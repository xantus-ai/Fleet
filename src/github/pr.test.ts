import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrBody } from "./pr.ts";
import type { Task } from "../queue/db.ts";

const baseTask: Task = {
  id: "11111111-2222-3333-4444-555555555555",
  linearIssueId: "lin-1",
  linearIssueIdentifier: "ENG-42",
  title: "Add a --version flag",
  body: "It would be nice to print the version on `--version`.",
  repo: "myrepo",
  branchName: "agent/eng-42-add-version-flag",
  status: "pr_open",
  claimedBy: null,
  claimedAt: null,
  heartbeatAt: null,
  prUrl: null,
  error: null,
  attemptCount: 1,
  budgetTokensRemaining: null,
  budgetSecondsRemaining: null,
  costUsd: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

test("PR body includes the Linear identifier and a back-link footer", () => {
  const body = buildPrBody(baseTask);
  assert.match(body, /^Implements ENG-42\./);
  assert.match(body, /Linear ticket `ENG-42`/);
  assert.match(body, /task `11111111-/);
});

test("PR body adds an Overview section when an overview is given", () => {
  const overview =
    "Adds a `--version` flag to the CLI so users can confirm the installed version when filing support tickets.";
  const body = buildPrBody(baseTask, overview);
  assert.match(body, /## Overview/);
  assert.match(body, /Adds a `--version` flag/);
});

test("PR body omits the Overview section when overview is empty", () => {
  const body = buildPrBody(baseTask, "");
  assert.doesNotMatch(body, /## Overview/);
});

test("PR body quotes the original ticket body under its own heading", () => {
  const body = buildPrBody(baseTask);
  assert.match(body, /## Original ticket/);
  assert.match(body, /^> It would be nice/m);
});
