import { serve } from "@hono/node-server";
import { config } from "../config.ts";
import { ensureDefaultRepo } from "../repos/registry.ts";
import { buildApp } from "../webhook/server.ts";

if (!config.linear.webhookSecret && !config.security.allowUnsignedWebhooks) {
  console.error(
    "[serve] LINEAR_WEBHOOK_SECRET is empty. Refusing to start.\n" +
      "        Set the secret from Linear (Settings → API → Webhooks),\n" +
      "        or set FLEET_ALLOW_UNSIGNED_WEBHOOKS=1 explicitly for local dev.",
  );
  process.exit(1);
}

if (!config.linear.webhookSecret) {
  console.warn(
    "[serve] FLEET_ALLOW_UNSIGNED_WEBHOOKS=1 — running without signature verification (do not use in production)",
  );
}

// Idempotent — upserts the default repo row from env on every startup.
// Without this, enqueue would FK-fail because repos is empty.
const repo = await ensureDefaultRepo();
if (repo) {
  console.log(`[serve] default repo: ${repo.slug} (${repo.githubFullName})`);
} else {
  console.warn(
    "[serve] no default repo configured (set GITHUB_DEFAULT_REPO + REPO_PATH)",
  );
}

const app = buildApp();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[serve] listening on http://localhost:${info.port}`);
  console.log(`[serve] webhook: POST /linear/webhook`);
});
