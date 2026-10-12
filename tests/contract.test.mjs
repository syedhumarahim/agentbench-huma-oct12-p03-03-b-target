import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
test("contract pins required checks", () => {
  const c = JSON.parse(fs.readFileSync("governance-contract.json", "utf8"));
  assert.deepEqual(c.required_status_checks, ["test", "package"]);
});
