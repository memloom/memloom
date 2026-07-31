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
    const result = await client.importSessions({}, (e) => seen.push(e.outcome));

    expect(seen).toEqual(["distilling", "imported"]);
    expect(result).toMatchObject({ sessions: 1, saved: 2 });
  });

  // relatedEntities is the one engine method whose only real caller is the MCP server, which
  // always goes over the wire. Nothing else exercises the URL it builds, so a renamed query
  // parameter would ship as a broken tool with every in-process test still green.
  it("asks the related route with the target, type and limit as query parameters", async () => {
    const seen: string[] = [];
    const client = new HttpMemloomClient("http://test", (url) => {
      seen.push(String(url));
      return Promise.resolve(
        response({ json: () => Promise.resolve({ entity: {}, related: [], truncated: 0 }) }),
      );
    });

    await client.relatedEntities("Bob", { entityType: "person", limit: 5 });
    const url = new URL(seen[0] ?? "");
    expect(url.pathname).toBe("/memory/entities/related");
    expect(url.searchParams.get("q")).toBe("Bob");
    expect(url.searchParams.get("type")).toBe("person");
    expect(url.searchParams.get("limit")).toBe("5");

    // Names carry slashes and at-signs on a real store, which is why this is a query
    // parameter and not a path segment.
    await client.relatedEntities("@memloom/cli");
    expect(new URL(seen[1] ?? "").searchParams.get("q")).toBe("@memloom/cli");
  });

  it("reads an unknown entity as null rather than throwing", async () => {
    // The route answers 404, and #json turns any non-ok into an error. Without the explicit
    // check, "no such entity" reaches the agent as a server failure.
    const client = new HttpMemloomClient("http://test", () =>
      Promise.resolve(response({ ok: false, status: 404 })),
    );
    expect(await client.relatedEntities("Nobody")).toBeNull();
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

    await expect(client.importSessions({})).rejects.toThrow(
      /lost the daemon's progress stream \(terminated\).*continues inside the daemon/s,
    );
  });
});
