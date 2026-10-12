import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { computePlan, renderPlanJson, renderPlanMarkdown } from "../src/plan.ts";
import type { Plan } from "../src/plan.ts";
import { inspectRemote } from "../src/remote-state.ts";
import { FakeGitHub } from "./helpers/fake-github.ts";
import {
  addCompliantRuleset,
  addObsoleteRuleset,
  addUnmanagedRuleset,
  CONTRACT_SHA,
  FAKE_TOKEN,
  LOCAL_CHECKS,
  makeContract,
  makeHarness,
  makeTempRepo,
  runCli,
} from "./helpers/fixtures.ts";

async function planFor(fake: FakeGitHub, overrides: Record<string, unknown> = {}): Promise<Plan> {
  const contract = makeContract(overrides);
  const { context, client } = makeHarness(fake, { contract, readOnly: true });
  return computePlan(
    contract,
    CONTRACT_SHA,
    await inspectRemote(client, context.repository, contract),
    LOCAL_CHECKS,
  );
}

test("an unprotected repository needs exactly one create", async () => {
  const fake = new FakeGitHub();
  const plan = await planFor(fake);
  assert.deepEqual(plan.summary, { create: 1, update: 0, delete: 0, total: 1, in_sync: false });
  assert.equal(plan.changes[0]?.action, "create");
  assert.equal(plan.changes[0].ruleset_name, "agentbench-managed-protected-main");
  assert.equal(plan.branch_state.default_branch, "main");
  assert.equal(plan.branch_state.default_branch_head, "a".repeat(40));
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(fake.writes, []);
});

test("a compliant repository needs no change, even with server-added defaults and reordering", async () => {
  const fake = new FakeGitHub();
  const ruleset = addCompliantRuleset(fake);
  ruleset.rules.reverse();
  const statusChecks = ruleset.rules.find((rule) => rule.type === "required_status_checks");
  assert.ok(statusChecks?.parameters);
  statusChecks.parameters.required_status_checks = [
    { context: "package", integration_id: null },
    { context: "test" },
  ];
  delete statusChecks.parameters.do_not_enforce_on_create;
  const pullRequest = ruleset.rules.find((rule) => rule.type === "pull_request");
  assert.ok(pullRequest?.parameters);
  pullRequest.parameters.required_reviewers = [];
  const plan = await planFor(fake);
  assert.deepEqual(plan.summary, { create: 0, update: 0, delete: 0, total: 0, in_sync: true });
  assert.deepEqual(plan.managed_rulesets, [
    {
      id: ruleset.id,
      name: ruleset.name,
      enforcement: "active",
      role: "target",
      matches_contract: true,
    },
  ]);
});

test("drift produces one in-place update listing only the differing fields", async () => {
  const fake = new FakeGitHub();
  const ruleset = addCompliantRuleset(fake);
  ruleset.enforcement = "disabled";
  ruleset.bypass_actors = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
  ruleset.rules = ruleset.rules.filter((rule) => rule.type !== "required_linear_history");
  ruleset.rules.push({ type: "required_signatures" });
  const statusChecks = ruleset.rules.find((rule) => rule.type === "required_status_checks");
  assert.ok(statusChecks?.parameters);
  statusChecks.parameters.strict_required_status_checks_policy = false;
  statusChecks.parameters.required_status_checks = [{ context: "test", integration_id: 15368 }];
  const plan = await planFor(fake);
  assert.equal(plan.summary.total, 1);
  const change = plan.changes[0];
  assert.equal(change?.action, "update");
  assert.equal(change.ruleset_id, ruleset.id);
  assert.deepEqual(
    change.differences.map((difference) => difference.path),
    [
      "bypass_actors",
      "enforcement",
      "rules.required_linear_history",
      "rules.required_signatures",
      "rules.required_status_checks.required_status_checks",
      "rules.required_status_checks.strict_required_status_checks_policy",
    ],
  );
});

test("minimum change: only the obsolete ruleset is deleted when the replacement is compliant", async () => {
  const fake = new FakeGitHub();
  const unmanaged = addUnmanagedRuleset(fake);
  const obsolete = addObsoleteRuleset(fake);
  addCompliantRuleset(fake);
  const plan = await planFor(fake);
  assert.deepEqual(
    plan.changes.map((change) => [change.action, change.ruleset_id]),
    [["delete", obsolete.id]],
  );
  assert.deepEqual(plan.unmanaged_rulesets_preserved, [{ id: unmanaged.id, name: unmanaged.name }]);
  assert.ok(!fake.sequence.includes(`GET /repos/octo/demo/rulesets/${unmanaged.id}`));
});

test("duplicates keep the compliant copy and unrecognised managed names are only warned about", async () => {
  const fake = new FakeGitHub();
  const drifted = addCompliantRuleset(fake);
  drifted.enforcement = "disabled";
  const compliant = addCompliantRuleset(fake);
  const stray = fake.addRuleset({ name: "agentbench-managed-experiment" });
  const plan = await planFor(fake);
  assert.deepEqual(
    plan.changes.map((change) => [change.action, change.ruleset_id]),
    [["delete", drifted.id]],
  );
  assert.deepEqual(
    plan.managed_rulesets.map((ruleset) => [ruleset.id, ruleset.role]),
    [
      [drifted.id, "duplicate"],
      [compliant.id, "target"],
      [stray.id, "unrecognized"],
    ],
  );
  assert.match(plan.warnings.join("\n"), /agentbench-managed-experiment.*left untouched/);
});

test("rulesets from other sources that share the prefix are not managed", async () => {
  const fake = new FakeGitHub();
  const inherited = fake.addRuleset({
    name: "agentbench-managed-org-wide",
    source_type: "Organization",
    source: "octo",
  });
  const plan = await planFor(fake);
  assert.deepEqual(plan.managed_rulesets, []);
  assert.deepEqual(plan.unmanaged_rulesets_preserved, [{ id: inherited.id, name: inherited.name }]);
});

test("planning paginates rulesets, branches and pull requests", async () => {
  const fake = new FakeGitHub();
  fake.pageSize = 2;
  for (let index = 0; index < 5; index += 1) addUnmanagedRuleset(fake, `unmanaged-${index}`);
  addCompliantRuleset(fake);
  for (let index = 0; index < 4; index += 1) {
    fake.branches.push({ name: `feature-${index}`, sha: String(index).repeat(40) });
  }
  fake.pulls = [0, 1, 2, 3, 4].map((index) => ({
    number: index + 1,
    merged_at: index === 3 ? "2026-01-02T00:00:00Z" : null,
    head: {
      ref: `feature-${index}`,
      sha: String(index).repeat(40),
      repo: { full_name: "octo/demo" },
    },
  }));
  const plan = await planFor(fake);
  assert.equal(plan.unmanaged_rulesets_preserved.length, 5);
  assert.equal(plan.summary.total, 0);
  assert.equal(plan.branch_state.branch_count, 5);
  assert.deepEqual(plan.branch_state.merged_branches_remaining, [
    { name: "feature-3", pull_request: 4 },
  ]);
  assert.match(plan.warnings.join("\n"), /branch "feature-3" was merged by pull request #4/);
  assert.equal(fake.log.filter((request) => request.path.endsWith("/rulesets")).length, 3);
  assert.equal(fake.log.filter((request) => request.path.endsWith("/branches")).length, 3);
  assert.equal(fake.log.filter((request) => request.path.endsWith("/pulls")).length, 3);
});

test("merged branches are matched on repository and head commit", async () => {
  const fake = new FakeGitHub();
  fake.branches.push(
    { name: "moved", sha: "1".repeat(40) },
    { name: "fork-named", sha: "2".repeat(40) },
  );
  fake.pulls = [
    {
      number: 1,
      merged_at: "2026-01-02T00:00:00Z",
      head: { ref: "moved", sha: "9".repeat(40), repo: { full_name: "octo/demo" } },
    },
    {
      number: 2,
      merged_at: "2026-01-02T00:00:00Z",
      head: { ref: "fork-named", sha: "2".repeat(40), repo: { full_name: "someone/demo" } },
    },
    {
      number: 3,
      merged_at: "2026-01-02T00:00:00Z",
      head: { ref: "gone", sha: "3".repeat(40), repo: null },
    },
  ];
  const plan = await planFor(fake);
  assert.deepEqual(plan.branch_state.merged_branches_remaining, []);
});

test("blockers: missing default branch, mismatched explicit branch, unreadable bypass actors, missing local checks", async () => {
  const empty = new FakeGitHub();
  empty.branches = [];
  assert.match((await planFor(empty)).blockers.join("\n"), /default branch "main" does not exist/);

  const renamed = new FakeGitHub();
  renamed.defaultBranch = "trunk";
  renamed.branches = [{ name: "trunk", sha: "b".repeat(40) }];
  const mismatched = await planFor(renamed, { branch: "refs/heads/main" });
  assert.match(
    mismatched.blockers.join("\n"),
    /contract targets refs\/heads\/main but the repository's default branch is "trunk"/,
  );
  assert.deepEqual((await planFor(renamed, { branch: "refs/heads/trunk" })).blockers, []);

  const hidden = new FakeGitHub();
  addCompliantRuleset(hidden);
  hidden.hideBypassActors = true;
  const unreadable = await planFor(hidden);
  assert.match(unreadable.blockers.join("\n"), /cannot read bypass actors/);
  assert.equal(unreadable.changes[0]?.action, "update");

  const contract = makeContract({ required_status_checks: ["test", "package", "lint", "deploy"] });
  const state = await inspectRemote(
    makeHarness(new FakeGitHub()).client,
    { owner: "octo", name: "demo" },
    contract,
  );
  const plan = computePlan(contract, CONTRACT_SHA, state, {
    package_scripts: ["test"],
    reporter_contexts: { test: "test", package: "package", lint: "lint" },
  });
  assert.deepEqual(plan.local_checks.problems, [
    'required status check "package" runs npm script "package", which package.json does not define',
    'required status check "lint" runs npm script "lint", which package.json does not define',
    'required status check "deploy" is not reported by scripts/report_local_checks.py; merges would wait forever',
  ]);
  assert.equal(plan.summary.in_sync, false);
  assert.match(renderPlanMarkdown(plan), /\| `deploy` \| missing \| no \|/);
});

test("malformed remote responses are rejected with a clear error", async () => {
  const cases: [RegExp, string, RegExp][] = [
    [/\/repos\/octo\/demo$/, JSON.stringify({ name: "demo" }), /"default_branch" is missing/],
    [/\/branches$/, JSON.stringify([{ name: "main" }]), /branch entry lacks a name or commit sha/],
    [/\/rulesets$/, JSON.stringify([{ id: "x", name: "y" }]), /"id" is not a positive integer/],
    [/\/rulesets$/, JSON.stringify(["text"]), /ruleset entry is not an object/],
    [
      /\/rulesets\/\d+$/,
      JSON.stringify({ id: 101, name: "n", enforcement: "active" }),
      /"rules" is not an array/,
    ],
    [
      /\/rulesets\/\d+$/,
      JSON.stringify({ id: 101, name: "n", enforcement: "active", rules: [{}] }),
      /"type" is not a string/,
    ],
    [
      /\/rulesets\/\d+$/,
      JSON.stringify({ id: 101, name: "n", enforcement: "active", rules: [3] }),
      /rule is not an object/,
    ],
    [
      /\/rulesets\/\d+$/,
      JSON.stringify({
        id: 101,
        name: "n",
        enforcement: "active",
        rules: [{ type: "t", parameters: 1 }],
      }),
      /parameters are not an object/,
    ],
    [
      /\/rulesets\/\d+$/,
      JSON.stringify({ id: 101, name: "n", enforcement: "active", rules: [], conditions: [] }),
      /"conditions" is not an object/,
    ],
    [
      /\/rulesets\/\d+$/,
      JSON.stringify({ id: 101, name: "n", enforcement: "active", rules: [], bypass_actors: {} }),
      /"bypass_actors" is not an array/,
    ],
    [
      /\/rulesets\/\d+$/,
      JSON.stringify({ id: 101, name: "n", enforcement: "active", rules: [], bypass_actors: [1] }),
      /bypass actor is not an object/,
    ],
    [
      /\/rulesets\/\d+$/,
      JSON.stringify({
        id: 101,
        name: "n",
        enforcement: "active",
        rules: [],
        bypass_actors: [{ actor_id: "a", actor_type: "Team", bypass_mode: "always" }],
      }),
      /bypass actor id is not a number/,
    ],
    [/\/rulesets\/\d+$/, "[]", /ruleset is not an object/],
    [/\/pulls$/, JSON.stringify([1]), /pull request entry is not an object/],
    [/\/pulls$/, JSON.stringify([{ number: 1 }]), /pull request entry lacks a head or number/],
  ];
  for (const [pattern, body, expected] of cases) {
    const fake = new FakeGitHub();
    addCompliantRuleset(fake);
    fake.branches.push({ name: "feature", sha: "f".repeat(40) });
    fake.fail("GET", pattern, { status: 200, body });
    await assert.rejects(planFor(fake), expected);
  }
});

test("plan output is deterministic and independent of remote ordering", async () => {
  const build = async (reverse: boolean): Promise<string> => {
    const fake = new FakeGitHub();
    addUnmanagedRuleset(fake, "zeta");
    addObsoleteRuleset(fake);
    const drifted = addCompliantRuleset(fake);
    drifted.enforcement = "disabled";
    addUnmanagedRuleset(fake, "alpha");
    if (reverse) {
      fake.rulesets.reverse();
      for (const ruleset of fake.rulesets) ruleset.rules.reverse();
    }
    const plan = await planFor(fake);
    return renderPlanJson(plan) + renderPlanMarkdown(plan);
  };
  assert.equal(await build(false), await build(true));
});

test("`plan` writes byte-identical artifacts on every run and never writes remotely", async (t) => {
  const fake = new FakeGitHub();
  addUnmanagedRuleset(fake);
  addObsoleteRuleset(fake);
  const cwd = makeTempRepo(t);
  const read = (): string =>
    readFileSync(path.join(cwd, "artifacts", "governance-plan.json"), "utf8") +
    readFileSync(path.join(cwd, "artifacts", "governance-plan.md"), "utf8");

  const first = await runCli(fake, cwd, ["plan"]);
  assert.equal(first.code, 0, first.stderr);
  const firstOutput = read();
  const second = await runCli(fake, cwd, ["plan"]);
  assert.equal(second.code, 0);
  assert.equal(read(), firstOutput);
  assert.equal(second.stdout, first.stdout);
  assert.deepEqual(fake.writes, []);
  assert.match(first.stdout, /1 to create, 0 to update, 1 to delete/);
  assert.match(
    first.stdout,
    /Wrote artifacts\/governance-plan\.json and artifacts\/governance-plan\.md/,
  );

  const parsed = JSON.parse(
    readFileSync(path.join(cwd, "artifacts", "governance-plan.json"), "utf8"),
  ) as Plan;
  assert.deepEqual(
    parsed.changes.map((change) => change.action),
    ["create", "delete"],
  );
  assert.equal(parsed.repository, "octo/demo");
  assert.match(
    firstOutput,
    /## Unmanaged rulesets \(preserved, never modified\)\n\n- `team-release-tags`/,
  );
});

test("plan artifacts contain no token, header, absolute path, timestamp or request id", async (t) => {
  const fake = new FakeGitHub();
  const drifted = addCompliantRuleset(fake);
  drifted.enforcement = "disabled";
  const cwd = makeTempRepo(t);
  const result = await runCli(fake, cwd, ["plan"]);
  assert.equal(result.code, 0, result.stderr);
  const output =
    readFileSync(path.join(cwd, "artifacts", "governance-plan.json"), "utf8") +
    readFileSync(path.join(cwd, "artifacts", "governance-plan.md"), "utf8") +
    result.stdout;
  assert.ok(!output.includes(FAKE_TOKEN));
  assert.ok(!output.includes(cwd));
  assert.doesNotMatch(output, /authorization|bearer/i);
  assert.doesNotMatch(output, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  assert.doesNotMatch(output, /request[-_ ]id|node_id|_links|created_at|updated_at/i);
  assert.doesNotMatch(output, /(^|[\s"'`(])\/(home|Users|tmp|var|private)\//m);
});

test("`plan` exits 1 when a blocker prevents a safe rollout", async (t) => {
  const fake = new FakeGitHub();
  fake.branches = [];
  const result = await runCli(fake, makeTempRepo(t), ["plan"]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /blocker: default branch "main" does not exist/);
  assert.deepEqual(fake.writes, []);
});
