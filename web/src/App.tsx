import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Spinner, StatusDot, Textarea } from "@nextop-os/ui-system/components";
import { AddIcon, ArrowRightIcon, ChatIcon, CheckIcon, ChevronDownIcon, CloseIcon, CopyIcon, DirectoryIcon, FileTextIcon, GridLeftLinedIcon, PauseIcon, PlayIcon, WarningLinedIcon } from "@nextop-os/ui-system/icons";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createChatConnection } from "./connection.js";
import type { ConnectionStatus } from "./connection.js";
import { initialChatState, isCancellationMessage, messageText, parseObject, promptForEnvironment, reduceFrame } from "./state.js";
import type { Block, ChatState, Message, ServerFrame, ToolStatus } from "./state.js";
import { SessionRestorer } from "./session.js";

interface Metadata { environments: string[]; model: string }
type Client = Awaited<ReturnType<typeof createChatConnection>>;
const toolLabels: Record<string, string> = {
  environment_list: "查看执行环境", filesystem_read: "读取文件", filesystem_write: "写入文件",
  filesystem_read_dir: "查看目录", filesystem_stat: "查看文件信息", filesystem_mkdir: "创建目录",
  process_exec: "执行命令", agent_kit_status: "检查执行环境",
};
function userText(text: string) { return text.replace(/^本次任务使用执行环境 .+?。涉及文件和命令时，environmentId 必须使用该值。\n\n/, "").replace(/\n\n<agent-kit-environment>[\s\S]*<\/agent-kit-environment>$/, ""); }
function duration(ms?: number) { return ms === undefined ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} 秒`; }

function ToolActivity({ block, result, progress, status, running }: { block: Block; result: Message | undefined; progress: string | undefined; status: ToolStatus | undefined; running: boolean }) {
  const [open, setOpen] = useState(false);
  const args = parseObject(block.argumentsText ?? "{}");
  const text = result ? messageText(result) : progress ?? "";
  const data = result ? parseObject(text) : {};
  const completion = String(data.completion ?? "");
  const cancelled = ["cancelled", "canceled"].includes(completion) || !!result?.isError && isCancellationMessage(text) || ["CANCELLED", "ABORTED"].includes(String(data.code ?? ""));
  const failed = !cancelled && (!!result?.isError || !!status?.isError);
  const incomplete = !result && !status && !running;
  const done = !!result || !!status;
  const label = cancelled ? "已停止" : failed ? "失败" : done ? "完成" : incomplete ? "已中断" : "执行中";
  const detail = typeof args.command === "string" ? args.command : typeof args.path === "string" ? args.path : "";
  const output = cancelled ? progress ?? "" : block.name === "process_exec" && result && ("stdout" in data || "stderr" in data)
    ? `${String(data.stdout ?? "")}${data.stderr ? `\n标准错误\n${String(data.stderr)}` : ""}`.trimEnd() : text;
  const environment = typeof args.environmentId === "string" ? args.environmentId : undefined;
  const elapsed = status?.durationMs ?? (typeof data.durationMs === "number" ? data.durationMs : undefined);
  const Icon = block.name === "process_exec" ? PlayIcon : block.name === "environment_list" ? DirectoryIcon : FileTextIcon;
  return <div className={`activity ${failed ? "activity-failed" : ""}`} data-tool={block.name}>
    <Button variant="ghost" className="activity-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="activity-symbol">{!done && !incomplete ? <Spinner size={14} /> : cancelled ? <PauseIcon size={15} /> : failed ? <WarningLinedIcon size={15} /> : <CheckIcon size={15} />}</span>
      <span className="activity-title">{toolLabels[block.name ?? ""] ?? block.name}<span className="activity-command">{detail}</span></span>
      <span className="activity-meta">{label}{elapsed !== undefined && <span>{duration(elapsed)}</span>}</span>
      <ChevronDownIcon size={13} className={open ? "chevron-open" : ""} />
    </Button>
    {open && <div className="activity-details">
      <div className="activity-caption"><Icon size={13} />{environment ? `环境 · ${environment}` : "执行详情"}{typeof data.exitCode === "number" && <span>退出码 {data.exitCode}</span>}</div>
      {detail && <pre className="command-line">{block.name === "process_exec" ? "$ " : ""}{detail}</pre>}
      {cancelled && <p className="muted">执行已停止{output ? "，以下为停止前收到的输出。" : "。"}</p>}
      <pre className="tool-output" aria-label="执行输出">{output || (cancelled ? "没有保存的输出。" : done ? "操作已完成，没有额外输出。" : incomplete ? "执行结果尚未确认。" : "等待输出…")}</pre>
      {Boolean(data.outputTruncated || data.outputIncomplete || data.displayTruncated) && <p className="muted">输出不完整，以上为已捕获的内容。</p>}
      <details className="raw-arguments"><summary>调用参数</summary><pre>{JSON.stringify(args, null, 2)}</pre></details>
    </div>}
  </div>;
}

function ConversationMessage({ message, state, results }: { message: Message; state: ChatState; results: Map<string, Message> }) {
  const [copied, setCopied] = useState(false);
  if (message.role === "toolResult" || !["user", "assistant"].includes(message.role)) return null;
  const text = messageText(message);
  if (message.role === "user") return <article className="user-message"><div className="user-bubble">{userText(text)}</div></article>;
  const blocks = message.content.filter(Boolean).filter((block) => block.type === "text" && block.text || block.type === "toolCall");
  if (!blocks.length && !message.errorMessage) return null;
  return <article className="assistant-message">
    {blocks.map((block, index) => block.type === "toolCall" ? <ToolActivity key={block.id ?? index} block={block} result={results.get(block.id ?? "")} progress={state.progress[block.id ?? ""]} status={state.statuses[block.id ?? ""]} running={!!state.ui?.isStreaming} />
      : <div className="prose" key={index}><Markdown remarkPlugins={[remarkGfm]} components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" />, img: ({ alt }) => <span>{alt ?? "图片"}</span> }}>{block.text ?? ""}</Markdown></div>)}
    {message.errorMessage && (isCancellationMessage(message.errorMessage) ? <p className="muted">本次执行已停止，你可以继续发送消息。</p> : <p className="message-error" role="alert">{message.errorMessage}</p>)}
    {text && message.id !== state.ui?.streamingMessage?.id && <Button variant="ghost" size="icon-xs" className="copy-response" aria-label={copied ? "已复制" : "复制回复"} onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}</Button>}
  </article>;
}

export function App() {
  const [state, setState] = useState(initialChatState);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [metadata, setMetadata] = useState<Metadata>({ environments: [], model: "" });
  const [environment, setEnvironment] = useState("");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [following, setFollowing] = useState(true);
  const client = useRef<Client | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const draftSession = useRef("");
  const ui = state.ui;
  const ready = status === "connected" && !!ui && !state.incompatible;
  const running = !!ui?.isStreaming;
  const messages = useMemo(() => [...(ui?.messages ?? []), ...(ui?.streamingMessage ? [ui.streamingMessage] : [])], [ui?.messages, ui?.streamingMessage]);
  const results = useMemo(() => new Map((ui?.messages ?? []).filter((m) => m.role === "toolResult").map((m) => [m.toolCallId ?? "", m])), [ui?.messages]);

  const send = (message: object) => {
    if (!client.current?.send(message)) { setState((s) => ({ ...s, notice: "连接已断开，请等待重连后再发送。" })); return false; }
    return true;
  };
  useEffect(() => {
    let closed = false;
    let off: (() => void) | undefined;
    let owned: Client | undefined;
    let restorer = new SessionRestorer(new URLSearchParams(location.hash.slice(1)).get("s"));
    let id = sessionStorage.getItem("agent-kit.clientId");
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem("agent-kit.clientId", id); }
    void createChatConnection(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`, id).then(async (connection) => {
      owned = connection;
      if (closed) { await connection.close(); return; }
      client.current = connection;
      off = connection.subscribe((frame: ServerFrame) => {
        const accepted = restorer.accept(frame);
        if (accepted.frames.length) setState((previous) => accepted.frames.reduce(reduceFrame, previous));
        if (accepted.request) connection.send(accepted.request);
      }, (value) => {
        if (value === "connected") restorer = new SessionRestorer(new URLSearchParams(location.hash.slice(1)).get("s"));
        setStatus(value);
      });
    }).catch((error: unknown) => setState((s) => ({ ...s, notice: String(error) })));
    void fetch("/agent-kit.json", { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error("无法读取环境配置"); return r.json() as Promise<Metadata>; }).then((data) => {
      if (!closed) { setMetadata(data); setEnvironment(data.environments.includes("workspace") ? "workspace" : data.environments.includes("local") ? "local" : data.environments[0] ?? ""); }
    }).catch(() => setState((s) => ({ ...s, notice: "环境配置加载失败，请重启服务后刷新。" })));
    return () => { closed = true; off?.(); client.current = null; void owned?.close(); };
  }, []);
  useEffect(() => { if (state.resync) send({ type: "get_state" }); }, [state.resync]);
  useEffect(() => {
    if (!ui) return;
    history.replaceState(null, "", `#s=${encodeURIComponent(ui.sessionId)}`);
    if (draftSession.current !== ui.sessionId) {
      draftSession.current = ui.sessionId;
      setDraft(sessionStorage.getItem(`agent-kit.draft.${ui.sessionId}`) ?? "");
      setPending(false); setStopping(false); setFollowing(true);
    }
  }, [ui?.sessionId]);
  useEffect(() => { if (ui) sessionStorage.setItem(`agent-kit.draft.${ui.sessionId}`, draft); }, [draft, ui?.sessionId]);
  useEffect(() => { if (ui?.isStreaming || ui?.messages.at(-1)?.role === "user") setPending(false); if (!ui?.isStreaming) setStopping(false); }, [ui?.isStreaming, ui?.messages]);
  useEffect(() => { if (status === "disconnected" || state.notice) setPending(false); }, [status, state.notice]);
  useEffect(() => { if (following && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [messages, state.progress, following, ui?.pendingApproval]);
  useEffect(() => { if (textarea.current) { textarea.current.style.height = "auto"; textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 180)}px`; } }, [draft]);

  const submit = () => {
    if (!draft.trim() || !ready || !environment || pending) return;
    const text = promptForEnvironment(draft.trim(), environment);
    if (send({ type: "prompt", text, ...(running ? { queue: "followUp" } : {}) })) {
      setDraft(""); setPending(!running); setFollowing(true);
    }
  };
  const newChat = () => { if (ready && !running && send({ type: "new_chat" })) { setSidebar(false); setPending(true); } };
  const openedFiles = new Set(state.conversations.map((c) => c.sessionFile));
  const historyItems = state.sessions.filter((s) => !openedFiles.has(s.path)).slice(0, 25);
  const currentTitle = state.conversations.find((c) => c.id === ui?.conversationId)?.title;
  const lastTool = messages.flatMap((m) => m.content.filter(Boolean)).filter((b) => b.type === "toolCall").at(-1);
  return <div className={`workspace ${sidebar ? "sidebar-visible" : ""}`}>
    {sidebar && <aside className="sidebar" aria-label="对话历史">
      <div className="sidebar-heading"><span>对话</span><Button variant="ghost" size="icon-xs" aria-label="关闭历史" onClick={() => setSidebar(false)}><CloseIcon size={16} /></Button></div>
      <Button variant="ghost" className="new-chat" onClick={newChat} disabled={!ready || running}><AddIcon size={16} />新对话</Button>
      <p className="sidebar-label">最近</p>
      <nav>{state.conversations.filter((c) => !c.isSubagent).map((c) => <Button key={c.id} variant="ghost" className={`history-item ${c.id === ui?.conversationId ? "selected" : ""}`} onClick={() => { send({ type: "switch_conversation", id: c.id }); setSidebar(false); }}><ChatIcon size={15} /><span>{userText(c.title)}</span>{c.isStreaming && <StatusDot tone="green" size="xs" pulse />}</Button>)}
        {historyItems.map((s) => <Button variant="ghost" key={s.path} className="history-item" onClick={() => { send({ type: "switch_session", path: s.path, sessionId: s.sessionId }); setSidebar(false); }}><ChatIcon size={15} /><span>{s.name || userText(s.firstMessage ?? "新对话")}</span></Button>)}
        {!state.conversations.length && !historyItems.length && <p className="muted sidebar-empty">还没有对话</p>}</nav>
      <div className="sidebar-footer"><StatusDot tone={ready ? "green" : "neutral"} size="xs" />{ready ? "本地服务已连接" : "正在连接服务"}</div>
    </aside>}
    <div className="main-panel">
      <header className="topbar"><div className="topbar-start"><Button variant="ghost" size="icon-sm" aria-label="对话历史" onClick={() => { setSidebar(!sidebar); send({ type: "list_sessions" }); }}><GridLeftLinedIcon size={18} /></Button><span className="brand">Agent Kit</span><span className="header-separator">/</span><span className="conversation-title">{currentTitle ? userText(currentTitle) : "新对话"}</span></div><Button variant="ghost" size="icon-sm" aria-label="新对话" disabled={!ready || running || pending} onClick={newChat}><AddIcon size={18} /></Button></header>
      {((state.notice && !isCancellationMessage(state.notice)) || (ui?.errorMessage && !isCancellationMessage(ui.errorMessage))) && <div className="notice" role="alert"><WarningLinedIcon size={16} /><span>{state.notice || ui?.errorMessage}</span><Button variant="ghost" size="icon-xs" aria-label="关闭提示" onClick={() => setState((s) => ({ ...s, notice: "" }))}><CloseIcon size={14} /></Button></div>}
      <div className="conversation-scroll" ref={scroll} onScroll={() => { const el = scroll.current; if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 100); }}>
        <main className="conversation" aria-label="聊天内容">
          {!messages.length && <section className="empty-state"><div className="empty-mark"><ChatIcon size={30} /></div><p className="eyebrow">YOUR LOCAL AGENT</p><h1>有什么想一起完成的？</h1><p>从一个任务开始，执行过程会在这里展开。</p><div className="suggestions"><Button variant="outline" onClick={() => { setDraft("查看当前工作区，简要说明项目结构。"); textarea.current?.focus(); }}><DirectoryIcon size={16} /><span>了解工作区</span><ArrowRightIcon size={14} /></Button><Button variant="outline" onClick={() => { setDraft("检查项目的运行方式，先说明你打算怎么检查。"); textarea.current?.focus(); }}><PlayIcon size={16} /><span>运行与检查</span><ArrowRightIcon size={14} /></Button></div></section>}
          {messages.map((message) => <ConversationMessage key={message.id} message={message} state={state} results={results} />)}
          {(running || pending) && <div className="working-status" role="status"><Spinner size={14} /><span>{stopping ? "正在停止执行…" : ui?.pendingApproval ? "等待你的确认" : running && lastTool && !results.has(lastTool.id ?? "") && !state.statuses[lastTool.id ?? ""] ? toolLabels[lastTool.name ?? ""] ?? "正在执行" : "正在处理…"}</span></div>}
          {ui?.pendingApproval && <Card className="approval"><strong>需要你的确认</strong><p>{ui.pendingApproval.reason}</p><pre>{JSON.stringify(ui.pendingApproval.params, null, 2)}</pre><div><Button variant="outline" onClick={() => send({ type: "tool_approval_response", id: ui.pendingApproval!.id, decision: "deny" })}>拒绝</Button><Button onClick={() => send({ type: "tool_approval_response", id: ui.pendingApproval!.id, decision: "approve", scope: "once" })}>允许本次</Button></div></Card>}
        </main>
      </div>
      <footer className="composer-area"><div className="composer-wrap">
        {!following && <Button variant="outline" size="sm" className="jump-latest" onClick={() => setFollowing(true)}>回到最新消息</Button>}
        <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <Textarea ref={textarea} aria-label="发送给 Agent 的任务" placeholder={running ? "补充任务或继续追问…" : "描述任务，或继续追问…"} className="task-input" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
          <div className="composer-controls"><div className="composer-settings"><Select value={environment} onValueChange={setEnvironment} disabled={!metadata.environments.length || running}><SelectTrigger aria-label="执行环境" className="environment-select"><DirectoryIcon size={14} /><SelectValue placeholder="选择环境" /></SelectTrigger><SelectContent>{metadata.environments.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select><span className="model-label" title={ui?.model?.id ?? metadata.model}>{ui?.model?.name ?? metadata.model}</span></div><div className="send-actions">{running && <Button variant="outline" size="icon-sm" aria-label="停止执行" disabled={stopping || !ready} onClick={() => { if (send({ type: "abort" })) setStopping(true); }}><PauseIcon size={15} /></Button>}<Button className="send-button" size="icon-sm" type="submit" aria-label={running ? "追加消息" : "发送消息"} disabled={!ready || !draft.trim() || !environment || pending}><ArrowRightIcon size={18} /></Button></div></div>
        </form>
        <div className="composer-footnote"><span><StatusDot tone={status === "connected" && ready ? "green" : "neutral"} size="xs" />{status === "disconnected" ? "连接断开，正在重连 · 输入会保留" : !ready ? "正在连接…" : running ? "执行中，可追加消息或停止" : "就绪"}{!!ui?.queue?.followUp.length && ` · ${ui.queue.followUp.length} 条消息已排队`}</span><span>Enter 发送 · Shift + Enter 换行</span></div>
      </div></footer>
    </div>
  </div>;
}
