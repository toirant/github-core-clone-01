// git-core.ts: the git object model, pkt-line codec and packfile read/write.
// Node stdlib only (node:crypto, node:zlib). No git binary, no network.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 id of `<type> <size>\0<data>`. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error(`pkt-line payload of ${body.length} bytes exceeds the 65520 limit`);
  const prefix = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, body]);
}

export type PktLineKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktLine {
  kind: PktLineKind;
  payload: Buffer;
}

/** Encode lines: a string becomes one pkt-line, 'flush'/'delim'/'response-end' the control packets. */
export function encodePktLines(lines: ReadonlyArray<string | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else if (line === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Incremental pkt-line decoder over streamed chunks. */
export class PktLineDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  #finished = false;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
  }

  /** The next complete packet, or null when more bytes are needed. Throws on a malformed line. */
  next(): PktLine | null {
    if (this.#buffer.length < 4) return null;
    const lengthText = this.#buffer.subarray(0, 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(lengthText)}`);
    }
    const length = parseInt(lengthText, 16);
    if (length === 0) {
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'flush', payload: Buffer.alloc(0) };
    }
    if (length === 1) {
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'delim', payload: Buffer.alloc(0) };
    }
    if (length === 2) {
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'response-end', payload: Buffer.alloc(0) };
    }
    if (length < 4 || length > 65520) throw new Error(`pkt-line length ${length} out of range`);
    if (this.#buffer.length < length) return null;
    const payload = this.#buffer.subarray(4, length);
    this.#buffer = this.#buffer.subarray(length);
    return { kind: 'data', payload: Buffer.from(payload) };
  }

  /** True when the stream ended cleanly on a packet boundary. */
  finish(): boolean {
    this.#finished = true;
    return this.#buffer.length === 0;
  }

  get bufferedBytes(): number {
    return this.#buffer.length;
  }

  get finished(): boolean {
    return this.#finished;
  }
}

/** Decode every pkt-line in a whole buffer; throws on a malformed line. */
export function decodePktLines(buffer: Buffer): PktLine[] {
  const decoder = new PktLineDecoder();
  decoder.push(buffer);
  const out: PktLine[] = [];
  for (;;) {
    const packet = decoder.next();
    if (packet === null) break;
    out.push(packet);
  }
  if (!decoder.finish()) throw new Error('trailing bytes after the last pkt-line');
  return out;
}

// ---------------------------------------------------------------------------
// packfile
// ---------------------------------------------------------------------------

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), in the caller's order. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** True when the pack's 20-byte trailer is the SHA-1 of everything before it. */
export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return actual === expected;
}

interface PackVarint {
  size: number;
  first: number;
  next: number;
}

function readPackVarint(buffer: Buffer, offset: number): PackVarint {
  if (offset >= buffer.length) throw new Error('pack entry header is truncated');
  let byte = buffer[offset]!;
  let size = byte & 0x0f;
  const first = byte;
  let next = offset + 1;
  let shift = 4;
  while (byte & 0x80) {
    if (next >= buffer.length) throw new Error('pack entry header varint is truncated');
    byte = buffer[next]!;
    next += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, first, next };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset]!;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream starting at `offset`; returns its bytes and the offset past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset]!;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset]! * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset]! * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
  checksumOk: boolean;
  declaredCount: number;
}

/**
 * Read a packfile (version 2), resolve every object including OFS_DELTA and REF_DELTA.
 * `resolveBase` supplies a base object a thin pack leaves out. Every object's SHA-1 is
 * recomputed and its declared size checked; a mismatch is an error.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computedTrailer;
  if (!checksumOk) throw new Error('pack trailer does not match its bytes');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount, checksumOk, declaredCount };
}

// ---------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries (already in git order). Results are cached
 * on the data buffer: object bytes are immutable once stored, and the same buffer
 * is re-read on every walk, so a WeakMap makes repeated parses free. */
const treeCache = new WeakMap<Buffer, TreeEntry[]>();

export function parseTree(data: Buffer): TreeEntry[] {
  const cached = treeCache.get(data);
  if (cached !== undefined) return cached;
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('tree entry has no oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  treeCache.set(data, entries);
  return entries;
}

/** Git's tree sort: entries compare by name, directories as if named `name/`. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  const key = (entry: TreeEntry): string => (entry.mode === '40000' ? `${entry.name}/` : entry.name);
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Serialize entries (sorted git-style) into a tree object. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** The empty tree's id. */
export const EMPTY_TREE_OID = hashObject('tree', Buffer.alloc(0));

// ---------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  authorTs: number;
  committerTs: number;
  message: string;
}

const commitCache = new WeakMap<Buffer, ParsedCommit>();

export function parseCommit(data: Buffer): ParsedCommit {
  const cached = commitCache.get(data);
  if (cached !== undefined) return cached;
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const commit: ParsedCommit = {
    tree: '',
    parents: [],
    author: '',
    committer: '',
    authorTs: 0,
    committerTs: 0,
    message,
  };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      commit.author = line.slice(7);
      const match = / (\d+) [+-]\d{4}$/.exec(commit.author);
      if (match) commit.authorTs = Number(match[1]);
    } else if (line.startsWith('committer ')) {
      commit.committer = line.slice(10);
      const match = / (\d+) [+-]\d{4}$/.exec(commit.committer);
      if (match) commit.committerTs = Number(match[1]);
    }
  }
  commitCache.set(data, commit);
  return commit;
}

export interface CommitInput {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}

export function buildCommit(input: CommitInput): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author} ${input.timestamp} +0000`);
  lines.push(`committer ${input.committer} ${input.timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const tag: ParsedTag = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) tag.object = line.slice(7).trim();
    else if (line.startsWith('type ')) tag.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tag.tagger = line.slice(7);
  }
  return tag;
}

export interface TagInput {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  timestamp: number;
  message: string;
}

export function buildTag(input: TagInput): Buffer {
  const lines = [
    `object ${input.object}`,
    `type ${input.type}`,
    `tag ${input.tag}`,
    `tagger ${input.tagger} ${input.timestamp} +0000`,
  ];
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Walk the object graph from `tips` and collect every reachable object.
 * `maxCommitDepth` limits how many commit generations are followed (1 = the tips only);
 * commits whose parents were cut off are reported as `shallowBoundaries`.
 * `exclude` oids are treated as already held: their closures are not walked and their
 * objects are not collected.
 */
export function collectReachable(
  lookup: ObjectLookup,
  tips: Iterable<string>,
  options: { maxCommitDepth?: number; exclude?: ReadonlySet<string> } = {},
): { objects: Map<string, GitObject>; shallowBoundaries: string[] } {
  const objects = new Map<string, GitObject>();
  const shallowBoundaries: string[] = [];
  const visitedCommits = new Set<string>();
  const visitedTrees = new Set<string>();
  const exclude = options.exclude ?? new Set<string>();
  const maxDepth = options.maxCommitDepth ?? Number.POSITIVE_INFINITY;

  const addTree = (treeOid: string): void => {
    if (exclude.has(treeOid) || visitedTrees.has(treeOid)) return;
    const tree = lookup(treeOid);
    if (!tree || tree.type !== 'tree') return;
    visitedTrees.add(treeOid);
    objects.set(treeOid, tree);
    for (const entry of parseTree(tree.data)) {
      if (exclude.has(entry.oid)) continue;
      if (entry.mode === '40000') addTree(entry.oid);
      else {
        const blob = lookup(entry.oid);
        if (blob) objects.set(entry.oid, blob);
      }
    }
  };

  // Breadth-first over commits so depth is exact (index queue: shift() is O(n)).
  const queue: Array<{ oid: string; depth: number }> = [];
  let queueHead = 0;
  for (const tip of tips) {
    if (!exclude.has(tip)) queue.push({ oid: tip, depth: 1 });
  }
  while (queueHead < queue.length) {
    const { oid, depth } = queue[queueHead]!;
    queueHead += 1;
    if (visitedCommits.has(oid) || exclude.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      objects.set(oid, object);
      const tag = parseTag(object.data);
      if (!exclude.has(tag.object)) queue.push({ oid: tag.object, depth });
      continue;
    }
    if (object.type !== 'commit') {
      // A lone blob/tree tip (unusual): include it.
      objects.set(oid, object);
      continue;
    }
    visitedCommits.add(oid);
    objects.set(oid, object);
    const commit = parseCommit(object.data);
    addTree(commit.tree);
    if (depth >= maxDepth) {
      if (commit.parents.length > 0) shallowBoundaries.push(oid);
      continue;
    }
    for (const parent of commit.parents) {
      if (!exclude.has(parent)) queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  return { objects, shallowBoundaries };
}

/** True when `ancestor` is reachable from `descendant` (following all parents). */
export function isAncestor(lookup: ObjectLookup, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** A common ancestor of `a` and `b` (the first found walking b's history), or null. */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stackA.push(parent);
  }
  const stackB = [b];
  const seenB = new Set<string>();
  while (stackB.length > 0) {
    const oid = stackB.pop()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stackB.push(parent);
  }
  return null;
}

/** Flat map of path -> blob oid for the tree at `treeOid` (recursive). */
export function flattenTree(lookup: ObjectLookup, treeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const tree = lookup(oid);
    if (!tree || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, entry.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

/** The first-parent chain from `tip`, newest first. */
export function firstParentChain(lookup: ObjectLookup, tip: string): string[] {
  const chain: string[] = [];
  let current: string | undefined = tip;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const object = lookup(current);
    if (!object || object.type !== 'commit') break;
    chain.push(current);
    current = parseCommit(object.data).parents[0];
  }
  return chain;
}
