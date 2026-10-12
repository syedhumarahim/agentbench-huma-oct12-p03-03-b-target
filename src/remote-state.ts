import type { Contract } from "./contract.ts";
import { GitHubError } from "./errors.ts";
import type { RepositoryRef } from "./git-remote.ts";
import { fullName } from "./git-remote.ts";
import type { GitHubClient } from "./github.ts";
import { isRecord } from "./json.ts";
import { parseLiveRuleset, parseRulesetSummary } from "./rulesets.ts";
import type { LiveRuleset, RulesetSummary } from "./rulesets.ts";

export interface MergedBranch {
  readonly name: string;
  readonly pull_request: number;
}

/** Everything the planner reads from GitHub. Gathered with GET requests only. */
export interface RemoteState {
  readonly repository: RepositoryRef;
  readonly default_branch: string;
  readonly default_branch_head: string | null;
  readonly branch_count: number;
  /** Non-default branches whose head was merged into the default branch and still exist. */
  readonly merged_branches_remaining: readonly MergedBranch[];
  /** Repository rulesets inside the managed-name prefix, with full detail, ordered by id. */
  readonly managed: readonly LiveRuleset[];
  /** Every other ruleset visible on the repository. Listed only; never read in detail or written. */
  readonly unmanaged: readonly RulesetSummary[];
}

export function repoPath(repository: RepositoryRef, suffix = ""): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}${suffix}`;
}

function malformed(path: string, detail: string): GitHubError {
  return new GitHubError(`GitHub returned a malformed response for GET ${path}: ${detail}`, {
    kind: "malformed",
    method: "GET",
    path,
  });
}

function isManaged(
  summary: RulesetSummary,
  contract: Contract,
  repository: RepositoryRef,
): boolean {
  const repositoryLevel =
    (summary.source_type === null || summary.source_type === "Repository") &&
    (summary.source === null ||
      summary.source.toLowerCase() === fullName(repository).toLowerCase());
  return repositoryLevel && summary.name.startsWith(contract.managed_name_prefix);
}

/** List repository rulesets and read the detail of the contract-managed ones only. */
export async function readRulesets(
  client: GitHubClient,
  repository: RepositoryRef,
  contract: Contract,
): Promise<{ managed: LiveRuleset[]; unmanaged: RulesetSummary[] }> {
  const listPath = repoPath(repository, "/rulesets");
  const summaries = (await client.paginate(`${listPath}?includes_parents=false&per_page=100`))
    .map((entry) => parseRulesetSummary(entry, listPath))
    .sort((a, b) => a.id - b.id);
  const managed: LiveRuleset[] = [];
  const unmanaged: RulesetSummary[] = [];
  for (const summary of summaries) {
    if (isManaged(summary, contract, repository)) {
      managed.push(await readRuleset(client, repository, summary.id));
    } else {
      unmanaged.push(summary);
    }
  }
  return { managed, unmanaged };
}

export async function readRuleset(
  client: GitHubClient,
  repository: RepositoryRef,
  id: number,
): Promise<LiveRuleset> {
  const detailPath = repoPath(repository, `/rulesets/${id}`);
  return parseLiveRuleset(await client.get(detailPath), detailPath);
}

interface BranchHead {
  readonly name: string;
  readonly sha: string;
}

function parseBranch(entry: unknown, path: string): BranchHead {
  const commit = isRecord(entry) ? entry.commit : undefined;
  const name = isRecord(entry) ? entry.name : undefined;
  const sha = isRecord(commit) ? commit.sha : undefined;
  if (typeof name !== "string" || typeof sha !== "string") {
    throw malformed(path, "branch entry lacks a name or commit sha");
  }
  return { name, sha };
}

async function readMergedBranches(
  client: GitHubClient,
  repository: RepositoryRef,
  defaultBranch: string,
  branches: readonly BranchHead[],
): Promise<MergedBranch[]> {
  const candidates = new Map(
    branches
      .filter((branch) => branch.name !== defaultBranch)
      .map((branch) => [branch.name, branch.sha]),
  );
  if (candidates.size === 0) return [];
  const pullsPath = repoPath(repository, "/pulls");
  const pulls = await client.paginate(
    `${pullsPath}?state=closed&base=${encodeURIComponent(defaultBranch)}&per_page=100`,
  );
  const merged = new Map<string, number>();
  for (const pull of pulls) {
    if (!isRecord(pull)) throw malformed(pullsPath, "pull request entry is not an object");
    const head = pull.head;
    const number = pull.number;
    if (!isRecord(head) || typeof number !== "number") {
      throw malformed(pullsPath, "pull request entry lacks a head or number");
    }
    const headRepository = head.repo;
    const sameRepository =
      isRecord(headRepository) &&
      typeof headRepository.full_name === "string" &&
      headRepository.full_name.toLowerCase() === fullName(repository).toLowerCase();
    const ref = head.ref;
    if (
      typeof pull.merged_at === "string" &&
      sameRepository &&
      typeof ref === "string" &&
      candidates.get(ref) === head.sha
    ) {
      merged.set(ref, Math.max(number, merged.get(ref) ?? 0));
    }
  }
  return [...merged.entries()]
    .map(([name, pullRequest]) => ({ name, pull_request: pullRequest }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Read-only inspection of the repository: default branch, branch state and rulesets. */
export async function inspectRemote(
  client: GitHubClient,
  repository: RepositoryRef,
  contract: Contract,
): Promise<RemoteState> {
  const repositoryPath = repoPath(repository);
  const metadata = await client.get(repositoryPath);
  const defaultBranch = isRecord(metadata) ? metadata.default_branch : undefined;
  if (typeof defaultBranch !== "string" || defaultBranch.length === 0) {
    throw malformed(repositoryPath, `"default_branch" is missing`);
  }
  const branchesPath = repoPath(repository, "/branches");
  const branches = (await client.paginate(`${branchesPath}?per_page=100`)).map((entry) =>
    parseBranch(entry, branchesPath),
  );
  const { managed, unmanaged } = await readRulesets(client, repository, contract);
  return {
    repository,
    default_branch: defaultBranch,
    default_branch_head: branches.find((branch) => branch.name === defaultBranch)?.sha ?? null,
    branch_count: branches.length,
    merged_branches_remaining: await readMergedBranches(
      client,
      repository,
      defaultBranch,
      branches,
    ),
    managed,
    unmanaged,
  };
}
