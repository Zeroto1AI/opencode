# Pull request review agent

The Review agent handles one GitHub PR, all currently open PRs in a repository, or a local committed range. It writes a Markdown report and a JSON record for every result. Manager delegates reviews to it.

## Run a review

Use the OpenCode Review agent, or run the CLI from this repository:

```sh
# Review a single PR (a GitHub token with repository pull-request read access is needed)
GH_TOKEN="$(gh auth token)" bun scripts/review.ts --pr https://github.com/owner/repo/pull/123

# Review every open PR, including dependency/bot PRs. Drafts are recorded as deferred.
GH_TOKEN="$(gh auth token)" bun scripts/review.ts --repo owner/repo --all

# Include drafts, request another pass for the same revision, or select a Claude model.
bun scripts/review.ts --repo owner/repo --pr 123 --include-drafts --force --model sonnet

# Review committed local changes. This never includes uncommitted or staged changes.
bun scripts/review.ts --directory /path/to/project --base main [--head HEAD]

# Post a final review summary as a GitHub issue comment (explicit opt-in).
bun scripts/review.ts --repo owner/repo --pr 123 --publish
```

Reports go to `outputs/reviews/` by default. Use `--output DIR` to select another local directory. Batch runs additionally write `index.md` and `index.json`. Exit status is 0 for complete or deferred reviews, 1 for failed, partial, or stale reviews, and 2 when a complete review contains P0/P1 findings. A report is advisory and does not approve, block, or merge a PR.

## Local credentials

Install and authenticate the Claude Code CLI. Confirm its version supports `--safe-mode`, `--restricted`, and `--json-schema`; the runner checks these flags before reviewing. Authentication uses `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. GitHub reviews additionally need `GH_TOKEN` or `GITHUB_TOKEN` with read access. Publishing needs write access to PR issue comments.

The reviewed source, diff, and PR context are sent to Anthropic through the configured Claude account for both model passes. Confirm that your organization's data policy permits this before using the agent on private repositories or enabling the workflow.

The reviewer CLI is launched in restricted mode with only file read/search tools and a custom review prompt. It receives a temporary snapshot of the merge base and PR head; it does not check out or execute PR code. The snapshot excludes common credential files, dependencies, symlinks, submodules, binary files, unsafe paths, files over 256 KB, and repositories beyond the 4,000-file / 40 MB limits. Exclusions appear in report coverage gaps and prevent a clean verdict.

The reviewer runs an initial pass and a separate verification pass. Findings must identify a concrete trigger, evidence, impact, a changed file and valid source line, and a small fix. The runner rejects invalid paths and line references, deduplicates findings, and never retains candidates as verified findings if verification fails. A review with gaps is marked partial; provider, snapshot, and metadata errors are saved as failed reports.

Repository code and PR metadata are untrusted input. The Claude process inherits only selected authentication and runtime environment values, starts with customization files, plugins, skills, MCP servers, sessions, and browser support disabled, and has no shell or write tools.

Tests and build commands from a PR are deliberately not run. CI results are captured from GitHub when available; source-based review is not represented as a test run. The GitHub comment is posted only with the explicit `--publish` flag and after the reviewed base and head SHAs are rechecked. Reports are idempotent for a repository, PR, base, head, model, and reviewer version. Use `--force` to rerun an existing revision.

## Scheduled GitHub Actions reports

`.github/workflows/review.yml` runs for PR open, update, reopen, and ready events, and scans for missed events weekly. It reviews one PR for pull-request events and dispatches all open PRs on schedule or manual run. The workflow uses `pull_request_target` to fetch Git objects without checking out contributor code, grants only contents and pull-request read permissions, serializes batch work, and uploads reports as a 14-day artifact.

It is off by default. To enable it in GitHub Actions repository variables, set:

- `REVIEW_ENABLED=true`
- `REVIEW_CLAUDE_VERSION` to an exact, tested Claude Code npm version
- Optionally, `REVIEW_MODEL` (default `sonnet`)

Add either `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` as a repository secret. The workflow's `GITHUB_TOKEN` only needs read access. It does not publish PR comments.

The workflow pins `actions/checkout`, `oven-sh/setup-bun`, and `actions/upload-artifact` to full commit SHAs. Review the npm install source and use GitHub organization policy to restrict allowed actions. The schedule, model usage, artifact retention, GitHub token access, and Anthropic secret are controlled by repository administrators.

Reports are workflow artifacts, not commits on a report branch. They expire after 14 days. Runs can take up to two hours and batch reviews run serially to limit model usage. If authentication, checkout, GitHub API access, or report upload fails, inspect the workflow run; a missing or failed run is never a clean review.
