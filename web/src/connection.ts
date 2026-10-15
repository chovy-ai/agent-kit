import { Context, Effect, Layer, ManagedRuntime } from "effect";
import type { ServerFrame } from "./state.js";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
interface ConnectionApi {
  send: (message: object) => boolean;
  subscribe: (listener: (frame: ServerFrame) => void, status: (value: ConnectionStatus) => void) => () => void;
}
class ChatConnection extends Context.Service<ChatConnection, ConnectionApi>()("agent-kit/web/ChatConnection") {}

function connectionLayer(url: string, clientId: string) {
  return Layer.effect(ChatConnection, Effect.gen(function* () {
    const listeners = new Set<(frame: ServerFrame) => void>();
    const statuses = new Set<(status: ConnectionStatus) => void>();
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let current: ConnectionStatus = "connecting";
    const status = (value: ConnectionStatus) => { current = value; statuses.forEach((listener) => listener(value)); };
    const send = (message: object) => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    };
    const connect = () => {
      if (closed) return;
      status("connecting");
      socket = new WebSocket(url);
      socket.onopen = () => {
        send({ type: "hello", clientId });
        status("connected");
      };
      socket.onmessage = (event) => {
        let frame: ServerFrame;
        try { frame = JSON.parse(String(event.data)) as ServerFrame; } catch { return; }
        if (!frame || typeof frame.type !== "string") return;
        listeners.forEach((listener) => listener(frame));
        if (frame.type === "ready") {
          send({ type: "get_state" });
          send({ type: "list_sessions" });
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        status("disconnected");
        if (!closed) timer = setTimeout(connect, 1500);
      };
    };
    yield* Effect.acquireRelease(Effect.sync(() => { connect(); }), () => Effect.sync(() => {
      closed = true;
      clearTimeout(timer);
      if (socket) {
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        socket.onopen = null;
        socket.close();
      }
      listeners.clear(); statuses.clear();
    }));
    return { send, subscribe(listener, onStatus) {
      listeners.add(listener); statuses.add(onStatus); onStatus(current);
      return () => { listeners.delete(listener); statuses.delete(onStatus); };
    } } satisfies ConnectionApi;
  }));
}

export async function createChatConnection(url: string, clientId: string) {
  const runtime = ManagedRuntime.make(connectionLayer(url, clientId));
  try {
    const connection = await runtime.runPromise(ChatConnection);
    return { ...connection, close: () => runtime.dispose() };
  } catch (error) { await runtime.dispose(); throw error; }
}
