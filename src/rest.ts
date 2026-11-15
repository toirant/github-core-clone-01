// rest.ts: the REST v3 surface under /api/v3. Every reply is JSON with a
// non-empty X-GitHub-Request-Id; errors carry {"message": string}.
// Routing is by method + path segments; the app layer enforces the bearer token
// and parses the JSON body (malformed JSON -> 400) before calling routeRest.

import {
  Forge,
  commentJson,
  commitJson,
  issueJson,
  pullJson,
  refJson,
  repoJson,
  type Repo,
} from './store.ts';
import { parseCommit } from './git-core.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function notFound(): RestResult {
  return err(404, 'Not Found');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseIntParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Paginate a list: slice + a GitHub-style Link header (absolute URLs, same origin). */
function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  baseUrl: string,
  path: string,
): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, parseIntParam(query.get('per_page'), 30)));
  const page = Math.max(1, parseIntParam(query.get('page'), 1));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `${baseUrl}${path}?${params.toString()}`;
  };
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  if (totalPages > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  return { page: [...slice], link: links.length > 0 ? links.join(', ') : null };
}

function linkHeaders(link: string | null): Record<string, string> {
  return link === null ? {} : { link };
}

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  baseUrl: string;
  path: string;
}

export function routeRest(forge: Forge, req: RestRequest): RestResult {
  const { method, segments } = req;
  const [first, ...rest] = segments;

  if (first === undefined || first === '') {
    if (method === 'GET') {
      return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, {
        'x-oauth-scopes': 'repo, read:org',
      });
    }
    return notFound();
  }

  if (first === 'meta') {
    if (method === 'GET') return ok(200, { installed_version: '1.0.0' });
    return notFound();
  }

  if (first === 'user') {
    if (rest.length === 0) {
      if (method === 'GET') {
        return ok(200, {
          login: forge.viewerLogin,
          id: forge.viewerId,
          type: 'User',
          name: forge.viewerLogin,
          email: `${forge.viewerLogin}@example.invalid`,
        });
      }
      return notFound();
    }
    if (rest[0] === 'repos') {
      if (method === 'POST') {
        if (!isObject(req.body)) return err(400, 'a JSON object body is required');
        const name = asString(req.body.name);
        if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'name is invalid');
        const created = forge.createRepo(name, {
          description: asString(req.body.description) ?? '',
          private: req.body.private === true,
        });
        if (created.error) return err(422, created.error);
        return ok(201, repoJson(created.repo!));
      }
      if (method === 'GET') {
        const repos = forge.listRepos();
        const { page, link } = paginate(repos, req.query, req.baseUrl, req.path);
        return ok(200, page.map((repo) => repoJson(repo)), linkHeaders(link));
      }
      return notFound();
    }
    return notFound();
  }

  if (first === 'users') {
    if (method === 'GET' && rest.length === 1) {
      if (rest[0] === forge.viewerLogin) {
        return ok(200, { login: forge.viewerLogin, id: forge.viewerId, type: 'User' });
      }
      return notFound();
    }
    return notFound();
  }

  if (first === 'repos') {
    const [owner, name, ...tail] = rest;
    if (owner === undefined || name === undefined) return notFound();
    const repo = forge.getRepo(owner, name);
    if (tail.length === 0) {
      if (method === 'GET') {
        if (!repo) return notFound();
        return ok(200, repoJson(repo));
      }
      if (method === 'PATCH') {
        if (!repo) return notFound();
        if (!isObject(req.body)) return err(400, 'a JSON object body is required');
        const description = asString(req.body.description);
        if (description !== undefined) repo.description = description;
        repo.updatedAt = forge.nowIso();
        return ok(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        if (!repo) return notFound();
        forge.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return notFound();
    }
    if (!repo) return notFound();
    return routeRepoResource(forge, repo, tail, req);
  }

  return notFound();
}

function routeRepoResource(forge: Forge, repo: Repo, tail: string[], req: RestRequest): RestResult {
  const { method } = req;
  const [resource, ...rest] = tail;

  if (resource === 'branches') {
    if (rest.length === 0) {
      if (method !== 'GET') return notFound();
      const branches = [...repo.refs.keys()]
        .filter((name) => name.startsWith('refs/heads/'))
        .sort()
        .map((name) => ({
          name: name.slice('refs/heads/'.length),
          commit: { sha: repo.refs.get(name)! },
        }));
      return ok(200, branches);
    }
    if (rest.length === 1 && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${rest[0]}`);
      if (sha === undefined) return notFound();
      return ok(200, { name: rest[0], commit: { sha } });
    }
    return notFound();
  }

  if (resource === 'commits') {
    if (method !== 'GET' || rest.length > 0) return notFound();
    const ref = req.query.get('sha') ?? repo.defaultBranch;
    const commits = forge.commitsOnRef(repo, ref);
    const { page, link } = paginate(commits, req.query, req.baseUrl, req.path);
    return ok(
      200,
      page.map(({ sha, commit }) => commitJson(sha, commit)),
      linkHeaders(link),
    );
  }

  if (resource === 'git') {
    if (rest[0] === 'refs') {
      const refPath = rest.slice(1).join('/');
      if (method === 'POST' && refPath === '') {
        if (!isObject(req.body)) return err(400, 'a JSON object body is required');
        const ref = asString(req.body.ref);
        const sha = asString(req.body.sha);
        if (!ref || !ref.startsWith('refs/') || !sha || !/^[0-9a-f]{40}$/.test(sha)) {
          return err(422, 'ref and sha are required');
        }
        if (!repo.objects.has(sha)) return err(422, 'the sha is not in the repository');
        if (repo.refs.has(ref)) return err(422, 'the ref already exists');
        repo.refs.set(ref, sha);
        return ok(201, refJson(ref, sha));
      }
      if (method === 'GET' && refPath !== '') {
        const sha = repo.refs.get(refPath);
        if (sha === undefined) return notFound();
        return ok(200, refJson(refPath, sha));
      }
      return notFound();
    }
    return notFound();
  }

  if (resource === 'labels') {
    if (method === 'GET' && rest.length === 0) {
      return ok(200, [...repo.labels.values()]);
    }
    if (method === 'POST' && rest.length === 0) {
      if (!isObject(req.body)) return err(400, 'a JSON object body is required');
      const name = asString(req.body.name);
      if (!name) return err(422, 'name is required');
      const created = forge.createLabel(repo, name, asString(req.body.color) ?? '000000');
      if (created.error) return err(422, created.error);
      return ok(201, created.label!);
    }
    return notFound();
  }

  if (resource === 'contents') {
    const path = rest.join('/');
    if (method === 'PUT') {
      if (!isObject(req.body)) return err(400, 'a JSON object body is required');
      const message = asString(req.body.message);
      const content = asString(req.body.content);
      if (!message || content === undefined) return err(422, 'message and content are required');
      const result = forge.putContents(repo, path, {
        message,
        content,
        sha: asString(req.body.sha),
        branch: asString(req.body.branch),
      });
      if (result.error) return err(result.status, result.error);
      return ok(result.status, { content: result.content, commit: result.commit });
    }
    if (method === 'GET') {
      const result = forge.getContents(repo, path, req.query.get('ref') ?? undefined);
      if (result.error) return err(result.status, result.error);
      return ok(200, result.body);
    }
    if (method === 'DELETE') {
      if (!isObject(req.body)) return err(400, 'a JSON object body is required');
      const message = asString(req.body.message);
      if (!message) return err(422, 'message is required');
      const result = forge.deleteContents(repo, path, {
        message,
        sha: asString(req.body.sha),
        branch: asString(req.body.branch),
      });
      if (result.error) return err(result.status, result.error);
      return ok(200, { commit: result.commit });
    }
    return notFound();
  }

  if (resource === 'issues') {
    if (rest.length === 0) {
      if (method === 'GET') {
        const issues = forge.listIssues(repo, {
          state: req.query.get('state') ?? undefined,
          sort: req.query.get('sort') ?? undefined,
          direction: req.query.get('direction') ?? undefined,
        });
        const { page, link } = paginate(issues, req.query, req.baseUrl, req.path);
        return ok(200, page.map((issue) => issueJson(repo, issue)), linkHeaders(link));
      }
      if (method === 'POST') {
        if (!isObject(req.body)) return err(400, 'a JSON object body is required');
        const title = asString(req.body.title);
        if (!title) return err(422, 'title is required');
        const labels = Array.isArray(req.body.labels)
          ? req.body.labels.filter((entry): entry is string => typeof entry === 'string')
          : [];
        const created = forge.createIssue(repo, { title, body: asString(req.body.body), labels });
        if (created.error) return err(422, created.error);
        return ok(201, issueJson(repo, created.issue!));
      }
      return notFound();
    }
    const number = Number.parseInt(rest[0]!, 10);
    if (!Number.isSafeInteger(number) || number <= 0) return notFound();
    if (rest.length === 1) {
      if (method === 'GET') {
        const issue = forge.getIssue(repo, number);
        if (!issue) return notFound();
        return ok(200, issueJson(repo, issue));
      }
      if (method === 'PATCH') {
        if (!isObject(req.body)) return err(400, 'a JSON object body is required');
        const patch: { state?: string; title?: string; body?: string; labels?: string[] } = {};
        if (req.body.state !== undefined) patch.state = asString(req.body.state);
        if (req.body.title !== undefined) patch.title = asString(req.body.title);
        if (req.body.body !== undefined) patch.body = asString(req.body.body);
        if (Array.isArray(req.body.labels)) {
          patch.labels = req.body.labels.filter((entry): entry is string => typeof entry === 'string');
        }
        const result = forge.patchIssue(repo, number, patch);
        if (result.error) return result.error === 'Not Found' ? notFound() : err(422, result.error);
        return ok(200, issueJson(repo, result.issue!));
      }
      return notFound();
    }
    if (rest[1] === 'comments') {
      if (method === 'GET') {
        const issue = forge.getIssue(repo, number);
        if (!issue) return notFound();
        return ok(200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
      }
      if (method === 'POST') {
        if (!isObject(req.body)) return err(400, 'a JSON object body is required');
        const body = asString(req.body.body);
        if (body === undefined) return err(422, 'body is required');
        const result = forge.addComment(repo, number, body);
        if (result.error) return result.error === 'Not Found' ? notFound() : err(422, result.error);
        const issue = forge.getIssue(repo, number)!;
        return ok(201, commentJson(repo, issue, result.comment!));
      }
      return notFound();
    }
    return notFound();
  }

  if (resource === 'pulls') {
    if (rest.length === 0) {
      if (method === 'GET') {
        const pulls = forge.listPulls(repo, req.query.get('state') ?? undefined);
        const { page, link } = paginate(pulls, req.query, req.baseUrl, req.path);
        return ok(200, page.map((pull) => pullJson(repo, pull)), linkHeaders(link));
      }
      if (method === 'POST') {
        if (!isObject(req.body)) return err(400, 'a JSON object body is required');
        const title = asString(req.body.title);
        const head = asString(req.body.head);
        const base = asString(req.body.base);
        if (!title || !head || !base) return err(422, 'title, head and base are required');
        const created = forge.createPull(repo, { title, body: asString(req.body.body), head, base });
        if (created.error) return err(422, created.error);
        return ok(201, pullJson(repo, created.pull!));
      }
      return notFound();
    }
    const number = Number.parseInt(rest[0]!, 10);
    if (!Number.isSafeInteger(number) || number <= 0) return notFound();
    if (rest.length === 1) {
      if (method === 'GET') {
        const pull = forge.getPull(repo, number);
        if (!pull) return notFound();
        return ok(200, pullJson(repo, pull));
      }
      return notFound();
    }
    if (rest[1] === 'files' && method === 'GET') {
      const pull = forge.getPull(repo, number);
      if (!pull) return notFound();
      return ok(200, forge.pullFiles(repo, pull));
    }
    if (rest[1] === 'merge' && method === 'PUT') {
      const result = forge.mergePull(repo, number);
      if (result.error) return err(result.status ?? 422, result.error);
      return ok(200, {
        sha: result.sha,
        merged: true,
        message: `Merge pull request #${number} from ${result.pull!.headRef}`,
      });
    }
    return notFound();
  }

  return notFound();
}

export { parseCommit };
