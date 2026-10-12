import { DEFAULT_BRANCH_SELECTOR } from "./contract.ts";
import type { Contract } from "./contract.ts";
import { canonicalJson, isRecord } from "./json.ts";
import { classifyManaged, computePlan } from "./plan.ts";
import type { Plan } from "./plan.ts";
import type { LocalChecks } from "./local-checks.ts";
import type { RemoteState } from "./remote-state.ts";
import type { LiveRuleset, RuleSpec } from "./rulesets.ts";

export const VERIFY_JSON_FILE = "governance-verify.json";

export interface PolicyCheck {
  readonly id: string;
  readonly description: string;
  readonly ok: boolean;
}

export interface VerifyReport {
  readonly schema_version: 1;
  readonly repository: string;
  readonly default_branch: string;
  readonly contract_sha256: string;
  readonly ok: boolean;
  readonly checks: readonly PolicyCheck[];
  readonly warnings: readonly string[];
}

function findRule(ruleset: LiveRuleset, type: string): RuleSpec | undefined {
  return ruleset.rules.find((rule) => rule.type === type);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return canonicalJson([...a].sort()) === canonicalJson([...b].sort());
}

/**
 * Check a live ruleset against each contract requirement by inspecting the rules directly.
 * This is intentionally independent of `diffRuleset`, so apply has two separate confirmations.
 */
export function evaluatePolicy(
  contract: Contract,
  defaultBranch: string,
  ruleset: LiveRuleset,
): PolicyCheck[] {
  const checks: PolicyCheck[] = [];
  const add = (id: string, description: string, ok: boolean): void => {
    checks.push({ id, description, ok });
  };
  const presence = (id: string, type: string, wanted: boolean, label: string): void => {
    const present = findRule(ruleset, type) !== undefined;
    add(
      id,
      wanted ? label : `${label} is not required by the contract and is absent`,
      present === wanted,
    );
  };

  add("enforcement-active", "ruleset enforcement is active", ruleset.enforcement === "active");

  const refName = ruleset.conditions.ref_name;
  const include = isRecord(refName) ? stringArray(refName.include) : [];
  const exclude = isRecord(refName) && Array.isArray(refName.exclude) ? refName.exclude : [];
  const selector = include[0];
  add(
    "targets-default-branch",
    `ruleset targets only the default branch "${defaultBranch}"`,
    ruleset.target === "branch" &&
      include.length === 1 &&
      exclude.length === 0 &&
      selector === contract.branch &&
      (selector === DEFAULT_BRANCH_SELECTOR || selector === `refs/heads/${defaultBranch}`),
  );

  const pullRequest = findRule(ruleset, "pull_request");
  presence(
    "pull-request-required",
    "pull_request",
    contract.pull_request,
    "changes must arrive through a pull request",
  );
  if (contract.pull_request) {
    const parameters = pullRequest?.parameters ?? {};
    add(
      "merge-method",
      `only the "${contract.allowed_merge_method}" merge method is allowed`,
      sameSet(stringArray(parameters.allowed_merge_methods), [contract.allowed_merge_method]),
    );
    add(
      "approving-reviews",
      `required approving review count is ${contract.required_approving_review_count}`,
      parameters.required_approving_review_count === contract.required_approving_review_count,
    );
    add(
      "review-threads-resolved",
      contract.required_review_thread_resolution
        ? "review conversations must be resolved"
        : "review conversation resolution is not required by the contract",
      parameters.required_review_thread_resolution === contract.required_review_thread_resolution,
    );
  }

  const statusChecks = findRule(ruleset, "required_status_checks");
  const wantsChecks = contract.required_status_checks.length > 0;
  const entries: unknown[] = Array.isArray(statusChecks?.parameters?.required_status_checks)
    ? statusChecks.parameters.required_status_checks
    : [];
  const contexts = entries.map((entry) => (isRecord(entry) ? entry.context : undefined));
  const pinned = entries.some(
    (entry) =>
      isRecord(entry) && entry.integration_id !== undefined && entry.integration_id !== null,
  );
  add(
    "required-status-checks",
    wantsChecks
      ? `required status checks are exactly: ${[...contract.required_status_checks].sort().join(", ")}`
      : "no status checks are required by the contract",
    wantsChecks
      ? contexts.every((context) => typeof context === "string") &&
          sameSet(contexts, contract.required_status_checks) &&
          !pinned
      : statusChecks === undefined,
  );
  if (wantsChecks) {
    add(
      "strict-status-checks",
      contract.strict
        ? "the pull-request head must be up to date before merging"
        : "an up-to-date pull-request head is not required by the contract",
      statusChecks?.parameters?.strict_required_status_checks_policy === contract.strict,
    );
  }

  presence(
    "linear-history",
    "required_linear_history",
    contract.required_linear_history,
    "linear history is required",
  );
  presence(
    "force-pushes-blocked",
    "non_fast_forward",
    contract.block_force_pushes,
    "force pushes are blocked",
  );
  presence("deletion-blocked", "deletion", contract.block_deletions, "branch deletion is blocked");

  const wantedActors = contract.bypass_actors.map((actor) => canonicalJson(actor)).sort();
  const liveActors = ruleset.bypass_actors.map((actor) => canonicalJson(actor)).sort();
  add(
    "bypass-actors",
    contract.bypass_actors.length === 0
      ? "no bypass actor is configured"
      : "bypass actors are exactly those listed in the contract",
    ruleset.bypass_actors_visible && canonicalJson(wantedActors) === canonicalJson(liveActors),
  );

  const expectedTypes = [
    "deletion",
    "non_fast_forward",
    "pull_request",
    "required_linear_history",
    "required_status_checks",
  ];
  add(
    "no-unexpected-rules",
    "the managed ruleset contains no rule outside the contract",
    ruleset.rules.every((rule) => expectedTypes.includes(rule.type)),
  );
  return checks;
}

/** Full read-only verification of the live repository against the contract. */
export function buildVerifyReport(
  contract: Contract,
  contractSha256: string,
  state: RemoteState,
  localChecks: LocalChecks,
): { report: VerifyReport; plan: Plan } {
  const plan = computePlan(contract, contractSha256, state, localChecks);
  const classification = classifyManaged(contract, state.managed);
  const checks: PolicyCheck[] = [
    {
      id: "managed-ruleset-present",
      description: `managed ruleset "${contract.ruleset_name}" exists`,
      ok: classification.target !== null,
    },
    {
      id: "no-duplicate-managed-ruleset",
      description: "no duplicate of the managed ruleset exists",
      ok: classification.duplicates.length === 0,
    },
    {
      id: "no-obsolete-managed-ruleset",
      description: "no obsolete contract-managed ruleset remains",
      ok: classification.obsolete.length === 0,
    },
    ...(classification.target === null
      ? []
      : evaluatePolicy(contract, state.default_branch, classification.target)),
    {
      id: "matches-contract",
      description: "the live managed policy matches the contract with no pending change",
      ok: plan.changes.length === 0,
    },
    {
      id: "no-blockers",
      description: "the default branch exists and every required status check has a local producer",
      ok: plan.blockers.length === 0,
    },
  ];
  return {
    plan,
    report: {
      schema_version: 1,
      repository: plan.repository,
      default_branch: state.default_branch,
      contract_sha256: contractSha256,
      ok: checks.every((check) => check.ok),
      checks,
      warnings: [...plan.blockers, ...plan.warnings],
    },
  };
}
