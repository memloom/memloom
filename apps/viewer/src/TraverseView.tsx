import { ArrowLeft, ArrowRight, Search } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, type RelatedEntities, type RelatedEntity } from "./api";

// Traverse the graph from one entity, docked beside the canvas. This answers a different
// question from the assistant next to it: the assistant reads your memories and writes prose,
// this walks edges and returns the graph itself. Clicking a neighbour selects it on the canvas
// AND becomes the next query, so following a chain of people is one click per hop.

const TYPES = [
  "person",
  "organization",
  "project",
  "tool",
  "technology",
  "agent",
  "place",
  "event",
  "concept",
];

export function TraverseView({
  onOpenEntity,
  onResult,
}: {
  onOpenEntity: (id: string) => void;
  /** Tells the canvas which nodes this answer covers, so everything else can be dimmed. */
  onResult: (focal: string | null, related: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [result, setResult] = useState<RelatedEntities | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(target: string, entityType = type) {
    if (!target.trim()) return;
    setBusy(true);
    setError(null);
    setMissing(null);
    try {
      const found = await api.relatedEntities(target.trim(), entityType || undefined);
      setResult(found);
      onResult(found?.entity.id ?? null, found?.related.map((r) => r.id) ?? []);
      // A miss and an entity with no neighbours look identical in the result shape but mean
      // opposite things, so the empty state has to know which one happened.
      if (!found) setMissing(target.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      onResult(null, []);
    } finally {
      setBusy(false);
    }
  }

  function clear() {
    setQuery("");
    setResult(null);
    setMissing(null);
    setError(null);
    onResult(null, []);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(query);
  }

  /** Follow a neighbour: show it on the canvas and make it the new centre of the panel. */
  function hop(entity: RelatedEntity) {
    onOpenEntity(entity.id);
    setQuery(entity.name);
    void run(entity.id);
  }

  const stated = result?.related.filter((r) => r.links.length > 0) ?? [];
  const coMention = result?.related.filter((r) => r.links.length === 0) ?? [];

  return (
    <div className="graphDockScroll">
      <form onSubmit={submit} className="traverseForm">
        <input
          type="text"
          className="entityFilter"
          placeholder="An entity name, or a spelling folded into one..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="actions">
          <select
            className="traverseType"
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              // Re-run against the entity already on screen, so changing the filter does not
              // silently leave stale results under a new label.
              if (result) void run(result.entity.id, e.target.value);
            }}
          >
            <option value="">any type</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btnPrimary" disabled={busy || !query.trim()}>
            <Search size={13} strokeWidth={1.75} /> {busy ? "Walking..." : "Traverse"}
          </button>
          {result && (
            <button type="button" className="btn" onClick={clear} title="Undim the whole graph">
              Clear
            </button>
          )}
        </div>
      </form>

      {error && <div className="notice noticeError">{error}</div>}

      {missing && !result && (
        <p style={{ color: "var(--text-faint)" }}>
          No entity named "{missing}". Names are matched exactly, aliases included, not by
          meaning. Try a name from the graph or the schema tab.
        </p>
      )}

      {!result && !missing && !error && (
        <p style={{ color: "var(--text-faint)" }}>
          Walk the graph from one entity: who and what it is connected to. The canvas dims to
          the answer, and clicking a neighbour follows it. Relationships the extractor stated
          are listed apart from entities that merely turn up in the same memories, because only
          the first kind is something the graph asserted.
        </p>
      )}

      {result && (
        <>
          <h2 className="sectionTitle">
            {result.entity.name}{" "}
            <span style={{ color: "var(--text-faint)", fontWeight: 400 }}>
              ({result.entity.entityType}, {result.entity.mentions} mentions)
            </span>
          </h2>
          {result.matchedAlias && (
            <div className="notice">
              "{result.matchedAlias}" is a folded-in spelling of {result.entity.name}, so this
              answers about the entity it now belongs to.
            </div>
          )}
          {result.entity.aliases.length > 0 && (
            <div className="reason">also written: {result.entity.aliases.join(", ")}</div>
          )}

          {result.related.length === 0 && (
            <p style={{ color: "var(--text-faint)" }}>
              Nothing{type ? ` of type ${type}` : ""} is connected to it yet. Entities connect
              through the memories that mention them, so this fills in as you save more.
            </p>
          )}

          {stated.length > 0 && (
            <>
              <h2 className="sectionTitle">Stated relationships</h2>
              <div className="conflictList">
                {stated.map((r) => (
                  <NeighbourCard key={r.id} entity={r} onOpen={() => hop(r)} />
                ))}
              </div>
            </>
          )}

          {coMention.length > 0 && (
            <>
              <h2 className="sectionTitle">Appears together with</h2>
              <div className="conflictList">
                {coMention.map((r) => (
                  <NeighbourCard key={r.id} entity={r} onOpen={() => hop(r)} />
                ))}
              </div>
            </>
          )}

          {result.truncated > 0 && (
            <div className="reason">
              and {result.truncated} more, not shown. Narrow it with the type filter.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function NeighbourCard({ entity, onOpen }: { entity: RelatedEntity; onOpen: () => void }) {
  return (
    <button type="button" className="card traverseCard" onClick={onOpen}>
      <div className="statement statementExisting">
        {entity.name}{" "}
        <span style={{ color: "var(--text-faint)" }}>
          ({entity.entityType}, {entity.mentions} mentions)
        </span>
      </div>
      {entity.aliases.length > 0 && (
        <div className="reason">also written: {entity.aliases.join(", ")}</div>
      )}
      <div className="reason">
        {entity.links.map((l) => (
          <span key={`${l.relation}-${l.direction}`} className="traverseLink">
            {l.direction === "out" ? (
              <ArrowRight size={11} strokeWidth={2} />
            ) : (
              <ArrowLeft size={11} strokeWidth={2} />
            )}
            {l.relation}
            {l.confidence != null && ` (${l.confidence.toFixed(2)})`}
          </span>
        ))}
        {entity.links.length > 0 && " . "}
        {entity.sharedSources} shared {entity.sharedSources === 1 ? "source" : "sources"}
      </div>
    </button>
  );
}
