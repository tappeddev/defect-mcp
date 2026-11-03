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

export function buildFixDefectPrompt(options: {
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
    ? ["", "## Team instructions", ...config.instructions.map((i) => `- ${i}`)].join("\n")
    : "";

  const notesSection = notes?.trim() ? `\n## Notes from the developer\n${notes.trim()}\n` : "";

  return `You are helping to find and fix a defect that was reported during testing.
Respond in English.

# HARD RULE
Phases 1 and 2 are **read-only**. Do NOT create, edit, delete or format any file, do NOT run code generators, migrations, git commits, checkouts or any other command that changes state. Reading files, searching code, \`git log\`/\`git show\`/\`git grep\`/\`git blame\`/\`git diff\` and running read-only commands are allowed.
Only start Phase 3 after the user has explicitly approved the proposed fix in a later message.

# Sources
These are the repositories relevant for this defect. Investigate them directly via their paths, even if they are outside the current working directory. Where a target ref is given, it is the version that was tested — base the analysis on it:
${renderSources(sources)}

Roles: \`app\` = client application, \`backend\` = one of our backend services, \`library\` = shared code used by app and/or backend, \`other\` = supporting material.

${ticketSection}
${notesSection}${extraInstructions}

# Workflow

## Phase 1 — Locate the defect: app or backend?
1. Summarise the reported behaviour in 2–3 sentences: steps, expected, actual.
2. Identify the affected feature/screen and trace it end to end: UI → state/logic → API call in the **app**, then the matching endpoint/handler → service → persistence in the **backend**.
3. Compare the request the app sends with what the backend expects, and the response the backend returns with what the app parses (paths, HTTP methods, payload fields, nullability, enums, status codes, error bodies, date/number formats, localisation).
4. Use evidence from the ticket (error messages, status codes, logs, screenshots, versions, environment) and from the code (recent \`git log\` on the relevant files can help).
5. Give a verdict: **App**, **Backend**, **Both**, **Library** or **Unclear** — naming the affected repository/repositories — with a confidence (high/medium/low) and the concrete evidence. If it is unclear, state exactly what information or reproduction would settle it.

## Phase 2 — Explanation, analysis and proposed fix
Produce a report with exactly these sections:

### 1. Verdict
App / Backend / Both / Library / Unclear — affected repository/repositories — confidence — one-sentence reason.

### 2. Explanation
What goes wrong, in plain language that a tester or product owner understands.

### 3. Analysis
- Root cause, with file paths and line numbers (\`repo/path/file:line\`) and short code excerpts.
- Why it was not caught (missing test, edge case, contract mismatch, …).
- Impact and other places affected by the same cause.

### 4. Proposed fix
- The concrete change(s) per repository and file; if there are several options, list them with pros/cons and a recommendation.
- Tests to add or adjust.
- Risks, side effects and whether app and backend changes must be released together.

### 5. Open questions
Anything that needs clarification before implementing.

Then **stop** and ask: "Shall I implement the proposed fix?" Wait for the user's answer.

## Phase 3 — Implementation (only after explicit approval)
- Implement only in local working copies, never in read-only mirrors. If a working copy is not on the target ref, ask the user which branch to base the fix on before changing anything.
- Implement exactly the approved fix with minimal, focused changes, following the conventions of each repository (read its AGENTS.md / CLAUDE.md / README / contributing guides if present).
- Add or update tests and run the relevant tests/linters where possible.
- Finish with a summary of changed files per repository and how to verify the fix (including steps for the tester).
`;
}
