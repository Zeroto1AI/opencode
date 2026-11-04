import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { checkClaude, reviewWithClaude, type Reviewer } from "./claude"
import { command, getPull, listPulls, localRevisions, snapshot, validateRepo, type Command, type Snapshot } from "./source"
import { REVIEW_VERSION, atomicWrite, deduplicate, findingKey, renderReport, reportKey, saveReport, validateAssessment, type Report } from "./report"

export type ReviewOptions = {
  directory: string
  repository?: string
  pr?: number
  all?: boolean
  base?: string
  head?: string
  model?: string
  output?: string
  includeDrafts?: boolean
  force?: boolean
  publish?: boolean
  signal?: AbortSignal
}
export type ReviewResult = { report: Report; file: string; cached: boolean }
type Dependencies = { run?: Command; reviewer?: Reviewer }

async function previousReport(output: string, repository: string, pr: number | undefined): Promise<Report | undefined> {
  const reports: Report[] = []
  for (const name of await readdir(output).catch(() => [] as string[])) {
    if (!/^[a-f0-9]{24}\.json$/.test(name)) continue
    try {
      const r = JSON.parse(await readFile(path.join(output, name), "utf8")) as Report
      if (r.repository === repository && r.pr === pr && ["complete", "partial"].includes(r.status)) reports.push(r)
    } catch { /* An interrupted or externally edited artifact is not review evidence. */ }
  }
  return reports.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
}

export async function publishReport(report: Report, directory: string, run = command, signal?: AbortSignal): Promise<void> {
  if (!report.pr || !["complete", "partial"].includes(report.status)) throw new Error("Only current, completed PR assessments can be published")
  const current = await getPull(report.repository, report.pr, directory, run, signal)
  if (current.state !== "OPEN" || current.baseRefOid !== report.base || current.headRefOid !== report.head) throw new Error("PR changed before publication; rerun the review")
  const marker = "<!-- opencode-review:" + report.id + " -->"
  const comments = JSON.parse(await run("gh", ["api", "--paginate", "--slurp", "repos/" + report.repository + "/issues/" + report.pr + "/comments?per_page=100"], directory, signal)).flat()
  if (comments.some((c: { body?: string }) => c.body?.includes(marker))) return
  const body = marker + "\n" + renderReport(report)
  // GitHub limits comment size; never silently truncate the findings.
  if (body.length > 60_000) throw new Error("Report exceeds GitHub comment limit; use the saved report")
  const temp = path.join(directory, ".review-comment-" + crypto.randomUUID() + ".json")
  try {
    await writeFile(temp, JSON.stringify({ body }), { mode: 0o600 })
    await run("gh", ["api", "--method", "POST", "repos/" + report.repository + "/issues/" + report.pr + "/comments", "--input", temp], directory, signal)
  } finally {
    await rm(temp, { force: true })
  }
}

export async function reviewOne(options: ReviewOptions, dependencies: Dependencies = {}): Promise<ReviewResult> {
  const run = dependencies.run ?? command
  const reviewer = dependencies.reviewer ?? reviewWithClaude
  const output = path.resolve(options.output ?? path.join(import.meta.dir, "../../outputs/reviews"))
  const model = options.model ?? "sonnet"
  const started = Date.now()
  const repository = options.repository ? validateRepo(options.repository) : path.resolve(options.directory)
  const remote = options.pr !== undefined
  if (remote && !options.repository) throw new Error("PR review requires --repo owner/name")
  if (!remote && !options.base) throw new Error("Local review requires --base")
  if (options.publish && !remote) throw new Error("Publishing requires a GitHub PR")
  await mkdir(output, { recursive: true })
  let report: Report = {
    version: REVIEW_VERSION, id: crypto.randomUUID().replace(/-/g, "").slice(0, 24),
    repository, pr: options.pr, base: "", head: "", model, status: "failed", summary: "",
    findings: [], coverage: [], gaps: [],
    checks: ["Two independent source-inspection passes; repository code is never executed.",
      "Tests were not run by this reviewer. CI results, when available, are recorded in the report."],
    previous: [], startedAt: new Date(started).toISOString(), durationMs: 0,
  }
  let source: Snapshot | undefined
  let lock: string | undefined
  let ownsLock = false
  let cached = false
  try {
    const pr = remote ? await getPull(repository, options.pr!, options.directory, run, options.signal) : undefined
    const revisions = pr ? { base: pr.baseRefOid, head: pr.headRefOid } :
      await localRevisions(options.directory, options.base!, options.head ?? "HEAD", run, options.signal)
    report = { ...report, ...revisions, url: pr?.url, id: reportKey(repository, options.pr, revisions.base, revisions.head, model) }
    lock = path.join(output, report.id + ".lock")
    try { await mkdir(lock); ownsLock = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("This revision is already being reviewed; retry after it finishes")
      throw error
    }
    if (pr && (pr.state !== "OPEN" || (pr.isDraft && !options.includeDrafts))) {
      report.status = "deferred"
      report.summary = pr.isDraft ? "Draft PR deferred until ready; use --include-drafts to review now." : "PR is no longer open."
    } else {
      let saved: Report | undefined
      try { saved = JSON.parse(await readFile(path.join(output, report.id + ".json"), "utf8")) } catch { /* No reusable report. */ }
      if (!options.force && saved?.status === "complete" && saved.id === report.id && saved.version === REVIEW_VERSION) {
        report = saved
        cached = true
      } else {
        const previous = await previousReport(output, repository, options.pr)
        if (!dependencies.reviewer) await checkClaude(options.signal)
        source = await snapshot({
          repository, local: remote ? undefined : path.resolve(options.directory), ...revisions,
          headRef: pr ? "refs/pull/" + pr.number + "/head" : undefined, signal: options.signal,
        }, run)
        report.mergeBase = source.mergeBase
        const ci = pr?.statusCheckRollup ?? []
        report.checks.push("GitHub CI snapshot: " + JSON.stringify(ci))
        await writeFile(path.join(source.root, "context.json"), JSON.stringify({
          repository, pr, revisions, instruction: "Inspect the change and affected behavior; report only verified, actionable defects.",
          requirementsLimit: "Only the PR description is supplied; linked issue contents are not automatically fetched. State missing requirements when material.",
        }, null, 2))
        const first = validateAssessment(await reviewer({ workspace: source.root, model, phase: "review", signal: options.signal }), source.files, source.changed)
        await writeFile(path.join(source.root, "candidates.json"), JSON.stringify(first, null, 2))
        const verified = validateAssessment(await reviewer({ workspace: source.root, model, phase: "verify", signal: options.signal }), source.files, source.changed)
        report.findings = deduplicate(verified.findings)
        report.summary = verified.summary
        report.coverage = [...new Set(verified.reviewedFiles)]
        const unreviewed = [...source.changed].filter(file => !report.coverage.includes(file))
        report.gaps = [...new Set([...source.gaps, ...first.gaps, ...verified.gaps,
          ...unreviewed.map(file => "Changed file not fully reviewed: " + file)])]
        report.status = report.gaps.length ? "partial" : "complete"
        report.previous = (previous?.findings ?? []).map(f => ({
          title: f.title,
          state: report.findings.some(current => findingKey(current) === findingKey(f)) ? "persisting" :
            report.status === "complete" ? "not-redetected" : "unverified",
        }))
      }
      if (remote) {
        const current = await getPull(repository, options.pr!, options.directory, run, options.signal)
        if (current.state !== "OPEN" || current.baseRefOid !== report.base || current.headRefOid !== report.head) {
          report.status = "stale"
          report.gaps.push("PR changed or closed while the review was running; rerun before relying on this report.")
          cached = false
        }
      }
    }
  } catch (error) {
    report.status = "failed"
    report.summary = "Review did not finish. No clean verdict is available."
    report.gaps.push(error instanceof Error ? error.message : "Unknown review failure")
    // A competing run owns its report path; preserve both outcomes.
    if (lock && !ownsLock) report.id = crypto.randomUUID().replace(/-/g, "").slice(0, 24)
  } finally {
    await source?.cleanup()
  }
  try {
    if (!cached) report.durationMs = Date.now() - started
    const file = await saveReport(output, report)
    if (options.publish) {
      try { await publishReport(report, output, run, options.signal) } catch (error) {
        report.gaps.push("Publication failed: " + (error instanceof Error ? error.message : "unknown error"))
        if (report.status === "complete") report.status = "partial"
        await saveReport(output, report)
      }
    }
    return { report, file, cached }
  } finally {
    if (ownsLock && lock) await rm(lock, { recursive: true, force: true })
  }
}

export async function runReviews(options: ReviewOptions, dependencies: Dependencies = {}): Promise<ReviewResult[]> {
  if (!options.all) return [await reviewOne(options, dependencies)]
  if (!options.repository || options.pr || options.base || options.head) throw new Error("--all requires --repo and cannot be combined with --pr, --base, or --head")
  const output = path.resolve(options.output ?? path.join(import.meta.dir, "../../outputs/reviews"))
  const results: ReviewResult[] = []
  let discoveryError: string | undefined
  try {
    const numbers = await listPulls(options.repository, options.directory, dependencies.run, options.signal)
    // Serialized throughput bounds cost and avoids saturating subscription accounts.
    for (const pr of numbers) {
      if (options.signal?.aborted) { discoveryError = "Batch cancelled; remaining PRs were not reviewed."; break }
      results.push(await reviewOne({ ...options, all: false, pr }, dependencies))
    }
  } catch (error) {
    discoveryError = error instanceof Error ? error.message : "PR discovery failed"
  }
  const index = {
    repository: options.repository, generatedAt: new Date().toISOString(), error: discoveryError ?? null,
    results: results.map(r => ({ pr: r.report.pr, status: r.report.status, head: r.report.head, file: path.basename(r.file), cached: r.cached })),
  }
  await atomicWrite(path.join(output, "index.json"), JSON.stringify(index, null, 2) + "\n")
  await atomicWrite(path.join(output, "index.md"), ["# PR review batch", "",
    discoveryError ?? (results.length ? "Every discovered PR has an outcome below." : "No open PRs."),
    "", ...index.results.map(r => "- PR #" + r.pr + ": " + r.status + " — [" + r.head.slice(0, 12) + "](" + r.file + ")"), ""].join("\n"))
  if (discoveryError) throw new Error(discoveryError + " See " + path.join(output, "index.md"))
  return results
}
