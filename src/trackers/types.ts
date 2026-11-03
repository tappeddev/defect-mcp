export type TrackerKind = "jira" | "github";

export type TicketRef =
  | { kind: "jira"; key: string; baseUrl?: string }
  | { kind: "github"; owner: string; repo: string; number: number; apiUrl?: string };

export interface Ticket {
  kind: TrackerKind;
  key: string;
  url: string;
  summary: string;
  /** Tracker-specific facts rendered as "label: value" lines. */
  facts: { label: string; value: string }[];
  environment?: string;
  description?: string;
  attachments: { name: string; url: string; mimeType?: string }[];
  links: { relation: string; key: string; summary?: string; status?: string }[];
  comments: { author?: string; created?: string; body: string }[];
  /** Comments omitted because of MAX_COMMENTS. */
  omittedComments: number;
  /** Links omitted because of MAX_LINKS. */
  omittedLinks?: number;
  attachmentNote?: string;
}

export const ATTACHMENT_NOTE =
  "Download the relevant ones with the defect `get_attachment` tool (it has the credentials; never call the tracker API yourself). " +
  "Screenshots and logs often settle the verdict.";

export const MAX_COMMENTS = 20;
export const MAX_LINKS = 15;
const MAX_TEXT_LENGTH = 12_000;

export function truncate(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  if (text.length <= MAX_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_TEXT_LENGTH)}\n… [truncated, ${text.length - MAX_TEXT_LENGTH} more characters]`;
}

export function joinOrDash(values: (string | undefined)[]): string {
  const present = values.filter((v): v is string => Boolean(v));
  return present.length ? present.join(", ") : "-";
}

export function describeRef(ref: TicketRef): string {
  return ref.kind === "jira" ? ref.key : `${ref.owner}/${ref.repo}#${ref.number}`;
}
