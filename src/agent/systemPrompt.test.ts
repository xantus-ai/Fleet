import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUserPrompt } from "./systemPrompt.ts";
import type { BlockerContext } from "../queue/dependencies.ts";

const records = {
  planPath: "/tmp/plan.md",
  progressPath: "/tmp/progress.md",
  overviewPath: "/tmp/overview.md",
};

const baseArgs = {
  identifier: "ENG-2",
  title: "Add Google OAuth backend",
  body: "Implement /api/auth/google start + callback.",
  branch: "agent/eng-2-add-google-oauth-backend",
  records,
};

test("buildUserPrompt omits the Related context section when no blockers", () => {
  const out = buildUserPrompt({ ...baseArgs, blockers: [] });
  assert.ok(!out.includes("Related context"));
  assert.ok(out.includes("# ENG-2: Add Google OAuth backend"));
});

test("buildUserPrompt omits the Related context section when blockers is undefined", () => {
  const out = buildUserPrompt(baseArgs);
  assert.ok(!out.includes("Related context"));
});

test("buildUserPrompt renders a single blocker with identifier, PR, overview, body", () => {
  const blocker: BlockerContext = {
    identifier: "ENG-1",
    title: "Schema migration for OAuth columns",
    body: "Add auth_provider, provider_user_id, email_verified columns.",
    prUrl: "https://github.com/owner/repo/pull/100",
    overviewText: "Added three columns to users for OAuth identity tracking.",
  };
  const out = buildUserPrompt({ ...baseArgs, blockers: [blocker] });
  assert.ok(out.includes("## Related context (already merged)"));
  assert.ok(out.includes("### ENG-1: Schema migration for OAuth columns"));
  assert.ok(out.includes("PR: https://github.com/owner/repo/pull/100"));
  assert.ok(out.includes("Added three columns to users for OAuth identity tracking."));
  assert.ok(out.includes("<summary>Original ticket body</summary>"));
  assert.ok(out.includes("Add auth_provider, provider_user_id, email_verified columns."));
});

test("buildUserPrompt renders multiple blockers in given order", () => {
  const blockers: BlockerContext[] = [
    {
      identifier: "ENG-1",
      title: "First",
      body: "first body",
      prUrl: "https://example.com/1",
      overviewText: "first overview",
    },
    {
      identifier: "ENG-1b",
      title: "Second",
      body: "second body",
      prUrl: "https://example.com/2",
      overviewText: "second overview",
    },
  ];
  const out = buildUserPrompt({ ...baseArgs, blockers });
  const firstIdx = out.indexOf("ENG-1: First");
  const secondIdx = out.indexOf("ENG-1b: Second");
  assert.ok(firstIdx > 0 && secondIdx > 0);
  assert.ok(firstIdx < secondIdx, "blockers should render in input order");
});

test("buildUserPrompt truncates long blocker bodies and marks the cut", () => {
  const longBody = "x".repeat(5000);
  const blocker: BlockerContext = {
    identifier: "ENG-1",
    title: "Big ticket",
    body: longBody,
    prUrl: null,
    overviewText: null,
  };
  const out = buildUserPrompt({ ...baseArgs, blockers: [blocker] });
  assert.ok(out.includes("…(truncated; see PR description for full context)"));
  // Original full body should not appear verbatim
  assert.ok(!out.includes(longBody));
});

test("buildUserPrompt renders gracefully when overviewText is null", () => {
  const blocker: BlockerContext = {
    identifier: "ENG-1",
    title: "No overview yet",
    body: "Body still helpful.",
    prUrl: null,
    overviewText: null,
  };
  const out = buildUserPrompt({ ...baseArgs, blockers: [blocker] });
  assert.ok(out.includes("### ENG-1: No overview yet"));
  assert.ok(out.includes("Body still helpful."));
  assert.ok(!out.includes("PR: "));
});

test("buildUserPrompt renders blocker without identifier using just title", () => {
  const blocker: BlockerContext = {
    identifier: null,
    title: "Untagged blocker",
    body: null,
    prUrl: "https://example.com/9",
    overviewText: "Overview only.",
  };
  const out = buildUserPrompt({ ...baseArgs, blockers: [blocker] });
  assert.ok(out.includes("### Untagged blocker"));
  assert.ok(!out.includes("<summary>Original ticket body</summary>"));
});
