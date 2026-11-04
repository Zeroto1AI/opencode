import { Plugin } from "@opencode/plugin"
import { runReviews } from "../../lib/review"
import { renderReport } from "../../lib/review/report"

export default Plugin.define({
  id: "review",
  async setup(ctx) {
    await ctx.tool.transform(editor => {
      editor.add({
        name: "review",
        description: "Review a PR, all open PRs, or a local committed range using restricted snapshots and two review passes. Saves Markdown/JSON reports; never publishes or edits source.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            directory: { type: "string", minLength: 1, description: "Explicit target project directory, not the plugin directory" },
            repository: { type: "string", description: "GitHub owner/name" },
            pr: { type: "integer", minimum: 1 },
            all: { type: "boolean" },
            base: { type: "string" },
            head: { type: "string" },
            model: { type: "string", description: "Claude model alias; defaults to sonnet" },
            includeDrafts: { type: "boolean" },
            force: { type: "boolean" },
          },
          required: ["directory"], additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          if (Number(!!input.all) + Number(input.pr !== undefined) + Number(!!input.base) !== 1 ||
              (input.head && !input.base)) throw new Error("Choose one of pr, all, or base")
          await ctx.permission.assert({
            sessionID: context.sessionID, agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "review", resources: [input.repository ?? input.directory],
          })
          const results = await runReviews({ ...input, signal: context.signal })
          return { content: results.map(r => "Saved report: " + r.file + "\n\n" + renderReport(r.report)).join("\n\n---\n\n") }
        },
      })
    })
  },
})
