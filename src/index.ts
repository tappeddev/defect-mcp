#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { downloadAttachment } from "./attachments.js";
import { loadConfig } from "./config.js";
import { loadEnvFiles } from "./env.js";
import { describeRef, fetchTicket, parseTicketRef, type Ticket } from "./trackers/index.js";
import { buildDefectContext } from "./prompts/fixDefect.js";
import { resolveSources, startBackgroundSync, syncMirror } from "./sources/index.js";

const loadedEnvFiles = loadEnvFiles();

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
  { name: "defect", version: "0.4.1" },
  {
    instructions:
      "For defects/tickets the user wants analysed or fixed, call the `get_context` tool first and follow its instructions.",
  },
);

async function workspaceRoots(): Promise<string[]> {
  if (!server.server.getClientCapabilities()?.roots) return [];
  try {
    const { roots } = await server.server.listRoots();
    return roots.filter((root) => root.uri.startsWith("file://")).map((root) => fileURLToPath(root.uri));
  } catch (error) {
    console.error(`[defect-mcp] Could not list workspace roots: ${(error as Error).message}`);
    return [];
  }
}

function textPrompt(text: string, description?: string) {
  return {
    description,
    messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
  };
}

const TICKET_DESCRIPTION =
  "Jira key (PROJ-1234), Jira or GitHub issue URL, owner/repo#123, or #123 with a configured default repo";
const NOTES_DESCRIPTION = "Optional hints, e.g. environment, app version, suspected area";

function isPlaceholder(value: string | undefined): boolean {
  return /^\$(\d+|ARGUMENTS)$/.test(value?.trim() ?? "");
}

/** Validates config and ticket reference without network access, so the prompt can fail fast. */
async function prepare(ticket: string) {
  // Reloaded on every call so config edits apply without restarting the server.
  const config = loadConfig({ roots: await workspaceRoots() });
  return { config, ref: parseTicketRef(ticket, config) };
}

server.registerTool(
  "get_context",
  {
    title: "Defect context",
    description:
      "Loads a defect ticket (Jira or GitHub), the state of the relevant repositories and the team's triage workflow. " +
      "Call this first whenever the user asks to analyse or fix a defect/ticket, then follow the returned instructions.",
    inputSchema: {
      ticket: z.string().describe(TICKET_DESCRIPTION),
      notes: z.string().optional().describe(NOTES_DESCRIPTION),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ ticket, notes }) => {
    let prepared;
    try {
      prepared = await prepare(ticket);
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: (error as Error).message }] };
    }
    const { config, ref } = prepared;

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

    const text = buildDefectContext({ config, sources, ref, ticket: loaded, ticketError, notes });
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "get_attachment",
  {
    title: "Download ticket attachment",
    description:
      "Downloads an attachment (screenshot, log, PDF, …) of a Jira ticket or GitHub issue using the server's credentials " +
      "and saves it locally. Use the URLs listed under Attachments in get_context. Text files are returned inline; " +
      "for images and other files, open the returned path with your file-reading tool.",
    inputSchema: {
      url: z.string().url().describe("Attachment URL as listed by get_context"),
      inline: z
        .boolean()
        .optional()
        .describe("Also return images directly in the result. Only needed if your file tools cannot open images."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ url, inline }) => {
    try {
      const config = loadConfig({ roots: await workspaceRoots() });
      const file = await downloadAttachment(url, config);
      const summary = `Saved to ${file.path} (${file.mimeType}, ${Math.round(file.bytes / 1024)} KB).`;
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];

      if (file.text !== undefined) {
        content.push({ type: "text", text: `${summary}\n\n${file.text}` });
      } else {
        content.push({
          type: "text",
          text: `${summary} Open this path with your file-reading tool to view it${file.isImage ? " (it is an image)" : ""}.`,
        });
        if (inline && file.isImage) {
          content.push({ type: "image", data: (await readFile(file.path)).toString("base64"), mimeType: file.mimeType });
        }
      }
      return { content };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: (error as Error).message }] };
    }
  },
);

server.registerPrompt(
  "fix",
  {
    title: "Find & fix defect",
    description: "Triage a defect from a Jira ticket or GitHub issue and propose a fix. Code changes only after approval.",
    argsSchema: {
      ticket: z.string().describe(TICKET_DESCRIPTION),
      notes: z.string().optional().describe(NOTES_DESCRIPTION),
    },
  },
  async ({ ticket, notes }) => {
    // OpenCode V1 calls prompts/get with the placeholders "$1", "$2" and substitutes the user's arguments into the
    // returned text afterwards (anomalyco/opencode#33564). Validation then happens in get_context instead.
    if (isPlaceholder(ticket)) {
      const notesPart = isPlaceholder(notes) ? ` and notes "${notes}" (omit notes if empty)` : "";
      return textPrompt(
        `Triage defect ${ticket}: call the defect MCP tool \`get_context\` with ticket "${ticket}"${notesPart} and follow its instructions.`,
        "Defect triage",
      );
    }

    let ref;
    try {
      ref = (await prepare(ticket)).ref;
    } catch (error) {
      return textPrompt(`defect-mcp: ${(error as Error).message}\nTell the user about this error and do nothing else.`);
    }

    // Kept to a single line on purpose: the client shows it as the user's message, the details come from the tool.
    const cleanTicket = ref.kind === "jira" ? ref.key : ticket.trim();
    const args = JSON.stringify(notes?.trim() ? { ticket: cleanTicket, notes: notes.trim() } : { ticket: cleanTicket });
    return textPrompt(
      `Triage defect ${describeRef(ref)}: call the defect MCP tool \`get_context\` with ${args} and follow its instructions.`,
      `Defect ${describeRef(ref)}`,
    );
  },
);

if (loadedEnvFiles.length) console.error(`[defect-mcp] Loaded environment from ${loadedEnvFiles.join(", ")}`);
try {
  const config = loadConfig();
  console.error(`[defect-mcp] Loaded ${config.sources.length} source(s) from ${config.configPath}`);
  startBackgroundSync(config);
} catch (error) {
  // Not fatal: clients that start the server outside the project only reveal the workspace via roots later.
  console.error(`[defect-mcp] ${(error as Error).message} Retrying with the client's workspace roots on the first prompt call.`);
}

await server.connect(new StdioServerTransport());
