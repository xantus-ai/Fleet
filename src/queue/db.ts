import pg from "pg";
import { config } from "../config.ts";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: Math.max(4, config.worker.concurrency * 2 + 2),
});

pool.on("error", (err) => {
  console.error("[db] idle client error", err);
});

export type Task = {
  id: string;
  linearIssueId: string;
  linearIssueIdentifier: string | null;
  title: string;
  body: string | null;
  repo: string | null;
  branchName: string | null;
  status:
    | "pending"
    | "claimed"
    | "running"
    | "pr_open"
    | "done"
    | "failed"
    | "cancelled";
  claimedBy: string | null;
  claimedAt: Date | null;
  heartbeatAt: Date | null;
  prUrl: string | null;
  error: string | null;
  attemptCount: number;
  budgetTokensRemaining: number | null;
  budgetSecondsRemaining: number | null;
  createdAt: Date;
  updatedAt: Date;
};

type TaskRow = {
  id: string;
  linear_issue_id: string;
  linear_issue_identifier: string | null;
  title: string;
  body: string | null;
  repo: string | null;
  branch_name: string | null;
  status: Task["status"];
  claimed_by: string | null;
  claimed_at: Date | null;
  heartbeat_at: Date | null;
  pr_url: string | null;
  error: string | null;
  attempt_count: number;
  budget_tokens_remaining: string | number | null;
  budget_seconds_remaining: number | null;
  created_at: Date;
  updated_at: Date;
};

export function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    linearIssueId: r.linear_issue_id,
    linearIssueIdentifier: r.linear_issue_identifier,
    title: r.title,
    body: r.body,
    repo: r.repo,
    branchName: r.branch_name,
    status: r.status,
    claimedBy: r.claimed_by,
    claimedAt: r.claimed_at,
    heartbeatAt: r.heartbeat_at,
    prUrl: r.pr_url,
    error: r.error,
    attemptCount: r.attempt_count,
    budgetTokensRemaining:
      r.budget_tokens_remaining == null
        ? null
        : Number(r.budget_tokens_remaining),
    budgetSecondsRemaining: r.budget_seconds_remaining,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function logEvent(
  taskId: string,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    `insert into task_events (task_id, type, payload) values ($1, $2, $3::jsonb)`,
    [taskId, type, JSON.stringify(payload)],
  );
}
