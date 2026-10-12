import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  describeMissingChecks,
  parsePackageScripts,
  parseReporterContexts,
  readLocalChecks,
} from "../src/local-checks.ts";
import { makeTempRepo, REPO_ROOT } from "./helpers/fixtures.ts";

test("the repository's own configuration provides both required checks", async () => {
  const checks = await readLocalChecks(REPO_ROOT);
  assert.deepEqual(checks.reporter_contexts, { test: "test", package: "package" });
  assert.ok(checks.package_scripts.includes("test") && checks.package_scripts.includes("package"));
  assert.deepEqual(describeMissingChecks(["test", "package"], checks), []);
});

test("reporter contexts are parsed from the COMMANDS mapping", () => {
  assert.deepEqual(
    parseReporterContexts(`COMMANDS = {"lint": ["npm", "run", "lint"], 'unit': ['npm', 'test']}\n`),
    { lint: "lint", unit: "test" },
  );
  assert.throws(
    () => parseReporterContexts("print('hello')"),
    /does not declare a COMMANDS mapping/,
  );
  assert.throws(
    () => parseReporterContexts("COMMANDS = {'x': ['make', 'x']}"),
    /context "x" does not run an npm script/,
  );
  assert.throws(
    () => parseReporterContexts("COMMANDS = {'x': ['npm']}"),
    /does not run an npm script/,
  );
});

test("package scripts are parsed defensively", () => {
  assert.deepEqual(parsePackageScripts('{"scripts": {"b": "x", "a": "y"}}'), ["a", "b"]);
  assert.deepEqual(parsePackageScripts('{"name": "x"}'), []);
  assert.deepEqual(parsePackageScripts("[]"), []);
  assert.throws(() => parsePackageScripts("{"), /package\.json is not valid JSON/);
});

test("missing configuration files are reported relative to the repository", async (t) => {
  const cwd = makeTempRepo(t);
  rmSync(path.join(cwd, "scripts", "report_local_checks.py"));
  await assert.rejects(readLocalChecks(cwd), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(
      error.message,
      "cannot read scripts/report_local_checks.py; run the CLI from the repository root",
    );
    return true;
  });
  writeFileSync(path.join(cwd, "package.json"), "{");
  await assert.rejects(readLocalChecks(cwd), /package\.json is not valid JSON/);
});
