import { config } from "../config.ts";
import type { Task } from "../queue/db.ts";
import type { LinearAdapter, ProgressEvent } from "./adapter.ts";

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

const COMMENT_CREATE = `
  mutation CommentCreate($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment { id }
    }
  }
`;

async function gql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  if (!config.linear.apiKey) {
    throw new Error("LINEAR_API_KEY not set");
  }
  const res = await fetch(LINEAR_GRAPHQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: config.linear.apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`linear graphql ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) {
    throw new Error(`linear graphql errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

async function comment(issueId: string, body: string): Promise<void> {
  if (!config.linear.apiKey) {
    console.log(`[linear:dryrun] ${issueId} ← ${body}`);
    return;
  }
  await gql(COMMENT_CREATE, { issueId, body });
}

function fmtProgress(e: ProgressEvent): string | null {
  switch (e.kind) {
    case "warning":
      return `:warning: ${e.text}`;
    case "tool_result":
      return e.ok ? null : `Tool \`${e.name}\` failed: ${e.summary ?? ""}`;
    default:
      return null;
  }
}

export const webhookAdapter: LinearAdapter = {
  async notifyStarted(task) {
    await comment(
      task.linearIssueId,
      `:robot_face: Picked up by fleet (task \`${task.id}\`). Branch will be \`${
        task.branchName ?? "agent/" + (task.linearIssueIdentifier ?? task.id.slice(0, 8))
      }\`.`,
    );
  },
  async notifyProgress(task, event) {
    const text = fmtProgress(event);
    if (text) await comment(task.linearIssueId, text);
  },
  async notifyPrOpened(task, prUrl) {
    await comment(task.linearIssueId, `PR opened: ${prUrl}`);
  },
  async notifyDone(task) {
    await comment(
      task.linearIssueId,
      `:white_check_mark: Done. Awaiting review and merge.`,
    );
  },
  async notifyFailed(task, error) {
    await comment(
      task.linearIssueId,
      `:x: Fleet run failed: ${error}\n\nTask \`${task.id}\`. Branch left in place for inspection.`,
    );
  },
};
