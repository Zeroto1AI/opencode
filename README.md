# opencode config -- Manager / CLI Agents

Quickly load this configuration into any project by cloning the repo into `.opencode/` at the project root. Opencode reads `opencode.json` from that directory, so no additional setup is needed.

This config sets up a primary **Manager** agent (runs on the model selected for the session — never the local model), a **Review** agent, the `qwen` local subagent, three external CLI coding-agent plugins (Claude Code, Codex, Antigravity), and a self-contained pitlane-mcp code-graph server.

## Runtime

This project is written in TypeScript and uses [Bun](https://bun.sh) as its runtime. The runtime dependencies are:

- `@opencode/plugin` -- opencode's v2 plugin SDK (provides `Plugin.define` / `ctx.tool.transform` used to register CLI agents).
- `bun:sqlite` -- Bun's built-in SQLite binding, used by `lib/save-output.ts` to look up session titles.
- Node.js stdlib (`node:path`, `node:fs`) for file I/O and path handling.

## Provider / Model

The **Manager** (default agent) runs on whichever model is selected for the session (e.g. an opencode cloud model). The local model is reserved for the `qwen` subagent.

Three OpenAI-compatible endpoints exist across two hosts — each server loads only one model at a time, and the hosts are independent and can serve concurrently:

- provider `unsloth` — `http://proart-px13.local:1234/v1/`: Qwen 3.8 27B (tool calling, reasoning, image input; 262,144-token loaded context / 262,144 max). Used by `qwen`.

## Agents

| Agent | Mode | Role |
| --- | --- | --- |
| `Manager` (default) | primary | Entry point for all work. Runs on the session model (not the local model). Leads research and analysis, manages multi-step tasks, decides when to delegate to CLI agents or the local subagent. |
| `Review` | all | Reviews a PR, all open PRs, or a local committed range. Uses restricted snapshots and independent verification; saves Markdown and JSON reports without changing source. |
| `qwen` | subagent | Qwen 3.8 27B — bounded mechanical edits, long-context tasks, and local MCP use. |

Agent prompts live in `.opencode/agents/`, where OpenCode discovers project agents. This includes Manager, Review, and qwen. The Manager prompt contains the model references for the external CLI agents.

### Pull request reviews

The `Review` agent can review one PR, all open PRs in a selected GitHub repository, or a local committed range. Each run saves a Markdown report and a JSON record with verified findings, source references, CI context, and coverage gaps. Manager delegates code-review requests to this restricted, read-only workflow.

See [docs/review.md](docs/review.md) for usage, permissions, reporting, and optional GitHub Actions automation. Scheduled automation is off until repository administrators configure GitHub variables and an Anthropic secret.

## Plugins (CLI agents)

One opencode v2 plugin (`plugins/cli-agents/`, id `cli-agents`) registers three external coding agents as tools:

| Tool | CLI binary | Description |
| --- | --- | --- |
| `cli-claude` | `claude` | Anthropic Claude Code. Accepts `prompt`, optional `model`, and `effort` (`low`/`medium`/`high`/`xhigh`/`max`). |
| `cli-codex` | `codex` | OpenAI Codex CLI. Accepts `prompt` and optional `model`. Runs non-interactively with `--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral`. |
| `cli-antigravity` | `agy` | Google Antigravity (`agy`). Accepts `prompt` and optional `model`. Reasoning effort is encoded in the model ID suffix (e.g. `gemini-3.7-flash-high`); there is no separate effort arg. |

All three plugins run the external CLI non-interactively in the current workspace directory, pipe the task as stdin or a `--print` argument, and save their output via `lib/save-output.ts`.

The separate `plugins/review/` plugin registers the restricted `review` tool used by the Review agent. Its implementation is in `lib/review/`; see [docs/review.md](docs/review.md).

## Codebase graph (pitlane MCP)

`mcp/` contains a self-contained [pitlane-mcp](https://github.com/eresende/pitlane-mcp) setup — a local tree-sitter graph of the project exposed as MCP tools (`pitlane_investigate`, `pitlane_locate_code`, `pitlane_read_code_unit`, `pitlane_trace_path`, `pitlane_analyze_impact`, ...). It is registered for:

- **opencode** — `mcp.pitlane` in `opencode.json` (available to Manager and `qwen`)
- **Claude Code** — `--mcp-config` in the `cli-claude` plugin
- **Codex** — run-scoped `-c` override in the `cli-codex` plugin
- **Antigravity** — registered via the `agy` discovery wrapper installed by `mcp/setup.sh` (see `plugins/cli-agents/index.ts`).

Everything lives inside `.opencode/mcp/` — no global `~/.claude.json` / `~/.codex/config.toml` changes. Run `.opencode/mcp/setup.sh` once per machine: it installs the shared binaries to `~/.local/bin/` (no per-project download) and indexes the project. See `mcp/README.md` for details.

## Library modules

| File | Purpose |
| --- | --- |
| `lib/run-cli.ts` | Spawns arbitrary shell commands via `Bun.spawn`, captures stdout/stderr/exit code. Used as the execution backbone for every CLI agent plugin. |
| `lib/save-output.ts` | Runs a CLI command and writes its output (along with prompt, session title, timestamp) to a Markdown file under `outputs/<session-folder>/`. Looks up the human-readable session title from opencode's SQLite database (`opencode.db`). Throws if the process exits non-zero. |

## Directory structure

```tree
.
├── .opencode/agents/ # OpenCode-discovered agent prompts
│   ├── Manager.md    # Primary orchestrator agent prompt
│   ├── Review.md     # Restricted PR and commit-range reviewer
│   └── qwen.md       # Local subagent prompt (Qwen 3.8 27B)
├── lib/              # Shared TypeScript utilities (Bun runtime)
│   ├── run-cli.ts    # Shell command runner via Bun.spawn
│   ├── save-output.ts  # CLI output capture and Markdown file writer
│   └── unsloth.ts    # Unsloth UI Backend HTTP client + run/event helpers
├── mcp/              # Self-contained pitlane-mcp code-graph setup
│   ├── pitlane-mcp-wrapper.py  # discovery-aware stdio relay (installed as pitlane-mcp)
│   ├── pitlane.json  # MCP server def for claude --mcp-config
│   ├── setup.sh      # idempotent install / index / verify / uninstall
│   └── README.md
├── plugins/          # v2 plugin entry points (auto-discovered)
│   └── cli-agents/index.ts  # registers cli-claude / cli-codex / cli-antigravity tools
├── outputs/          # Saved tool runs (Markdown, keyed by session)
├── .gitignore
├── opencode.json     # opencode configuration: provider, plugins, agents
└── README.md
```

## Configuration file

`opencode.json` is the sole opencode config. It declares:

- The `$schema` URL for validation.
- `default_agent`: `"Manager"`.
- `provider.unsloth`: the local model provider (Qwen 3.8 27B), used **only** by the `qwen` subagent (npm package `@ai-sdk/openai-compatible`, local base URL, API key, and per-model capabilities/limits). The Manager never runs on this model.
- `mcp.pitlane`: the local pitlane-mcp code-graph server (shared `pitlane-mcp` binary in `~/.local/bin`, resolved via PATH — see `mcp/README.md`).
- `agent`: agents are defined as markdown files in `.opencode/agents/` — `Manager` with mode `primary`, `Review`, and `qwen`. The CLI agent tools (`cli-claude`, `cli-codex`, `cli-antigravity`) are registered by `plugins/cli-agents/`.

## Saving output

When a CLI agent runs, its stdout/stderr is written to `outputs/<sanitized-session-title>/<tool-name>-<ISO-timestamp>.md`. Each file contains the session title/ID, tool name, timestamp, the original prompt, and the captured output. The Manager agent verifies delegated work before presenting results -- it should not delegate merely to avoid doing necessary synthesis itself (see `.opencode/agents/Manager.md`).
