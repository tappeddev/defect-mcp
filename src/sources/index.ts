import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Config, Source } from "../config.js";
import { authFor, git } from "./git.js";

const MIRROR_FRESH_MS = 5 * 60_000;
const CLONE_TIMEOUT_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const LOG_FORMAT = "--format=%h %cs %s";

export interface TargetInfo {
  ref: string;
  resolved?: string;
  commit?: string;
  ahead?: number;
  behind?: number;
  fetchError?: string;
  error?: string;
}

export type SourceStatus =
  | {
      mode: "local";
      source: Source;
      path: string;
      git?: { branch: string; head: string; dirtyFiles: number; target?: TargetInfo };
      notGit?: boolean;
      gitError?: string;
    }
  | { mode: "mirror"; source: Source; path: string; commit?: string; syncedAt?: Date; pending?: boolean; error?: string }
  | { mode: "missing"; source: Source; reason: string };

interface MirrorResult {
  commit?: string;
  syncedAt?: Date;
  error?: string;
}

const inflight = new Map<string, Promise<MirrorResult>>();
const lastSync = new Map<string, MirrorResult & { at: number }>();

async function cloneOrFetch(source: Source, config: Config): Promise<MirrorResult> {
  const { cloneUrl, cachePath } = source.remote!;
  const auth = authFor(cloneUrl, config.gitlab.url);
  const fresh = !existsSync(join(cachePath, ".git"));

  try {
    if (fresh) {
      await mkdir(dirname(cachePath), { recursive: true });
      await rm(cachePath, { recursive: true, force: true });
      await git(["clone", "--no-checkout", "--origin", "origin", cloneUrl, cachePath], { auth, timeoutMs: CLONE_TIMEOUT_MS });
    } else {
      await git(["remote", "set-url", "origin", cloneUrl], { cwd: cachePath });
    }

    await git(["fetch", "--prune", "--tags", "--force", "origin", source.ref ?? "HEAD"], {
      cwd: cachePath,
      auth,
      timeoutMs: fresh ? CLONE_TIMEOUT_MS : 2 * 60_000,
    });
    await git(["checkout", "--force", "--detach", "FETCH_HEAD"], { cwd: cachePath });
    const commit = await git(["log", "-1", LOG_FORMAT, "HEAD"], { cwd: cachePath });
    return { commit, syncedAt: new Date() };
  } catch (error) {
    // A half-finished first clone would look like a valid mirror next time, so remove it.
    if (fresh) await rm(cachePath, { recursive: true, force: true }).catch(() => undefined);
    const hint = auth ? "" : " (no GITLAB_TOKEN used: set it, or make sure your git credentials/SSH key work non-interactively)";
    return { error: `${(error as Error).message}${hint}` };
  }
}

export function syncMirror(source: Source, config: Config): Promise<MirrorResult> {
  const key = source.remote!.cachePath;
  const cached = lastSync.get(key);
  if (cached && !cached.error && Date.now() - cached.at < MIRROR_FRESH_MS) return Promise.resolve(cached);

  const running = inflight.get(key);
  if (running) return running;

  const promise = cloneOrFetch(source, config)
    .then((result) => {
      lastSync.set(key, { ...result, at: Date.now() });
      if (result.error) console.error(`[defect-mcp] Sync of ${source.name} failed: ${result.error}`);
      return result;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

function needsMirror(source: Source): boolean {
  return Boolean(source.remote && !source.local?.exists);
}

/** Starts mirroring in the background so the first prompt call does not have to wait for a full clone. */
export function startBackgroundSync(config: Config): void {
  for (const source of config.sources.filter(needsMirror)) void syncMirror(source, config);
}

async function inspectTarget(path: string, ref: string, config: Config): Promise<TargetInfo> {
  const target: TargetInfo = { ref };

  const originUrl = await git(["remote", "get-url", "origin"], { cwd: path }).catch(() => undefined);
  if (originUrl) {
    await git(["fetch", "origin", ref], { cwd: path, auth: authFor(originUrl, config.gitlab.url), timeoutMs: FETCH_TIMEOUT_MS }).catch(
      (error) => (target.fetchError = (error as Error).message),
    );
  }

  for (const candidate of originUrl ? [`origin/${ref}`, ref] : [ref]) {
    const resolved = await git(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { cwd: path }).catch(() => "");
    if (resolved) {
      target.resolved = candidate;
      break;
    }
  }
  if (!target.resolved) {
    target.error = `ref "${ref}" not found`;
    return target;
  }

  const [ahead, behind] = (await git(["rev-list", "--left-right", "--count", `HEAD...${target.resolved}`], { cwd: path }))
    .split(/\s+/)
    .map(Number);
  target.ahead = ahead;
  target.behind = behind;
  target.commit = await git(["log", "-1", LOG_FORMAT, target.resolved], { cwd: path });
  return target;
}

async function inspectLocal(source: Source, config: Config): Promise<SourceStatus> {
  const path = source.local!.path;
  const isRepo = await git(["rev-parse", "--is-inside-work-tree"], { cwd: path }).then(
    () => true,
    () => false,
  );
  if (!isRepo) return { mode: "local", source, path, notGit: true };

  const [branch, head, status] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path }),
    git(["log", "-1", LOG_FORMAT, "HEAD"], { cwd: path }),
    git(["status", "--porcelain"], { cwd: path }),
  ]);
  const target = source.ref ? await inspectTarget(path, source.ref, config) : undefined;

  return {
    mode: "local",
    source,
    path,
    git: { branch, head, dirtyFiles: status ? status.split("\n").length : 0, target },
  };
}

async function resolveMirror(source: Source, config: Config): Promise<SourceStatus> {
  const path = source.remote!.cachePath;
  const timeoutMs = config.gitlab.syncTimeoutSeconds * 1000;
  const result = await Promise.race([
    syncMirror(source, config),
    sleep(timeoutMs, undefined, { ref: false }),
  ]);

  if (!result) return { mode: "mirror", source, path, pending: true };
  return { mode: "mirror", source, path, ...result };
}

export function resolveSources(config: Config): Promise<SourceStatus[]> {
  return Promise.all(
    config.sources.map(async (source): Promise<SourceStatus> => {
      try {
        if (source.local?.exists) return await inspectLocal(source, config);
        if (source.remote) return await resolveMirror(source, config);
        return { mode: "missing", source, reason: `path ${source.local?.path} not found and no "remote" configured` };
      } catch (error) {
        const reason = (error as Error).message;
        if (source.local?.exists) return { mode: "local", source, path: source.local.path, gitError: reason };
        return { mode: "missing", source, reason };
      }
    }),
  );
}
