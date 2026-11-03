import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Config } from "./config.js";
import { USER_ENV_FILE } from "./env.js";

const ATTACHMENT_DIR = join(homedir(), ".cache", "defect-mcp", "attachments");
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_INLINE_TEXT = 20_000;
const TEXT_TYPES = /^(text\/|application\/(json|xml|x-ndjson|yaml|x-yaml|javascript|x-sh))/;
const TEXT_EXTENSIONS = /\.(log|txt|json|xml|ya?ml|csv|md|har|stacktrace|out)$/i;

export interface Attachment {
  path: string;
  mimeType: string;
  bytes: number;
  isImage: boolean;
  text?: string;
}

function origin(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).origin : undefined;
  } catch {
    return undefined;
  }
}

/** Returns the auth header for a URL, or throws: tokens are only ever sent to the configured trackers. */
function authFor(url: URL, config: Config): Record<string, string> {
  const jiraOrigin = config.trackers.jira ? origin(process.env.JIRA_URL ?? config.trackers.jira.url) : undefined;
  if (jiraOrigin && url.origin === jiraOrigin) {
    const token = process.env.JIRA_PERSONAL_TOKEN;
    if (!token) throw new Error(`JIRA_PERSONAL_TOKEN is not set. Add it to ${USER_ENV_FILE}.`);
    return { Authorization: `Bearer ${token}` };
  }

  if (config.trackers.github) {
    const githubHosts = new Set(["github.com", "api.github.com", "user-images.githubusercontent.com", "private-user-images.githubusercontent.com"]);
    const apiOrigin = origin(config.trackers.github.apiUrl);
    if (githubHosts.has(url.host) || url.origin === apiOrigin) {
      const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      return token ? { Authorization: `Bearer ${token}` } : {};
    }
  }

  throw new Error(`${url.origin} is not a configured tracker; only attachments from the configured Jira/GitHub can be downloaded.`);
}

export async function downloadAttachment(rawUrl: string, config: Config): Promise<Attachment> {
  const url = new URL(rawUrl.trim());
  const response = await fetch(url, { headers: { ...authFor(url, config), "User-Agent": "defect-mcp" }, redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status} for ${url.href}.`);

  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_BYTES) throw new Error(`Attachment is too large (${declaredSize} bytes, limit ${MAX_BYTES}).`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > MAX_BYTES) throw new Error(`Attachment is too large (${data.length} bytes, limit ${MAX_BYTES}).`);

  const filename = decodeURIComponent(basename(url.pathname)).replace(/[^\w.-]+/g, "_") || "attachment";
  // One directory per URL keeps same-named attachments of different tickets apart.
  const dir = join(ATTACHMENT_DIR, createHash("sha1").update(url.href).digest("hex").slice(0, 12));
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  await writeFile(path, data);

  const mimeType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
  const isText = TEXT_TYPES.test(mimeType) || TEXT_EXTENSIONS.test(filename);
  let text: string | undefined;
  if (isText) {
    const full = data.toString("utf8");
    text = full.length > MAX_INLINE_TEXT ? `${full.slice(-MAX_INLINE_TEXT)}\n… [showing the last ${MAX_INLINE_TEXT} characters; full file at ${path}]` : full;
  }

  return { path, mimeType, bytes: data.length, isImage: mimeType.startsWith("image/"), text };
}
