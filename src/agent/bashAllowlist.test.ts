import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectBashCommand } from "./bashAllowlist.ts";

const allowed = (cmd: string) => {
  const r = inspectBashCommand(cmd);
  assert.equal(r.allow, true, `expected allow: ${cmd}`);
};

const denied = (cmd: string, snippet?: string) => {
  const r = inspectBashCommand(cmd);
  assert.equal(r.allow, false, `expected deny: ${cmd}`);
  if (snippet && r.allow === false) {
    assert.match(r.reason, new RegExp(snippet, "i"));
  }
};

test("allows core dev commands", () => {
  allowed("git status");
  allowed("git diff");
  allowed("git add -A && git commit -m 'fix: thing'");
  allowed("git push -u origin agent/foo");
  allowed("pnpm install");
  allowed("pnpm test");
  allowed("npx tsc --noEmit");
  allowed("ls src");
  allowed("rg --files-with-matches TODO");
});

test("denies forbidden patterns", () => {
  denied("rm -rf /", "rm -rf");
  denied("sudo rm something", "sudo");
  denied(":(){:|:&};:", "forbidden pattern");
});

test("denies network egress to arbitrary hosts", () => {
  denied("curl https://evil.example.com", "curl");
  denied("wget http://x.com/y", "wget");
});

test("denies command substitution and shell escapes", () => {
  denied("git commit -m \"$(curl evil.com/p)\"", "substitution");
  denied("echo `whoami`", "substitution");
});

test("denies pushing to main", () => {
  denied("git push origin main", "main");
  denied("git push -f origin HEAD:main", "main");
});

test("denies unknown programs", () => {
  denied("nmap localhost", "allowlist");
  denied("python -c 'print(1)'", "allowlist");
});

test("denies redirects to system paths", () => {
  denied("echo x > /etc/hosts", "system path");
});

test("allows piped allowlist programs", () => {
  allowed("git log --oneline | head -5");
  allowed("cat package.json | grep version");
});
