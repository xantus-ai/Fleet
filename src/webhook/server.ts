import { Hono } from "hono";
import { config } from "../config.ts";
import { enqueue } from "../queue/claim.ts";
import { recordDependencies } from "../queue/dependencies.ts";
import {
  buildDependencyGraph,
  fetchLinearRelations,
  type FetchIssueRelations,
} from "../linear/dependencyGraph.ts";
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

/**
 * After enqueuing the labelled issue, walk its blocks/blocked-by graph
 * in Linear and enqueue every reachable issue, then record the
 * blocker→blocked edges so claimNext gates dependent tasks correctly.
 *
 * Errors here are logged and swallowed: the labelled issue is already
 * enqueued and will run on its own. Dependents can still be labelled
 * manually if the chain walk fails.
 */
export async function expandDependencyChain(
  rootIssueId: string,
  rootTaskId: string,
  fetchRelations: FetchIssueRelations = fetchLinearRelations,
): Promise<void> {
  const graph = await buildDependencyGraph(rootIssueId, fetchRelations);

  const issueToTask = new Map<string, string>([[rootIssueId, rootTaskId]]);

  for (const [issueId, node] of graph.issues) {
    if (issueId === rootIssueId) continue;
    const result = await enqueue({
      linearIssueId: issueId,
      linearIssueIdentifier: node.identifier,
      title: node.title,
      body: node.body,
      repo: null,
    });
    issueToTask.set(issueId, result.task.id);
  }

  const edges: { taskId: string; blockerTaskId: string }[] = [];
  for (const [issueId, blockerIds] of graph.blockers) {
    const taskId = issueToTask.get(issueId);
    if (!taskId) continue;
    for (const blockerIssueId of blockerIds) {
      const blockerTaskId = issueToTask.get(blockerIssueId);
      if (!blockerTaskId || blockerTaskId === taskId) continue;
      edges.push({ taskId, blockerTaskId });
    }
  }
  await recordDependencies(edges);
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

    // Pass null and let the worker's resolveRepo() pick the default at
    // run time. tasks.repo is an FK to repos.slug (a basename, not the
    // full owner/name), so passing config.github.defaultRepo here would
    // FK-fail. Multi-repo routing — when added — assigns a slug at this
    // point instead of relying on the default.
    const result = await enqueue({
      linearIssueId: payload.data.id,
      linearIssueIdentifier: payload.data.identifier ?? null,
      title: payload.data.title ?? "(untitled)",
      body: payload.data.description ?? null,
      repo: null,
    });

    // Run on both enqueued and duplicate so descendants can be filled in
    // retroactively if they were missing on a prior webhook (e.g. label
    // applied before this feature was deployed). Both the Linear queries
    // and the DB writes are idempotent.
    if (config.linear.apiKey) {
      try {
        await expandDependencyChain(payload.data.id, result.task.id);
      } catch (err) {
        console.error(
          `[webhook] dependency chain walk failed for ${payload.data.identifier ?? payload.data.id}:`,
          err,
        );
      }
    }

    return c.json({
      kind: result.kind,
      taskId: result.task.id,
      status: result.task.status,
    });
  });

  return app;
}
