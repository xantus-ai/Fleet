import { setTimeout as delay } from "node:timers/promises";
import { config } from "../config.ts";
import { claimNext, heartbeat, markFailed } from "../queue/claim.ts";
import { checkDailyBudget } from "../queue/budget.ts";
import type { LinearAdapter } from "../linear/adapter.ts";
import { runTask } from "./runTask.ts";

type WorkerCtx = {
  workerId: string;
  index: number;
  linear: LinearAdapter;
  /** Aborted means: stop *claiming new* tasks. In-flight tasks finish. */
  drainSignal: AbortSignal;
  /** Aborted means: cancel even in-flight tasks. Reserved for SIGINT. */
  killSignal: AbortSignal;
};

async function runOneWorker(ctx: WorkerCtx): Promise<void> {
  const id = `${ctx.workerId}#${ctx.index}`;
  let lastBudgetWarn = 0;

  while (!ctx.drainSignal.aborted) {
    // Daily USD cap gate.
    try {
      const b = await checkDailyBudget();
      if (b.kind === "exceeded") {
        const now = Date.now();
        if (now - lastBudgetWarn > 60_000) {
          console.warn(
            `[${id}] daily budget exceeded ($${b.spentUsd.toFixed(2)} / $${b.capUsd}); pausing claims`,
          );
          lastBudgetWarn = now;
        }
        await delay(15_000, undefined, { signal: ctx.drainSignal }).catch(() => {});
        continue;
      }
    } catch (err) {
      console.error(`[${id}] budget check failed`, err);
    }

    let task;
    try {
      task = await claimNext(id);
    } catch (err) {
      console.error(`[${id}] claim error`, err);
      await delay(config.worker.pollIntervalMs, undefined, { signal: ctx.drainSignal }).catch(() => {});
      continue;
    }

    if (!task) {
      await delay(config.worker.pollIntervalMs, undefined, { signal: ctx.drainSignal }).catch(() => {});
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
      await markFailed(task.id, msg).catch(() => {});
    } finally {
      stop.abort();
      await hb.catch(() => {});
    }
  }

  console.log(`[${id}] drained`);
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
  const drain = new AbortController();
  const kill = new AbortController();
  let sigCount = 0;

  const onSig = (sig: string) => {
    sigCount += 1;
    if (sigCount === 1) {
      console.log(`[pool] received ${sig}; draining (Ctrl-C again to abort in-flight tasks)`);
      drain.abort();
    } else {
      console.log(`[pool] received ${sig} again; aborting in-flight tasks`);
      kill.abort();
    }
  };
  process.on("SIGINT", () => onSig("SIGINT"));
  process.on("SIGTERM", () => onSig("SIGTERM"));

  const n = config.worker.concurrency;
  console.log(`[pool] starting ${n} workers as ${config.worker.id}`);

  const workers = Array.from({ length: n }, (_, i) =>
    runOneWorker({
      workerId: config.worker.id,
      index: i,
      linear,
      drainSignal: drain.signal,
      killSignal: kill.signal,
    }),
  );

  await Promise.allSettled(workers);
  console.log("[pool] all workers stopped");
}
