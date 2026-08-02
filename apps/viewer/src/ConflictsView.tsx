import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type Conflict,
  type ConflictAutoEvent,
  type EntityAutoEvent,
  type EntityConflict,
  type EntityMerge,
  type PossibleContradiction,
  type ResolveDecision,
  type ResolvedConflict,
  type SettledEntityPair,
} from "./api";
import { toastDone, toastFailed, toastSaid } from "./toast";

// The decision inbox: a queue on the left, one thing to read on the right.
//
// Three kinds of question share this tab because they are all "you decide": which spelling an
// entity keeps, which of two beliefs is true, and whether a pair reconciliation flagged is a
// contradiction at all. Stacking them as three full-width lists meant the third was below the
// fold and the first thing you saw was whichever had the most rows. A rail fixes the ordering
// problem and leaves the pane free to show one item properly.
//
// Deciding advances to the next item, and the actions are numbered, because a queue is only
// worth having if it can be emptied in one sitting.

type Kind = "entities" | "memories" | "possible";

/** One row in the rail, whatever kind it came from. */
interface Row {
  id: string;
  /** Ordering signal. Entities carry a judgement score, the rest a cosine. Null sorts last. */
  score: number | null;
  tag: string;
  title: string;
}

const KINDS: Kind[] = ["entities", "memories", "possible"];

/** Highest score first, unrated last, newest first within a tie. */
function bySort(rows: Row[], sort: "score" | "recency"): Row[] {
  if (sort === "recency") return rows;
  return [...rows].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

function pct(score: number | null): string {
  return score === null ? "--" : score.toFixed(2);
}

export function ConflictsView({
  conflicts,
  onChanged,
  focus,
  onFocusConsumed,
}: {
  conflicts: Conflict[];
  onChanged: () => void;
  /** A conflict to open, set when arriving from a reconcile run's log. */
  focus?: string | null;
  onFocusConsumed?: () => void;
}) {
  const [kind, setKind] = useState<Kind>("memories");
  const [selected, setSelected] = useState<Record<Kind, string | null>>({
    entities: null,
    memories: null,
    possible: null,
  });
  const [sort, setSort] = useState<"score" | "recency">("score");
  const [entityConflicts, setEntityConflicts] = useState<EntityConflict[]>([]);
  const [possible, setPossible] = useState<PossibleContradiction[]>([]);
  const [resolved, setResolved] = useState<ResolvedConflict[]>([]);
  const [merges, setMerges] = useState<EntityMerge[]>([]);
  const [settled, setSettled] = useState<SettledEntityPair[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoLabel, setAutoLabel] = useState<string | null>(null);
  const [mergeText, setMergeText] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(() => {
    Promise.allSettled([
      api.entityConflicts(),
      api.possibleContradictions(),
      api.resolvedConflicts(),
      api.entityMerges(),
      api.settledEntityPairs(),
    ]).then(([e, p, r, m, s]) => {
      if (e.status === "fulfilled") setEntityConflicts(e.value);
      if (p.status === "fulfilled") setPossible(p.value);
      if (r.status === "fulfilled") setResolved(r.value);
      if (m.status === "fulfilled") setMerges(m.value);
      if (s.status === "fulfilled") setSettled(s.value);
    });
  }, []);
  // conflicts is a new array on every parent refresh, which is the signal to re-read the rest.
  // biome-ignore lint/correctness/useExhaustiveDependencies: conflicts is the refresh signal
  useEffect(load, [load, conflicts]);

  // Arriving from a reconcile run's log: open that conflict rather than scrolling to it.
  useEffect(() => {
    if (!focus) return;
    setKind("memories");
    setSelected((prev) => ({ ...prev, memories: focus }));
    const timer = setTimeout(() => onFocusConsumed?.(), 1500);
    return () => clearTimeout(timer);
  }, [focus, onFocusConsumed]);

  const rows: Record<Kind, Row[]> = useMemo(
    () => ({
      entities: entityConflicts.map((c) => ({
        id: c.id,
        score: c.candidates[0]?.score ?? null,
        tag: c.incoming.entityType,
        title: `${c.incoming.name} / ${c.candidates[0]?.name ?? "?"}`,
      })),
      memories: conflicts.map((c) => ({
        id: c.id,
        score: c.candidates[0]?.similarity ?? null,
        tag: `${c.candidates.length} candidate${c.candidates.length === 1 ? "" : "s"}`,
        title: c.incoming.content,
      })),
      possible: possible.map((p) => ({
        id: p.id,
        score: p.similarity,
        tag: p.model ?? "unconfirmed",
        title: p.newQuote || p.newMemory.content,
      })),
    }),
    [entityConflicts, conflicts, possible],
  );

  const visible = bySort(rows[kind], sort);
  const currentId = selected[kind] ?? visible[0]?.id ?? null;

  const select = (id: string | null) => setSelected((prev) => ({ ...prev, [kind]: id }));

  /** Deciding moves to the next item, so a queue can be worked without reaching for the mouse. */
  const advance = useCallback(() => {
    const list = bySort(rows[kind], sort);
    const at = list.findIndex((r) => r.id === (selected[kind] ?? list[0]?.id));
    const next = list[at + 1] ?? list[at - 1] ?? null;
    setSelected((prev) => ({ ...prev, [kind]: next?.id ?? null }));
  }, [rows, kind, sort, selected]);

  /**
   * Every decision goes through here, so `said` is where the outcome is named. A decision that
   * advances the queue moves the item off screen, which is exactly when a person needs telling
   * what they just chose.
   */
  async function act(
    id: string,
    run: () => Promise<unknown>,
    opts: { said?: string; thenAdvance?: boolean } = {},
  ) {
    setBusy(id);
    try {
      await run();
      if (opts.thenAdvance !== false) advance();
      setMergeText(null);
      load();
      onChanged();
      if (opts.said) toastDone(opts.said);
    } catch (err) {
      toastFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  // One button, two meanings, because the rail decides which queue it drains.
  async function resolveObvious() {
    setAutoRunning(true);
    try {
      if (kind === "entities") {
        const r = await api.autoResolveEntities((e: EntityAutoEvent) =>
          setAutoLabel(`${e.index}/${e.total}`),
        );
        toastSaid(`folded ${r.folded}, kept ${r.rejected} apart, left ${r.unsure} for you`);
      } else {
        const r = await api.autoResolveConflicts((e: ConflictAutoEvent) =>
          setAutoLabel(`${e.index}/${e.total}`),
        );
        toastSaid(`resolved ${r.resolved} of ${r.examined}, ${r.unsure} left for you`);
      }
      load();
      onChanged();
    } catch (err) {
      toastFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setAutoRunning(false);
      setAutoLabel(null);
    }
  }

  // Fills the entity queue: lexical rules fold what is certain and ask about the rest.
  async function findDuplicates() {
    setScanning(true);
    try {
      const r = await api.resolveEntities();
      toastSaid(`looked at ${r.examined} entities: folded ${r.merged}, ${r.queued} to decide`);
      load();
      onChanged();
    } catch (err) {
      toastFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }

  const conflict = conflicts.find((c) => c.id === currentId) ?? null;
  const entity = entityConflicts.find((c) => c.id === currentId) ?? null;
  const maybe = possible.find((p) => p.id === currentId) ?? null;

  // Number keys act, u undoes the newest decision, j and k walk the rail. Typing in the merge
  // box must not fire any of it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const list = bySort(rows[kind], sort);
      const at = list.findIndex((r) => r.id === (selected[kind] ?? list[0]?.id));
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((p) => ({ ...p, [kind]: list[Math.min(at + 1, list.length - 1)]?.id ?? null }));
        return;
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((p) => ({ ...p, [kind]: list[Math.max(at - 1, 0)]?.id ?? null }));
        return;
      }
      if (e.key === "u") {
        const newest = resolved[0];
        if (newest) void act(newest.id, () => api.revert(newest.id), { said: "undone", thenAdvance: false });
        return;
      }
      if (!currentId || busy) return;
      if (conflict) {
        const single = conflict.candidates.length === 1 ? conflict.candidates[0] : undefined;
        if (e.key === "1") {
          void act(currentId, () => api.resolve(currentId, { action: "keep_new" }), {
            said: "kept the new memory; the older one is now stale",
          });
        }
        if (e.key === "2" && single) {
          void act(
            currentId,
            () => api.resolve(currentId, { action: "keep_existing", candidateId: single.id }),
            { said: "kept the existing memory; the new one is now stale" },
          );
        }
        if (e.key === "3") {
          void act(currentId, () => api.resolve(currentId, { action: "keep_both" }), {
            said: "both kept; this pair will not be raised again",
          });
        }
        if (e.key === "m") setMergeText(conflict.incoming.content);
      }
      if (entity) {
        const cand = entity.candidates[0];
        if (e.key === "1" && cand) {
          void act(
            currentId,
            () => api.resolve(currentId, { action: "keep_existing", candidateId: cand.id }),
            { said: `folded into "${cand.name}"` },
          );
        }
        if (e.key === "2") {
          void act(currentId, () => api.resolve(currentId, { action: "keep_new" }), {
            said: "folded the other way",
          });
        }
        if (e.key === "3") {
          void act(currentId, () => api.resolve(currentId, { action: "keep_both" }), {
            said: "kept apart; this pair will not be raised again",
          });
        }
      }
      if (maybe) {
        if (e.key === "1") {
          void act(currentId, () => api.answerPossible(currentId, "approved"), {
            said: "moved to conflicts, waiting for you to resolve it",
          });
        }
        if (e.key === "2") {
          void act(currentId, () => api.answerPossible(currentId, "rejected"), {
            said: "dismissed as no conflict; this pair will not be raised again",
          });
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const counts: Record<Kind, number> = {
    entities: entityConflicts.length,
    memories: conflicts.length,
    possible: possible.length,
  };
  const obviousNote =
    kind === "entities"
      ? `${entityConflicts.length} pairs the spelling rules could not settle.`
      : `${conflicts.filter((c) => (c.candidates[0]?.similarity ?? 0) >= 0.8).length} of ${conflicts.length} above 0.80, the rest stay for you.`;

  return (
    <div className="inbox">
      <aside className="inboxRail">
        <nav className="inboxTabs">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={`inboxTab ${kind === k ? "inboxTabActive" : ""}`}
              onClick={() => setKind(k)}
            >
              {k}
              {counts[k] > 0 && <span className="inboxTabCount">{counts[k]}</span>}
            </button>
          ))}
        </nav>

        <div className="inboxSort">
          <span>sort</span>
          <button
            type="button"
            className={sort === "score" ? "inboxSortOn" : ""}
            onClick={() => setSort("score")}
          >
            similarity
          </button>
          <button
            type="button"
            className={sort === "recency" ? "inboxSortOn" : ""}
            onClick={() => setSort("recency")}
          >
            recency
          </button>
        </div>

        <div className="inboxQueue">
          {visible.length === 0 && <p className="inboxEmpty">Nothing to decide here.</p>}
          {visible.map((row) => (
            <button
              key={row.id}
              type="button"
              className={`inboxRow ${row.id === currentId ? "inboxRowActive" : ""}`}
              onClick={() => select(row.id)}
            >
              <span className="inboxRowHead">
                <span className="inboxScore">{pct(row.score)}</span>
                <span className="inboxTag">{row.tag}</span>
              </span>
              <span className="inboxRowTitle">{row.title}</span>
            </button>
          ))}
        </div>

        <div className="inboxFoot">
          {kind !== "possible" && counts[kind] > 0 && (
            <>
              <button
                type="button"
                className="btn btnPrimary"
                disabled={autoRunning || scanning}
                onClick={resolveObvious}
              >
                {autoRunning ? `Deciding ${autoLabel ?? ""}` : "resolve the obvious ones"}
              </button>
              <p className="inboxNote">{obviousNote}</p>
            </>
          )}
          {kind === "entities" && (
            <button
              type="button"
              className="btn"
              disabled={autoRunning || scanning}
              onClick={findDuplicates}
              title="Folds spellings that differ only in case or punctuation, and asks about the rest."
            >
              {scanning ? "Scanning…" : "find duplicate entities"}
            </button>
          )}
        </div>

        <button
          type="button"
          className="inboxResolved"
          onClick={() => setShowResolved((v) => !v)}
        >
          {showResolved ? "▾" : "▸"} resolved {resolved.length + merges.length + settled.length}
        </button>
        {showResolved && (
          <div className="inboxDrawer">
            {resolved.slice(0, 20).map((r) => (
              <div key={r.id} className="inboxRow">
                <span className="inboxRowHead">
                  <span className="inboxTag">{r.resolution.replace("_", " ")}</span>
                  <button
                    type="button"
                    className="linkBtn"
                    onClick={() => void act(r.id, () => api.revert(r.id), { said: "undone", thenAdvance: false })}
                  >
                    undo
                  </button>
                </span>
                <span className="inboxRowTitle">{r.incoming.content}</span>
              </div>
            ))}
            {merges
              .filter((m) => !m.revertedAt)
              .slice(0, 20)
              .map((m) => (
                <div key={m.id} className="inboxRow">
                  <span className="inboxRowHead">
                    <span className="inboxTag">
                      {m.decidedBy === "llm" ? `folded by ${m.model ?? "a model"}` : "folded"}
                    </span>
                    <button
                      type="button"
                      className="linkBtn"
                      onClick={() =>
                        void act(m.id, () => api.revertEntityMerge(m.id), {
                          said: `"${m.sourceName}" is a separate entity again`,
                          thenAdvance: false,
                        })
                      }
                    >
                      revert
                    </button>
                  </span>
                  <span className="inboxRowTitle">
                    "{m.sourceName}" now resolves to "{m.canonicalName}"
                  </span>
                </div>
              ))}
            {settled.slice(0, 20).map((p) => (
              <div key={p.id} className="inboxRow">
                <span className="inboxRowHead">
                  <span className="inboxTag">
                    {p.decidedBy === "llm" ? `kept apart by ${p.model ?? "a model"}` : "kept apart"}
                  </span>
                  <button
                    type="button"
                    className="linkBtn"
                    onClick={() =>
                    void act(p.id, () => api.revert(p.id), {
                      said: "back in the queue to decide again",
                      thenAdvance: false,
                    })
                  }
                  >
                    ask again
                  </button>
                </span>
                <span className="inboxRowTitle">
                  "{p.incomingName}" and "{p.candidateName}" are different things
                </span>
              </div>
            ))}
          </div>
        )}
      </aside>

      <section className="inboxPane">
        {!currentId && <p className="inboxEmpty">Pick something on the left.</p>}

        {conflict && (
          <>
            <header className="paneHead">
              <span className="paneKind">memory conflict</span>
              <span className="paneScore">
                similarity <b>{pct(conflict.candidates[0]?.similarity ?? null)}</b>
              </span>
            </header>
            <div className="paneLabel">new</div>
            <div className="statement statementNew">{conflict.incoming.content}</div>
            {conflict.candidates.map((c) => (
              <div key={c.id}>
                <div className="paneLabel">existing</div>
                <div className="statement statementExisting">{c.content}</div>
                {c.reason && <div className="reason">{c.reason}</div>}
              </div>
            ))}
            {mergeText !== null && (
              <textarea
                value={mergeText}
                onChange={(e) => setMergeText(e.target.value)}
                placeholder="The reconciled statement that replaces both"
              />
            )}
            <footer className="paneActions">
              {mergeText !== null ? (
                <button
                  type="button"
                  className="btn btnPrimary"
                  disabled={busy === conflict.id || mergeText.trim().length === 0}
                  onClick={() =>
                    act(
                      conflict.id,
                      () =>
                        api.resolve(conflict.id, { action: "merge", content: mergeText.trim() }),
                      { said: "merged into one memory; both originals are now stale" },
                    )
                  }
                >
                  Save merged memory
                </button>
              ) : (
                <>
                  <Action
                    k="1"
                    label="keep new"
                    primary
                    disabled={busy === conflict.id}
                    onClick={() =>
                      act(conflict.id, () => api.resolve(conflict.id, { action: "keep_new" }), {
                        said: "kept the new memory; the older one is now stale",
                      })
                    }
                  />
                  {conflict.candidates.length === 1 && conflict.candidates[0] && (
                    <Action
                      k="2"
                      label="keep existing"
                      disabled={busy === conflict.id}
                      onClick={() =>
                        act(
                          conflict.id,
                          () =>
                            api.resolve(conflict.id, {
                              action: "keep_existing",
                              candidateId: conflict.candidates[0]?.id ?? "",
                            }),
                          { said: "kept the existing memory; the new one is now stale" },
                        )
                      }
                    />
                  )}
                  <Action
                    k="3"
                    label="keep both"
                    disabled={busy === conflict.id}
                    onClick={() =>
                      act(conflict.id, () => api.resolve(conflict.id, { action: "keep_both" }), {
                        said: "both kept; this pair will not be raised again",
                      })
                    }
                  />
                  <Action
                    k="m"
                    label="merge…"
                    disabled={busy === conflict.id}
                    onClick={() => setMergeText(conflict.incoming.content)}
                  />
                </>
              )}
              <span className="paneHint">
                deciding advances to the next; <kbd>u</kbd> undo
              </span>
            </footer>
          </>
        )}

        {entity && entity.candidates[0] && (
          <>
            <header className="paneHead">
              <span className="paneKind">same thing?</span>
              <span className="paneScore">
                score <b>{pct(entity.candidates[0].score)}</b>
              </span>
            </header>
            <div className="statement statementNew">
              {entity.incoming.name}{" "}
              <span className="paneMuted">
                ({entity.incoming.entityType}, {entity.incoming.mentions} mentions)
              </span>
            </div>
            <div className="statement statementExisting">
              {entity.candidates[0].name}{" "}
              <span className="paneMuted">
                ({entity.candidates[0].entityType}, {entity.candidates[0].mentions} mentions)
              </span>
            </div>
            <div className="reason">{entity.candidates[0].reason}</div>
            <footer className="paneActions">
              <Action
                k="1"
                label={`keep "${entity.candidates[0].name}"`}
                primary
                disabled={busy === entity.id}
                onClick={() =>
                  act(
                    entity.id,
                    () =>
                      api.resolve(entity.id, {
                        action: "keep_existing",
                        candidateId: entity.candidates[0]?.id ?? "",
                      }),
                    { said: `folded into "${entity.candidates[0]?.name ?? ""}"` },
                  )
                }
              />
              <Action
                k="2"
                label={`keep "${entity.incoming.name}"`}
                disabled={busy === entity.id}
                onClick={() =>
                  act(entity.id, () => api.resolve(entity.id, { action: "keep_new" }), {
                    said: `folded into "${entity.incoming.name}"`,
                  })
                }
              />
              <Action
                k="3"
                label="different things"
                disabled={busy === entity.id}
                onClick={() =>
                  act(entity.id, () => api.resolve(entity.id, { action: "keep_both" }), {
                    said: "kept apart; this pair will not be raised again",
                  })
                }
              />
              <span className="paneHint">deciding advances to the next</span>
            </footer>
          </>
        )}

        {maybe && (
          <>
            <header className="paneHead">
              <span className="paneKind">possible contradiction</span>
              <span className="paneScore">
                similarity <b>{pct(maybe.similarity)}</b>
              </span>
            </header>
            <div className="paneLabel">new</div>
            <div className="statement statementNew">{maybe.newQuote}</div>
            <div className="paneLabel">existing</div>
            <div className="statement statementExisting">{maybe.oldQuote}</div>
            <div className="reason">
              {maybe.model ? `${maybe.model}: ` : ""}
              {maybe.reason}
            </div>
            <details className="possibleFull">
              <summary>the two memories in full</summary>
              <div className="reason">{maybe.newMemory.content}</div>
              <div className="reason">{maybe.oldMemory.content}</div>
            </details>
            <footer className="paneActions">
              <Action
                k="1"
                label="these conflict"
                primary
                disabled={busy === maybe.id}
                onClick={() =>
                  act(maybe.id, () => api.answerPossible(maybe.id, "approved"), {
                    said: "moved to conflicts, waiting for you to resolve it",
                  })
                }
              />
              <Action
                k="2"
                label="no"
                disabled={busy === maybe.id}
                onClick={() =>
                  act(maybe.id, () => api.answerPossible(maybe.id, "rejected"), {
                    said: "dismissed as no conflict; this pair will not be raised again",
                  })
                }
              />
              <span className="paneHint">
                confirming makes it a real conflict; dismissing is permanent
              </span>
            </footer>
          </>
        )}

      </section>
    </div>
  );
}

/** An action with its key hint, so the shortcut is discoverable instead of documented. */
function Action({
  k,
  label,
  onClick,
  disabled,
  primary,
}: {
  k: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={`btn ${primary ? "btnPrimary" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      {label} <kbd>{k}</kbd>
    </button>
  );
}
