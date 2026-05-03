import { pool } from "./db.ts";

export type RecentToolCall = {
  name: string;
  summary: string;
  ok?: boolean;
};

export type Diagnostics = {
  recentToolCalls: RecentToolCall[];
  finalAssistantText?: string;
};

const MAX_TOOL_CALLS = 5;
const MAX_TOOL_SUMMARY = 160;
const MAX_FINAL_TEXT = 600;

type RawEvent = { type: string; payload: Record<string, unknown> };

/**
 * Pulls the most recent agent activity for a task and formats it for
 * human triage. Pairs each tool_call with its tool_result to surface
 * which step failed.
 */
export async function buildDiagnostics(taskId: string): Promise<Diagnostics> {
  const { rows } = await pool.query<RawEvent>(
    `select type, payload
       from task_events
      where task_id = $1
      order by id desc
      limit 60`,
    [taskId],
  );
  const events = rows.slice().reverse();
  return diagnosticsFromEvents(events);
}

export function diagnosticsFromEvents(events: RawEvent[]): Diagnostics {
  const calls: RecentToolCall[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || e.type !== "tool_call") continue;
    const name = String(e.payload.name ?? "");
    const summary = String(e.payload.summary ?? "");
    let ok: boolean | undefined;
    const next = events[i + 1];
    if (next?.type === "tool_result" && typeof next.payload.ok === "boolean") {
      ok = next.payload.ok;
    }
    calls.push({ name, summary: summary.slice(0, MAX_TOOL_SUMMARY), ok });
  }

  let finalAssistantText: string | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (
      e.type === "agent_message" &&
      e.payload.kind === "text" &&
      typeof e.payload.text === "string"
    ) {
      finalAssistantText = e.payload.text.slice(0, MAX_FINAL_TEXT);
      break;
    }
  }

  return {
    recentToolCalls: calls.slice(-MAX_TOOL_CALLS),
    finalAssistantText,
  };
}
