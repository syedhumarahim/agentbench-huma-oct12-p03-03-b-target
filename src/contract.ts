import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ContractError, UsageError } from "./errors.ts";
import { isRecord } from "./json.ts";
import type { BypassActorRecord, RuleSpec, RulesetBody } from "./rulesets.ts";

export const SUPPORTED_CONTRACT_VERSION = 1;
export const DEFAULT_BRANCH_SELECTOR = "~DEFAULT_BRANCH";

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export const BYPASS_ACTOR_TYPES = [
  "Integration",
  "OrganizationAdmin",
  "RepositoryRole",
  "Team",
  "DeployKey",
] as const;
export type BypassActorType = (typeof BYPASS_ACTOR_TYPES)[number];

export const BYPASS_MODES = ["always", "pull_request"] as const;
export type BypassMode = (typeof BYPASS_MODES)[number];

export interface BypassActor {
  readonly actor_id: number | null;
  readonly actor_type: BypassActorType;
  readonly bypass_mode: BypassMode;
}

/** The validated governance contract. Field names mirror `governance-contract.json`. */
export interface Contract {
  readonly allowed_merge_method: MergeMethod;
  readonly block_deletions: boolean;
  readonly block_force_pushes: boolean;
  readonly branch: string;
  readonly bypass_actors: readonly BypassActor[];
  readonly enforcement: "active";
  readonly managed_name_prefix: string;
  readonly obsolete_managed_ruleset_name: string | null;
  readonly pull_request: boolean;
  readonly required_approving_review_count: number;
  readonly required_linear_history: boolean;
  readonly required_review_thread_resolution: boolean;
  readonly required_status_checks: readonly string[];
  readonly ruleset_name: string;
  readonly strict: boolean;
  readonly unmanaged_settings: "preserve";
  readonly version: 1;
}

const REQUIRED_KEYS = [
  "allowed_merge_method",
  "block_deletions",
  "block_force_pushes",
  "branch",
  "bypass_actors",
  "enforcement",
  "managed_name_prefix",
  "pull_request",
  "required_approving_review_count",
  "required_linear_history",
  "required_review_thread_resolution",
  "required_status_checks",
  "ruleset_name",
  "strict",
  "unmanaged_settings",
  "version",
] as const;
const OPTIONAL_KEYS = ["obsolete_managed_ruleset_name"] as const;
const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);

/** Rule types this contract version can express, and the contract key that enables each. */
export const SUPPORTED_RULE_TYPES: Readonly<Record<string, string>> = {
  deletion: "block_deletions",
  non_fast_forward: "block_force_pushes",
  pull_request: "pull_request",
  required_linear_history: "required_linear_history",
  required_status_checks: "required_status_checks",
};

/** GitHub rule types that exist but are deliberately outside this contract version. */
const UNSUPPORTED_RULE_TYPES: ReadonlySet<string> = new Set([
  "branch_name_pattern",
  "code_quality",
  "code_scanning",
  "commit_author_email_pattern",
  "commit_message_pattern",
  "committer_email_pattern",
  "copilot_code_review",
  "creation",
  "file_extension_restriction",
  "file_path_restriction",
  "max_file_path_length",
  "max_file_size",
  "merge_queue",
  "required_deployments",
  "required_signatures",
  "tag_name_pattern",
  "update",
  "workflows",
]);

const SUPPORTED_RULE_SUMMARY = Object.entries(SUPPORTED_RULE_TYPES)
  .map(([type, key]) => `${type} (via "${key}")`)
  .join(", ");

const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WILDCARD_PATTERN = /[*?[\]]/;

/** Returns an error for a branch selector the contract may not use, or null when it is acceptable. */
export function describeBranchSelectorProblem(selector: unknown): string | null {
  if (typeof selector !== "string" || selector.length === 0) {
    return `"branch" must be "${DEFAULT_BRANCH_SELECTOR}" or "refs/heads/<branch>"`;
  }
  if (selector === DEFAULT_BRANCH_SELECTOR) return null;
  if (selector === "~ALL" || WILDCARD_PATTERN.test(selector)) {
    return `"branch" is an unsafe wildcard target (${JSON.stringify(selector)}); the managed policy may only target one explicit branch`;
  }
  const prefix = "refs/heads/";
  if (!selector.startsWith(prefix)) {
    return `"branch" is malformed (${JSON.stringify(selector)}); use "${DEFAULT_BRANCH_SELECTOR}" or "refs/heads/<branch>"`;
  }
  const name = selector.slice(prefix.length);
  const malformed =
    name.length === 0 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000- \u007f~^:\\]/.test(name) ||
    name.includes("..") ||
    name.includes("@{") ||
    name.includes("//") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name === "@" ||
    name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"));
  return malformed
    ? `"branch" is malformed (${JSON.stringify(selector)}); it is not a valid branch ref name`
    : null;
}

/** Report object keys that appear more than once; `JSON.parse` silently keeps only the last. */
export function findDuplicateKeys(text: string): string[] {
  const duplicates = new Set<string>();
  let index = 0;
  const skipWhitespace = (): void => {
    while (index < text.length && " \t\r\n".includes(text.charAt(index))) index += 1;
  };
  const readString = (): string => {
    const start = index;
    index += 1;
    while (index < text.length && text.charAt(index) !== '"') {
      index += text.charAt(index) === "\\" ? 2 : 1;
    }
    index += 1;
    return JSON.parse(text.slice(start, index)) as string;
  };
  const readValue = (location: string): void => {
    skipWhitespace();
    const char = text.charAt(index);
    if (char === "{") {
      index += 1;
      const seen = new Set<string>();
      skipWhitespace();
      if (text.charAt(index) === "}") {
        index += 1;
        return;
      }
      for (;;) {
        skipWhitespace();
        const key = readString();
        if (seen.has(key)) duplicates.add(`${location}${key}`);
        seen.add(key);
        skipWhitespace();
        index += 1; // ":"
        readValue(`${location}${key}.`);
        skipWhitespace();
        const separator = text.charAt(index);
        index += 1;
        if (separator !== ",") return;
      }
    }
    if (char === "[") {
      index += 1;
      skipWhitespace();
      if (text.charAt(index) === "]") {
        index += 1;
        return;
      }
      for (let position = 0; ; position += 1) {
        readValue(`${location}${position}.`);
        skipWhitespace();
        const separator = text.charAt(index);
        index += 1;
        if (separator !== ",") return;
      }
    }
    if (char === '"') {
      readString();
      return;
    }
    while (index < text.length && !",]} \t\r\n".includes(text.charAt(index))) index += 1;
  };
  readValue("");
  return [...duplicates].sort();
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `${typeof value} ${JSON.stringify(value)}`;
}

function validateBypassActors(value: unknown, issues: string[]): BypassActor[] {
  if (!Array.isArray(value)) {
    issues.push(`"bypass_actors" must be an array, got ${describeType(value)}`);
    return [];
  }
  const actors: BypassActor[] = [];
  const seen = new Set<string>();
  value.forEach((entry: unknown, position) => {
    const label = `"bypass_actors[${position}]"`;
    if (!isRecord(entry)) {
      issues.push(`${label} must be an object`);
      return;
    }
    const unknownKeys = Object.keys(entry).filter(
      (key) => !["actor_id", "actor_type", "bypass_mode"].includes(key),
    );
    if (unknownKeys.length > 0) {
      issues.push(`${label} has unknown key(s): ${unknownKeys.sort().join(", ")}`);
    }
    const { actor_id: actorId, actor_type: actorType, bypass_mode: bypassMode } = entry;
    const typeOk = BYPASS_ACTOR_TYPES.some((candidate) => candidate === actorType);
    if (!typeOk) {
      issues.push(`${label}.actor_type must be one of ${BYPASS_ACTOR_TYPES.join(", ")}`);
    }
    const modeOk = BYPASS_MODES.some((candidate) => candidate === bypassMode);
    if (!modeOk) issues.push(`${label}.bypass_mode must be one of ${BYPASS_MODES.join(", ")}`);
    const idMayBeNull = actorType === "OrganizationAdmin" || actorType === "DeployKey";
    const idOk =
      (typeof actorId === "number" && Number.isInteger(actorId) && actorId > 0) ||
      (actorId === null && idMayBeNull);
    if (!idOk) issues.push(`${label}.actor_id must be a positive integer`);
    if (typeOk && modeOk && idOk) {
      const actor = {
        actor_id: actorId,
        actor_type: actorType as BypassActorType,
        bypass_mode: bypassMode as BypassMode,
      };
      const identity = `${actor.actor_type}:${actor.actor_id}`;
      if (seen.has(identity)) issues.push(`${label} duplicates bypass actor ${identity}`);
      seen.add(identity);
      actors.push(actor);
    }
  });
  return actors;
}

function validateStatusChecks(value: unknown, issues: string[]): string[] {
  if (!Array.isArray(value)) {
    issues.push(`"required_status_checks" must be an array, got ${describeType(value)}`);
    return [];
  }
  const checks: string[] = [];
  value.forEach((entry: unknown, position) => {
    const label = `"required_status_checks[${position}]"`;
    if (typeof entry !== "string") {
      issues.push(`${label} must be a string, got ${describeType(entry)}`);
    } else if (entry.trim().length === 0) {
      issues.push(`${label} is an empty status-check name`);
    } else if (entry !== entry.trim()) {
      issues.push(`${label} has leading or trailing whitespace`);
    } else if (checks.includes(entry)) {
      issues.push(`${label} duplicates status check ${JSON.stringify(entry)}`);
    } else {
      checks.push(entry);
    }
  });
  return checks;
}

function reportUnknownKeys(raw: Record<string, unknown>, issues: string[]): void {
  for (const key of Object.keys(raw).sort()) {
    if (KNOWN_KEYS.has(key)) continue;
    if (key === "rules" || key === "rule_types") {
      const entries: unknown[] = Array.isArray(raw[key]) ? raw[key] : [];
      const types = entries
        .map((entry) => (isRecord(entry) ? entry.type : entry))
        .filter((type): type is string => typeof type === "string");
      const unsupported = types.filter((type) => !(type in SUPPORTED_RULE_TYPES));
      for (const type of unsupported) {
        issues.push(
          `unsupported rule type ${JSON.stringify(type)}; supported: ${SUPPORTED_RULE_SUMMARY}`,
        );
      }
      issues.push(
        `unknown contract key "${key}"; rules are declared through dedicated keys: ${SUPPORTED_RULE_SUMMARY}`,
      );
    } else if (UNSUPPORTED_RULE_TYPES.has(key)) {
      issues.push(
        `unsupported rule type ${JSON.stringify(key)}; supported: ${SUPPORTED_RULE_SUMMARY}`,
      );
    } else {
      issues.push(`unknown contract key "${key}"`);
    }
  }
}

/** Strictly validate contract JSON text. Every problem found is reported at once. */
export function parseContract(text: string): Contract {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ContractError(["file is not valid JSON"]);
  }
  if (!isRecord(raw)) throw new ContractError(["top level must be a JSON object"]);

  const issues: string[] = [];
  for (const duplicate of findDuplicateKeys(text)) {
    issues.push(
      duplicate === "ruleset_name" || duplicate === "obsolete_managed_ruleset_name"
        ? `duplicate managed ruleset name: key "${duplicate}" is declared more than once`
        : `duplicate contract key "${duplicate}"`,
    );
  }
  reportUnknownKeys(raw, issues);
  for (const key of REQUIRED_KEYS) {
    if (!(key in raw)) issues.push(`missing required key "${key}"`);
  }

  const has = (key: string): boolean => key in raw;
  const bool = (key: string): boolean => {
    const value = raw[key];
    if (has(key) && typeof value !== "boolean") {
      issues.push(`"${key}" must be a boolean, got ${describeType(value)}`);
    }
    return value === true;
  };

  if (has("version") && raw.version !== SUPPORTED_CONTRACT_VERSION) {
    issues.push(
      `unsupported contract version ${JSON.stringify(raw.version)}; this CLI supports version ${SUPPORTED_CONTRACT_VERSION}`,
    );
  }
  if (has("unmanaged_settings") && raw.unmanaged_settings !== "preserve") {
    issues.push(`"unmanaged_settings" must be "preserve"; unmanaged settings are never modified`);
  }
  if (has("enforcement") && raw.enforcement !== "active") {
    issues.push(
      `conflicting policy: "enforcement" must be "active" (got ${describeType(raw.enforcement)}); a disabled or evaluate-only ruleset does not protect the default branch`,
    );
  }

  const mergeMethod = raw.allowed_merge_method;
  const mergeMethodOk = MERGE_METHODS.some((candidate) => candidate === mergeMethod);
  if (has("allowed_merge_method") && !mergeMethodOk) {
    issues.push(`"allowed_merge_method" must be one of ${MERGE_METHODS.join(", ")}`);
  }

  if (has("branch")) {
    const problem = describeBranchSelectorProblem(raw.branch);
    if (problem !== null) issues.push(problem);
  }

  const prefix = raw.managed_name_prefix;
  let prefixOk = false;
  if (has("managed_name_prefix")) {
    if (typeof prefix !== "string") {
      issues.push(`"managed_name_prefix" must be a string`);
    } else if (WILDCARD_PATTERN.test(prefix) || prefix.includes("~")) {
      issues.push(
        `"managed_name_prefix" is an unsafe wildcard target; it must be a literal prefix`,
      );
    } else if (!PREFIX_PATTERN.test(prefix)) {
      issues.push(
        `"managed_name_prefix" must be at least 3 characters of letters, digits, ".", "_" or "-" so the managed scope stays narrow`,
      );
    } else {
      prefixOk = true;
    }
  }

  const validateManagedName = (key: string): string | null => {
    const value = raw[key];
    if (typeof value !== "string" || !NAME_PATTERN.test(value)) {
      issues.push(`"${key}" must be a ruleset name made of letters, digits, ".", "_" or "-"`);
      return null;
    }
    if (prefixOk && typeof prefix === "string") {
      if (!value.startsWith(prefix) || value.length === prefix.length) {
        issues.push(
          `"${key}" (${JSON.stringify(value)}) must start with the managed prefix ${JSON.stringify(prefix)} and extend it; otherwise it is outside the managed scope`,
        );
      }
    }
    return value;
  };
  const rulesetName = has("ruleset_name") ? validateManagedName("ruleset_name") : null;
  const obsoleteName =
    has("obsolete_managed_ruleset_name") && raw.obsolete_managed_ruleset_name !== null
      ? validateManagedName("obsolete_managed_ruleset_name")
      : null;
  if (
    rulesetName !== null &&
    obsoleteName !== null &&
    rulesetName.toLowerCase() === obsoleteName.toLowerCase()
  ) {
    issues.push(
      `duplicate managed ruleset name ${JSON.stringify(rulesetName)}: "ruleset_name" and "obsolete_managed_ruleset_name" must differ`,
    );
  }

  const pullRequest = bool("pull_request");
  const linearHistory = bool("required_linear_history");
  const threadResolution = bool("required_review_thread_resolution");
  const strict = bool("strict");
  const blockDeletions = bool("block_deletions");
  const blockForcePushes = bool("block_force_pushes");

  const approvals = raw.required_approving_review_count;
  const approvalsOk =
    typeof approvals === "number" &&
    Number.isInteger(approvals) &&
    approvals >= 0 &&
    approvals <= 10;
  if (has("required_approving_review_count") && !approvalsOk) {
    issues.push(`"required_approving_review_count" must be an integer between 0 and 10`);
  }

  const statusChecks = has("required_status_checks")
    ? validateStatusChecks(raw.required_status_checks, issues)
    : [];
  const bypassActors = has("bypass_actors") ? validateBypassActors(raw.bypass_actors, issues) : [];

  if (has("pull_request") && !pullRequest) {
    if (approvalsOk && approvals > 0) {
      issues.push(
        `conflicting policy: "required_approving_review_count" is ${approvals} but "pull_request" is false`,
      );
    }
    if (threadResolution) {
      issues.push(
        `conflicting policy: "required_review_thread_resolution" is true but "pull_request" is false`,
      );
    }
    if (bypassActors.some((actor) => actor.bypass_mode === "pull_request")) {
      issues.push(
        `conflicting policy: a bypass actor uses bypass_mode "pull_request" but "pull_request" is false`,
      );
    }
  }
  if (linearHistory && mergeMethod === "merge") {
    issues.push(
      `conflicting policy: "allowed_merge_method" is "merge" but "required_linear_history" forbids merge commits`,
    );
  }
  if (strict && has("required_status_checks") && statusChecks.length === 0) {
    issues.push(`conflicting policy: "strict" is true but "required_status_checks" is empty`);
  }

  if (issues.length > 0 || rulesetName === null) throw new ContractError(issues);
  return {
    allowed_merge_method: mergeMethod as MergeMethod,
    block_deletions: blockDeletions,
    block_force_pushes: blockForcePushes,
    branch: raw.branch as string,
    bypass_actors: bypassActors,
    enforcement: "active",
    managed_name_prefix: prefix as string,
    obsolete_managed_ruleset_name: obsoleteName,
    pull_request: pullRequest,
    required_approving_review_count: approvals as number,
    required_linear_history: linearHistory,
    required_review_thread_resolution: threadResolution,
    required_status_checks: statusChecks,
    ruleset_name: rulesetName,
    strict,
    unmanaged_settings: "preserve",
    version: SUPPORTED_CONTRACT_VERSION,
  };
}

export interface LoadedContract {
  readonly contract: Contract;
  /** SHA-256 of the exact contract bytes, recorded in plans and snapshots. */
  readonly sha256: string;
}

export async function loadContract(filePath: string, displayPath: string): Promise<LoadedContract> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    throw new UsageError(`cannot read governance contract at ${displayPath}`);
  }
  return {
    contract: parseContract(text),
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

/** The exact ruleset the contract requires, in the shape the GitHub rulesets API accepts. */
export function buildDesiredRuleset(contract: Contract): RulesetBody {
  const rules: RuleSpec[] = [];
  if (contract.block_deletions) rules.push({ type: "deletion" });
  if (contract.block_force_pushes) rules.push({ type: "non_fast_forward" });
  if (contract.pull_request) {
    rules.push({
      type: "pull_request",
      parameters: {
        allowed_merge_methods: [contract.allowed_merge_method],
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_approving_review_count: contract.required_approving_review_count,
        required_review_thread_resolution: contract.required_review_thread_resolution,
      },
    });
  }
  if (contract.required_linear_history) rules.push({ type: "required_linear_history" });
  if (contract.required_status_checks.length > 0) {
    rules.push({
      type: "required_status_checks",
      parameters: {
        do_not_enforce_on_create: false,
        required_status_checks: contract.required_status_checks.map((context) => ({ context })),
        strict_required_status_checks_policy: contract.strict,
      },
    });
  }
  const bypassActors: BypassActorRecord[] = contract.bypass_actors.map((actor) => ({ ...actor }));
  return {
    name: contract.ruleset_name,
    target: "branch",
    enforcement: contract.enforcement,
    bypass_actors: bypassActors,
    conditions: { ref_name: { include: [contract.branch], exclude: [] } },
    rules,
  };
}
