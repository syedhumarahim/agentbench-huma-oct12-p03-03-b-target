import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { UsageError } from "../src/errors.ts";
import { fullName, parseRemoteUrl, resolveRepository } from "../src/git-remote.ts";
import { makeTempRepo } from "./helpers/fixtures.ts";

test("credential-free GitHub remotes are parsed", () => {
  const expected = { owner: "octo", name: "demo.repo" };
  for (const url of [
    "https://github.com/octo/demo.repo.git",
    "https://github.com/octo/demo.repo",
    "https://github.com/octo/demo.repo/",
    "git@github.com:octo/demo.repo.git",
    "ssh://git@github.com/octo/demo.repo.git\n",
  ]) {
    assert.deepEqual(parseRemoteUrl(url, "origin"), expected, url);
  }
  assert.equal(fullName(expected), "octo/demo.repo");
});

test("remotes that embed credentials are rejected without echoing them", () => {
  const secret = ["ghp", "R".repeat(36)].join("_");
  for (const url of [
    `https://${secret}@github.com/octo/demo.git`,
    `https://user:${secret}@github.com/octo/demo.git`,
    `https://x-access-token:${secret}@github.com/octo/demo`,
    `http://user:${secret}@github.com/octo/demo.git`,
    `ssh://deploy:${secret}@github.com/octo/demo.git`,
  ]) {
    assert.throws(
      () => parseRemoteUrl(url, "origin"),
      (error: unknown) =>
        error instanceof UsageError &&
        error.message.includes("embeds credentials") &&
        !error.message.includes(secret) &&
        !error.message.includes("user"),
    );
  }
});

test("unsupported remotes are rejected", () => {
  for (const url of [
    "https://gitlab.com/octo/demo.git",
    "http://github.com/octo/demo.git",
    "https://github.com/octo",
    "https://github.com/octo/demo/extra",
    "https://github.com/octo/..",
    "/srv/git/demo.git",
    "",
  ]) {
    assert.throws(
      () => parseRemoteUrl(url, "origin"),
      /not a supported credential-free GitHub URL/,
      url,
    );
  }
});

test("the repository is resolved from a real temporary clone", async (t) => {
  const cwd = makeTempRepo(t, { remoteUrl: "https://github.com/Octo-Org/demo_repo.git" });
  assert.deepEqual(await resolveRepository(cwd, "origin"), {
    owner: "Octo-Org",
    name: "demo_repo",
  });
  await assert.rejects(resolveRepository(cwd, "upstream"), /cannot read git remote "upstream"/);
  await assert.rejects(resolveRepository(cwd, "--upload-pack=x"), /invalid git remote name/);
});

test("a credential-bearing push URL is rejected even when the fetch URL is clean", async (t) => {
  const cwd = makeTempRepo(t);
  const secret = ["ghp", "P".repeat(36)].join("_");
  execFileSync("git", [
    "-C",
    cwd,
    "remote",
    "set-url",
    "--push",
    "origin",
    `https://${secret}@github.com/octo/demo.git`,
  ]);
  await assert.rejects(
    resolveRepository(cwd, "origin"),
    (error: unknown) => error instanceof UsageError && !error.message.includes(secret),
  );
});

test("mismatched fetch and push repositories are rejected", async (t) => {
  const cwd = makeTempRepo(t);
  execFileSync("git", [
    "-C",
    cwd,
    "remote",
    "set-url",
    "--push",
    "origin",
    "https://github.com/octo/other.git",
  ]);
  await assert.rejects(resolveRepository(cwd, "origin"), /different fetch and push repositories/);
});
