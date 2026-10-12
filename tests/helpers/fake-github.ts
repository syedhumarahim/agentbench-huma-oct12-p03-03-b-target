import type { FetchLike, HttpRequestInit, HttpResponseLike } from "../../src/github.ts";

/* Tests must never reach the network: any accidental use of the real fetch fails loudly. */
globalThis.fetch = () => Promise.reject(new Error("live network access is forbidden in tests"));

export interface FakeRuleset {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  source_type: string;
  source: string;
  bypass_actors: unknown[];
  conditions: Record<string, unknown>;
  rules: { type: string; parameters?: Record<string, unknown> }[];
}

export interface FaultResponse {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  /** Simulate a transport failure instead of an HTTP response. */
  readonly failure?: "network" | "timeout";
  /** Apply the request's effect first, then fail: an ambiguous outcome. */
  readonly afterEffect?: boolean;
}

interface Fault {
  readonly method: string;
  readonly pattern: RegExp;
  readonly response: FaultResponse;
  remaining: number;
}

export interface LoggedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly authorization: string | undefined;
}

function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponseLike {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

/** In-memory stand-in for the parts of the GitHub REST API the CLI uses. */
export class FakeGitHub {
  readonly owner = "octo";
  readonly repo = "demo";
  defaultBranch = "main";
  branches: { name: string; sha: string }[] = [{ name: "main", sha: "a".repeat(40) }];
  pulls: unknown[] = [];
  rulesets: FakeRuleset[] = [];
  nextId = 101;
  pageSize = 100;
  hideBypassActors = false;
  /** Add parameters the real API fills in, to prove they do not cause drift. */
  serverDefaults = true;
  onStore: ((ruleset: FakeRuleset) => void) | undefined;
  readonly log: LoggedRequest[] = [];
  readonly #faults: Fault[] = [];

  get fullName(): string {
    return `${this.owner}/${this.repo}`;
  }

  get writes(): LoggedRequest[] {
    return this.log.filter((request) => request.method !== "GET");
  }

  /** Requests in order, as "METHOD /path". */
  get sequence(): string[] {
    return this.log.map((request) => `${request.method} ${request.path}`);
  }

  fail(method: string, pattern: RegExp, response: FaultResponse, times = 1): void {
    this.#faults.push({ method, pattern, response, remaining: times });
  }

  addRuleset(partial: Partial<FakeRuleset> & { name: string }): FakeRuleset {
    const ruleset: FakeRuleset = {
      id: this.nextId++,
      target: "branch",
      enforcement: "active",
      source_type: "Repository",
      source: this.fullName,
      bypass_actors: [],
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [],
      ...partial,
    };
    this.rulesets.push(ruleset);
    return ruleset;
  }

  readonly fetch: FetchLike = (url: string, init: HttpRequestInit) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    this.log.push({
      method: init.method,
      path,
      query: parsed.search,
      authorization: init.headers.Authorization,
    });
    const fault = this.#faults.find(
      (candidate) =>
        candidate.remaining > 0 && candidate.method === init.method && candidate.pattern.test(path),
    );
    if (fault !== undefined) {
      fault.remaining -= 1;
      if (fault.response.afterEffect === true) this.#route(init, parsed);
      if (fault.response.failure !== undefined) {
        const error = new Error("simulated transport failure");
        error.name = fault.response.failure === "timeout" ? "TimeoutError" : "TypeError";
        return Promise.reject(error);
      }
      return Promise.resolve(
        respond(fault.response.status ?? 500, fault.response.body ?? "{}", fault.response.headers),
      );
    }
    return Promise.resolve(this.#route(init, parsed));
  };

  #page(items: unknown[], url: URL): HttpResponseLike {
    const requested = Number(url.searchParams.get("per_page") ?? "30");
    const size = Math.min(requested, this.pageSize);
    const page = Number(url.searchParams.get("page") ?? "1");
    const slice = items.slice((page - 1) * size, page * size);
    const headers: Record<string, string> = {};
    if (page * size < items.length) {
      const next = new URL(url.href);
      next.searchParams.set("page", String(page + 1));
      headers.Link = `<${next.href}>; rel="next", <${url.href}>; rel="first"`;
    }
    return respond(200, slice, headers);
  }

  #detail(ruleset: FakeRuleset): Record<string, unknown> {
    const { bypass_actors: bypassActors, ...rest } = ruleset;
    const detail: Record<string, unknown> = {
      ...rest,
      node_id: `RRS_${ruleset.id}`,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      current_user_can_bypass: "never",
      _links: {
        self: { href: `https://api.github.com/repos/${this.fullName}/rulesets/${ruleset.id}` },
      },
    };
    if (!this.hideBypassActors) detail.bypass_actors = bypassActors;
    return detail;
  }

  #store(id: number, body: Record<string, unknown>): FakeRuleset {
    const rules = (body.rules as FakeRuleset["rules"]).map((rule) => {
      if (!this.serverDefaults || rule.parameters === undefined) return structuredClone(rule);
      const extra: Record<string, unknown> =
        rule.type === "pull_request"
          ? { automatic_copilot_code_review_enabled: false, required_reviewers: [] }
          : {};
      return { type: rule.type, parameters: { ...extra, ...structuredClone(rule.parameters) } };
    });
    const ruleset: FakeRuleset = {
      id,
      name: body.name as string,
      target: (body.target as string | undefined) ?? "branch",
      enforcement: body.enforcement as string,
      source_type: "Repository",
      source: this.fullName,
      bypass_actors: structuredClone((body.bypass_actors as unknown[] | undefined) ?? []),
      conditions: structuredClone((body.conditions as Record<string, unknown> | undefined) ?? {}),
      rules,
    };
    this.onStore?.(ruleset);
    return ruleset;
  }

  #route(init: HttpRequestInit, url: URL): HttpResponseLike {
    const base = `/repos/${this.fullName}`;
    const path = url.pathname;
    const { method } = init;
    if (!path.startsWith(base)) return respond(404, { message: "Not Found" });
    const rest = path.slice(base.length);
    if (method === "GET" && rest === "") {
      return respond(200, {
        full_name: this.fullName,
        default_branch: this.defaultBranch,
        visibility: "public",
      });
    }
    if (method === "GET" && rest === "/branches") {
      return this.#page(
        this.branches.map((branch) => ({
          name: branch.name,
          commit: { sha: branch.sha },
          protected: false,
        })),
        url,
      );
    }
    if (method === "GET" && rest === "/pulls") return this.#page(this.pulls, url);
    if (rest === "/rulesets") {
      if (method === "GET") {
        return this.#page(
          this.rulesets.map(({ id, name, target, enforcement, source_type, source }) => ({
            id,
            name,
            target,
            enforcement,
            source_type,
            source,
          })),
          url,
        );
      }
      if (method === "POST") {
        const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        if (this.rulesets.some((ruleset) => ruleset.name === body.name)) {
          return respond(422, { message: "Validation Failed", errors: ["Name must be unique"] });
        }
        const created = this.#store(this.nextId++, body);
        this.rulesets.push(created);
        return respond(201, this.#detail(created));
      }
    }
    const match = /^\/rulesets\/(\d+)$/.exec(rest);
    if (match !== null) {
      const id = Number(match[1]);
      const index = this.rulesets.findIndex((ruleset) => ruleset.id === id);
      const existing = this.rulesets[index];
      if (existing === undefined) return respond(404, { message: "Not Found" });
      if (method === "GET") return respond(200, this.#detail(existing));
      if (method === "PUT") {
        const updated = this.#store(id, JSON.parse(init.body ?? "{}") as Record<string, unknown>);
        this.rulesets[index] = updated;
        return respond(200, this.#detail(updated));
      }
      if (method === "DELETE") {
        this.rulesets.splice(index, 1);
        return respond(204, "");
      }
    }
    return respond(404, { message: "Not Found" });
  }
}
