import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnosticsFromEvents } from "./diagnostics.ts";

test("pairs each tool_call with the following tool_result", () => {
  const d = diagnosticsFromEvents([
    { type: "tool_call", payload: { name: "Bash", summary: "git status" } },
    { type: "tool_result", payload: { ok: true, summary: "clean" } },
    { type: "tool_call", payload: { name: "Edit", summary: "src/foo.ts" } },
    { type: "tool_result", payload: { ok: false, summary: "no such file" } },
  ]);
  assert.equal(d.recentToolCalls.length, 2);
  assert.deepEqual(d.recentToolCalls[0], {
    name: "Bash",
    summary: "git status",
    ok: true,
  });
  assert.equal(d.recentToolCalls[1]?.ok, false);
});

test("keeps only the last 5 tool calls", () => {
  const events = Array.from({ length: 12 }, (_, i) => ({
    type: "tool_call",
    payload: { name: "Bash", summary: `cmd ${i}` },
  }));
  const d = diagnosticsFromEvents(events);
  assert.equal(d.recentToolCalls.length, 5);
  assert.equal(d.recentToolCalls[0]?.summary, "cmd 7");
  assert.equal(d.recentToolCalls[4]?.summary, "cmd 11");
});

test("captures the latest assistant text as finalAssistantText", () => {
  const d = diagnosticsFromEvents([
    { type: "agent_message", payload: { kind: "text", text: "first thought" } },
    { type: "tool_call", payload: { name: "Bash", summary: "ls" } },
    { type: "agent_message", payload: { kind: "user_prompt", text: "ignore me" } },
    { type: "agent_message", payload: { kind: "text", text: "final thought" } },
  ]);
  assert.equal(d.finalAssistantText, "final thought");
});

test("truncates an excessively long final text", () => {
  const long = "x".repeat(2000);
  const d = diagnosticsFromEvents([
    { type: "agent_message", payload: { kind: "text", text: long } },
  ]);
  assert.ok(d.finalAssistantText && d.finalAssistantText.length <= 600);
});

test("handles missing payload fields gracefully", () => {
  const d = diagnosticsFromEvents([
    { type: "tool_call", payload: {} },
    { type: "tool_result", payload: {} },
  ]);
  assert.equal(d.recentToolCalls.length, 1);
  assert.equal(d.recentToolCalls[0]?.name, "");
});
