// The graph schema: the closed vocabularies that constrain what the indexer may put in
// the graph. Both the extraction prompt and the code-level validators render from these
// constants, so they can never drift apart. Per-user configurability is future work (a
// MemloomConfig extension point); for now the schema is deliberately a code constant —
// a closed vocabulary is the fix for extraction noise, not a preference.

export interface EntityTypeDef {
  readonly name: string;
  readonly description: string;
}

// The 8 entity types. "thing" is gone on purpose: a sink type is where garbage
// accumulates (487 of the 492 noise entities in the motivating corpus would have needed
// one). An extraction with a type outside this list is DROPPED, never coerced.
export const ENTITY_TYPES: readonly EntityTypeDef[] = [
  {
    name: "person",
    description:
      'A specific named human being ("Maria Skłodowska-Curie") — never roles, groups, or grammatical subjects.',
  },
  {
    name: "organization",
    description:
      'A named company, team, school, or institution ("Anthropic", "Uniwersytet Jagielloński").',
  },
  {
    name: "project",
    description: 'A named project, product, repository, or initiative ("memloom").',
  },
  {
    name: "tool",
    description: 'A named application or service used to get things done ("Figma", "Docker").',
  },
  {
    name: "technology",
    description:
      'A named language, framework, library, protocol, or database ("TypeScript", "PGLite").',
  },
  {
    name: "place",
    description: 'A specific geographic or physical location ("Kraków", "CERN").',
  },
  {
    name: "event",
    description:
      'A specific nameable occurrence — a conference, exam, release, trip ("matura 2026").',
  },
  {
    name: "concept",
    description:
      'LAST RESORT: a proper, named idea someone would search by name ("twierdzenie Pitagorasa", "Bayes\' theorem") — never generic domain words like "wzór" or "funkcja".',
  },
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number]["name"];

export const ENTITY_TYPE_NAMES: ReadonlySet<string> = new Set(ENTITY_TYPES.map((t) => t.name));

export interface EdgeRelationDef {
  readonly name: string;
  readonly description: string;
  /** Synthesized for display (viewer), never stored in memory_edges. */
  readonly virtual?: true;
}

// Every relation the engine writes (or the viewer synthesizes), formalized.
export const EDGE_RELATIONS: readonly EdgeRelationDef[] = [
  {
    name: "mention",
    description:
      "A memory or context chunk mentions an entity (created by the indexer); also the quarantine relation for unproven entity-to-entity relationships.",
  },
  {
    name: "replaces",
    description:
      "A newer belief version supersedes an older one (versioning and conflict supersession).",
  },
  {
    name: "distinct",
    description: "Two similar beliefs deliberately kept separate (conflict keep_both).",
  },
  {
    name: "chunk",
    description:
      "Document contains chunk — synthesized in the viewer when a document blooms; never stored.",
    virtual: true,
  },
] as const;

export interface PredicateDef {
  readonly name: string;
  readonly description: string;
}

// The closed predicate vocabulary for typed entity-to-entity relationships. The extractor
// classifies against exactly these names; anything else (and anything under the confidence
// floor) is stored as a plain 'mention' edge — quarantine semantics without a review UI.
// No per-owner registry or proposal lifecycle here (that is multi-tenant machinery; future).
export const PREDICATES: readonly PredicateDef[] = [
  {
    name: "uses",
    description: "Subject relies on a tool or technology in practice (memloom uses PGLite).",
  },
  {
    name: "depends_on",
    description: "A hard structural dependency between projects or technologies.",
  },
  {
    name: "part_of",
    description:
      "Membership or containment: a team part_of an organization, a module part_of a project, a district part_of a city.",
  },
  {
    name: "created_by",
    description: "A project or concept was made by a person or organization.",
  },
  {
    name: "works_on",
    description: "A person actively works on a project.",
  },
  {
    name: "works_at",
    description: "A person is employed by or affiliated with an organization.",
  },
  {
    name: "located_in",
    description: "A person, organization, or event is physically in a place.",
  },
  {
    name: "attended",
    description: "A person attended or participated in an event.",
  },
] as const;

export type PredicateName = (typeof PREDICATES)[number]["name"];

export const PREDICATE_NAMES: ReadonlySet<string> = new Set(PREDICATES.map((p) => p.name));

/** Below this, a typed relationship is stored as a plain 'mention' edge (quarantine). */
export const MIN_RELATIONSHIP_CONFIDENCE = 0.7;
