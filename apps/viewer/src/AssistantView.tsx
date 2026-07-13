import {
  Check,
  ChevronDown,
  Copy,
  FileText,
  MessageSquare,
  MoreHorizontal,
  Network,
  Plus,
  Search,
  SquarePen,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  type AssistantMessage,
  type AssistantModel,
  type AssistantModels,
  type AssistantSession,
  type AssistantSessionHit,
  type AssistantSource,
  api,
  type SessionAttachment,
} from "./api";

// The assistant tab: chat grounded in the local memory store. The harness lives in the
// engine; this view renders sessions (star/rename/search/delete), streams one turn over
// SSE with a typewriter status line while tools run, and shows per-answer sources.
// See docs/design/assistant-tab.md.

const THINKING_LINES = [
  "thinking...",
  "weighing what matters...",
  "connecting the dots...",
  "looking closer...",
];

// Typewriter status line (a typing-status pattern): types the current phrase
// character by character, cycling while the model works. Tool events swap in real text.
function TypingLine({ text }: { text: string | null }) {
  const [shown, setShown] = useState("");
  const phraseRef = useRef(0);
  const phrase = text ?? THINKING_LINES[phraseRef.current % THINKING_LINES.length] ?? "";

  useEffect(() => {
    setShown("");
    let i = 0;
    const type = setInterval(() => {
      i += 1;
      setShown(phrase.slice(0, i));
      if (i >= phrase.length) clearInterval(type);
    }, 18);
    // Generic phrases rotate after a beat; real tool text stays until replaced.
    const rotate = text
      ? null
      : setTimeout(() => {
          phraseRef.current += 1;
          setShown("");
        }, 2600);
    return () => {
      clearInterval(type);
      if (rotate) clearTimeout(rotate);
    };
  }, [phrase, text]);

  return (
    <div className="typingLine">
      {shown}
      <span className="typingCaret" />
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copyBtn"
      data-tip={copied ? "Copied" : "Copy response"}
      onClick={() => {
        // Markers are for the sources panel; the clipboard gets clean markdown.
        void navigator.clipboard.writeText(text.replace(/\s?\[\d{1,2}\]/g, ""));
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      {copied ? <Check size={13} strokeWidth={1.75} /> : <Copy size={13} strokeWidth={1.75} />}
    </button>
  );
}

// "memory / fact", "memory / how-to" (procedure), or plain "context" for chunks.
function sourceTypeLabel(s: AssistantSource): string {
  if (s.kind === "context") return "context";
  if (!s.memoryType) return "memory";
  return `memory / ${s.memoryType === "procedure" ? "how-to" : s.memoryType}`;
}

function SourcesPanel({
  sources,
  onOpenInGraph,
}: {
  sources: AssistantSource[];
  onOpenInGraph?: (nodeId: string) => void;
}) {
  const [openN, setOpenN] = useState<number | null>(null);
  if (sources.length === 0) return null;
  return (
    <details className="sourcesPanel">
      <summary>sources · {sources.length}</summary>
      {sources.map((s) => {
        const isOpen = openN === s.n;
        return (
          // The detail frame opens right under its own row, not below the whole list.
          <div key={s.n} className="sourceItem">
            <button
              type="button"
              className={`sourceRow ${isOpen ? "sourceRowOpen" : ""}`}
              onClick={() => setOpenN(isOpen ? null : s.n)}
            >
              <span className="sourceN">[{s.n}]</span>
              <span className={`sourceKind sourceKind-${s.kind}`}>{s.kind}</span>
              <span className="sourceTitle">{s.title}</span>
              {s.date && <span className="sourceSim">{s.date}</span>}
            </button>
            {isOpen && (
              <div className="sourceFrame">
                <div className="sourceFrameHead">
                  <span className="sourceFrameType">{sourceTypeLabel(s)}</span>
                  <span className="sourceFrameMeta">
                    {s.similarity !== undefined && (
                      <span className="sourceStat">{Math.round(s.similarity * 100)}% sim</span>
                    )}
                    {s.graphNodeId && onOpenInGraph && (
                      <button
                        type="button"
                        className="sourceGraphLink"
                        onClick={() => onOpenInGraph(s.graphNodeId as string)}
                      >
                        <Network size={12} strokeWidth={1.75} /> graph
                      </button>
                    )}
                  </span>
                </div>
                <div className="sourceFrameBody">{s.snippet}</div>
              </div>
            )}
          </div>
        );
      })}
    </details>
  );
}

const MODEL_STORAGE_KEY = "memloom:chatModel";

// "Anthropic: Claude Sonnet 5" -> "Claude Sonnet 5" (the group heading names the provider).
function shortName(name: string): string {
  const colon = name.indexOf(": ");
  return colon > 0 ? name.slice(colon + 2) : name;
}

function fmtContext(tokens: number | null): string {
  if (!tokens) return "";
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return `${Math.round(tokens / 1000)}K`;
}

function fmtPrice(usd: number | null): string {
  if (usd === null) return "?";
  if (usd === 0) return "$0";
  return usd < 1 ? `$${usd.toFixed(2).replace(/0$/, "")}` : `$${Number(usd.toFixed(2))}`;
}

// The composer's model picker: the live OpenRouter catalog (tool-capable models only,
// fetched lazily through the daemon's cached proxy), grouped by provider with search.
// value null = the daemon's configured default.
function ModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<AssistantModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open || catalog) return;
    api
      .assistantModels()
      .then(setCatalog)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [open, catalog]);

  const current = value ?? catalog?.defaultModel ?? null;
  const currentModel = catalog?.models.find((m) => m.id === current);
  const label = currentModel ? shortName(currentModel.name) : (current ?? "model");

  const groups = useMemo(() => {
    if (!catalog) return [];
    const needle = q.trim().toLowerCase();
    const hits = needle
      ? catalog.models.filter(
          (m) => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle),
        )
      : catalog.models;
    const byProvider = new Map<string, AssistantModel[]>();
    for (const m of hits) {
      const list = byProvider.get(m.provider);
      if (list) list.push(m);
      else byProvider.set(m.provider, [m]);
    }
    return [...byProvider.entries()];
  }, [catalog, q]);

  return (
    <div className="modelPicker">
      <button
        type="button"
        className="composerModelBtn"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {label} <ChevronDown size={13} strokeWidth={1.75} />
      </button>
      {open && (
        <>
          {/* transparent backdrop: any outside click closes the popover */}
          <button
            type="button"
            className="pickerBackdrop"
            aria-label="Close model picker"
            onClick={() => setOpen(false)}
          />
          <div className="modelPickerPop">
            <div className="modelPickerSearch">
              <Search size={13} strokeWidth={1.75} />
              <input
                type="text"
                placeholder="Search models..."
                value={q}
                // biome-ignore lint/a11y/noAutofocus: the popover just opened by user intent
                autoFocus
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <div className="modelPickerList">
              {!catalog && !error && <div className="modelPickerNote">loading models...</div>}
              {error && <div className="modelPickerNote">{error}</div>}
              {groups.map(([provider, models]) => (
                <div key={provider}>
                  <div className="modelGroupHead">{provider}</div>
                  {models.map((m) => (
                    <button
                      type="button"
                      key={m.id}
                      className={`modelRow ${m.id === current ? "modelRowActive" : ""}`}
                      title={m.description}
                      onClick={() => {
                        onChange(m.id === catalog?.defaultModel ? null : m.id);
                        setOpen(false);
                      }}
                    >
                      <span className="modelRowName">
                        {shortName(m.name)}
                        {m.id === catalog?.defaultModel && (
                          <span className="modelDefaultTag">default</span>
                        )}
                      </span>
                      <span className="modelRowMeta">
                        {fmtPrice(m.promptPer1M)}/{fmtPrice(m.completionPer1M)} per 1M
                        {m.contextLength ? ` · ${fmtContext(m.contextLength)} ctx` : ""}
                      </span>
                      {m.description && <span className="modelRowDesc">{m.description}</span>}
                    </button>
                  ))}
                </div>
              ))}
              {catalog && groups.length === 0 && (
                <div className="modelPickerNote">no models matched</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SessionRow({
  session,
  snippet,
  active,
  onOpen,
  onPatch,
  onDelete,
}: {
  session: AssistantSession;
  snippet?: string;
  active: boolean;
  onOpen: () => void;
  onPatch: (patch: { title?: string; starred?: boolean }) => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [deleteArmed, setDeleteArmed] = useState(false);

  if (renaming) {
    return (
      <div className="chatSessionRow chatSessionRowActive">
        <input
          type="text"
          className="chatRenameInput"
          value={title}
          ref={(el) => el?.focus()}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => setRenaming(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onPatch({ title: title.trim() || session.title });
              setRenaming(false);
            }
            if (e.key === "Escape") {
              setTitle(session.title);
              setRenaming(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className={`chatSessionRow ${active ? "chatSessionRowActive" : ""}`}>
      <button type="button" className="chatSessionMain" onClick={onOpen}>
        {session.isStarred ? (
          <Star size={13} strokeWidth={1.75} className="starIcon" />
        ) : (
          <MessageSquare size={13} strokeWidth={1.75} />
        )}
        <span className="chatSessionTitle">
          {session.title}
          {snippet && <span className="chatSessionSnippet">{snippet}</span>}
        </span>
      </button>
      <button
        type="button"
        className="chatSessionMenuBtn"
        onClick={() => setMenuOpen((v) => !v)}
        onBlur={() => setTimeout(() => setMenuOpen(false), 150)}
        aria-label="Session menu"
      >
        <MoreHorizontal size={13} strokeWidth={1.75} />
      </button>
      {menuOpen && (
        <div className="chatSessionMenu">
          {/* preventDefault throughout: the browser's default mousedown action moves focus
              AFTER React swaps the row for the rename input, which would instantly blur
              (and cancel) the input before it ever paints. */}
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              setMenuOpen(false);
              onPatch({ starred: !session.isStarred });
            }}
          >
            <Star size={12} strokeWidth={1.75} /> {session.isStarred ? "unstar" : "star"}
          </button>
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              setMenuOpen(false);
              setRenaming(true);
            }}
          >
            <SquarePen size={12} strokeWidth={1.75} /> rename
          </button>
          <button
            type="button"
            className={deleteArmed ? "menuDanger" : ""}
            onMouseDown={(e) => {
              if (!deleteArmed) {
                e.preventDefault();
                setDeleteArmed(true);
                return;
              }
              onDelete();
            }}
          >
            <Trash2 size={12} strokeWidth={1.75} /> {deleteArmed ? "confirm delete" : "delete"}
          </button>
        </div>
      )}
    </div>
  );
}

// `compact` drops the session-list sidebar for the docked graph view — the chat column fills
// the dock, keeping one "new chat" affordance so context can still be reset.
export function AssistantView({
  onOpenInGraph,
  compact = false,
}: {
  onOpenInGraph?: (nodeId: string) => void;
  compact?: boolean;
}) {
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState<AssistantSessionHit[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The picked model persists across sessions and chats; null = the daemon's default.
  const [model, setModel] = useState<string | null>(() => localStorage.getItem(MODEL_STORAGE_KEY));
  const [attachments, setAttachments] = useState<SessionAttachment[]>([]);
  const [uploading, setUploading] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const pickModel = useCallback((id: string | null) => {
    if (id) localStorage.setItem(MODEL_STORAGE_KEY, id);
    else localStorage.removeItem(MODEL_STORAGE_KEY);
    setModel(id);
  }, []);

  const refreshSessions = useCallback(async () => {
    const list = await api.assistantSessions().catch(() => null);
    if (list) setSessions(list);
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // Debounced hybrid search; empty query restores the plain list.
  useEffect(() => {
    if (!searchQ.trim()) {
      setSearchHits(null);
      return;
    }
    const t = setTimeout(() => {
      void api
        .assistantSearch(searchQ.trim())
        .then(setSearchHits)
        .catch(() => setSearchHits(null));
    }, 250);
    return () => clearTimeout(t);
  }, [searchQ]);

  const openSession = useCallback(async (id: string) => {
    setActiveId(id);
    setError(null);
    const [list, files] = await Promise.all([
      api.assistantMessages(id).catch(() => null),
      api.sessionAttachments(id).catch(() => []),
    ]);
    if (list) setMessages(list);
    setAttachments(files);
  }, []);

  const resetChat = useCallback(() => {
    setActiveId(null);
    setMessages([]);
    setError(null);
    setAttachments([]);
  }, []);

  // Upload the picked files into the chat's scope. The first attach of a fresh chat
  // creates the session server-side; adopt its id so the message goes to the same chat.
  async function attachFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    let sessionId = activeId;
    for (const file of Array.from(files)) {
      setUploading((prev) => [...prev, file.name]);
      try {
        const buf = new Uint8Array(await file.arrayBuffer());
        // btoa needs a binary string; build it in slices to keep the stack flat.
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) {
          bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        }
        const result = await api.assistantAttach({
          filename: file.name,
          contentBase64: btoa(bin),
          ...(sessionId ? { sessionId } : {}),
        });
        sessionId = result.sessionId;
        setActiveId(result.sessionId);
        const list = await api.sessionAttachments(result.sessionId).catch(() => []);
        setAttachments(list);
        void refreshSessions();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading((prev) => prev.filter((n) => n !== file.name));
      }
    }
  }

  async function removeAttachment(id: string) {
    try {
      await api.removeDocument(id);
      setAttachments((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every append
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, streaming]);

  async function send() {
    const message = draft.trim();
    if (!message || streaming) return;
    setDraft("");
    setError(null);
    setStreaming(true);
    setStreamText("");
    setStatusLine(null);
    // Optimistic user bubble.
    setMessages((prev) => [
      ...prev,
      {
        id: `tmp-${Date.now()}`,
        role: "user",
        content: message,
        sources: [],
        createdAt: new Date().toISOString(),
      },
    ]);
    try {
      const done = await api.assistantChat(
        { ...(activeId ? { sessionId: activeId } : {}), ...(model ? { model } : {}), message },
        (e) => {
          if (e.type === "tool_call")
            setStatusLine(
              `searching memories for "${e.query}"${e.onDate ? ` on ${e.onDate}` : ""}...`,
            );
          else if (e.type === "tool_result")
            setStatusLine(`found ${e.hits} ${e.hits === 1 ? "result" : "results"}, reading...`);
          else if (e.type === "delta") {
            setStatusLine(null);
            setStreamText((prev) => prev + e.text);
          }
        },
      );
      setActiveId(done.sessionId);
      setMessages((prev) => [
        ...prev,
        {
          id: done.messageId,
          role: "assistant",
          content: done.answer,
          sources: done.sources,
          createdAt: new Date().toISOString(),
        },
      ]);
      void refreshSessions();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("OPENROUTER_API_KEY")) setOffline(msg);
      else setError(msg);
    } finally {
      setStreaming(false);
      setStreamText("");
      setStatusLine(null);
    }
  }

  const sidebarSessions = useMemo(
    () => searchHits ?? sessions.map((s) => ({ ...s, snippet: "" })),
    [searchHits, sessions],
  );

  if (offline) {
    return (
      <div className="emptyState">
        <p>The assistant needs an LLM.</p>
        <p>
          Add <code>OPENROUTER_API_KEY</code> to <code>~/.memloom/config.env</code> and restart the
          daemon (<code>memloom stop</code>, then <code>memloom serve</code>).
        </p>
      </div>
    );
  }

  const searchBox = (
    <div className="chatSearch">
      <Search size={13} strokeWidth={1.75} />
      <input
        type="text"
        placeholder="Search chats..."
        value={searchQ}
        onChange={(e) => setSearchQ(e.target.value)}
      />
    </div>
  );

  const sessionList = (
    <div className="chatSessionList">
      {sidebarSessions.map((s) => (
        <SessionRow
          key={s.id}
          session={s}
          snippet={s.snippet || undefined}
          active={s.id === activeId}
          onOpen={() => void openSession(s.id)}
          onPatch={(patch) => {
            void api.assistantPatch(s.id, patch).then(refreshSessions);
          }}
          onDelete={() => {
            void api.assistantDelete(s.id).then(() => {
              if (activeId === s.id) {
                setActiveId(null);
                setMessages([]);
              }
              void refreshSessions();
            });
          }}
        />
      ))}
      {sidebarSessions.length === 0 && (
        <div className="chatSidebarEmpty">{searchQ ? "no chats matched" : "no chats yet"}</div>
      )}
    </div>
  );

  const messagesEl = (
    <div className="chatMessages" ref={scrollRef}>
      {messages.length === 0 && !streaming && (
        <div className="chatWelcome">
          <p>Ask about your memories and documents.</p>
          <p className="chatWelcomeHint">Answers are grounded in your local store, with sources.</p>
        </div>
      )}
      {messages.map((m) =>
        m.role === "user" ? (
          <div key={m.id} className="chatBubble chatBubbleUser">
            {m.content}
          </div>
        ) : (
          <div key={m.id} className="chatBubble chatBubbleAssistant">
            <div className="chatMarkdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
            </div>
            <SourcesPanel sources={m.sources} onOpenInGraph={onOpenInGraph} />
            <div className="chatBubbleActions">
              <CopyButton text={m.content} />
            </div>
          </div>
        ),
      )}
      {streaming && (
        <div className="chatBubble chatBubbleAssistant">
          {streamText ? (
            <div className="chatMarkdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamText}</ReactMarkdown>
            </div>
          ) : (
            <TypingLine text={statusLine} />
          )}
        </div>
      )}
      {error && <div className="notice noticeError">{error}</div>}
    </div>
  );

  const composerEl = (
    <form
      className="chatComposer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {(attachments.length > 0 || uploading.length > 0) && (
        <div className="attachChips">
          {attachments.map((a) => (
            <span key={a.id} className="attachChip" title={`${a.chunkCount} chunks`}>
              <FileText size={12} strokeWidth={1.75} />
              {a.title}
              <button
                type="button"
                className="attachChipX"
                aria-label={`Remove ${a.title}`}
                onClick={() => void removeAttachment(a.id)}
              >
                <X size={11} strokeWidth={2} />
              </button>
            </span>
          ))}
          {uploading.map((name) => (
            <span key={name} className="attachChip attachChipPending">
              <FileText size={12} strokeWidth={1.75} />
              {name}...
            </span>
          ))}
        </div>
      )}
      <textarea
        value={draft}
        rows={Math.min(6, Math.max(1, draft.split("\n").length))}
        placeholder="Ask your memory..."
        disabled={streaming}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {/* Bottom bar: "+" attaches files into this chat's scope; the model picker chooses
          the OpenRouter model for every turn. */}
      <div className="chatComposerBar">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".md,.markdown,.txt,.pdf"
          style={{ display: "none" }}
          onChange={(e) => {
            void attachFiles(e.target.files);
            e.target.value = ""; // allow re-picking the same file
          }}
        />
        <button
          type="button"
          className="composerIconBtn"
          aria-label="Attach a file to this chat"
          disabled={streaming || uploading.length > 0}
          onClick={() => fileInputRef.current?.click()}
        >
          <Plus size={16} strokeWidth={1.75} />
        </button>
        <div className="chatComposerActions">
          <ModelPicker value={model} onChange={pickModel} disabled={streaming} />
          <button
            type="submit"
            className="btn btnPrimary"
            disabled={streaming || draft.trim().length === 0}
          >
            {streaming ? "..." : "Send"}
          </button>
        </div>
      </div>
    </form>
  );

  if (compact) {
    // Single column so the composer spans the full dock width. The body shows the chat
    // history (same rows as the tab) while idle and swaps to messages once a conversation
    // is open; "new chat" clears back to the list.
    const inConversation = streaming || messages.length > 0 || activeId !== null;
    return (
      <div className="chatLayout chatLayoutCompact">
        <div className="chatCompactHead">
          <button type="button" className="btn chatNewBtn" onClick={resetChat}>
            <Plus size={13} strokeWidth={1.75} /> new chat
          </button>
          {searchBox}
        </div>
        <div className="chatCompactBody">{inConversation ? messagesEl : sessionList}</div>
        {composerEl}
      </div>
    );
  }

  return (
    <div className="chatLayout">
      <aside className="chatSidebar">
        <button type="button" className="btn chatNewBtn" onClick={resetChat}>
          <Plus size={13} strokeWidth={1.75} /> new chat
        </button>
        {searchBox}
        {sessionList}
      </aside>
      <section className="chatMain">
        {messagesEl}
        {composerEl}
      </section>
    </div>
  );
}
