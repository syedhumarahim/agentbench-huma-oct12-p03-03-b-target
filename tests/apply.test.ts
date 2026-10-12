import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { applyContract } from "../src/apply.ts";
import type { ApplyOutcome } from "../src/apply.ts";
import { buildDesiredRuleset } from "../src/contract.ts";
import { ReconcileError } from "../src/errors.ts";
import { diffRuleset, parseLiveRuleset } from "../src/rulesets.ts";
import type { Snapshot } from "../src/snapshot.ts";
import { FakeGitHub } from "./helpers/fake-github.ts";
import type { FakeRuleset } from "./helpers/fake-github.ts";
import {
  addCompliantRuleset,
  addObsoleteRuleset,
  addUnmanagedRuleset,
  FAKE_TOKEN,
  makeContract,
  makeHarness,
  makeTempRepo,
  runCli,
} from "./helpers/fixtures.ts";

interface Run {
  readonly outcome?: ApplyOutcome;
  readonly error?: ReconcileError;
  readonly snapshots: Snapshot[];
  /** Number of remote writes that had been sent when each snapshot was saved. */
  readonly writesAtSnapshot: number[];
}

async function apply(fake: FakeGitHub, overrides: Record<string, unknown> = {}): Promise<Run> {
  const { context } = makeHarness(fake, { contract: makeContract(overrides) });
  const snapshots: Snapshot[] = [];
  const writesAtSnapshot: number[] = [];
  const save = (snapshot: Snapshot): Promise<string> => {
    snapshots.push(snapshot);
    writesAtSnapshot.push(fake.writes.length);
    return Promise.resolve("state/governance-recovery-snapshot.json");
  };
  try {
    return { outcome: await applyContract(context, save), snapshots, writesAtSnapshot };
  } catch (error) {
    assert.ok(error instanceof ReconcileError, `expected a ReconcileError, got ${String(error)}`);
    return { error, snapshots, writesAtSnapshot };
  }
}

function matchesContract(ruleset: FakeRuleset | undefined): boolean {
  if (ruleset === undefined) return false;
  const live = parseLiveRuleset(structuredClone(ruleset), "test");
  return diffRuleset(buildDesiredRuleset(makeContract()), live).length === 0;
}

function managedNames(fake: FakeGitHub): string[] {
  return fake.rulesets
    .filter((ruleset) => ruleset.name.startsWith("agentbench-managed-"))
    .map((ruleset) => ruleset.name)
    .sort();
}

test("first apply creates the protected-main ruleset and verifies it", async () => {
  const fake = new FakeGitHub();
  const run = await apply(fake);
  assert.equal(run.outcome?.changed, true);
  assert.deepEqual(run.outcome.actions, [
    { action: "create", ruleset_id: 101, ruleset_name: "agentbench-managed-protected-main" },
  ]);
  assert.deepEqual(
    fake.writes.map((request) => `${request.method} ${request.path}`),
    ["POST /repos/octo/demo/rulesets"],
  );
  assert.equal(fake.rulesets.length, 1);
  assert.ok(matchesContract(fake.rulesets[0]));
  assert.equal(fake.rulesets[0]?.enforcement, "active");
  assert.deepEqual(fake.rulesets[0].bypass_actors, []);
  const afterCreate = fake.sequence.slice(
    fake.sequence.indexOf("POST /repos/octo/demo/rulesets") + 1,
  );
  assert.equal(
    afterCreate[0],
    "GET /repos/octo/demo/rulesets/101",
    "the replacement is re-read immediately",
  );
});

test("apply is idempotent: a second run sends no write and creates no duplicate", async () => {
  const fake = new FakeGitHub();
  addUnmanagedRuleset(fake);
  addObsoleteRuleset(fake);
  const first = await apply(fake);
  assert.equal(first.outcome?.changed, true);
  const writesAfterFirst = fake.writes.length;
  const stateAfterFirst = JSON.stringify(fake.rulesets);

  for (let run = 0; run < 3; run += 1) {
    const again = await apply(fake);
    assert.equal(again.outcome?.changed, false);
    assert.deepEqual(again.outcome.actions, []);
    assert.equal(again.outcome.remote_writes, 0);
    assert.equal(again.outcome.snapshot, null);
    assert.deepEqual(again.snapshots, [], "a no-op apply must not replace the recovery snapshot");
  }
  assert.equal(fake.writes.length, writesAfterFirst);
  assert.equal(JSON.stringify(fake.rulesets), stateAfterFirst);
  assert.deepEqual(managedNames(fake), ["agentbench-managed-protected-main"]);
});

test("the recovery snapshot is saved before the first remote write", async () => {
  const fake = new FakeGitHub();
  const obsolete = addObsoleteRuleset(fake);
  addUnmanagedRuleset(fake);
  const run = await apply(fake);
  assert.equal(run.outcome?.changed, true);
  assert.deepEqual(run.writesAtSnapshot, [0]);
  const snapshot = run.snapshots[0];
  assert.equal(snapshot?.repository, "octo/demo");
  assert.deepEqual(
    snapshot.rulesets.map((ruleset) => [ruleset.id, ruleset.name]),
    [[obsolete.id, "agentbench-managed-obsolete"]],
    "only managed rulesets are recorded",
  );
  assert.ok(!JSON.stringify(snapshot).includes(FAKE_TOKEN));
});

test("no remote write is attempted when the snapshot cannot be saved", async () => {
  const fake = new FakeGitHub();
  addObsoleteRuleset(fake);
  const { context } = makeHarness(fake);
  await assert.rejects(
    applyContract(context, () => Promise.reject(new Error("disk full"))),
    /disk full/,
  );
  assert.deepEqual(fake.writes, []);
});

test("the replacement is created and verified before the obsolete ruleset is deleted", async () => {
  const fake = new FakeGitHub();
  const unmanaged = addUnmanagedRuleset(fake);
  const obsolete = addObsoleteRuleset(fake);
  const unmanagedBefore = JSON.stringify(unmanaged);
  const run = await apply(fake);
  assert.deepEqual(
    run.outcome?.actions.map((action) => action.action),
    ["create", "delete"],
  );
  const sequence = fake.sequence;
  const created = sequence.indexOf("POST /repos/octo/demo/rulesets");
  const createdId = run.outcome.actions[0]?.ruleset_id ?? 0;
  const verified = sequence.indexOf(`GET /repos/octo/demo/rulesets/${createdId}`);
  const deleted = sequence.indexOf(`DELETE /repos/octo/demo/rulesets/${obsolete.id}`);
  assert.ok(created >= 0 && verified > created && deleted > verified, sequence.join("\n"));
  assert.deepEqual(managedNames(fake), ["agentbench-managed-protected-main"]);
  assert.equal(
    JSON.stringify(fake.rulesets.find((ruleset) => ruleset.id === unmanaged.id)),
    unmanagedBefore,
  );
  assert.ok(fake.writes.every((request) => !request.path.endsWith(`/${unmanaged.id}`)));
  assert.ok(
    fake.log.every((request) =>
      /^\/repos\/octo\/demo(\/(rulesets(\/\d+)?|branches|pulls))?$/.test(request.path),
    ),
    "only repository metadata, branches, pulls and rulesets are ever requested",
  );
});

test("a compliant replacement is re-verified before a leftover obsolete ruleset is deleted", async () => {
  const fake = new FakeGitHub();
  const obsolete = addObsoleteRuleset(fake);
  const target = addCompliantRuleset(fake);
  const run = await apply(fake);
  assert.deepEqual(run.outcome?.actions, [
    { action: "delete", ruleset_id: obsolete.id, ruleset_name: obsolete.name },
  ]);
  assert.deepEqual(
    fake.writes.map((request) => request.method),
    ["DELETE"],
  );
  const sequence = fake.sequence;
  const lastVerification = sequence.lastIndexOf(
    `GET /repos/octo/demo/rulesets/${target.id}`,
    sequence.indexOf(`DELETE /repos/octo/demo/rulesets/${obsolete.id}`),
  );
  assert.ok(lastVerification > sequence.indexOf("GET /repos/octo/demo/rulesets"));
});

test("drift is repaired with a single in-place update", async () => {
  const fake = new FakeGitHub();
  const target = addCompliantRuleset(fake);
  target.enforcement = "disabled";
  target.bypass_actors = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
  const run = await apply(fake);
  assert.deepEqual(run.outcome?.actions, [
    { action: "update", ruleset_id: target.id, ruleset_name: target.name },
  ]);
  assert.deepEqual(
    fake.sequence.filter((entry) => !entry.startsWith("GET")),
    [`PUT /repos/octo/demo/rulesets/${target.id}`],
  );
  assert.ok(matchesContract(fake.rulesets[0]));
});

test("duplicates are removed only after the kept copy is verified", async () => {
  const fake = new FakeGitHub();
  const first = addCompliantRuleset(fake);
  first.enforcement = "disabled";
  const second = addCompliantRuleset(fake);
  const run = await apply(fake);
  assert.deepEqual(run.outcome?.actions, [
    { action: "delete", ruleset_id: first.id, ruleset_name: first.name },
  ]);
  assert.deepEqual(
    fake.rulesets.map((ruleset) => ruleset.id),
    [second.id],
  );
});

test("if the created replacement fails verification, the old policy is preserved", async () => {
  const fake = new FakeGitHub();
  const obsolete = addObsoleteRuleset(fake);
  fake.onStore = (ruleset) => {
    ruleset.rules = ruleset.rules.filter((rule) => rule.type !== "required_status_checks");
  };
  const run = await apply(fake);
  assert.match(
    run.error?.message ?? "",
    /failed verification: rules\.required_status_checks differs from the contract/,
  );
  assert.match(
    run.error?.message ?? "",
    /existing managed rulesets were left in place; no managed ruleset was deleted/,
  );
  assert.ok(
    fake.rulesets.some((ruleset) => ruleset.id === obsolete.id),
    "obsolete policy must survive",
  );
  assert.ok(!fake.sequence.some((entry) => entry.startsWith("DELETE")));
});

test("if verification cannot re-read the replacement, nothing is deleted", async () => {
  const fake = new FakeGitHub();
  const obsolete = addObsoleteRuleset(fake);
  fake.fail("GET", /\/rulesets\/102$/, { status: 500 }, 3);
  const run = await apply(fake);
  assert.match(run.error?.message ?? "", /failed verification: could not re-read the ruleset/);
  assert.ok(fake.rulesets.some((ruleset) => ruleset.id === obsolete.id));
  assert.ok(!fake.sequence.some((entry) => entry.startsWith("DELETE")));

  const recovered = await apply(fake);
  assert.equal(recovered.error, undefined);
  assert.deepEqual(managedNames(fake), ["agentbench-managed-protected-main"]);
});

test("if an updated replacement fails verification, the last verified policy is restored", async () => {
  const fake = new FakeGitHub();
  const target = addCompliantRuleset(fake);
  target.rules = target.rules.filter((rule) => rule.type !== "required_linear_history");
  const obsolete = addObsoleteRuleset(fake);
  const before = structuredClone(target);
  let stores = 0;
  fake.onStore = (ruleset) => {
    stores += 1;
    if (stores === 1) ruleset.enforcement = "disabled";
  };
  const run = await apply(fake);
  assert.match(run.error?.message ?? "", /failed verification/);
  assert.match(
    run.error?.message ?? "",
    /the last verified managed policy was restored; no managed ruleset was deleted/,
  );
  const after = fake.rulesets.find((ruleset) => ruleset.id === target.id);
  assert.equal(after?.enforcement, "active");
  assert.deepEqual(
    after.rules.map((rule) => rule.type).sort(),
    before.rules.map((rule) => rule.type).sort(),
  );
  assert.ok(fake.rulesets.some((ruleset) => ruleset.id === obsolete.id));
  assert.deepEqual(
    fake.writes.map((request) => request.method),
    ["PUT", "PUT"],
  );
});

test("a failed rollback tells the operator to run restore", async () => {
  const fake = new FakeGitHub();
  const target = addCompliantRuleset(fake);
  target.enforcement = "disabled";
  let stores = 0;
  fake.onStore = (ruleset) => {
    stores += 1;
    if (stores === 1) ruleset.target = "tag";
    if (stores === 2) ruleset.enforcement = "evaluate";
  };
  const unconfirmed = await apply(fake);
  assert.match(
    unconfirmed.error?.message ?? "",
    /written back but could not be confirmed; run `restore`/,
  );

  const second = new FakeGitHub();
  const drifted = addCompliantRuleset(second);
  drifted.enforcement = "disabled";
  second.onStore = (ruleset) => {
    ruleset.target = "tag";
  };
  second.fail("PUT", /\/rulesets\/\d+$/, { status: 200, afterEffect: true, body: "{}" });
  second.fail("PUT", /\/rulesets\/\d+$/, {
    status: 403,
    body: JSON.stringify({ message: "denied" }),
  });
  const failed = await apply(second);
  assert.match(
    failed.error?.message ?? "",
    /restoring the previous managed policy failed .*HTTP 403.*run `restore`/,
  );
});

test("a rejected update leaves the previous policy untouched", async () => {
  const fake = new FakeGitHub();
  const target = addCompliantRuleset(fake);
  target.enforcement = "disabled";
  const before = JSON.stringify(fake.rulesets);
  fake.fail("PUT", /\/rulesets\/\d+$/, {
    status: 422,
    body: JSON.stringify({ message: "Invalid rule" }),
  });
  const run = await apply(fake);
  assert.match(
    run.error?.message ?? "",
    /updating ruleset .* failed: .*HTTP 422 - Invalid rule.*previous managed policy is unchanged/,
  );
  assert.equal(JSON.stringify(fake.rulesets), before);
  assert.equal(fake.writes.length, 1);
});

test("an update that keeps failing ambiguously is rolled back", async () => {
  const fake = new FakeGitHub();
  const target = addCompliantRuleset(fake);
  target.enforcement = "disabled";
  fake.fail("PUT", /\/rulesets\/\d+$/, { status: 502, afterEffect: true }, 3);
  const run = await apply(fake);
  assert.match(run.error?.message ?? "", /HTTP 502.*the last verified managed policy was restored/);
  assert.equal(fake.rulesets[0]?.enforcement, "disabled", "the pre-change state is back in place");
});

test("a rejected create leaves existing managed rulesets in place", async () => {
  const fake = new FakeGitHub();
  const obsolete = addObsoleteRuleset(fake);
  fake.fail("POST", /\/rulesets$/, {
    status: 403,
    body: JSON.stringify({ message: "Resource not accessible" }),
  });
  const run = await apply(fake);
  assert.match(
    run.error?.message ?? "",
    /creating ruleset .* failed: .*HTTP 403.*nothing was deleted/,
  );
  assert.deepEqual(
    fake.rulesets.map((ruleset) => ruleset.id),
    [obsolete.id],
  );
  assert.equal(fake.writes.length, 1, "a permanent failure is not retried");
});

test("an ambiguous create is resolved by lookup instead of a duplicate create", async () => {
  for (const response of [
    { failure: "timeout" as const, afterEffect: true },
    { status: 502, afterEffect: true },
    { status: 201, afterEffect: true, body: "{}" },
  ]) {
    const fake = new FakeGitHub();
    addObsoleteRuleset(fake);
    fake.fail("POST", /\/rulesets$/, response);
    const run = await apply(fake);
    assert.equal(run.error, undefined);
    assert.deepEqual(
      run.outcome?.actions.map((action) => action.action),
      ["adopt", "delete"],
    );
    assert.equal(fake.sequence.filter((entry) => entry.startsWith("POST")).length, 1);
    assert.deepEqual(managedNames(fake), ["agentbench-managed-protected-main"]);
  }

  const lost = new FakeGitHub();
  lost.fail("POST", /\/rulesets$/, { failure: "network" });
  const run = await apply(lost);
  assert.match(run.error?.message ?? "", /creating ruleset .* failed: .*network error/);
  assert.deepEqual(lost.rulesets, []);
});

test("partial failure while deleting keeps the verified replacement and is finished by a re-run", async () => {
  const fake = new FakeGitHub();
  const duplicateSource = addCompliantRuleset(fake);
  duplicateSource.enforcement = "disabled";
  addCompliantRuleset(fake);
  const obsolete = addObsoleteRuleset(fake);
  fake.fail("DELETE", new RegExp(`/rulesets/${obsolete.id}$`), { status: 500 }, 3);
  const run = await apply(fake);
  assert.match(
    run.error?.message ?? "",
    /deleting ruleset "agentbench-managed-obsolete" .* failed/,
  );
  assert.match(
    run.error?.message ?? "",
    /verified replacement "agentbench-managed-protected-main" is active; 1 obsolete managed ruleset\(s\) remain\. Re-run apply/,
  );
  assert.ok(
    fake.rulesets.some((ruleset) => matchesContract(ruleset)),
    "protection stays in place",
  );

  const rerun = await apply(fake);
  assert.deepEqual(
    rerun.outcome?.actions.map((action) => action.action),
    ["delete"],
  );
  assert.deepEqual(managedNames(fake), ["agentbench-managed-protected-main"]);
});

test("an obsolete ruleset that is already gone counts as deleted", async () => {
  const fake = new FakeGitHub();
  const obsolete = addObsoleteRuleset(fake);
  fake.fail("DELETE", /\/rulesets\/\d+$/, { status: 404, afterEffect: true, body: "{}" });
  const run = await apply(fake);
  assert.equal(run.error, undefined);
  assert.ok(
    run.outcome?.actions.some(
      (action) => action.action === "delete" && action.ruleset_id === obsolete.id,
    ),
  );
});

test("apply refuses to write when the plan has blockers or the final state still differs", async () => {
  const fake = new FakeGitHub();
  fake.branches = [];
  const blocked = await apply(fake);
  assert.match(blocked.error?.message ?? "", /apply is blocked and made no remote change/);
  assert.deepEqual(fake.writes, []);
  assert.deepEqual(blocked.snapshots, []);

  const racing = new FakeGitHub();
  let listings = 0;
  const original = racing.fetch;
  const fetch: typeof original = (url, init) => {
    if (init.method === "GET" && new URL(url).pathname.endsWith("/rulesets")) {
      listings += 1;
      if (listings === 2) addObsoleteRuleset(racing);
    }
    return original(url, init);
  };
  const { context } = makeHarness(Object.assign(racing, { fetch }));
  await assert.rejects(
    applyContract(context, () => Promise.resolve("state/snapshot.json")),
    /post-apply verification still finds 1 pending change/,
  );
});

test("`apply` writes the snapshot and report, and a second run changes nothing", async (t) => {
  const fake = new FakeGitHub();
  addObsoleteRuleset(fake);
  addUnmanagedRuleset(fake);
  const cwd = makeTempRepo(t);
  const first = await runCli(fake, cwd, ["apply"]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(
    first.stdout,
    /Recovery snapshot saved to state\/governance-recovery-snapshot\.json before the first remote write/,
  );
  assert.match(first.stdout, /Applied and verified\. Remote writes: 2\./);
  const snapshotPath = path.join(cwd, "state", "governance-recovery-snapshot.json");
  const snapshot = readFileSync(snapshotPath, "utf8");
  assert.ok(!snapshot.includes(FAKE_TOKEN) && !snapshot.includes(cwd));
  assert.match(snapshot, /"name": "agentbench-managed-obsolete"/);
  assert.doesNotMatch(snapshot, /team-release-tags/);
  assert.equal(readdirSync(path.join(cwd, "state", "snapshots")).length, 1);
  const report = JSON.parse(
    readFileSync(path.join(cwd, "artifacts", "governance-apply.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(report.remote_writes, 2);
  assert.equal(report.recovery_snapshot, "state/governance-recovery-snapshot.json");

  const writes = fake.writes.length;
  const second = await runCli(fake, cwd, ["apply"]);
  assert.equal(second.code, 0);
  assert.match(
    second.stdout,
    /No changes: the live managed policy already matches the contract\. Remote writes: 0\./,
  );
  assert.equal(fake.writes.length, writes);
  assert.equal(readFileSync(snapshotPath, "utf8"), snapshot, "the pre-change snapshot is kept");
  assert.equal(readdirSync(path.join(cwd, "state", "snapshots")).length, 1);
});

test("`apply` exits 1 on a remote failure without leaking the token", async (t) => {
  const fake = new FakeGitHub();
  fake.fail("POST", /\/rulesets$/, {
    status: 403,
    body: JSON.stringify({ message: `Bad credentials for token ${FAKE_TOKEN}` }),
  });
  const cwd = makeTempRepo(t);
  const result = await runCli(fake, cwd, ["apply"]);
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /^error: creating ruleset "agentbench-managed-protected-main" failed/,
  );
  assert.ok(!result.stderr.includes(FAKE_TOKEN));
  assert.match(result.stderr, /\[REDACTED\]/);
  assert.ok(existsSync(path.join(cwd, "state", "governance-recovery-snapshot.json")));
});
