import { webhookAdapter } from "../linear/webhookAdapter.ts";
import { runPool } from "../worker/pool.ts";

await runPool(webhookAdapter);
process.exit(0);
