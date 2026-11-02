import { createHash, randomBytes } from "node:crypto";
import type { StorageAdapter } from "./storage.js";

// Tokens for a hosted memloom. The loopback daemon never needs these: it trusts the machine.
// A hosted server cannot, so every request carries a token, and the token decides the owner.
//
// Three kinds, one table:
//   api      long-lived, made by hand (`memloom token create`) for Claude Code, Cursor, the CLI
//   access   short-lived, issued by the OAuth flow to Claude.ai and other connectors
//   refresh  trades for a new access token; rotated on every use
//
// Only a sha256 of each token is stored. The tokens are 32 random bytes, so a plain hash is
// enough: there is nothing to brute-force that a salt would slow down.

export type TokenKind = "api" | "access" | "refresh";

export interface IssuedToken {
  token: string;
  ownerId: string;
  kind: TokenKind;
  expiresAt: Date | null;
}

export interface TokenRow {
  hash: string;
  ownerId: string;
  kind: TokenKind;
  label: string;
  clientId: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

const PREFIX: Record<TokenKind, string> = { api: "mlm_", access: "mla_", refresh: "mlr_" };

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(kind: TokenKind): string {
  return PREFIX[kind] + randomBytes(32).toString("base64url");
}

export class AuthStore {
  readonly #storage: StorageAdapter;

  constructor(storage: StorageAdapter) {
    this.#storage = storage;
  }

  async issue(
    ownerId: string,
    kind: TokenKind,
    opts: { label?: string; clientId?: string; ttlMs?: number } = {},
  ): Promise<IssuedToken> {
    const token = newToken(kind);
    const expiresAt = opts.ttlMs ? new Date(Date.now() + opts.ttlMs) : null;
    await this.#storage.query(
      `INSERT INTO _memloom_tokens (hash, owner_id, kind, label, client_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [hashToken(token), ownerId, kind, opts.label ?? "", opts.clientId ?? null, expiresAt],
    );
    return { token, ownerId, kind, expiresAt };
  }

  /**
   * The owner a token acts for, or null when it is unknown, expired, or not one of `kinds`.
   * A refresh token is never accepted where an access token is expected.
   */
  async verify(
    token: string,
    kinds: readonly TokenKind[] = ["api", "access"],
  ): Promise<{ ownerId: string; kind: TokenKind; clientId: string | null } | null> {
    const [row] = await this.#storage.query<{
      owner_id: string;
      kind: TokenKind;
      client_id: string | null;
    }>(
      `UPDATE _memloom_tokens SET last_used_at = now()
        WHERE hash = $1 AND kind = ANY($2::text[])
          AND (expires_at IS NULL OR expires_at > now())
        RETURNING owner_id, kind, client_id`,
      [hashToken(token), [...kinds]],
    );
    return row ? { ownerId: row.owner_id, kind: row.kind, clientId: row.client_id } : null;
  }

  /** Delete a token, by the token itself or by its stored hash. True when one was removed. */
  async revoke(tokenOrHash: string): Promise<boolean> {
    const rows = await this.#storage.query(
      "DELETE FROM _memloom_tokens WHERE hash = $1 OR hash = $2 RETURNING 1",
      [tokenOrHash, hashToken(tokenOrHash)],
    );
    return rows.length > 0;
  }

  async list(): Promise<TokenRow[]> {
    const rows = await this.#storage.query<{
      hash: string;
      owner_id: string;
      kind: TokenKind;
      label: string;
      client_id: string | null;
      expires_at: Date | string | null;
      last_used_at: Date | string | null;
      created_at: Date | string;
    }>(
      `SELECT hash, owner_id, kind, label, client_id, expires_at, last_used_at, created_at
         FROM _memloom_tokens
        WHERE expires_at IS NULL OR expires_at > now()
        ORDER BY created_at`,
    );
    const date = (v: Date | string | null) => (v === null ? null : new Date(v));
    return rows.map((r) => ({
      hash: r.hash,
      ownerId: r.owner_id,
      kind: r.kind,
      label: r.label,
      clientId: r.client_id,
      expiresAt: date(r.expires_at),
      lastUsedAt: date(r.last_used_at),
      createdAt: new Date(r.created_at),
    }));
  }

  async registerClient(clientName: string, redirectUris: string[]): Promise<OAuthClient> {
    const clientId = `mlc_${randomBytes(16).toString("base64url")}`;
    await this.#storage.query(
      `INSERT INTO _memloom_oauth_clients (client_id, client_name, redirect_uris)
       VALUES ($1, $2, $3::jsonb)`,
      [clientId, clientName, JSON.stringify(redirectUris)],
    );
    return { clientId, clientName, redirectUris };
  }

  async client(clientId: string): Promise<OAuthClient | null> {
    const [row] = await this.#storage.query<{
      client_id: string;
      client_name: string;
      redirect_uris: string[] | string;
    }>(
      "SELECT client_id, client_name, redirect_uris FROM _memloom_oauth_clients WHERE client_id = $1",
      [clientId],
    );
    if (!row) return null;
    const uris =
      typeof row.redirect_uris === "string" ? JSON.parse(row.redirect_uris) : row.redirect_uris;
    return { clientId: row.client_id, clientName: row.client_name, redirectUris: uris };
  }
}
