import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type EntityDetail, type SchemaEntry, type SchemaInfo } from "./api";

// The graph schema registry: what the indexer is allowed to extract. System defaults,
// user-added entries, and the LLM proposal review queue (approve promotes a name into the
// vocabulary; dismiss blocklists it from ever being proposed again).

function VocabSection({
  title,
  entries,
  onToggle,
  onDelete,
}: {
  title: string;
  entries: (SchemaEntry & { count: number })[];
  onToggle: (entry: SchemaEntry) => void;
  onDelete: (entry: SchemaEntry) => void;
}) {
  // Two-click delete (the DocumentsView pattern); clicking anything else disarms.
  const [armedId, setArmedId] = useState<string | null>(null);
  return (
    <div className="card">
      <div className="cardLabel">
        {title} · {entries.length}
      </div>
      {entries.map((entry) => (
        <div
          key={entry.id}
          className={`schemaRow ${entry.status === "disabled" ? "schemaRowDisabled" : ""}`}
        >
          <div className="schemaRowHead">
            <span className="typeTag">{entry.name}</span>
            {entry.tier === "user" && <span className="tierTag">user</span>}
            <span className="docMeta">
              {entry.count > 0 ? `${entry.count} in graph` : "unused"}
            </span>
            <button
              type="button"
              className="metaAction"
              onClick={() => {
                setArmedId(null);
                onToggle(entry);
              }}
            >
              {entry.status === "disabled" ? "enable" : "disable"}
            </button>
            {/* Delete exists only for disabled user entries: system rows are re-seeded by
                name (a delete would resurrect them active), and active rows disable first. */}
            {entry.tier === "user" && entry.status === "disabled" && (
              <button
                type="button"
                className={`metaAction ${armedId === entry.id ? "metaActionDanger" : ""}`}
                onClick={() => {
                  if (armedId !== entry.id) {
                    setArmedId(entry.id);
                    return;
                  }
                  setArmedId(null);
                  onDelete(entry);
                }}
              >
                {armedId === entry.id ? "confirm delete" : "delete"}
              </button>
            )}
          </div>
          {entry.description && <div className="schemaRowBody">{entry.description}</div>}
        </div>
      ))}
    </div>
  );
}

// The instances list: every extracted entity with usage counts, and the correction
// primitives — rename, retype, merge-into (repoints edges), delete (sweeps edges).
function EntitiesSection({
  activeTypes,
  onChanged,
}: {
  activeTypes: string[];
  onChanged: () => void;
}) {
  const [entities, setEntities] = useState<EntityDetail[] | null>(null);
  // Collapsed by default: the schema (types + predicates) is this tab's main content;
  // the instance list can be hundreds of rows and must never push it below the fold.
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .entities()
      .then(setEntities)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const shown = useMemo(() => {
    if (!entities) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return entities;
    return entities.filter(
      (e) => e.name.toLowerCase().includes(needle) || e.entityType.includes(needle),
    );
  }, [entities, filter]);

  if (!entities) return null;

  return (
    <div className="card">
      <button
        type="button"
        className="cardLabel cardLabelToggle"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "▾" : "▸"} entities · {entities.length}
      </button>
      {open && (
        <div className="entityList">
          {error && <div className="notice noticeError">{error}</div>}
          {entities.length > 8 && (
            <input
              type="text"
              className="entityFilter"
              placeholder="Filter entities..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          {entities.length === 0 && (
            <p className="schemaHint">No entities yet — run an index to extract them.</p>
          )}
          {shown.map((e) => (
            <div key={e.id} className="schemaRow">
              <div className="schemaRowHead">
                {renamingId === e.id ? (
                  <input
                    type="text"
                    className="entityRenameInput"
                    value={renameValue}
                    ref={(el) => el?.focus()}
                    onChange={(ev) => setRenameValue(ev.target.value)}
                    onBlur={() => setRenamingId(null)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" && renameValue.trim()) {
                        setRenamingId(null);
                        void act(() => api.updateEntity(e.id, { name: renameValue.trim() }));
                      }
                      if (ev.key === "Escape") setRenamingId(null);
                    }}
                  />
                ) : (
                  <span className="typeTag">{e.name}</span>
                )}
                <select
                  className="entityTypeSelect"
                  value={e.entityType}
                  disabled={busy}
                  onChange={(ev) =>
                    void act(() => api.updateEntity(e.id, { entityType: ev.target.value }))
                  }
                >
                  {/* An entity can carry a type that was since disabled; keep it selectable. */}
                  {[...new Set([e.entityType, ...activeTypes])].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <span className="docMeta">
                  {e.mentions > 0
                    ? `${e.mentions} mentions · ${e.documents} docs · ${e.memories} memories`
                    : "unused"}
                </span>
                <button
                  type="button"
                  className="metaAction"
                  disabled={busy}
                  onMouseDown={(ev) => {
                    // preventDefault: the default mousedown focus change would blur (and
                    // instantly close) the rename input React is about to render.
                    ev.preventDefault();
                    setArmedId(null);
                    setMergingId(null);
                    setRenameValue(e.name);
                    setRenamingId(e.id);
                  }}
                >
                  rename
                </button>
                <button
                  type="button"
                  className="metaAction"
                  disabled={busy}
                  onClick={() => {
                    setArmedId(null);
                    setMergingId(mergingId === e.id ? null : e.id);
                  }}
                >
                  merge
                </button>
                <button
                  type="button"
                  className={`metaAction ${armedId === e.id ? "metaActionDanger" : ""}`}
                  disabled={busy}
                  onClick={() => {
                    if (armedId !== e.id) {
                      setMergingId(null);
                      setArmedId(e.id);
                      return;
                    }
                    setArmedId(null);
                    void act(() => api.deleteEntity(e.id));
                  }}
                >
                  {armedId === e.id ? "confirm delete" : "delete"}
                </button>
              </div>
              {mergingId === e.id && (
                <div className="entityMergeRow">
                  <span className="docMeta">
                    fold "{e.name}" into — its mentions and relations move to the survivor:
                  </span>
                  <select
                    className="entityTypeSelect"
                    defaultValue=""
                    disabled={busy}
                    onChange={(ev) => {
                      const into = ev.target.value;
                      if (!into) return;
                      setMergingId(null);
                      void act(() => api.mergeEntity(e.id, into));
                    }}
                  >
                    <option value="" disabled>
                      choose the surviving entity...
                    </option>
                    {entities
                      .filter((other) => other.id !== e.id)
                      .map((other) => (
                        <option key={other.id} value={other.id}>
                          {other.name} ({other.entityType})
                        </option>
                      ))}
                  </select>
                </div>
              )}
            </div>
          ))}
          {shown.length === 0 && entities.length > 0 && (
            <p className="schemaHint">no entities matched the filter</p>
          )}
        </div>
      )}
    </div>
  );
}

export function SchemaView({ onChanged }: { onChanged: () => void }) {
  const [schema, setSchema] = useState<SchemaInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"entity_type" | "predicate">("entity_type");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .schema()
      .then(setSchema)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!schema && !error) return <div className="panel">{}</div>;

  return (
    <div className="panel">
      <div className="panelInner">
        <h2 className="sectionTitle">Graph schema</h2>
        {error && <div className="notice noticeError">{error}</div>}

        {schema && (
          <EntitiesSection
            activeTypes={schema.entityTypes.filter((t) => t.status === "active").map((t) => t.name)}
            onChanged={onChanged}
          />
        )}

        {schema && schema.proposals.length > 0 && (
          <div className="card">
            <div className="cardLabel">proposed by the indexer · {schema.proposals.length}</div>
            <p className="schemaHint">
              The extraction model wanted these vocabulary names. Approve to start extracting with
              them (re-index to capture earlier occurrences); dismiss to never see them proposed
              again.
            </p>
            {schema.proposals.map((p) => (
              <div key={p.id} className="schemaRow">
                <div className="schemaRowHead">
                  <span className="typeTag">{p.name}</span>
                  <span className="tierTag">{p.kind === "entity_type" ? "type" : "predicate"}</span>
                  <span className="docMeta">suggested {p.occurrences}×</span>
                  <button
                    type="button"
                    className="metaAction"
                    disabled={busy}
                    onClick={() => act(() => api.approveProposal(p.id))}
                  >
                    approve
                  </button>
                  <button
                    type="button"
                    className="metaAction"
                    disabled={busy}
                    onClick={() => act(() => api.dismissProposal(p.id))}
                  >
                    dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {schema && (
          <>
            <VocabSection
              title="entity types"
              entries={schema.entityTypes}
              onToggle={(e) =>
                act(() =>
                  api.setSchemaStatus(e.id, e.status === "disabled" ? "active" : "disabled"),
                )
              }
              onDelete={(e) => act(() => api.deleteSchemaEntry(e.id))}
            />
            <VocabSection
              title="predicates"
              entries={schema.predicates}
              onToggle={(e) =>
                act(() =>
                  api.setSchemaStatus(e.id, e.status === "disabled" ? "active" : "disabled"),
                )
              }
              onDelete={(e) => act(() => api.deleteSchemaEntry(e.id))}
            />

            <div className="card">
              <div className="cardLabel">add your own</div>
              <div className="formRow">
                <select
                  className="schemaKindSelect"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as "entity_type" | "predicate")}
                >
                  <option value="entity_type">entity type</option>
                  <option value="predicate">predicate</option>
                </select>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="name (snake_case, e.g. medication)"
                />
              </div>
              <div className="formRow">
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Description — this text steers the extractor, write it like a rule"
                />
                <button
                  type="button"
                  className="btn btnPrimary"
                  disabled={busy || name.trim().length < 2}
                  onClick={() =>
                    act(async () => {
                      await api.addSchemaEntry({
                        kind,
                        name: name.trim(),
                        description: description.trim(),
                      });
                      setName("");
                      setDescription("");
                    })
                  }
                >
                  Add
                </button>
              </div>
            </div>

            <div className="card">
              <div className="cardLabel">edge relations (engine-defined)</div>
              {schema.relations.map((r) => (
                <div key={r.name} className="schemaRow">
                  <div className="schemaRowHead">
                    <span className="typeTag">{r.name}</span>
                    <span className="docMeta">
                      {r.count > 0 ? `${r.count} in graph` : "unused"}
                    </span>
                  </div>
                  <div className="schemaRowBody">{r.description}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
