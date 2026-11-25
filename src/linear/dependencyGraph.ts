import { config } from "../config.ts";

export type IssueNode = {
  id: string;
  identifier: string | null;
  title: string;
  body: string | null;
};

export type IssueRelations = {
  issue: IssueNode;
  blocks: string[];
  blockedBy: string[];
};

export type FetchIssueRelations = (issueId: string) => Promise<IssueRelations>;

export type DependencyGraph = {
  issues: Map<string, IssueNode>;
  blockers: Map<string, Set<string>>;
};

/**
 * Walk Linear's blocks/blocked-by graph from a starting issue, in both
 * directions, and return every reachable issue plus its set of direct
 * blockers. The walk is a BFS over the union of relations and
 * inverseRelations of type 'blocks', visiting each issue at most once.
 *
 * The graph is allowed to contain diamonds (multiple blockers per issue);
 * cycles terminate cleanly via the visited set.
 */
export async function buildDependencyGraph(
  rootId: string,
  fetch: FetchIssueRelations,
): Promise<DependencyGraph> {
  const issues = new Map<string, IssueNode>();
  const blockers = new Map<string, Set<string>>();
  const queue: string[] = [rootId];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const result = await fetch(id);
    issues.set(id, result.issue);
    blockers.set(id, new Set(result.blockedBy));

    for (const next of result.blocks) {
      if (!visited.has(next)) queue.push(next);
    }
    for (const next of result.blockedBy) {
      if (!visited.has(next)) queue.push(next);
    }
  }

  return { issues, blockers };
}

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

const ISSUE_RELATIONS = `
  query IssueRelations($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      relations {
        nodes {
          type
          relatedIssue { id }
        }
      }
      inverseRelations {
        nodes {
          type
          issue { id }
        }
      }
    }
  }
`;

type LinearIssueResponse = {
  issue: {
    id: string;
    identifier: string | null;
    title: string;
    description: string | null;
    relations: {
      nodes: Array<{ type: string; relatedIssue: { id: string } | null }>;
    };
    inverseRelations: {
      nodes: Array<{ type: string; issue: { id: string } | null }>;
    };
  } | null;
};

export const fetchLinearRelations: FetchIssueRelations = async (issueId) => {
  if (!config.linear.apiKey) {
    throw new Error("LINEAR_API_KEY not set");
  }
  const res = await fetch(LINEAR_GRAPHQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: config.linear.apiKey,
    },
    body: JSON.stringify({ query: ISSUE_RELATIONS, variables: { id: issueId } }),
  });
  if (!res.ok) {
    throw new Error(`linear graphql ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    data?: LinearIssueResponse;
    errors?: unknown;
  };
  if (json.errors) {
    throw new Error(`linear graphql errors: ${JSON.stringify(json.errors)}`);
  }
  const issue = json.data?.issue;
  if (!issue) {
    throw new Error(`linear issue not found: ${issueId}`);
  }

  const blocks = issue.relations.nodes
    .filter((n) => n.type === "blocks" && n.relatedIssue)
    .map((n) => n.relatedIssue!.id);
  const blockedBy = issue.inverseRelations.nodes
    .filter((n) => n.type === "blocks" && n.issue)
    .map((n) => n.issue!.id);

  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      body: issue.description,
    },
    blocks,
    blockedBy,
  };
};
