import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFailure } from "./webhookAdapter.ts";
import type { Task } from "../queue/db.ts";

const baseTask: Task = {
  id: "11111111-2222-3333-4444-555555555555",
  linearIssueId: "lin-issue",
  linearIssueIdentifier: "ENG-42",
  title: "do thing",
  body: null,
  repo: "myrepo",
  branchName: "agent/eng-42-do-thing",
  status: "failed",
  claimedBy: null,
  claimedAt: null,
  heartbeatAt: null,
  prUrl: null,
  overviewText: null,
  error: null,
  attemptCount: 1,
  budgetTokensRemaining: null,
  budgetSecondsRemaining: null,
  costUsd: 0.42,
  createdAt: new Date(),
  updatedAt: new Date(),
};

test("failure comment includes the error and the branch", () => {
  const out = formatFailure(baseTask, {
    error: "tests failed",
    recentToolCalls: [],
  });
  assert.match(out, /Fleet run failed: tests failed/);
  assert.match(out, /agent\/eng-42-do-thing/);
});

test("failure comment quotes the agent's last message", () => {
  const out = formatFailure(baseTask, {
    error: "stopped",
    recentToolCalls: [],
    finalAssistantText: "I tried two approaches\nboth crashed",
  });
  assert.match(out, /^> I tried two approaches$/m);
  assert.match(out, /^> both crashed$/m);
});

test("failure comment lists tool calls with status marks", () => {
  const out = formatFailure(baseTask, {
    error: "stopped",
    recentToolCalls: [
      { name: "Bash", summary: "pnpm test", ok: false },
      { name: "Edit", summary: "src/foo.ts", ok: true },
      { name: "Bash", summary: "pnpm install" }, // unknown ok
    ],
  });
  assert.match(out, /:x:.*`Bash` pnpm test/);
  assert.match(out, /:white_check_mark:.*`Edit` src\/foo\.ts/);
  assert.match(out, /·.*`Bash` pnpm install/);
});

test("failure comment omits sections that have no content", () => {
  const out = formatFailure(baseTask, {
    error: "boom",
    recentToolCalls: [],
  });
  assert.doesNotMatch(out, /Last tool calls/);
});
