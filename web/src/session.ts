import type { SavedSession, ServerFrame } from "./state.js";

/** Keep attach's temporary blank snapshot out of the UI while restoring a URL. */
export class SessionRestorer {
  private target: string | null;
  private fallback: Extract<ServerFrame, { type: "snapshot" }> | undefined;
  private requested = false;
  private resolved: boolean;
  constructor(sessionId: string | null) { this.target = sessionId; this.resolved = !sessionId; }

  accept(frame: ServerFrame): { frames: ServerFrame[]; request?: object } {
    if (this.resolved) return { frames: [frame] };
    if (frame.type === "snapshot") {
      if (frame.state.sessionId === this.target) { this.resolved = true; return { frames: [frame] }; }
      this.fallback = frame;
      return { frames: [] };
    }
    if (frame.type === "snapshot_delta" || frame.type === "message_delta" || frame.type === "tool_delta") return { frames: [] };
    if (frame.type === "sessions" && !this.requested) {
      const target: SavedSession | undefined = frame.sessions.find((session) => session.sessionId === this.target);
      if (target) {
        this.requested = true;
        return { frames: [frame], request: { type: "switch_session", path: target.path, sessionId: target.sessionId } };
      }
      this.resolved = true;
      return { frames: [...(this.fallback ? [this.fallback] : []), frame, { type: "notice", level: "warning", text: "这条历史对话已不可用，已打开一个新对话。" }] };
    }
    if (frame.type === "notice" && frame.level === "error") {
      this.resolved = true;
      return { frames: [...(this.fallback ? [this.fallback] : []), frame] };
    }
    return { frames: [frame] };
  }
}
