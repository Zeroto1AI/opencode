import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runCli } from "../lib/run-cli"
import { reviewOne, runReviews, publishReport } from "../lib/review"
import { claudeArgs, type Reviewer } from "../lib/review/claude"
import { command, excludedFile, listPulls, reviewEnvironment, snapshot, validateRepo, type Command } from "../lib/review/source"
import { deduplicate, renderReport, safePath, validateAssessment, type Finding } from "../lib/review/report"
import { parseReviewArgs } from "../scripts/review"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function temp() {
  const dir = await mkdtemp(path.join(tmpdir(), "review-test-"))
  directories.push(dir)
  return dir
}
async function fixture(extra = false) {
  const dir = await temp()
  const git = (args: string[]) => command("git", ["-C", dir, ...args], dir)
  await git(["init", "--template="])
  await git(["config", "user.email", "review@example.invalid"])
  await git(["config", "user.name", "Review Fixture"])
  await writeFile(path.join(dir, "price.ts"), "\nexport const price = (count: number) => count * 10\n")
  await writeFile(path.join(dir, "caller.ts"), "import { price } from './price'\nexport const total = price(2)\n")
  await git(["add", "."])
  await git(["commit", "-m", "baseline"])
  const base = (await git(["rev-parse", "HEAD"])).trim()
  await writeFile(path.join(dir, "price.ts"), "\nexport const price = (count: number) => count / 10\n")
  if (extra) {
    await writeFile(path.join(dir, ".env"), "TOKEN=never-send-this\n")
    await symlink("/etc/passwd", path.join(dir, "escape"))
  }
  await git(["add", "."])
  await git(["commit", "-m", "change price"])
  const head = (await git(["rev-parse", "HEAD"])).trim()
  return { dir, git, base, head, output: path.join(dir, "reports") }
}
const finding: Finding = {
  severity: "P1", title: "Price divides instead of multiplying", file: "price.ts", side: "head", line: 2,
  trigger: "A customer orders two items.", evidence: "price(2) returns 0.2 instead of 20.",
  impact: "Orders are undercharged.", fix: "Multiply count by 10.",
}
const assessment = (findings = [finding]) => ({
  summary: "Changes the unit-price calculation.", findings, reviewedFiles: ["price.ts"], gaps: [],
})

describe("review pipeline", () => {
  test("reviews both revisions, verifies candidates, saves reports, and preserves a dirty checkout", async () => {
    const f = await fixture()
    await writeFile(path.join(f.dir, "caller.ts"), "user's uncommitted edit\n")
    const before = await f.git(["status", "--porcelain"])
    const phases: string[] = []
    const reviewer: Reviewer = async input => {
      phases.push(input.phase)
      expect(await readFile(path.join(input.workspace, "head/price.ts"), "utf8")).toStartWith("\n")
      expect(await readFile(path.join(input.workspace, "base/price.ts"), "utf8")).toContain("* 10")
      expect(await readFile(path.join(input.workspace, "head/caller.ts"), "utf8")).toContain("price(2)")
      if (input.phase === "verify") expect(JSON.parse(await readFile(path.join(input.workspace, "candidates.json"), "utf8")).findings).toHaveLength(1)
      return assessment()
    }
    const output = await temp()
    const result = await reviewOne({ directory: f.dir, base: f.base, output }, { reviewer })
    expect(result.report.status).toBe("complete")
    expect(phases).toEqual(["review", "verify"])
    expect(await readFile(result.file, "utf8")).toContain("Changes needed")
    expect(JSON.parse(await readFile(result.file.replace(".md", ".json"), "utf8")).findings).toHaveLength(1)
    expect(await f.git(["status", "--porcelain"])).toBe(before)
    const cached = await reviewOne({ directory: f.dir, base: f.base, output }, { reviewer: async () => { throw new Error("should not run") } })
    expect(cached.cached).toBe(true)
    expect(cached.report.status).toBe("complete")
  })

  test("excludes secrets and symlinks from snapshots and marks incomplete reviews partial", async () => {
    const f = await fixture(true)
    const s = await snapshot({ repository: f.dir, local: f.dir, base: f.base, head: f.head })
    try {
      expect(s.files.has("head/.env")).toBe(false)
      expect(s.files.has("head/escape")).toBe(false)
      expect(await readFile(path.join(s.root, "changes.diff"), "utf8")).not.toContain("never-send-this")
      expect(s.gaps.some(g => g.includes("symlink"))).toBe(true)
    } finally { await s.cleanup() }
    const result = await reviewOne({ directory: f.dir, base: f.base, output: f.output }, { reviewer: async () => assessment([]) })
    expect(result.report.status).toBe("partial")
    expect(renderReport(result.report)).toContain("no clean verdict")
  })

  test("verification failure never retains unverified candidates as confirmed findings", async () => {
    const f = await fixture()
    const result = await reviewOne({ directory: f.dir, base: f.base, output: f.output }, {
      reviewer: async input => { if (input.phase === "verify") throw new Error("provider unavailable"); return assessment() },
    })
    expect(result.report.status).toBe("failed")
    expect(result.report.findings).toEqual([])
    expect(await readFile(result.file, "utf8")).toContain("provider unavailable")
    expect((await readdir(f.output)).some(n => n.endsWith(".lock"))).toBe(false)
  })

  test("a verifier can reject a false positive without inventing replacement findings", async () => {
    const f = await fixture()
    const result = await reviewOne({ directory: f.dir, base: f.base, output: f.output }, {
      reviewer: async input => input.phase === "review" ? assessment() : assessment([]),
    })
    expect(result.report.findings).toEqual([])
    expect(result.report.status).toBe("complete")
  })

  test("new commits make a remote result stale and prevent publication", async () => {
    const f = await fixture()
    await f.git(["update-ref", "refs/pull/1/head", f.head])
    let views = 0
    let posted = false
    const run: Command = async (exe, args, cwd, signal) => {
      if (exe === "gh") {
        if (args[0] === "pr") return JSON.stringify({ number: 1, title: "Price", body: "", state: "OPEN", isDraft: false,
          baseRefOid: f.base, headRefOid: ++views === 1 ? f.head : "a".repeat(40) })
        posted = true
        throw new Error("must not publish")
      }
      return command(exe, args.map(a => a === "https://github.com/acme/project.git" ? f.dir : a), cwd, signal)
    }
    const result = await reviewOne({ directory: f.dir, repository: "acme/project", pr: 1, output: f.output, publish: true }, {
      run, reviewer: async () => assessment(),
    })
    expect(result.report.status).toBe("stale")
    expect(posted).toBe(false)
  })

  test("batch paginates and records drafts plus metadata failures instead of silently skipping PRs", async () => {
    const dir = await temp()
    const run: Command = async (exe, args) => {
      if (args[0] === "api") {
        expect(args).toContain("--paginate")
        return JSON.stringify([[{ number: 1 }], [{ number: 2 }]])
      }
      if (args[2] === "2") throw new Error("PR metadata unavailable")
      return JSON.stringify({ number: 1, title: "draft", body: "", state: "OPEN", isDraft: true,
        baseRefOid: "a".repeat(40), headRefOid: "b".repeat(40) })
    }
    const result = await runReviews({ directory: dir, repository: "acme/project", all: true, output: dir }, { run })
    expect(result.map(r => r.report.status)).toEqual(["deferred", "failed"])
    expect(JSON.parse(await readFile(path.join(dir, "index.json"), "utf8")).results).toHaveLength(2)
  })

  test("failed discovery still saves a batch index and returns an error", async () => {
    const dir = await temp()
    await expect(runReviews({ directory: dir, repository: "acme/project", all: true, output: dir },
      { run: async () => { throw new Error("GitHub unavailable") } })).rejects.toThrow("GitHub unavailable")
    expect(await readFile(path.join(dir, "index.md"), "utf8")).toContain("GitHub unavailable")
  })
})

test("rejects nonexistent finding locations, unreviewed files, and hostile paths", () => {
  const files = new Map([["head/price.ts", "\ncode\n"]])
  expect(() => validateAssessment(assessment([{ ...finding, line: 99 }]), files, new Set(["price.ts"]))).toThrow()
  expect(() => validateAssessment(assessment([{ ...finding, file: "../outside" }]), files, new Set(["price.ts"]))).toThrow()
  expect(() => validateAssessment({ ...assessment(), reviewedFiles: ["not-changed"] }, files, new Set(["price.ts"]))).toThrow()
  for (const file of ["../a", "/etc/passwd", "a/../../b", "a\\b", "a\n"]) expect(safePath(file)).toBe(false)
  expect(excludedFile("nested/.env.production")).toBe(true)
  expect(() => validateRepo("https://evil.test/repo")).toThrow()
  expect(deduplicate([finding, finding])).toHaveLength(1)
})

test("review CLI is restricted and cannot inherit arbitrary credential environment", () => {
  const args = claudeArgs("sonnet", "review")
  expect(args).toContain("--safe-mode")
  expect(args).toContain("--restricted")
  expect(args).toContain("Read,Grep,Glob")
  expect(args.join(" ")).not.toContain("--dangerously")
  process.env.REVIEW_TEST_SECRET = "never inherit"
  try { expect(reviewEnvironment("claude").REVIEW_TEST_SECRET).toBeUndefined() } finally { delete process.env.REVIEW_TEST_SECRET }
})

test("CLI validates scope and PR URLs", () => {
  expect(parseReviewArgs(["--pr", "https://github.com/acme/project/pull/12"])?.pr).toBe(12)
  expect(() => parseReviewArgs(["--all"])).toThrow()
  expect(() => parseReviewArgs(["--repo", "acme/project", "--all", "--pr", "1"])).toThrow()
  expect(() => parseReviewArgs(["--pr", "https://evil.test/acme/project/pull/1"])).toThrow()
})

test("command runner bounds output, preserves source whitespace, and times out", async () => {
  const cwd = await temp()
  const result = await runCli({ command: process.execPath, args: ["-e", 'process.stdout.write("\\nhello\\n")'], cwd, trimOutput: false })
  expect(result.stdout).toBe("\nhello\n")
  await expect(runCli({ command: process.execPath, args: ["-e", 'process.stdout.write("x".repeat(10000))'], cwd, maxOutputBytes: 100 })).rejects.toThrow("limit")
  const timed = await runCli({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd, timeoutMs: 30 })
  expect(timed.exitCode).not.toBe(0)
})
