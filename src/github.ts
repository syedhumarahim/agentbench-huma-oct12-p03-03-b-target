import { GitHubError } from "./errors.ts";
import type { GitHubErrorKind } from "./errors.ts";
import { isRecord } from "./json.ts";
import { summarizeRemoteMessage } from "./redact.ts";

export interface HttpResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface HttpRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal: AbortSignal;
  readonly redirect: "manual";
}

export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

export interface GitHubClientOptions {
  readonly token: string;
  readonly fetch: FetchLike;
  readonly baseUrl?: string;
  /** Total attempts per request, including the first. */
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly baseDelayMs?: number;
  /** Longest single wait the client will accept, including server-requested waits. */
  readonly maxDelayMs?: number;
  readonly maxPages?: number;
  /** When true every non-GET request is refused locally before it is sent. */
  readonly readOnly?: boolean;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

export interface RequestRecord {
  readonly method: string;
  readonly path: string;
}

export interface GitHubResponse {
  readonly status: number;
  readonly data: unknown;
  readonly next: string | null;
}

const DEFAULT_BASE_URL = "https://api.github.com";
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(["GET", "PUT", "DELETE"]);
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Parse a Retry-After header: delta-seconds or an HTTP date.
 * Returns the wait in milliseconds, or null when the header is absent or invalid.
 */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d{1,9}$/.test(trimmed)) return Number(trimmed) * 1000;
  if (!/[a-z]/i.test(trimmed)) return null;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Extract the rel="next" target from a Link header. */
export function parseNextLink(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(",")) {
    const match = /^\s*<([^>]+)>\s*;(.*)$/.exec(part);
    if (match !== null && /\brel\s*=\s*"?next"?/.test(match[2] ?? "")) return match[1] ?? null;
  }
  return null;
}

function classifyStatus(status: number): GitHubErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 422) return "validation";
  if (status === 429) return "rate_limit";
  return status >= 500 ? "server" : "client";
}

/**
 * Minimal GitHub REST client with bounded retries.
 *
 * - Transient failures (network errors, timeouts, 500/502/503/504) are retried for idempotent
 *   methods only; a POST that may have been processed is surfaced as an ambiguous error instead.
 * - Rate limits (429, or 403 carrying Retry-After or an exhausted quota) are retried for every
 *   method because GitHub rejected the request without processing it.
 * - Authorization and validation failures are permanent and never retried.
 */
export class GitHubClient {
  /** Every request actually sent, in order. Never contains headers or bodies. */
  readonly requests: RequestRecord[] = [];

  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #baseUrl: URL;
  readonly #maxAttempts: number;
  readonly #timeoutMs: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #maxPages: number;
  readonly #readOnly: boolean;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;

  constructor(options: GitHubClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch;
    this.#baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    if (this.#baseUrl.protocol !== "https:") {
      throw new GitHubError("the GitHub API base URL must use https", {
        kind: "client",
        method: "GET",
        path: "/",
      });
    }
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 4);
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#baseDelayMs = options.baseDelayMs ?? 500;
    this.#maxDelayMs = options.maxDelayMs ?? 60_000;
    this.#maxPages = options.maxPages ?? 50;
    this.#readOnly = options.readOnly ?? false;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? Date.now;
  }

  /** Requests that changed, or attempted to change, remote state. */
  get writes(): RequestRecord[] {
    return this.requests.filter((request) => request.method !== "GET");
  }

  async get(path: string): Promise<unknown> {
    return (await this.request("GET", path)).data;
  }

  /** Follow `Link: rel="next"` until exhausted. Every page must be a JSON array. */
  async paginate(path: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let next: string | null = path;
    for (let page = 0; next !== null; page += 1) {
      if (page >= this.#maxPages) {
        throw new GitHubError(
          `GitHub pagination for ${this.#displayPath(path)} exceeded ${this.#maxPages} pages`,
          { kind: "pagination", method: "GET", path: this.#displayPath(path) },
        );
      }
      const response: GitHubResponse = await this.request("GET", next);
      if (!Array.isArray(response.data)) {
        throw new GitHubError(
          `GitHub returned a malformed response for GET ${this.#displayPath(path)}: expected a JSON array`,
          {
            kind: "malformed",
            method: "GET",
            path: this.#displayPath(path),
            status: response.status,
          },
        );
      }
      items.push(...(response.data as unknown[]));
      next = response.next;
    }
    return items;
  }

  async request(method: string, pathOrUrl: string, body?: unknown): Promise<GitHubResponse> {
    const url = this.#resolve(pathOrUrl, method);
    const path = url.pathname;
    if (this.#readOnly && method !== "GET") {
      throw new GitHubError(`refusing to send ${method} ${path}: this command is read-only`, {
        kind: "read_only",
        method,
        path,
      });
    }

    for (let attempt = 1; ; attempt += 1) {
      const canRetry = attempt < this.#maxAttempts;
      this.requests.push({ method, path });
      let response: HttpResponseLike;
      let text: string;
      try {
        response = await this.#fetch(url.href, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.#token}`,
            "User-Agent": "governance-cli",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.#timeoutMs),
          redirect: "manual",
        });
        text = await response.text();
      } catch (error) {
        const timedOut =
          error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        if (canRetry && IDEMPOTENT_METHODS.has(method)) {
          await this.#sleep(this.#backoff(attempt));
          continue;
        }
        throw new GitHubError(
          timedOut
            ? `GitHub API ${method} ${path} timed out after ${this.#timeoutMs} ms (attempt ${attempt})`
            : `GitHub API ${method} ${path} failed: network error (attempt ${attempt})`,
          { kind: timedOut ? "timeout" : "network", method, path, attempts: attempt },
        );
      }

      const status = response.status;
      if (status >= 200 && status < 300) {
        return {
          status,
          data: this.#parseBody(text, method, path, status),
          next: this.#nextLink(response.headers.get("link"), method, path),
        };
      }
      if (status >= 300 && status < 400) {
        throw new GitHubError(
          `GitHub API ${method} ${path} answered with an unexpected redirect (HTTP ${status}); the credential was not forwarded`,
          { kind: "redirect", method, path, status, attempts: attempt },
        );
      }

      const retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.#now());
      const quotaExhausted = response.headers.get("x-ratelimit-remaining") === "0";
      const rateLimited =
        status === 429 ||
        (status === 403 && (response.headers.get("retry-after") !== null || quotaExhausted));
      if (rateLimited) {
        const wait = retryAfter ?? this.#resetDelay(response) ?? this.#backoff(attempt);
        if (canRetry && wait <= this.#maxDelayMs) {
          await this.#sleep(wait);
          continue;
        }
        throw new GitHubError(
          wait > this.#maxDelayMs
            ? `GitHub API ${method} ${path} is rate limited (HTTP ${status}); the requested wait of ${Math.ceil(wait / 1000)} s exceeds the ${Math.ceil(this.#maxDelayMs / 1000)} s limit`
            : `GitHub API ${method} ${path} is rate limited (HTTP ${status}) after ${attempt} attempts`,
          { kind: "rate_limit", method, path, status, attempts: attempt },
        );
      }
      if (TRANSIENT_STATUSES.has(status) && canRetry && IDEMPOTENT_METHODS.has(method)) {
        const wait = retryAfter !== null && retryAfter <= this.#maxDelayMs ? retryAfter : null;
        await this.#sleep(wait ?? this.#backoff(attempt));
        continue;
      }
      throw new GitHubError(
        `GitHub API ${method} ${path} failed: HTTP ${status}${this.#remoteMessage(text)} (attempt ${attempt})`,
        { kind: classifyStatus(status), method, path, status, attempts: attempt },
      );
    }
  }

  #displayPath(pathOrUrl: string): string {
    return pathOrUrl.split("?")[0] ?? pathOrUrl;
  }

  #resolve(pathOrUrl: string, method: string): URL {
    const url = new URL(pathOrUrl, this.#baseUrl);
    if (url.origin !== this.#baseUrl.origin) {
      throw new GitHubError(
        `refusing to follow a link outside ${this.#baseUrl.origin}; the credential was not sent`,
        { kind: "redirect", method, path: url.pathname },
      );
    }
    return url;
  }

  #nextLink(header: string | null, method: string, path: string): string | null {
    const next = parseNextLink(header);
    if (next === null) return null;
    try {
      return this.#resolve(next, method).href;
    } catch {
      throw new GitHubError(
        `GitHub pagination for ${path} pointed outside ${this.#baseUrl.origin}; the credential was not sent`,
        { kind: "redirect", method, path },
      );
    }
  }

  #backoff(attempt: number): number {
    return Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** (attempt - 1));
  }

  #resetDelay(response: HttpResponseLike): number | null {
    const reset = response.headers.get("x-ratelimit-reset");
    if (reset === null || !/^\d{1,12}$/.test(reset.trim())) return null;
    return Math.max(0, Number(reset.trim()) * 1000 - this.#now());
  }

  #parseBody(text: string, method: string, path: string, status: number): unknown {
    if (status === 204 || text.trim().length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GitHubError(
        `GitHub returned a malformed response for ${method} ${path}: body is not valid JSON`,
        { kind: "malformed", method, path, status },
      );
    }
  }

  /** A short redacted summary of the remote error; the raw body is never propagated. */
  #remoteMessage(text: string): string {
    let message: unknown;
    try {
      const parsed: unknown = JSON.parse(text);
      message = isRecord(parsed) ? parsed.message : undefined;
    } catch {
      message = undefined;
    }
    if (typeof message !== "string" || message.length === 0) return "";
    return ` - ${summarizeRemoteMessage(message, [this.#token])}`;
  }
}
