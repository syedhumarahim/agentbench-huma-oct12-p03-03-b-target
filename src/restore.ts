import { createRuleset } from "./apply.ts";
import type { CommandContext } from "./apply.ts";
import { ReconcileError } from "./errors.ts";
import { readRuleset, readRulesets, repoPath } from "./remote-state.ts";
import { diffRuleset } from "./rulesets.ts";
import type { LiveRuleset, RulesetBody } from "./rulesets.ts";
import type { Snapshot, SnapshotRuleset } from "./snapshot.ts";

export const RESTORE_JSON_FILE = "governance-restore.json";

export interface RestoreAction {
  readonly action: "create" | "adopt" | "update" | "unchanged";
  readonly ruleset_name: string;
  readonly ruleset_id: number;
}

export interface RestoreOutcome {
  readonly actions: readonly RestoreAction[];
  /** Managed rulesets that exist remotely but are not in the snapshot. Never modified here. */
  readonly left_in_place: readonly { readonly id: number; readonly name: string }[];
  readonly unmanaged_preserved: number;
  readonly remote_writes: number;
}

function bodyOf(ruleset: SnapshotRuleset): RulesetBody {
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    bypass_actors: ruleset.bypass_actors,
    conditions: ruleset.conditions,
    rules: ruleset.rules,
  };
}

/**
 * Bring the rulesets recorded in a validated snapshot back to their recorded state.
 *
 * Only snapshot entries are written: each is matched to a live managed ruleset by id, then by
 * name, and is updated or re-created only when it differs. Nothing is deleted, and rulesets
 * outside the snapshot (managed or not) are never touched. Safe to re-run after a partial failure.
 */
export async function restoreSnapshot(
  context: CommandContext,
  snapshot: Snapshot,
): Promise<RestoreOutcome> {
  const { client, repository, contract } = context;
  const { managed, unmanaged } = await readRulesets(client, repository, contract);
  const unclaimed = new Map<number, LiveRuleset>(managed.map((ruleset) => [ruleset.id, ruleset]));
  const claim = (recorded: SnapshotRuleset): LiveRuleset | undefined => {
    const match =
      unclaimed.get(recorded.id) ??
      [...unclaimed.values()].find((live) => live.name === recorded.name);
    if (match !== undefined) unclaimed.delete(match.id);
    return match;
  };
  const pairs = snapshot.rulesets.map((recorded) => ({ recorded, live: claim(recorded) }));

  const actions: RestoreAction[] = [];
  for (const [position, { recorded, live }] of pairs.entries()) {
    const body = bodyOf(recorded);
    try {
      let id: number;
      let action: RestoreAction["action"];
      if (live === undefined) {
        const created = await createRuleset(context, body);
        id = created.id;
        action = created.adopted ? "adopt" : "create";
      } else if (diffRuleset(body, live).length === 0) {
        actions.push({ action: "unchanged", ruleset_name: recorded.name, ruleset_id: live.id });
        continue;
      } else {
        await client.request("PUT", repoPath(repository, `/rulesets/${live.id}`), body);
        id = live.id;
        action = "update";
      }
      const remaining = diffRuleset(body, await readRuleset(client, repository, id));
      if (remaining.length > 0) {
        throw new Error(
          `the restored ruleset does not match the snapshot (${remaining.map((difference) => difference.path).join(", ")})`,
        );
      }
      actions.push({ action, ruleset_name: recorded.name, ruleset_id: id });
    } catch (error) {
      const done = actions.filter((entry) => entry.action !== "unchanged").length;
      const pending = pairs.slice(position + 1).map((pair) => pair.recorded.name);
      throw new ReconcileError(
        `restoring ruleset "${recorded.name}" failed: ${error instanceof Error ? error.message : "unknown error"}. ` +
          `${done} ruleset(s) were restored before the failure; ${pending.length} not attempted` +
          `${pending.length > 0 ? ` (${pending.join(", ")})` : ""}. Unmanaged rulesets were not touched. Re-run restore to continue.`,
      );
    }
  }
  return {
    actions,
    left_in_place: [...unclaimed.values()].map((ruleset) => ({
      id: ruleset.id,
      name: ruleset.name,
    })),
    unmanaged_preserved: unmanaged.length,
    remote_writes: client.writes.length,
  };
}
