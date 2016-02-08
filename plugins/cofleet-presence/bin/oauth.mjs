// The OAuth client for `cofleet login` — RFC 8252 native-app flow against
// Cofleet's MCP authorization server.
//
// Why a browser flow and not a pasted token: a `vk_` token can only be minted
// server-side by an operator, which makes every new teammate a support ticket.
// This is the same handshake Claude Code itself runs to connect the MCP, so a
// developer who can sign in to Cofleet can authorise this without anyone's
// help.
//
// Shape: discover → register a client on the loopback port we just bound →
// authorize in the browser with PKCE → exchange the code → store the pair.
//
// A NEW client is registered per login. The server matches `redirect_uri`
// EXACTLY (auth/oauth/clients.ts), so the port has to be known before
// registering, and the port is ephemeral — binding first and registering second
// is the only order that works. Logins are rare enough that the extra client
// row is cheaper than reserving a fixed port and failing when it is taken.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const DISCOVERY_PATH = '/.well-known/oauth-authorization-server';
/** How long to wait for the human to finish in the browser. */
const CONSENT_TIMEOUT_MS = 5 * 60_000;
const HTTP_TIMEOUT_MS = 15_000;
const TRUSTED_HTTPS_ORIGINS = new Set([
  'https://app.cofleet.dev',
  'https://dev.cofleet.dev',
]);

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const octets = hostname.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}

/** A Cofleet origin carries credentials, so remote traffic is limited to the
 * fixed Cofleet deployments. HTTP(S) loopback remains available for local
 * development without exposing the token on the network. */
export function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error('Cofleet server URL must be an HTTPS origin (HTTP is allowed only for loopback)');
  }
  const url = new URL(value);
  const loopback = isLoopbackHostname(url.hostname);
  const trustedRemote =
    url.protocol === 'https:' &&
    TRUSTED_HTTPS_ORIGINS.has(url.origin) &&
    (value === url.origin || value === `${url.origin}/`);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    (!loopback && !trustedRemote) ||
    url.username ||
    url.password ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search ||
    url.hash
  ) {
    throw new Error('Cofleet server URL must be an HTTPS origin (HTTP is allowed only for loopback)');
  }
  return url.origin;
}

function validatedEndpoint(configuredOrigin, field, value) {
  if (typeof value !== 'string') {
    return { ok: false, reason: `${configuredOrigin} advertises no ${field}.` };
  }
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    return { ok: false, reason: `${field} must be an absolute URL on the configured origin.` };
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    return { ok: false, reason: `${field} must be an uncredentialed URL on the configured origin.` };
  }
  if (new URL(configuredOrigin).protocol === 'https:' && endpoint.protocol !== 'https:') {
    return { ok: false, reason: `${field} must not downgrade the configured HTTPS origin.` };
  }
  if (endpoint.origin !== configuredOrigin) {
    return {
      ok: false,
      reason: `${field} must use the same origin as the configured Cofleet server.`,
    };
  }
  return { ok: true, url: endpoint.href };
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE S256 — the only challenge method this server advertises. */
export function makePkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    // Never let an OAuth POST follow a 307/308 to another origin with the
    // authorization code, verifier, or refresh token still in its body.
    const response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Bind 127.0.0.1:0 and resolve once the port is known. The redirect URI is
 *  built from the assigned port, so nothing can be registered before this. */
function listenLoopback(onCode) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const ok = !error && Boolean(code);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        `<!doctype html><meta charset="utf-8"><title>Cofleet</title>` +
          `<body style="font:16px system-ui;padding:3rem;max-width:32rem">` +
          (ok
            ? `<h1>Connected</h1><p>Cofleet is linked to this machine. You can close this tab and go back to your terminal.</p>`
            : `<h1>Not connected</h1><p>${error ? String(error).replace(/[<&]/g, '') : 'No authorization code was returned'}. Run <code>cofleet login</code> again.</p>`) +
          `</body>`,
      );
      onCode({ code, state, error });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** Best-effort browser open. Always returns; the caller prints the URL either
 *  way, because a headless box or an SSH session has no browser to open and the
 *  flow still has to be completable by hand. */
function openBrowser(url) {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(opener, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No opener on this box — the printed URL is the fallback.
  }
}

/**
 * Run the full login. `log` receives human-facing lines so the caller owns
 * output. The browser opener is injectable so tests never launch an OS browser.
 *
 * Resolves `{ ok: true, credentials }` or `{ ok: false, reason }`.
 */
export async function login(
  baseUrl,
  log = () => {},
  { openBrowser: browserOpener = openBrowser } = {},
) {
  let configuredOrigin;
  try {
    configuredOrigin = normalizeOrigin(baseUrl);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Invalid Cofleet origin.' };
  }

  const discovery = await fetchJson(`${configuredOrigin}${DISCOVERY_PATH}`);
  if (!discovery.ok) {
    return {
      ok: false,
      reason:
        discovery.status === 404
          ? `${configuredOrigin} has no OAuth authorization server (OAUTH_ENABLED is off there).`
          : `Could not read ${DISCOVERY_PATH} from ${configuredOrigin} (HTTP ${discovery.status}).`,
    };
  }
  const meta = discovery.body;

  let issuer;
  try {
    issuer = normalizeOrigin(meta.issuer);
  } catch {
    return { ok: false, reason: `${configuredOrigin} advertises an invalid issuer.` };
  }
  if (issuer !== configuredOrigin) {
    return { ok: false, reason: `OAuth issuer must equal the configured Cofleet origin.` };
  }

  const endpoints = {};
  for (const field of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    const validated = validatedEndpoint(configuredOrigin, field, meta[field]);
    if (!validated.ok) return validated;
    endpoints[field] = validated.url;
  }

  let settle;
  const callback = new Promise((resolve) => {
    settle = resolve;
  });
  const { server, port } = await listenLoopback((result) => settle(result));
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    const registration = await fetchJson(endpoints.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Cofleet plugin for Claude Code',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        // Public client: there is nowhere on a developer's laptop to keep a
        // client secret that the developer cannot already read.
        token_endpoint_auth_method: 'none',
      }),
    });
    if (!registration.ok || typeof registration.body.client_id !== 'string') {
      return { ok: false, reason: `Client registration failed (HTTP ${registration.status}).` };
    }
    const clientId = registration.body.client_id;

    const { verifier, challenge } = makePkce();
    const state = base64url(randomBytes(16));
    const authorizeUrl = `${endpoints.authorization_endpoint}?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    })}`;

    log(`Opening your browser to authorise this machine.`);
    log(`If it does not open, visit:\n  ${authorizeUrl}\n`);
    browserOpener(authorizeUrl);

    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve({ error: 'timeout' }), CONSENT_TIMEOUT_MS).unref?.(),
    );
    const result = await Promise.race([callback, timeout]);

    if (result.error === 'timeout') return { ok: false, reason: 'Timed out waiting for approval.' };
    if (result.error) return { ok: false, reason: `Authorization refused: ${result.error}` };
    // A mismatched state means the code did not come from the request we made.
    if (result.state !== state) return { ok: false, reason: 'State mismatch — login aborted.' };

    const token = await fetchJson(endpoints.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: result.code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_id: clientId,
      }).toString(),
    });
    if (!token.ok || typeof token.body.access_token !== 'string') {
      return { ok: false, reason: `Token exchange failed (HTTP ${token.status}).` };
    }

    return {
      ok: true,
      credentials: {
        baseUrl: configuredOrigin,
        clientId,
        accessToken: token.body.access_token,
        refreshToken: token.body.refresh_token ?? null,
        // Absolute, so a stored credential stays meaningful across restarts.
        expiresAt: Date.now() + (Number(token.body.expires_in) || 0) * 1000,
      },
    };
  } finally {
    server.close();
  }
}

/** Rotate an expiring access token. The server rotates the refresh token too,
 *  so the caller MUST persist what comes back — reusing a spent refresh token
 *  is an invalid_grant. */
export async function refresh(credentials, tokenEndpoint) {
  if (!credentials.refreshToken) return { ok: false, reason: 'no_refresh_token' };
  let credentialOrigin;
  try {
    credentialOrigin = normalizeOrigin(credentials.baseUrl);
  } catch {
    return { ok: false, reason: 'invalid_credential_origin' };
  }
  const validated = validatedEndpoint(credentialOrigin, 'token_endpoint', tokenEndpoint);
  if (!validated.ok) return validated;

  const response = await fetchJson(validated.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: credentials.clientId,
    }).toString(),
  });
  if (!response.ok || typeof response.body.access_token !== 'string') {
    return { ok: false, reason: `refresh_failed_${response.status}` };
  }
  return {
    ok: true,
    credentials: {
      ...credentials,
      accessToken: response.body.access_token,
      refreshToken: response.body.refresh_token ?? credentials.refreshToken,
      expiresAt: Date.now() + (Number(response.body.expires_in) || 0) * 1000,
    },
  };
}
