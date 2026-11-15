// git-http.ts: git smart HTTP — info/refs advertisements, upload-pack (v2 + v0)
// and receive-pack (v0). All state lives in the Forge store; all packs are built
// and read by git-core.ts.

import {
  PKT_FLUSH,
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseTag,
  pktLine,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
} from './git-core.ts';
import { Forge, type Repo } from './store.ts';

export const GIT_AGENT = 'forge/1.0';

export interface GitRequest {
  owner: string;
  repoName: string;
  service: string;
  query: URLSearchParams;
  protocolVersion: string | null;
  body: Buffer;
}

export class GitHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sidebandPackets(pack: Buffer, progress?: string): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (progress !== undefined) {
    parts.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from(progress, 'utf8')])));
  }
  return Buffer.concat(parts);
}

/** The HEAD line's oid: the default branch tip, else the first branch tip, else ZERO. */
function headOid(repo: Repo): string {
  const main = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (main !== undefined) return main;
  for (const [name, oid] of repo.refs) {
    if (name.startsWith('refs/heads/')) return oid;
  }
  return ZERO_OID;
}

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function uploadPackCapsV0(): string {
  return `side-band-64k shallow thin-pack ofs-delta multi_ack_detailed symref=HEAD:refs/heads/main agent=${GIT_AGENT}`;
}

function receivePackCapsV0(): string {
  return `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=${GIT_AGENT}`;
}

/** The peeled oid for an annotated tag ref, or undefined. */
function peeledOid(repo: Repo, refName: string): string | undefined {
  const oid = repo.refs.get(refName);
  if (oid === undefined) return undefined;
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return undefined;
  return parseTag(object.data).object;
}

/** v0 advertisement body for a service, with the service preamble. */
export function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadPackCapsV0() : receivePackCapsV0();
  const lines: string[] = [`# service=${service}\n`, 'flush'];
  const names = sortedRefNames(repo);
  const head = headOid(repo);
  if (names.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${head} HEAD\0${caps}\n`);
    for (const name of names) {
      const oid = repo.refs.get(name)!;
      lines.push(`${oid} ${name}\n`);
      const peeled = peeledOid(repo, name);
      if (peeled !== undefined) lines.push(`${peeled} ${name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines as Array<string | 'flush'>);
}

/** v2 capability advertisement body for upload-pack, with the service preamble. */
export function advertisementV2(): Buffer {
  const lines: Array<string | 'flush'> = [
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'fetch=shallow\n',
    'ls-refs\n',
    'object-format=sha1\n',
    `agent=${GIT_AGENT}\n`,
    'flush',
  ];
  return encodePktLines(lines);
}

/** v2 ls-refs response for the requested prefixes. */
export function lsRefsV2(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean): Buffer {
  const lines: Array<string | 'flush'> = [];
  const head = headOid(repo);
  const include = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (include('HEAD')) {
    const suffix = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    lines.push(`${head} HEAD${suffix}\n`);
  }
  for (const name of sortedRefNames(repo)) {
    if (!include(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOid(repo, name);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
}

/**
 * Compute a fetch: the objects to send, the shallow/unshallow lines and the ack.
 * `wants` must all exist (else an error naming the missing oid).
 */
export function computeFetch(
  repo: Repo,
  request: FetchRequest,
): { pack: Buffer; shallow: string[]; unshallow: string[]; ack: string | null; packObjects: number } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  for (const want of request.wants) {
    if (!repo.objects.has(want)) throw new GitHttpError(400, `want ${want} is not in the repository`);
  }
  // What the client already holds. A have that is also a shallow boundary is held
  // only to depth 1 (its commit + tree + blobs, not its parents); a plain have is
  // held with its full closure. Shallow boundaries not listed as haves are held
  // to depth 1 as well.
  const held = new Set<string>();
  const shallowSet = new Set(request.shallow);
  for (const have of request.haves) {
    const closure = shallowSet.has(have)
      ? collectReachable(lookup, [have], { maxCommitDepth: 1 })
      : collectReachable(lookup, [have]);
    for (const oid of closure.objects.keys()) held.add(oid);
  }
  for (const boundary of request.shallow) {
    if (!repo.objects.has(boundary)) continue;
    const closure = collectReachable(lookup, [boundary], { maxCommitDepth: 1 });
    for (const oid of closure.objects.keys()) held.add(oid);
  }
  const maxDepth = request.deepen ?? Number.POSITIVE_INFINITY;
  const walk = collectReachable(lookup, request.wants, { maxCommitDepth: maxDepth });
  const packObjects: GitObject[] = [];
  const wantCommits = new Set<string>();
  for (const [oid, object] of walk.objects) {
    if (object.type === 'commit') wantCommits.add(oid);
    if (!held.has(oid)) packObjects.push(object);
  }
  const shallow = walk.shallowBoundaries;
  const unshallow = request.shallow.filter(
    (boundary) => wantCommits.has(boundary) && !shallow.includes(boundary),
  );
  let ack: string | null = null;
  for (const have of request.haves) {
    const object = repo.objects.get(have);
    if (object && object.type === 'commit') {
      ack = have;
      break;
    }
  }
  return { pack: writePack(packObjects), shallow, unshallow, ack, packObjects: packObjects.length };
}

/** A v2 fetch response: acknowledgments, shallow-info, packfile sections. */
export function fetchResponseV2(result: ReturnType<typeof computeFetch>): Buffer {
  const parts: Buffer[] = [];
  const ackLines: Array<string | 'flush'> = ['acknowledgments\n'];
  if (result.ack !== null) {
    ackLines.push(`ACK ${result.ack}\n`, 'ready\n');
  } else {
    ackLines.push('NAK\n');
  }
  ackLines.push('flush');
  parts.push(encodePktLines(ackLines));
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    const shallowLines: Array<string | 'flush'> = ['shallow-info\n'];
    for (const oid of result.shallow) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of result.unshallow) shallowLines.push(`unshallow ${oid}\n`);
    shallowLines.push('flush');
    parts.push(encodePktLines(shallowLines));
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPackets(result.pack, 'Counting objects: done.\n'));
  return Buffer.concat(parts);
}

/** A v0 fetch response: flat ACK/NAK, shallow lines, then the sideband pack. */
export function fetchResponseV0(result: ReturnType<typeof computeFetch>): Buffer {
  const parts: Buffer[] = [];
  const lines: Array<string | 'flush'> = [];
  if (result.ack !== null) lines.push(`ACK ${result.ack}\n`);
  else lines.push('NAK\n');
  for (const oid of result.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of result.unshallow) lines.push(`unshallow ${oid}\n`);
  parts.push(encodePktLines(lines));
  parts.push(sidebandPackets(result.pack));
  return Buffer.concat(parts);
}

/** Parse a v2 upload-pack request body into its command and arguments. */
export function parseV2Request(body: Buffer): { command: string; args: string[] } {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch (err) {
    throw new GitHttpError(400, `malformed pkt-line stream: ${(err as Error).message}`);
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8'));
  }
  const commandLine = lines[0] ?? '';
  const match = /^command=([a-z-]+)\n?$/.exec(commandLine.trim());
  if (!match) throw new GitHttpError(400, `expected a v2 command, got ${JSON.stringify(commandLine.slice(0, 40))}`);
  const args = lines.slice(1).map((line) => line.replace(/\n$/, ''));
  return { command: match[1]!, args };
}

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportEntry {
  ref: string;
  ok: boolean;
  reason: string;
}

export interface PushOutcome {
  unpackOk: boolean;
  unpackDetail: string;
  refs: PushReportEntry[];
}

/**
 * Apply a receive-pack: validate the pack, then apply the commands that pass.
 * Returns the report-status outcome (unpack + one line per ref).
 */
export function applyReceivePack(repo: Repo, body: Buffer): PushOutcome {
  // Split the command pkt-lines (up to the first flush) from the pack bytes.
  const decoderLines: string[] = [];
  let packStart = -1;
  {
    // Walk pkt-lines manually so the pack offset is exact.
    let offset = 0;
    for (;;) {
      if (offset + 4 > body.length) throw new GitHttpError(400, 'the receive-pack body is truncated');
      const lengthText = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) {
        throw new GitHttpError(400, 'the receive-pack body is not a pkt-line stream');
      }
      const length = parseInt(lengthText, 16);
      if (length === 0) {
        packStart = offset + 4;
        break;
      }
      if (length < 4 || offset + length > body.length) {
        throw new GitHttpError(400, 'the receive-pack body is truncated');
      }
      decoderLines.push(body.subarray(offset + 4, offset + length).toString('utf8'));
      offset += length;
    }
  }
  const commands: PushCommand[] = [];
  for (const line of decoderLines) {
    const text = line.replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const head = nul >= 0 ? text.slice(0, nul) : text;
    const parts = head.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!) || !parts[2]!.startsWith('refs/')) {
      throw new GitHttpError(400, `bad push command ${JSON.stringify(head.slice(0, 60))}`);
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (commands.length === 0) throw new GitHttpError(400, 'a push needs at least one command');
  const packBytes = body.subarray(packStart);
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error: no packfile was sent';
    } else if (!verifyPackChecksum(packBytes)) {
      unpackOk = false;
      unpackDetail = 'unpacker error: the pack trailer does not match its bytes';
    } else {
      try {
        const read = readPack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, object] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = `unpacker error: ${(err as Error).message}`;
      }
    }
  }
  const refs: PushReportEntry[] = [];
  if (!unpackOk) {
    for (const command of commands) {
      refs.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
    }
    return { unpackOk, unpackDetail, refs };
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        refs.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        refs.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      refs.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        refs.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        refs.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update.
    if (current === undefined) {
      refs.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
    } else if (command.oldOid !== current) {
      refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (!isAncestor(lookup, command.oldOid, command.newOid)) {
      refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      refs.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  return { unpackOk, unpackDetail, refs };
}

/** The report-status stream inside sideband band 1, plus a progress line. */
export function pushReportSideband(outcome: PushOutcome): Buffer {
  const lines: Array<string | 'flush'> = [`unpack ${outcome.unpackDetail}\n`];
  for (const entry of outcome.refs) {
    lines.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`);
  }
  lines.push('flush');
  const report = encodePktLines(lines);
  const parts: Buffer[] = [sidebandPackets(report, 'Unpacking objects: done.\n'), PKT_FLUSH];
  return Buffer.concat(parts);
}

export { hashObject };
