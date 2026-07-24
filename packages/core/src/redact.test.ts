import { describe, expect, it } from "vitest";
import { redact } from "./redact.js";

// Two corpora, one promise each: secret shapes get masked (pre-egress AND pre-store safety),
// and ordinary code/prose survives untouched (precision over recall, by design).

describe("redact: secret shapes", () => {
  const cases: Array<[string, string]> = [
    ["sk- keys", "my key is sk-or-v1-0123456789abcdef0123456789abcdef"],
    ["github tokens", "export GH=ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345"],
    ["npm tokens", "npm_0123456789abcdefghijklmn is in .npmrc"],
    ["slack tokens", "slack says xoxb-1234567890-abcdefghij"],
    ["aws access keys", "aws_access_key_id = AKIAIOSFODNN7EXAMPLE"],
    ["google api keys", "key=AIzaSyD-1234567890abcdefghijklmnopqrstu"],
    ["bearer headers", "authorization: Bearer abc123def456ghi789jkl012"],
    ["jwts", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N7ihg"],
  ];

  for (const [name, input] of cases) {
    it(`masks ${name}`, () => {
      const result = redact(input);
      expect(result.hits).toBeGreaterThan(0);
      expect(result.text).toContain("[redacted]");
    });
  }

  it("masks secret-named assignments but keeps the variable name", () => {
    const result = redact("OPENROUTER_API_KEY=abcdef123456789xyz and it worked");
    expect(result.text).toContain("OPENROUTER_API_KEY=");
    expect(result.text).toContain("[redacted]");
    expect(result.text).not.toContain("abcdef123456789xyz");
  });

  it("masks json-style secret fields", () => {
    const result = redact('config was {"apiToken": "supersecretvalue123"}');
    expect(result.text).not.toContain("supersecretvalue123");
  });

  it("masks url passwords but keeps the host", () => {
    const result = redact("connect to postgres://admin:hunter2secret@db.internal:5432/app");
    expect(result.text).toContain("postgres://admin:[redacted]@db.internal:5432/app");
    expect(result.hits).toBe(1);
  });

  it("counts multiple hits", () => {
    const result = redact("first sk-or-0123456789abcdefgh then MY_SECRET=abcdefgh1234 done");
    expect(result.hits).toBe(2);
  });
});

describe("redact: false-positive corpus", () => {
  const clean = [
    "the staging database runs on Postgres with pgvector",
    "use pnpm build to compile all packages",
    "const result = await engine.save({ content })",
    "set --type procedure when saving how-to steps",
    "the keyboard shortcut is ctrl+k",
    "primary key on (owner_id, source, session_id)",
    "the key insight is that hooks are fire and forget",
    "KEY=short",
    "skills live in ~/.claude/skills",
    "task-list markdown uses [x] checkboxes",
  ];

  for (const text of clean) {
    it(`leaves "${text.slice(0, 40)}" untouched`, () => {
      const result = redact(text);
      expect(result.hits).toBe(0);
      expect(result.text).toBe(text);
    });
  }
});
