import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { USAGE } from "../src/cli.ts";
import { FakeGitHub } from "./helpers/fake-github.ts";
import {
  addCompliantRuleset,
  contractText,
  FAKE_TOKEN,
  makeTempRepo,
  REPO_ROOT,
  runCli,
} from "./helpers/fixtures.ts";

const CLI = path.join(REPO_ROOT, "src", "cli.ts");

/** Run the real entry point in a child process with an environment that holds no credentials. */
function spawnCli(
  cwd: string,
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", CLI, ...args],
    {
      cwd,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("help exits 0 and documents every command", async (t) => {
  const fake = new FakeGitHub();
  const cwd = makeTempRepo(t);
  for (const argv of [["help"], ["--help"], ["-h"], ["plan", "--help"]]) {
    const result = await runCli(fake, cwd, argv);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, USAGE);
    assert.equal(result.stderr, "");
  }
  for (const command of ["plan", "apply", "verify", "restore"])
    assert.match(USAGE, new RegExp(`\\n  ${command} `));
  assert.deepEqual(fake.log, []);
});

test("usage errors exit 2 before any request", async (t) => {
  const fake = new FakeGitHub();
  const cwd = makeTempRepo(t);
  const cases: [string[], RegExp][] = [
    [[], /^error: missing command/],
    [["destroy"], /^error: unknown command "destroy"/],
    [["plan", "extra"], /^error: unexpected extra argument "extra"/],
    [["plan", "--force"], /^error: .*--force/],
    [["plan", "--remote", "upstream"], /^error: cannot read git remote "upstream"/],
    [["plan", "--remote=-x"], /^error: invalid git remote name/],
    [["plan", "--contract", "nope.json"], /^error: cannot read governance contract at nope\.json/],
    [["plan", "--token-file", "missing-token.txt"], /^error: cannot read the GitHub token file\n$/],
  ];
  for (const [argv, expected] of cases) {
    const result = await runCli(fake, cwd, argv);
    assert.equal(result.code, 2, argv.join(" "));
    assert.match(result.stderr, expected);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(fake.log, []);
});

test("a missing or malformed token exits 2 without echoing it", async (t) => {
  const fake = new FakeGitHub();
  const cwd = makeTempRepo(t);
  const none = await runCli(fake, cwd, ["plan"], { env: {} });
  assert.equal(none.code, 2);
  assert.match(none.stderr, /no GitHub token available/);

  const malformed = await runCli(fake, cwd, ["plan"], { env: { GITHUB_TOKEN: "two parts" } });
  assert.equal(malformed.code, 2);
  assert.equal(malformed.stderr, "error: the GitHub token is empty or malformed\n");

  writeFileSync(path.join(cwd, "empty-token.txt"), "  \n");
  const empty = await runCli(fake, cwd, ["plan", "--token-file", "empty-token.txt"], { env: {} });
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /token is empty or malformed/);
  assert.deepEqual(fake.log, []);
});

test("the token is read from a file at runtime, trimmed, and used only as a header", async (t) => {
  const fake = new FakeGitHub();
  addCompliantRuleset(fake);
  const cwd = makeTempRepo(t);
  mkdirSync(path.join(cwd, "private"));
  writeFileSync(path.join(cwd, "private", "token"), `\n  ${FAKE_TOKEN}  \n`);
  const viaFlag = await runCli(fake, cwd, ["plan", "--token-file", "private/token"], { env: {} });
  assert.equal(viaFlag.code, 0, viaFlag.stderr);
  const viaEnv = await runCli(fake, cwd, ["verify"], {
    env: { GOVERNANCE_TOKEN_FILE: "private/token" },
  });
  assert.equal(viaEnv.code, 0, viaEnv.stderr);
  assert.ok(fake.log.every((request) => request.authorization === `Bearer ${FAKE_TOKEN}`));
  assert.ok(
    fake.log.every(
      (request) => !request.path.includes(FAKE_TOKEN) && !request.query.includes(FAKE_TOKEN),
    ),
  );
  assert.ok(!(viaFlag.stdout + viaEnv.stdout).includes(FAKE_TOKEN));
});

test("an invalid contract exits 2 and lists every problem", async (t) => {
  const fake = new FakeGitHub();
  const cwd = makeTempRepo(t, {
    contract: contractText({ version: 3, branch: "~ALL", surprise: true }),
  });
  const result = await runCli(fake, cwd, ["apply"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^error: governance contract is invalid:/);
  assert.match(result.stderr, /unsupported contract version 3/);
  assert.match(result.stderr, /unsafe wildcard target/);
  assert.match(result.stderr, /unknown contract key "surprise"/);
  assert.deepEqual(fake.log, []);
});

test("a token-bearing remote is rejected without printing the URL", async (t) => {
  const fake = new FakeGitHub();
  const secret = ["ghp", "S".repeat(36)].join("_");
  const cwd = makeTempRepo(t, {
    remoteUrl: `https://x-access-token:${secret}@github.com/octo/demo.git`,
  });
  const result = await runCli(fake, cwd, ["plan"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^error: git remote "origin" embeds credentials in its URL/);
  assert.ok(!result.stderr.includes(secret));
  assert.ok(!result.stderr.includes("x-access-token"));
  assert.deepEqual(fake.log, []);
});

test("remote failures exit 1 with a redacted message", async (t) => {
  const fake = new FakeGitHub();
  fake.fail("GET", /\/repos\/octo\/demo$/, {
    status: 401,
    body: JSON.stringify({ message: `Bad credentials ${FAKE_TOKEN}`, request_id: "ABCD:1234" }),
  });
  const cwd = makeTempRepo(t);
  const result = await runCli(fake, cwd, ["plan"]);
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "error: GitHub API GET /repos/octo/demo failed: HTTP 401 - Bad credentials [REDACTED] (attempt 1)\n",
  );
  assert.ok(!existsSync(path.join(cwd, "artifacts", "governance-plan.json")));
});

test("unexpected internal failures exit 1 and are redacted", async (t) => {
  const fake = new FakeGitHub();
  const cwd = makeTempRepo(t);
  const result = await runCli(fake, cwd, ["plan"], {
    fetch: () => {
      throw Object.assign(new RangeError(`boom ${FAKE_TOKEN}`), { name: "RangeError" });
    },
    git: () => Promise.resolve("https://github.com/octo/demo.git\n"),
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^error: GitHub API GET \/repos\/octo\/demo failed: network error/);
  assert.ok(!result.stderr.includes(FAKE_TOKEN));

  const broken = await runCli(fake, cwd, ["plan"], {
    git: () => Promise.resolve("https://github.com/octo/demo.git\n"),
    stdout: () => {
      throw new Error(`cannot write ${FAKE_TOKEN}`);
    },
  });
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /^error: unexpected failure: cannot write \[REDACTED\]/);
});

test("GITHUB_API_URL must be https and is honoured", async (t) => {
  const fake = new FakeGitHub();
  const cwd = makeTempRepo(t);
  const insecure = await runCli(fake, cwd, ["plan"], {
    env: { GITHUB_TOKEN: FAKE_TOKEN, GITHUB_API_URL: "http://localhost:8080" },
  });
  assert.equal(insecure.code, 1);
  assert.match(insecure.stderr, /must use https/);
  assert.deepEqual(fake.log, []);
});

test("the real entry point reports usage errors with exit code 2 and no credentials", (t) => {
  const cwd = makeTempRepo(t);
  const missing = spawnCli(cwd, []);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^error: missing command/);
  const unknown = spawnCli(cwd, ["rollback"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command "rollback"/);
  const help = spawnCli(cwd, ["--help"]);
  assert.equal(help.status, 0);
  assert.equal(help.stdout, USAGE);
  const noToken = spawnCli(cwd, ["plan"]);
  assert.equal(noToken.status, 2);
  assert.match(noToken.stderr, /no GitHub token available/);
});
