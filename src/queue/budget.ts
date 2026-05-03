import { config } from "../config.ts";
import { pool } from "./db.ts";

export type BudgetState =
  | { kind: "ok"; spentUsd: number; capUsd: number }
  | { kind: "exceeded"; spentUsd: number; capUsd: number };

/**
 * Sum of cost_usd across the rolling 24-hour window. We use a rolling
 * window rather than a calendar day so a single bad ticket can't reset
 * the budget by waiting until midnight.
 */
export async function spentLast24h(): Promise<number> {
  const { rows } = await pool.query<{ sum: string | null }>(
    `select coalesce(sum(cost_usd), 0)::text as sum
       from tasks
      where created_at > now() - interval '24 hours'`,
  );
  return Number(rows[0]?.sum ?? 0);
}

export async function checkDailyBudget(): Promise<BudgetState> {
  const cap = config.worker.dailyUsdCap;
  if (cap <= 0) {
    return { kind: "ok", spentUsd: 0, capUsd: 0 };
  }
  const spent = await spentLast24h();
  if (spent >= cap) {
    return { kind: "exceeded", spentUsd: spent, capUsd: cap };
  }
  return { kind: "ok", spentUsd: spent, capUsd: cap };
}

export async function recordCost(taskId: string, costUsd: number): Promise<void> {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return;
  await pool.query(`update tasks set cost_usd = cost_usd + $2 where id = $1`, [
    taskId,
    costUsd,
  ]);
}
