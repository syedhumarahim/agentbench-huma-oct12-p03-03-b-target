import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { APPLY_JSON_FILE, applyContract } from "./apply.ts";
import type { CommandContext } from "./apply.ts";
import { loadContract } from "./contract.ts";
import {
  ContractError,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  GitHubError,
  ReconcileError,
  SnapshotError,
  UsageError,
} from "./errors.ts";
import { fullName, resolveRepository } from "./git-remote.ts";
import type { GitRunner } from "./git-remote.ts";
import { GitHubClient } from "./github.ts";
import type { FetchLike } from "./github.ts";
import { stableStringify } from "./json.ts";
import { readLocalChecks } from "./local-checks.ts";
import {
  computePlan,
  PLAN_JSON_FILE,
  PLAN_MARKDOWN_FILE,
  renderPlanJson,
  renderPlanMarkdown,
  summarizePlan,
} from "./plan.ts";
import { redactText } from "./redact.ts";
import { inspectRemote } from "./remote-state.ts";
import { RESTORE_JSON_FILE, restoreSnapshot } from "./restore.ts";
import { parseSnapshot, serializeSnapshot, SNAPSHOT_FILE } from "./snapshot.ts";
import { buildVerifyReport, VERIFY_JSON_FILE } from "./verify.ts";

export const COMMANDS = ["plan", "apply", "verify", "restore"] as const;
export type Command = (typeof COMMANDS)[number];

export const USAGE = `Usage: npm run policy -- <command> [options]

Commands:
  plan      Read-only. Compare the live rulesets with governance-contract.json and write
            artifacts/governance-plan.json and artifacts/governance-plan.md.
  apply     Reconcile the contract-managed rulesets. Saves a recovery snapshot before the
            first remote write and verifies the replacement before deleting anything.
  verify    Read-only. Exit 0 only when the live managed policy matches the contract.
  restore   Re-create or re-align the managed rulesets recorded in the recovery snapshot.

Options:
  --contract <path>       Contract file (default: governance-contract.json)
  --remote <name>         Git remote that identifies the repository (default: origin)
  --token-file <path>     File holding the GitHub token (or set GOVERNANCE_TOKEN_FILE,
                          or provide the token in the GITHUB_TOKEN environment variable)
  --artifacts-dir <path>  Where reports are written (default: artifacts)
  --state-dir <path>      Where recovery snapshots are kept (default: state)
  --snapshot <path>       Snapshot used by restore (default: <state-dir>/${SNAPSHOT_FILE})
  -h, --help              Show this help

Exit codes: 0 success, 1 drift or remote failure, 2 usage, contract or snapshot error.
`;

export interface CliDependencies {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly fetch: FetchLike;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly git?: GitRunner;
}

interface Options {
  readonly contract: string;
  readonly remote: string;
  readonly tokenFile: string | undefined;
  readonly artifactsDir: string;
  readonly stateDir: string;
  readonly snapshot: string | undefined;
}

function parseCommandLine(argv: readonly string[]): {
  command: string | undefined;
  help: boolean;
  options: Options;
} {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        contract: { type: "string", default: "governance-contract.json" },
        remote: { type: "string", default: "origin" },
        "token-file": { type: "string" },
        "artifacts-dir": { type: "string", default: "artifacts" },
        "state-dir": { type: "string", default: "state" },
        snapshot: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "invalid arguments");
  }
  if (parsed.positionals.length > 1) {
    throw new UsageError(`unexpected extra argument ${JSON.stringify(parsed.positionals[1])}`);
  }
  return {
    command: parsed.positionals[0],
    help: parsed.values.help,
    options: {
      contract: parsed.values.contract,
      remote: parsed.values.remote,
      tokenFile: parsed.values["token-file"],
      artifactsDir: parsed.values["artifacts-dir"],
      stateDir: parsed.values["state-dir"],
      snapshot: parsed.values.snapshot,
    },
  };
}

/** Read the token at runtime. It is held in memory only and never written or echoed. */
async function resolveToken(options: Options, deps: CliDependencies): Promise<string> {
  const tokenFile = options.tokenFile ?? deps.env.GOVERNANCE_TOKEN_FILE;
  let token: string;
  if (tokenFile !== undefined && tokenFile.length > 0) {
    try {
      token = (await readFile(path.resolve(deps.cwd, tokenFile), "utf8")).trim();
    } catch {
      throw new UsageError("cannot read the GitHub token file");
    }
  } else {
    token = (deps.env.GITHUB_TOKEN ?? "").trim();
    if (token.length === 0) {
      throw new UsageError(
        "no GitHub token available: pass --token-file <path>, or set GOVERNANCE_TOKEN_FILE or GITHUB_TOKEN",
      );
    }
  }
  if (token.length === 0 || /\s/.test(token)) {
    throw new UsageError("the GitHub token is empty or malformed");
  }
  return token;
}

/** Path shown to operators and written into reports: always relative, never absolute. */
function displayPath(cwd: string, target: string): string {
  const relative = path.relative(cwd, target).split(path.sep).join("/");
  return relative.startsWith("..") || path.isAbsolute(relative) ? path.basename(target) : relative;
}

function exitCodeFor(error: unknown): number {
  return error instanceof UsageError ||
    error instanceof ContractError ||
    error instanceof SnapshotError
    ? EXIT_USAGE
    : EXIT_FAILURE;
}

function describeError(error: unknown): string {
  if (
    error instanceof UsageError ||
    error instanceof ContractError ||
    error instanceof SnapshotError ||
    error instanceof GitHubError ||
    error instanceof ReconcileError
  ) {
    return error.message;
  }
  return `unexpected failure: ${error instanceof Error ? error.message : "unknown error"}`;
}

/** Run one CLI invocation and return its exit code. All side effects go through `deps`. */
export async function main(argv: readonly string[], deps: CliDependencies): Promise<number> {
  const secrets: string[] = [];
  const say = (text: string): void => {
    deps.stdout(`${redactText(text, secrets)}\n`);
  };
  try {
    const { command, help, options } = parseCommandLine(argv);
    if (help || command === "help") {
      deps.stdout(USAGE);
      return EXIT_OK;
    }
    if (command === undefined) throw new UsageError(`missing command\n\n${USAGE}`);
    if (!COMMANDS.some((candidate) => candidate === command)) {
      throw new UsageError(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
    }

    const contractPath = path.resolve(deps.cwd, options.contract);
    const { contract, sha256: contractSha256 } = await loadContract(
      contractPath,
      displayPath(deps.cwd, contractPath),
    );
    const repository = await resolveRepository(deps.cwd, options.remote, deps.git);
    const localChecks = await readLocalChecks(deps.cwd);
    const token = await resolveToken(options, deps);
    secrets.push(token);

    const readOnly = command === "plan" || command === "verify";
    const baseUrl = deps.env.GITHUB_API_URL;
    const client = new GitHubClient({
      token,
      fetch: deps.fetch,
      readOnly,
      ...(baseUrl === undefined || baseUrl.length === 0 ? {} : { baseUrl }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    });
    const context: CommandContext = { contract, contractSha256, repository, client, localChecks };
    const artifactsDir = path.resolve(deps.cwd, options.artifactsDir);
    const stateDir = path.resolve(deps.cwd, options.stateDir);
    const writeOutput = async (
      directory: string,
      name: string,
      content: string,
    ): Promise<string> => {
      await mkdir(directory, { recursive: true });
      const target = path.join(directory, name);
      await writeFile(target, redactText(content, secrets), "utf8");
      return displayPath(deps.cwd, target);
    };

    if (command === "plan") {
      const plan = computePlan(
        contract,
        contractSha256,
        await inspectRemote(client, repository, contract),
        localChecks,
      );
      const jsonPath = await writeOutput(artifactsDir, PLAN_JSON_FILE, renderPlanJson(plan));
      const markdownPath = await writeOutput(
        artifactsDir,
        PLAN_MARKDOWN_FILE,
        renderPlanMarkdown(plan),
      );
      say(`Plan for ${plan.repository}: ${summarizePlan(plan)}`);
      for (const change of plan.changes) {
        say(`  ${change.action} ${change.ruleset_name}: ${change.reason}`);
      }
      for (const warning of plan.warnings) say(`  warning: ${warning}`);
      for (const blocker of plan.blockers) say(`  blocker: ${blocker}`);
      say(`Wrote ${jsonPath} and ${markdownPath}`);
      return plan.blockers.length === 0 ? EXIT_OK : EXIT_FAILURE;
    }

    if (command === "verify") {
      const { report } = buildVerifyReport(
        contract,
        contractSha256,
        await inspectRemote(client, repository, contract),
        localChecks,
      );
      const reportPath = await writeOutput(artifactsDir, VERIFY_JSON_FILE, stableStringify(report));
      for (const check of report.checks) say(`${check.ok ? "ok  " : "FAIL"} ${check.description}`);
      for (const warning of report.warnings) say(`warning: ${warning}`);
      say(
        report.ok
          ? `Verified: the live policy on ${report.repository} matches the contract. Wrote ${reportPath}`
          : `Drift detected on ${report.repository}. Wrote ${reportPath}`,
      );
      return report.ok ? EXIT_OK : EXIT_FAILURE;
    }

    if (command === "apply") {
      const outcome = await applyContract(context, async (snapshot) => {
        const content = serializeSnapshot(snapshot);
        await writeOutput(
          path.join(stateDir, "snapshots"),
          `${snapshot.integrity_sha256}.json`,
          content,
        );
        return writeOutput(stateDir, SNAPSHOT_FILE, content);
      });
      const reportPath = await writeOutput(
        artifactsDir,
        APPLY_JSON_FILE,
        stableStringify({
          schema_version: 1,
          repository: fullName(repository),
          contract_sha256: contractSha256,
          changed: outcome.changed,
          actions: outcome.actions,
          recovery_snapshot: outcome.snapshot,
          remote_writes: outcome.remote_writes,
        }),
      );
      if (outcome.changed) {
        say(
          `Recovery snapshot saved to ${outcome.snapshot ?? "(none)"} before the first remote write.`,
        );
        for (const action of outcome.actions) {
          say(`  ${action.action} ${action.ruleset_name} (id ${action.ruleset_id})`);
        }
        say(`Applied and verified. Remote writes: ${outcome.remote_writes}. Wrote ${reportPath}`);
      } else {
        say(`No changes: the live managed policy already matches the contract. Remote writes: 0.`);
      }
      return EXIT_OK;
    }

    const snapshotPath = path.resolve(
      deps.cwd,
      options.snapshot ?? path.join(options.stateDir, SNAPSHOT_FILE),
    );
    let snapshotText: string;
    try {
      snapshotText = await readFile(snapshotPath, "utf8");
    } catch {
      throw new SnapshotError(
        `no recovery snapshot found at ${displayPath(deps.cwd, snapshotPath)}; nothing was changed`,
      );
    }
    const snapshot = parseSnapshot(snapshotText, { repository, contract });
    const outcome = await restoreSnapshot(context, snapshot);
    const reportPath = await writeOutput(
      artifactsDir,
      RESTORE_JSON_FILE,
      stableStringify({ schema_version: 1, repository: fullName(repository), ...outcome }),
    );
    for (const action of outcome.actions) {
      say(`  ${action.action} ${action.ruleset_name} (id ${action.ruleset_id})`);
    }
    for (const ruleset of outcome.left_in_place) {
      say(`  left in place (not in snapshot): ${ruleset.name} (id ${ruleset.id})`);
    }
    say(
      `Restore complete: ${outcome.actions.length} recorded ruleset(s) processed, ${outcome.unmanaged_preserved} unmanaged ruleset(s) untouched. Remote writes: ${outcome.remote_writes}. Wrote ${reportPath}`,
    );
    return EXIT_OK;
  } catch (error) {
    deps.stderr(`error: ${redactText(describeError(error), secrets)}\n`);
    return exitCodeFor(error);
  }
}

async function isEntryPoint(): Promise<boolean> {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(await realpath(entry)).href;
  } catch {
    return false;
  }
}

if (await isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    fetch: (url, init) => fetch(url, init),
  });
}
