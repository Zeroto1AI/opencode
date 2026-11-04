#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { runReviews, type ReviewOptions } from "../lib/review"

export function parseReviewArgs(args: string[]): ReviewOptions | undefined {
  const { values } = parseArgs({
    args, strict: true, allowPositionals: false,
    options: {
      repo: { type: "string" }, pr: { type: "string" }, all: { type: "boolean" },
      directory: { type: "string" }, base: { type: "string" }, head: { type: "string" },
      model: { type: "string" }, output: { type: "string" },
      "include-drafts": { type: "boolean" }, force: { type: "boolean" },
      publish: { type: "boolean" }, help: { type: "boolean" },
    },
  })
  if (values.help) return undefined
  let repository = values.repo
  let pr: number | undefined
  if (values.pr) {
    const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/.exec(values.pr)
    if (url) {
      if (repository && repository !== url[1]) throw new Error("--repo disagrees with PR URL")
      repository = url[1]
      pr = Number(url[2])
    } else if (/^[1-9]\d*$/.test(values.pr)) pr = Number(values.pr)
    else throw new Error("--pr must be a positive number or a github.com PR URL")
    if (!Number.isSafeInteger(pr)) throw new Error("Invalid PR number")
  }
  const modes = Number(!!values.all) + Number(pr !== undefined) + Number(!!values.base)
  if (modes !== 1) throw new Error("Choose exactly one: --pr, --all, or --base")
  if ((pr || values.all) && !repository) throw new Error("GitHub reviews require --repo owner/name")
  if (values.head && !values.base) throw new Error("--head requires --base")
  if (values.base && repository) throw new Error("Local --base reviews use --directory, not --repo")
  return {
    directory: values.directory ?? process.cwd(), repository, pr, all: values.all,
    base: values.base, head: values.head, model: values.model, output: values.output,
    includeDrafts: values["include-drafts"], force: values.force, publish: values.publish,
  }
}

if (import.meta.main) {
  const abort = new AbortController()
  process.once("SIGINT", () => abort.abort())
  process.once("SIGTERM", () => abort.abort())
  try {
    const options = parseReviewArgs(process.argv.slice(2))
    if (!options) {
      console.log([
        "Usage:",
        "  bun scripts/review.ts --pr https://github.com/owner/repo/pull/123",
        "  bun scripts/review.ts --repo owner/repo --all",
        "  bun scripts/review.ts --directory /project --base main [--head HEAD]",
        "",
        "Options: --model sonnet --output DIR --include-drafts --force --publish",
        "Reports are saved locally by default. --publish explicitly posts a GitHub summary comment.",
        "Exit: 0 complete/deferred, 1 failed/partial/stale, 2 complete with P0/P1 findings.",
      ].join("\n"))
    } else {
      const results = await runReviews({ ...options, signal: abort.signal })
      for (const { report, file, cached } of results) {
        console.log((report.pr ? "PR #" + report.pr : "Local range") + ": " + report.status + (cached ? " (cached)" : "") + " — " + file)
      }
      process.exitCode = results.some(r => ["failed", "partial", "stale"].includes(r.report.status)) ? 1 :
        results.some(r => r.report.findings.some(f => f.severity === "P0" || f.severity === "P1")) ? 2 : 0
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
