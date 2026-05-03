/**
 * Defense-in-depth Bash allowlist. Returns null on allow, or a string
 * reason on deny. Designed to be conservative: when in doubt, deny.
 *
 * The fleet rules in the system prompt also tell the agent what's
 * allowed — this layer enforces it.
 */

const FORBIDDEN_SUBSTRINGS = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf $",
  ":(){:|:&};:", // fork bomb
  "sudo ",
  "shutdown",
  "reboot ",
  "mkfs",
  "dd if=",
  "/etc/passwd",
  "/etc/shadow",
  "chmod 777 /",
  "chown -R / ",
];

const ALLOWED_PROGRAMS = new Set([
  "git",
  "gh",
  "pnpm",
  "npm",
  "yarn",
  "bun",
  "node",
  "npx",
  "tsx",
  "tsc",
  "eslint",
  "prettier",
  "vitest",
  "jest",
  "pytest",
  "go",
  "cargo",
  "rustc",
  "make",
  // read-only inspection
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "pwd",
  "env",
  "echo",
  "true",
  "false",
  "test",
  "wc",
  "sort",
  "uniq",
  "diff",
  "cut",
  "awk",
  "sed",
  "tr",
  "xargs",
  "which",
  "type",
]);

const SHELL_OPERATORS = /(\|\||&&|;|\||>|<|`|\$\()/;

/**
 * Pull each top-level command out of a Bash invocation. We don't try to
 * be a full shell parser; we split on common operators and inspect each
 * piece's first token (ignoring leading env var assignments).
 */
function commandsFromInvocation(cmd: string): string[] {
  return cmd
    .split(/\|\||&&|;|\|/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstProgram(piece: string): string | null {
  const tokens = piece.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    // Strip leading env var assignments like FOO=bar
    if (/^[A-Z_][A-Z0-9_]*=/.test(tok)) continue;
    return tok;
  }
  return null;
}

export type AllowDecision = { allow: true } | { allow: false; reason: string };

export function inspectBashCommand(cmd: string): AllowDecision {
  const trimmed = cmd.trim();
  if (!trimmed) return { allow: false, reason: "empty command" };

  for (const bad of FORBIDDEN_SUBSTRINGS) {
    if (trimmed.includes(bad)) {
      return { allow: false, reason: `forbidden pattern: ${bad}` };
    }
  }

  // Backticks and command substitution are too risky to evaluate without
  // a real shell parser. Reject; the agent can do the same work with
  // explicit pipes that we can inspect.
  if (/`|\$\(/.test(trimmed)) {
    return { allow: false, reason: "command substitution not allowed" };
  }

  // Heredocs: `git commit -m "..."` is fine, but `cat << EOF | sh` isn't.
  if (/<<\s*['"]?\w+['"]?/.test(trimmed) && /\|\s*sh\b/.test(trimmed)) {
    return { allow: false, reason: "piping heredoc to shell not allowed" };
  }

  // Network: `curl` and `wget` go to arbitrary hosts; deny by default.
  if (/(^|\s)(curl|wget)\b/.test(trimmed)) {
    return { allow: false, reason: "curl/wget not allowed" };
  }

  for (const piece of commandsFromInvocation(trimmed)) {
    const prog = firstProgram(piece);
    if (!prog) continue;
    // Allow simple variable echoing or `cd <dir>` etc.
    if (prog === "cd" || prog === ":") continue;
    if (!ALLOWED_PROGRAMS.has(prog)) {
      return { allow: false, reason: `program not in allowlist: ${prog}` };
    }
  }

  // Even if pieces are individually allowed, redirecting outside the
  // worktree is suspicious. We only catch the obvious case.
  if (/>\s*\/(?:etc|usr|bin|sbin|var|root|System)/.test(trimmed)) {
    return { allow: false, reason: "redirect to system path not allowed" };
  }

  // Special case: `git push` to anything other than origin or our branch
  // namespace is fine to allow — branch protection on the server side is
  // the real defense. We just catch the obvious "push to main" attempt.
  if (/\bgit\s+push\b.*\b(?:origin\s+)?(?:HEAD:)?(?:refs\/heads\/)?main\b/.test(trimmed)) {
    return { allow: false, reason: "must not push to main directly" };
  }

  return { allow: true };
}
