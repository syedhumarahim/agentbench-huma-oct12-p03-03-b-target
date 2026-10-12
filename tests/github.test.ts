import assert from "node:assert/strict";
import test from "node:test";
import { GitHubError } from "../src/errors.ts";
import { GitHubClient, parseNextLink, parseRetryAfter } from "../src/github.ts";
import type { FetchLike } from "../src/github.ts";
import { FakeGitHub } from "./helpers/fake-github.ts";
import { FAKE_TOKEN, makeHarness } from "./helpers/fixtures.ts";

const RULESETS = /\/rulesets$/;

async function captureError(promise: Promise<unknown>): Promise<GitHubError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GitHubError, "expected a GitHubError");
    return error;
  }
  return assert.fail("request unexpectedly succeeded");
}

test("paginate follows Link headers across every page", async () => {
  const fake = new FakeGitHub();
  fake.pageSize = 2;
  for (let index = 0; index < 5; index += 1) fake.addRuleset({ name: `ruleset-${index}` });
  const { client } = makeHarness(fake);
  const items = await client.paginate("/repos/octo/demo/rulesets?per_page=100");
  assert.equal(items.length, 5);
  assert.deepEqual(
    fake.log.map((request) => request.query),
    ["?per_page=100", "?per_page=100&page=2", "?per_page=100&page=3"],
  );
});

test("paginate is bounded and rejects non-array pages", async () => {
  const fake = new FakeGitHub();
  fake.pageSize = 1;
  for (let index = 0; index < 4; index += 1) fake.addRuleset({ name: `ruleset-${index}` });
  const bounded = new GitHubClient({ token: FAKE_TOKEN, fetch: fake.fetch, maxPages: 2 });
  const error = await captureError(bounded.paginate("/repos/octo/demo/rulesets?per_page=100"));
  assert.equal(error.kind, "pagination");
  assert.match(error.message, /exceeded 2 pages/);

  const { client } = makeHarness(fake);
  const malformed = await captureError(client.paginate("/repos/octo/demo"));
  assert.equal(malformed.kind, "malformed");
});

test("pagination never follows a link to another origin", async () => {
  const requests: string[] = [];
  const fetch: FetchLike = (url) => {
    requests.push(url);
    return Promise.resolve({
      status: 200,
      headers: {
        get: (name) => (name === "link" ? '<https://evil.example/steal?page=2>; rel="next"' : null),
      },
      text: () => Promise.resolve("[]"),
    });
  };
  const client = new GitHubClient({ token: FAKE_TOKEN, fetch });
  const error = await captureError(client.paginate("/repos/octo/demo/rulesets"));
  assert.equal(error.kind, "redirect");
  assert.deepEqual(requests, ["https://api.github.com/repos/octo/demo/rulesets"]);
  const direct = await captureError(client.request("GET", "https://evil.example/x"));
  assert.match(direct.message, /credential was not sent/);
  assert.equal(requests.length, 1);
});

test("transient failures on idempotent requests are retried with bounded backoff", async () => {
  const fake = new FakeGitHub();
  fake.fail("GET", RULESETS, { status: 502 });
  fake.fail("GET", RULESETS, { failure: "network" });
  const { client, sleeps } = makeHarness(fake, { maxAttempts: 4 });
  assert.deepEqual(await client.paginate("/repos/octo/demo/rulesets"), []);
  assert.equal(fake.log.length, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test("retries stop at the attempt limit", async () => {
  const fake = new FakeGitHub();
  fake.fail("GET", RULESETS, { status: 503 }, 99);
  const { client, sleeps } = makeHarness(fake, { maxAttempts: 3 });
  const error = await captureError(client.get("/repos/octo/demo/rulesets"));
  assert.equal(error.kind, "server");
  assert.equal(error.status, 503);
  assert.equal(error.attempts, 3);
  assert.equal(error.ambiguous, true);
  assert.equal(fake.log.length, 3);
  assert.equal(sleeps.length, 2);
});

test("timeouts are retried and then reported as timeouts", async () => {
  const fake = new FakeGitHub();
  fake.fail("GET", RULESETS, { failure: "timeout" }, 99);
  const { client } = makeHarness(fake, { maxAttempts: 2 });
  const error = await captureError(client.get("/repos/octo/demo/rulesets"));
  assert.equal(error.kind, "timeout");
  assert.match(error.message, /timed out after 15000 ms/);
  assert.equal(fake.log.length, 2);
});

test("a hung request is aborted by the client timeout", async () => {
  const fetch: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      // A pending socket keeps the event loop alive; the abort timer alone does not.
      const socket = setTimeout(() => undefined, 5_000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(socket);
        reject(init.signal.reason as Error);
      });
    });
  const client = new GitHubClient({ token: FAKE_TOKEN, fetch, timeoutMs: 20, maxAttempts: 1 });
  const error = await captureError(client.get("/repos/octo/demo"));
  assert.equal(error.kind, "timeout");
});

test("permanent authorization and validation failures are never retried", async () => {
  for (const [status, kind] of [
    [401, "auth"],
    [403, "forbidden"],
    [404, "not_found"],
    [422, "validation"],
    [409, "client"],
  ] as const) {
    const fake = new FakeGitHub();
    fake.fail("GET", RULESETS, { status, body: JSON.stringify({ message: "nope" }) }, 99);
    const { client, sleeps } = makeHarness(fake, { maxAttempts: 5 });
    const error = await captureError(client.get("/repos/octo/demo/rulesets"));
    assert.equal(error.kind, kind);
    assert.equal(error.status, status);
    assert.equal(fake.log.length, 1, `HTTP ${status} must not be retried`);
    assert.deepEqual(sleeps, []);
  }
});

test("POST is not blindly retried after an ambiguous failure", async () => {
  for (const response of [
    { status: 502 },
    { failure: "network" as const },
    { failure: "timeout" as const },
  ]) {
    const fake = new FakeGitHub();
    fake.fail("POST", RULESETS, response, 99);
    const { client } = makeHarness(fake, { maxAttempts: 4 });
    const error = await captureError(
      client.request("POST", "/repos/octo/demo/rulesets", { name: "x" }),
    );
    assert.equal(error.ambiguous, true);
    assert.equal(fake.log.length, 1);
  }
});

test("a valid Retry-After is honoured for rate limits on any method", async () => {
  const fake = new FakeGitHub();
  fake.fail("POST", RULESETS, { status: 429, headers: { "Retry-After": "7" } });
  fake.fail("GET", RULESETS, { status: 403, headers: { "Retry-After": "3" } });
  const { client, sleeps } = makeHarness(fake);
  await client.request("POST", "/repos/octo/demo/rulesets", {
    name: "x",
    enforcement: "active",
    rules: [],
  });
  await client.paginate("/repos/octo/demo/rulesets");
  assert.deepEqual(sleeps, [7000, 3000]);
});

test("an invalid Retry-After falls back to backoff and an excessive one fails fast", async () => {
  const fake = new FakeGitHub();
  fake.fail("GET", RULESETS, { status: 429, headers: { "Retry-After": "soon-ish!" } });
  const { client, sleeps } = makeHarness(fake);
  await client.paginate("/repos/octo/demo/rulesets");
  assert.deepEqual(sleeps, [500]);

  const slow = new FakeGitHub();
  slow.fail("GET", RULESETS, { status: 429, headers: { "Retry-After": "3600" } }, 99);
  const harness = makeHarness(slow, { maxAttempts: 5 });
  const error = await captureError(harness.client.get("/repos/octo/demo/rulesets"));
  assert.equal(error.kind, "rate_limit");
  assert.match(error.message, /requested wait of 3600 s exceeds the 60 s limit/);
  assert.equal(slow.log.length, 1);
  assert.deepEqual(harness.sleeps, []);
});

test("primary rate limits wait for the reset time and stay bounded", async () => {
  const fake = new FakeGitHub();
  const headers = { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1010" };
  fake.fail("GET", RULESETS, { status: 403, headers }, 99);
  const sleeps: number[] = [];
  const client = new GitHubClient({
    token: FAKE_TOKEN,
    fetch: fake.fetch,
    maxAttempts: 3,
    now: () => 1_000_000,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      return Promise.resolve();
    },
  });
  const error = await captureError(client.get("/repos/octo/demo/rulesets"));
  assert.equal(error.kind, "rate_limit");
  assert.match(error.message, /rate limited \(HTTP 403\) after 3 attempts/);
  assert.deepEqual(sleeps, [10_000, 10_000]);
});

test("a 503 with Retry-After waits as instructed", async () => {
  const fake = new FakeGitHub();
  fake.fail("GET", RULESETS, { status: 503, headers: { "Retry-After": "2" } });
  const { client, sleeps } = makeHarness(fake);
  await client.paginate("/repos/octo/demo/rulesets");
  assert.deepEqual(sleeps, [2000]);
});

test("malformed success bodies and redirects are reported, not followed", async () => {
  const fake = new FakeGitHub();
  fake.fail("GET", /\/repos\/octo\/demo$/, { status: 200, body: "<html>proxy error</html>" });
  const { client } = makeHarness(fake);
  const malformed = await captureError(client.get("/repos/octo/demo"));
  assert.equal(malformed.kind, "malformed");
  assert.ok(!malformed.message.includes("proxy error"));

  fake.fail("GET", /\/repos\/octo\/demo$/, {
    status: 301,
    headers: { Location: "https://elsewhere.example/" },
  });
  const redirect = await captureError(client.get("/repos/octo/demo"));
  assert.equal(redirect.kind, "redirect");
  assert.equal(fake.log.length, 2);
});

test("error messages carry a short redacted summary, never the raw body or token", async () => {
  const fake = new FakeGitHub();
  const leaked = ["github", "pat", "A".repeat(40)].join("_");
  fake.fail("GET", RULESETS, {
    status: 403,
    body: JSON.stringify({
      message: `Resource not accessible. token ${FAKE_TOKEN} or ${leaked} Authorization: Bearer ${FAKE_TOKEN} ${"x".repeat(400)}`,
      documentation_url: "https://docs.github.com/secret-detail",
      internal: "do-not-surface",
    }),
  });
  const { client } = makeHarness(fake);
  const error = await captureError(client.get("/repos/octo/demo/rulesets?per_page=100"));
  assert.match(
    error.message,
    /GitHub API GET \/repos\/octo\/demo\/rulesets failed: HTTP 403 - Resource not accessible/,
  );
  assert.ok(!error.message.includes(FAKE_TOKEN));
  assert.ok(!error.message.includes(leaked));
  assert.ok(!error.message.includes("do-not-surface"));
  assert.ok(!error.message.includes("per_page"));
  assert.ok(error.message.length < 320);

  fake.fail("GET", RULESETS, { status: 500, body: "plain text failure with secrets" }, 99);
  const plain = await captureError(client.get("/repos/octo/demo/rulesets"));
  assert.ok(!plain.message.includes("secrets"));
});

test("a read-only client refuses writes before sending anything", async () => {
  const fake = new FakeGitHub();
  const { client } = makeHarness(fake, { readOnly: true });
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const error = await captureError(client.request(method, "/repos/octo/demo/rulesets", {}));
    assert.equal(error.kind, "read_only");
  }
  assert.equal(fake.log.length, 0);
  assert.deepEqual(client.writes, []);
});

test("requests authenticate with the token and record only method and path", async () => {
  const fake = new FakeGitHub();
  const { client } = makeHarness(fake);
  await client.get("/repos/octo/demo");
  assert.equal(fake.log[0]?.authorization, `Bearer ${FAKE_TOKEN}`);
  assert.deepEqual(client.requests, [{ method: "GET", path: "/repos/octo/demo" }]);
  assert.ok(!JSON.stringify(client.requests).includes(FAKE_TOKEN));
});

test("the API base URL must be https", () => {
  assert.throws(
    () =>
      new GitHubClient({
        token: FAKE_TOKEN,
        fetch: new FakeGitHub().fetch,
        baseUrl: "http://api.github.com",
      }),
    /must use https/,
  );
});

test("parseRetryAfter accepts seconds and HTTP dates only", () => {
  assert.equal(parseRetryAfter(null, 0), null);
  assert.equal(parseRetryAfter("12", 0), 12_000);
  assert.equal(parseRetryAfter(" 0 ", 0), 0);
  assert.equal(parseRetryAfter("-5", 0), null);
  assert.equal(parseRetryAfter("1.5", 0), null);
  assert.equal(parseRetryAfter("garbage", 0), null);
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now), 30_000);
  assert.equal(parseRetryAfter("Wed, 31 Dec 2025 23:59:00 GMT", now), 0);
});

test("parseNextLink extracts only the next relation", () => {
  assert.equal(parseNextLink(null), null);
  assert.equal(parseNextLink('<https://api.github.com/a?page=1>; rel="prev"'), null);
  assert.equal(
    parseNextLink(
      '<https://api.github.com/a?page=1>; rel="prev", <https://api.github.com/a?page=3>; rel="next"',
    ),
    "https://api.github.com/a?page=3",
  );
  assert.equal(parseNextLink("nonsense"), null);
});
