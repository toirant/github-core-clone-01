// app.ts: the HTTP server. Routes /healthz, git smart HTTP, REST v3, GraphQL v4
// and MCP, all from the one in-memory Forge. Node stdlib only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './src/store.ts';
import { routeRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import {
  GitHttpError,
  advertisementV0,
  advertisementV2,
  applyReceivePack,
  computeFetch,
  fetchResponseV0,
  fetchResponseV2,
  lsRefsV2,
  parseV2Request,
  pushReportSideband,
} from './src/git-http.ts';
import { decodePktLines } from './src/git-core.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 100 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1]! : null;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createForge(): Forge {
  return new Forge({
    shopToken: process.env.MAKEFUN_SHOP_TOKEN ?? null,
    trialNow: process.env.MAKEFUN_TRIAL_NOW ?? null,
  });
}

export function createApp(forge: Forge = createForge()): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(forge, req, res).catch((err: unknown) => {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' }, {
          'x-github-request-id': nextRequestId(),
        });
      } catch {
        // The peer went away; nothing to write to.
      }
    });
  });
}

async function handleRequest(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const { pathname, query } = pathOf(req);
  const segments = pathname.split('/').filter((segment) => segment !== '').map(decodeSegment);

  // The env's boot probe: no auth.
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Auth: every API and git call presents the shop token; no token is 401.
  const needsAuth =
    pathname.startsWith('/api/v3') ||
    pathname.startsWith('/api/graphql') ||
    pathname === '/mcp' ||
    (segments.length >= 2 && segments[1]!.endsWith('.git'));
  if (needsAuth && !forge.tokenOk(bearerToken(req))) {
    if (pathname === '/mcp') {
      res.writeHead(401, { 'content-type': JSON_TYPE });
      res.end(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } })}\n`);
      return;
    }
    sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': nextRequestId() });
    return;
  }

  const requestId = nextRequestId();
  const apiHeaders = { 'x-github-request-id': requestId };

  // ---- REST v3 ----
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const restSegments = pathname === '/api/v3' ? [] : segments.slice(2);
    let body: unknown;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' }, apiHeaders);
          return;
        }
      }
    }
    const host = req.headers.host ?? 'localhost';
    const result = routeRest(forge, {
      method,
      segments: restSegments,
      query,
      body,
      baseUrl: `http://${host}`,
      path: pathname,
    });
    if (result.status === 204) {
      res.writeHead(204, apiHeaders);
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, { ...apiHeaders, ...(result.headers ?? {}) });
    return;
  }

  // ---- GraphQL v4 ----
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' }, apiHeaders);
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }, apiHeaders);
      return;
    }
    const { status, payload } = handleGraphQL(forge, body);
    sendJson(res, status, payload, apiHeaders);
    return;
  }

  // ---- MCP ----
  if (pathname === '/mcp') {
    if (method === 'DELETE') {
      res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': 2 });
      res.end('{}\n');
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' }, apiHeaders);
      return;
    }
    const raw = await readBody(req);
    const { status, payload } = handleMcp(forge, raw.toString('utf8'));
    if (status === 202 || payload === null) {
      res.writeHead(202, { 'content-length': 0 });
      res.end();
      return;
    }
    sendJson(res, status, payload);
    return;
  }

  // ---- git smart HTTP ----
  if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
    const owner = segments[0]!;
    const repoName = segments[1]!.slice(0, -'.git'.length);
    const servicePath = segments[2] ?? '';
    const repo = forge.getRepo(owner, repoName);
    try {
      if (method === 'GET' && servicePath === 'info' && segments[3] === 'refs') {
        const service = query.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(res, 400, { message: 'a service parameter is required' }, apiHeaders);
          return;
        }
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' }, apiHeaders);
          return;
        }
        if (service === 'git-receive-pack') {
          sendBuffer(res, 200, advertisementV0(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
          return;
        }
        const protocol = req.headers['git-protocol'];
        if (protocol === 'version=2') {
          sendBuffer(res, 200, advertisementV2(), 'application/x-git-upload-pack-advertisement');
        } else {
          sendBuffer(res, 200, advertisementV0(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
        }
        return;
      }
      if (method === 'POST' && servicePath === 'git-upload-pack') {
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' }, apiHeaders);
          return;
        }
        const body = await readBody(req);
        const protocol = req.headers['git-protocol'];
        if (protocol === 'version=2') {
          const { command, args } = parseV2Request(body);
          if (command === 'ls-refs') {
            const prefixes = args
              .filter((arg) => arg.startsWith('ref-prefix '))
              .map((arg) => arg.slice('ref-prefix '.length));
            const bodyOut = lsRefsV2(repo, prefixes, args.includes('peel'), args.includes('symrefs'));
            sendBuffer(res, 200, bodyOut, 'application/x-git-upload-pack-result');
            return;
          }
          if (command === 'fetch') {
            const wants: string[] = [];
            const haves: string[] = [];
            const shallow: string[] = [];
            let deepen: number | null = null;
            for (const arg of args) {
              if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
              else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
              else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
              else if (arg.startsWith('deepen ')) deepen = Number.parseInt(arg.slice(7).trim(), 10);
            }
            if (wants.length === 0) {
              sendJson(res, 400, { message: 'a fetch needs at least one want' }, apiHeaders);
              return;
            }
            const result = computeFetch(repo, { wants, haves, shallow, deepen });
            sendBuffer(res, 200, fetchResponseV2(result), 'application/x-git-upload-pack-result');
            return;
          }
          sendJson(res, 400, { message: `unknown v2 command ${command}` }, apiHeaders);
          return;
        }
        // Protocol v0 fetch.
        const wants: string[] = [];
        const haves: string[] = [];
        const shallow: string[] = [];
        let deepen: number | null = null;
        try {
          for (const packet of decodePktLines(body)) {
            if (packet.kind !== 'data') continue;
            const line = packet.payload.toString('utf8').replace(/\n$/, '');
            if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
            else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
            else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
            else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7).trim(), 10);
          }
        } catch (err) {
          throw new GitHttpError(400, `malformed pkt-line stream: ${(err as Error).message}`);
        }
        if (wants.length === 0) {
          sendJson(res, 400, { message: 'a fetch needs at least one want' }, apiHeaders);
          return;
        }
        const result = computeFetch(repo, { wants, haves, shallow, deepen });
        sendBuffer(res, 200, fetchResponseV0(result), 'application/x-git-upload-pack-result');
        return;
      }
      if (method === 'POST' && servicePath === 'git-receive-pack') {
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' }, apiHeaders);
          return;
        }
        const body = await readBody(req);
        const outcome = applyReceivePack(repo, body);
        sendBuffer(res, 200, pushReportSideband(outcome), 'application/x-git-receive-pack-result');
        return;
      }
    } catch (err) {
      if (err instanceof GitHttpError) {
        sendJson(res, err.status, { message: err.message }, apiHeaders);
        return;
      }
      throw err;
    }
    sendJson(res, 404, { message: 'Not Found' }, apiHeaders);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' }, apiHeaders);
}
