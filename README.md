# Governance rollout

A small typed CLI (Node.js 22, TypeScript run through Node's type stripping, no runtime
dependencies) that keeps the repository's **protected-main policy** in line with the tracked
contract in [`governance-contract.json`](governance-contract.json).

```
npm ci                      # dev tooling only (TypeScript, ESLint, Prettier), pinned by package-lock.json
npm run policy -- plan      # read-only: what would change
npm run policy -- apply     # reconcile the managed rulesets
npm run policy -- verify    # read-only: does the live policy match the contract?
npm run policy -- restore   # recover the managed rulesets from the last snapshot
```

## Governance model

`governance-contract.json` is the source of truth. It describes exactly one repository ruleset,
named by `ruleset_name`, which must be active on the repository's default branch and must:

| Contract key                             | Effect on the managed ruleset                                   |
| ---------------------------------------- | --------------------------------------------------------------- |
| `branch` (`~DEFAULT_BRANCH`)             | targets the actual default branch, and only that branch         |
| `pull_request`                           | changes reach the branch only through a pull request            |
| `allowed_merge_method`                   | the single merge method pull requests may use (`squash`)        |
| `required_approving_review_count`        | approvals required before merging                               |
| `required_review_thread_resolution`      | review conversations must be resolved                           |
| `required_status_checks` + `strict`      | exact status contexts (`test`, `package`); head must be current |
| `required_linear_history`                | no merge commits                                                |
| `block_force_pushes` / `block_deletions` | force pushes and deletion of the branch are blocked             |
| `bypass_actors`                          | the complete list of bypass actors (empty: nobody may bypass)   |
| `enforcement`                            | must be `active`                                                |

The contract is validated strictly before anything else happens. Unsupported versions, unknown
keys, unsupported rule types, duplicate keys or duplicate managed ruleset names, malformed branch
selectors, wildcard targets (`~ALL`, `*`, a wildcard prefix), empty or duplicate status-check
names, and self-contradictory policies (for example `merge` with linear history, or `strict` with
no checks) are all rejected with a message that lists every problem found.

The required status contexts are produced locally, not by a hosted runner:
`scripts/report_local_checks.py` runs `npm test` and `npm run package` and reports `test` and
`package` on the exact commit through the Commit Statuses API. `plan` cross-checks the contract
against the reporter and `package.json`, and refuses to proceed if a required context has no local
producer, because such a policy could never be satisfied.

## Managed-scope boundary

The CLI owns repository-level rulesets whose name starts with `managed_name_prefix`
(`agentbench-managed-`), and nothing else.

- **Written**: the ruleset named `ruleset_name` (created, or updated in place when it drifts).
- **Deleted**: the ruleset named `obsolete_managed_ruleset_name`, and duplicates of `ruleset_name`
  — only after the replacement has been verified.
- **Reported, never changed**: other rulesets that happen to use the prefix (a warning), and merged
  branches that still exist remotely (a warning).
- **Never read in detail, never written**: every ruleset outside the prefix, rulesets inherited
  from an organization, and all other repository settings — visibility, collaborators, Actions
  permissions, secrets, variables, environments, webhooks, deploy keys, issue settings.

The only endpoints the CLI calls are `GET /repos/{owner}/{repo}`, `GET …/branches`, `GET …/pulls`,
and `GET|POST|PUT|DELETE …/rulesets[/{id}]`.

## Commands

All commands resolve the owner and repository from the `origin` remote (override with `--remote`),
which must be a credential-free URL such as `https://github.com/OWNER/REPO.git`. A remote that
embeds a user name, password or token is rejected and its URL is not echoed.

| Command   | Remote writes | Output                                                                       | Exit code                       |
| --------- | ------------- | ---------------------------------------------------------------------------- | ------------------------------- |
| `plan`    | none          | `artifacts/governance-plan.json`, `artifacts/governance-plan.md`             | 0, or 1 when a blocker is found |
| `apply`   | minimum       | `state/governance-recovery-snapshot.json`, `artifacts/governance-apply.json` | 0, or 1 on any failure          |
| `verify`  | none          | `artifacts/governance-verify.json`                                           | 0 when compliant, 1 on drift    |
| `restore` | minimum       | `artifacts/governance-restore.json`                                          | 0, or 1 on any failure          |

Exit code 2 always means the command never reached GitHub: bad usage, an invalid contract, a
missing token, an unusable remote, or a missing or invalid snapshot.

Options: `--contract`, `--remote`, `--token-file`, `--artifacts-dir`, `--state-dir`, `--snapshot`,
`--help`.

### `plan`

Reads the default branch, the branch list, closed pull requests (to spot merged branches that were
not deleted), every repository ruleset, and the local check names. It then computes the minimum set
of ruleset changes and writes the plan as JSON and Markdown.

The output is deterministic: keys are sorted, lists are ordered, and it contains no token, header,
absolute path, timestamp, request id or remote error body. Running `plan` again against unchanged
remote state produces byte-identical files. The client used by `plan` and `verify` refuses any
non-GET request locally, so they cannot write even by mistake.

### `apply`

1. Plans, exactly as `plan` does. If nothing has to change, it stops: no snapshot, no write.
2. Saves the recovery snapshot locally, before the first remote write.
3. Creates the protected-main ruleset, or updates it in place.
4. Re-reads the ruleset and verifies it two independent ways (field comparison against the contract
   and a requirement-by-requirement policy check).
5. Only then deletes the obsolete ruleset and any duplicates.
6. Re-inspects the repository and requires an empty plan.

If verification fails after an update, the previous ruleset body is written back. If it fails after
a create, existing managed rulesets are left exactly as they were. In neither case is anything
deleted, so the default branch is never left without the last verified policy. A failure while
deleting leaves the verified replacement active; re-running `apply` finishes the job.

### `verify`

Checks each requirement of the policy against the live ruleset, plus: the managed ruleset exists,
no duplicate exists, no obsolete managed ruleset remains, and the plan is empty. Prints one line
per check.

### `restore`

Validates the snapshot, then brings each recorded ruleset back to its recorded state: updated in
place when it still exists (matched by id, then by name), re-created when it is gone, left alone
when it already matches. It never deletes, and it never touches a ruleset that is not in the
snapshot.

## Recovery procedure

`apply` writes `state/governance-recovery-snapshot.json` (and a content-addressed copy under
`state/snapshots/`) holding the contract-managed rulesets as they were before the rollout. `state/`
is git-ignored; the snapshot holds ruleset configuration only, never credentials.

1. Run `npm run policy -- verify` to see what is wrong.
2. If the contract is right and the remote drifted, run `apply` again — it converges forward and is
   the preferred fix.
3. If the rollout itself must be undone, run `npm run policy -- restore` (or pass
   `--snapshot state/snapshots/<digest>.json` for an older snapshot).
4. Run `verify` or `plan` again and review the result.

Before using a snapshot, `restore` checks its schema exactly (unknown keys are rejected), its
integrity digest, that it was captured for this repository and this managed prefix, that every
recorded ruleset name is inside the managed prefix, and that it contains no credential-like text. A
missing or invalid snapshot stops the command before any request is made.

`restore` is for real recovery. It is not part of a normal rollout and should not be run just to
try it out: re-creating an obsolete ruleset changes what the branch enforces.

## Credential handling

- The token is read at runtime from `--token-file <path>`, from the file named by
  `GOVERNANCE_TOKEN_FILE`, or from the `GITHUB_TOKEN` environment variable. It is never accepted as
  a command-line argument.
- It is held in memory, sent only as the `Authorization` header to the API origin over HTTPS, and
  never written to artifacts, snapshots, logs or git configuration.
- Redirects are not followed and pagination links to another origin are refused, so the token
  cannot be forwarded elsewhere.
- Error messages contain the method, path, status and a short redacted summary of GitHub's message
  — never the response body. All output passes through a redaction step that removes the token and
  token-shaped strings.
- Use credential-free remotes. To push, supply the token through `GIT_ASKPASS` or a credential
  helper rather than the URL.

`npm run scan:publication` scans every commit and blob reachable from any ref (and any extra
directories given as arguments, for example `artifacts state`) for tokens, private keys,
credential-bearing URLs and credential files. It reports rule names, paths and commit ids only.
Run it before publishing a repository or its history.

## Expected GitHub permissions

For a fine-grained personal access token scoped to the target repository:

| Permission                 | Needed for                                                             |
| -------------------------- | ---------------------------------------------------------------------- |
| Metadata: read             | every command                                                          |
| Administration: read/write | `apply` and `restore` (ruleset writes); reading bypass actors          |
| Contents: read             | branch list (`plan`, `verify`); write is needed only to push branches  |
| Pull requests: read        | merged-branch detection; write is needed only to open and merge the PR |
| Commit statuses: write     | `scripts/report_local_checks.py` only — the CLI never writes statuses  |

A classic token needs `repo`. If the credential cannot see bypass actors, `plan` and `verify` say
so and `apply` refuses to write, because the "no bypass actor" requirement could not be confirmed.

## Idempotency guarantees

- `plan` and `verify` never write, and their output is a pure function of the contract, the local
  check configuration and the remote state.
- `apply` after a successful `apply` sends no write or delete request, creates no duplicate, and
  leaves the existing recovery snapshot untouched.
- Rule parameters GitHub adds with default values do not count as drift, so a compliant ruleset
  stays compliant when the API grows new optional fields.
- Creating a ruleset is the one non-idempotent call. If it ends ambiguously (timeout, network
  error, 5xx) the CLI looks the ruleset up by name and adopts it rather than creating a second one.
- `restore` compares before writing; repeating it after success, or after a partial failure, only
  performs the work that is still outstanding.

## Failure handling

Requests time out after 15 seconds. Network errors, timeouts and HTTP 500/502/503/504 are retried
for idempotent methods with exponential backoff, at most four attempts in total. Rate limits (429,
or 403 with `Retry-After` or an exhausted quota) honour a valid `Retry-After` or the reset time, up
to 60 seconds per wait; longer waits fail immediately with a clear message. Authorization and
validation failures (401, 403, 404, 422) are never retried. Pagination follows `Link` headers and is
capped at 50 pages. Responses that are not valid JSON or lack required fields are rejected.

## Protected change workflow

Work on a branch, open a pull request into the default branch, then from the clean, pushed head:

```
python scripts/report_local_checks.py --token-file PATH
```

It runs `npm test` and `npm run package`, and reports only their real results for that exact SHA
(`--local-only` runs the checks without publishing). If the head changes, run it again. Merge with
the contract's merge method once both statuses are green, then delete the merged branch. Keep the
helper intact and never fabricate a status.

## Development

```
npm run check    # format:check, lint, typecheck, test (with coverage thresholds), package
```

| Script                     | What it does                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `npm test`                 | Node's test runner with coverage; fails below 95% lines, 90% branches, 90% functions |
| `npm run package`          | `npm pack --dry-run`                                                                 |
| `npm run typecheck`        | `tsc --noEmit` in strict mode                                                        |
| `npm run lint`             | ESLint with type-aware rules, zero warnings allowed                                  |
| `npm run format:check`     | Prettier                                                                             |
| `npm run scan:publication` | history and artifact scan for credential material                                    |

`npm test` and `npm run package` need only Node.js; the other scripts need `npm ci` first. Tests
use an in-memory GitHub fake and temporary git repositories: they never read a real token and never
reach the network (the global `fetch` is replaced with one that fails).

## Limitations

- github.com only. `GITHUB_API_URL` can point at another HTTPS API origin, but remotes must be
  `github.com` URLs.
- One managed ruleset per contract, targeting one branch. Tag, push and organization rulesets are
  out of scope.
- Rule types beyond those in the table above (signatures, deployments, merge queue, code scanning,
  path or pattern restrictions) cannot be expressed and are rejected by validation.
- Status checks are matched by context name from any source; pinning a check to a specific GitHub
  App is not supported.
- `restore` does not delete. After a full rollback the replacement ruleset is still present and is
  listed as "left in place"; remove it deliberately if that is really intended.
- Merged branches that still exist are reported, not deleted; the CLI changes rulesets only.
- A ruleset edited by someone else between planning and writing is not locked against; the final
  re-inspection in `apply` reports any difference that remains.
