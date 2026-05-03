import { pool, rowToTask } from "../queue/db.ts";
import { markCancelled } from "../queue/claim.ts";
import { spentLast24h } from "../queue/budget.ts";
import { config } from "../config.ts";

const [, , cmd, ...args] = process.argv;

function usage(): never {
  console.error(
    `usage:
  admin list [status]                 list recent tasks
  admin show <task-id>                full task row + raw events
  admin logs <task-id>                pretty event timeline
  admin cancel <task-id>              mark a task cancelled
  admin retry <task-id>               re-queue a failed/cancelled task
  admin stats                         counts by status + 24h cost`,
  );
  process.exit(2);
}

async function list(filter: string | undefined): Promise<void> {
  const where = filter ? `where status = $1` : "";
  const params = filter ? [filter] : [];
  const { rows } = await pool.query(
    `select * from tasks ${where} order by created_at desc limit 50`,
    params,
  );
  for (const r of rows) {
    const t = rowToTask(r);
    console.log(
      [
        t.createdAt.toISOString(),
        t.status.padEnd(9),
        (t.linearIssueIdentifier ?? t.linearIssueId.slice(0, 8)).padEnd(10),
        `$${t.costUsd.toFixed(2).padStart(6)}`,
        t.id,
        t.title.slice(0, 60),
      ].join("  "),
    );
  }
}

async function show(id: string): Promise<void> {
  const taskRes = await pool.query(`select * from tasks where id=$1`, [id]);
  if (taskRes.rows.length === 0) {
    console.error("not found");
    process.exit(1);
  }
  const t = rowToTask(taskRes.rows[0]);
  console.log(JSON.stringify(t, null, 2));
  console.log("\n--- events ---");
  const events = await pool.query(
    `select id, type, payload, created_at from task_events where task_id=$1 order by id`,
    [id],
  );
  for (const e of events.rows) {
    console.log(`${e.created_at.toISOString()}  ${e.type}  ${JSON.stringify(e.payload)}`);
  }
}

async function logs(id: string): Promise<void> {
  const events = await pool.query<{
    type: string;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    `select type, payload, created_at from task_events where task_id=$1 order by id`,
    [id],
  );
  if (events.rows.length === 0) {
    console.error("no events for that task");
    process.exit(1);
  }
  for (const e of events.rows) {
    const ts = e.created_at.toISOString().replace("T", " ").slice(0, 19);
    console.log(`${ts}  ${formatEvent(e.type, e.payload)}`);
  }
}

function trim(s: unknown, n: number): string {
  const str = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return str.length <= n ? str : str.slice(0, n - 1) + "…";
}

function formatEvent(type: string, p: Record<string, unknown>): string {
  switch (type) {
    case "status_change":
      return `→ ${p.to ?? "?"}${p.error ? ` (${trim(p.error, 80)})` : ""}`;
    case "branch_assigned":
      return `branch ${p.branch}`;
    case "worktree_created":
      return `worktree ${p.dir}`;
    case "tool_call":
      return `· ${p.name}  ${trim(p.summary, 100)}`;
    case "tool_result":
      return `  ${p.ok ? "✓" : "✗"}  ${trim(p.summary, 100)}`;
    case "tool_call_denied":
      return `! BLOCKED ${p.tool}: ${trim(p.command, 80)}  (${p.reason})`;
    case "agent_message":
      if (p.kind === "user_prompt") return `prompt: ${trim(p.text, 100)}`;
      return `say: ${trim(p.text, 100)}`;
    case "agent_result":
      return `agent done  ok=${p.ok}  $${Number(p.costUsd ?? 0).toFixed(4)}  turns=${p.numTurns}  ${p.durationMs}ms`;
    case "agent_error":
      return `agent error: ${trim(p.error, 120)}`;
    default:
      return `${type}  ${trim(p, 100)}`;
  }
}

async function retry(id: string): Promise<void> {
  const { rowCount } = await pool.query(
    `update tasks set status='pending', error=null, claimed_by=null, claimed_at=null
      where id=$1 and status in ('failed','cancelled')`,
    [id],
  );
  if (!rowCount) {
    console.error("task not in failed/cancelled state");
    process.exit(1);
  }
  console.log("queued for retry");
}

async function stats(): Promise<void> {
  const counts = await pool.query<{ status: string; n: string }>(
    `select status, count(*)::text as n from tasks group by status order by status`,
  );
  console.log("Tasks by status:");
  for (const r of counts.rows) {
    console.log(`  ${r.status.padEnd(10)} ${r.n}`);
  }

  const spent = await spentLast24h();
  const cap = config.worker.dailyUsdCap;
  console.log("");
  console.log(
    `Spend (rolling 24h): $${spent.toFixed(2)}` +
      (cap > 0 ? ` / $${cap.toFixed(2)} cap` : " (no cap)"),
  );

  const recent = await pool.query<{ d: string; n: string; usd: string }>(
    `select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as d,
            count(*)::text as n,
            coalesce(sum(cost_usd), 0)::text as usd
       from tasks
      where created_at > now() - interval '7 days'
      group by 1 order by 1 desc`,
  );
  console.log("\nLast 7 days:");
  for (const r of recent.rows) {
    console.log(`  ${r.d}  ${r.n.padStart(4)} tasks  $${Number(r.usd).toFixed(2)}`);
  }
}

try {
  switch (cmd) {
    case "list":
      await list(args[0]);
      break;
    case "show":
      if (!args[0]) usage();
      await show(args[0]);
      break;
    case "logs":
      if (!args[0]) usage();
      await logs(args[0]);
      break;
    case "cancel":
      if (!args[0]) usage();
      await markCancelled(args[0]);
      console.log("cancelled");
      break;
    case "retry":
      if (!args[0]) usage();
      await retry(args[0]);
      break;
    case "stats":
      await stats();
      break;
    default:
      usage();
  }
} finally {
  await pool.end();
}
