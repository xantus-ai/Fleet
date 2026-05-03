import { Hono } from "hono";
import { config } from "../config.ts";
import { enqueue } from "../queue/claim.ts";
import { verifyLinearSignature } from "./verify.ts";

type LinearLabel = { id: string; name: string } | string;

type LinearIssuePayload = {
  action: "create" | "update" | "remove";
  type: string;
  data: {
    id: string;
    identifier?: string;
    title?: string;
    description?: string;
    labels?: LinearLabel[];
    labelIds?: string[];
    state?: { name?: string };
  };
  url?: string;
  updatedFrom?: { labelIds?: string[] };
};

function labelNames(payload: LinearIssuePayload): string[] {
  const labels = payload.data.labels ?? [];
  return labels
    .map((l) => (typeof l === "string" ? l : l.name))
    .filter((s): s is string => typeof s === "string");
}

function shouldTrigger(payload: LinearIssuePayload, triggerLabel: string): boolean {
  if (payload.type !== "Issue") return false;
  if (payload.action !== "create" && payload.action !== "update") return false;
  return labelNames(payload).some(
    (n) => n.toLowerCase() === triggerLabel.toLowerCase(),
  );
}

export function buildApp() {
  const app = new Hono();

  app.get("/healthz", (c) => c.text("ok"));

  app.post("/linear/webhook", async (c) => {
    const raw = await c.req.text();
    const sig = c.req.header("linear-signature");

    if (config.linear.webhookSecret) {
      if (!verifyLinearSignature(raw, sig, config.linear.webhookSecret)) {
        return c.json({ error: "bad signature" }, 401);
      }
    }

    let payload: LinearIssuePayload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    if (!shouldTrigger(payload, config.linear.triggerLabel)) {
      return c.json({ ignored: true });
    }

    const result = await enqueue({
      linearIssueId: payload.data.id,
      linearIssueIdentifier: payload.data.identifier ?? null,
      title: payload.data.title ?? "(untitled)",
      body: payload.data.description ?? null,
      repo: config.github.defaultRepo || null,
    });

    return c.json({
      kind: result.kind,
      taskId: result.task.id,
      status: result.task.status,
    });
  });

  return app;
}
