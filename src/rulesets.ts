import { GitHubError } from "./errors.ts";
import { canonicalJson, isRecord, sortKeys } from "./json.ts";

export interface BypassActorRecord {
  readonly actor_id: number | null;
  readonly actor_type: string;
  readonly bypass_mode: string;
}

export interface RuleSpec {
  readonly type: string;
  readonly parameters?: Record<string, unknown>;
}

/** The writable portion of a ruleset: what POST and PUT accept and what snapshots record. */
export interface RulesetBody {
  readonly name: string;
  readonly target: string;
  readonly enforcement: string;
  readonly bypass_actors: readonly BypassActorRecord[];
  readonly conditions: Record<string, unknown>;
  readonly rules: readonly RuleSpec[];
}

export interface RulesetSummary {
  readonly id: number;
  readonly name: string;
  readonly target: string;
  readonly enforcement: string;
  readonly source_type: string | null;
  readonly source: string | null;
}

export interface LiveRuleset extends RulesetBody {
  readonly id: number;
  /** False when the credential cannot see bypass actors; the policy is then unverifiable. */
  readonly bypass_actors_visible: boolean;
}

export interface Difference {
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

function malformed(path: string, detail: string): GitHubError {
  return new GitHubError(`GitHub returned a malformed ruleset response for ${path}: ${detail}`, {
    kind: "malformed",
    method: "GET",
    path,
  });
}

function requireString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0)
    throw malformed(path, `"${key}" is not a string`);
  return value;
}

function requireId(record: Record<string, unknown>, path: string): number {
  const value = record.id;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw malformed(path, `"id" is not a positive integer`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function parseRulesetSummary(value: unknown, path: string): RulesetSummary {
  if (!isRecord(value)) throw malformed(path, "ruleset entry is not an object");
  return {
    id: requireId(value, path),
    name: requireString(value, "name", path),
    target: optionalString(value.target) ?? "branch",
    enforcement: requireString(value, "enforcement", path),
    source_type: optionalString(value.source_type),
    source: optionalString(value.source),
  };
}

function parseBypassActors(value: unknown, path: string): BypassActorRecord[] {
  if (!Array.isArray(value)) throw malformed(path, `"bypass_actors" is not an array`);
  return value.map((entry: unknown) => {
    if (!isRecord(entry)) throw malformed(path, "bypass actor is not an object");
    const actorId = entry.actor_id;
    if (actorId !== null && actorId !== undefined && typeof actorId !== "number") {
      throw malformed(path, "bypass actor id is not a number");
    }
    return {
      actor_id: actorId ?? null,
      actor_type: requireString(entry, "actor_type", path),
      bypass_mode: requireString(entry, "bypass_mode", path),
    };
  });
}

function parseRules(value: unknown, path: string): RuleSpec[] {
  if (!Array.isArray(value)) throw malformed(path, `"rules" is not an array`);
  return value.map((entry: unknown) => {
    if (!isRecord(entry)) throw malformed(path, "rule is not an object");
    const type = requireString(entry, "type", path);
    const parameters = entry.parameters;
    if (parameters === undefined || parameters === null) return { type };
    if (!isRecord(parameters)) throw malformed(path, `rule "${type}" parameters are not an object`);
    return { type, parameters };
  });
}

/** Validate the detail response for one ruleset. */
export function parseLiveRuleset(value: unknown, path: string): LiveRuleset {
  if (!isRecord(value)) throw malformed(path, "ruleset is not an object");
  const conditions = value.conditions;
  if (conditions !== undefined && conditions !== null && !isRecord(conditions)) {
    throw malformed(path, `"conditions" is not an object`);
  }
  const bypassVisible = value.bypass_actors !== undefined && value.bypass_actors !== null;
  return {
    id: requireId(value, path),
    name: requireString(value, "name", path),
    target: optionalString(value.target) ?? "branch",
    enforcement: requireString(value, "enforcement", path),
    bypass_actors: bypassVisible ? parseBypassActors(value.bypass_actors, path) : [],
    bypass_actors_visible: bypassVisible,
    conditions: conditions ?? {},
    rules: parseRules(value.rules, path),
  };
}

function sortedStrings(value: unknown): unknown {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value].sort()
    : value;
}

function bypassKey(actor: BypassActorRecord): string {
  return `${actor.actor_type}:${actor.actor_id}:${actor.bypass_mode}`;
}

function canonicalConditions(conditions: Record<string, unknown>): Record<string, unknown> {
  const refName = conditions.ref_name;
  if (!isRecord(refName)) return conditions;
  return {
    ...conditions,
    ref_name: {
      ...refName,
      include: sortedStrings(refName.include ?? []),
      exclude: sortedStrings(refName.exclude ?? []),
    },
  };
}

function canonicalStatusChecks(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value
    .map((entry: unknown) => {
      if (!isRecord(entry)) return entry;
      const normalized: Record<string, unknown> = { ...entry };
      if (normalized.integration_id === null) delete normalized.integration_id;
      return normalized;
    })
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

function canonicalParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...parameters };
  if ("allowed_merge_methods" in result) {
    result.allowed_merge_methods = sortedStrings(result.allowed_merge_methods);
  }
  if ("required_status_checks" in result) {
    result.required_status_checks = canonicalStatusChecks(result.required_status_checks);
  }
  return result;
}

/**
 * Order-independent form of a ruleset body. Set-like arrays are sorted so two bodies that GitHub
 * treats as identical serialise identically.
 */
export function canonicalBody(body: RulesetBody): RulesetBody {
  return {
    name: body.name,
    target: body.target,
    enforcement: body.enforcement,
    bypass_actors: [...body.bypass_actors]
      .map((actor) => ({
        actor_id: actor.actor_id,
        actor_type: actor.actor_type,
        bypass_mode: actor.bypass_mode,
      }))
      .sort((a, b) => bypassKey(a).localeCompare(bypassKey(b))),
    conditions: sortKeys(canonicalConditions(body.conditions)) as Record<string, unknown>,
    rules: [...body.rules]
      .map((rule) =>
        rule.parameters === undefined
          ? { type: rule.type }
          : {
              type: rule.type,
              parameters: sortKeys(canonicalParameters(rule.parameters)) as Record<string, unknown>,
            },
      )
      .sort((a, b) => a.type.localeCompare(b.type)),
  };
}

/** Parameters GitHub fills in when omitted; compared as if they had been sent explicitly. */
const PARAMETER_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  required_status_checks: { do_not_enforce_on_create: false },
};

/**
 * Compare the live managed ruleset with the contract's desired body.
 *
 * Only keys the contract sets are compared inside rule parameters, so server-side additions with
 * default values (new optional parameters) do not cause perpetual drift. Rule types, targets,
 * enforcement and bypass actors are compared exactly.
 */
export function diffRuleset(desired: RulesetBody, live: LiveRuleset): Difference[] {
  const want = canonicalBody(desired);
  const have = canonicalBody(live);
  const differences: Difference[] = [];
  const compare = (path: string, expected: unknown, actual: unknown): void => {
    if (canonicalJson(expected) !== canonicalJson(actual)) {
      differences.push({ path, expected: expected ?? null, actual: actual ?? null });
    }
  };

  compare("name", want.name, have.name);
  compare("target", want.target, have.target);
  compare("enforcement", want.enforcement, have.enforcement);
  if (live.bypass_actors_visible) {
    compare("bypass_actors", want.bypass_actors, have.bypass_actors);
  } else {
    differences.push({
      path: "bypass_actors",
      expected: want.bypass_actors,
      actual: "not visible to this credential",
    });
  }
  compare("conditions", want.conditions, have.conditions);

  const liveRules = new Map(have.rules.map((rule) => [rule.type, rule]));
  const wantedTypes = new Set(want.rules.map((rule) => rule.type));
  for (const rule of want.rules) {
    const actual = liveRules.get(rule.type);
    if (actual === undefined) {
      differences.push({ path: `rules.${rule.type}`, expected: "present", actual: "missing" });
      continue;
    }
    const defaults = PARAMETER_DEFAULTS[rule.type] ?? {};
    const actualParameters = { ...defaults, ...(actual.parameters ?? {}) };
    for (const [key, expected] of Object.entries(rule.parameters ?? {})) {
      compare(`rules.${rule.type}.${key}`, expected, actualParameters[key]);
    }
  }
  for (const rule of have.rules) {
    if (!wantedTypes.has(rule.type)) {
      differences.push({ path: `rules.${rule.type}`, expected: "absent", actual: "present" });
    }
  }
  return differences.sort((a, b) => a.path.localeCompare(b.path));
}
