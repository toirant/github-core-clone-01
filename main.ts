// main.ts: entrypoint for the github-core-clone-01 forge.
//
// Lifecycle (per the kit's RULES.txt): the forge binds an ephemeral port of
// its own, registers that port with the trial environment, and stays up
// while the suite drives it. When the suite has finished and written its
// export it answers {"done": true} on /done, and this process exits 0.
//
//   1. createApp() builds the HTTP server (git smart HTTP, REST v3,
//      GraphQL v4 and MCP) over one in-memory Forge.
//   2. The server listens on port 0, so the kernel picks an ephemeral
//      port; it never binds 8080, where the suite listens.
//   3. With MAKEFUN_ENV_URL set, POST {"port": <port>} to
//      $MAKEFUN_ENV_URL/register, retrying until the env accepts it.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true},
//      then close the server and exit 0.
//
// Without MAKEFUN_ENV_URL (local development) the server just listens on
// $PORT, or 8080, and serves until it is stopped. Node 22 runs this file
// directly, so only erasable TypeScript is used here.

import { createApp } from './app.ts';
import type { Server } from 'node:http';

/** Where the suite listens; the entry must never bind this port. */
const SUITE_PORT = 8080;
/** Port used for local development when no trial environment is set. */
const DEV_PORT = 8080;
/** How long one register attempt may take. */
const REGISTER_TIMEOUT_MS = 5_000;
/** How long one /done poll may take. */
const DONE_TIMEOUT_MS = 10_000;
/** Gap between /done polls (the env answers each poll at once). */
const DONE_POLL_MS = 1_000;
/** How long to keep retrying the register before giving up. */
const REGISTER_BUDGET_MS = 15_000;
/** Gap between register attempts, growing to this cap. */
const REGISTER_RETRY_MS = 250;
const REGISTER_RETRY_MAX_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).replace(/\s+/g, ' ').trim();
}

function envBaseUrl(): string | null {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw.trim() === '') return null;
  return raw.replace(/\/+$/, '');
}

function devPort(): number {
  const raw = process.env.PORT;
  if (raw !== undefined && raw !== '') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 && parsed !== SUITE_PORT) return parsed;
  }
  return DEV_PORT;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '0.0.0.0' }, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the listener has no TCP address'));
        return;
      }
      resolve(address.port);
    });
  });
}

/** POST {"port": N} to the env's /register; true only on a 200 answer. */
async function tryRegister(envUrl: string, port: number): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`${envUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    });
  } catch (err) {
    process.stderr.write(`register: POST /register failed (${messageOf(err)})\n`);
    return false;
  }
  await response.arrayBuffer().catch(() => undefined);
  if (response.status !== 200) {
    process.stderr.write(`register: POST /register answered HTTP ${response.status}\n`);
    return false;
  }
  return true;
}

/** Keep registering until the env accepts, or the boot budget runs out. */
async function register(envUrl: string, port: number): Promise<void> {
  const deadline = Date.now() + REGISTER_BUDGET_MS;
  let delay = REGISTER_RETRY_MS;
  for (;;) {
    if (await tryRegister(envUrl, port)) return;
    if (Date.now() >= deadline) {
      throw new Error(`no register accepted within ${REGISTER_BUDGET_MS} ms`);
    }
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    delay = Math.min(REGISTER_RETRY_MAX_MS, delay * 2);
  }
}

/** GET /done once; true when the suite answers {"done": true}. */
async function pollOnce(envUrl: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`${envUrl}/done`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(DONE_TIMEOUT_MS),
    });
  } catch (err) {
    process.stderr.write(`done: GET /done failed (${messageOf(err)})\n`);
    return false;
  }
  if (response.status !== 200) {
    process.stderr.write(`done: GET /done answered HTTP ${response.status}\n`);
    await response.arrayBuffer().catch(() => undefined);
    return false;
  }
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    return false;
  }
  return typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true;
}

/** Poll /done until the suite is finished, then stop serving and exit 0. */
async function waitForDone(envUrl: string, server: Server): Promise<void> {
  for (;;) {
    if (await pollOnce(envUrl)) break;
    await sleep(DONE_POLL_MS);
  }
  process.stderr.write('done: the suite finished; shutting down\n');
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

async function main(): Promise<number> {
  const server = createApp();
  const envUrl = envBaseUrl();
  let port: number;
  try {
    // Port 0 in a trial: the kernel picks an ephemeral port. Locally the
    // dev port is used instead, so a runner can dial a fixed address.
    port = await listen(server, envUrl === null ? devPort() : 0);
  } catch (err) {
    process.stderr.write(`listen failed (${messageOf(err)})\n`);
    return 1;
  }
  process.stderr.write(`forge listening on port ${port}\n`);
  if (envUrl === null) {
    // Local development: no trial environment, so serve until stopped.
    // A listener error after startup ends the process instead of leaving
    // it hung on a promise that can never settle.
    return await new Promise<number>((resolve) => {
      server.once('close', () => resolve(0));
      server.once('error', (err: Error) => {
        process.stderr.write(`server error (${messageOf(err)})\n`);
        resolve(1);
      });
      process.once('SIGINT', () => server.close());
      process.once('SIGTERM', () => server.close());
    });
  }
  try {
    await register(envUrl, port);
  } catch (err) {
    process.stderr.write(`register failed (${messageOf(err)})\n`);
    server.close();
    return 1;
  }
  process.stderr.write(`registered port ${port} with ${envUrl}\n`);
  await waitForDone(envUrl, server);
  return 0;
}

const code = await main();
process.exit(code);
