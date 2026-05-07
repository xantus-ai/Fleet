import {
  query,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.ts";
import { logEvent, type Task } from "../queue/db.ts";
import type { BlockerContext } from "../queue/dependencies.ts";
import type { LinearAdapter } from "../linear/adapter.ts";
import type { TaskRecords } from "../taskRecords/manager.ts";
import { inspectBashCommand } from "./bashAllowlist.ts";
import { buildSystemPrompt, buildUserPrompt } from "./systemPrompt.ts";

export type AgentResult = {
  ok: boolean;
  reason?: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  finalText: string;
};

const ENABLED_TOOLS = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"];

function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return typeof input.command === "string" ? input.command : "";
    case "Read":
    case "Write":
      return typeof input.file_path === "string" ? input.file_path : "";
    case "Edit":
      return typeof input.file_path === "string" ? input.file_path : "";
    case "Grep":
      return typeof input.pattern === "string" ? input.pattern : "";
    case "Glob":
      return typeof input.pattern === "string" ? input.pattern : "";
    default:
      return JSON.stringify(input).slice(0, 200);
  }
}

export async function runAgent(args: {
  task: Task;
  worktreeDir: string;
  branch: string;
  records: TaskRecords;
  linear: LinearAdapter;
  signal: AbortSignal;
  blockers: BlockerContext[];
}): Promise<AgentResult> {
  const { task, worktreeDir, branch, records, linear, signal, blockers } = args;

  const systemPrompt = await buildSystemPrompt(worktreeDir);
  const userPrompt = buildUserPrompt({
    identifier: task.linearIssueIdentifier,
    title: task.title,
    body: task.body,
    branch,
    records: {
      planPath: records.planPath,
      progressPath: records.progressPath,
      overviewPath: records.overviewPath,
    },
    blockers,
  });

  await logEvent(task.id, "agent_message", {
    kind: "user_prompt",
    text: userPrompt,
  });

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  let finalText = "";
  let costUsd = 0;
  let durationMs = 0;
  let numTurns = 0;
  let ok = false;
  let reason: string | undefined;

  try {
    const response = query({
      prompt: userPrompt,
      options: {
        cwd: worktreeDir,
        additionalDirectories: [records.dir],
        model: config.agent.model,
        // Pass the system prompt as [content, BOUNDARY] so the entire
        // fleet-rules + target-repo CLAUDE.md prefix is cacheable. The
        // SDK then sends a cache_control marker, which lets every turn
        // after the first hit Anthropic's prompt cache (~10% of full
        // input price). Subsequent tasks against the same target repo
        // also hit the cache as long as they start within the cache
        // TTL of a previous task.
        systemPrompt: [systemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY],
        tools: ENABLED_TOOLS,
        allowedTools: ENABLED_TOOLS,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        canUseTool: async (toolName, input) => {
          if (toolName === "Bash") {
            const command =
              typeof input.command === "string" ? input.command : "";
            const decision = inspectBashCommand(command);
            if (!decision.allow) {
              await logEvent(task.id, "tool_call_denied", {
                tool: toolName,
                command,
                reason: decision.reason,
              });
              await linear.notifyProgress(task, {
                kind: "warning",
                text: `Blocked Bash: \`${command}\` — ${decision.reason}`,
              });
              return {
                behavior: "deny",
                message: `Blocked by fleet policy: ${decision.reason}`,
                interrupt: false,
              };
            }
          }
          return { behavior: "allow", updatedInput: input };
        },
        maxTurns: config.agent.maxTurns,
        maxBudgetUsd: config.agent.maxUsd,
        persistSession: false,
        abortController: ac,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "fleet/0.1.0" },
      },
    });

    for await (const msg of response) {
      switch (msg.type) {
        case "assistant": {
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text) {
              finalText = block.text;
              await logEvent(task.id, "agent_message", {
                kind: "text",
                text: block.text,
              });
            } else if (block.type === "tool_use") {
              const summary = summarizeToolInput(
                block.name,
                block.input as Record<string, unknown>,
              );
              await logEvent(task.id, "tool_call", {
                name: block.name,
                summary,
              });
            }
          }
          break;
        }
        case "user": {
          const content = msg.message.content;
          if (typeof content === "string") break;
          for (const block of content) {
            if (typeof block === "string") continue;
            if (block.type === "tool_result") {
              const isError = block.is_error === true;
              const c = block.content;
              const summary =
                typeof c === "string"
                  ? c.slice(0, 500)
                  : Array.isArray(c)
                    ? c
                        .map((p) =>
                          typeof p === "string"
                            ? p
                            : p.type === "text"
                              ? p.text
                              : "",
                        )
                        .join("\n")
                        .slice(0, 500)
                    : "";
              await logEvent(task.id, "tool_result", { ok: !isError, summary });
            }
          }
          break;
        }
        case "result": {
          numTurns = msg.num_turns;
          durationMs = msg.duration_ms;
          if (msg.subtype === "success") {
            costUsd = msg.total_cost_usd;
            ok = true;
          } else {
            costUsd = msg.total_cost_usd ?? 0;
            ok = false;
            reason = `agent ended: ${msg.subtype}`;
          }
          let cacheReadInputTokens = 0;
          let cacheCreationInputTokens = 0;
          let inputTokens = 0;
          let outputTokens = 0;
          for (const usage of Object.values(msg.modelUsage ?? {})) {
            cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
            cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
            inputTokens += usage.inputTokens ?? 0;
            outputTokens += usage.outputTokens ?? 0;
          }
          await logEvent(task.id, "agent_result", {
            ok,
            costUsd,
            durationMs,
            numTurns,
            subtype: msg.subtype,
            inputTokens,
            outputTokens,
            cacheReadInputTokens,
            cacheCreationInputTokens,
          });
          break;
        }
        default:
          // Other system / progress messages are ignored for v1.
          break;
      }
    }
  } catch (err) {
    ok = false;
    reason = err instanceof Error ? err.message : String(err);
    await logEvent(task.id, "agent_error", { error: reason });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  return { ok, reason, costUsd, durationMs, numTurns, finalText };
}
