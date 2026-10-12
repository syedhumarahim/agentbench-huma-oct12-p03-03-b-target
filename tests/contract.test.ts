import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDesiredRuleset,
  describeBranchSelectorProblem,
  findDuplicateKeys,
  loadContract,
  parseContract,
} from "../src/contract.ts";
import { ContractError, UsageError } from "../src/errors.ts";
import {
  BASE_CONTRACT_TEXT,
  contractText,
  makeContract,
  makeTempRepo,
} from "./helpers/fixtures.ts";
import path from "node:path";

function issuesFor(overrides: Record<string, unknown>): readonly string[] {
  try {
    parseContract(contractText(overrides));
  } catch (error) {
    assert.ok(error instanceof ContractError, "expected a ContractError");
    return error.issues;
  }
  return assert.fail("contract was unexpectedly accepted");
}

function assertRejected(overrides: Record<string, unknown>, pattern: RegExp): void {
  const issues = issuesFor(overrides);
  assert.ok(
    issues.some((issue) => pattern.test(issue)),
    `expected an issue matching ${pattern}, got:\n${issues.join("\n")}`,
  );
}

test("the tracked contract is valid and yields the protected-main ruleset", () => {
  const contract = parseContract(BASE_CONTRACT_TEXT);
  assert.equal(contract.ruleset_name, "agentbench-managed-protected-main");
  assert.deepEqual(buildDesiredRuleset(contract), {
    name: "agentbench-managed-protected-main",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ["squash"],
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: true,
        },
      },
      { type: "required_linear_history" },
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: false,
          required_status_checks: [{ context: "test" }, { context: "package" }],
          strict_required_status_checks_policy: true,
        },
      },
    ],
  });
});

test("optional rules are omitted from the desired ruleset when the contract disables them", () => {
  const contract = makeContract({
    block_deletions: false,
    block_force_pushes: false,
    pull_request: false,
    required_linear_history: false,
    required_review_thread_resolution: false,
    required_status_checks: [],
    strict: false,
    bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
    branch: "refs/heads/release/1.x",
    obsolete_managed_ruleset_name: undefined,
  });
  const desired = buildDesiredRuleset(contract);
  assert.deepEqual(desired.rules, []);
  assert.deepEqual(desired.bypass_actors, [
    { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
  ]);
  assert.deepEqual(desired.conditions, {
    ref_name: { include: ["refs/heads/release/1.x"], exclude: [] },
  });
  assert.equal(contract.obsolete_managed_ruleset_name, null);
});

test("rejects unsupported contract versions", () => {
  assertRejected({ version: 2 }, /unsupported contract version 2/);
  assertRejected({ version: "1" }, /unsupported contract version "1"/);
});

test("rejects unknown contract keys", () => {
  assertRejected({ require_signed_commits: true }, /unknown contract key "require_signed_commits"/);
});

test("rejects unsupported rule types with the supported list", () => {
  assertRejected(
    { required_signatures: true },
    /unsupported rule type "required_signatures"; supported: deletion/,
  );
  assertRejected({ merge_queue: {} }, /unsupported rule type "merge_queue"/);
  const issues = issuesFor({
    rules: [{ type: "workflows" }, { type: "deletion" }, "tag_name_pattern"],
  });
  assert.ok(issues.some((issue) => issue.includes('unsupported rule type "workflows"')));
  assert.ok(issues.some((issue) => issue.includes('unsupported rule type "tag_name_pattern"')));
  assert.ok(!issues.some((issue) => issue.includes('unsupported rule type "deletion"')));
  assert.ok(issues.some((issue) => issue.includes('unknown contract key "rules"')));
  assertRejected({ rule_types: "everything" }, /unknown contract key "rule_types"/);
});

test("rejects duplicate managed ruleset names", () => {
  assertRejected(
    { obsolete_managed_ruleset_name: "agentbench-managed-protected-main" },
    /duplicate managed ruleset name "agentbench-managed-protected-main"/,
  );
  assertRejected(
    {
      obsolete_managed_ruleset_name: "AGENTBENCH-MANAGED-PROTECTED-MAIN"
        .toLowerCase()
        .replace("main", "MAIN"),
    },
    /must start with the managed prefix|duplicate managed ruleset name/,
  );
  const duplicated = BASE_CONTRACT_TEXT.replace(
    '"ruleset_name"',
    '"ruleset_name": "agentbench-managed-other",\n  "ruleset_name"',
  );
  assert.throws(
    () => parseContract(duplicated),
    (error: unknown) =>
      error instanceof ContractError &&
      error.issues.some((issue) => issue.includes('key "ruleset_name" is declared more than once')),
  );
  const duplicatedKey = BASE_CONTRACT_TEXT.replace('"strict"', '"strict": false,\n  "strict"');
  assert.throws(() => parseContract(duplicatedKey), /duplicate contract key "strict"/);
});

test("findDuplicateKeys walks nested objects, arrays and escaped strings", () => {
  const text =
    '{"a": {"b": 1, "b": 2}, "list": [{"x\\"y": 1, "x\\"y": 2}, [], {}, "s"], "n": -1.5e3, "t": true}';
  assert.deepEqual(findDuplicateKeys(text), ["a.b", 'list.0.x"y']);
  assert.deepEqual(findDuplicateKeys(BASE_CONTRACT_TEXT), []);
});

test("rejects names outside the managed prefix", () => {
  assertRejected(
    { ruleset_name: "protected-main" },
    /"ruleset_name".*must start with the managed prefix/,
  );
  assertRejected(
    { ruleset_name: "agentbench-managed-" },
    /must start with the managed prefix .* and extend it/,
  );
  assertRejected(
    { obsolete_managed_ruleset_name: "legacy" },
    /"obsolete_managed_ruleset_name".*outside the managed scope/,
  );
  assertRejected({ ruleset_name: "has spaces" }, /"ruleset_name" must be a ruleset name/);
  assertRejected({ ruleset_name: 7 }, /"ruleset_name" must be a ruleset name/);
});

test("rejects malformed branch selectors", () => {
  for (const branch of [
    "main",
    "",
    "refs/heads/",
    "refs/heads/a..b",
    "refs/heads/a b",
    "refs/tags/v1",
    42,
    null,
  ]) {
    assertRejected({ branch }, /"branch"/);
  }
  assert.match(
    describeBranchSelectorProblem("refs/heads/.hidden") ?? "",
    /not a valid branch ref name/,
  );
  assert.match(
    describeBranchSelectorProblem("refs/heads/x.lock") ?? "",
    /not a valid branch ref name/,
  );
  assert.match(
    describeBranchSelectorProblem("refs/heads/a//b") ?? "",
    /not a valid branch ref name/,
  );
  assert.equal(describeBranchSelectorProblem("refs/heads/release/1.x"), null);
  assert.equal(describeBranchSelectorProblem("~DEFAULT_BRANCH"), null);
});

test("rejects unsafe wildcard targets", () => {
  assertRejected({ branch: "~ALL" }, /unsafe wildcard target/);
  assertRejected({ branch: "refs/heads/*" }, /unsafe wildcard target/);
  assertRejected({ branch: "refs/heads/release-?" }, /unsafe wildcard target/);
  assertRejected({ branch: "refs/heads/[a-z]" }, /unsafe wildcard target/);
  assertRejected(
    { managed_name_prefix: "*" },
    /"managed_name_prefix" is an unsafe wildcard target/,
  );
  assertRejected({ managed_name_prefix: "agent*" }, /unsafe wildcard target/);
  assertRejected(
    { managed_name_prefix: "" },
    /"managed_name_prefix" must be at least 3 characters/,
  );
  assertRejected({ managed_name_prefix: "a-" }, /at least 3 characters/);
  assertRejected({ managed_name_prefix: 12 }, /"managed_name_prefix" must be a string/);
});

test("rejects empty and malformed status-check names", () => {
  assertRejected(
    { required_status_checks: ["test", ""] },
    /"required_status_checks\[1\]" is an empty status-check name/,
  );
  assertRejected({ required_status_checks: ["   "] }, /empty status-check name/);
  assertRejected({ required_status_checks: [" test"] }, /leading or trailing whitespace/);
  assertRejected({ required_status_checks: ["test", "test"] }, /duplicates status check "test"/);
  assertRejected({ required_status_checks: [7] }, /must be a string/);
  assertRejected({ required_status_checks: "test" }, /"required_status_checks" must be an array/);
});

test("rejects conflicting policies", () => {
  assertRejected({ enforcement: "disabled" }, /conflicting policy: "enforcement" must be "active"/);
  assertRejected({ enforcement: "evaluate" }, /conflicting policy/);
  assertRejected(
    { allowed_merge_method: "merge" },
    /conflicting policy: "allowed_merge_method" is "merge"/,
  );
  assertRejected(
    { required_status_checks: [] },
    /conflicting policy: "strict" is true but "required_status_checks" is empty/,
  );
  assertRejected(
    { pull_request: false },
    /"required_review_thread_resolution" is true but "pull_request" is false/,
  );
  assertRejected(
    {
      pull_request: false,
      required_review_thread_resolution: false,
      required_approving_review_count: 2,
    },
    /"required_approving_review_count" is 2 but "pull_request" is false/,
  );
  assertRejected(
    {
      pull_request: false,
      required_review_thread_resolution: false,
      bypass_actors: [{ actor_id: 1, actor_type: "Team", bypass_mode: "pull_request" }],
    },
    /bypass actor uses bypass_mode "pull_request"/,
  );
});

test("rejects malformed scalar fields and bypass actors", () => {
  assertRejected({ strict: "yes" }, /"strict" must be a boolean, got string "yes"/);
  assertRejected({ block_deletions: null }, /"block_deletions" must be a boolean, got null/);
  assertRejected({ pull_request: [] }, /"pull_request" must be a boolean, got an array/);
  assertRejected(
    { block_force_pushes: {} },
    /"block_force_pushes" must be a boolean, got an object/,
  );
  assertRejected(
    { allowed_merge_method: "fast-forward" },
    /"allowed_merge_method" must be one of merge, squash, rebase/,
  );
  assertRejected({ required_approving_review_count: 1.5 }, /integer between 0 and 10/);
  assertRejected({ required_approving_review_count: 11 }, /integer between 0 and 10/);
  assertRejected({ unmanaged_settings: "overwrite" }, /"unmanaged_settings" must be "preserve"/);
  assertRejected({ bypass_actors: "admins" }, /"bypass_actors" must be an array/);
  assertRejected({ bypass_actors: ["admin"] }, /"bypass_actors\[0\]" must be an object/);
  assertRejected(
    { bypass_actors: [{ actor_id: 1, actor_type: "User", bypass_mode: "always", note: "x" }] },
    /unknown key\(s\): note/,
  );
  assertRejected(
    { bypass_actors: [{ actor_id: 1, actor_type: "User", bypass_mode: "always" }] },
    /actor_type must be one of/,
  );
  assertRejected(
    { bypass_actors: [{ actor_id: 1, actor_type: "Team", bypass_mode: "sometimes" }] },
    /bypass_mode must be one of/,
  );
  assertRejected(
    { bypass_actors: [{ actor_id: null, actor_type: "Team", bypass_mode: "always" }] },
    /actor_id must be a positive integer/,
  );
  assertRejected(
    {
      bypass_actors: [
        { actor_id: 1, actor_type: "Team", bypass_mode: "always" },
        { actor_id: 1, actor_type: "Team", bypass_mode: "pull_request" },
      ],
    },
    /duplicates bypass actor Team:1/,
  );
  const accepted = makeContract({
    bypass_actors: [{ actor_id: null, actor_type: "OrganizationAdmin", bypass_mode: "always" }],
  });
  assert.equal(accepted.bypass_actors.length, 1);
});

test("reports every problem at once, including missing keys", () => {
  const issues = issuesFor({ version: 9, branch: "~ALL", strict: undefined, extra: 1 });
  assert.ok(issues.length >= 4);
  assert.ok(issues.includes('missing required key "strict"'));
  assert.throws(() => parseContract("{not json"), /not valid JSON/);
  assert.throws(() => parseContract("[]"), /top level must be a JSON object/);
});

test("loadContract reports an unreadable file without leaking the absolute path", async (t) => {
  const directory = makeTempRepo(t);
  const loaded = await loadContract(
    path.join(directory, "governance-contract.json"),
    "governance-contract.json",
  );
  assert.match(loaded.sha256, /^[0-9a-f]{64}$/);
  await assert.rejects(
    loadContract(path.join(directory, "missing.json"), "missing.json"),
    (error: unknown) =>
      error instanceof UsageError &&
      error.message === "cannot read governance contract at missing.json" &&
      !error.message.includes(directory),
  );
});
