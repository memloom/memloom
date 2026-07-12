import { useCallback, useEffect, useState } from "react";
import { api, type SchemaEntry, type SchemaInfo } from "./api";

// The graph schema registry: what the indexer is allowed to extract. System defaults,
// user-added entries, and the LLM proposal review queue (approve promotes a name into the
// vocabulary; dismiss blocklists it from ever being proposed again).

function VocabSection({
  title,
  entries,
  onToggle,
}: {
  title: string;
  entries: (SchemaEntry & { count: number })[];
  onToggle: (entry: SchemaEntry) => void;
}) {
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
            <button type="button" className="metaAction" onClick={() => onToggle(entry)}>
              {entry.status === "disabled" ? "enable" : "disable"}
            </button>
          </div>
          {entry.description && <div className="schemaRowBody">{entry.description}</div>}
        </div>
      ))}
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
            />
            <VocabSection
              title="predicates"
              entries={schema.predicates}
              onToggle={(e) =>
                act(() =>
                  api.setSchemaStatus(e.id, e.status === "disabled" ? "active" : "disabled"),
                )
              }
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
