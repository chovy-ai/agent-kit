import assert from "node:assert/strict";
import { test } from "node:test";
import { initialChatState, isCancellationMessage, promptForEnvironment, reduceFrame } from "../web/src/state.js";
import type { UiState } from "../web/src/state.js";
import { SessionRestorer } from "../web/src/session.js";

const snapshot = (conversationId = "one"): UiState => ({ conversationId, sessionId: conversationId, rev: 1, isStreaming: false, messages: [] });

test("chat adapter requests a full snapshot on missing revisions instead of mixing conversations", () => {
  let state = reduceFrame(initialChatState(), { type: "snapshot", state: snapshot() });
  state = reduceFrame(state, { type: "snapshot_delta", conversationId: "one", baseRev: 1, rev: 2, state: { isStreaming: true }, appended: [{ id: "u1", role: "user", content: [{ type: "text", text: "hello" }] }] });
  assert.equal(state.ui?.messages.length, 1);
  assert.equal(state.ui?.isStreaming, true);
  const gap = reduceFrame(state, { type: "snapshot_delta", conversationId: "one", baseRev: 3, rev: 4, state: {}, appended: [] });
  assert.equal(gap.resync, true);
  assert.equal(gap.ui?.rev, 2);
  const switched = reduceFrame(gap, { type: "snapshot", state: snapshot("two") });
  assert.equal(switched.resync, false);
  assert.equal(switched.ui?.messages.length, 0);
});

test("chat streaming deduplicates replayed events and treats Go previews as cumulative", () => {
  let state = reduceFrame(initialChatState(), { type: "snapshot", state: snapshot() });
  const frame = { type: "message_delta" as const, conversationId: "one", seq: 1, messageId: "stream-1", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好" } };
  state = reduceFrame(state, frame);
  state = reduceFrame(state, frame);
  assert.equal(state.ui?.streamingMessage?.content[0]?.text, "你好");
  state = reduceFrame(state, { type: "tool_delta", conversationId: "one", seq: 2, toolCallId: "cmd", toolName: "process_exec", delta: "first\n" });
  state = reduceFrame(state, { type: "tool_delta", conversationId: "one", seq: 3, toolCallId: "cmd", toolName: "process_exec", delta: "first\nsecond\n" });
  assert.equal(state.progress.cmd, "first\nsecond\n");
  const background = reduceFrame(state, { type: "tool_delta", conversationId: "other", seq: 99, toolCallId: "cmd", toolName: "process_exec", delta: "wrong environment" });
  assert.equal(background, state);
  const switched = reduceFrame(state, { type: "snapshot", state: snapshot("two") });
  assert.deepEqual(switched.progress, {});
});

test("chat refuses incompatible server protocols and pins the selected execution environment", () => {
  assert.equal(reduceFrame(initialChatState(), { type: "ready", protocolVersion: 30 }).incompatible, true);
  const prompt = promptForEnvironment("查看文件", "workspace");
  assert.ok(prompt.includes('执行环境 "workspace"'));
  assert.ok(prompt.startsWith("查看文件"));
});

test("only explicit cancellation signals are presented as stopped, preserving real failures", () => {
  assert.equal(isCancellationMessage("All fibers interrupted without error"), true);
  assert.equal(isCancellationMessage("This operation was aborted"), true);
  assert.equal(isCancellationMessage("Command failed: exit 1"), false);
  assert.equal(isCancellationMessage("request timeout"), false);
  assert.equal(isCancellationMessage("unconfirmed"), false);
});

test("URL restoration ignores temporary blank snapshots until the target session arrives", () => {
  const restorer = new SessionRestorer("saved");
  const empty = { type: "snapshot" as const, state: snapshot("temporary") };
  assert.deepEqual(restorer.accept(empty).frames, []);
  const action = restorer.accept({ type: "sessions", sessions: [{ sessionId: "saved", path: "/allowed/saved.jsonl", modified: 1 }] });
  assert.deepEqual(action.request, { type: "switch_session", sessionId: "saved", path: "/allowed/saved.jsonl" });
  assert.deepEqual(restorer.accept(empty).frames, []);
  const saved = { type: "snapshot" as const, state: snapshot("saved") };
  assert.deepEqual(restorer.accept(saved).frames, [saved]);
});

test("missing history and failed restoration remain visible instead of silently changing the URL", () => {
  const restorer = new SessionRestorer("missing");
  restorer.accept({ type: "snapshot", state: snapshot("temporary") });
  const fallback = restorer.accept({ type: "sessions", sessions: [] });
  let state = fallback.frames.reduce(reduceFrame, initialChatState());
  assert.equal(state.ui?.sessionId, "temporary");
  assert.ok(state.notice.includes("不可用"));
  state = reduceFrame(state, { type: "snapshot", state: snapshot("another") });
  assert.ok(state.notice.includes("不可用"));
});
