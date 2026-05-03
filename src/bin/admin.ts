import { pool, rowToTask } from "../queue/db.ts";
import { markCancelled } from "../queue/claim.ts";

const [, , cmd, ...args] = process.argv;

function usage(): never {
  console.error(
    `usage:
  admin list [status]
  admin show <task-id>
  admin cancel <task-id>
  admin retry <task-id>`,
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
        t.linearIssueIdentifier ?? t.linearIssueId.slice(0, 8),
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

try {
  switch (cmd) {
    case "list":
      await list(args[0]);
      break;
    case "show":
      if (!args[0]) usage();
      await show(args[0]);
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
    default:
      usage();
  }
} finally {
  await pool.end();
}
