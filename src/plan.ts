import { buildDesiredRuleset, DEFAULT_BRANCH_SELECTOR } from "./contract.ts";
import type { Contract } from "./contract.ts";
import { fullName } from "./git-remote.ts";
import { stableStringify } from "./json.ts";
import { describeMissingChecks, REPORTER_SCRIPT } from "./local-checks.ts";
import type { LocalChecks } from "./local-checks.ts";
import type { RemoteState } from "./remote-state.ts";
import { canonicalBody, diffRuleset } from "./rulesets.ts";
import type { Difference, LiveRuleset, RulesetBody } from "./rulesets.ts";

export const PLAN_SCHEMA_VERSION = 1;
export const PLAN_JSON_FILE = "governance-plan.json";
export const PLAN_MARKDOWN_FILE = "governance-plan.md";

export type ChangeAction = "create" | "update" | "delete";
export type ManagedRole = "target" | "duplicate" | "obsolete" | "unrecognized";

export interface PlannedChange {
  readonly action: ChangeAction;
  readonly ruleset_id: number | null;
  readonly ruleset_name: string;
  readonly reason: string;
  readonly differences: readonly Difference[];
}

export interface ManagedRulesetReport {
  readonly id: number;
  readonly name: string;
  readonly enforcement: string;
  readonly role: ManagedRole;
  readonly matches_contract: boolean;
}

export interface Plan {
  readonly schema_version: number;
  readonly repository: string;
  readonly contract: {
    readonly sha256: string;
    readonly version: number;
    readonly managed_name_prefix: string;
    readonly ruleset_name: string;
    readonly obsolete_managed_ruleset_name: string | null;
  };
  readonly branch_state: {
    readonly default_branch: string;
    readonly default_branch_head: string | null;
    readonly branch_count: number;
    readonly merged_branches_remaining: RemoteState["merged_branches_remaining"];
  };
  readonly local_checks: {
    readonly required_status_checks: readonly string[];
    readonly reporter_contexts: Readonly<Record<string, string>>;
    readonly package_scripts: readonly string[];
    readonly problems: readonly string[];
  };
  readonly desired_ruleset: RulesetBody;
  readonly managed_rulesets: readonly ManagedRulesetReport[];
  readonly unmanaged_rulesets_preserved: readonly { readonly id: number; readonly name: string }[];
  readonly changes: readonly PlannedChange[];
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly summary: {
    readonly create: number;
    readonly update: number;
    readonly delete: number;
    readonly total: number;
    readonly in_sync: boolean;
  };
}

export interface Classification {
  /** The ruleset that is, or will become, the protected-main policy. */
  readonly target: LiveRuleset | null;
  readonly targetDifferences: readonly Difference[];
  readonly duplicates: readonly LiveRuleset[];
  readonly obsolete: readonly LiveRuleset[];
  readonly unrecognized: readonly LiveRuleset[];
}

/** Sort managed rulesets into the roles the contract assigns them. */
export function classifyManaged(
  contract: Contract,
  managed: readonly LiveRuleset[],
): Classification {
  const desired = buildDesiredRuleset(contract);
  const named = managed.filter((ruleset) => ruleset.name === contract.ruleset_name);
  const target =
    named.find((ruleset) => diffRuleset(desired, ruleset).length === 0) ?? named[0] ?? null;
  return {
    target,
    targetDifferences: target === null ? [] : diffRuleset(desired, target),
    duplicates: named.filter((ruleset) => ruleset !== target),
    obsolete: managed.filter(
      (ruleset) =>
        contract.obsolete_managed_ruleset_name !== null &&
        ruleset.name === contract.obsolete_managed_ruleset_name,
    ),
    unrecognized: managed.filter(
      (ruleset) =>
        ruleset.name !== contract.ruleset_name &&
        ruleset.name !== contract.obsolete_managed_ruleset_name,
    ),
  };
}

function planChanges(contract: Contract, classification: Classification): PlannedChange[] {
  const changes: PlannedChange[] = [];
  const { target, targetDifferences } = classification;
  if (target === null) {
    changes.push({
      action: "create",
      ruleset_id: null,
      ruleset_name: contract.ruleset_name,
      reason: "the contract-managed protected-main ruleset does not exist",
      differences: [],
    });
  } else if (targetDifferences.length > 0) {
    changes.push({
      action: "update",
      ruleset_id: target.id,
      ruleset_name: target.name,
      reason: "the managed ruleset differs from the contract",
      differences: targetDifferences,
    });
  }
  for (const duplicate of classification.duplicates) {
    changes.push({
      action: "delete",
      ruleset_id: duplicate.id,
      ruleset_name: duplicate.name,
      reason: "duplicate of the managed protected-main ruleset",
      differences: [],
    });
  }
  for (const obsolete of classification.obsolete) {
    changes.push({
      action: "delete",
      ruleset_id: obsolete.id,
      ruleset_name: obsolete.name,
      reason: "obsolete managed ruleset named by the contract",
      differences: [],
    });
  }
  return changes;
}

function findBlockers(
  contract: Contract,
  state: RemoteState,
  localProblems: readonly string[],
): string[] {
  const blockers: string[] = [...localProblems];
  if (state.default_branch_head === null) {
    blockers.push(`default branch "${state.default_branch}" does not exist on the remote yet`);
  }
  if (
    contract.branch !== DEFAULT_BRANCH_SELECTOR &&
    contract.branch !== `refs/heads/${state.default_branch}`
  ) {
    blockers.push(
      `the contract targets ${contract.branch} but the repository's default branch is "${state.default_branch}"`,
    );
  }
  if (state.managed.some((ruleset) => !ruleset.bypass_actors_visible)) {
    blockers.push(
      "the credential cannot read bypass actors of the managed rulesets; repository Administration access is required",
    );
  }
  return blockers.sort();
}

/** Pure calculation of the minimum ruleset changes that satisfy the contract. */
export function computePlan(
  contract: Contract,
  contractSha256: string,
  state: RemoteState,
  localChecks: LocalChecks,
): Plan {
  const classification = classifyManaged(contract, state.managed);
  const changes = planChanges(contract, classification);
  const localProblems = describeMissingChecks(contract.required_status_checks, localChecks);
  const blockers = findBlockers(contract, state, localProblems);
  const warnings = [
    ...classification.unrecognized.map(
      (ruleset) =>
        `ruleset "${ruleset.name}" (id ${ruleset.id}) uses the managed prefix but is not named by the contract; it is left untouched`,
    ),
    ...state.merged_branches_remaining.map(
      (branch) =>
        `branch "${branch.name}" was merged by pull request #${branch.pull_request} and still exists remotely`,
    ),
  ].sort();
  const roleOf = (ruleset: LiveRuleset): ManagedRole => {
    if (ruleset === classification.target) return "target";
    if (classification.duplicates.includes(ruleset)) return "duplicate";
    return classification.obsolete.includes(ruleset) ? "obsolete" : "unrecognized";
  };
  const count = (action: ChangeAction): number =>
    changes.filter((change) => change.action === action).length;
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    repository: fullName(state.repository),
    contract: {
      sha256: contractSha256,
      version: contract.version,
      managed_name_prefix: contract.managed_name_prefix,
      ruleset_name: contract.ruleset_name,
      obsolete_managed_ruleset_name: contract.obsolete_managed_ruleset_name,
    },
    branch_state: {
      default_branch: state.default_branch,
      default_branch_head: state.default_branch_head,
      branch_count: state.branch_count,
      merged_branches_remaining: state.merged_branches_remaining,
    },
    local_checks: {
      required_status_checks: [...contract.required_status_checks].sort(),
      reporter_contexts: localChecks.reporter_contexts,
      package_scripts: [...localChecks.package_scripts].sort(),
      problems: localProblems,
    },
    desired_ruleset: canonicalBody(buildDesiredRuleset(contract)),
    managed_rulesets: state.managed.map((ruleset) => ({
      id: ruleset.id,
      name: ruleset.name,
      enforcement: ruleset.enforcement,
      role: roleOf(ruleset),
      matches_contract:
        ruleset === classification.target && classification.targetDifferences.length === 0,
    })),
    unmanaged_rulesets_preserved: state.unmanaged.map((ruleset) => ({
      id: ruleset.id,
      name: ruleset.name,
    })),
    changes,
    blockers,
    warnings,
    summary: {
      create: count("create"),
      update: count("update"),
      delete: count("delete"),
      total: changes.length,
      in_sync: changes.length === 0 && blockers.length === 0,
    },
  };
}

export function renderPlanJson(plan: Plan): string {
  return stableStringify(plan);
}

function inline(value: unknown): string {
  return `\`${JSON.stringify(value).replaceAll("|", "\\|").replaceAll("`", "'")}\``;
}

function bulletList(items: readonly string[]): string[] {
  return items.length === 0 ? ["None."] : items.map((item) => `- ${item}`);
}

export function summarizePlan(plan: Plan): string {
  const { create, update, delete: remove } = plan.summary;
  return plan.summary.total === 0
    ? "No changes: the live managed policy matches the contract."
    : `${create} to create, ${update} to update, ${remove} to delete.`;
}

/** Human-readable plan. Deterministic: derived only from the plan value. */
export function renderPlanMarkdown(plan: Plan): string {
  const lines: string[] = [
    "# Governance plan",
    "",
    `- Repository: \`${plan.repository}\``,
    `- Default branch: \`${plan.branch_state.default_branch}\` at \`${plan.branch_state.default_branch_head ?? "(missing)"}\``,
    `- Contract: version ${plan.contract.version}, sha256 \`${plan.contract.sha256}\``,
    `- Managed scope: rulesets named \`${plan.contract.managed_name_prefix}*\``,
    `- Result: ${summarizePlan(plan)}`,
    "",
    "## Changes",
    "",
  ];
  if (plan.changes.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| # | Action | Ruleset | Id | Reason |", "| --- | --- | --- | --- | --- |");
    plan.changes.forEach((change, index) => {
      lines.push(
        `| ${index + 1} | ${change.action} | \`${change.ruleset_name}\` | ${change.ruleset_id ?? "new"} | ${change.reason} |`,
      );
    });
    for (const change of plan.changes.filter((candidate) => candidate.differences.length > 0)) {
      lines.push("", `### Differences for \`${change.ruleset_name}\``, "");
      lines.push("| Field | Contract | Live |", "| --- | --- | --- |");
      for (const difference of change.differences) {
        lines.push(
          `| \`${difference.path}\` | ${inline(difference.expected)} | ${inline(difference.actual)} |`,
        );
      }
    }
  }
  lines.push("", "## Blockers", "", ...bulletList(plan.blockers));
  lines.push("", "## Warnings", "", ...bulletList(plan.warnings));
  lines.push("", "## Managed rulesets", "");
  if (plan.managed_rulesets.length === 0) {
    lines.push("None.");
  } else {
    lines.push(
      "| Id | Name | Role | Enforcement | Matches contract |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const ruleset of plan.managed_rulesets) {
      lines.push(
        `| ${ruleset.id} | \`${ruleset.name}\` | ${ruleset.role} | ${ruleset.enforcement} | ${ruleset.matches_contract ? "yes" : "no"} |`,
      );
    }
  }
  lines.push("", "## Unmanaged rulesets (preserved, never modified)", "");
  lines.push(
    ...bulletList(
      plan.unmanaged_rulesets_preserved.map((ruleset) => `\`${ruleset.name}\` (id ${ruleset.id})`),
    ),
  );
  lines.push("", "## Local status checks", "");
  lines.push(`Reporter: \`${REPORTER_SCRIPT}\``, "");
  lines.push(
    "| Required context | Reporter command | Defined in package.json |",
    "| --- | --- | --- |",
  );
  for (const context of plan.local_checks.required_status_checks) {
    const script = plan.local_checks.reporter_contexts[context];
    lines.push(
      `| \`${context}\` | ${script === undefined ? "missing" : `\`npm run ${script}\``} | ${script !== undefined && plan.local_checks.package_scripts.includes(script) ? "yes" : "no"} |`,
    );
  }
  lines.push("", "## Branch state", "");
  lines.push(`- Branches on remote: ${plan.branch_state.branch_count}`);
  lines.push(
    `- Merged branches still present: ${
      plan.branch_state.merged_branches_remaining.length === 0
        ? "none"
        : plan.branch_state.merged_branches_remaining
            .map((branch) => `\`${branch.name}\` (#${branch.pull_request})`)
            .join(", ")
    }`,
  );
  lines.push(
    "",
    "## Desired managed ruleset",
    "",
    "```json",
    stableStringify(plan.desired_ruleset).trimEnd(),
    "```",
    "",
  );
  return lines.join("\n");
}
