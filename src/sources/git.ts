import { execFile } from "node:child_process";

export class GitError extends Error {}

export interface GitOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Basic-auth header for this host only; passed via env so the token never appears in argv or .git/config. */
  auth?: { host: string; token: string };
}

export function git(args: string[], options: GitOptions = {}): Promise<string> {
  // Never block on interactive credential prompts: the MCP server has no terminal.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
  };
  if (options.auth) {
    const credentials = Buffer.from(`oauth2:${options.auth.token}`).toString("base64");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = `http.https://${options.auth.host}/.extraHeader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${credentials}`;
  }

  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: options.cwd, env, timeout: options.timeoutMs ?? 30_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const reason = error.killed ? `timed out after ${(options.timeoutMs ?? 30_000) / 1000}s` : stderr.trim() || error.message;
          reject(new GitError(`git ${args[0]} failed: ${reason}`));
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

/** Only send the token to the configured GitLab host, never to arbitrary remotes. */
export function authFor(remoteUrl: string | undefined, gitlabUrl: string | undefined): GitOptions["auth"] {
  const token = process.env.GITLAB_TOKEN;
  if (!token || !gitlabUrl || !remoteUrl?.startsWith("https://")) return undefined;
  const host = new URL(remoteUrl).host;
  return host === new URL(gitlabUrl).host ? { host, token } : undefined;
}
