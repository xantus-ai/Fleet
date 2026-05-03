import { setTimeout as delay } from "node:timers/promises";
import { config } from "../config.ts";
import { claimNext, heartbeat, markFailed } from "../queue/claim.ts";
import type { LinearAdapter } from "../linear/adapter.ts";
import { runTask } from "./runTask.ts";

type WorkerCtx = {
  workerId: string;
  index: number;
  linear: LinearAdapter;
  signal: AbortSignal;
};

async function runOneWorker(ctx: WorkerCtx): Promise<void> {
  const id = `${ctx.workerId}#${ctx.index}`;
  while (!ctx.signal.aborted) {
    let task;
    try {
      task = await claimNext(id);
    } catch (err) {
      console.error(`[${id}] claim error`, err);
      await delay(config.worker.pollIntervalMs, undefined, { signal: ctx.signal }).catch(() => {});
      continue;
    }

    if (!task) {
      await delay(config.worker.pollIntervalMs, undefined, { signal: ctx.signal }).catch(() => {});
      continue;
    }

    console.log(`[${id}] claimed ${task.id} (${task.linearIssueIdentifier ?? task.linearIssueId})`);
    const stop = new AbortController();
    const hb = heartbeatLoop(task.id, id, stop.signal);

    try {
      await runTask(task, ctx.linear);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${id}] task ${task.id} failed:`, msg);
      // markFailed may already have been called inside runTask; defensive retry is harmless.
      await markFailed(task.id, msg).catch(() => {});
    } finally {
      stop.abort();
      await hb.catch(() => {});
    }
  }
}

async function heartbeatLoop(taskId: string, workerId: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const ok = await heartbeat(taskId, workerId);
      if (!ok) return; // someone else owns it now (stale-claim recovery)
    } catch (err) {
      console.error(`[${workerId}] heartbeat error`, err);
    }
    await delay(config.worker.heartbeatIntervalMs, undefined, { signal }).catch(() => {});
  }
}

export async function runPool(linear: LinearAdapter): Promise<void> {
  const ac = new AbortController();
  const shutdown = (sig: string) => {
    console.log(`[pool] received ${sig}, shutting down`);
    ac.abort();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const n = config.worker.concurrency;
  console.log(`[pool] starting ${n} workers as ${config.worker.id}`);

  const workers = Array.from({ length: n }, (_, i) =>
    runOneWorker({
      workerId: config.worker.id,
      index: i,
      linear,
      signal: ac.signal,
    }),
  );

  await Promise.allSettled(workers);
  console.log("[pool] all workers stopped");
}
