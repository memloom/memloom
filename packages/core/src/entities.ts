import type { LLMProvider } from "./providers.js";
import {
  type ActiveSchema,
  DEFAULT_ACTIVE_SCHEMA,
  MIN_RELATIONSHIP_CONFIDENCE,
  normalizeSchemaName,
  type SchemaKind,
} from "./schema.js";

// Graph extraction: entities AND typed relationships in one LLM call, constrained by the
// ACTIVE schema (the registry rows, defaulting to the system tier) at BOTH ends: the
// prompt renders the vocabularies, and parseExtraction enforces them because the prompt
// is not trusted. Precision first: a clean graph of real things beats a complete one
// full of noise. Unknown-but-clean names become PROPOSALS for the review queue instead
// of graph rows.

export interface ExtractedEntity {
  name: string;
  type: string;
}

export interface ExtractedRelationship {
  subject: string;
  predicate: string;
  confidence: number;
  object: string;
}

export interface SchemaProposal {
  kind: SchemaKind;
  name: string;
}

export interface Extraction {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  /** Vocabulary names the model wanted but the schema lacks: review-queue input. */
  proposals: SchemaProposal[];
}

export interface ExtractionContext {
  /** Title of the document a chunk came from: grounds salience judgments. */
  docTitle?: string;
  /**
   * Canonical names already in the owner's graph. Rendered into the prompt so the model
   * reuses exact spellings ("@memloom/core", not "memloom/core") instead of minting
   * near-duplicates that resolution then has to fold.
   */
  knownEntities?: string[];
}

const MAX_ENTITIES = 5;
const MAX_RELATIONSHIPS = 5;
const MAX_NAME_LENGTH = 40;
const MAX_NAME_WORDS = 5;
// Any hard math symbol anywhere in the name, or LaTeX residue.
const MATH_SYMBOLS = /[=^√∫∑∏∈∉≤≥≠→±≈∞′²³]|\\(frac|sqrt|int|sum)/;
// "3 + 4", "2x·5", "10/2": digit, arithmetic operator, digit.
const DIGIT_OP_DIGIT = /\d\s*[+\-*/·×:^]\s*\d/;
// "f(x)", "g'(2)": single ASCII letter (optionally primed) followed by parens.
// ASCII-only on purpose: math function names are ASCII; Polish words never match.
const FUNC_CALL = /\b[a-zA-Z]['′]?\s*\([^)]*\)/;
const LETTER = /\p{L}/gu; // Unicode letters: Ł, ż, ó all count

export function buildEntityPrompt(
  content: string,
  context: ExtractionContext = {},
  schema: ActiveSchema = DEFAULT_ACTIVE_SCHEMA,
): string {
  const typeLines = schema.entityTypes.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const predicateLines = schema.predicates.map((p) => `- ${p.name}: ${p.description}`).join("\n");
  return [
    "You extract a knowledge graph from one text for a personal memory system. PRECISION FIRST.",
    "Extract only SIGNAL: named, reusable things worth linking across MANY memories.",
    "When in doubt, do NOT extract. Empty arrays are a good answer.",
    "",
    "ALLOWED ENTITY TYPES:",
    typeLines,
    '"concept" is a LAST RESORT.',
    "If a clearly reusable category is missing, you may use a NEW short snake_case type;",
    "the entity is then held for the user's review instead of entering the graph. Rare.",
    "",
    "DO NOT EXTRACT:",
    '- mathematical expressions, formulas, or equations ("y = x^3 - 2x^2", "a + 2a = 6")',
    '- exercise or task phrasing in any language ("Wyznacz największą wartość", "solve for the unknown")',
    '- generic domain words in any language ("wzór", "punkty", "zadanie", "equation", "derivative")',
    "- sentence fragments or clauses copied from the text",
    "- numbers, dates, quantities, one-off literals, code fragments",
    "",
    "ONE ENTITY = ONE THING. Use the canonical name. At most 5 entities, the most salient only.",
    ...(context.knownEntities && context.knownEntities.length > 0
      ? [
          "KNOWN ENTITIES already in the graph: when the text refers to one of these,",
          "reuse the EXACT spelling below instead of a variant:",
          context.knownEntities.join(", "),
        ]
      : []),
    "",
    "RELATIONSHIPS: only ones the text ACTUALLY STATES, between names in your entities array.",
    "ALLOWED PREDICATES:",
    predicateLines,
    "confidence is 0..1: how explicitly the text states it. If no predicate fits, you may",
    "supply a NEW short snake_case name; the link is stored as a plain mention and the",
    "name is proposed for the user's review. Propose sparingly.",
    ...(schema.dismissed.length > 0
      ? [`NEVER propose these rejected names: ${schema.dismissed.join(", ")}.`]
      : []),
    "",
    'GOOD: {"entities":[{"name":"Ada Lovelace","type":"person"},{"name":"Analytical Engine","type":"project"}],',
    '       "relationships":[{"subject":"Ada Lovelace","predicate":"works_on","confidence":0.95,"object":"Analytical Engine"}]}',
    'BAD entity: {"name":"y = x^3 - 2x^2"} (a formula), {"name":"wzór"} (generic word),',
    '            {"name":"największa wartość w przedziale"} (sentence fragment)',
    "",
    ...(context.docTitle ? [`SOURCE: ${context.docTitle}`] : []),
    `TEXT: ${content}`,
    "",
    'Return ONLY a JSON object: {"entities":[{"name":"...","type":"..."}],',
    '"relationships":[{"subject":"...","predicate":"...","confidence":0.9,"object":"..."}]}',
    'Return {"entities":[],"relationships":[]} if nothing qualifies.',
  ].join("\n");
}

/**
 * The identity key an entity name resolves under: casefolded, trimmed, leading "@"
 * stripped, whitespace collapsed. "memloom/core" and "@Memloom/Core " are the same
 * entity; the first-seen spelling stays the display name. Mirrored in SQL inside
 * #resolveEntity; keep the two in sync.
 */
export function entityNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/^@/, "").replace(/\s+/g, " ");
}

function sliceJson(raw: string, open: string, close: string): unknown {
  const start = raw.indexOf(open);
  const end = raw.lastIndexOf(close);
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

// The deterministic validation layer. Entities: drop, never coerce (precision first),
// but a CLEAN name with an unknown type becomes a schema proposal instead of a graph row.
// Relationships: coerce to 'mention' when the predicate is out-of-vocab or under-confident
// (quarantine semantics; confident unknown predicates are proposed), drop when the
// endpoints aren't surviving entities.
export function parseExtraction(
  raw: string,
  schema: ActiveSchema = DEFAULT_ACTIVE_SCHEMA,
): Extraction {
  const typeNames = new Set(schema.entityTypes.map((t) => t.name));
  const predicateNames = new Set(schema.predicates.map((p) => p.name));
  const dismissed = new Set(schema.dismissed);

  let entitiesRaw: unknown[] = [];
  let relationshipsRaw: unknown[] = [];

  // The {...} slice of a bare entity array parses as a single entity object, so only take
  // the object path when it actually carries the expected arrays; otherwise fall back to
  // the legacy shape (a bare entities array).
  const obj = sliceJson(raw, "{", "}");
  const rec =
    obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  if (rec && (Array.isArray(rec.entities) || Array.isArray(rec.relationships))) {
    if (Array.isArray(rec.entities)) entitiesRaw = rec.entities;
    if (Array.isArray(rec.relationships)) relationshipsRaw = rec.relationships;
  } else {
    const arr = sliceJson(raw, "[", "]");
    if (Array.isArray(arr)) entitiesRaw = arr;
  }

  const proposals: SchemaProposal[] = [];
  const proposed = new Set<string>();
  const propose = (kind: SchemaKind, rawName: string) => {
    const name = normalizeSchemaName(rawName);
    if (!name || name === "mention" || dismissed.has(name)) return;
    const key = `${kind}:${name}`;
    if (proposed.has(key)) return;
    proposed.add(key);
    proposals.push({ kind, name });
  };

  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();
  for (const item of entitiesRaw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const name = String(rec.name ?? "").trim();
    if (!name) continue;
    // Name guards first: a garbage name must never generate a type proposal either.
    if (MATH_SYMBOLS.test(name) || DIGIT_OP_DIGIT.test(name) || FUNC_CALL.test(name)) continue;
    if (name.length > MAX_NAME_LENGTH || name.split(/\s+/).length > MAX_NAME_WORDS) continue;
    if ((name.match(LETTER) ?? []).length < 2) continue;
    const type = String(rec.type ?? "")
      .trim()
      .toLowerCase();
    if (!typeNames.has(type)) {
      // No default sink: the entity is held out of the graph, its type goes to review.
      if (type) propose("entity_type", type);
      continue;
    }
    const key = `${name.toLowerCase()} ${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push({ name, type });
  }
  const kept = entities.slice(0, MAX_ENTITIES);
  const keptNames = new Set(kept.map((e) => e.name.toLowerCase()));

  const relationships: ExtractedRelationship[] = [];
  const seenRel = new Set<string>();
  for (const item of relationshipsRaw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const subject = String(rec.subject ?? "").trim();
    const object = String(rec.object ?? "").trim();
    if (!subject || !object) continue;
    // An entity killed by the guards kills its relationships.
    if (!keptNames.has(subject.toLowerCase()) || !keptNames.has(object.toLowerCase())) continue;
    if (subject.toLowerCase() === object.toLowerCase()) continue;
    let predicate = String(rec.predicate ?? "")
      .trim()
      .toLowerCase();
    const rawConfidence = Number(rec.confidence);
    const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0;
    if (!predicateNames.has(predicate) || confidence < MIN_RELATIONSHIP_CONFIDENCE) {
      // A CONFIDENT classification against a missing predicate is vocabulary signal.
      if (
        predicate &&
        !predicateNames.has(predicate) &&
        confidence >= MIN_RELATIONSHIP_CONFIDENCE
      ) {
        propose("predicate", predicate);
      }
      predicate = "mention"; // quarantine: keep the connection, drop the unproven claim
    }
    const key = `${subject.toLowerCase()}|${predicate}|${object.toLowerCase()}`;
    if (seenRel.has(key)) continue;
    seenRel.add(key);
    relationships.push({ subject, predicate, confidence, object });
    if (relationships.length >= MAX_RELATIONSHIPS) break;
  }

  return { entities: kept, relationships, proposals };
}

export async function extractGraph(
  llm: LLMProvider,
  content: string,
  context: ExtractionContext = {},
  schema: ActiveSchema = DEFAULT_ACTIVE_SCHEMA,
): Promise<Extraction> {
  const raw = await llm.complete(buildEntityPrompt(content, context, schema));
  return parseExtraction(raw, schema);
}

// Math-density pre-filter: exercise-sheet chunks are formula-and-enumeration soup
// (30-60% math-ish characters) while prose in any language runs ~2-6%. Chunks over the
// threshold skip the LLM entirely: nothing worth extracting lives there.
export const MATH_DENSITY_THRESHOLD = 0.25;
const MATH_DENSITY_MIN_CHARS = 40; // don't judge tiny chunks

export function mathDensity(text: string): number {
  const mathish = (text.match(/[0-9=+\-*/^√∫∑∈≤≥→±²³()<>|\\]/g) ?? []).length;
  const letters = (text.match(LETTER) ?? []).length;
  return mathish / Math.max(1, mathish + letters);
}

export function isMathDense(text: string): boolean {
  return (
    text.replace(/\s/g, "").length >= MATH_DENSITY_MIN_CHARS &&
    mathDensity(text) >= MATH_DENSITY_THRESHOLD
  );
}
