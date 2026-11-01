import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeTeamDomain } from './cloudflareAccess.ts';
import { startServer } from './server.ts';

/**
 * TeXWerk collaboration server:
 *   npm run serve -- <projectsRootDir> [--port 5810] [--host 0.0.0.0] [--access <adminLogin>] [--allow-host <name>]
 *     [--cloudflare-team <team>.cloudflareaccess.com --cloudflare-aud <tag> [--cloudflare-port 5811] [--public-url https://tex.example.com]]
 *
 * Every top-level folder of <projectsRootDir> is a LaTeX project and a git
 * repository. Binds all interfaces by default so tailnet peers can reach it.
 *
 * --access <adminLogin> takes identity from `tailscale serve`'s
 * Tailscale-User-Login headers (trusted on loopback only — pair with
 * --host 127.0.0.1 and `tailscale serve`). Without it, people type a name.
 *
 * --allow-host <name> (repeatable): a DNS name people reach the server by,
 * besides IP addresses, localhost, single-label, *.ts.net and *.local names,
 * which are always allowed (see origin.ts).
 *
 * --cloudflare-team / --cloudflare-aud open a second door, with --access,
 * for people off the tailnet: a loopback listener on --cloudflare-port (5811)
 * for a Cloudflare Tunnel behind a Cloudflare Access application. There
 * identity is the email in the token Cloudflare Access signs, checked
 * against the team's keys and the application's audience tag; see
 * cloudflareAccess.ts. Such guests open only projects shared with their
 * email. --public-url is the address they open; its host name is allowed.
 */
const args = process.argv.slice(2);
let rootDir: string | null = null;
let port = 5810;
let host = '0.0.0.0';
let access: string | null = null;
const allowHosts: string[] = [];
let cloudflareTeam: string | null = null;
let cloudflareAud: string | null = null;
let cloudflarePort = 5811;
let publicUrl: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--host') host = args[++i];
  else if (args[i] === '--access') access = args[++i];
  else if (args[i] === '--allow-host') allowHosts.push(...args[++i].split(','));
  else if (args[i] === '--cloudflare-team') cloudflareTeam = args[++i];
  else if (args[i] === '--cloudflare-aud') cloudflareAud = args[++i];
  else if (args[i] === '--cloudflare-port') cloudflarePort = Number(args[++i]);
  else if (args[i] === '--public-url') publicUrl = args[++i];
  else if (!args[i].startsWith('-') && !rootDir) rootDir = args[i];
}
const cloudflareRequested = cloudflareTeam !== null || cloudflareAud !== null;
let cloudflareTeamDomain = '';
try { if (cloudflareRequested) cloudflareTeamDomain = normalizeTeamDomain(cloudflareTeam ?? ''); } catch { /* reported below */ }
if (!rootDir || Number.isNaN(port)
  || (cloudflareRequested && (!cloudflareTeamDomain || !cloudflareAud?.trim() || !access
    || !Number.isInteger(cloudflarePort) || cloudflarePort <= 0 || cloudflarePort === port
    || (publicUrl !== undefined && !/^https:\/\/[^/\s]+\/?$/.test(publicUrl))))) {
  process.stderr.write('usage: npm run serve -- <projectsRootDir> [--port 5810] [--host 0.0.0.0] [--access <adminLogin>] [--allow-host <name>]\n'
    + '  [--cloudflare-team <team>.cloudflareaccess.com --cloudflare-aud <tag> [--cloudflare-port 5811] [--public-url https://tex.example.com]]\n'
    + (cloudflareRequested ? '  (--cloudflare-team and --cloudflare-aud go together, need --access, and --cloudflare-port must differ from --port)\n' : ''));
  process.exit(2);
}
if (access && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
  process.stderr.write('warning: --access trusts identity headers on loopback only. Bind --host 127.0.0.1 and front the server with `tailscale serve`.\n');
}

const appDir = resolve(import.meta.dirname, '..', '..');
const clientDir = join(appDir, 'dist', 'client');
const bridgeFile = join(appDir, 'dist', 'texwerk-connect.mjs');
const server = await startServer({
  rootDir: resolve(rootDir),
  clientDir: existsSync(join(clientDir, 'index.html')) ? clientDir : null,
  bridgeFile: existsSync(bridgeFile) ? bridgeFile : null,
  port,
  host,
  access: access ? { admin: access } : null,
  allowHosts,
  cloudflare: cloudflareRequested
    ? { teamDomain: cloudflareTeamDomain, audience: cloudflareAud!, port: cloudflarePort, publicUrl }
    : undefined,
});
process.stdout.write(`${JSON.stringify({
  status: 'serving', rootDir: resolve(rootDir), access, urls: server.urls,
  cloudflare: server.cloudflarePort === undefined ? null : { teamDomain: cloudflareTeamDomain, port: server.cloudflarePort, publicUrl: publicUrl ?? null },
})}\n`);

const stop = () => { void server.close().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
