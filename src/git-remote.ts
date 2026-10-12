import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UsageError } from "./errors.ts";

const execFileAsync = promisify(execFile);

export interface RepositoryRef {
  readonly owner: string;
  readonly name: string;
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const REPO = "[A-Za-z0-9._-]{1,100}";
const HTTPS_REMOTE = new RegExp(`^https://github\\.com/(${OWNER})/(${REPO}?)(?:\\.git)?/?$`);
const SSH_REMOTE = new RegExp(
  `^(?:git@github\\.com:|ssh://git@github\\.com/)(${OWNER})/(${REPO}?)(?:\\.git)?/?$`,
);

export function fullName(repository: RepositoryRef): string {
  return `${repository.owner}/${repository.name}`;
}

/**
 * Parse a remote URL into owner and repository.
 *
 * Only credential-free GitHub URLs are accepted. A URL that embeds a user name, password or token
 * is rejected, and the error deliberately does not echo the URL.
 */
export function parseRemoteUrl(url: string, remoteName: string): RepositoryRef {
  const trimmed = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(trimmed) && !trimmed.startsWith("ssh://git@")) {
    throw new UsageError(
      `git remote "${remoteName}" embeds credentials in its URL; replace it with a credential-free URL such as https://github.com/OWNER/REPO.git`,
    );
  }
  const match = HTTPS_REMOTE.exec(trimmed) ?? SSH_REMOTE.exec(trimmed);
  const owner = match?.[1];
  const name = match?.[2];
  if (owner === undefined || name === undefined || name === "." || name === "..") {
    throw new UsageError(
      `git remote "${remoteName}" is not a supported credential-free GitHub URL (expected https://github.com/OWNER/REPO.git)`,
    );
  }
  return { owner, name };
}

export const runGit: GitRunner = async (cwd, args) => {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout;
};

/** Resolve the target repository from the fetch and push URLs of a git remote. */
export async function resolveRepository(
  cwd: string,
  remoteName: string,
  git: GitRunner = runGit,
): Promise<RepositoryRef> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remoteName)) {
    throw new UsageError(`invalid git remote name ${JSON.stringify(remoteName)}`);
  }
  let fetchUrl: string;
  let pushUrl: string;
  try {
    fetchUrl = await git(cwd, ["remote", "get-url", remoteName]);
    pushUrl = await git(cwd, ["remote", "get-url", "--push", remoteName]);
  } catch {
    throw new UsageError(
      `cannot read git remote "${remoteName}"; run inside a clone whose "${remoteName}" remote points at the target repository`,
    );
  }
  const repository = parseRemoteUrl(fetchUrl, remoteName);
  const pushRepository = parseRemoteUrl(pushUrl, remoteName);
  if (fullName(repository).toLowerCase() !== fullName(pushRepository).toLowerCase()) {
    throw new UsageError(
      `git remote "${remoteName}" has different fetch and push repositories; refusing to guess the target`,
    );
  }
  return repository;
}
