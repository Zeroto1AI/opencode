import { Plugin } from "@opencode/plugin"
import { runCliAndSave } from "../../lib/save-output"

const claudeInput = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      description: "The complete task for Claude Code",
    },
    model: {
      type: "string",
      description: "Optional Claude model alias or full ID",
    },
    effort: {
      type: "string",
      enum: ["low", "medium", "high", "xhigh", "max"],
      description: "Optional reasoning effort",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
} as const

const codexInput = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      description: "The complete task for Codex",
    },
    model: {
      type: "string",
      description: "Optional Codex model ID",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
} as const

const antigravityInput = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      description: "The complete task for Antigravity",
    },
    model: {
      type: "string",
      description: "Optional Antigravity model ID (e.g. gemini-3.7-flash-high)",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
} as const

export default Plugin.define({
  id: "cli-agents",
  async setup(ctx) {
    // Location where this plugin instance loaded. The v1 API exposed the
    // session's working directory per tool call (context.directory); v2 tool
    // executors only receive sessionID/agent/messageID/signal, so the plugin
    // location directory is used as the CLI working directory instead.
    const directory = ctx.location.directory

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "cli-claude",
        description:
          "Run Anthropic's authenticated Claude Code agent non-interactively in the current workspace. It can inspect, edit, and execute commands. Optionally select any model accepted by the local Claude CLI.",
        input: claudeInput,
        execute: async (input: any, context: any) => {
          await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent,
            action: "cli-claude", resources: ["*"] })
          const commandArgs = [
            "--print",
            "--output-format",
            "text",
            "--dangerously-skip-permissions",
            "--add-dir",
            directory,
          ]

          if (input.model) commandArgs.push("--model", input.model)
          if (input.effort) commandArgs.push("--effort", input.effort)

          const content = await runCliAndSave({
            toolName: "cli-claude",
            sessionID: context.sessionID,
            prompt: input.prompt,
            options: {
              command: "claude",
              args: commandArgs,
              cwd: directory,
              stdin: input.prompt,
              signal: context.signal,
            },
          })
          return { content }
        },
      })

      editor.add({
        name: "cli-codex",
        description:
          "Run OpenAI's authenticated Codex CLI non-interactively in the current workspace. It can inspect, edit, and execute commands. Optionally select any model accepted by the local Codex CLI.",
        input: codexInput,
        execute: async (input: any, context: any) => {
          await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent,
            action: "cli-codex", resources: ["*"] })
          const commandArgs = [
            "exec",
            "-",
            "--dangerously-bypass-approvals-and-sandbox",
            "--skip-git-repo-check",
            "--ephemeral",
            "--color",
            "never",
            "--cd",
            directory,
            // Inject the local pitlane graph MCP server for this run only
            // (binary is shared at ~/.local/bin — resolved via PATH, no per-project copy).
            "-c",
            `mcp_servers.pitlane.command="pitlane-mcp"`,
          ]

          if (input.model) commandArgs.push("--model", input.model)

          const content = await runCliAndSave({
            toolName: "cli-codex",
            sessionID: context.sessionID,
            prompt: input.prompt,
            options: {
              command: "codex",
              args: commandArgs,
              cwd: directory,
              stdin: input.prompt,
              signal: context.signal,
            },
          })
          return { content }
        },
      })

      editor.add({
        name: "cli-antigravity",
        description:
          "Run Google's authenticated Antigravity coding agent (agy) non-interactively in the current workspace. It can inspect, edit, and execute commands. Select any model exposed by the local agy installation. Note: reasoning effort is encoded in the model ID suffix (e.g. gemini-3.7-flash-high), so pass a full model ID to pick the effort level.",
        input: antigravityInput,
        execute: async (input: any, context: any) => {
          await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent,
            action: "cli-antigravity", resources: ["*"] })
          const commandArgs = ["--print", input.prompt, "--dangerously-skip-permissions", "--add-dir", directory]

          if (input.model) commandArgs.push("--model", input.model)

          const content = await runCliAndSave({
            toolName: "cli-antigravity",
            sessionID: context.sessionID,
            prompt: input.prompt,
            options: {
              command: "agy",
              args: commandArgs,
              cwd: directory,
              signal: context.signal,
            },
          })
          return { content }
        },
      })
    })
  },
})
