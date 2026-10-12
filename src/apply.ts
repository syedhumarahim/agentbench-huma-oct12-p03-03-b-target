import { buildDesiredRuleset } from "./contract.ts";
import type { Contract } from "./contract.ts";
import { GitHubError, ReconcileError } from "./errors.ts";
import type { RepositoryRef } from "./git-remote.ts";
import type { GitHubClient } from "./github.ts";
import { isRecord } from "./json.ts";
import type { LocalChecks } from "./local-checks.ts";
import { classifyManaged, computePlan } from "./plan.ts";
import type { Plan } from "./plan.ts";
import { inspectRemote, readRuleset, readRulesets, repoPath } from "./remote-state.ts";
import { canonicalBody, diffRuleset } from "./rulesets.ts";
import type { LiveRuleset, RulesetBody } from "./rulesets.ts";
import { createSnapshot } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";
import { evaluatePolicy } from "./verify.ts";

export const APPLY_JSON_FILE = "governance-apply.json";

export interface CommandContext {
  readonly contract: Contract;
  readonly contractSha256: string;
  readonly repository: RepositoryRef;
  readonly client: GitHubClient;
  readonly localChecks: LocalChecks;
}

export interface AppliedAction {
  readonly action: "create" | "adopt" | "update" | "delete";
  readonly ruleset_id: number;
  readonly ruleset_name: string;
}

export interface ApplyOutcome {
  readonly changed: boolean;
  readonly plan: Plan;
  readonly actions: readonly AppliedAction[];
  /** Display path of the recovery snapshot, or null when no remote write was needed. */
  readonly snapshot: string | null;
  readonly remote_writes: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function rulesetPath(repository: RepositoryRef, id?: number): string {
  return repoPath(repository, id === undefined ? "/rulesets" : `/rulesets/${id}`);
}

/**
 * Create a ruleset. POST is not idempotent, so an ambiguous failure (timeout, network error, 5xx)
 * is resolved by looking the ruleset up by name instead of blindly sending a second create.
 */
export async function createRuleset(
  context: CommandContext,
  body: RulesetBody,
): Promise<{ id: number; adopted: boolean }> {
  const { client, repository, contract } = context;
  try {
    const response = await client.request("POST", rulesetPath(repository), body);
    const id = isRecord(response.data) ? response.data.id : undefined;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      throw new GitHubError("GitHub returned a malformed response for the created ruleset: no id", {
        kind: "malformed",
        method: "POST",
        path: rulesetPath(repository),
      });
    }
    return { id, adopted: false };
  } catch (error) {
    if (!(error instanceof GitHubError) || !(error.ambiguous || error.kind === "malformed"))
      throw error;
    const { managed } = await readRulesets(client, repository, contract);
    const existing = managed.find((ruleset) => ruleset.name === body.name);
    if (existing === undefined) throw error;
    return { id: existing.id, adopted: true };
  }
}

/** Fresh read of the replacement, checked two independent ways. Returns the problems found. */
async function verifyReplacement(
  context: CommandContext,
  id: number,
  defaultBranch: string,
): Promise<string[]> {
  let live: LiveRuleset;
  try {
    live = await readRuleset(context.client, context.repository, id);
  } catch (error) {
    return [`could not re-read the ruleset: ${describe(error)}`];
  }
  const differences = diffRuleset(buildDesiredRuleset(context.contract), live).map(
    (difference) => `${difference.path} differs from the contract`,
  );
  const failedChecks = evaluatePolicy(context.contract, defaultBranch, live)
    .filter((check) => !check.ok)
    .map((check) => `check "${check.id}" failed`);
  return [...new Set([...differences, ...failedChecks])];
}

async function rollBackUpdate(context: CommandContext, previous: LiveRuleset): Promise<string> {
  const body = canonicalBody(previous);
  try {
    await context.client.request("PUT", rulesetPath(context.repository, previous.id), body);
    const restored = await readRuleset(context.client, context.repository, previous.id);
    return diffRuleset(body, restored).length === 0
      ? "the last verified managed policy was restored"
      : "the previous managed policy was written back but could not be confirmed; run `restore`";
  } catch (error) {
    return `restoring the previous managed policy failed (${describe(error)}); run \`restore\` to recover from the snapshot`;
  }
}

/**
 * Reconcile the contract-managed rulesets.
 *
 * Order of operations:
 *   1. read-only inspection and planning; stop when nothing has to change;
 *   2. save the recovery snapshot locally, before any remote write;
 *   3. create or update the replacement protected-main ruleset;
 *   4. re-read and verify the replacement; on failure keep or restore the previous policy;
 *   5. only then delete obsolete and duplicate managed rulesets;
 *   6. re-inspect and require an empty plan.
 */
export async function applyContract(
  context: CommandContext,
  saveSnapshot: (snapshot: Snapshot) => Promise<string>,
): Promise<ApplyOutcome> {
  const { client, repository, contract, contractSha256, localChecks } = context;
  const state = await inspectRemote(client, repository, contract);
  const plan = computePlan(contract, contractSha256, state, localChecks);
  if (plan.blockers.length > 0) {
    throw new ReconcileError(
      `apply is blocked and made no remote change:\n${plan.blockers.map((blocker) => `  - ${blocker}`).join("\n")}`,
    );
  }
  if (plan.changes.length === 0) {
    return {
      changed: false,
      plan,
      actions: [],
      snapshot: null,
      remote_writes: client.writes.length,
    };
  }

  const snapshot = await saveSnapshot(
    createSnapshot(repository, contract, contractSha256, state.managed),
  );
  const desired = buildDesiredRuleset(contract);
  const classification = classifyManaged(contract, state.managed);
  const actions: AppliedAction[] = [];
  const replacement = plan.changes.find((change) => change.action !== "delete");
  const previous = classification.target;
  let replacementId: number;

  if (replacement?.action === "update" && previous !== null) {
    try {
      await client.request("PUT", rulesetPath(repository, previous.id), desired);
    } catch (error) {
      const recovery =
        error instanceof GitHubError && error.ambiguous
          ? await rollBackUpdate(context, previous)
          : "the previous managed policy is unchanged";
      throw new ReconcileError(
        `updating ruleset "${previous.name}" failed: ${describe(error)}. ${recovery}; no managed ruleset was deleted.`,
      );
    }
    replacementId = previous.id;
    actions.push({ action: "update", ruleset_id: previous.id, ruleset_name: previous.name });
  } else if (previous === null) {
    try {
      const created = await createRuleset(context, desired);
      replacementId = created.id;
      actions.push({
        action: created.adopted ? "adopt" : "create",
        ruleset_id: created.id,
        ruleset_name: desired.name,
      });
    } catch (error) {
      throw new ReconcileError(
        `creating ruleset "${desired.name}" failed: ${describe(error)}. Existing managed rulesets were left in place; nothing was deleted.`,
      );
    }
  } else {
    replacementId = previous.id;
  }

  const problems = await verifyReplacement(context, replacementId, state.default_branch);
  if (problems.length > 0) {
    const recovery =
      replacement?.action === "update" && previous !== null
        ? await rollBackUpdate(context, previous)
        : "existing managed rulesets were left in place";
    throw new ReconcileError(
      `the replacement ruleset "${desired.name}" (id ${replacementId}) failed verification: ${problems.join("; ")}. ${recovery}; no managed ruleset was deleted.`,
    );
  }

  const deletions = plan.changes.filter((change) => change.action === "delete");
  for (const [position, change] of deletions.entries()) {
    const id = change.ruleset_id;
    if (id === null) continue;
    try {
      await client.request("DELETE", rulesetPath(repository, id));
    } catch (error) {
      if (!(error instanceof GitHubError && error.kind === "not_found")) {
        throw new ReconcileError(
          `deleting ruleset "${change.ruleset_name}" (id ${id}) failed: ${describe(error)}. The verified replacement "${desired.name}" is active; ${deletions.length - position} obsolete managed ruleset(s) remain. Re-run apply to finish.`,
        );
      }
    }
    actions.push({ action: "delete", ruleset_id: id, ruleset_name: change.ruleset_name });
  }

  const finalPlan = computePlan(
    contract,
    contractSha256,
    await inspectRemote(client, repository, contract),
    localChecks,
  );
  if (finalPlan.changes.length > 0) {
    throw new ReconcileError(
      `post-apply verification still finds ${finalPlan.changes.length} pending change(s); run plan to inspect them`,
    );
  }
  return { changed: true, plan, actions, snapshot, remote_writes: client.writes.length };
}
