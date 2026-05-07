import { config } from "../config.ts";
import type { Task } from "../queue/db.ts";
import type {
  FailureDiagnostics,
  LinearAdapter,
  ProgressEvent,
} from "./adapter.ts";

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

const COMMENT_CREATE = `
  mutation CommentCreate($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment { id }
    }
  }
`;

const ISSUE_TEAM_STATES = `
  query IssueTeamStates($id: String!) {
    issue(id: $id) {
      team {
        id
        states { nodes { id name type } }
      }
    }
  }
`;

const ISSUE_UPDATE_STATE = `
  mutation IssueUpdateState($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
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

type IssueTeamStatesResp = {
  issue: {
    team: {
      id: string;
      states: { nodes: Array<{ id: string; name: string; type: string }> };
    } | null;
  } | null;
};

const issueToTeam = new Map<string, string>();
const teamStates = new Map<string, Map<string, string>>();

async function loadStatesForIssue(issueId: string): Promise<Map<string, string> | null> {
  const cachedTeamId = issueToTeam.get(issueId);
  if (cachedTeamId) {
    const cached = teamStates.get(cachedTeamId);
    if (cached) return cached;
  }
  const data = await gql<IssueTeamStatesResp>(ISSUE_TEAM_STATES, { id: issueId });
  const team = data.issue?.team;
  if (!team) return null;
  const map = new Map<string, string>();
  for (const s of team.states.nodes) map.set(s.name.toLowerCase(), s.id);
  issueToTeam.set(issueId, team.id);
  teamStates.set(team.id, map);
  return map;
}

async function setIssueState(issueId: string, stateName: string): Promise<void> {
  if (!stateName) return;
  if (!config.linear.apiKey) {
    console.log(`[linear:dryrun] ${issueId} → state "${stateName}"`);
    return;
  }
  try {
    const states = await loadStatesForIssue(issueId);
    if (!states) {
      console.warn(`[linear] no team found for issue ${issueId}; skipping state change`);
      return;
    }
    const stateId = states.get(stateName.toLowerCase());
    if (!stateId) {
      console.warn(
        `[linear] state "${stateName}" not found on issue ${issueId}'s team; skipping`,
      );
      return;
    }
    await gql(ISSUE_UPDATE_STATE, { id: issueId, stateId });
  } catch (e) {
    console.warn(`[linear] failed to set state "${stateName}" on ${issueId}: ${e}`);
  }
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

export function formatFailure(task: Task, diag: FailureDiagnostics): string {
  const lines: string[] = [`:x: Fleet run failed: ${diag.error}`, ""];

  if (diag.finalAssistantText) {
    const quoted = diag.finalAssistantText
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    lines.push(quoted, "");
  }

  if (diag.recentToolCalls.length > 0) {
    lines.push("**Last tool calls:**");
    for (const c of diag.recentToolCalls) {
      const mark = c.ok === false ? ":x:" : c.ok === true ? ":white_check_mark:" : "·";
      const summary = c.summary.length > 0 ? ` ${c.summary}` : "";
      lines.push(`- ${mark} \`${c.name}\`${summary}`);
    }
    lines.push("");
  }

  lines.push(
    `Task \`${task.id}\`. Branch \`${task.branchName ?? "—"}\` left for inspection.`,
  );
  return lines.join("\n");
}

export const webhookAdapter: LinearAdapter = {
  async notifyStarted(task) {
    await comment(
      task.linearIssueId,
      `:robot_face: Picked up by fleet (task \`${task.id}\`). Branch will be \`${
        task.branchName ?? "agent/" + (task.linearIssueIdentifier ?? task.id.slice(0, 8))
      }\`.`,
    );
    await setIssueState(task.linearIssueId, config.linear.stateInProgress);
  },
  async notifyProgress(task, event) {
    const text = fmtProgress(event);
    if (text) await comment(task.linearIssueId, text);
  },
  async notifyPrOpened(task, prUrl) {
    await comment(task.linearIssueId, `PR opened: ${prUrl}`);
    await setIssueState(task.linearIssueId, config.linear.stateInReview);
  },
  async notifyDone(task) {
    await comment(
      task.linearIssueId,
      `:white_check_mark: Done. Awaiting review and merge.`,
    );
  },
  async notifyFailed(task, diag) {
    await comment(task.linearIssueId, formatFailure(task, diag));
  },
};
