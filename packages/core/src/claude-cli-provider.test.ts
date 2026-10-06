import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ClaudeCliLLM, parseEnvelope } from "./claude-cli-provider.js";

// The provider is exercised against a fake `claude`: a node script that reads the prompt from
// stdin and prints a result envelope shaped like the real CLI's --output-format json. The real
// CLI needs a logged-in subscription, which a test cannot assume.

const dir = mkdtempSync(join(tmpdir(), "memloom-claude-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeCli(name: string, body: string): string {
  const path = join(dir, `${name}.cjs`);
  writeFileSync(
    path,
    [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (d) => { input += d; });",
      `process.stdin.on('end', () => { ${body} });`,
    ].join("\n"),
  );
  return path;
}

function provider(script: string, opts: { model?: string; timeoutMs?: number } = {}) {
  return new ClaudeCliLLM({ command: "node", extraArgs: [script], ...opts });
}

describe("ClaudeCliLLM", () => {
  it("sends the prompt over stdin and returns the envelope's result text", async () => {
    const script = fakeCli(
      "echo",
      `const args = process.argv.slice(2);
       const env = { type: 'result', is_error: false, result: 'got:' + input.length + ':' + args.join(' '),
         total_cost_usd: 0.001, usage: { input_tokens: 12, output_tokens: 3 } };
       process.stdout.write(JSON.stringify(env));`,
    );
    const llm = provider(script, { model: "haiku" });
    let usage: unknown;
    const reply = await llm.complete("x".repeat(40_000), { onUsage: (u) => (usage = u) });
    // The whole 40k prompt arrived (it would not fit on a command line), and the model flag
    // plus the no-tools, no-persistence, no-settings flags went with it.
    expect(reply.startsWith("got:40000:")).toBe(true);
    expect(reply).toContain("--model haiku");
    expect(reply).toContain("--tools ");
    expect(reply).toContain("--no-session-persistence");
    expect(reply).toContain("--setting-sources ");
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 3, usd: 0.001 });
    expect(llm.calls).toBe(1);
  });

  it("throws on an is_error envelope instead of returning an empty reply", async () => {
    const script = fakeCli(
      "autherr",
      `process.stdout.write(JSON.stringify({ type: 'result', is_error: true,
         result: 'Failed to authenticate: OAuth session expired and could not be refreshed' }));`,
    );
    await expect(provider(script).complete("hi")).rejects.toThrow(/Failed to authenticate/);
  });

  it("throws when the process prints no envelope", async () => {
    const script = fakeCli("garbage", `process.stderr.write('boom'); process.exit(2);`);
    await expect(provider(script).complete("hi")).rejects.toThrow(/exited 2.*boom/s);
  });

  it("caps concurrency at the configured limit", async () => {
    const script = fakeCli(
      "slow",
      `setTimeout(() => process.stdout.write(JSON.stringify({ result: 'ok', is_error: false })), 150);`,
    );
    const llm = new ClaudeCliLLM({ command: "node", extraArgs: [script], concurrency: 2 });
    const started = performance.now();
    await Promise.all([llm.complete("a"), llm.complete("b"), llm.complete("c")]);
    // Three calls at a limit of two take two rounds; one round would finish under ~300 ms
    // only if all three ran at once.
    expect(performance.now() - started).toBeGreaterThan(250);
    expect(llm.calls).toBe(3);
  });
});

describe("parseEnvelope", () => {
  it("accepts a clean envelope and one with leading noise", () => {
    expect(parseEnvelope('{"result":"a"}')?.result).toBe("a");
    expect(parseEnvelope('warning: something\n{"result":"b","is_error":false}')?.result).toBe("b");
    expect(parseEnvelope("")).toBeNull();
    expect(parseEnvelope("not json")).toBeNull();
  });
});
