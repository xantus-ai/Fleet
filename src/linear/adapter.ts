import type { Task } from "../queue/db.ts";

export type ProgressEvent =
  | { kind: "thought"; text: string }
  | { kind: "tool_call"; name: string; summary: string }
  | { kind: "tool_result"; name: string; ok: boolean; summary?: string }
  | { kind: "warning"; text: string };

/**
 * Boundary between the orchestrator and Linear. v1 implementation posts
 * comments via GraphQL; v2 will plug into the Linear Agent API
 * (AgentSession + AgentActivity) without changing any callers.
 */
export interface LinearAdapter {
  notifyStarted(task: Task): Promise<void>;
  notifyProgress(task: Task, event: ProgressEvent): Promise<void>;
  notifyPrOpened(task: Task, prUrl: string): Promise<void>;
  notifyDone(task: Task): Promise<void>;
  notifyFailed(task: Task, error: string): Promise<void>;
}
