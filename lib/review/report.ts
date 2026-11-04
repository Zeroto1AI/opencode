import { createHash } from "node:crypto"
import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"

export const REVIEW_VERSION = "1"
export type Finding = {
  severity: "P0" | "P1" | "P2" | "P3"
  title: string
  file: string
  side: "base" | "head"
  line: number
  trigger: string
  evidence: string
  impact: string
  fix: string
}
export type Assessment = {
  summary: string
  findings: Finding[]
  reviewedFiles: string[]
  gaps: string[]
}
export type Report = {
  version: string
  id: string
  repository: string
  pr?: number
  url?: string
  base: string
  head: string
  mergeBase?: string
  model: string
  status: "complete" | "partial" | "failed" | "stale" | "deferred"
  summary: string
  findings: Finding[]
  coverage: string[]
  gaps: string[]
  checks: string[]
  previous: { title: string; state: "persisting" | "not-redetected" | "unverified" }[]
  startedAt: string
  durationMs: number
}

const text = { type: "string", minLength: 1 }
export const assessmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings", "reviewedFiles", "gaps"],
  properties: {
    summary: text,
    reviewedFiles: { type: "array", items: text },
    gaps: { type: "array", items: text },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "file", "side", "line", "trigger", "evidence", "impact", "fix"],
        properties: {
          severity: { enum: ["P0", "P1", "P2", "P3"] },
          title: text, file: text, side: { enum: ["base", "head"] },
          line: { type: "integer", minimum: 1 },
          trigger: text, evidence: text, impact: text, fix: text,
        },
      },
    },
  },
}

export function safePath(value: string): boolean {
  return !!value && !path.posix.isAbsolute(value) && !value.includes("\\") &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    value.split("/").every(part => part !== ".." && part !== "." && part !== "")
}

export function validateAssessment(value: unknown, files: Map<string, string>, changed: Set<string>): Assessment {
  const a = value as Assessment
  if (!a || typeof a.summary !== "string" || !a.summary.trim() ||
      !Array.isArray(a.findings) || !Array.isArray(a.reviewedFiles) || !Array.isArray(a.gaps) ||
      !a.gaps.every(g => typeof g === "string" && g.trim()) ||
      !a.reviewedFiles.every(f => typeof f === "string" && changed.has(f))) {
    throw new Error("Invalid review assessment")
  }
  for (const f of a.findings) {
    if (!f || !["P0", "P1", "P2", "P3"].includes(f.severity) ||
        !["base", "head"].includes(f.side) ||
        !["title", "file", "trigger", "evidence", "impact", "fix"].every(
          key => typeof f[key as keyof Finding] === "string" && String(f[key as keyof Finding]).trim()) ||
        !safePath(f.file) || !changed.has(f.file) || !Number.isInteger(f.line) || f.line < 1) {
      throw new Error("Invalid finding")
    }
    const source = files.get(f.side + "/" + f.file)
    if (source === undefined || f.line > source.split("\n").length) {
      throw new Error("Finding references an unavailable source line")
    }
  }
  return a
}

export function findingKey(f: Finding): string {
  return [f.file, f.side, f.title.toLowerCase().replace(/[^a-z0-9]/g, "")].join(":")
}

export function deduplicate(findings: Finding[]): Finding[] {
  const unique = new Map<string, Finding>()
  for (const f of [...findings].sort((a, b) => a.severity.localeCompare(b.severity))) {
    if (!unique.has(findingKey(f))) unique.set(findingKey(f), f)
  }
  return [...unique.values()]
}

export function reportKey(repository: string, pr: number | undefined, base: string, head: string, model: string): string {
  return createHash("sha256").update(JSON.stringify([REVIEW_VERSION, repository, pr, base, head, model])).digest("hex").slice(0, 24)
}

// Model prose is data: suppress HTML and mentions before optional GitHub publication.
export function plain(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\\[\]*_!])/g, "\\$1").replace(/@/g, "@\u200b")
}

export function renderReport(r: Report): string {
  const verdict = r.status !== "complete" ? "Incomplete — no clean verdict." :
    r.findings.some(f => f.severity === "P0" || f.severity === "P1") ? "Changes needed." :
    "No verified blockers within the reviewed scope."
  return [
    "# PR review" + (r.pr ? " #" + r.pr : ""),
    "", "- Repository: " + plain(r.repository),
    "- Status: **" + r.status + "**",
    "- Base: " + r.base, "- Head: " + r.head,
    "- Merge base: " + (r.mergeBase ?? "unavailable"),
    "- Reviewer: " + plain(r.model) + " / rules " + r.version,
    "- Started: " + r.startedAt + "; duration: " + Math.round(r.durationMs / 1000) + "s",
    "", "**" + verdict + "**", "", plain(r.summary),
    "", "## Verified findings", "",
    ...(r.findings.length ? r.findings.flatMap((f, i) => [
      "### " + (i + 1) + ". [" + f.severity + "] " + plain(f.title), "",
      "Location: " + plain(f.side + "/" + f.file) + ":" + f.line,
      "", "- Trigger: " + plain(f.trigger), "- Evidence: " + plain(f.evidence),
      "- Impact: " + plain(f.impact), "- Smallest fix: " + plain(f.fix), "",
    ]) : ["No verified issues found within the reviewed scope."]),
    "", "## Coverage", "", ...r.coverage.map(f => "- " + plain(f)),
    "", "## Checks", "", ...r.checks.map(c => "- " + plain(c)),
    "", "## Gaps and unresolved questions", "",
    ...(r.gaps.length ? r.gaps.map(g => "- " + plain(g)) : ["None reported."]),
    "", "## Previous findings", "",
    ...(r.previous.length ? r.previous.map(f => "- " + plain(f.title) + ": " + f.state) : ["No previous report."]),
    "", "P0: critical, immediate action. P1: serious, fix before merge. P2: normal defect. P3: minor defect.",
    "This report is advisory. It does not approve, merge, or modify the PR.", "",
  ].join("\n")
}

export async function atomicWrite(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = file + "." + crypto.randomUUID() + ".tmp"
  await writeFile(tmp, content, { mode: 0o600 })
  await rename(tmp, file)
}

export async function saveReport(directory: string, report: Report): Promise<string> {
  const destination = path.join(directory, report.id)
  await atomicWrite(destination + ".md", renderReport(report))
  await atomicWrite(destination + ".json", JSON.stringify(report, null, 2) + "\n")
  return destination + ".md"
}
