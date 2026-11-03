import type { Config } from "../config.js";
import type { SourceStatus } from "../sources/index.js";
import { describeRef, type Ticket, type TicketRef } from "../trackers/index.js";
import { renderSources } from "./sources.js";

const TRACKER_NAMES = { jira: "Jira", github: "GitHub" } as const;

function renderTicket(t: Ticket): string {
  const sections = [
    `## ${TRACKER_NAMES[t.kind]} ticket ${t.key}: ${t.summary}`,
    "",
    `- URL: ${t.url}`,
    ...t.facts.map((f) => `- ${f.label}: ${f.value}`),
  ];

  if (t.environment) sections.push("", "### Environment", t.environment);
  sections.push("", "### Description", t.description ?? "_(empty)_");

  if (t.attachments.length) {
    sections.push(
      "",
      "### Attachments",
      ...(t.attachmentNote ? [t.attachmentNote] : []),
      ...t.attachments.map((a) => `- ${a.name}${a.mimeType ? ` (${a.mimeType})` : ""}: ${a.url}`),
    );
  }

  if (t.links.length) {
    sections.push(
      "",
      "### Linked issues",
      ...t.links.map((l) => `- ${l.relation} ${l.key}${l.summary ? `: ${l.summary}` : ""}${l.status ? ` [${l.status}]` : ""}`),
      ...(t.omittedLinks ? [`- … ${t.omittedLinks} more, see the URL`] : []),
    );
  }

  if (t.comments.length) {
    sections.push(
      "",
      t.omittedComments
        ? `### Comments (latest ${t.comments.length}, ${t.omittedComments} older omitted — see the URL)`
        : "### Comments (oldest first)",
      ...t.comments.map((c) => `#### ${c.author ?? "unknown"} — ${c.created ?? ""}\n${c.body}`),
    );
  }

  return sections.join("\n");
}

function renderTicketUnavailable(ref: TicketRef, reason: string): string {
  const tracker = TRACKER_NAMES[ref.kind];
  return [
    `## ${tracker} ticket ${describeRef(ref)}`,
    "",
    `The MCP server could not load this ticket: ${reason}`,
    "",
    `If you have another way to read ${tracker} tickets (a ${tracker} tool, CLI or skill), use it to fetch the ticket now.`,
    "Otherwise ask the user to paste the ticket description, steps to reproduce, expected/actual behaviour and any logs before continuing. Do not guess the ticket content.",
  ].join("\n");
}

export function buildDefectContext(options: {
  config: Config;
  sources: SourceStatus[];
  ref: TicketRef;
  ticket?: Ticket;
  ticketError?: string;
  notes?: string;
}): string {
  const { config, sources, ref, ticket, ticketError, notes } = options;

  const ticketSection = ticket
    ? renderTicket(ticket)
    : renderTicketUnavailable(ref, ticketError ?? "unknown error");

  const extraInstructions = config.instructions.length
    ? ["", "# Team rules", ...config.instructions.map((i) => `- ${i}`)].join("\n")
    : "";

  const notesSection = notes?.trim() ? `\n# Notes from the developer\n${notes.trim()}\n` : "";

  return `# Task
Find the cause of a defect reported during testing and propose a fix. Respond in English.

**Read-only until the user approves the fix**: no file edits, formatting, code generation, commits or checkouts. Reading, searching and read-only git commands (\`log\`, \`show\`, \`grep\`, \`blame\`, \`diff\`) are fine.

# Sources
Investigate these paths directly, even outside the current working directory. If a target ref is given, it is the tested version — analyse that. Roles: app = client, backend = one of our services, library = shared code.
${renderSources(sources)}

${ticketSection}
${notesSection}${extraInstructions}

# How to investigate
- Trace the feature end to end: UI → state → API call in the app, then endpoint → service → persistence in the backend.
- Compare request vs. what the backend expects and response vs. what the app parses (paths, fields, nullability, enums, status codes, formats).
- Use the ticket evidence (errors, logs, versions, environment) and \`git log\` on relevant files.

# Answer format
Keep it short and concrete: findings, not process. No intro, do not restate the ticket, no phase headings, omit empty sections. Aim for at most ~25 lines; the user can ask for details.

**Verdict:** App | Backend | Both | Library | Unclear · <repository> · confidence high/medium/low
**What happens:** 1–2 sentences a tester understands.
**Root cause:** 1–3 bullets with \`repo/path/file:line\`; a code excerpt only if essential (max 5 lines).
**Fix:** bullets per file, plus tests to add; risks only if relevant (e.g. app and backend must be released together). If there are real alternatives, one line each and your recommendation.
**Open questions:** only if any. If the verdict is Unclear, say exactly what would settle it.

End with: "Implement this fix?" and wait.

# After approval
- Change only local working copies, never read-only mirrors (ask the user to check the repository out first). If a working copy is not on the target ref, ask which branch to base the fix on.
- Minimal, focused changes following each repository's conventions (AGENTS.md / CLAUDE.md / README).
- Add or update tests and run them where possible.
- Finish with a short list of changed files and how a tester can verify the fix.
`;
}
