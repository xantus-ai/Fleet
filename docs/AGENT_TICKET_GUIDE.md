# Linear ticket guide for the fleet

This document tells the agent (or human) that creates Linear tickets
how to shape them so the **fleet** — an autonomous agent that picks
up `agent-ready`-labelled tickets and opens GitHub PRs — can complete
them in a single run.

A ticket that follows this guide gets implemented in 5-15 minutes
for ~$1-3. A ticket that doesn't follow it either fails (turn cap,
unclear scope) or burns budget without producing a mergeable PR.

If you're routing a request to the fleet and it doesn't fit the
shape below, **split it before filing** rather than filing one big
ticket and hoping.

---

## Hard rules

These are non-negotiable. Tickets that violate them will fail.

1. **One ticket = one PR = one logical change.** If you find yourself
   writing "and also" more than once, split.
2. **Estimated agent budget per ticket: 80 turns / $5 / 30 minutes.**
   These are the fleet's defaults. Feature ambition must fit.
3. **No multi-stack changes in one ticket.** Backend + frontend = at
   least two tickets. Schema migration = its own ticket. The agent
   loses coherence across stacks at scale, and reviewers can't
   sensibly approve them together either.
4. **Decisions are made in the ticket, not in the agent.** Don't
   write "consider X or Y" — pick one. Agents can't make
   architectural choices on the fly under turn pressure.
5. **Every file reference must be a verified path** (e.g.
   `api/src/routes/auth.ts:34`). If you reference a line
   number, it must currently match what's in the file. Stale paths
   make the agent re-explore and burn turns.
6. **Verify against `main` and date-stamp the ticket** ("Current
   state verified 2026-05-04 against `main`"). Tickets older than
   ~2 weeks must be re-verified before re-labelling `agent-ready`.

---

## Required body sections

Every ticket body must contain these sections, in this order. If a
section is genuinely empty, write `_(none)_` — don't omit it.

### 1. Objective (1-2 sentences)

The user-facing or system-level goal in plain language. Avoid
jargon. Should fit in a tweet.

> **Bad:** "Improve auth resilience."
> **Good:** "Let users sign in with Google so we stop losing prospects
> at the password-creation step."

### 2. Context

What currently exists, with verified file paths and line numbers.
The agent does not need to re-explore the codebase if this section
is complete.

Include:
- Schema/state of relevant tables, in the form `users.password_hash
  VARCHAR(255) NOT NULL` (`api/src/db/schema.ts:41`).
- Behaviour of the function you're modifying, summarised. The agent
  has the source — you're providing the *map*.
- What's already in place that the new work should reuse (helpers,
  patterns, plugins).

### 3. Exact steps

Numbered changes. Each step must include:
- **Where** (file path with line range if relevant).
- **What** (the actual change, not a goal).
- **Why** only when it would surprise a reader.

Example:

> 1. **`api/src/db/schema.ts`** — make
>    `users.password_hash` nullable. Add an idempotent
>    `ALTER COLUMN ... DROP NOT NULL` so it can run on existing data.
> 2. **`api/src/routes/auth.ts:34-167`** — extract the
>    new-account setup (user insert, default settings, welcome email)
>    into `api/src/lib/create-user.ts`. The existing
>    `/register` handler calls the helper instead of inlining.

### 4. Verification

Concrete commands the agent should run before pushing. If the agent
can't verify, the fleet refuses to open the PR.

Examples:
- `cd api && npx tsc --noEmit`
- `cd web && npm test -- src/components/auth`
- `cd api && npm run migrate -- --dry-run`

### 5. Out of scope

What this ticket does **not** do. Especially important when the
ticket touches a complex area where the agent might be tempted to
"clean up while it's there."

### 6. Risks

Anything subtle that could go wrong. Examples:
- Data migration on a populated table
- Race conditions with existing sessions
- Backwards compatibility with deployed clients
- Security-sensitive flows (auth, payments, secrets)

If a risk is severe enough that a wrong implementation would corrupt
production data, **flag it explicitly** so the reviewer treats the PR
with appropriate care.

---

## Optional but recommended sections

### Acceptance criteria

A checklist the reviewer (and the agent) uses to know when the work
is done. Phrase as `[ ] User can do X` or `[ ] Y is true`.

### Depends on

When ticket B can't be merged until ticket A is, link it in Linear
using the native blocks / blocked-by relation. Do **not** also inline
ticket A's content into ticket B's body — the fleet now attaches each
merged blocker's title, body, PR URL, and `overview.md` to ticket B's
prompt automatically (see `docs/cross-task-context.md`). Inline
only what the blocker ticket *failed* to capture (a decision that
lives only in a Slack thread, a constraint discovered after merge,
etc.).

Two ordering guarantees fall out of the Linear link:

- **Scheduling**: `claimNext` will not start B until every blocker
  is `done`. No human action needed beyond the link.
- **Context**: B's agent receives the merged blockers' overviews +
  bodies in its prompt. Single-hop only — if A blocks B blocks C, C
  sees B but not A. A's effect on C is mediated by B (in the merged
  code and in B's overview).

The fleet does not enforce *PR-merge* ordering — that's still on the
human reviewer. State the dependency in Linear so the reviewer merges
in the right order.

---

## Splitting heuristics

When a ticket feels too big, split along these axes (in order of
preference):

1. **By stack:** schema → backend → frontend. Each is a separate PR
   touching a different part of the tree.
2. **By extraction:** if the work is "do X using a shared helper,"
   make the shared helper its own ticket first.
3. **By provider/instance:** "Add Google + GitHub OAuth" → one
   ticket per provider. Identical scaffolding the second time;
   different bug surfaces.
4. **By verb:** add the schema column first, backfill it second,
   start writing to it third, start reading from it fourth. Each
   step lands independently and is safely revertable.
5. **By "happy path" vs "edge cases":** ship the working flow, then
   a follow-up for error handling and rare cases. Avoid this split
   for security-critical flows where the edge case **is** the
   security guarantee.

If a single ticket needs more than ~80 turns, you've split too
late. The right unit is "one PR a senior reviewer can read in 15-20
minutes and approve in confidence."

---

## Style

- Terse, action-oriented. No marketing copy. No "we should..."
- Bullet lists where possible. The agent parses them more reliably
  than prose.
- Code blocks for code-shaped things (file paths, snippets, env
  vars). Don't put them in inline backticks where they wrap.
- No screenshots — the agent can't see them. Describe the UI in
  words ("a button labelled `Continue with Google` to the left of
  the email field, identical styling to the existing
  `secondaryButton` component").
- Don't reference Slack threads, internal documents the agent can't
  access, or live URLs that change. Inline what's needed.

---

## A worked example: a well-shaped ticket

Title: **APP-42c: Add Google OAuth backend (routes + callback)**

Body:

```markdown
## Objective

Let users sign in with Google. The `/api/auth/google` route starts
the OAuth flow; `/callback` exchanges the code, finds or creates the
user, and returns a JWT identical in shape to `/api/auth/login`.

## Context

Verified against `main` on 2026-05-05. The fleet will attach
APP-42a's and APP-42b's merged context (overviews + bodies + PR
links) to this ticket's prompt automatically — that covers the schema
columns and the `createUser` helper signature. Beyond that:

- JWT signing is wired via `fastify.jwt` plugin
  (`api/src/index.ts:42`).
- `@fastify/oauth2` is already a dependency (`package.json:31`).

## Exact steps

1. **`api/src/routes/oauth-google.ts`** (new) — register
   the Google OAuth2 plugin scope (`openid`, `email`, `profile`),
   redirect URI from `process.env.GOOGLE_OAUTH_REDIRECT_URI`. Two
   routes: `GET /api/auth/google` (start) and
   `GET /api/auth/google/callback` (finish).

2. **Callback handler** flow:
   1. Exchange the code for tokens.
   2. Fetch `userinfo` from Google. Reject if `email_verified !== true`.
   3. Look up `users` by `(auth_provider='google', provider_user_id=sub)`.
      If found → sign JWT, return `{user, token}`.
   4. Else look up by verified email. If found and existing
      `auth_provider='password'` → link this OAuth identity to the
      existing user; send `linked-new-method` email. If existing
      `auth_provider` is a *different* OAuth provider → return
      `409` with body `{error: "use_different_provider", existing: "github"}`.
   5. Else → call `createUser({...})`. Return same shape.

3. **`api/src/index.ts`** — register the new route file
   only if `GOOGLE_OAUTH_CLIENT_ID` is set. If not set, log
   `[oauth] google disabled (no client id)` once at startup.

4. **`api/.env.example`** — add `GOOGLE_OAUTH_CLIENT_ID`,
   `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` with
   localhost defaults for dev.

## Verification

- `cd api && npx tsc --noEmit` passes.
- `cd api && npm test -- routes/oauth-google` passes.
- Manually: with a Google test app's credentials in `.env`, hit
  `http://localhost:3000/api/auth/google` in a browser, complete
  consent, land back on the SPA with a valid JWT. (Manual step
  noted for the reviewer; the agent doesn't perform browser tests.)

## Out of scope

- GitHub OAuth — separate ticket (APP-42d).
- Frontend "Continue with Google" buttons — APP-42e.
- Account linking UI in account settings — APP-42f.

## Risks

- **Email collision with existing password account:** the upsert
  must be safe only when Google reports `email_verified=true`. A
  malicious account hijack flow exists if we trust unverified emails.
  Reject the request if `email_verified !== true` rather than
  prompting the user.
- **Provider mismatch:** if the email exists with
  `auth_provider='github'`, do **not** silently link a new Google
  identity. Return the `409 use_different_provider` shape so the UI
  can show "Sign in with GitHub instead."

## Depends on

- APP-42a (schema migration) — merged.
- APP-42b (`createUser` helper) — merged.

## Acceptance criteria

- [ ] `GET /api/auth/google` returns 302 to Google when configured,
      404 when not.
- [ ] Callback creates a new user via `createUser` if no match.
- [ ] Callback links to an existing password account when emails
      match (verified) and existing `auth_provider='password'`.
- [ ] Callback returns `409 use_different_provider` on provider
      mismatch.
- [ ] All paths covered in `routes/oauth-google.test.ts`.
```

This ticket fits comfortably in 80 turns: one new file, two route
handlers, one config update, three test cases. The agent doesn't
have to make any structural decisions or learn the surrounding
system from scratch — every dependency is named and pre-verified,
and merged blockers (APP-42a, APP-42b) arrive in the prompt
automatically.
