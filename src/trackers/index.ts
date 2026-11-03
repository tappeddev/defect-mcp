import type { Config } from "../config.js";
import { fetchGitHubIssue, githubApiUrlForHost } from "./github.js";
import { fetchJiraTicket } from "./jira.js";
import type { Ticket, TicketRef } from "./types.js";

export { describeRef, type Ticket, type TicketRef } from "./types.js";

const GITHUB_URL_PATH = /^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/;
const GITHUB_SHORT_REF = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;
const GITHUB_NUMBER_ONLY = /^#?(\d+)$/;
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const JIRA_KEY_IN_TEXT = /([A-Z][A-Z0-9]+-\d+)/;

function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid GitHub repository "${fullName}", expected "owner/repo".`);
  return { owner, repo };
}

const TRACKER_LABELS: Record<TicketRef["kind"], string> = { jira: "Jira", github: "GitHub" };

function supportedFormats(config: Config): string {
  const formats: string[] = [];
  if (config.trackers.jira) formats.push("a Jira key (PROJ-1234)", "a Jira browse URL");
  if (config.trackers.github) {
    formats.push("a GitHub issue URL", "owner/repo#123");
    if (config.trackers.github.defaultRepo) formats.push("#123");
  }
  return formats.join(", ");
}

export function parseTicketRef(input: string, config: Config): TicketRef {
  const ref = detectTicketRef(input, config);
  if (!ref) {
    throw new Error(`"${input}" is not a supported ticket reference. Use ${supportedFormats(config)}.`);
  }
  if (!config.trackers[ref.kind]) {
    throw new Error(
      `"${input}" looks like a ${TRACKER_LABELS[ref.kind]} ticket, but ${TRACKER_LABELS[ref.kind]} is not configured ` +
        `(add trackers.${ref.kind} to ${config.configPath}). Supported here: ${supportedFormats(config)}.`,
    );
  }
  return ref;
}

function detectTicketRef(input: string, config: Config): TicketRef | undefined {
  const trimmed = input.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);

    const github = url.pathname.match(GITHUB_URL_PATH);
    if (github) {
      return {
        kind: "github",
        owner: github[1],
        repo: github[2],
        number: Number(github[3]),
        apiUrl: githubApiUrlForHost(url.origin),
      };
    }

    const jiraKey = url.pathname.toUpperCase().match(JIRA_KEY_IN_TEXT) ?? url.search.toUpperCase().match(JIRA_KEY_IN_TEXT);
    if (jiraKey) {
      const browseIndex = url.pathname.indexOf("/browse/");
      const contextPath = browseIndex > 0 ? url.pathname.slice(0, browseIndex) : "";
      return { kind: "jira", key: jiraKey[1], baseUrl: `${url.origin}${contextPath}` };
    }

    return undefined;
  }

  const short = trimmed.match(GITHUB_SHORT_REF);
  if (short) return { kind: "github", owner: short[1], repo: short[2], number: Number(short[3]) };

  const numberOnly = trimmed.match(GITHUB_NUMBER_ONLY);
  const defaultRepo = config.trackers.github?.defaultRepo;
  if (numberOnly && defaultRepo) return { kind: "github", ...splitRepo(defaultRepo), number: Number(numberOnly[1]) };

  if (JIRA_KEY.test(trimmed.toUpperCase())) return { kind: "jira", key: trimmed.toUpperCase() };

  return undefined;
}

export function fetchTicket(ref: TicketRef, config: Config): Promise<Ticket> {
  return ref.kind === "jira"
    ? fetchJiraTicket(ref, config.trackers.jira?.url)
    : fetchGitHubIssue(ref, config.trackers.github?.apiUrl);
}
