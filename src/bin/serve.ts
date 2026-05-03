import { serve } from "@hono/node-server";
import { config } from "../config.ts";
import { buildApp } from "../webhook/server.ts";

const app = buildApp();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[serve] listening on http://localhost:${info.port}`);
  console.log(`[serve] webhook: POST /linear/webhook`);
});
