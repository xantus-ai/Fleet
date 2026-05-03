import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTaskRecords,
  extractOverview,
  readOverview,
  recordsFor,
} from "./manager.ts";
import type { Task } from "../queue/db.ts";
import type { RepoConfig } from "../repos/registry.ts";

function fakeTask(): Task {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    linearIssueId: "lin-1",
    linearIssueIdentifier: "ENG-42",
    title: "Add a --version flag",
    body: null,
    repo: "myrepo",
    branchName: null,
    status: "running",
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
}

async function tmpRepo(): Promise<RepoConfig> {
  const dir = await mkdtemp(join(tmpdir(), "fleet-records-test-"));
  return {
    slug: "myrepo",
    githubFullName: "owner/myrepo",
    defaultBranch: "main",
    workdir: join(dir, "myrepo"),
    worktreeRoot: join(dir, "myrepo-worktrees"),
    taskRecordsRoot: join(dir, "myrepo-fleet"),
  };
}

test("extractOverview returns null for an unmodified template", () => {
  const tpl = `# Overview

<!--
Fill in AT THE END.
REPLACE THIS COMMENT WITH THE OVERVIEW.
-->
`;
  assert.equal(extractOverview(tpl), null);
});

test("extractOverview returns null for an empty file", () => {
  assert.equal(extractOverview(""), null);
  assert.equal(extractOverview("# Overview\n\n"), null);
});

test("extractOverview returns null when the only content is too short", () => {
  assert.equal(extractOverview("# Overview\n\nshort"), null);
});

test("extractOverview returns the cleaned content when filled in", () => {
  const filled = `# Overview

Adds a \`--version\` flag to the CLI that prints the package version
from package.json. Useful for support tickets to confirm what is
installed on a user's machine.
`;
  const out = extractOverview(filled);
  assert.ok(out);
  assert.match(out!, /^Adds a `--version` flag/);
  assert.doesNotMatch(out!, /^# Overview/m);
});

test("extractOverview strips leftover HTML comments", () => {
  const mixed = `# Overview

<!-- some leftover comment -->
Implements pagination on the search endpoint to keep response sizes
predictable for large queries.
`;
  const out = extractOverview(mixed);
  assert.ok(out);
  assert.doesNotMatch(out!, /<!--/);
  assert.match(out!, /Implements pagination/);
});

test("createTaskRecords writes three template files in a branch dir", async () => {
  const repo = await tmpRepo();
  const branch = "agent/eng-42-add-version-flag";
  const r = await createTaskRecords({ repo, branch, task: fakeTask() });

  assert.equal(r.dir, join(repo.taskRecordsRoot, branch));
  for (const path of [r.planPath, r.progressPath, r.overviewPath]) {
    const text = await readFile(path, "utf8");
    assert.ok(text.length > 0, `${path} is empty`);
  }
  const plan = await readFile(r.planPath, "utf8");
  assert.match(plan, /ENG-42/);
  assert.match(plan, /agent\/eng-42-add-version-flag/);
});

test("createTaskRecords is idempotent: it does not overwrite an existing file", async () => {
  const repo = await tmpRepo();
  const branch = "agent/eng-99-x";
  const first = await createTaskRecords({ repo, branch, task: fakeTask() });

  await writeFile(first.planPath, "# Plan\n\nManually edited", "utf8");
  await createTaskRecords({ repo, branch, task: fakeTask() });

  assert.equal(
    await readFile(first.planPath, "utf8"),
    "# Plan\n\nManually edited",
  );
});

test("readOverview returns null for an unwritten template and the cleaned content otherwise", async () => {
  const repo = await tmpRepo();
  const branch = "agent/eng-77-y";
  const records = recordsFor(repo, branch);
  await createTaskRecords({ repo, branch, task: fakeTask() });

  assert.equal(await readOverview(records), null);

  await writeFile(
    records.overviewPath,
    "# Overview\n\nThis change moves the rate limiter onto the API gateway so it can be reused by other services.\n",
    "utf8",
  );
  const out = await readOverview(records);
  assert.ok(out);
  assert.match(out!, /^This change moves the rate limiter/);
});
