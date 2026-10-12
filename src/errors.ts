/** Exit codes shared by every command. */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** Invalid invocation or local configuration (bad flag, missing token, unusable remote). */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** The governance contract failed strict validation. */
export class ContractError extends Error {
  override readonly name = "ContractError";
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`governance contract is invalid:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.issues = issues;
  }
}

/** The recovery snapshot is missing or failed validation. */
export class SnapshotError extends Error {
  override readonly name = "SnapshotError";
}

export type GitHubErrorKind =
  | "auth"
  | "forbidden"
  | "not_found"
  | "validation"
  | "client"
  | "rate_limit"
  | "server"
  | "network"
  | "timeout"
  | "redirect"
  | "malformed"
  | "pagination"
  | "read_only";

export interface GitHubErrorDetails {
  readonly kind: GitHubErrorKind;
  readonly method: string;
  readonly path: string;
  readonly status?: number;
  readonly attempts?: number;
}

/** A GitHub request failed. The message never contains credentials or raw response bodies. */
export class GitHubError extends Error {
  override readonly name = "GitHubError";
  readonly kind: GitHubErrorKind;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly attempts: number;

  constructor(message: string, details: GitHubErrorDetails) {
    super(message);
    this.kind = details.kind;
    this.method = details.method;
    this.path = details.path;
    this.status = details.status ?? null;
    this.attempts = details.attempts ?? 1;
  }

  /** True when the request may or may not have been processed by GitHub. */
  get ambiguous(): boolean {
    return this.kind === "network" || this.kind === "timeout" || this.kind === "server";
  }
}

/** Reconciliation or restoration stopped part-way; the message states what was left in place. */
export class ReconcileError extends Error {
  override readonly name = "ReconcileError";
}
