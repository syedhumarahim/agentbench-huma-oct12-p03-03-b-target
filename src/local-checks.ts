import { readFile } from "node:fs/promises";
import path from "node:path";
import { UsageError } from "./errors.ts";
import { isRecord } from "./json.ts";

export const PACKAGE_MANIFEST = "package.json";
export const REPORTER_SCRIPT = "scripts/report_local_checks.py";

/** Local producers of commit-status contexts, as configured in the repository. */
export interface LocalChecks {
  /** npm script names declared in package.json. */
  readonly package_scripts: readonly string[];
  /** Status context -> npm script the supplied reporter runs for it. */
  readonly reporter_contexts: Readonly<Record<string, string>>;
}

/** Extract `COMMANDS = {'context': ['npm', ...]}` from the supplied reporter without running it. */
export function parseReporterContexts(source: string): Record<string, string> {
  const block = /^COMMANDS\s*=\s*\{([^}]*)\}/m.exec(source);
  if (block === null) {
    throw new UsageError(`${REPORTER_SCRIPT} does not declare a COMMANDS mapping`);
  }
  const contexts: Record<string, string> = {};
  const entry = /['"]([^'"]+)['"]\s*:\s*\[([^\]]*)\]/g;
  for (const match of (block[1] ?? "").matchAll(entry)) {
    const context = match[1] ?? "";
    const command = [...(match[2] ?? "").matchAll(/['"]([^'"]*)['"]/g)].map(
      (part) => part[1] ?? "",
    );
    const script =
      command[0] === "npm" ? (command[1] === "run" ? command[2] : command[1]) : undefined;
    if (script === undefined || script.length === 0) {
      throw new UsageError(`${REPORTER_SCRIPT} context "${context}" does not run an npm script`);
    }
    contexts[context] = script;
  }
  return contexts;
}

export function parsePackageScripts(source: string): string[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new UsageError(`${PACKAGE_MANIFEST} is not valid JSON`);
  }
  const scripts = isRecord(manifest) ? manifest.scripts : undefined;
  return isRecord(scripts) ? Object.keys(scripts).sort() : [];
}

export async function readLocalChecks(root: string): Promise<LocalChecks> {
  const read = async (relative: string): Promise<string> => {
    try {
      return await readFile(path.join(root, relative), "utf8");
    } catch {
      throw new UsageError(`cannot read ${relative}; run the CLI from the repository root`);
    }
  };
  return {
    package_scripts: parsePackageScripts(await read(PACKAGE_MANIFEST)),
    reporter_contexts: parseReporterContexts(await read(REPORTER_SCRIPT)),
  };
}

/** Explain every required status context that no local command can produce. */
export function describeMissingChecks(required: readonly string[], checks: LocalChecks): string[] {
  const problems: string[] = [];
  for (const context of required) {
    const script = checks.reporter_contexts[context];
    if (script === undefined) {
      problems.push(
        `required status check "${context}" is not reported by ${REPORTER_SCRIPT}; merges would wait forever`,
      );
    } else if (!checks.package_scripts.includes(script)) {
      problems.push(
        `required status check "${context}" runs npm script "${script}", which ${PACKAGE_MANIFEST} does not define`,
      );
    }
  }
  return problems;
}
