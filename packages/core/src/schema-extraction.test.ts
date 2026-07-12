import { describe, expect, it } from "vitest";
import { buildEntityPrompt, isMathDense, mathDensity, parseExtraction } from "./entities.js";
import { ENTITY_TYPES, PREDICATES } from "./schema.js";

// The deterministic layer of schema-constrained extraction: the prompt never gets to decide
// what enters the graph — parseExtraction does. Pure unit tests, no DB, no LLM.

function extraction(
  entities: Array<Record<string, unknown>>,
  relationships: Array<Record<string, unknown>> = [],
): string {
  return JSON.stringify({ entities, relationships });
}

describe("parseExtraction — entity guards", () => {
  it("drops out-of-vocab and missing types (no thing sink)", () => {
    const out = parseExtraction(
      extraction([
        { name: "Fly.io", type: "platform" },
        { name: "Nameless" },
        { name: "Sink", type: "thing" },
        { name: "Kraków", type: "place" },
      ]),
    );
    expect(out.entities).toEqual([{ name: "Kraków", type: "place" }]);
  });

  it("drops formulas and math expressions", () => {
    const out = parseExtraction(
      extraction([
        { name: "f(x) = x^3 - 2x^2", type: "concept" },
        { name: "x + 2x = 6", type: "concept" },
        { name: "√2", type: "concept" },
        { name: "3·4", type: "concept" },
        { name: "g'(2)", type: "concept" },
        { name: "x²", type: "concept" },
        { name: "\\frac{a}{b}", type: "concept" },
      ]),
    );
    expect(out.entities).toEqual([]);
  });

  it("drops fragments: too long, too many words, too few letters", () => {
    const out = parseExtraction(
      extraction([
        { name: "największa wartość funkcji w przedziale domkniętym i otwartym", type: "concept" },
        { name: "Wyznacz największą wartość funkcji w przedziale", type: "concept" },
        { name: "5", type: "concept" },
        { name: "twierdzenie Pitagorasa", type: "concept" },
      ]),
    );
    expect(out.entities).toEqual([{ name: "twierdzenie Pitagorasa", type: "concept" }]);
  });

  it("keeps Polish proper names (Unicode letters count)", () => {
    const out = parseExtraction(
      extraction([
        { name: "Maria Skłodowska-Curie", type: "person" },
        { name: "Łódź", type: "place" },
        { name: "Uniwersytet Jagielloński", type: "organization" },
      ]),
    );
    expect(out.entities.map((e) => e.name)).toEqual([
      "Maria Skłodowska-Curie",
      "Łódź",
      "Uniwersytet Jagielloński",
    ]);
  });

  it("caps entities at 5 AFTER filtering", () => {
    const seven = ["Ala", "Ola", "Ela", "Iza", "Uta", "Ida", "Ewa"].map((name) => ({
      name,
      type: "person",
    }));
    expect(parseExtraction(extraction(seven)).entities).toHaveLength(5);

    const mixed = [
      { name: "x + 2x = 6", type: "concept" }, // garbage, must not consume a slot
      { name: "Ala", type: "person" },
      { name: "wzór dla x = 2", type: "bogus" }, // out-of-vocab
      { name: "Ola", type: "person" },
      { name: "Ela", type: "person" },
    ];
    expect(parseExtraction(extraction(mixed)).entities.map((e) => e.name)).toEqual([
      "Ala",
      "Ola",
      "Ela",
    ]);
  });

  it("still accepts the legacy bare-array shape", () => {
    const out = parseExtraction(JSON.stringify([{ name: "Kraków", type: "place" }]));
    expect(out.entities).toEqual([{ name: "Kraków", type: "place" }]);
    expect(out.relationships).toEqual([]);
  });
});

describe("parseExtraction — relationship guards", () => {
  const pair = [
    { name: "Ada Lovelace", type: "person" },
    { name: "Analytical Engine", type: "project" },
  ];

  it("keeps in-vocab, confident relationships", () => {
    const out = parseExtraction(
      extraction(pair, [
        {
          subject: "Ada Lovelace",
          predicate: "works_on",
          confidence: 0.9,
          object: "Analytical Engine",
        },
      ]),
    );
    expect(out.relationships).toEqual([
      {
        subject: "Ada Lovelace",
        predicate: "works_on",
        confidence: 0.9,
        object: "Analytical Engine",
      },
    ]);
  });

  it("coerces out-of-vocab predicates and low confidence to mention", () => {
    const out = parseExtraction(
      extraction(pair, [
        {
          subject: "Ada Lovelace",
          predicate: "invented",
          confidence: 0.95,
          object: "Analytical Engine",
        },
        {
          subject: "Analytical Engine",
          predicate: "created_by",
          confidence: 0.4,
          object: "Ada Lovelace",
        },
      ]),
    );
    expect(out.relationships.map((r) => r.predicate)).toEqual(["mention", "mention"]);
  });

  it("drops relationships whose endpoints are not surviving entities, and self-loops", () => {
    const out = parseExtraction(
      extraction(pair, [
        { subject: "Ada Lovelace", predicate: "works_on", confidence: 0.9, object: "Ghost Entity" },
        { subject: "Ada Lovelace", predicate: "works_on", confidence: 0.9, object: "Ada Lovelace" },
      ]),
    );
    expect(out.relationships).toEqual([]);
  });

  it("an entity killed by the guards kills its relationships", () => {
    const out = parseExtraction(
      extraction(
        [
          { name: "Ada Lovelace", type: "person" },
          { name: "x + 2x = 6", type: "concept" },
        ],
        [{ subject: "Ada Lovelace", predicate: "uses", confidence: 0.9, object: "x + 2x = 6" }],
      ),
    );
    expect(out.relationships).toEqual([]);
  });

  it("dedupes and caps relationships", () => {
    const rels = Array.from({ length: 8 }, () => ({
      subject: "Ada Lovelace",
      predicate: "works_on",
      confidence: 0.9,
      object: "Analytical Engine",
    }));
    expect(parseExtraction(extraction(pair, rels)).relationships).toHaveLength(1);
  });
});

describe("parseExtraction — schema proposals", () => {
  it("a clean name with an unknown type is held out and its type proposed", () => {
    const out = parseExtraction(
      extraction([
        { name: "Ibuprofen", type: "Medication" },
        { name: "x + 2x = 6", type: "equation" }, // garbage name: no proposal either
      ]),
    );
    expect(out.entities).toEqual([]);
    expect(out.proposals).toEqual([{ kind: "entity_type", name: "medication" }]);
  });

  it("a confident unknown predicate is quarantined AND proposed; a weak one is not", () => {
    const pair = [
      { name: "Ada Lovelace", type: "person" },
      { name: "Analytical Engine", type: "project" },
    ];
    const out = parseExtraction(
      extraction(pair, [
        {
          subject: "Ada Lovelace",
          predicate: "invented",
          confidence: 0.95,
          object: "Analytical Engine",
        },
        {
          subject: "Analytical Engine",
          predicate: "sketched_by",
          confidence: 0.3,
          object: "Ada Lovelace",
        },
      ]),
    );
    expect(out.relationships.map((r) => r.predicate)).toEqual(["mention", "mention"]);
    expect(out.proposals).toEqual([{ kind: "predicate", name: "invented" }]);
  });

  it("dismissed names are never re-proposed", () => {
    const schema = {
      ...structuredClone({
        entityTypes: [{ name: "person", description: "" }],
        predicates: [{ name: "works_on", description: "" }],
      }),
      dismissed: ["medication"],
    };
    const out = parseExtraction(extraction([{ name: "Ibuprofen", type: "medication" }]), schema);
    expect(out.proposals).toEqual([]);
  });

  it("an injected custom schema is honored end to end", () => {
    const schema = {
      entityTypes: [{ name: "medication", description: "a named drug" }],
      predicates: [{ name: "treats", description: "drug treats condition" }],
      dismissed: [],
    };
    const out = parseExtraction(
      extraction(
        [
          { name: "Ibuprofen", type: "medication" },
          { name: "Migrena", type: "medication" },
        ],
        [{ subject: "Ibuprofen", predicate: "treats", confidence: 0.9, object: "Migrena" }],
      ),
      schema,
    );
    expect(out.entities).toHaveLength(2);
    expect(out.relationships[0]?.predicate).toBe("treats");
  });
});

describe("math density pre-filter", () => {
  it("prose is not math-dense, in any language", () => {
    const polish =
      "Maria Skłodowska-Curie była polską fizyczką i chemiczką, dwukrotną laureatką Nagrody Nobla, która prowadziła badania nad promieniotwórczością w Paryżu.";
    expect(isMathDense(polish)).toBe(false);
    expect(mathDensity(polish)).toBeLessThan(0.25);
  });

  it("an exercise-sheet chunk is math-dense", () => {
    const sheet =
      "Zad 3. f(x) = x^3 - 2x^2 + 1, x ∈ [0, 3], y = 2x + 7, 4x - 1 = 0, x^2 + 2x = 66 - 4x";
    expect(isMathDense(sheet)).toBe(true);
  });

  it("never judges tiny fragments", () => {
    expect(isMathDense("x = 2 + 2")).toBe(false);
  });
});

describe("buildEntityPrompt", () => {
  it("renders every schema type and predicate, and the source line only with a doc title", () => {
    const bare = buildEntityPrompt("some text");
    for (const t of ENTITY_TYPES) expect(bare).toContain(`- ${t.name}:`);
    for (const p of PREDICATES) expect(bare).toContain(`- ${p.name}:`);
    expect(bare).not.toContain("SOURCE:");

    const sourced = buildEntityPrompt("some text", { docTitle: "notes.pdf" });
    expect(sourced).toContain("SOURCE: notes.pdf");
  });
});
