import assert from "node:assert/strict";
import test from "node:test";
import { redactText, redactValue, summarizeRemoteMessage } from "../src/redact.ts";

const classic = ["ghp", "a1B2".repeat(9)].join("_");
const fineGrained = ["github", "pat", "11ABCDEFG0", "x".repeat(40)].join("_");
const scheme = "https:" + "//";

test("known secrets and token-shaped strings are removed", () => {
  const custom = "plain-custom-secret-value";
  const text = `a ${classic} b ${fineGrained} c ${custom} d`;
  assert.equal(redactText(text, [custom]), "a [REDACTED] b [REDACTED] c [REDACTED] d");
  assert.equal(redactText("nothing to hide", [""]), "nothing to hide");
});

test("authorization headers, bearer values, URL credentials and request ids are removed", () => {
  const opaque = "opaqueOpaqueOpaque1234";
  assert.equal(redactText(`Authorization: Bearer ${opaque}`), "Authorization: [REDACTED]");
  assert.equal(redactText(`"authorization":"token ${opaque}"`), '"authorization":"[REDACTED]"');
  assert.equal(redactText(`sent bearer ${opaque} today`), "sent bearer [REDACTED] today");
  assert.equal(
    redactText(`clone ${scheme}user:${opaque}@github.com/o/r.git`),
    `clone ${scheme}[REDACTED]@github.com/o/r.git`,
  );
  assert.equal(
    redactText("X-GitHub-Request-Id: ABCD:1234:5678"),
    "X-GitHub-Request-Id: [REDACTED]",
  );
  assert.equal(
    redactText(`${scheme}github.com/octo/demo.git`),
    `${scheme}github.com/octo/demo.git`,
  );
});

test("redactValue walks nested structures and preserves non-strings", () => {
  assert.deepEqual(redactValue({ a: [classic, 1, null, { b: `x ${fineGrained}` }], c: true }), {
    a: ["[REDACTED]", 1, null, { b: "x [REDACTED]" }],
    c: true,
  });
});

test("remote messages are collapsed to one short redacted line", () => {
  const summary = summarizeRemoteMessage(`Bad\n  credentials ${classic}\n${"y".repeat(500)}`);
  assert.ok(summary.startsWith("Bad credentials [REDACTED] yyy"));
  assert.equal(summary.length, 160);
  assert.ok(summary.endsWith("..."));
  assert.equal(summarizeRemoteMessage("  short  "), "short");
});
