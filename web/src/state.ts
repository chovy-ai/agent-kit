/** Adapter for pi-web-ui 0.104.4's public WebSocket protocol (version 29). */
export interface Block { type: string; text?: string; thinking?: string; id?: string; name?: string; argumentsText?: string }
export interface Message {
  id: string; role: string; content: Block[]; timestamp?: number;
  toolCallId?: string; toolName?: string; isError?: boolean; details?: unknown;
  errorMessage?: string; stopReason?: string;
}
export interface Approval { id: string; toolName: string; params: unknown; reason: string }
export interface UiState {
  rev: number; conversationId: string; sessionId: string; messages: Message[];
  isStreaming: boolean; streamingMessage?: Message | null; cwd?: string;
  model?: { id: string; name: string; provider: string } | null;
  errorMessage?: string; pendingApproval?: Approval | null;
  retry?: { attempt?: number } | null;
  queue?: { steering: string[]; followUp: string[] };
}
export interface Conversation { id: string; title: string; sessionFile?: string; isStreaming: boolean; isSubagent?: boolean }
export interface SavedSession { path: string; sessionId?: string; name?: string; firstMessage?: string; modified: number }
export interface ToolStatus { isError?: boolean; durationMs?: number; exitCode?: number }
export interface ChatState {
  ui: UiState | null; conversations: Conversation[]; sessions: SavedSession[];
  progress: Record<string, string>; statuses: Record<string, ToolStatus>;
  notice: string; incompatible: boolean; resync: boolean; lastSeq: number; sessionsLoaded: boolean;
}
export type ServerFrame =
  | { type: "ready"; protocolVersion: number }
  | { type: "snapshot"; state: UiState }
  | { type: "snapshot_delta"; conversationId: string; baseRev: number; rev: number; appended: Message[]; state: Partial<UiState> }
  | { type: "message_delta"; conversationId: string; seq: number; messageId: string; assistantMessageEvent: { type: string; contentIndex?: number; delta?: string } }
  | { type: "tool_delta"; conversationId: string; seq: number; toolCallId: string; toolName: string; delta: string }
  | ({ type: "tool_status"; toolCallId: string } & ToolStatus)
  | { type: "conversations"; conversations: Conversation[]; activeId: string }
  | { type: "sessions"; sessions: SavedSession[] }
  | { type: "notice"; level: string; text: string };

export function initialChatState(): ChatState {
  return { ui: null, conversations: [], sessions: [], progress: {}, statuses: {}, notice: "", incompatible: false, resync: false, lastSeq: 0, sessionsLoaded: false };
}

export function reduceFrame(previous: ChatState, frame: ServerFrame): ChatState {
  switch (frame.type) {
    case "ready": return frame.protocolVersion === 29 ? previous : { ...previous, incompatible: true, notice: "页面与服务版本不兼容，请更新并刷新页面。" };
    case "notice": return { ...previous, notice: frame.text };
    case "conversations": return { ...previous, conversations: frame.conversations };
    case "sessions": return { ...previous, sessions: frame.sessions, sessionsLoaded: true };
    case "snapshot": {
      const switched = previous.ui?.conversationId !== frame.state.conversationId;
      return { ...previous, ui: frame.state, resync: false,
        ...(switched ? { lastSeq: 0, progress: {}, statuses: {} } : {}) };
    }
    case "snapshot_delta": {
      if (!previous.ui || previous.ui.conversationId !== frame.conversationId || previous.ui.rev !== frame.baseRev) return { ...previous, resync: true };
      return { ...previous, ui: { ...previous.ui, ...frame.state, rev: frame.rev, messages: [...previous.ui.messages, ...frame.appended] } };
    }
    case "message_delta": {
      if (!previous.ui || previous.ui.conversationId !== frame.conversationId || frame.seq <= previous.lastSeq) return previous;
      const event = frame.assistantMessageEvent;
      const state = { ...previous, lastSeq: frame.seq };
      if (event.type !== "text_delta" || !event.delta) return state;
      const current = previous.ui.streamingMessage?.id === frame.messageId ? previous.ui.streamingMessage
        : { id: frame.messageId, role: "assistant", content: [] };
      const content = [...current.content];
      const index = event.contentIndex ?? 0;
      content[index] = { type: "text", text: (content[index]?.text ?? "") + event.delta };
      return { ...state, ui: { ...previous.ui, isStreaming: true, streamingMessage: { ...current, content } } };
    }
    case "tool_delta": {
      if (!previous.ui || previous.ui.conversationId !== frame.conversationId || frame.seq <= previous.lastSeq) return previous;
      // Agent Kit's partial results contain the cumulative output preview.
      // Replacing it prevents duplicated lines as additional chunks arrive.
      return { ...previous, lastSeq: frame.seq, progress: { ...previous.progress, [frame.toolCallId]: frame.delta } };
    }
    case "tool_status": return { ...previous, statuses: { ...previous.statuses, [frame.toolCallId]: frame } };
    default: return previous;
  }
}

export function messageText(message: Message): string { return message.content.filter(Boolean).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n"); }
export function parseObject(text: string): Record<string, unknown> {
  try { const value: unknown = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  catch { return {}; }
}
export function isCancellationMessage(text: string | undefined): boolean {
  return !!text && ["all fibers interrupted without error", "this operation was aborted", "the operation was aborted"].includes(text.trim().replace(/[.!]$/, "").toLowerCase());
}
export function promptForEnvironment(text: string, environment: string): string {
  return `${text}\n\n<agent-kit-environment>\n本次任务使用执行环境 ${JSON.stringify(environment)}。涉及文件和命令时，environmentId 必须使用该值。\n</agent-kit-environment>`;
}
