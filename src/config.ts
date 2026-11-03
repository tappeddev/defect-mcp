import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const SourceSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[\w.-]+$/, "only letters, digits, '.', '_' and '-' (used as cache directory name)"),
    role: z.enum(["app", "backend", "library", "other"]),
    description: z.string().optional(),
    path: z.string().min(1).optional(),
    remote: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
  })
  .refine((source) => source.path || source.remote, { message: 'Each source needs "path" and/or "remote".' });

const ConfigSchema = z
  .object({
    trackers: z
      .object({
        jira: z.object({ url: z.string().url().optional() }).optional(),
        github: z
          .object({
            apiUrl: z.string().url().optional(),
            defaultRepo: z
              .string()
              .regex(/^[\w.-]+\/[\w.-]+$/, 'expected "owner/repo"')
              .optional(),
          })
          .optional(),
      })
      .default({})
      .refine((trackers) => trackers.jira || trackers.github, {
        message: 'Configure at least one tracker: "jira" and/or "github" (an empty object {} is enough to enable one).',
      }),
    gitlab: z
      .object({
        url: z.string().url().optional(),
        cacheDir: z.string().min(1).optional(),
        syncTimeoutSeconds: z.number().int().positive().default(60),
      })
      .default({ syncTimeoutSeconds: 60 }),
    sources: z.array(SourceSchema).min(1),
    instructions: z.array(z.string()).default([]),
  })
  .refine(
    (config) => config.gitlab.url || config.sources.every((s) => !s.remote || isCloneUrl(s.remote)),
    { message: 'Sources with a GitLab project path as "remote" require "gitlab.url".', path: ["gitlab", "url"] },
  );

export type Role = z.infer<typeof SourceSchema>["role"];

export interface Source {
  name: string;
  role: Role;
  description?: string;
  ref?: string;
  local?: { path: string; exists: boolean };
  remote?: { cloneUrl: string; cachePath: string };
}

export type Config = Omit<z.infer<typeof ConfigSchema>, "sources" | "gitlab"> & {
  gitlab: z.infer<typeof ConfigSchema>["gitlab"] & { cacheDir: string };
  sources: Source[];
  configPath: string;
};

export const CONFIG_FILENAME = ".defect-mcp.json";
const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "defect-mcp", "repos");

function isCloneUrl(remote: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(remote) || /^[\w.-]+@[\w.-]+:/.test(remote);
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function resolvePath(path: string, baseDir: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function findUpwards(startDir: string): string | undefined {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Explicit --config / DEFECT_MCP_CONFIG win. Otherwise the project config is searched from each directory upwards:
 * first the server's working directory (OpenCode, Claude Code start it in the project), then the client's
 * workspace roots for clients that start servers elsewhere.
 */
function resolveConfigPath(argv: string[], searchDirs: string[]): string {
  const index = argv.indexOf("--config");
  const explicit = (index >= 0 ? argv[index + 1] : undefined) ?? process.env.DEFECT_MCP_CONFIG;
  if (explicit) {
    const path = resolve(expandHome(explicit));
    if (!existsSync(path)) throw new Error(`Config not found at ${path}.`);
    return path;
  }

  for (const dir of searchDirs) {
    const found = findUpwards(dir);
    if (found) return found;
  }

  throw new Error(
    `No ${CONFIG_FILENAME} found in ${searchDirs.join(", ")} or any parent directory. ` +
      `Add a ${CONFIG_FILENAME} to the project root (see https://github.com/tappeddev/defect-mcp#configuration) or pass --config <path>.`,
  );
}

export function loadConfig(options: { argv?: string[]; roots?: string[] } = {}): Config {
  const argv = options.argv ?? process.argv.slice(2);
  const searchDirs = [...new Set([process.cwd(), ...(options.roots ?? [])])];
  const configPath = resolveConfigPath(argv, searchDirs);

  const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(configPath, "utf8")));
  if (!parsed.success) {
    throw new Error(`Invalid config ${configPath}:\n${z.prettifyError(parsed.error)}`);
  }

  // Paths are relative to the config file, so a shared config can live next to the repos.
  const baseDir = dirname(configPath);
  const cacheDir = parsed.data.gitlab.cacheDir ? resolvePath(parsed.data.gitlab.cacheDir, baseDir) : DEFAULT_CACHE_DIR;
  const gitlabUrl = parsed.data.gitlab.url?.replace(/\/+$/, "");

  const sources: Source[] = parsed.data.sources.map(({ path, remote, ...rest }) => {
    const source: Source = { ...rest };
    if (path) {
      const absolute = resolvePath(path, baseDir);
      source.local = { path: absolute, exists: existsSync(absolute) };
    }
    if (remote) {
      const cloneUrl = isCloneUrl(remote) ? remote : `${gitlabUrl}/${remote.replace(/^\/+|\/+$/g, "")}.git`;
      source.remote = { cloneUrl, cachePath: join(cacheDir, source.name) };
    }
    return source;
  });

  return { ...parsed.data, gitlab: { ...parsed.data.gitlab, cacheDir }, sources, configPath };
}
