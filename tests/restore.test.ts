import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { applyContract } from "../src/apply.ts";
import { ReconcileError, SnapshotError } from "../src/errors.ts";
import { readRulesets } from "../src/remote-state.ts";
import { restoreSnapshot } from "../src/restore.ts";
import { createSnapshot, parseSnapshot, serializeSnapshot } from "../src/snapshot.ts";
import type { Snapshot } from "../src/snapshot.ts";
import { FakeGitHub } from "./helpers/fake-github.ts";
import {
  addCompliantRuleset,
  addObsoleteRuleset,
  addUnmanagedRuleset,
  CONTRACT_SHA,
  FAKE_TOKEN,
  makeContract,
  makeHarness,
  makeTempRepo,
  runCli,
} from "./helpers/fixtures.ts";

const REPOSITORY = { owner: "octo", name: "demo" };
const EXPECTED = { repository: REPOSITORY, contract: makeContract() };

/** Capture the managed state of a fake repository exactly as apply would. */
async function capture(fake: FakeGitHub): Promise<Snapshot> {
  const { client, context } = makeHarness(fake);
  const { managed } = await readRulesets(client, REPOSITORY, context.contract);
  fake.log.length = 0;
  return createSnapshot(REPOSITORY, context.contract, CONTRACT_SHA, managed);
}

function tamper(snapshot: Snapshot, edit: (raw: Record<string, unknown>) => void): string {
  const raw = JSON.parse(serializeSnapshot(snapshot)) as Record<string, unknown>;
  edit(raw);
  return JSON.stringify(raw);
}

function firstRuleset(raw: Record<string, unknown>): Record<string, unknown> {
  return (raw.rulesets as Record<string, unknown>[])[0] ?? {};
}

test("a snapshot round-trips through serialisation and validation", async () => {
  const fake = new FakeGitHub();
  addObsoleteRuleset(fake);
  const drifted = addCompliantRuleset(fake);
  drifted.bypass_actors = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
  addUnmanagedRuleset(fake);
  const snapshot = await capture(fake);
  const text = serializeSnapshot(snapshot);
  assert.deepEqual(parseSnapshot(text, EXPECTED), snapshot);
  assert.equal(serializeSnapshot(parseSnapshot(text, EXPECTED)), text);
  assert.deepEqual(
    snapshot.rulesets.map((ruleset) => ruleset.name),
    ["agentbench-managed-obsolete", "agentbench-managed-protected-main"],
  );
  assert.doesNotMatch(text, /team-release-tags|node_id|_links|created_at|Authorization/);
  assert.ok(!text.includes(FAKE_TOKEN));
});

test("restore re-creates deleted rulesets and reverts changed ones", async () => {
  const fake = new FakeGitHub();
  const obsolete = addObsoleteRuleset(fake);
  const original = addCompliantRuleset(fake);
  original.enforcement = "disabled";
  const unmanaged = addUnmanagedRuleset(fake);
  const unmanagedBefore = JSON.stringify(unmanaged);
  const snapshot = await capture(fake);

  const rollout = makeHarness(fake);
  await applyContract(rollout.context, () => Promise.resolve("state/snapshot.json"));
  assert.ok(!fake.rulesets.some((ruleset) => ruleset.id === obsolete.id));
  fake.log.length = 0;

  const { context } = makeHarness(fake);
  const outcome = await restoreSnapshot(context, snapshot);
  assert.deepEqual(
    outcome.actions.map((action) => [action.action, action.ruleset_name]),
    [
      ["create", "agentbench-managed-obsolete"],
      ["update", "agentbench-managed-protected-main"],
    ],
  );
  assert.equal(outcome.remote_writes, 2);
  assert.equal(outcome.unmanaged_preserved, 1);
  assert.equal(
    fake.rulesets.find((ruleset) => ruleset.id === original.id)?.enforcement,
    "disabled",
  );
  const recreated = fake.rulesets.find((ruleset) => ruleset.name === "agentbench-managed-obsolete");
  assert.deepEqual(recreated?.rules, [{ type: "deletion" }, { type: "non_fast_forward" }]);
  assert.equal(
    JSON.stringify(fake.rulesets.find((ruleset) => ruleset.id === unmanaged.id)),
    unmanagedBefore,
  );
  assert.ok(!fake.sequence.some((entry) => entry.startsWith("DELETE")), "restore never deletes");
  assert.ok(!fake.sequence.some((entry) => entry.endsWith(`/rulesets/${unmanaged.id}`)));

  fake.log.length = 0;
  const again = await restoreSnapshot(makeHarness(fake).context, snapshot);
  assert.deepEqual(
    again.actions.map((action) => action.action),
    ["unchanged", "unchanged"],
  );
  assert.deepEqual(fake.writes, [], "a repeated restore is a no-op");
});

test("restore touches only recorded rulesets and reports the rest as left in place", async () => {
  const fake = new FakeGitHub();
  addObsoleteRuleset(fake);
  const snapshot = await capture(fake);
  const replacement = addCompliantRuleset(fake);
  const unmanaged = addUnmanagedRuleset(fake);
  const before = JSON.stringify(fake.rulesets);
  const outcome = await restoreSnapshot(makeHarness(fake).context, snapshot);
  assert.deepEqual(
    outcome.actions.map((action) => action.action),
    ["unchanged"],
  );
  assert.deepEqual(outcome.left_in_place, [{ id: replacement.id, name: replacement.name }]);
  assert.equal(JSON.stringify(fake.rulesets), before);
  assert.deepEqual(fake.writes, []);
  assert.ok(!fake.sequence.some((entry) => entry.endsWith(`/rulesets/${unmanaged.id}`)));
});

test("an empty snapshot restores nothing and writes nothing", async () => {
  const fake = new FakeGitHub();
  const snapshot = await capture(fake);
  addCompliantRuleset(fake);
  const outcome = await restoreSnapshot(makeHarness(fake).context, snapshot);
  assert.deepEqual(outcome.actions, []);
  assert.deepEqual(fake.writes, []);
  assert.equal(fake.rulesets.length, 1);
});

test("partial remote failure reports progress, leaves unmanaged rulesets alone and can be resumed", async () => {
  const fake = new FakeGitHub();
  addObsoleteRuleset(fake);
  const target = addCompliantRuleset(fake);
  const extra = fake.addRuleset({
    name: "agentbench-managed-extra",
    rules: [{ type: "deletion" }],
  });
  const unmanaged = addUnmanagedRuleset(fake);
  const unmanagedBefore = JSON.stringify(unmanaged);
  const snapshot = await capture(fake);

  fake.rulesets = fake.rulesets.filter((ruleset) => ruleset.name !== "agentbench-managed-obsolete");
  target.enforcement = "disabled";
  extra.rules = [];
  fake.fail("PUT", new RegExp(`/rulesets/${target.id}$`), { status: 500 }, 3);

  const { context } = makeHarness(fake);
  await assert.rejects(restoreSnapshot(context, snapshot), (error: unknown) => {
    assert.ok(error instanceof ReconcileError);
    assert.match(
      error.message,
      /restoring ruleset "agentbench-managed-protected-main" failed: .*HTTP 500/,
    );
    assert.match(
      error.message,
      /1 ruleset\(s\) were restored before the failure; 1 not attempted \(agentbench-managed-extra\)/,
    );
    assert.match(
      error.message,
      /Unmanaged rulesets were not touched\. Re-run restore to continue\./,
    );
    return true;
  });
  assert.ok(fake.rulesets.some((ruleset) => ruleset.name === "agentbench-managed-obsolete"));
  assert.deepEqual(fake.rulesets.find((ruleset) => ruleset.id === extra.id)?.rules, []);
  assert.equal(
    JSON.stringify(fake.rulesets.find((ruleset) => ruleset.id === unmanaged.id)),
    unmanagedBefore,
  );

  const resumed = await restoreSnapshot(makeHarness(fake).context, snapshot);
  assert.deepEqual(
    resumed.actions.map((action) => action.action),
    ["unchanged", "update", "update"],
  );
  assert.equal(fake.rulesets.find((ruleset) => ruleset.id === target.id)?.enforcement, "active");
  assert.equal(
    fake.rulesets.filter((ruleset) => ruleset.name === "agentbench-managed-obsolete").length,
    1,
  );
});

test("restore fails when the restored ruleset does not match the snapshot", async () => {
  const fake = new FakeGitHub();
  addObsoleteRuleset(fake);
  const snapshot = await capture(fake);
  fake.rulesets = [];
  fake.onStore = (ruleset) => {
    ruleset.enforcement = "disabled";
  };
  await assert.rejects(
    restoreSnapshot(makeHarness(fake).context, snapshot),
    /restored ruleset does not match the snapshot \(enforcement\)/,
  );
});

test("an ambiguous create during restore adopts the existing ruleset instead of duplicating it", async () => {
  const fake = new FakeGitHub();
  addObsoleteRuleset(fake);
  const snapshot = await capture(fake);
  fake.rulesets = [];
  fake.fail("POST", /\/rulesets$/, { failure: "timeout", afterEffect: true });
  const outcome = await restoreSnapshot(makeHarness(fake).context, snapshot);
  assert.deepEqual(
    outcome.actions.map((action) => action.action),
    ["adopt"],
  );
  assert.equal(fake.rulesets.length, 1);
});

test("malformed snapshots are rejected before any request is made", async () => {
  const fake = new FakeGitHub();
  addObsoleteRuleset(fake);
  const drifted = addCompliantRuleset(fake);
  drifted.bypass_actors = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
  const snapshot = await capture(fake);
  const cases: [string, string, RegExp][] = [
    ["not json", "{", /not valid JSON/],
    ["not an object", "[]", /top level must be an object/],
    ["unknown key", tamper(snapshot, (raw) => (raw.extra = 1)), /unknown key\(s\): extra/],
    [
      "missing key",
      tamper(snapshot, (raw) => delete raw.contract_sha256),
      /missing key\(s\): contract_sha256/,
    ],
    ["wrong kind", tamper(snapshot, (raw) => (raw.kind = "backup")), /"kind" must be/],
    [
      "wrong schema",
      tamper(snapshot, (raw) => (raw.schema_version = 2)),
      /unsupported schema_version 2/,
    ],
    [
      "other repository",
      tamper(snapshot, (raw) => (raw.repository = "octo/other")),
      /different repository than octo\/demo/,
    ],
    [
      "other prefix",
      tamper(snapshot, (raw) => (raw.managed_name_prefix = "team-")),
      /managed prefix does not match/,
    ],
    [
      "bad contract digest",
      tamper(snapshot, (raw) => (raw.contract_sha256 = "abc")),
      /"contract_sha256" must be a SHA-256/,
    ],
    [
      "rulesets not array",
      tamper(snapshot, (raw) => (raw.rulesets = {})),
      /"rulesets" must be an array/,
    ],
    [
      "ruleset not object",
      tamper(snapshot, (raw) => (raw.rulesets = [1])),
      /rulesets\[0\] must be an object/,
    ],
    [
      "edited content",
      tamper(snapshot, (raw) => (firstRuleset(raw).enforcement = "disabled")),
      /integrity digest mismatch/,
    ],
    ["truncated", tamper(snapshot, (raw) => (raw.rulesets = [])), /integrity digest mismatch/],
    [
      "unmanaged name",
      tamper(snapshot, (raw) => (firstRuleset(raw).name = "team-release-tags")),
      /outside the managed prefix .* only contract-managed rulesets may be restored/,
    ],
    [
      "bare prefix name",
      tamper(snapshot, (raw) => (firstRuleset(raw).name = "agentbench-managed-")),
      /outside the managed prefix/,
    ],
    [
      "bad id",
      tamper(snapshot, (raw) => (firstRuleset(raw).id = -1)),
      /id must be a positive integer/,
    ],
    ["bad name", tamper(snapshot, (raw) => (firstRuleset(raw).name = 5)), /name must be a string/],
    [
      "bad target",
      tamper(snapshot, (raw) => (firstRuleset(raw).target = "everything")),
      /target must be one of branch, tag, push/,
    ],
    [
      "bad enforcement",
      tamper(snapshot, (raw) => (firstRuleset(raw).enforcement = "sometimes")),
      /enforcement must be one of/,
    ],
    [
      "bad conditions",
      tamper(snapshot, (raw) => (firstRuleset(raw).conditions = [])),
      /conditions must be an object/,
    ],
    [
      "bad rules",
      tamper(snapshot, (raw) => (firstRuleset(raw).rules = "all")),
      /rules must be an array/,
    ],
    [
      "rule not object",
      tamper(snapshot, (raw) => (firstRuleset(raw).rules = [1])),
      /rules entries must be objects/,
    ],
    [
      "rule without type",
      tamper(snapshot, (raw) => (firstRuleset(raw).rules = [{}])),
      /rules entry lacks a type/,
    ],
    [
      "rule with extra key",
      tamper(snapshot, (raw) => (firstRuleset(raw).rules = [{ type: "deletion", id: 1 }])),
      /rules entry has unknown key\(s\): id/,
    ],
    [
      "rule parameters",
      tamper(snapshot, (raw) => (firstRuleset(raw).rules = [{ type: "x", parameters: 1 }])),
      /parameters must be an object/,
    ],
    [
      "bypass not array",
      tamper(snapshot, (raw) => (firstRuleset(raw).bypass_actors = {})),
      /bypass_actors must be an array/,
    ],
    [
      "bypass not object",
      tamper(snapshot, (raw) => (firstRuleset(raw).bypass_actors = [1])),
      /bypass_actors entries must be objects/,
    ],
    [
      "bypass malformed",
      tamper(
        snapshot,
        (raw) =>
          (firstRuleset(raw).bypass_actors = [
            { actor_id: "x", actor_type: "Team", bypass_mode: "always" },
          ]),
      ),
      /bypass_actors entry is malformed/,
    ],
    [
      "ruleset extra key",
      tamper(snapshot, (raw) => (firstRuleset(raw).node_id = "x")),
      /rulesets\[0\] has unknown key\(s\): node_id/,
    ],
    [
      "duplicate ids",
      tamper(snapshot, (raw) => (raw.rulesets = [firstRuleset(raw), firstRuleset(raw)])),
      /ruleset ids must be unique/,
    ],
    [
      "credential material",
      tamper(snapshot, (raw) => (firstRuleset(raw).conditions = { note: `Bearer ${FAKE_TOKEN}` })),
      /contains credential-like material/,
    ],
  ];
  for (const [label, text, expected] of cases) {
    assert.throws(
      () => parseSnapshot(text, EXPECTED),
      (error: unknown) => error instanceof SnapshotError && expected.test(error.message),
      label,
    );
  }
  assert.deepEqual(fake.log, []);
});

test("`restore` with a missing snapshot exits 2 and makes no request", async (t) => {
  const fake = new FakeGitHub();
  addCompliantRuleset(fake);
  const cwd = makeTempRepo(t);
  const result = await runCli(fake, cwd, ["restore"]);
  assert.equal(result.code, 2);
  assert.equal(
    result.stderr,
    "error: no recovery snapshot found at state/governance-recovery-snapshot.json; nothing was changed\n",
  );
  assert.deepEqual(fake.log, []);
});

test("`restore` with a malformed snapshot exits 2 and makes no request", async (t) => {
  const fake = new FakeGitHub();
  addObsoleteRuleset(fake);
  const snapshot = await capture(fake);
  const cwd = makeTempRepo(t);
  mkdirSync(path.join(cwd, "state"));
  const file = path.join(cwd, "state", "governance-recovery-snapshot.json");
  writeFileSync(
    file,
    tamper(snapshot, (raw) => (firstRuleset(raw).name = "team-release-tags")),
  );
  const result = await runCli(fake, cwd, ["restore"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^error: recovery snapshot is invalid: .*outside the managed prefix/);
  assert.deepEqual(fake.log, []);
});

test("`apply` then `restore` returns the managed rulesets to the snapshot state", async (t) => {
  const fake = new FakeGitHub();
  addObsoleteRuleset(fake);
  const unmanaged = addUnmanagedRuleset(fake);
  const unmanagedBefore = JSON.stringify(unmanaged);
  const cwd = makeTempRepo(t);
  assert.equal((await runCli(fake, cwd, ["apply"])).code, 0);
  assert.ok(!fake.rulesets.some((ruleset) => ruleset.name === "agentbench-managed-obsolete"));

  const restored = await runCli(fake, cwd, ["restore"]);
  assert.equal(restored.code, 0, restored.stderr);
  assert.match(restored.stdout, /create agentbench-managed-obsolete/);
  assert.match(
    restored.stdout,
    /left in place \(not in snapshot\): agentbench-managed-protected-main/,
  );
  assert.match(restored.stdout, /1 unmanaged ruleset\(s\) untouched\. Remote writes: 1\./);
  assert.ok(fake.rulesets.some((ruleset) => ruleset.name === "agentbench-managed-obsolete"));
  assert.equal(
    JSON.stringify(fake.rulesets.find((ruleset) => ruleset.id === unmanaged.id)),
    unmanagedBefore,
  );
  const report = readFileSync(path.join(cwd, "artifacts", "governance-restore.json"), "utf8");
  assert.ok(!report.includes(FAKE_TOKEN) && !report.includes(cwd));

  const explicit = await runCli(fake, cwd, [
    "restore",
    "--snapshot",
    "state/governance-recovery-snapshot.json",
  ]);
  assert.equal(explicit.code, 0);
  assert.match(explicit.stdout, /unchanged agentbench-managed-obsolete/);
});

test("`restore` exits 1 on partial remote failure", async (t) => {
  const fake = new FakeGitHub();
  addObsoleteRuleset(fake);
  const cwd = makeTempRepo(t);
  assert.equal((await runCli(fake, cwd, ["apply"])).code, 0);
  fake.fail("POST", /\/rulesets$/, { status: 403, body: JSON.stringify({ message: "denied" }) });
  const result = await runCli(fake, cwd, ["restore"]);
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /restoring ruleset "agentbench-managed-obsolete" failed: .*HTTP 403 - denied/,
  );
});
