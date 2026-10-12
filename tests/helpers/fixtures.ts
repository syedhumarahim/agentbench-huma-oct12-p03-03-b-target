import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { CommandContext } from "../../src/apply.ts";
import type { CliDependencies } from "../../src/cli.ts";
import { main } from "../../src/cli.ts";
import { buildDesiredRuleset, parseContract } from "../../src/contract.ts";
import type { Contract } from "../../src/contract.ts";
import { GitHubClient } from "../../src/github.ts";
import type { LocalChecks } from "../../src/local-checks.ts";
import type { FakeGitHub, FakeRuleset } from "./fake-github.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** A synthetic token assembled at runtime; it is not a real credential and never matches one. */
export const FAKE_TOKEN = ["ghp", "T".repeat(36)].join("_");

export const BASE_CONTRACT_TEXT = readFileSync(
  path.join(REPO_ROOT, "governance-contract.json"),
  "utf8",
);

export function contractObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const merged = { ...(JSON.parse(BASE_CONTRACT_TEXT) as Record<string, unknown>), ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) Reflect.deleteProperty(merged, key);
  }
  return merged;
}

export function contractText(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify(contractObject(overrides), null, 2)}\n`;
}

export function makeContract(overrides: Record<string, unknown> = {}): Contract {
  return parseContract(contractText(overrides));
}

export const LOCAL_CHECKS: LocalChecks = {
  package_scripts: ["package", "policy", "test"],
  reporter_contexts: { test: "test", package: "package" },
};

export const CONTRACT_SHA = "c".repeat(64);

export interface Harness {
  readonly context: CommandContext;
  readonly client: GitHubClient;
  readonly sleeps: number[];
}

export function makeHarness(
  fake: FakeGitHub,
  options: { contract?: Contract; readOnly?: boolean; maxAttempts?: number } = {},
): Harness {
  const sleeps: number[] = [];
  const client = new GitHubClient({
    token: FAKE_TOKEN,
    fetch: fake.fetch,
    readOnly: options.readOnly ?? false,
    maxAttempts: options.maxAttempts ?? 3,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      return Promise.resolve();
    },
  });
  return {
    client,
    sleeps,
    context: {
      contract: options.contract ?? makeContract(),
      contractSha256: CONTRACT_SHA,
      repository: { owner: fake.owner, name: fake.repo },
      client,
      localChecks: LOCAL_CHECKS,
    },
  };
}

/** Seed the fake with a ruleset that already satisfies the contract. */
export function addCompliantRuleset(
  fake: FakeGitHub,
  contract: Contract = makeContract(),
): FakeRuleset {
  const desired = buildDesiredRuleset(contract);
  return fake.addRuleset({
    name: desired.name,
    enforcement: desired.enforcement,
    bypass_actors: [...desired.bypass_actors],
    conditions: structuredClone(desired.conditions),
    rules: desired.rules.map((rule) => structuredClone(rule) as FakeRuleset["rules"][number]),
  });
}

export function addObsoleteRuleset(fake: FakeGitHub): FakeRuleset {
  return fake.addRuleset({
    name: "agentbench-managed-obsolete",
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
  });
}

export function addUnmanagedRuleset(fake: FakeGitHub, name = "team-release-tags"): FakeRuleset {
  return fake.addRuleset({
    name,
    target: "tag",
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "deletion" }],
  });
}

/** A throwaway git repository whose origin points at the fake repository. */
export function makeTempRepo(
  t: TestContext,
  options: { remoteUrl?: string; contract?: string } = {},
): string {
  const directory = mkdtempSync(path.join(tmpdir(), "governance-cli-"));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", directory, ...args], { stdio: "ignore" });
  };
  git("init", "--quiet");
  git("remote", "add", "origin", options.remoteUrl ?? "https://github.com/octo/demo.git");
  writeFileSync(
    path.join(directory, "governance-contract.json"),
    options.contract ?? BASE_CONTRACT_TEXT,
  );
  cpSync(path.join(REPO_ROOT, "package.json"), path.join(directory, "package.json"));
  mkdirSync(path.join(directory, "scripts"));
  cpSync(
    path.join(REPO_ROOT, "scripts", "report_local_checks.py"),
    path.join(directory, "scripts", "report_local_checks.py"),
  );
  return directory;
}

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runCli(
  fake: FakeGitHub,
  cwd: string,
  argv: readonly string[],
  overrides: Partial<CliDependencies> = {},
): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { GITHUB_TOKEN: FAKE_TOKEN },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    fetch: fake.fetch,
    sleep: () => Promise.resolve(),
    ...overrides,
  });
  return { code, stdout, stderr };
}
