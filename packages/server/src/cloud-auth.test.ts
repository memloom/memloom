import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageAdapter } from "@memloom/core";
import {
  AuthStore,
  HashingEmbeddingProvider,
  HttpMemloomClient,
  Memloom,
  NullLLMProvider,
  PgliteAdapter,
  truncateAll,
} from "@memloom/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./index.js";

// A hosted memloom answers the internet, so every route needs a token and the token decides
// whose memories a request touches. The OAuth half is what Claude.ai's connectors speak.

const OWNER = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const PUBLIC = "https://memloom.example.com";
const PASSWORD = "correct-horse-battery";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let storage: StorageAdapter;
let previousHome: string | undefined;
let fakeHome: string;

beforeAll(async () => {
  storage = await PgliteAdapter.open();
  fakeHome = mkdtempSync(join(tmpdir(), "memloom-cloud-auth-"));
  previousHome = process.env.MEMLOOM_HOME;
  process.env.MEMLOOM_HOME = fakeHome;
});
afterAll(async () => {
  await storage.close();
  if (previousHome === undefined) delete process.env.MEMLOOM_HOME;
  else process.env.MEMLOOM_HOME = previousHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

async function hosted() {
  await truncateAll(storage);
  const memloom = new Memloom({
    storage,
    embedding: new HashingEmbeddingProvider(1024),
    llm: new NullLLMProvider(),
  });
  await memloom.init();
  await storage.exec("DELETE FROM _memloom_tokens; DELETE FROM _memloom_oauth_clients;");
  const store = new AuthStore(storage);
  const app = createServer(memloom, {
    cloudAuth: { store, publicUrl: PUBLIC, ownerId: OWNER, loginPassword: PASSWORD },
  });
  return { app, store };
}

function form(data: Record<string, string>) {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data).toString(),
  };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("hosted server tokens", () => {
  it("refuses a request without a token and points at the OAuth metadata", async () => {
    const { app } = await hosted();
    const res = await app.request("/memory/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `${PUBLIC}/.well-known/oauth-protected-resource`,
    );
  });

  it("answers health and discovery without one", async () => {
    const { app } = await hosted();
    expect((await app.request("/health")).status).toBe(200);
    const meta = (await (await app.request("/.well-known/oauth-authorization-server")).json()) as {
      token_endpoint: string;
    };
    expect(meta.token_endpoint).toBe(`${PUBLIC}/token`);
  });

  it("takes the owner from the token, not from a header", async () => {
    const { app, store } = await hosted();
    const mine = await store.issue(OWNER, "api");
    const theirs = await store.issue(OTHER, "api");
    const save = (token: string, content: string) =>
      new HttpMemloomClient(
        "",
        (url, init) => app.request(url, init) as never,
        undefined,
        token,
      ).save({ content });
    const listed = async (token: string) => {
      const res = await app.request("/memory/list", {
        headers: { authorization: `Bearer ${token}` },
      });
      const { memories } = (await res.json()) as { memories: { content: string }[] };
      return memories.map((m) => m.content);
    };
    await save(mine.token, "owner a's memory");
    expect(await listed(theirs.token)).toEqual([]);
    expect(await listed(mine.token)).toEqual(["owner a's memory"]);

    const spoofed = await app.request("/memory/list", {
      headers: { authorization: `Bearer ${theirs.token}`, "x-memloom-owner": OWNER },
    });
    expect(spoofed.status).toBe(403);
  });

  it("refuses a body that names another owner", async () => {
    const { app, store } = await hosted();
    const { token } = await store.issue(OWNER, "api");
    const res = await app.request("/memory/save", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "x", ownerId: OTHER }),
    });
    expect(res.status).toBe(400);
  });

  it("keeps routes that read the server's own disk closed", async () => {
    const { app, store } = await hosted();
    const { token } = await store.issue(OWNER, "api");
    const res = await app.request("/context/add", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: "/etc/passwd" }),
    });
    expect(res.status).toBe(403);
  });

  it("stops accepting a revoked token", async () => {
    const { app, store } = await hosted();
    const { token } = await store.issue(OWNER, "api");
    const auth = { headers: { authorization: `Bearer ${token}` } };
    expect((await app.request("/memory/list", auth)).status).toBe(200);
    await store.revoke(token);
    expect((await app.request("/memory/list", auth)).status).toBe(401);
  });
});

describe("hosted server OAuth", () => {
  async function signIn(app: Awaited<ReturnType<typeof hosted>>["app"]) {
    const reg = await app.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const params = {
      client_id,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s1",
    };
    const page = await app.request(`/authorize?${new URLSearchParams(params)}`);
    expect(await page.text()).toContain("Claude wants to use your memory");
    const login = await app.request("/authorize", form({ ...params, password: PASSWORD }));
    expect(login.status).toBe(302);
    const location = new URL(login.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("s1");
    return { client_id, verifier, code: location.searchParams.get("code") ?? "" };
  }

  it("signs in with the password and trades the code for working tokens", async () => {
    const { app } = await hosted();
    const { client_id, verifier, code } = await signIn(app);
    const res = await app.request(
      "/token",
      form({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id,
        redirect_uri: REDIRECT,
      }),
    );
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as { access_token: string; refresh_token: string };
    const list = await app.request("/memory/list", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(list.status).toBe(200);
    // A refresh token is not an access token.
    const misuse = await app.request("/memory/list", {
      headers: { authorization: `Bearer ${tokens.refresh_token}` },
    });
    expect(misuse.status).toBe(401);
  });

  it("refuses a wrong verifier, and a code used twice", async () => {
    const { app } = await hosted();
    const { client_id, verifier, code } = await signIn(app);
    const exchange = (v: string) =>
      app.request(
        "/token",
        form({
          grant_type: "authorization_code",
          code,
          code_verifier: v,
          client_id,
          redirect_uri: REDIRECT,
        }),
      );
    expect((await exchange("x".repeat(43))).status).toBe(400);
    // The failed attempt spent the code.
    expect((await exchange(verifier)).status).toBe(400);
  });

  it("refuses a wrong password", async () => {
    const { app } = await hosted();
    const reg = await app.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const res = await app.request(
      "/authorize",
      form({
        client_id,
        redirect_uri: REDIRECT,
        response_type: "code",
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        password: "not-the-password",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("never redirects to an address the client did not register", async () => {
    const { app } = await hosted();
    const reg = await app.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const res = await app.request(
      "/authorize",
      form({
        client_id,
        redirect_uri: "https://evil.example.com/cb",
        response_type: "code",
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        password: PASSWORD,
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("rotates refresh tokens", async () => {
    const { app } = await hosted();
    const { client_id, verifier, code } = await signIn(app);
    const first = (await (
      await app.request(
        "/token",
        form({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id,
          redirect_uri: REDIRECT,
        }),
      )
    ).json()) as { refresh_token: string };
    const refresh = () =>
      app.request(
        "/token",
        form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id }),
      );
    expect((await refresh()).status).toBe(200);
    expect((await refresh()).status).toBe(400);
  });

  it("refuses to register a redirect that is neither https nor loopback", async () => {
    const { app } = await hosted();
    const res = await app.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
    });
    expect(res.status).toBe(400);
  });
});
