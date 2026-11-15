// store.ts: the forge's in-memory data model and every operation the surfaces share.
// One Forge holds all repositories; everything is deterministic: server-created
// timestamps come from a logical clock seeded by MAKEFUN_TRIAL_NOW (or the scenario
// epoch when unset), +1s per mutation, so a replay produces identical objects.

import {
  EMPTY_TREE_OID,
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  firstParentChain,
  flattenTree,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  type GitObject,
  type GitObjectType,
} from './git-core.ts';
import { SCENARIO_EPOCH_SEC, VIEWER_ID, VIEWER_LOGIN } from './scenario.ts';

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
}

export const FORGE_AUTHOR = 'Forge <forge@localhost>';
export const DEFAULT_BRANCH = 'main';

function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace('.000Z', 'Z');
}

/** A line-based diff: {additions, deletions} via longest common subsequence. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // A trailing newline makes the last split element ''; drop it on both sides.
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  if (oldLines.length > 2000 || newLines.length > 2000) {
    return oldText === newText ? { additions: 0, deletions: 0 } : { additions: newLines.length, deletions: oldLines.length };
  }
  const n = oldLines.length;
  const m = newLines.length;
  // LCS lengths, one row at a time (keep the full table small: use two rows).
  const prev = new Array<number>(m + 1).fill(0);
  const curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]!);
    }
    for (let j = 0; j <= m; j += 1) prev[j] = curr[j]!;
  }
  const lcs = prev[m]!;
  return { additions: m - lcs, deletions: n - lcs };
}

export class Forge {
  readonly viewerLogin: string;
  readonly viewerId: number;
  /** The shop token when the environment provides one; null means dev mode (any token). */
  readonly shopToken: string | null;
  #clockSec: number;
  #repoSeq = 0;
  #issueSeq = 0;
  #commentSeq = 0;
  #pullSeq = 0;
  #createdSeq = 0;
  readonly repos = new Map<string, Repo>();

  constructor(options: { shopToken?: string | null; trialNow?: string | null } = {}) {
    this.viewerLogin = VIEWER_LOGIN;
    this.viewerId = VIEWER_ID;
    this.shopToken = options.shopToken ?? null;
    let start = SCENARIO_EPOCH_SEC;
    if (options.trialNow) {
      const parsed = Date.parse(options.trialNow);
      if (Number.isFinite(parsed)) start = Math.floor(parsed / 1000);
    }
    this.#clockSec = start;
  }

  /** The next logical second, as an epoch; every mutation advances the clock by 1s. */
  nextTime(): number {
    const now = this.#clockSec;
    this.#clockSec += 1;
    return now;
  }

  nowIso(): string {
    return isoOf(this.#clockSec);
  }

  // ------------------------------------------------------------------ auth

  /** True when the bearer token is the shop token (or any non-empty token in dev mode). */
  tokenOk(token: string | null): boolean {
    if (token === null || token === '') return false;
    if (this.shopToken === null) return true;
    return token === this.shopToken;
  }

  // ------------------------------------------------------------------ repos

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== this.viewerLogin) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, options: { description?: string; private?: boolean } = {}): { repo?: Repo; error?: string } {
    if (this.repos.has(this.repoKey(this.viewerLogin, name))) {
      return { error: 'name already exists on this account' };
    }
    const createdAt = isoOf(this.nextTime());
    const repo: Repo = {
      id: ++this.#repoSeq,
      name,
      owner: this.viewerLogin,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      createdSeq: ++this.#createdSeq,
      createdAt,
      updatedAt: createdAt,
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
    };
    // GitHub seeds every repository with these labels.
    for (const [label, color] of [
      ['bug', 'd73a4a'],
      ['documentation', '0075ca'],
      ['duplicate', 'cfd3d7'],
      ['enhancement', 'a2eeef'],
      ['good first issue', '7057ff'],
      ['help wanted', '008672'],
      ['invalid', 'e4e669'],
      ['question', 'd876e3'],
      ['wontfix', 'ffffff'],
    ] as const) {
      repo.labels.set(label, { name: label, color });
    }
    this.repos.set(this.repoKey(this.viewerLogin, name), repo);
    return { repo };
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.viewerLogin) return false;
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ------------------------------------------------------------------ git objects

  lookup(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** The oid a ref name, branch name or sha resolves to, or undefined. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const full = `refs/heads/${ref}`;
    if (repo.refs.has(full)) return repo.refs.get(full);
    const tag = `refs/tags/${ref}`;
    if (repo.refs.has(tag)) return repo.refs.get(tag);
    if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
    return undefined;
  }

  /** The tip of the default branch, or undefined when the repo is unborn. */
  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  createCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const timestamp = this.nextTime();
    const data = buildCommit({
      tree,
      parents,
      message,
      author: FORGE_AUTHOR,
      committer: FORGE_AUTHOR,
      timestamp,
    });
    return this.putObject(repo, 'commit', data);
  }

  // ------------------------------------------------------------------ trees

  /** Set (blobOid) or delete (null) `segments` in the tree at `treeOid` (null = empty). */
  setPathInTree(repo: Repo, treeOid: string | null, segments: string[], blobOid: string | null): string {
    if (segments.length === 0) return treeOid ?? EMPTY_TREE_OID;
    const head = segments[0]!;
    const rest = segments.slice(1);
    const entries = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
    const kept = entries.filter((entry) => entry.name !== head);
    if (rest.length === 0) {
      if (blobOid !== null) kept.push({ mode: '100644', name: head, oid: blobOid });
    } else {
      const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
      const childOid = this.setPathInTree(repo, existing?.oid ?? null, rest, blobOid);
      const child = repo.objects.get(childOid);
      const childEntries = child ? parseTree(child.data) : [];
      if (childEntries.length > 0) kept.push({ mode: '40000', name: head, oid: childOid });
    }
    const data = buildTree(kept);
    return this.putObject(repo, 'tree', data);
  }

  /** The object at `segments` in the tree at `treeOid`, or undefined. */
  getPathInTree(repo: Repo, treeOid: string, segments: string[]): { mode: string; oid: string } | undefined {
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const tree = repo.objects.get(current);
      if (!tree || tree.type !== 'tree') return undefined;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
      if (!entry) return undefined;
      if (i === segments.length - 1) return { mode: entry.mode, oid: entry.oid };
      if (entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    return undefined;
  }

  /** Flat path -> blob oid map for a commit's tree. */
  treePaths(repo: Repo, commitOid: string): Map<string, string> {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return new Map();
    const tree = parseCommit(commit.data).tree;
    return flattenTree((oid) => repo.objects.get(oid), tree);
  }

  // ------------------------------------------------------------------ contents

  /** Commit `path`'s new content on `branch` (creating the branch from the default tip when needed). */
  putContents(
    repo: Repo,
    path: string,
    body: { message: string; content: string; sha?: string; branch?: string },
  ): { status: number; content?: Record<string, unknown>; commit?: { sha: string; message: string }; error?: string } {
    const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
    if (segments.length === 0) return { status: 422, error: 'a file path is required' };
    let branch = body.branch ?? repo.defaultBranch;
    let tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined && branch !== repo.defaultBranch) {
      // GitHub creates the branch from the default branch when a contents write names it.
      const base = this.defaultTip(repo);
      if (base !== undefined) {
        repo.refs.set(`refs/heads/${branch}`, base);
        tip = base;
      }
    }
    const blob = Buffer.from(body.content, 'base64');
    const blobOid = this.putObject(repo, 'blob', blob);
    let existed = false;
    let currentTree: string | null = null;
    if (tip !== undefined) {
      const commit = repo.objects.get(tip);
      if (commit && commit.type === 'commit') currentTree = parseCommit(commit.data).tree;
      const current = currentTree === null ? undefined : this.getPathInTree(repo, currentTree, segments);
      if (current !== undefined) {
        existed = true;
        if (body.sha !== undefined && body.sha !== current.oid) {
          return { status: 409, error: 'the file sha does not match the current blob' };
        }
      } else if (body.sha !== undefined) {
        return { status: 422, error: 'a sha was given but the file does not exist' };
      }
    } else if (body.sha !== undefined) {
      return { status: 422, error: 'a sha was given but the file does not exist' };
    }
    const newTree = this.setPathInTree(repo, currentTree, segments, blobOid);
    const commitSha = this.createCommit(repo, newTree, tip === undefined ? [] : [tip], body.message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    const content = {
      type: 'file',
      encoding: 'base64',
      size: blob.length,
      name: segments[segments.length - 1]!,
      path: segments.join('/'),
      content: blob.toString('base64'),
      sha: blobOid,
    };
    return { status: existed ? 200 : 201, content, commit: { sha: commitSha, message: body.message } };
  }

  getContents(
    repo: Repo,
    path: string,
    ref?: string,
  ): { status: number; body?: unknown; error?: string } {
    const tip = ref === undefined ? this.defaultTip(repo) : this.resolveRef(repo, ref);
    if (tip === undefined) return { status: 404, error: 'Not Found' };
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return { status: 404, error: 'Not Found' };
    const treeOid = parseCommit(commit.data).tree;
    const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
    if (segments.length === 0) {
      return { status: 200, body: this.listTree(repo, treeOid, '') };
    }
    const found = this.getPathInTree(repo, treeOid, segments);
    if (!found) return { status: 404, error: 'Not Found' };
    if (found.mode === '40000') {
      return { status: 200, body: this.listTree(repo, found.oid, segments.join('/')) };
    }
    const blob = repo.objects.get(found.oid);
    if (!blob) return { status: 404, error: 'Not Found' };
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: segments[segments.length - 1]!,
        path: segments.join('/'),
        content: blob.data.toString('base64'),
        sha: found.oid,
      },
    };
  }

  listTree(repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return [];
    return parseTree(tree.data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
    }));
  }

  deleteContents(
    repo: Repo,
    path: string,
    body: { message: string; sha?: string; branch?: string },
  ): { status: number; commit?: { sha: string; message: string }; error?: string } {
    const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
    if (segments.length === 0) return { status: 422, error: 'a file path is required' };
    const branch = body.branch ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return { status: 404, error: 'Not Found' };
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') return { status: 404, error: 'Not Found' };
    const treeOid = parseCommit(commit.data).tree;
    const current = this.getPathInTree(repo, treeOid, segments);
    if (!current || current.mode === '40000') return { status: 404, error: 'Not Found' };
    if (body.sha !== undefined && body.sha !== current.oid) {
      return { status: 409, error: 'the file sha does not match the current blob' };
    }
    const newTree = this.setPathInTree(repo, treeOid, segments, null);
    const commitSha = this.createCommit(repo, newTree, [tip], body.message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { status: 200, commit: { sha: commitSha, message: body.message } };
  }

  // ------------------------------------------------------------------ labels

  createLabel(repo: Repo, name: string, color: string): { label?: Label; error?: string } {
    const existing = repo.labels.get(name);
    if (existing) return { label: existing };
    const label = { name, color };
    repo.labels.set(name, label);
    return { label };
  }

  // ------------------------------------------------------------------ issues

  createIssue(
    repo: Repo,
    input: { title: string; body?: string; labels?: string[] },
  ): { issue?: Issue; error?: string } {
    if (!input.title || input.title.trim() === '') return { error: 'title is required' };
    const labels = input.labels ?? [];
    for (const name of labels) {
      if (!repo.labels.has(name)) return { error: `label ${name} does not exist` };
    }
    const createdAt = isoOf(this.nextTime());
    const issue: Issue = {
      id: ++this.#issueSeq,
      number: repo.nextIssueNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: ++this.#createdSeq,
      createdAt,
      updatedAt: createdAt,
    };
    repo.issues.push(issue);
    return { issue };
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(
    repo: Repo,
    options: { state?: string; sort?: string; direction?: string },
  ): Issue[] {
    const state = options.state ?? 'open';
    let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    const direction = options.direction ?? 'desc';
    list = [...list].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    return list;
  }

  patchIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string; labels?: string[] }): { issue?: Issue; error?: string } {
    const issue = this.getIssue(repo, number);
    if (!issue) return { error: 'Not Found' };
    if (patch.state !== undefined) {
      if (patch.state !== 'open' && patch.state !== 'closed') return { error: 'state must be open or closed' };
      issue.state = patch.state;
    }
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.labels !== undefined) {
      for (const name of patch.labels) {
        if (!repo.labels.has(name)) return { error: `label ${name} does not exist` };
      }
      issue.labels = [...patch.labels];
    }
    issue.updatedAt = isoOf(this.nextTime());
    return { issue };
  }

  addComment(repo: Repo, number: number, body: string): { comment?: IssueComment; error?: string } {
    const issue = this.getIssue(repo, number);
    if (!issue) return { error: 'Not Found' };
    if (!body || body.trim() === '') return { error: 'body is required' };
    const comment: IssueComment = { id: ++this.#commentSeq, body, createdAt: isoOf(this.nextTime()) };
    issue.comments.push(comment);
    return { comment };
  }

  // ------------------------------------------------------------------ pull requests

  createPull(
    repo: Repo,
    input: { title: string; body?: string; head: string; base: string },
  ): { pull?: Pull; error?: string } {
    if (!input.title || input.title.trim() === '') return { error: 'title is required' };
    const headSha = repo.refs.get(`refs/heads/${input.head}`);
    if (headSha === undefined) return { error: `head branch ${input.head} does not exist` };
    const baseSha = repo.refs.get(`refs/heads/${input.base}`);
    if (baseSha === undefined) return { error: `base branch ${input.base} does not exist` };
    const createdAt = isoOf(this.nextTime());
    const pull: Pull = {
      id: ++this.#pullSeq,
      number: repo.nextPullNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      baseRef: input.base,
      headSha,
      baseSha,
      createdSeq: ++this.#createdSeq,
      createdAt,
      updatedAt: createdAt,
    };
    repo.pulls.push(pull);
    return { pull };
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  listPulls(repo: Repo, state?: string): Pull[] {
    const wanted = state ?? 'open';
    return repo.pulls
      .filter((pull) => wanted === 'all' || pull.state === wanted)
      .sort((a, b) => b.createdSeq - a.createdSeq);
  }

  /** MERGEABLE / CONFLICTING / UNKNOWN for a pull request's head against its base. */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const head = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const base = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    if (head === undefined || base === undefined) return 'UNKNOWN';
    if (pull.merged) return 'MERGEABLE';
    return this.mergeConflict(repo, head, base) === null ? 'MERGEABLE' : 'CONFLICTING';
  }

  /**
   * The first path both sides changed differently from the merge-base, or null.
   * Returns 'no-base' when the histories share no ancestor.
   */
  mergeConflict(repo: Repo, headSha: string, baseSha: string): string | 'no-base' | null {
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    const base = mergeBase(lookup, headSha, baseSha);
    if (base === null) return 'no-base';
    const basePaths = this.treePaths(repo, base);
    const headPaths = this.treePaths(repo, headSha);
    const basePathsNow = this.treePaths(repo, baseSha);
    const all = new Set([...basePaths.keys(), ...headPaths.keys(), ...basePathsNow.keys()]);
    for (const path of all) {
      const fromBase = basePaths.get(path);
      const inHead = headPaths.get(path);
      const inBase = basePathsNow.get(path);
      const headChanged = inHead !== fromBase;
      const baseChanged = inBase !== fromBase;
      if (headChanged && baseChanged && inHead !== inBase) return path;
    }
    return null;
  }

  /** Squash-merge a pull request onto its base branch. */
  mergePull(repo: Repo, number: number): { pull?: Pull; sha?: string; error?: string; status?: number } {
    const pull = this.getPull(repo, number);
    if (!pull) return { error: 'Not Found', status: 404 };
    if (pull.merged || pull.state === 'closed') return { error: 'pull request is already closed', status: 405 };
    const head = repo.refs.get(`refs/heads/${pull.headRef}`);
    const base = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (head === undefined || base === undefined) return { error: 'the pull request head or base no longer exists', status: 405 };
    const conflict = this.mergeConflict(repo, head, base);
    if (conflict !== null) {
      return {
        error: conflict === 'no-base' ? 'no common ancestor for a merge' : `merge conflict on ${conflict}`,
        status: 405,
      };
    }
    const headCommit = repo.objects.get(head);
    if (!headCommit || headCommit.type !== 'commit') return { error: 'the head is not a commit', status: 405 };
    const headTree = parseCommit(headCommit.data).tree;
    const mergeSha = this.createCommit(repo, headTree, [base], pull.title);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = isoOf(this.nextTime());
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = pull.mergedAt;
    return { pull, sha: mergeSha };
  }

  /** The file diff of a pull request: base tip tree vs head tip tree. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const basePaths = this.treePaths(repo, pull.baseSha);
    const headPaths = this.treePaths(repo, pull.headSha);
    const all = new Set([...basePaths.keys(), ...headPaths.keys()]);
    const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...all].sort()) {
      const inBase = basePaths.get(path);
      const inHead = headPaths.get(path);
      if (inBase === inHead) continue;
      if (inBase === undefined) {
        const blob = repo.objects.get(inHead!)?.data.toString('utf8') ?? '';
        const lines = blob === '' ? 0 : blob.split('\n').length - (blob.endsWith('\n') ? 1 : 0);
        files.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (inHead === undefined) {
        const blob = repo.objects.get(inBase)?.data.toString('utf8') ?? '';
        const lines = blob === '' ? 0 : blob.split('\n').length - (blob.endsWith('\n') ? 1 : 0);
        files.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else {
        const oldText = repo.objects.get(inBase)?.data.toString('utf8') ?? '';
        const newText = repo.objects.get(inHead)?.data.toString('utf8') ?? '';
        const { additions, deletions } = lineDiff(oldText, newText);
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  /** Commits on a ref's first-parent chain, newest first. */
  commitsOnRef(repo: Repo, ref: string): Array<{ sha: string; commit: ParsedCommit }> {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return [];
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    return firstParentChain(lookup, tip).map((sha) => {
      const object = repo.objects.get(sha)!;
      return { sha, commit: parseCommit(object.data) };
    });
  }

  /** Objects reachable from `tips` minus objects reachable from `excludeTips`. */
  reachableMinus(repo: Repo, tips: string[], excludeTips: string[]): Map<string, GitObject> {
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    const exclude = new Set<string>();
    if (excludeTips.length > 0) {
      const excluded = collectReachable(lookup, excludeTips);
      for (const oid of excluded.objects.keys()) exclude.add(oid);
    }
    return collectReachable(lookup, tips, { exclude }).objects;
  }
}

// ---------------------------------------------------------------------------
// REST serialization
// ---------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000' };
    }),
    user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
      repo: repoJson(repo),
    },
    user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function commitJson(sha: string, commit: ReturnType<typeof parseCommit>): Record<string, unknown> {
  return {
    sha,
    commit: {
      message: commit.message,
      author: { name: commit.author, date: isoOf(commit.authorTs) },
      committer: { name: commit.committer, date: isoOf(commit.committerTs) },
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

export function refJson(ref: string, sha: string): Record<string, unknown> {
  return { ref, object: { sha, type: 'commit' }, url: `/api/v3/git/refs/${ref}` };
}

export { ZERO_OID };
