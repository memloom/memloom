import {
  Check,
  Copy,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  SquarePen,
  Star,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  type AssistantMessage,
  type AssistantSession,
  type AssistantSessionHit,
  type AssistantSource,
  api,
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

function SourcesPanel({ sources }: { sources: AssistantSource[] }) {
  const [open, setOpen] = useState<AssistantSource | null>(null);
  if (sources.length === 0) return null;
  return (
    <details className="sourcesPanel">
      <summary>sources · {sources.length}</summary>
      {sources.map((s) => (
        <button
          type="button"
          key={s.n}
          className="sourceRow"
          onClick={() => setOpen(open?.n === s.n ? null : s)}
        >
          <span className="sourceN">[{s.n}]</span>
          <span className={`sourceKind sourceKind-${s.kind}`}>{s.kind}</span>
          <span className="sourceTitle">{s.title}</span>
          {s.date && <span className="sourceSim">{s.date}</span>}
          {s.similarity !== undefined && (
            <span className="sourceSim">{Math.round(s.similarity * 100)}%</span>
          )}
        </button>
      ))}
      {open && <div className="sourceFull">{open.snippet}</div>}
    </details>
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

export function AssistantView() {
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
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
    const list = await api.assistantMessages(id).catch(() => null);
    if (list) setMessages(list);
  }, []);

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
        { ...(activeId ? { sessionId: activeId } : {}), message },
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

  return (
    <div className="chatLayout">
      <aside className="chatSidebar">
        <button
          type="button"
          className="btn chatNewBtn"
          onClick={() => {
            setActiveId(null);
            setMessages([]);
            setError(null);
          }}
        >
          <Plus size={13} strokeWidth={1.75} /> new chat
        </button>
        <div className="chatSearch">
          <Search size={13} strokeWidth={1.75} />
          <input
            type="text"
            placeholder="Search chats..."
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
          />
        </div>
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
      </aside>

      <section className="chatMain">
        <div className="chatMessages" ref={scrollRef}>
          {messages.length === 0 && !streaming && (
            <div className="chatWelcome">
              <p>Ask about your memories and documents.</p>
              <p className="chatWelcomeHint">
                Answers are grounded in your local store, with sources.
              </p>
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
                <SourcesPanel sources={m.sources} />
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
        <form
          className="chatComposer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
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
          <button
            type="submit"
            className="btn btnPrimary"
            disabled={streaming || draft.trim().length === 0}
          >
            {streaming ? "..." : "Send"}
          </button>
        </form>
      </section>
    </div>
  );
}
