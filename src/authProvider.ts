import { randomUUID } from "node:crypto";
import { Response } from "express";
import {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidRequestError,
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { config } from "./config";

/**
 * Dynamic client registration store. Any MCP client can self-register (per the
 * MCP spec's required DCR flow); the actual gate is the username/password
 * login screen in PendingAuthStore below.
 */
export class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  async getClient(clientId: string) {
    return this.clients.get(clientId);
  }

  async registerClient(
    clientMetadata: Omit<
      OAuthClientInformationFull,
      "client_id" | "client_id_issued_at"
    >
  ) {
    const client: OAuthClientInformationFull = {
      ...clientMetadata,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(client.client_id, client);
    return client;
  }
}

interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
}

interface IssuedCode {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
}

interface IssuedToken {
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

interface IssuedRefreshToken {
  clientId: string;
  scopes: string[];
}

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const LOGIN_TTL_MS = 5 * 60 * 1000; // 5 minutes to complete the login form

/**
 * Single-user OAuth 2.1 authorization server for this MCP.
 *
 * `authorize()` renders a small login form instead of redirecting straight
 * back to the client, gating the flow on OAUTH_USERNAME / OAUTH_PASSWORD.
 * The form POSTs to /login (wired up in index.ts), which validates the
 * credentials and then calls `completeLogin` to issue the auth code and
 * perform the actual OAuth redirect.
 *
 * All state (pending logins, codes, tokens) is in-memory: it resets on
 * redeploy/restart, which just means connected clients need to
 * re-authenticate. There is a single user, so this is an acceptable
 * trade-off for the simplicity it buys.
 *
 * Access tokens are short-lived (1 hour), but refresh tokens are issued
 * alongside them and rotated on use, so a well-behaved MCP client renews
 * its session silently instead of prompting the login form again every hour.
 */
export class SingleUserAuthProvider implements OAuthServerProvider {
  clientsStore = new InMemoryClientsStore();

  private pending = new Map<string, PendingAuthorization>();
  private codes = new Map<string, IssuedCode>();
  private tokens = new Map<string, IssuedToken>();
  private refreshTokens = new Map<string, IssuedRefreshToken>();

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new InvalidRequestError("Unregistered redirect_uri");
    }

    const loginId = randomUUID();
    this.pending.set(loginId, { client, params });
    setTimeout(() => this.pending.delete(loginId), LOGIN_TTL_MS).unref();

    res.status(200).type("html").send(renderLoginForm(loginId));
  }

  /** Called by the /login POST handler once credentials are checked. */
  async completeLogin(loginId: string, res: Response): Promise<void> {
    const pending = this.pending.get(loginId);
    if (!pending) {
      res.status(400).type("html").send(renderLoginForm(null, "This login link has expired. Please try connecting again."));
      return;
    }
    this.pending.delete(loginId);

    const code = randomUUID();
    this.codes.set(code, { client: pending.client, params: pending.params });
    setTimeout(() => this.codes.delete(code), LOGIN_TTL_MS).unref();

    const target = new URL(pending.params.redirectUri);
    target.searchParams.set("code", code);
    if (pending.params.state !== undefined) {
      target.searchParams.set("state", pending.params.state);
    }
    res.redirect(target.toString());
  }

  getPendingLoginId(loginId: string): boolean {
    return this.pending.has(loginId);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const data = this.codes.get(authorizationCode);
    if (!data) throw new InvalidGrantError("Invalid authorization code");
    return data.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<OAuthTokens> {
    const data = this.codes.get(authorizationCode);
    if (!data) throw new InvalidGrantError("Invalid authorization code");
    if (data.client.client_id !== client.client_id) {
      throw new InvalidGrantError("Authorization code was not issued to this client");
    }
    this.codes.delete(authorizationCode);

    const scopes = data.params.scopes ?? [];
    return this.issueTokens(client.client_id, scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[]
  ): Promise<OAuthTokens> {
    const data = this.refreshTokens.get(refreshToken);
    if (!data) throw new InvalidGrantError("Invalid or already-used refresh token");
    if (data.clientId !== client.client_id) {
      throw new InvalidGrantError("Refresh token was not issued to this client");
    }
    // Rotate: the old refresh token is single-use.
    this.refreshTokens.delete(refreshToken);

    return this.issueTokens(client.client_id, scopes ?? data.scopes);
  }

  private issueTokens(clientId: string, scopes: string[]): OAuthTokens {
    const token = randomUUID();
    this.tokens.set(token, {
      clientId,
      scopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    });

    const refreshToken = randomUUID();
    this.refreshTokens.set(refreshToken, { clientId, scopes });

    return {
      access_token: token,
      token_type: "bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const data = this.tokens.get(token);
    if (!data || data.expiresAt < Date.now()) {
      throw new InvalidTokenError("Invalid or expired token");
    }
    return {
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: Math.floor(data.expiresAt / 1000),
    };
  }
}

function renderLoginForm(loginId: string | null, error?: string): string {
  const escapedError = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : "";
  const formBody = loginId
    ? `
      <input type="hidden" name="login_id" value="${escapeHtml(loginId)}" />
      <label>Username<input type="text" name="username" autocomplete="username" required autofocus /></label>
      <label>Password<input type="password" name="password" autocomplete="current-password" required /></label>
      <button type="submit">Authorize</button>
    `
    : "";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Sign in to datastore-mcp</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 360px; margin: 10vh auto; color: #1a1a1a; }
    h1 { font-size: 1.1rem; }
    form { display: flex; flex-direction: column; gap: 0.75rem; }
    label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; }
    input { padding: 0.5rem; font-size: 1rem; }
    button { padding: 0.6rem; font-size: 1rem; cursor: pointer; }
    .error { color: #b00020; }
  </style>
</head>
<body>
  <h1>Authorize access to your datastore-mcp state store</h1>
  ${escapedError}
  <form method="post" action="/login">
    ${formBody}
  </form>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function checkCredentials(username: string, password: string): boolean {
  return username === config.oauth.username && password === config.oauth.password;
}

export { renderLoginForm };
