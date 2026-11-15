// mcp.ts: the Model Context Protocol endpoint at /mcp (JSON-RPC 2.0, Streamable HTTP).
// Speaks the modern 2026-07-28 era (server/discover, no handshake) and the legacy
// handshake era (initialize + notifications/initialized) — the suite probes discover
// first and falls back. Tools act on the same Forge store as REST.

import { Forge, issueJson, pullJson, repoJson } from './store.ts';

export const MCP_SERVER_NAME = 'forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

const TOOL = (
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string; enum?: string[] }>,
  required: string[],
): McpToolDef => ({ name, description, inputSchema: { type: 'object', properties, required } });

/** The tool list: a module-level constant, so two tools/list answers are byte-identical. */
export const MCP_TOOLS: McpToolDef[] = [
  TOOL(
    'create_repo',
    'Create a repository owned by the authenticated user.',
    {
      owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    ['name'],
  ),
  TOOL(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
    },
    ['owner', 'repo'],
  ),
  TOOL(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    ['owner', 'repo', 'title'],
  ),
  TOOL(
    'list_issues',
    'List issues in a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      state: { type: 'string', description: 'Issue state filter.', enum: ['open', 'closed', 'all'] },
    },
    ['owner', 'repo'],
  ),
  TOOL(
    'create_pull_request',
    'Open a pull request from a head branch into a base branch.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  TOOL(
    'merge_pull_request',
    'Merge a pull request with a squash commit onto its base branch.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
  TOOL(
    'list_repos',
    'List repositories owned by the authenticated user.',
    {
      owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
    },
    [],
  ),
  TOOL(
    'get_issue',
    'Get one issue by number.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      issue_number: { type: 'integer', description: 'The issue number.' },
    },
    ['owner', 'repo', 'issue_number'],
  ),
];

function serverInfo(): { name: string; version: string } {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

function toolResult(data: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } | null {
  if (typeof args.owner === 'string' && typeof args.repo === 'string') {
    return { owner: args.owner, repo: args.repo };
  }
  if (typeof args.full_name === 'string') {
    const [owner, repo] = args.full_name.split('/', 2);
    if (owner && repo) return { owner, repo };
  }
  return null;
}

function missingArg(args: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = args[name];
    if (value === undefined || value === null || value === '') return name;
  }
  return null;
}

/** Run one tool call against the store. */
function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized === 'createrepo' || normalized === 'createrepository') {
    const missing = missingArg(args, ['name']);
    if (missing) return toolError(`Missing required argument: ${missing}`);
    const repoName = String(args.name);
    const created = forge.createRepo(repoName, {
      description: typeof args.description === 'string' ? args.description : '',
      private: args.private === true,
    });
    if (created.error || !created.repo) return toolError(created.error ?? 'the repository could not be created');
    return toolResult(repoJson(created.repo));
  }
  if (normalized === 'getrepo' || normalized === 'getrepository') {
    const target = splitFullName(args);
    if (!target) return toolError('Missing required argument: owner and repo (or full_name)');
    const repo = forge.getRepo(target.owner, target.repo);
    if (!repo) return toolError(`repository ${target.owner}/${target.repo} was not found`);
    return toolResult(repoJson(repo));
  }
  if (normalized === 'listrepos') {
    return toolResult(forge.listRepos().map((repo) => repoJson(repo)));
  }
  if (normalized === 'createissue') {
    const target = splitFullName(args);
    const missing = !target ? 'owner and repo (or full_name)' : missingArg(args, ['title']);
    if (missing) return toolError(`Missing required argument: ${missing}`);
    const repo = forge.getRepo(target!.owner, target!.repo);
    if (!repo) return toolError(`repository ${target!.owner}/${target!.repo} was not found`);
    const created = forge.createIssue(repo, {
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
    });
    if (created.error || !created.issue) return toolError(created.error ?? 'the issue could not be created');
    return toolResult(issueJson(repo, created.issue));
  }
  if (normalized === 'listissues') {
    const target = splitFullName(args);
    if (!target) return toolError('Missing required argument: owner and repo (or full_name)');
    const repo = forge.getRepo(target.owner, target.repo);
    if (!repo) return toolError(`repository ${target.owner}/${target.repo} was not found`);
    const state = typeof args.state === 'string' ? args.state : 'open';
    const issues = forge.listIssues(repo, { state });
    return toolResult(issues.map((issue) => issueJson(repo, issue)));
  }
  if (normalized === 'getissue') {
    const target = splitFullName(args);
    const missing = !target ? 'owner and repo (or full_name)' : missingArg(args, ['issue_number']);
    if (missing) return toolError(`Missing required argument: ${missing}`);
    const repo = forge.getRepo(target!.owner, target!.repo);
    if (!repo) return toolError(`repository ${target!.owner}/${target!.repo} was not found`);
    const number = Number(args.issue_number);
    const issue = forge.getIssue(repo, number);
    if (!issue) return toolError(`issue #${number} was not found`);
    return toolResult(issueJson(repo, issue));
  }
  if (normalized === 'createpullrequest' || normalized === 'createpr') {
    const target = splitFullName(args);
    const missing = !target ? 'owner and repo (or full_name)' : missingArg(args, ['title', 'head', 'base']);
    if (missing) return toolError(`Missing required argument: ${missing}`);
    const repo = forge.getRepo(target!.owner, target!.repo);
    if (!repo) return toolError(`repository ${target!.owner}/${target!.repo} was not found`);
    const created = forge.createPull(repo, {
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
      head: String(args.head),
      base: String(args.base),
    });
    if (created.error || !created.pull) return toolError(created.error ?? 'the pull request could not be created');
    return toolResult(pullJson(repo, created.pull));
  }
  if (normalized === 'mergepullrequest' || normalized === 'mergepr') {
    const target = splitFullName(args);
    const missing = !target ? 'owner and repo (or full_name)' : missingArg(args, ['pull_number']);
    if (missing) return toolError(`Missing required argument: ${missing}`);
    const repo = forge.getRepo(target!.owner, target!.repo);
    if (!repo) return toolError(`repository ${target!.owner}/${target!.repo} was not found`);
    const number = Number(args.pull_number);
    const merged = forge.mergePull(repo, number);
    if (merged.error || !merged.pull) return toolError(merged.error ?? 'the pull request could not be merged');
    return toolResult({
      sha: merged.sha,
      merged: true,
      number,
      state: 'closed',
      message: `Merge pull request #${number} from ${merged.pull.headRef}`,
    });
  }
  return toolError(`unknown tool ${name}`);
}

export interface McpResponse {
  status: number;
  payload: unknown;
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, payload: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

/**
 * Handle one POST /mcp body. `bodyText` is the raw request body; a body that is not
 * JSON answers HTTP 400 with JSON-RPC -32700.
 */
export function handleMcp(forge: Forge, bodyText: string): McpResponse {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    const idMatch = /"id"\s*:\s*(\d+|"[^"]*")/.exec(bodyText);
    let id: unknown = null;
    if (idMatch) {
      const raw = idMatch[1]!;
      id = raw.startsWith('"') ? raw.slice(1, -1) : Number(raw);
    }
    return rpcError(id, -32700, 'Parse error: the request body is not JSON', 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return rpcError(null, -32600, 'Invalid Request: a JSON-RPC object is required');
  }
  const record = body as Record<string, unknown>;
  const id = record.id ?? null;
  const method = record.method;
  if (typeof method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request: a method string is required');
  }
  // A notification (no id): answer 202 with no body.
  const isNotification = record.id === undefined;

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'discover',
      supportedVersions: [...MCP_REVISIONS],
      capabilities: { tools: {} },
      instructions: 'A GitHub-compatible git forge: create repositories, issues and pull requests.',
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    });
  }
  if (method === 'initialize') {
    const params = (record.params ?? {}) as Record<string, unknown>;
    const requested = params.protocolVersion;
    const protocolVersion =
      typeof requested === 'string' && MCP_REVISIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
    });
  }
  if (method.startsWith('notifications/')) {
    return { status: 202, payload: null };
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: MCP_TOOLS });
  }
  if (method === 'tools/call') {
    const params = (record.params ?? {}) as Record<string, unknown>;
    const name = params.name;
    if (typeof name !== 'string' || name === '') {
      return rpcError(id, -32602, 'Invalid params: tools/call needs a tool name');
    }
    const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
    if (!tool) {
      return rpcError(id, -32602, `Method not found: no tool named ${name}`);
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return rpcError(id, -32602, 'Invalid params: arguments must be an object');
    }
    return rpcResult(id, callTool(forge, name, args));
  }
  if (isNotification) return { status: 202, payload: null };
  return rpcError(id, -32601, `Method not found: ${method}`);
}
