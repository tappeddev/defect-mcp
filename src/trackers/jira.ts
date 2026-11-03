import { USER_ENV_FILE } from "../env.js";
import { MAX_COMMENTS, joinOrDash, truncate, type Ticket, type TicketRef } from "./types.js";

const FIELDS = [
  "summary",
  "description",
  "status",
  "priority",
  "issuetype",
  "components",
  "labels",
  "environment",
  "versions",
  "fixVersions",
  "reporter",
  "assignee",
  "created",
  "attachment",
  "comment",
  "issuelinks",
].join(",");

type Json = any;
type JiraRef = Extract<TicketRef, { kind: "jira" }>;

export async function fetchJiraTicket(ref: JiraRef, configuredUrl?: string): Promise<Ticket> {
  const baseUrl = (process.env.JIRA_URL ?? configuredUrl ?? ref.baseUrl)?.replace(/\/+$/, "");
  const token = process.env.JIRA_PERSONAL_TOKEN;
  if (!baseUrl) throw new Error("No Jira URL configured (set JIRA_URL or trackers.jira.url in the config).");
  if (!token) throw new Error(`JIRA_PERSONAL_TOKEN is not set. Add it to ${USER_ENV_FILE} (or the MCP server environment).`);

  const response = await fetch(
    `${baseUrl}/rest/api/2/issue/${encodeURIComponent(ref.key)}?fields=${FIELDS}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`Jira responded with HTTP ${response.status} for ${ref.key}.`);
  }

  const issue: Json = await response.json();
  const f: Json = issue.fields ?? {};
  const comments: Json[] = f.comment?.comments ?? [];
  const names = (items: Json[] | undefined) => joinOrDash((items ?? []).map((i) => i.name));

  return {
    kind: "jira",
    key: issue.key,
    url: `${baseUrl}/browse/${issue.key}`,
    summary: f.summary ?? "",
    facts: [
      { label: "Type", value: f.issuetype?.name ?? "-" },
      { label: "Status", value: f.status?.name ?? "-" },
      { label: "Priority", value: f.priority?.name ?? "-" },
      { label: "Reporter", value: f.reporter?.displayName ?? "-" },
      { label: "Assignee", value: f.assignee?.displayName ?? "-" },
      { label: "Created", value: f.created ?? "-" },
      { label: "Components", value: names(f.components) },
      { label: "Labels", value: joinOrDash(f.labels ?? []) },
      { label: "Affects versions", value: names(f.versions) },
      { label: "Fix versions", value: names(f.fixVersions) },
    ],
    environment: truncate(f.environment),
    description: truncate(f.description),
    attachments: (f.attachment ?? []).map((a: Json) => ({
      name: a.filename,
      url: a.content,
      mimeType: a.mimeType,
    })),
    attachmentNote: "Requires Jira authentication to download; ask the user for screenshots/logs if they are essential.",
    links: (f.issuelinks ?? []).map((l: Json) => {
      const other = l.outwardIssue ?? l.inwardIssue;
      return {
        relation: l.outwardIssue ? l.type?.outward : l.type?.inward,
        key: other?.key,
        summary: other?.fields?.summary,
        status: other?.fields?.status?.name,
      };
    }),
    comments: comments.slice(-MAX_COMMENTS).map((c: Json) => ({
      author: c.author?.displayName,
      created: c.created,
      body: truncate(c.body) ?? "",
    })),
    omittedComments: Math.max(0, comments.length - MAX_COMMENTS),
  };
}
