import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  formatFinding,
  runScan,
  scanDirectory,
  scanGitHistory,
  scanPath,
  scanText,
} from "../src/publication-scan.ts";
import { REPO_ROOT } from "./helpers/fixtures.ts";

/* Every sample is assembled at runtime so this file itself stays clean under the scanner. */
const dashes = "-".repeat(5);
const samples: Record<string, string> = {
  "github-token": ["ghp", "Z".repeat(36)].join("_"),
  "github-fine-grained-token": ["github", "pat", "Y".repeat(40)].join("_"),
  "aws-access-key-id": "AKIA" + "ABCDEFGHIJKLMNOP",
  "private-key-block": `${dashes}BEGIN RSA PRIVATE KEY${dashes}`,
  "slack-token": ["xoxb", "1234567890", "abcdefghij"].join("-"),
  "google-api-key": "AIza" + "B".repeat(35),
  "npm-token": ["npm", "c".repeat(36)].join("_"),
  "json-web-token": ["eyJ" + "a".repeat(12), "eyJ" + "b".repeat(12), "c".repeat(12)].join("."),
  "credential-bearing-url": "https:" + "//deploy:" + "hunter2hunter2" + "@example.com/repo.git",
  "authorization-header-value": "Authorization: " + "Bearer " + "d".repeat(24),
  "hardcoded-secret-assignment": "client_secret" + ' = "' + "e".repeat(24) + '"',
};

function tempGitRepo(t: TestContext): { root: string; git: (...args: string[]) => void } {
  const root = mkdtempSync(path.join(tmpdir(), "governance-scan-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const git = (...args: string[]): void => {
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { stdio: "ignore" },
    );
  };
  git("init", "--quiet");
  return { root, git };
}

test("every content rule fires and findings never contain the matched value", () => {
  for (const [rule, sample] of Object.entries(samples)) {
    const findings = scanText("config/settings.txt", `line one\nvalue ${sample}\n`);
    assert.ok(
      findings.some((finding) => finding.rule === rule && finding.line === 2),
      `rule ${rule} did not fire`,
    );
    for (const finding of findings) {
      assert.ok(!JSON.stringify(finding).includes(sample));
      assert.ok(!formatFinding(finding).includes(sample));
      assert.match(formatFinding(finding), /\[value redacted\]$/);
    }
  }
});

test("ordinary source text is not flagged", () => {
  const benign = [
    "const url = `https://github.com/${owner}/${repo}.git`;",
    "Authorization: `Bearer ${token}`",
    "password = os.environ['PASSWORD']",
    "see https://example.com/docs?page=2 and git@github.com:octo/demo.git",
  ].join("\n");
  assert.deepEqual(scanText("src/example.ts", benign), []);
});

test("sensitive file names are flagged by path alone", () => {
  for (const [file, rule] of [
    [".env", "dotenv-file"],
    ["config/.env.production", "dotenv-file"],
    ["deploy/server.pem", "key-or-certificate-file"],
    ["home/.ssh/config", "credential-directory"],
    ["id_ed25519", "ssh-private-key-file"],
    [".npmrc", "credential-store-file"],
    [".eval-credentials/github_token.txt", "credential-directory"],
    ["out/github_token.txt", "generated-credential-file"],
    ["ci/credentials.json", "generated-credential-file"],
  ] as const) {
    assert.ok(
      scanPath(file).some((finding) => finding.rule === rule),
      `${file} should trigger ${rule}`,
    );
  }
  assert.deepEqual(scanPath("src/redact.ts"), []);
  assert.deepEqual(scanPath("governance-contract.json"), []);
  assert.equal(
    formatFinding({ rule: "dotenv-file", path: ".env", line: null, commit: "abc123" }),
    "dotenv-file  .env  (commit abc123)  [value redacted]",
  );
});

test("history scanning finds material that was committed and later removed", async (t) => {
  const { root, git } = tempGitRepo(t);
  writeFileSync(path.join(root, "README.md"), "hello\n");
  writeFileSync(path.join(root, "leak.txt"), `token ${samples["github-token"]}\n`);
  writeFileSync(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 0, 255]));
  git("add", ".");
  git("commit", "--quiet", "-m", "add files");
  git("rm", "--quiet", "leak.txt");
  git("commit", "--quiet", "-m", `remove leak ${samples["aws-access-key-id"]}`);

  const result = await scanGitHistory(root);
  assert.equal(result.commits, 2);
  assert.equal(result.blobs, 3);
  const rules = result.findings.map((finding) => `${finding.rule}@${finding.path}`).sort();
  assert.deepEqual(rules, ["aws-access-key-id@(commit metadata)", "github-token@leak.txt"]);
  assert.ok(result.findings.every((finding) => /^[0-9a-f]{12}$/.test(finding.commit ?? "")));

  const lines: string[] = [];
  assert.equal(await runScan(root, [], (line) => lines.push(line)), 1);
  assert.match(lines.join("\n"), /publication scan: 2 finding\(s\)/);
  assert.ok(!lines.join("\n").includes(samples["github-token"] ?? "missing"));
});

test("generated directories are scanned and a clean repository passes", async (t) => {
  const { root, git } = tempGitRepo(t);
  writeFileSync(path.join(root, "README.md"), "hello\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "initial");
  mkdirSync(path.join(root, "artifacts", "nested"), { recursive: true });
  writeFileSync(path.join(root, "artifacts", "plan.json"), "{}\n");
  const lines: string[] = [];
  assert.equal(
    await runScan(root, ["artifacts", "missing-directory"], (line) => lines.push(line)),
    0,
  );
  assert.equal(lines.at(-1), "publication scan: clean");

  writeFileSync(
    path.join(root, "artifacts", "nested", "debug.log"),
    `${samples["private-key-block"]}\n`,
  );
  writeFileSync(path.join(root, "artifacts", "nested", "blob.bin"), Buffer.from([0, 0, 0]));
  const findings = await scanDirectory(root, "artifacts");
  assert.deepEqual(
    findings.map((finding) => [finding.rule, finding.path, finding.commit]),
    [["private-key-block", "artifacts/nested/debug.log", null]],
  );
  assert.match(
    formatFinding(findings[0] ?? assert.fail()),
    /artifacts\/nested\/debug\.log:1 {2}\(working tree\)/,
  );
});

test("this repository's own history is clean", async () => {
  const result = await scanGitHistory(REPO_ROOT);
  assert.deepEqual(result.findings, []);
  assert.ok(result.commits >= 1);
});
