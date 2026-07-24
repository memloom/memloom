import { describe, expect, it } from "vitest";
import { HttpMemloomClient, type HttpResponse } from "./http-client.js";

// The NDJSON stream reader: heartbeat pings and unknown event kinds must be skipped, and a
// stream that dies mid-read (client idle timeout, network drop) must say the daemon keeps
// running instead of surfacing a bare "terminated".

function response(overrides: Partial<HttpResponse>): HttpResponse {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(""),
    json: () => Promise.resolve({}),
    ...overrides,
  };
}

describe("HttpMemloomClient stream reader", () => {
  it("skips ping and unknown event types, forwards items, returns the done payload", async () => {
    const lines = [
      '{"type":"ping"}',
      '{"type":"item","outcome":"distilling","index":1}',
      '{"type":"ping"}',
      '{"type":"from-a-newer-daemon","x":1}',
      '{"type":"item","outcome":"imported","index":1}',
      '{"type":"done","sessions":1,"saved":2}',
    ].join("\n");
    const client = new HttpMemloomClient("http://test", () =>
      Promise.resolve(response({ text: () => Promise.resolve(lines) })),
    );

    const seen: string[] = [];
    const result = await client.importClaudeCode({}, (e) => seen.push(e.outcome));

    expect(seen).toEqual(["distilling", "imported"]);
    expect(result).toMatchObject({ sessions: 1, saved: 2 });
  });

  it("a stream dying mid-read reports that the daemon continues the run", async () => {
    const encoder = new TextEncoder();
    const chunks: Array<{ done: boolean; value?: Uint8Array }> = [
      { done: false, value: encoder.encode('{"type":"item","outcome":"distilling","index":1}\n') },
    ];
    const client = new HttpMemloomClient("http://test", () =>
      Promise.resolve(
        response({
          body: {
            getReader: () => ({
              read: () => {
                const next = chunks.shift();
                if (next) return Promise.resolve(next);
                return Promise.reject(new TypeError("terminated"));
              },
            }),
          },
        }),
      ),
    );

    await expect(client.importClaudeCode({})).rejects.toThrow(
      /lost the daemon's progress stream \(terminated\).*continues inside the daemon/s,
    );
  });
});
