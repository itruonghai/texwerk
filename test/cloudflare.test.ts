/**
 * The Cloudflare door (src/server/cloudflareAccess.ts): who a token makes
 * you, and what a guest from the internet may open and do.
 */
import { strict as assert } from 'node:assert';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createCloudflareAccessVerifier } from '../src/server/cloudflareAccess.ts';
import { startServer } from '../src/server/server.ts';
import { CLOSE_SIGN_IN_EXPIRED } from '../src/shared/protocol.ts';

const TEAM = 'acme.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const ADMIN = 'admin@example.com';
const GUEST = 'guest@example.com';
const PUBLIC_HOST = 'tex.example.com';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] };
const certsFetch = async () => ({ ok: true, status: 200, json: async () => jwks });

function token(claims: Record<string, unknown>, opts: { kid?: string; key?: typeof privateKey } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: `https://${TEAM}`, aud: [AUD], iat: now, nbf: now, exp: now + 3600, ...claims,
  })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), opts.key ?? privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

test('a token counts only when Cloudflare signed it for this application, unexpired, for a person', async () => {
  const verifier = createCloudflareAccessVerifier({ teamDomain: TEAM, audience: AUD }, { fetch: certsFetch });
  assert.deepEqual(await verifier.verifyToken(token({ email: 'Ann@Example.com', name: 'Ann' })), { login: 'ann@example.com', name: 'Ann' });
  const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  for (const [why, bad] of [
    ['another key', token({ email: GUEST }, { key: otherKey })],
    ['an unknown key id', token({ email: GUEST }, { kid: 'k2' })],
    ['another application', token({ email: GUEST, aud: ['b'.repeat(64)] })],
    ['another team', token({ email: GUEST, iss: 'https://evil.cloudflareaccess.com' })],
    ['expired', token({ email: GUEST, exp: now - 3600 })],
    ['a service token', token({ common_name: 'bot' })],
    ['garbage', 'not.a.token'],
  ] as const) {
    assert.equal(await verifier.verifyToken(bad), null, why);
  }
});

function call(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers }, (r) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => { body += c; });
      r.on('end', () => done({ status: r.statusCode!, body }));
    }).on('error', fail);
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}

async function server(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'texwerk-cloudflare-'));
  const projects = join(root, 'projects');
  const access = (sharedWith: Array<{ login: string; role: string }>) =>
    JSON.stringify({ owner: ADMIN, visibility: 'private', sharedWith, publicRole: 'view' });
  for (const [name, sidecar] of [
    ['Public', null],
    ['Shared', access([{ login: GUEST, role: 'edit' }])],
    ['Viewed', access([{ login: GUEST, role: 'view' }])],
    ['Private', access([])],
  ] as const) {
    await mkdir(join(projects, name, '.texwerk'), { recursive: true });
    await writeFile(join(projects, name, 'main.tex'), `${name}\n`);
    if (sidecar) await writeFile(join(projects, name, '.texwerk', 'access.json'), sidecar);
  }
  // The verifier fetches the team's keys with the global fetch.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
    String(url).startsWith(`https://${TEAM}/`) ? certsFetch() : realFetch(url, init)) as typeof fetch;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const cfPort = port + 1;
  const s = await startServer({
    rootDir: projects, clientDir: null, bridgeFile: null, port, host: '127.0.0.1', access: { admin: ADMIN },
    cloudflare: { teamDomain: TEAM, audience: AUD, port: cfPort, publicUrl: `https://${PUBLIC_HOST}` },
  });
  t.after(async () => { globalThis.fetch = realFetch; await s.close(); await rm(root, { recursive: true, force: true }); });
  const as = (email: string, claims: Record<string, unknown> = {}) => ({
    host: PUBLIC_HOST, origin: `https://${PUBLIC_HOST}`, 'cf-access-jwt-assertion': token({ email, ...claims }),
  });
  return { port, cfPort, as };
}

test('on the Cloudflare port nobody without a token gets in, whatever else they send', async (t) => {
  const { cfPort, port } = await server(t);
  assert.equal((await call(cfPort, '/api/me', { headers: { host: PUBLIC_HOST } })).status, 403, 'loopback alone is not the admin there');
  assert.equal((await call(cfPort, '/api/me', { headers: { host: PUBLIC_HOST, 'tailscale-user-login': ADMIN } })).status, 403, 'tailscale headers are not read there');
  const me = JSON.parse((await call(port, '/api/me')).body) as { you: { login: string }; admin: boolean };
  assert.equal(me.you.login, ADMIN, 'the tailscale port is unchanged');
  assert.equal(me.admin, true);
});

test('a guest sees only what is shared with them, never what is public on the tailnet', async (t) => {
  const { cfPort, port, as } = await server(t);
  const me = JSON.parse((await call(cfPort, '/api/me', { headers: as(GUEST) })).body) as { you: { login: string; external: boolean }; guest: boolean; admin: boolean };
  assert.equal(me.you.login, GUEST);
  assert.equal(me.guest, true);
  assert.equal(me.admin, false);
  const listed = (JSON.parse((await call(cfPort, '/api/projects', { headers: as(GUEST) })).body) as { projects: Array<{ id: string; role: string }> }).projects;
  assert.deepEqual(listed.map((p) => `${p.id}:${p.role}`).sort(), ['Shared:edit', 'Viewed:view']);
  assert.equal((await call(cfPort, '/raw/Public/main.tex', { headers: as(GUEST) })).status, 403);
  assert.equal((await call(cfPort, '/raw/Private/main.tex', { headers: as(GUEST) })).status, 403);
  assert.equal((await call(cfPort, '/raw/Shared/main.tex', { headers: as(GUEST) })).body, 'Shared\n');
  assert.equal((await call(cfPort, '/api/file?project=Viewed&path=main.tex', { method: 'PUT', headers: as(GUEST), body: 'x' })).status, 403, 'view stays view');
  // The same person on the tailnet would see the public project.
  assert.equal((await call(port, '/raw/Public/main.tex', { headers: { 'tailscale-user-login': GUEST, 'x-forwarded-for': '100.64.0.9' } })).status, 200);
  // The admin's email is the admin on this door too.
  const adminList = (JSON.parse((await call(cfPort, '/api/projects', { headers: as(ADMIN) })).body) as { projects: unknown[] }).projects;
  assert.equal(adminList.length, 4);
});

test('a guest cannot create, import, move, reach the trash or the user list, or point git elsewhere', async (t) => {
  const { cfPort, as } = await server(t);
  for (const [method, path, body] of [
    ['POST', '/api/projects', { name: 'Mine' }],
    ['POST', '/api/projects/clone', { url: 'https://example.com/x.git', name: 'Mine' }],
    ['POST', '/api/folders?path=F', undefined],
    ['GET', '/api/users', undefined],
    ['GET', '/api/projects/trash', undefined],
    ['POST', '/api/git/remote?project=Shared', { url: 'http://127.0.0.1:5800/x.git' }],
    ['POST', '/api/git/deploy-key?project=Shared', undefined],
    ['POST', '/api/projects/delete?project=Shared', undefined],
  ] as const) {
    const r = await call(cfPort, path, { method, headers: as(GUEST), body });
    assert.equal(r.status, 403, `${method} ${path}: ${r.body}`);
  }
});

test('a guest\'s socket opens only on a shared project and closes when the sign-in runs out', async (t) => {
  const { cfPort, as } = await server(t);
  const open = (project: string, headers: Record<string, string>) => new Promise<{ code: number; opened: boolean }>((done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${cfPort}/ws?project=${project}`, { headers });
    let opened = false;
    ws.once('open', () => { opened = true; });
    ws.once('close', (code) => done({ code, opened }));
    ws.once('error', () => done({ code: 0, opened }));
    setTimeout(() => { if (ws.readyState === ws.OPEN) ws.close(1000); }, 2500);
  });
  assert.equal((await open('Public', as(GUEST))).code, 4403);
  assert.equal((await open('Shared', { host: PUBLIC_HOST })).opened, false, 'no token, no socket');
  const lasting = await open('Shared', as(GUEST));
  assert.equal(lasting.code, 1000, 'stays open while the sign-in holds');
  // Within the clock-skew tolerance, about one second from running out.
  const expiring = await open('Shared', as(GUEST, { exp: Math.floor(Date.now() / 1000) - 59 }));
  assert.ok(expiring.opened);
  assert.equal(expiring.code, CLOSE_SIGN_IN_EXPIRED);
});
