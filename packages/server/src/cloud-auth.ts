import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthStore } from "@memloom/core";
import type { Context, Hono } from "hono";

// Authentication for a hosted memloom: one server on the internet, reached by Claude.ai,
// Claude Code, Cursor and the CLI from anywhere. The loopback daemon trusts its machine and
// needs none of this; this module is only installed when the server is told its public URL.
//
// Two ways in, both ending in a bearer token that names an owner:
//   - API tokens, made with `memloom token create` and pasted into a client's config.
//   - OAuth 2.1 (authorization code + PKCE, dynamic client registration), which is what
//     Claude.ai's custom connectors speak. The person signs in once with the server's login
//     password and the connector holds a refreshable token from then on.
//
// One owner per server: the login password signs in as `ownerId`. That matches how memloom is
// hosted today (a person's own server), and keeps the login page free of account management.

export interface CloudAuthOptions {
  store: AuthStore;
  /** The URL clients reach the server at, e.g. https://memloom.fly.dev. No trailing slash. */
  publicUrl: string;
  /** Who the login password signs in as. */
  ownerId: string;
  /** Enables the OAuth login. Without it only API tokens work. */
  loginPassword?: string;
  /** Injectable clock for tests. */
  now?: () => number;
}

const ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

// Paths a caller reaches without a token: discovery, the OAuth endpoints themselves, health.
const PUBLIC_PATHS = new Set([
  "/health",
  "/authorize",
  "/token",
  "/register",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
]);

// Routes that act on the server's own disk or process. On a laptop that is the user's machine;
// on a hosted server it is ours, and nothing a client sends should read or control it.
const LOCAL_ONLY = [
  /^\/admin\//,
  /^\/context\/add(\/stream)?$/,
  /^\/context\/pick$/,
  /^\/context\/browse$/,
  /^\/context\/roots$/,
  /^\/context\/documents\/[^/]+\/open$/,
  /^\/queue$/,
  /^\/import\/claude-code\/notify$/,
  /^\/import\/sessions\/stream$/,
  /^\/import\/agent-memory\/stream$/,
];

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  expiresAt: number;
}

const owners = new WeakMap<Request, string>();

/** The owner a verified token named for this request, when the server requires tokens. */
export function authOwner(c: Context): string | undefined {
  return owners.get(c.req.raw);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function samePassword(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return (
    computed.length === challenge.length &&
    timingSafeEqual(Buffer.from(computed), Buffer.from(challenge))
  );
}

// Claude.ai and desktop clients register https callbacks, and native clients use a loopback
// one. Anything else (javascript:, data:, a plain-http remote host) is refused at registration.
function acceptableRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function loginPage(params: Record<string, string>, clientName: string, error?: string): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to memloom</title>
<style>body{font:16px system-ui,sans-serif;max-width:22rem;margin:15vh auto;padding:0 1rem;color:#222;background:#fafafa}
input[type=password],button{width:100%;box-sizing:border-box;padding:.6rem;font:inherit;margin-top:.5rem}
.err{color:#b00020}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}</style></head>
<body><h1>memloom</h1><p>${escapeHtml(clientName || "An app")} wants to use your memory.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/authorize">${hidden}
<label>Password<input type="password" name="password" autofocus required></label>
<button type="submit">Allow</button></form></body></html>`;
}

export function installCloudAuth(app: Hono, opts: CloudAuthOptions): void {
  const { store, ownerId } = opts;
  const publicUrl = opts.publicUrl.replace(/\/+$/, "");
  const now = opts.now ?? Date.now;
  const codes = new Map<string, PendingCode>();
  const failures = new Map<string, number[]>();
  const resourceMetadata = `${publicUrl}/.well-known/oauth-protected-resource`;

  const clientIp = (c: Context) =>
    c.req.header("fly-client-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "?";

  const lockedOut = (ip: string) => {
    const recent = (failures.get(ip) ?? []).filter((t) => now() - t < LOGIN_WINDOW_MS);
    failures.set(ip, recent);
    return recent.length >= LOGIN_MAX_FAILURES;
  };

  // Every request that is not public carries a valid token, and the token decides the owner.
  // An owner header that disagrees is refused rather than ignored, so a confused client finds
  // out instead of quietly writing somewhere else.
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (PUBLIC_PATHS.has(path)) return next();
    if (LOCAL_ONLY.some((re) => re.test(path))) {
      return c.json(
        { error: "not available on a hosted memloom: this route acts on the server's own disk" },
        403,
      );
    }
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const verified = token ? await store.verify(token) : null;
    if (!verified) {
      c.header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadata}"`);
      return c.json({ error: token ? "invalid or expired token" : "missing bearer token" }, 401);
    }
    const sent = c.req.header("x-memloom-owner");
    if (sent && sent.toLowerCase() !== verified.ownerId) {
      return c.json({ error: "this token cannot act for that owner" }, 403);
    }
    owners.set(c.req.raw, verified.ownerId);
    await next();
  });

  // RFC 9728: where a client that got a 401 learns which authorization server to use.
  const protectedResource = (c: Context) =>
    c.json({
      resource: `${publicUrl}/mcp`,
      authorization_servers: [publicUrl],
      bearer_methods_supported: ["header"],
    });
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  // RFC 8414.
  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/authorize`,
      token_endpoint: `${publicUrl}/token`,
      registration_endpoint: `${publicUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    }),
  );

  // RFC 7591 dynamic registration. Public clients only: PKCE is the proof, not a secret.
  app.post("/register", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      client_name?: unknown;
      redirect_uris?: unknown;
    } | null;
    const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
    if (
      uris.length === 0 ||
      uris.length > 10 ||
      !uris.every((u): u is string => typeof u === "string" && acceptableRedirect(u))
    ) {
      return c.json(
        {
          error: "invalid_redirect_uri",
          error_description: "redirect_uris must be https or loopback",
        },
        400,
      );
    }
    const name = typeof body?.client_name === "string" ? body.client_name.slice(0, 200) : "";
    const client = await store.registerClient(name, uris);
    return c.json(
      {
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  // The parameters /authorize needs, checked the same way for the page and the form post.
  // Errors that concern the client itself are shown here, never redirected: redirecting to an
  // unverified redirect_uri is an open redirect.
  async function authorizeRequest(
    params: Record<string, string>,
  ): Promise<{ ok: true; clientName: string } | { ok: false; message: string }> {
    if (!opts.loginPassword) {
      return { ok: false, message: "Sign-in is off on this server: set MEMLOOM_LOGIN_PASSWORD." };
    }
    const client = params.client_id ? await store.client(params.client_id) : null;
    if (!client)
      return { ok: false, message: "Unknown client. Remove the connector and add it again." };
    if (!params.redirect_uri || !client.redirectUris.includes(params.redirect_uri)) {
      return { ok: false, message: "That redirect address is not registered for this client." };
    }
    if (params.response_type !== "code")
      return { ok: false, message: "Unsupported response_type." };
    if (!params.code_challenge || params.code_challenge_method !== "S256") {
      return { ok: false, message: "PKCE with S256 is required." };
    }
    return { ok: true, clientName: client.clientName };
  }

  const FORWARDED = [
    "client_id",
    "redirect_uri",
    "response_type",
    "code_challenge",
    "code_challenge_method",
    "state",
    "scope",
    "resource",
  ];

  app.get("/authorize", async (c) => {
    const params: Record<string, string> = {};
    for (const key of FORWARDED) {
      const v = c.req.query(key);
      if (v !== undefined) params[key] = v;
    }
    const check = await authorizeRequest(params);
    if (!check.ok) return c.text(check.message, 400);
    return c.html(loginPage(params, check.clientName));
  });

  app.post("/authorize", async (c) => {
    const form = await c.req.parseBody();
    const params: Record<string, string> = {};
    for (const key of FORWARDED) {
      const v = form[key];
      if (typeof v === "string") params[key] = v;
    }
    const check = await authorizeRequest(params);
    if (!check.ok) return c.text(check.message, 400);
    const ip = clientIp(c);
    if (lockedOut(ip)) {
      return c.html(
        loginPage(params, check.clientName, "Too many attempts. Try again later."),
        429,
      );
    }
    const password = typeof form.password === "string" ? form.password : "";
    if (!samePassword(password, opts.loginPassword ?? "")) {
      failures.get(ip)?.push(now());
      return c.html(loginPage(params, check.clientName, "Wrong password."), 401);
    }
    const code = randomBytes(32).toString("base64url");
    codes.set(code, {
      clientId: params.client_id as string,
      redirectUri: params.redirect_uri as string,
      challenge: params.code_challenge as string,
      expiresAt: now() + CODE_TTL_MS,
    });
    const target = new URL(params.redirect_uri as string);
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    return c.redirect(target.toString(), 302);
  });

  app.post("/token", async (c) => {
    const form = await c.req.parseBody();
    const field = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
    const fail = (error: string, description: string) =>
      c.json({ error, error_description: description }, 400);

    const issue = async (owner: string, clientId: string) => {
      const access = await store.issue(owner, "access", {
        clientId,
        ttlMs: ACCESS_TTL_MS,
        label: "oauth",
      });
      const refresh = await store.issue(owner, "refresh", {
        clientId,
        ttlMs: REFRESH_TTL_MS,
        label: "oauth",
      });
      c.header("Cache-Control", "no-store");
      return c.json({
        access_token: access.token,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TTL_MS / 1000),
        refresh_token: refresh.token,
      });
    };

    if (field("grant_type") === "authorization_code") {
      const code = field("code");
      const pending = codes.get(code);
      codes.delete(code); // single use, whatever happens next
      if (!pending || pending.expiresAt < now())
        return fail("invalid_grant", "unknown or expired code");
      if (pending.clientId !== field("client_id")) return fail("invalid_grant", "client mismatch");
      if (pending.redirectUri !== field("redirect_uri"))
        return fail("invalid_grant", "redirect_uri mismatch");
      if (!pkceMatches(field("code_verifier"), pending.challenge)) {
        return fail("invalid_grant", "code_verifier does not match");
      }
      return issue(ownerId, pending.clientId);
    }

    if (field("grant_type") === "refresh_token") {
      const old = field("refresh_token");
      const verified = old ? await store.verify(old, ["refresh"]) : null;
      if (!verified) return fail("invalid_grant", "unknown or expired refresh token");
      const clientId = field("client_id");
      if (clientId && verified.clientId && clientId !== verified.clientId) {
        return fail("invalid_grant", "client mismatch");
      }
      // Rotation: a refresh token works once. A stolen one that is used after the real client
      // has refreshed simply fails.
      await store.revoke(old);
      return issue(verified.ownerId, verified.clientId ?? clientId);
    }

    return fail("unsupported_grant_type", "use authorization_code or refresh_token");
  });
}
