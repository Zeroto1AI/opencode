import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runCli } from "../run-cli"
import { safePath } from "./report"

export type Command = (command: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<string>

export function reviewEnvironment(auth: "github" | "claude" | "none"): Record<string, string> {
  const keys = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"]
  if (auth === "github") keys.push("GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR")
  if (auth === "claude") keys.push("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN")
  const env = Object.fromEntries(keys.flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []))
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }
}

export const command: Command = async (executable, args, cwd, signal) => {
  const result = await runCli({
    command: executable, args, cwd, signal, env: reviewEnvironment(executable === "gh" || executable === "git" ? "github" : "none"),
    timeoutMs: 120_000, maxOutputBytes: 16 * 1024 * 1024, trimOutput: false,
  })
  if (result.exitCode !== 0) throw new Error(executable + " command failed (exit " + result.exitCode + "); check authentication and target availability")
  return result.stdout
}

export type PullRequest = {
  number: number
  title: string
  body: string
  baseRefOid: string
  headRefOid: string
  state: string
  isDraft: boolean
  url: string
  comments?: unknown[]
  reviews?: unknown[]
  statusCheckRollup?: unknown[]
}

export function validateRepo(repo: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
      repo.split("/").some(s => s === "." || s === "..")) throw new Error("Use a GitHub repository in owner/name form")
  return repo
}

export function validateSha(sha: string): string {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Expected a full Git commit SHA")
  return sha
}

export async function getPull(repo: string, number: number, cwd: string, run = command, signal?: AbortSignal): Promise<PullRequest> {
  validateRepo(repo)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid PR number")
  const pr = JSON.parse(await run("gh", ["pr", "view", String(number), "--repo", repo, "--json",
    "number,title,body,baseRefOid,headRefOid,state,isDraft,url,comments,reviews,statusCheckRollup"], cwd, signal))
  validateSha(pr.baseRefOid)
  validateSha(pr.headRefOid)
  if (pr.number !== number || typeof pr.title !== "string" || typeof pr.body !== "string" ||
      !["OPEN", "CLOSED", "MERGED"].includes(pr.state) || typeof pr.isDraft !== "boolean") throw new Error("Invalid PR metadata")
  return pr
}

export async function listPulls(repo: string, cwd: string, run = command, signal?: AbortSignal): Promise<number[]> {
  validateRepo(repo)
  const pages = JSON.parse(await run("gh", ["api", "--paginate", "--slurp", "repos/" + repo + "/pulls?state=open&per_page=100"], cwd, signal))
  const ids = pages.flat().map((p: { number: number }) => p.number)
  if (!ids.every((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0)) throw new Error("Invalid PR listing")
  return [...new Set<number>(ids)]
}

export type Snapshot = {
  root: string
  mergeBase: string
  files: Map<string, string>
  changed: Set<string>
  gaps: string[]
  cleanup: () => Promise<void>
}

export function excludedFile(file: string): boolean {
  return !safePath(file) || file.split("/").some(p =>
    p === ".git" || p === ".env" || p.startsWith(".env.") || p === "node_modules" ||
    /^(id_rsa|id_ed25519|credentials|secrets)(\.|$)/i.test(p) || /\.(pem|key|p12|pfx)$/i.test(p))
}

export async function snapshot(input: {
  repository: string; local?: string; base: string; head: string; signal?: AbortSignal
  headRef?: string
}, run = command): Promise<Snapshot> {
  validateSha(input.base)
  validateSha(input.head)
  const root = await mkdtemp(path.join(tmpdir(), "opencode-review-"))
  const gitDir = path.join(root, "objects.git")
  const workspace = path.join(root, "workspace")
  const cleanup = () => rm(root, { recursive: true, force: true })
  const git = (args: string[]) => run("git", ["--git-dir=" + gitDir, "-c", "core.hooksPath=/dev/null", ...args], root, input.signal)
  try {
    await mkdir(workspace)
    await run("git", ["init", "--bare", "--template=", gitDir], root, input.signal)
    const source = input.local ?? "https://github.com/" + validateRepo(input.repository) + ".git"
    // Fetch objects only. Never check out a PR, run its hooks, or initialize its submodules.
    const headRef = input.headRef ?? input.head
    if (input.headRef && !/^refs\/pull\/[1-9]\d*\/head$/.test(input.headRef)) throw new Error("Invalid pull request head ref")
    await git(["-c", "credential.helper=!gh auth git-credential", "fetch", "--no-tags", "--no-recurse-submodules", "--", source, input.base, headRef])
    const mergeBase = validateSha((await git(["merge-base", input.base, input.head])).trim())
    const changed = new Set((await git(["diff", "--name-only", "--no-renames", "-z", mergeBase, input.head, "--"])).split("\0").filter(Boolean))
    const files = new Map<string, string>()
    const gaps: string[] = []
    let bytes = 0
    for (const [side, sha] of [["base", mergeBase], ["head", input.head]]) {
      const names = new Set<string>()
      const entries = (await git(["ls-tree", "-rlz", sha])).split("\0").filter(Boolean)
      // Changed files first, then repository context, so a large tree cannot starve the diff.
      entries.sort((a, b) => Number(changed.has(b.slice(b.indexOf("\t") + 1))) - Number(changed.has(a.slice(a.indexOf("\t") + 1))))
      for (const entry of entries) {
        const tab = entry.indexOf("\t")
        const file = entry.slice(tab + 1)
        const [mode, type, oid, size] = entry.slice(0, tab).trim().split(/\s+/)
        let reason = ""
        if (excludedFile(file)) reason = "excluded path (credentials, dependencies, or unsafe name)"
        else if (names.has(file.normalize("NFC").toLowerCase())) reason = "case-insensitive path collision"
        else if (type !== "blob" || !["100644", "100755"].includes(mode)) reason = "symlink or submodule"
        else if (Number(size) > 256_000) reason = "file exceeds 256 KB"
        else if (files.size >= 4000 || bytes + Number(size) > 40_000_000) reason = "snapshot size budget"
        if (reason) {
          gaps.push(side + "/" + file + ": " + reason)
          continue
        }
        names.add(file.normalize("NFC").toLowerCase())
        const content = await git(["cat-file", "blob", oid])
        if (content.includes("\0") || content.includes("\ufffd")) {
          gaps.push(side + "/" + file + ": binary or non-UTF8 content")
          continue
        }
        bytes += Buffer.byteLength(content)
        files.set(side + "/" + file, content)
        const target = path.join(workspace, side, file)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, content, { mode: 0o400 })
      }
    }
    const allowed = [...changed].filter(file => files.has("base/" + file) || files.has("head/" + file))
    // Do not place excluded secrets in the diff either.
    const diff = allowed.length ? await git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=5", mergeBase, input.head, "--", ...allowed]) : ""
    await writeFile(path.join(workspace, "changes.diff"), diff)
    await writeFile(path.join(workspace, "history.txt"), await git(["log", "-30", "--format=%H %s", mergeBase + ".." + input.head, "--"]))
    await writeFile(path.join(workspace, "manifest.json"), JSON.stringify({ base: input.base, head: input.head, mergeBase, changed: [...changed], available: [...files.keys()], gaps }, null, 2))
    return { root: workspace, mergeBase, files, changed, gaps, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

export async function localRevisions(directory: string, base: string, head: string, run = command, signal?: AbortSignal) {
  const resolve = async (ref: string) => validateSha((await run("git", ["-C", directory, "rev-parse", "--verify", "--end-of-options", ref + "^{commit}"], directory, signal)).trim())
  return { base: await resolve(base), head: await resolve(head) }
}
