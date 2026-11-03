import { MAX_COMMENTS, MAX_LINKS, joinOrDash, truncate, type Ticket, type TicketRef } from "./types.js";

type Json = any;
type GitHubRef = Extract<TicketRef, { kind: "github" }>;

const PAGE_SIZE = 100;
const ATTACHMENT_PATTERN = /!?\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|(https:\/\/github\.com\/user-attachments\/[^\s)"'>]+)/g;

export function githubApiUrlForHost(origin: string): string {
  // GitHub.com uses a separate API host; GitHub Enterprise Server serves it under /api/v3.
  return origin === "https://github.com" ? "https://api.github.com" : `${origin}/api/v3`;
}

function extractAttachments(markdown: string | undefined): Ticket["attachments"] {
  if (!markdown) return [];
  const found = new Map<string, string>();
  for (const match of markdown.matchAll(ATTACHMENT_PATTERN)) {
    const url = match[2] ?? match[3];
    const isFile =
      Boolean(match[3]) || match[0].startsWith("!") || /user-attachments|githubusercontent|\/files\/\d+\//.test(url);
    if (isFile && !found.has(url)) found.set(url, match[1] || url.split("/").pop() || url);
  }
  return [...found].map(([url, name]) => ({ name, url }));
}

export async function fetchGitHubIssue(ref: GitHubRef, configuredApiUrl?: string): Promise<Ticket> {
  const apiUrl = (ref.apiUrl ?? configuredApiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "defect-mcp",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const base = `${apiUrl}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues/${ref.number}`;
  const get = async (url: string): Promise<Json> => {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const hint =
        !token && (response.status === 404 || response.status === 401)
          ? " The repository may be private: set GITHUB_TOKEN in the MCP server environment."
          : "";
      throw new Error(`GitHub responded with HTTP ${response.status} for ${ref.owner}/${ref.repo}#${ref.number}.${hint}`);
    }
    return response.json();
  };

  const issue: Json = await get(base);

  const totalComments: number = issue.comments ?? 0;
  let comments: Json[] = [];
  if (totalComments > 0) {
    const lastPage = Math.ceil(totalComments / PAGE_SIZE);
    comments = await get(`${base}/comments?per_page=${PAGE_SIZE}&page=${lastPage}`);
    if (comments.length < MAX_COMMENTS && lastPage > 1) {
      comments = [...(await get(`${base}/comments?per_page=${PAGE_SIZE}&page=${lastPage - 1}`)), ...comments];
    }
  }

  // The timeline is best-effort: it only adds linked issues/PRs and must not break the prompt.
  let timeline: Json[] = [];
  try {
    timeline = await get(`${base}/timeline?per_page=${PAGE_SIZE}`);
  } catch (error) {
    console.error(`[defect-mcp] GitHub timeline unavailable: ${(error as Error).message}`);
  }

  const links = new Map<string, Ticket["links"][number]>();
  for (const event of timeline) {
    const source = event.event === "cross-referenced" ? event.source?.issue : undefined;
    if (!source) continue;
    const key = `${source.repository?.full_name ?? `${ref.owner}/${ref.repo}`}#${source.number}`;
    const status = source.pull_request?.merged_at ? "merged" : source.state;
    links.set(key, {
      relation: source.pull_request ? "referenced by PR" : "referenced by issue",
      key,
      summary: source.title,
      status,
    });
  }

  const allLinks = [...links.values()];
  const state = issue.state_reason ? `${issue.state} (${issue.state_reason})` : issue.state;
  const description = truncate(issue.body);

  return {
    kind: "github",
    key: `${ref.owner}/${ref.repo}#${issue.number}`,
    url: issue.html_url,
    summary: issue.title ?? "",
    facts: [
      { label: "Kind", value: issue.pull_request ? "Pull request" : (issue.type?.name ?? "Issue") },
      { label: "State", value: state ?? "-" },
      { label: "Author", value: issue.user?.login ?? "-" },
      { label: "Assignees", value: joinOrDash((issue.assignees ?? []).map((a: Json) => a.login)) },
      { label: "Created", value: issue.created_at ?? "-" },
      { label: "Labels", value: joinOrDash((issue.labels ?? []).map((l: Json) => (typeof l === "string" ? l : l.name))) },
      { label: "Milestone", value: issue.milestone?.title ?? "-" },
    ],
    description,
    attachments: [...new Map([issue.body, ...comments.map((c) => c.body)].flatMap(extractAttachments).map((a) => [a.url, a])).values()],
    attachmentNote: "Embedded in the issue/comments; fetch them if your tools allow it, otherwise ask the user.",
    links: allLinks.slice(0, MAX_LINKS),
    omittedLinks: Math.max(0, allLinks.length - MAX_LINKS),
    comments: comments.slice(-MAX_COMMENTS).map((c: Json) => ({
      author: c.user?.login,
      created: c.created_at,
      body: truncate(c.body) ?? "",
    })),
    omittedComments: Math.max(0, totalComments - MAX_COMMENTS),
  };
}
