import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const USER_ENV_FILE = join(homedir(), ".config", "defect-mcp", ".env");

/**
 * Loads tokens from DEFECT_MCP_ENV_FILE and ~/.config/defect-mcp/.env, so tool configs can stay identical for
 * every developer. Variables that are already set (shell, tool config, --env-file) take precedence.
 */
export function loadEnvFiles(): string[] {
  const candidates = [process.env.DEFECT_MCP_ENV_FILE, USER_ENV_FILE].filter((p): p is string => Boolean(p));
  const loaded: string[] = [];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      process.loadEnvFile(file);
      loaded.push(file);
    } catch (error) {
      console.error(`[defect-mcp] Could not read ${file}: ${(error as Error).message}`);
    }
  }
  return loaded;
}
