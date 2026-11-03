# defect-mcp

MCP server that provides prompts for triaging and fixing defects reported during testing.

## Prompts

### `fix` — Find & fix defect

Arguments:

| Argument | Required | Example |
| --- | --- | --- |
| `ticket` | yes | see the table below |
| `notes` | no | `"only on staging, app 2.4.1"` |

Supported ticket references:

| Input | Tracker |
| --- | --- |
| `PROJ-123`, `proj-123` | Jira |
| `https://jira.example.com/browse/PROJ-123` | Jira |
| `https://github.com/owner/repo/issues/123` (also `/pull/123`, GitHub Enterprise URLs) | GitHub |
| `owner/repo#123` | GitHub |
| `#123` or `123` | GitHub, requires `trackers.github.defaultRepo` |

The server loads the ticket (description, environment, attachments, linked issues/PRs, comments) and builds a prompt that makes the agent:

1. **Locate** the defect: app, backend, both, shared library or unclear, with evidence and confidence.
2. **Report**: explanation, analysis (root cause with `file:line`), proposed fix incl. tests and risks, open questions.
3. **Stop** and ask for approval. Phases 1 and 2 are read-only.
4. **Implement** only after explicit approval.

## Setup

Requires Node.js ≥ 20.

```sh
git clone https://github.com/tappeddev/defect-mcp.git && cd defect-mcp
npm install
npm run build
cp .env.example .env                                   # add your tokens
cp defect-mcp.config.example.json defect-mcp.config.json  # adjust sources
```

### Configuration

`defect-mcp.config.json` (git-ignored, one per developer):

```json
{
  "trackers": {
    "jira": { "url": "https://jira.example.com" },
    "github": { "apiUrl": "https://api.github.com", "defaultRepo": "owner/repo" }
  },
  "gitlab": { "url": "https://gitlab.example.com" },
  "sources": [
    { "name": "new_portal", "role": "app", "path": "../new_portal", "description": "Flutter web portal" },
    { "name": "api-server", "role": "backend", "path": "../api-server", "ref": "main",
      "remote": "my-group/backend/api-server" },
    { "name": "mail-service", "role": "backend", "remote": "my-group/backend/mail-service", "ref": "master" }
  ],
  "instructions": ["Optional extra rules for the agent"]
}
```

The config file is resolved from `--config <path>`, then `DEFECT_MCP_CONFIG`, then `~/.config/defect-mcp/config.json`. It is re-read on every prompt call, so edits apply immediately.

### Sources

Each source needs `path`, `remote`, or both:

| Field | Description |
| --- | --- |
| `name` | Unique name; also used as the mirror directory name. |
| `role` | `app`, `backend`, `library` or `other`. |
| `description` | Optional; helps the agent decide where to look. |
| `path` | Local working copy: absolute, `~/…`, or relative to the config file. |
| `remote` | GitLab project path (`group/sub/project`, requires `gitlab.url`) or a full clone URL (`https://…` / `git@…`). |
| `ref` | Optional branch, tag or commit that was tested, e.g. `develop` or `release/1.4`. |

How a source is used:

| Configured | Analysis (phases 1–2) | Fix (phase 3) |
| --- | --- | --- |
| `path` exists | Local working copy. With `ref`, the server fetches `origin/<ref>` and tells the agent to analyse that version if the working copy differs (e.g. you are on a feature branch). | In the working copy; the agent asks which branch to base the fix on if it is not on `ref`. |
| `path` missing or not set, `remote` set | Read-only mirror in the cache, checked out at `ref` (or the default branch). | The agent asks you to clone the repository first. |
| neither available | Skipped; the agent mentions it. | – |

This lets a shared config contain `path` **and** `remote`: developers who have the repository checked out use their working copy, everybody else gets the mirror automatically.

Mirrors:

- Stored in `gitlab.cacheDir` (default `~/.cache/defect-mcp/repos/<name>`) as full clones, so `git log`/`git blame` work.
- Synced in the background when the server starts and refreshed on prompt calls (at most every 5 minutes). A prompt call waits up to `gitlab.syncTimeoutSeconds` (default 60) for a running sync; the first clone of a large repository can take longer, so pre-fill the cache once after setup:

  ```sh
  node --env-file=.env dist/index.js sync --config defect-mcp.config.json
  ```

- Authentication: if `GITLAB_TOKEN` is set, it is sent only to the host of `gitlab.url` and never written to `.git/config`. Without it, your normal git credentials (keychain, credential helper, SSH key) are used; they must work without an interactive prompt.

### Trackers

Configure **at least one** tracker; the others are optional. An empty object (`"github": {}`) is enough to enable a tracker with its defaults. References to a tracker that is not configured are rejected with a clear message.

- `trackers.jira.url`: Jira base URL. Can be overridden with `JIRA_URL`.
- `trackers.github.apiUrl`: GitHub API URL; defaults to `https://api.github.com`. For GitHub Enterprise Server use `https://<host>/api/v3`. For full GitHub URLs the API URL is derived from the URL's host.
- `trackers.github.defaultRepo`: `owner/repo` used for `#123` references.

Credentials come from the environment, never from the config:

| Variable | Needed for |
| --- | --- |
| `JIRA_PERSONAL_TOKEN` | Jira (Personal Access Token), only if `trackers.jira` is configured |
| `GITHUB_TOKEN` (or `GH_TOKEN`) | Private GitHub repositories; recommended in general to avoid the low anonymous rate limit. A fine-grained token with read access to *Issues* is enough. |
| `GITLAB_TOKEN` | Optional: mirroring `remote` sources from GitLab (scope `read_repository`) if your git credentials do not already work. |

The easiest way to provide them is `node --env-file=<path>/.env` as shown below. If a ticket cannot be loaded, the prompt tells the agent to fetch it in another way or to ask you for the details.

## Use it in your tool

Replace `/ABS/PATH` with the absolute path of this repository.

### OpenCode

```sh
opencode mcp add defect --global -- node --env-file=/ABS/PATH/.env /ABS/PATH/dist/index.js --config /ABS/PATH/defect-mcp.config.json
```

Usage: `/defect:fix PROJ-123` or `/defect:fix owner/repo#123`

### Claude Code

```sh
claude mcp add defect --scope user -- node --env-file=/ABS/PATH/.env /ABS/PATH/dist/index.js --config /ABS/PATH/defect-mcp.config.json
```

Usage: `/mcp__defect__fix PROJ-123`

### VS Code (GitHub Copilot, agent mode)

`.vscode/mcp.json` or the user-level MCP configuration:

```json
{
  "servers": {
    "defect": {
      "type": "stdio",
      "command": "node",
      "args": ["--env-file=/ABS/PATH/.env", "/ABS/PATH/dist/index.js", "--config", "/ABS/PATH/defect-mcp.config.json"]
    }
  }
}
```

Usage: `/mcp.defect.fix`

### Cursor and other MCP clients

`~/.cursor/mcp.json` (other clients use the same `mcpServers` format):

```json
{
  "mcpServers": {
    "defect": {
      "command": "node",
      "args": ["--env-file=/ABS/PATH/.env", "/ABS/PATH/dist/index.js", "--config", "/ABS/PATH/defect-mcp.config.json"]
    }
  }
}
```

Prompt support differs between clients; check your client's MCP prompt / slash command documentation.

## Development

```sh
npm run dev       # run from source
npm run inspect   # open the MCP Inspector
npm run build     # compile to dist/
```

Add a new prompt by creating a builder in `src/prompts/` and registering it in `src/index.ts` with `server.registerPrompt`.
