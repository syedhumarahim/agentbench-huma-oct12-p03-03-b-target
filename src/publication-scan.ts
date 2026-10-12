import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A redacted finding: where a rule matched, never what it matched. */
export interface ScanFinding {
  readonly rule: string;
  readonly path: string;
  readonly line: number | null;
  readonly commit: string | null;
}

interface ContentRule {
  readonly name: string;
  readonly pattern: RegExp;
}

const DASHES = "-".repeat(5);

/* Patterns are assembled from fragments so this file never matches its own rules. */
const CONTENT_RULES: readonly ContentRule[] = [
  { name: "github-token", pattern: new RegExp("\\bgh[pousr]_" + "[A-Za-z0-9]{30,}") },
  {
    name: "github-fine-grained-token",
    pattern: new RegExp("\\bgithub_pat_" + "[A-Za-z0-9_]{30,}"),
  },
  { name: "aws-access-key-id", pattern: new RegExp("\\b(?:AKIA|ASIA)" + "[0-9A-Z]{16}\\b") },
  { name: "private-key-block", pattern: new RegExp(DASHES + "BEGIN [A-Z ]*PRIVATE KEY" + DASHES) },
  { name: "slack-token", pattern: new RegExp("\\bxox[abprs]-" + "[A-Za-z0-9-]{10,}") },
  { name: "google-api-key", pattern: new RegExp("\\bAIza" + "[0-9A-Za-z_-]{35}\\b") },
  { name: "npm-token", pattern: new RegExp("\\bnpm_" + "[A-Za-z0-9]{36}\\b") },
  {
    name: "json-web-token",
    pattern: new RegExp("\\beyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}"),
  },
  {
    name: "credential-bearing-url",
    pattern: new RegExp("[a-z][a-z0-9+.-]*:" + "//[^/\\s:@'\"`$<>{}]+:[^/\\s:@'\"`$<>{}]+@[^\\s]"),
  },
  {
    name: "authorization-header-value",
    pattern: new RegExp(
      "authorization\\s*:\\s*(?:bearer|token|basic)\\s+" + "[A-Za-z0-9._~+/=-]{16,}",
      "i",
    ),
  },
  {
    name: "hardcoded-secret-assignment",
    pattern: new RegExp(
      "(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)" +
        "[\"']?\\s*[:=]\\s*[\"'][A-Za-z0-9+/_=-]{16,}[\"']",
      "i",
    ),
  },
];

const SENSITIVE_PATH_RULES: readonly ContentRule[] = [
  {
    name: "credential-directory",
    pattern: /(^|\/)(\.eval-credentials|\.runtime-secrets|\.aws|\.ssh)\//,
  },
  { name: "dotenv-file", pattern: /(^|\/)\.env(\.[^/]*)?$/ },
  { name: "key-or-certificate-file", pattern: /\.(pem|key|p12|pfx|jks|keystore)$/i },
  { name: "ssh-private-key-file", pattern: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/ },
  { name: "credential-store-file", pattern: /(^|\/)(\.npmrc|\.netrc|\.git-credentials|\.pypirc)$/ },
  {
    name: "generated-credential-file",
    pattern: /(^|\/)[^/]*(token|credential|secret)s?[^/]*\.(txt|json|ya?ml|env|ini)$/i,
  },
];

/** Scan one text blob. Findings carry the rule and line only. */
export function scanText(
  filePath: string,
  text: string,
  commit: string | null = null,
): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = text.split("\n");
  for (const rule of CONTENT_RULES) {
    lines.forEach((line, index) => {
      if (rule.pattern.test(line)) {
        findings.push({ rule: rule.name, path: filePath, line: index + 1, commit });
      }
    });
  }
  return findings;
}

/** Flag paths whose name alone marks them as credential material. */
export function scanPath(filePath: string, commit: string | null = null): ScanFinding[] {
  return SENSITIVE_PATH_RULES.filter((rule) => rule.pattern.test(filePath)).map((rule) => ({
    rule: rule.name,
    path: filePath,
    line: null,
    commit,
  }));
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

async function git(root: string, args: readonly string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

export interface HistoryScanResult {
  readonly commits: number;
  readonly blobs: number;
  readonly findings: ScanFinding[];
}

/** Scan every commit message and every blob reachable from any ref. */
export async function scanGitHistory(root: string): Promise<HistoryScanResult> {
  const commits = (await git(root, ["rev-list", "--all"]))
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  const findings: ScanFinding[] = [];
  const scannedBlobs = new Set<string>();
  const scannedPaths = new Set<string>();
  for (const commit of commits) {
    const short = commit.slice(0, 12);
    const message = (
      await git(root, ["show", "-s", "--format=%an%n%ae%n%cn%n%ce%n%B", commit])
    ).toString("utf8");
    findings.push(...scanText("(commit metadata)", message, short));
    const tree = (await git(root, ["ls-tree", "-r", "-z", commit]))
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    for (const entry of tree) {
      const [meta, filePath] = entry.split("\t");
      const [, type, blob] = (meta ?? "").split(" ");
      if (type !== "blob" || blob === undefined || filePath === undefined) continue;
      if (!scannedPaths.has(filePath)) {
        scannedPaths.add(filePath);
        findings.push(...scanPath(filePath, short));
      }
      if (scannedBlobs.has(blob)) continue;
      scannedBlobs.add(blob);
      const content = await git(root, ["cat-file", "blob", blob]);
      if (!isBinary(content)) findings.push(...scanText(filePath, content.toString("utf8"), short));
    }
  }
  return { commits: commits.length, blobs: scannedBlobs.size, findings };
}

/** Scan files on disk (for generated artifacts that are not tracked). */
export async function scanDirectory(root: string, relative: string): Promise<ScanFinding[]> {
  const findings: ScanFinding[] = [];
  const pending = [relative];
  while (pending.length > 0) {
    const current = pending.pop() ?? relative;
    let entries;
    try {
      entries = await readdir(path.join(root, current), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.posix.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (entry.isFile()) {
        findings.push(...scanPath(child));
        const content = await readFile(path.join(root, child));
        if (!isBinary(content)) findings.push(...scanText(child, content.toString("utf8")));
      }
    }
  }
  return findings;
}

export function formatFinding(finding: ScanFinding): string {
  const location = finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
  const commit = finding.commit === null ? "working tree" : `commit ${finding.commit}`;
  return `${finding.rule}  ${location}  (${commit})  [value redacted]`;
}

/** CLI: scan history plus any generated directories given as arguments. Exit 1 on findings. */
export async function runScan(
  root: string,
  extraDirectories: readonly string[],
  write: (line: string) => void,
): Promise<number> {
  const history = await scanGitHistory(root);
  const findings = [...history.findings];
  for (const directory of extraDirectories)
    findings.push(...(await scanDirectory(root, directory)));
  write(
    `scanned ${history.commits} commit(s), ${history.blobs} blob(s), ${extraDirectories.length} extra path(s)`,
  );
  for (const finding of findings) write(formatFinding(finding));
  write(
    findings.length === 0
      ? "publication scan: clean"
      : `publication scan: ${findings.length} finding(s)`,
  );
  return findings.length === 0 ? 0 : 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runScan(process.cwd(), process.argv.slice(2), (line) => {
    process.stdout.write(`${line}\n`);
  });
}
