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

The prompt only inserts a one-line instruction into the chat. The agent then calls the server's `get_context` tool, which loads the ticket (description, environment, attachments, linked issues/PRs, comments), the state of the configured sources and the triage workflow. Tool results are usually shown collapsed, so the chat stays clean. The agent can also call the tool without the prompt, e.g. when you just write "look at PROJ-123".

Attachments (screenshots, logs, PDFs) are downloaded with the `get_attachment` tool, which uses the server's credentials and only talks to the configured trackers. Files are saved under `~/.cache/defect-mcp/attachments/`; text files are returned inline, images are opened by the agent with its file-reading tool (or returned inline with `inline: true`).

The workflow makes the agent:

1. **Locate** the defect: app, backend, both, shared library or unclear, with evidence and confidence.
2. **Report** briefly: verdict, what happens, root cause with `file:line`, fix incl. tests, open questions.
3. **Stop** and ask for approval. Phases 1 and 2 are read-only.
4. **Implement** only after explicit approval.

## Setup

Requires Node.js ≥ 20.12 and git. Nothing needs to be cloned or built by hand: the tools start the server with `npx`, which installs and builds it from GitHub on first use.

### Once per project (checked in)

1. Add a `.defect-mcp.json` to the project root (see [Configuration](#configuration) and `defect-mcp.config.example.json`).
2. Add the server to the project configuration of each tool your team uses (see [Use it in your tool](#use-it-in-your-tool)). The entries contain no personal paths, so they can be committed.

### Once per developer

Put your tokens into `~/.config/defect-mcp/.env` (see `.env.example`):

```sh
mkdir -p ~/.config/defect-mcp
cat > ~/.config/defect-mcp/.env <<'ENV'
JIRA_PERSONAL_TOKEN=<your token>
ENV
```

Optional: pre-fill the mirror cache for `remote` sources you do not have checked out (run in the project root):

```sh
npx -y github:tappeddev/defect-mcp#v0.4.0 sync
```

### Configuration

`.defect-mcp.json` in the project root, committed with the project:

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

The config is resolved from `--config <path>`, then `DEFECT_MCP_CONFIG`, otherwise `.defect-mcp.json` is searched from the server's working directory upwards and then in the client's workspace roots. If none is found, the prompt fails with an error explaining how to add one. It is re-read on every prompt call, so edits apply immediately.

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
  npx -y github:tappeddev/defect-mcp#v0.4.0 sync   # in the project root
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

The server loads `~/.config/defect-mcp/.env` (or the file in `DEFECT_MCP_ENV_FILE`) automatically; variables already set in the environment take precedence. If a token is missing or a ticket cannot be loaded, the prompt says so and tells the agent to fetch it in another way or to ask you for the details.

## Use it in your tool

Add these files to the project. Pin the version (`#v0.4.0`) and bump it to roll out updates to the whole team.

### OpenCode

`opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "defect": {
        "type": "local",
        "command": ["npx", "-y", "github:tappeddev/defect-mcp#v0.4.0"],
        "timeout": { "startup": 180000 }
      }
    }
  }
}
```

The higher startup timeout covers the first start, when `npx` installs and builds the server.

Usage: `/defect:fix PROJ-123` or `/defect:fix owner/repo#123`

### Claude Code

`.mcp.json`:

```json
{
  "mcpServers": {
    "defect": { "command": "npx", "args": ["-y", "github:tappeddev/defect-mcp#v0.4.0"] }
  }
}
```

Usage: `/mcp__defect__fix PROJ-123`

### VS Code (GitHub Copilot, agent mode)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "defect": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:tappeddev/defect-mcp#v0.4.0", "--config", "${workspaceFolder}/.defect-mcp.json"]
    }
  }
}
```

Usage: `/mcp.defect.fix`

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "defect": {
      "command": "npx",
      "args": ["-y", "github:tappeddev/defect-mcp#v0.4.0", "--config", "${workspaceFolder}/.defect-mcp.json"]
    }
  }
}
```

Prompt support differs between clients; check your client's MCP prompt / slash command documentation.

## Development

```sh
git clone https://github.com/tappeddev/defect-mcp.git && cd defect-mcp
npm install       # also builds dist/ via the prepare script
npm run dev       # run from source
npm run inspect   # open the MCP Inspector
npm run build     # compile to dist/
```

To test a local checkout in a project, point the tool at it instead of `npx`, e.g. `["node", "/path/to/defect-mcp/dist/index.js"]`.

Releasing: bump `version` in `package.json` and the server version in `src/index.ts`, commit, tag `vX.Y.Z`, push the tag, then update the pinned version in the projects.

Add a new prompt by creating a builder in `src/prompts/` and registering it in `src/index.ts` with `server.registerPrompt`.
