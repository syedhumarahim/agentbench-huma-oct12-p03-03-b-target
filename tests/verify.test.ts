import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inspectRemote } from "../src/remote-state.ts";
import { parseLiveRuleset } from "../src/rulesets.ts";
import { buildVerifyReport, evaluatePolicy } from "../src/verify.ts";
import type { VerifyReport } from "../src/verify.ts";
import { FakeGitHub } from "./helpers/fake-github.ts";
import type { FakeRuleset } from "./helpers/fake-github.ts";
import {
  addCompliantRuleset,
  addObsoleteRuleset,
  addUnmanagedRuleset,
  CONTRACT_SHA,
  LOCAL_CHECKS,
  makeContract,
  makeHarness,
  makeTempRepo,
  runCli,
} from "./helpers/fixtures.ts";

function failedChecks(
  mutate: (ruleset: FakeRuleset) => void,
  overrides: Record<string, unknown> = {},
  defaultBranch = "main",
): string[] {
  const contract = makeContract(overrides);
  const fake = new FakeGitHub();
  const ruleset = addCompliantRuleset(fake, contract);
  mutate(ruleset);
  return evaluatePolicy(contract, defaultBranch, parseLiveRuleset(structuredClone(ruleset), "test"))
    .filter((check) => !check.ok)
    .map((check) => check.id);
}

function parameters(ruleset: FakeRuleset, type: string): Record<string, unknown> {
  const rule = ruleset.rules.find((candidate) => candidate.type === type);
  assert.ok(rule?.parameters, `rule ${type} has parameters`);
  return rule.parameters;
}

async function verify(fake: FakeGitHub): Promise<VerifyReport> {
  const contract = makeContract();
  const { client, context } = makeHarness(fake, { contract, readOnly: true });
  const state = await inspectRemote(client, context.repository, contract);
  return buildVerifyReport(contract, CONTRACT_SHA, state, LOCAL_CHECKS).report;
}

test("a compliant ruleset passes every policy check", () => {
  assert.deepEqual(
    failedChecks(() => undefined),
    [],
  );
  assert.deepEqual(
    failedChecks(() => undefined, { branch: "refs/heads/trunk" }, "trunk"),
    [],
  );
});

test("each protected-main requirement is checked individually", () => {
  const drop = (type: string) => (ruleset: FakeRuleset) => {
    ruleset.rules = ruleset.rules.filter((rule) => rule.type !== type);
  };
  assert.deepEqual(
    failedChecks((ruleset) => (ruleset.enforcement = "disabled")),
    ["enforcement-active"],
  );
  assert.deepEqual(
    failedChecks((ruleset) => (ruleset.target = "tag")),
    ["targets-default-branch"],
  );
  assert.deepEqual(
    failedChecks(
      (ruleset) =>
        (ruleset.conditions = { ref_name: { include: ["refs/heads/dev"], exclude: [] } }),
    ),
    ["targets-default-branch"],
  );
  assert.deepEqual(
    failedChecks(
      (ruleset) =>
        (ruleset.conditions = {
          ref_name: { include: ["~DEFAULT_BRANCH"], exclude: ["refs/heads/main"] },
        }),
    ),
    ["targets-default-branch"],
  );
  assert.deepEqual(
    failedChecks((ruleset) => (ruleset.conditions = {})),
    ["targets-default-branch"],
  );
  assert.deepEqual(
    failedChecks(() => undefined, { branch: "refs/heads/main" }, "trunk"),
    ["targets-default-branch"],
  );
  assert.deepEqual(failedChecks(drop("pull_request")), [
    "pull-request-required",
    "merge-method",
    "approving-reviews",
    "review-threads-resolved",
  ]);
  assert.deepEqual(
    failedChecks(
      (ruleset) =>
        (parameters(ruleset, "pull_request").allowed_merge_methods = ["merge", "squash"]),
    ),
    ["merge-method"],
  );
  assert.deepEqual(
    failedChecks(
      (ruleset) => (parameters(ruleset, "pull_request").required_approving_review_count = 1),
    ),
    ["approving-reviews"],
  );
  assert.deepEqual(
    failedChecks(
      (ruleset) => (parameters(ruleset, "pull_request").required_review_thread_resolution = false),
    ),
    ["review-threads-resolved"],
  );
  assert.deepEqual(failedChecks(drop("required_status_checks")), [
    "required-status-checks",
    "strict-status-checks",
  ]);
  assert.deepEqual(
    failedChecks(
      (ruleset) =>
        (parameters(ruleset, "required_status_checks").required_status_checks = [
          { context: "test" },
        ]),
    ),
    ["required-status-checks"],
  );
  assert.deepEqual(
    failedChecks(
      (ruleset) =>
        (parameters(ruleset, "required_status_checks").required_status_checks = [
          { context: "test" },
          { context: "package" },
          { context: "lint" },
        ]),
    ),
    ["required-status-checks"],
  );
  assert.deepEqual(
    failedChecks(
      (ruleset) =>
        (parameters(ruleset, "required_status_checks").required_status_checks = [
          { context: "test", integration_id: 15368 },
          { context: "package" },
        ]),
    ),
    ["required-status-checks"],
  );
  assert.deepEqual(
    failedChecks(
      (ruleset) =>
        (parameters(ruleset, "required_status_checks").required_status_checks = [
          { name: "test" },
          7,
        ]),
    ),
    ["required-status-checks"],
  );
  assert.deepEqual(
    failedChecks(
      (ruleset) =>
        (parameters(ruleset, "required_status_checks").strict_required_status_checks_policy =
          false),
    ),
    ["strict-status-checks"],
  );
  assert.deepEqual(failedChecks(drop("required_linear_history")), ["linear-history"]);
  assert.deepEqual(failedChecks(drop("non_fast_forward")), ["force-pushes-blocked"]);
  assert.deepEqual(failedChecks(drop("deletion")), ["deletion-blocked"]);
  assert.deepEqual(
    failedChecks(
      (ruleset) =>
        (ruleset.bypass_actors = [
          { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
        ]),
    ),
    ["bypass-actors"],
  );
  assert.deepEqual(
    failedChecks((ruleset) => ruleset.rules.push({ type: "required_signatures" })),
    ["no-unexpected-rules"],
  );
});

test("rules the contract disables must be absent, and listed bypass actors must match exactly", () => {
  const relaxed = {
    pull_request: false,
    required_review_thread_resolution: false,
    required_status_checks: [],
    strict: false,
    required_linear_history: false,
    bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
  };
  assert.deepEqual(
    failedChecks(() => undefined, relaxed),
    [],
  );
  assert.deepEqual(
    failedChecks((ruleset) => {
      ruleset.rules.push(
        { type: "pull_request", parameters: {} },
        { type: "required_linear_history" },
      );
      ruleset.rules.push({
        type: "required_status_checks",
        parameters: { required_status_checks: [] },
      });
      ruleset.bypass_actors = [];
    }, relaxed),
    ["pull-request-required", "required-status-checks", "linear-history", "bypass-actors"],
  );
  assert.deepEqual(
    failedChecks(() => undefined, { strict: false, required_review_thread_resolution: false }),
    [],
  );
});

test("verify passes after a rollout and reports each kind of drift", async () => {
  const fake = new FakeGitHub();
  const target = addCompliantRuleset(fake);
  addUnmanagedRuleset(fake);
  const clean = await verify(fake);
  assert.equal(clean.ok, true);
  assert.ok(clean.checks.length >= 15);
  assert.deepEqual(fake.writes, []);

  addObsoleteRuleset(fake);
  const withObsolete = await verify(fake);
  assert.equal(withObsolete.ok, false);
  assert.deepEqual(
    withObsolete.checks.filter((check) => !check.ok).map((check) => check.id),
    ["no-obsolete-managed-ruleset", "matches-contract"],
  );

  fake.rulesets = fake.rulesets.filter((ruleset) => ruleset.name !== "agentbench-managed-obsolete");
  addCompliantRuleset(fake);
  const withDuplicate = await verify(fake);
  assert.deepEqual(
    withDuplicate.checks.filter((check) => !check.ok).map((check) => check.id),
    ["no-duplicate-managed-ruleset", "matches-contract"],
  );

  fake.rulesets = fake.rulesets.filter((ruleset) => ruleset.id === target.id);
  fake.hideBypassActors = true;
  const unreadable = await verify(fake);
  assert.deepEqual(
    unreadable.checks.filter((check) => !check.ok).map((check) => check.id),
    ["bypass-actors", "matches-contract", "no-blockers"],
  );

  const missing = await verify(new FakeGitHub());
  assert.deepEqual(
    missing.checks.filter((check) => !check.ok).map((check) => check.id),
    ["managed-ruleset-present", "matches-contract"],
  );
});

test("`verify` exits 0 when compliant and 1 on drift, and never writes", async (t) => {
  const fake = new FakeGitHub();
  const target = addCompliantRuleset(fake);
  fake.branches.push({ name: "feature", sha: "f".repeat(40) });
  fake.pulls = [
    {
      number: 7,
      merged_at: "2026-01-02T00:00:00Z",
      head: { ref: "feature", sha: "f".repeat(40), repo: { full_name: "octo/demo" } },
    },
  ];
  const cwd = makeTempRepo(t);
  const ok = await runCli(fake, cwd, ["verify"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /ok {3}ruleset enforcement is active/);
  assert.match(
    ok.stdout,
    /warning: branch "feature" was merged by pull request #7 and still exists remotely/,
  );
  assert.match(ok.stdout, /Verified: the live policy on octo\/demo matches the contract/);
  const first = readFileSync(path.join(cwd, "artifacts", "governance-verify.json"), "utf8");
  assert.equal((JSON.parse(first) as VerifyReport).ok, true);
  assert.equal((await runCli(fake, cwd, ["verify"])).code, 0);
  assert.equal(readFileSync(path.join(cwd, "artifacts", "governance-verify.json"), "utf8"), first);

  target.enforcement = "disabled";
  const drift = await runCli(fake, cwd, ["verify"]);
  assert.equal(drift.code, 1);
  assert.match(drift.stdout, /FAIL ruleset enforcement is active/);
  assert.match(drift.stdout, /Drift detected on octo\/demo/);
  assert.deepEqual(fake.writes, []);
});
