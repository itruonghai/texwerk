import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

/**
 * A second way in for `--access`: people who are not on the tailnet, signed
 * in by Cloudflare Access (an emailed one-time code, or whatever login the
 * Access application allows) and carried here by a Cloudflare Tunnel. Ported
 * from DeckWerk's src/server/cloudflareAccess.ts.
 *
 * The tunnel daemon (`cloudflared`) runs on this machine and connects to a
 * listener of its own (`--cloudflare-port`), never to the tailscale serve
 * port. Which port a connection arrived on decides how its identity is read:
 *
 * - On the tailscale port nothing changes (identity.ts).
 * - On the Cloudflare port the only identity is the one in the request's
 *   `Cf-Access-Jwt-Assertion` header: a token Cloudflare signs for this
 *   Access application, checked here against the team's published keys,
 *   issuer and the application's audience tag. Tailscale headers are never
 *   read there, and a request without a valid token is nobody, not the
 *   machine owner — every request on that port arrives from the tunnel
 *   daemon over loopback, so "loopback" proves nothing about the person.
 *
 * The person's login is their email address, lower-cased, so a project is
 * shared with a Cloudflare user by typing their email in Share…, exactly as
 * with a tailnet login. When the admin signs in through Cloudflare with the
 * same address as their tailnet login, they are the admin on both doors.
 *
 * Only node:crypto: the token is a plain RS256 JWT, and the keys are the
 * JWK set at https://<team domain>/cdn-cgi/access/certs.
 */

export interface CloudflareAccessConfig {
  /** The Zero Trust team domain, e.g. "acme.cloudflareaccess.com". */
  teamDomain: string;
  /** The Access application's audience (AUD) tag. */
  audience: string;
}

/** Who a verified token names. */
export interface CloudflarePerson {
  login: string;
  name: string;
}

export const CLOUDFLARE_TOKEN_HEADER = 'cf-access-jwt-assertion';
/** How long fetched signing keys are used before they are fetched again. */
const KEYS_MAX_AGE_MS = 60 * 60 * 1000;
/**
 * How long keys are still used while Cloudflare cannot be reached to refresh
 * them. Past this nobody gets in: a key Cloudflare has withdrawn must not stay
 * good forever just because this machine is cut off from hearing about it.
 */
const KEYS_STALE_LIMIT_MS = 6 * 60 * 60 * 1000;
/** Fetches happen at most this often, however many unknown key ids arrive. */
const KEYS_REFETCH_MIN_MS = 30 * 1000;
/** Clock skew tolerated on exp / nbf / iat. */
const CLOCK_SKEW_S = 60;

/** "acme.cloudflareaccess.com", from however the operator typed it. */
export function normalizeTeamDomain(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(trimmed)) {
    throw new Error(`not a Cloudflare Access team domain: ${value}`);
  }
  return trimmed;
}

/** Sockets accepted on the Cloudflare listener: identity on these comes from the verified token alone. */
const cloudflareSockets = new WeakSet<Socket>();
/** Who each verified request on the Cloudflare listener is, and until when (ms). */
const verifiedRequests = new WeakMap<IncomingMessage, { person: CloudflarePerson; expiresAt: number }>();

export function admitCloudflareSocket(socket: Socket): void {
  cloudflareSockets.add(socket);
}

export function isCloudflareRequest(request: IncomingMessage): boolean {
  return cloudflareSockets.has(request.socket as Socket);
}

/** The person this request was verified as, or null (also for unverified requests). */
export function cloudflarePersonOf(request: IncomingMessage): CloudflarePerson | null {
  return verifiedRequests.get(request)?.person ?? null;
}

/**
 * When this request's sign-in runs out (epoch ms), or null when it was not
 * verified. A WebSocket outlives its handshake; the server closes it then.
 */
export function cloudflareSessionEndsAt(request: IncomingMessage): number | null {
  return verifiedRequests.get(request)?.expiresAt ?? null;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface Jwk { kid?: unknown; kty?: unknown }

export interface CloudflareAccessVerifier {
  /**
   * Check the request's token and remember who it is. Safe to call more than
   * once for the same request. Resolves to the person, or null when the
   * token is missing, malformed, expired, for another application, or not
   * signed by the team's keys.
   */
  admit(request: IncomingMessage): Promise<CloudflarePerson | null>;
  /** The token check alone, for tests and diagnostics. */
  verifyToken(token: string): Promise<CloudflarePerson | null>;
}

export function createCloudflareAccessVerifier(
  config: CloudflareAccessConfig,
  options: { fetch?: FetchLike; now?: () => number } = {},
): CloudflareAccessVerifier {
  const teamDomain = normalizeTeamDomain(config.teamDomain);
  const audience = config.audience.trim();
  if (!audience) throw new Error('Cloudflare Access needs the application audience (AUD) tag');
  const issuer = `https://${teamDomain}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;

  let keys = new Map<string, KeyObject>();
  /** Last fetch that produced keys, and last attempt of any outcome. */
  let refreshedAt = -Infinity;
  let attemptedAt = -Infinity;
  let inflight: Promise<void> | null = null;

  const refreshKeys = (): Promise<void> => {
    inflight ??= (async () => {
      try {
        const response = await fetchImpl(certsUrl, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as { keys?: unknown };
        const next = new Map<string, KeyObject>();
        for (const jwk of Array.isArray(body.keys) ? body.keys as Jwk[] : []) {
          if (typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue;
          try {
            next.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
          } catch {
            // One unreadable key must not cost the others.
          }
        }
        if (next.size === 0) throw new Error('no usable RSA keys in the response');
        keys = next;
        refreshedAt = now();
      } catch (error) {
        // Keep what we had: a Cloudflare hiccup should not sign everyone out.
        process.stderr.write(`cloudflare access: could not fetch signing keys from ${certsUrl}: ${
          error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        attemptedAt = now();
        inflight = null;
      }
    })();
    return inflight;
  };

  const keyFor = async (kid: string): Promise<KeyObject | null> => {
    const due = now() - refreshedAt > KEYS_MAX_AGE_MS || !keys.has(kid);
    if (due && (inflight || now() - attemptedAt > KEYS_REFETCH_MIN_MS)) await refreshKeys();
    if (now() - refreshedAt > KEYS_STALE_LIMIT_MS) return null;
    return keys.get(kid) ?? null;
  };

  const verifySession = async (token: string): Promise<{ person: CloudflarePerson; expiresAt: number } | null> => {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = decodeJson(headerPart);
    const payload = decodeJson(payloadPart);
    if (!header || !payload) return null;
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

    const key = await keyFor(header.kid);
    if (!key) return null;
    let valid = false;
    try {
      valid = verify('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`), key, Buffer.from(signaturePart, 'base64url'));
    } catch {
      valid = false;
    }
    if (!valid) return null;

    if (payload.iss !== issuer) return null;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(audience)) return null;
    const seconds = now() / 1000;
    if (typeof payload.exp !== 'number' || payload.exp < seconds - CLOCK_SKEW_S) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > seconds + CLOCK_SKEW_S) return null;
    if (typeof payload.iat === 'number' && payload.iat > seconds + CLOCK_SKEW_S) return null;
    // Service tokens carry a common_name instead of an email; they are not people.
    if (typeof payload.email !== 'string' || !payload.email.includes('@')) return null;
    const login = payload.email.trim().toLowerCase(); // as normalizeLogin
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 60) : login;
    // The same tolerance the check above allows: a socket closed any sooner
    // would reload into the very token it was just refused for.
    return { person: { login, name }, expiresAt: (payload.exp + CLOCK_SKEW_S) * 1000 };
  };

  return {
    verifyToken: async (token) => (await verifySession(token))?.person ?? null,
    async admit(request) {
      const known = verifiedRequests.get(request);
      if (known) return known.person;
      const raw = request.headers[CLOUDFLARE_TOKEN_HEADER];
      const token = (Array.isArray(raw) ? raw[0] : raw)?.trim();
      if (!token) return null;
      const session = await verifySession(token);
      if (session) verifiedRequests.set(request, session);
      return session?.person ?? null;
    },
  };
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
