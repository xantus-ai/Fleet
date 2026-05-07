import { webhookAdapter } from "../linear/webhookAdapter.ts";
import { ensureDefaultRepo } from "../repos/registry.ts";
import { runPool } from "../worker/pool.ts";

// Mirror the receiver: keep the repos row up to date with env on every
// startup so resolveRepo() can find it.
await ensureDefaultRepo();

await runPool(webhookAdapter);
process.exit(0);
