import { createHash } from "node:crypto";
import type { Contract } from "./contract.ts";
import { SnapshotError } from "./errors.ts";
import type { RepositoryRef } from "./git-remote.ts";
import { fullName } from "./git-remote.ts";
import { canonicalJson, isRecord, stableStringify } from "./json.ts";
import { redactText } from "./redact.ts";
import { canonicalBody } from "./rulesets.ts";
import type { BypassActorRecord, LiveRuleset, RulesetBody, RuleSpec } from "./rulesets.ts";

export const SNAPSHOT_KIND = "governance-recovery-snapshot";
export const SNAPSHOT_SCHEMA_VERSION = 1;
export const SNAPSHOT_FILE = "governance-recovery-snapshot.json";

export interface SnapshotRuleset extends RulesetBody {
  readonly id: number;
}

/** Credential-free record of the contract-managed rulesets as they were before a rollout. */
export interface Snapshot {
  readonly kind: typeof SNAPSHOT_KIND;
  readonly schema_version: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly repository: string;
  readonly managed_name_prefix: string;
  readonly contract_sha256: string;
  readonly rulesets: readonly SnapshotRuleset[];
  readonly integrity_sha256: string;
}

type SnapshotPayload = Omit<Snapshot, "integrity_sha256">;

function digest(payload: SnapshotPayload): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function createSnapshot(
  repository: RepositoryRef,
  contract: Contract,
  contractSha256: string,
  managed: readonly LiveRuleset[],
): Snapshot {
  const payload: SnapshotPayload = {
    kind: SNAPSHOT_KIND,
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    repository: fullName(repository),
    managed_name_prefix: contract.managed_name_prefix,
    contract_sha256: contractSha256,
    rulesets: [...managed]
      .sort((a, b) => a.id - b.id)
      .map((ruleset) => ({ id: ruleset.id, ...canonicalBody(ruleset) })),
  };
  return { ...payload, integrity_sha256: digest(payload) };
}

export function serializeSnapshot(snapshot: Snapshot): string {
  return stableStringify(snapshot);
}

const TOP_LEVEL_KEYS = [
  "contract_sha256",
  "integrity_sha256",
  "kind",
  "managed_name_prefix",
  "repository",
  "rulesets",
  "schema_version",
];
const RULESET_KEYS = [
  "bypass_actors",
  "conditions",
  "enforcement",
  "id",
  "name",
  "rules",
  "target",
];
const TARGETS = ["branch", "tag", "push"];
const ENFORCEMENTS = ["active", "evaluate", "disabled"];
const SHA256 = /^[0-9a-f]{64}$/;

function invalid(detail: string): SnapshotError {
  return new SnapshotError(`recovery snapshot is invalid: ${detail}`);
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
    throw invalid(`${label} has unknown key(s): ${unknown.sort().join(", ")}`);
  const missing = allowed.filter((key) => !(key in value));
  if (missing.length > 0) throw invalid(`${label} is missing key(s): ${missing.join(", ")}`);
}

function parseBypassActors(value: unknown, label: string): BypassActorRecord[] {
  if (!Array.isArray(value)) throw invalid(`${label}.bypass_actors must be an array`);
  return value.map((entry: unknown) => {
    if (!isRecord(entry)) throw invalid(`${label}.bypass_actors entries must be objects`);
    requireExactKeys(
      entry,
      ["actor_id", "actor_type", "bypass_mode"],
      `${label}.bypass_actors entry`,
    );
    const { actor_id: actorId, actor_type: actorType, bypass_mode: bypassMode } = entry;
    const idOk = actorId === null || (typeof actorId === "number" && Number.isInteger(actorId));
    if (!idOk || typeof actorType !== "string" || typeof bypassMode !== "string") {
      throw invalid(`${label}.bypass_actors entry is malformed`);
    }
    return { actor_id: actorId, actor_type: actorType, bypass_mode: bypassMode };
  });
}

function parseRules(value: unknown, label: string): RuleSpec[] {
  if (!Array.isArray(value)) throw invalid(`${label}.rules must be an array`);
  return value.map((entry: unknown) => {
    if (!isRecord(entry)) throw invalid(`${label}.rules entries must be objects`);
    const unknown = Object.keys(entry).filter((key) => key !== "type" && key !== "parameters");
    if (unknown.length > 0)
      throw invalid(`${label}.rules entry has unknown key(s): ${unknown.sort().join(", ")}`);
    const { type, parameters } = entry;
    if (typeof type !== "string" || type.length === 0)
      throw invalid(`${label}.rules entry lacks a type`);
    if (parameters === undefined) return { type };
    if (!isRecord(parameters))
      throw invalid(`${label}.rules "${type}" parameters must be an object`);
    return { type, parameters };
  });
}

function parseRuleset(value: unknown, position: number, prefix: string): SnapshotRuleset {
  const label = `rulesets[${position}]`;
  if (!isRecord(value)) throw invalid(`${label} must be an object`);
  requireExactKeys(value, RULESET_KEYS, label);
  const { id, name, target, enforcement, conditions } = value;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw invalid(`${label}.id must be a positive integer`);
  }
  if (typeof name !== "string" || name.length === 0)
    throw invalid(`${label}.name must be a string`);
  if (!name.startsWith(prefix) || name.length === prefix.length) {
    throw invalid(
      `${label} is named ${JSON.stringify(name)}, which is outside the managed prefix ${JSON.stringify(prefix)}; only contract-managed rulesets may be restored`,
    );
  }
  if (typeof target !== "string" || !TARGETS.includes(target)) {
    throw invalid(`${label}.target must be one of ${TARGETS.join(", ")}`);
  }
  if (typeof enforcement !== "string" || !ENFORCEMENTS.includes(enforcement)) {
    throw invalid(`${label}.enforcement must be one of ${ENFORCEMENTS.join(", ")}`);
  }
  if (!isRecord(conditions)) throw invalid(`${label}.conditions must be an object`);
  return {
    id,
    name,
    target,
    enforcement,
    bypass_actors: parseBypassActors(value.bypass_actors, label),
    conditions,
    rules: parseRules(value.rules, label),
  };
}

export interface SnapshotExpectation {
  readonly repository: RepositoryRef;
  readonly contract: Contract;
}

/**
 * Strictly validate snapshot text before it is used for a restore: exact schema, integrity digest,
 * matching repository and managed prefix, managed names only, and no credential material.
 */
export function parseSnapshot(text: string, expected: SnapshotExpectation): Snapshot {
  if (redactText(text) !== text) {
    throw invalid("it contains credential-like material and will not be used");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid("it is not valid JSON");
  }
  if (!isRecord(raw)) throw invalid("top level must be an object");
  requireExactKeys(raw, TOP_LEVEL_KEYS, "snapshot");
  if (raw.kind !== SNAPSHOT_KIND) throw invalid(`"kind" must be "${SNAPSHOT_KIND}"`);
  if (raw.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
    throw invalid(`unsupported schema_version ${JSON.stringify(raw.schema_version)}`);
  }
  const { repository, managed_name_prefix: prefix, contract_sha256: contractSha } = raw;
  const expectedRepository = fullName(expected.repository);
  if (
    typeof repository !== "string" ||
    repository.toLowerCase() !== expectedRepository.toLowerCase()
  ) {
    throw invalid(`it was captured for a different repository than ${expectedRepository}`);
  }
  if (prefix !== expected.contract.managed_name_prefix) {
    throw invalid(
      `its managed prefix does not match the contract prefix ${JSON.stringify(expected.contract.managed_name_prefix)}`,
    );
  }
  if (typeof contractSha !== "string" || !SHA256.test(contractSha)) {
    throw invalid(`"contract_sha256" must be a SHA-256 hex digest`);
  }
  if (!Array.isArray(raw.rulesets)) throw invalid(`"rulesets" must be an array`);
  const rulesets = raw.rulesets.map((entry: unknown, position) =>
    parseRuleset(entry, position, prefix),
  );
  const ids = new Set(rulesets.map((ruleset) => ruleset.id));
  if (ids.size !== rulesets.length) throw invalid("ruleset ids must be unique");
  const payload: SnapshotPayload = {
    kind: SNAPSHOT_KIND,
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    repository,
    managed_name_prefix: prefix,
    contract_sha256: contractSha,
    rulesets,
  };
  if (raw.integrity_sha256 !== digest(payload)) {
    throw invalid("integrity digest mismatch; the file was edited or truncated");
  }
  return { ...payload, integrity_sha256: digest(payload) };
}
