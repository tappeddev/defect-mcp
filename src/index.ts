#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { describeRef, fetchTicket, parseTicketRef, type Ticket } from "./trackers/index.js";
import { buildFixDefectPrompt } from "./prompts/fixDefect.js";
import { resolveSources, startBackgroundSync, syncMirror } from "./sources/index.js";

if (process.argv[2] === "sync") {
  await runSyncCommand();
  process.exit(0);
}

/** `defect-mcp sync [--config <path>]`: pre-fills the mirror cache, e.g. once after setup. */
async function runSyncCommand(): Promise<void> {
  const config = loadConfig();
  const remotes = config.sources.filter((s) => s.remote);
  if (!remotes.length) {
    console.log("No sources with a \"remote\" configured.");
    return;
  }
  for (const source of remotes) {
    if (source.local?.exists) {
      console.log(`- ${source.name}: skipped, local working copy ${source.local.path} is used`);
      continue;
    }
    console.log(`- ${source.name}: syncing ${source.remote!.cloneUrl} ...`);
    const result = await syncMirror(source, config);
    console.log(result.error ? `  failed: ${result.error}` : `  ${source.remote!.cachePath} @ ${result.commit}`);
  }
}

const server = new McpServer(
  { name: "defect", version: "0.1.0" },
  {
    instructions:
      "Use the `fix` prompt to triage a defect from a Jira ticket or GitHub issue: locate it (app vs backend), explain and analyse it, propose a fix, and only implement after explicit approval.",
  },
);

function textPrompt(text: string, description?: string) {
  return {
    description,
    messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
  };
}

server.registerPrompt(
  "fix",
  {
    title: "Find & fix defect",
    description:
      "Triage a defect from a Jira ticket or GitHub issue: app or backend, explanation, analysis, proposed fix. Code changes only after approval.",
    argsSchema: {
      ticket: z
        .string()
        .describe("Jira key (PROJ-1234), Jira or GitHub issue URL, owner/repo#123, or #123 with a configured default repo"),
      notes: z.string().optional().describe("Optional hints, e.g. environment, app version, suspected area"),
    },
  },
  async ({ ticket, notes }) => {
    // Reloaded on every call so config edits apply without restarting the server.
    let config;
    try {
      config = loadConfig();
    } catch (error) {
      return textPrompt(
        `The defect MCP server is misconfigured: ${(error as Error).message}\nTell the user to fix the configuration and do nothing else.`,
      );
    }

    let ref;
    try {
      ref = parseTicketRef(ticket, config);
    } catch (error) {
      return textPrompt(`${(error as Error).message}\nAsk the user for a valid ticket reference.`);
    }

    let loaded: Ticket | undefined;
    let ticketError: string | undefined;
    const [, sources] = await Promise.all([
      fetchTicket(ref, config).then(
        (result) => (loaded = result),
        (error) => {
          ticketError = (error as Error).message;
          console.error(`[defect-mcp] ${ticketError}`);
        },
      ),
      resolveSources(config),
    ]);

    return textPrompt(
      buildFixDefectPrompt({ config, sources, ref, ticket: loaded, ticketError, notes }),
      loaded ? `${loaded.key}: ${loaded.summary}` : `Defect ${describeRef(ref)}`,
    );
  },
);

try {
  const config = loadConfig();
  console.error(`[defect-mcp] Loaded ${config.sources.length} source(s) from ${config.configPath}`);
  startBackgroundSync(config);
} catch (error) {
  console.error(`[defect-mcp] ${(error as Error).message}`);
}

await server.connect(new StdioServerTransport());
