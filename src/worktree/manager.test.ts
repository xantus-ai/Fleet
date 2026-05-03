import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBranchName, slugify } from "./manager.ts";

test("slugify lowercases, strips punctuation, collapses dashes", () => {
  assert.equal(slugify("Add a --version flag!"), "add-a-version-flag");
  assert.equal(slugify("  fix:   off-by-one  "), "fix-off-by-one");
});

test("slugify caps length at 40 characters", () => {
  const long = "a".repeat(80);
  assert.equal(slugify(long).length, 40);
});

test("slugify falls back to 'task' for empty input", () => {
  assert.equal(slugify(""), "task");
  assert.equal(slugify("!!!"), "task");
});

test("buildBranchName uses the Linear identifier when present", () => {
  assert.equal(
    buildBranchName({
      identifier: "ENG-123",
      taskId: "abcdef0123",
      title: "Add a --version flag",
    }),
    "agent/eng-123-add-a-version-flag",
  );
});

test("buildBranchName falls back to a task-id prefix without an identifier", () => {
  assert.equal(
    buildBranchName({
      identifier: null,
      taskId: "abcdef0123456789",
      title: "Hi",
    }),
    "agent/abcdef01-hi",
  );
});
