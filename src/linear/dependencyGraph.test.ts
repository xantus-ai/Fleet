import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDependencyGraph,
  type FetchIssueRelations,
  type IssueNode,
  type IssueRelations,
} from "./dependencyGraph.ts";

function node(id: string): IssueNode {
  return { id, identifier: id, title: id, body: null };
}

function fakeFetcher(
  graph: Record<string, { blocks: string[]; blockedBy: string[] }>,
): FetchIssueRelations & { calls: string[] } {
  const calls: string[] = [];
  const fetch = async (id: string): Promise<IssueRelations> => {
    calls.push(id);
    const entry = graph[id];
    if (!entry) throw new Error(`no fixture for ${id}`);
    return { issue: node(id), blocks: entry.blocks, blockedBy: entry.blockedBy };
  };
  return Object.assign(fetch, { calls });
}

test("walks a linear chain in both directions from any starting point", async () => {
  // 183 -> 184 -> 185 (each "blocks" the next)
  const fetch = fakeFetcher({
    "183": { blocks: ["184"], blockedBy: [] },
    "184": { blocks: ["185"], blockedBy: ["183"] },
    "185": { blocks: [], blockedBy: ["184"] },
  });

  const graph = await buildDependencyGraph("184", fetch);

  assert.deepEqual(
    [...graph.issues.keys()].sort(),
    ["183", "184", "185"],
  );
  assert.deepEqual([...graph.blockers.get("184")!], ["183"]);
  assert.deepEqual([...graph.blockers.get("185")!], ["184"]);
  assert.deepEqual([...graph.blockers.get("183")!], []);
});

test("captures every blocker for diamond dependencies", async () => {
  // 188 is blocked by 185, 186, AND 187
  const fetch = fakeFetcher({
    "183": { blocks: ["184", "185"], blockedBy: [] },
    "184": { blocks: ["185"], blockedBy: ["183"] },
    "185": { blocks: ["186", "187", "188"], blockedBy: ["183", "184"] },
    "186": { blocks: ["187", "188"], blockedBy: ["185"] },
    "187": { blocks: ["188"], blockedBy: ["185", "186"] },
    "188": { blocks: [], blockedBy: ["185", "186", "187"] },
  });

  const graph = await buildDependencyGraph("183", fetch);

  assert.equal(graph.issues.size, 6);
  assert.deepEqual(
    [...graph.blockers.get("188")!].sort(),
    ["185", "186", "187"],
  );
  assert.deepEqual(
    [...graph.blockers.get("187")!].sort(),
    ["185", "186"],
  );
});

test("terminates on cycles without infinite looping", async () => {
  // A blocks B, B blocks A — pathological but must not hang.
  const fetch = fakeFetcher({
    A: { blocks: ["B"], blockedBy: ["B"] },
    B: { blocks: ["A"], blockedBy: ["A"] },
  });

  const graph = await buildDependencyGraph("A", fetch);

  assert.deepEqual([...graph.issues.keys()].sort(), ["A", "B"]);
  assert.equal(fetch.calls.length, 2);
});

test("visits each issue exactly once even when reached via multiple paths", async () => {
  // 183 reaches 188 via 184->185 and via 185 directly. Should fetch
  // 188 once.
  const fetch = fakeFetcher({
    "183": { blocks: ["184", "185"], blockedBy: [] },
    "184": { blocks: ["188"], blockedBy: ["183"] },
    "185": { blocks: ["188"], blockedBy: ["183"] },
    "188": { blocks: [], blockedBy: ["184", "185"] },
  });

  await buildDependencyGraph("183", fetch);

  const counts = fetch.calls.reduce<Record<string, number>>((acc, id) => {
    acc[id] = (acc[id] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counts, { "183": 1, "184": 1, "185": 1, "188": 1 });
});
