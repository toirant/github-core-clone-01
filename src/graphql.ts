// graphql.ts: a small GraphQL executor for the documents the suite sends.
// A recursive-descent parser for the query language subset (operations, variables,
// arguments, aliases, inline fragments, named fragments), then resolvers over the
// Forge store. Unknown fields answer HTTP 200 with an `errors` entry naming the
// field; an unknown repository answers `data.repository = null` with no errors.

import { Forge, type Issue, type Pull, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selection: FieldNode[] | null;
  typeCondition: string | null;
}

export interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, { defaultValue: ValueNode | null }>;
  selection: FieldNode[];
}

class Parser {
  #tokens: Token[];
  #pos = 0;
  #fragments = new Map<string, { typeCondition: string; selection: FieldNode[] }>();

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  #peek(): Token {
    return this.#tokens[this.#pos]!;
  }

  #next(): Token {
    const token = this.#tokens[this.#pos]!;
    this.#pos += 1;
    return token;
  }

  #expectPunct(value: string): void {
    const token = this.#next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}, got ${token.value}`);
    }
  }

  #expectName(): string {
    const token = this.#next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.#peek().kind !== 'eof') {
      const token = this.#peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, variables: {}, selection: this.#parseSelectionSet(null) });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.#next();
        const name = this.#expectName();
        this.#expectName(); // 'on'
        const typeCondition = this.#expectName();
        const selection = this.#parseSelectionSet(null);
        this.#fragments.set(name, { typeCondition, selection });
      } else {
        const keyword = this.#expectName();
        if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
          throw new Error(`unexpected definition ${keyword}`);
        }
        let name: string | null = null;
        if (this.#peek().kind === 'name') name = this.#next().value;
        const variables: Record<string, { defaultValue: ValueNode | null }> = {};
        if (this.#peek().kind === 'punct' && this.#peek().value === '(') {
          this.#next();
          while (!(this.#peek().kind === 'punct' && this.#peek().value === ')')) {
            this.#expectPunct('$');
            const varName = this.#expectName();
            this.#expectPunct(':');
            this.#parseType();
            let defaultValue: ValueNode | null = null;
            if (this.#peek().kind === 'punct' && this.#peek().value === '=') {
              this.#next();
              defaultValue = this.#parseValue(true);
            }
            variables[varName] = { defaultValue };
            if (this.#peek().kind === 'punct' && this.#peek().value === ',') this.#next();
          }
          this.#expectPunct(')');
        }
        // Directives (none used by the suite): skip @name(args).
        while (this.#peek().kind === 'punct' && this.#peek().value === '@') {
          this.#next();
          this.#expectName();
          if (this.#peek().kind === 'punct' && this.#peek().value === '(') this.#parseArguments();
        }
        operations.push({
          type: keyword === 'mutation' ? 'mutation' : 'query',
          name,
          variables,
          selection: this.#parseSelectionSet(null),
        });
      }
    }
    return operations;
  }

  #parseType(): void {
    if (this.#peek().kind === 'punct' && this.#peek().value === '[') {
      this.#next();
      this.#parseType();
      this.#expectPunct(']');
    } else {
      this.#expectName();
    }
    if (this.#peek().kind === 'punct' && this.#peek().value === '!') this.#next();
  }

  #parseSelectionSet(typeCondition: string | null): FieldNode[] {
    this.#expectPunct('{');
    const fields: FieldNode[] = [];
    while (!(this.#peek().kind === 'punct' && this.#peek().value === '}')) {
      if (this.#peek().kind === 'eof') throw new Error('unterminated selection set');
      if (this.#peek().kind === 'punct' && this.#peek().value === '...') {
        this.#next();
        if (this.#peek().kind === 'name' && this.#peek().value === 'on') {
          this.#next();
          const condition = this.#expectName();
          const inner = this.#parseSelectionSet(condition);
          fields.push(...inner);
        } else {
          const name = this.#expectName();
          const fragment = this.#fragments.get(name);
          if (!fragment) throw new Error(`unknown fragment ${name}`);
          fields.push(...fragment.selection);
        }
        continue;
      }
      const first = this.#expectName();
      let alias: string | null = null;
      let name = first;
      if (this.#peek().kind === 'punct' && this.#peek().value === ':') {
        this.#next();
        alias = first;
        name = this.#expectName();
      }
      let args: Record<string, ValueNode> = {};
      if (this.#peek().kind === 'punct' && this.#peek().value === '(') {
        args = this.#parseArguments();
      }
      while (this.#peek().kind === 'punct' && this.#peek().value === '@') {
        this.#next();
        this.#expectName();
        if (this.#peek().kind === 'punct' && this.#peek().value === '(') this.#parseArguments();
      }
      let selection: FieldNode[] | null = null;
      if (this.#peek().kind === 'punct' && this.#peek().value === '{') {
        selection = this.#parseSelectionSet(typeCondition);
      }
      fields.push({ alias, name, args, selection, typeCondition });
    }
    this.#expectPunct('}');
    return fields;
  }

  #parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.#expectPunct('(');
    while (!(this.#peek().kind === 'punct' && this.#peek().value === ')')) {
      const name = this.#expectName();
      this.#expectPunct(':');
      args[name] = this.#parseValue(false);
      if (this.#peek().kind === 'punct' && this.#peek().value === ',') this.#next();
    }
    this.#expectPunct(')');
    return args;
  }

  #parseValue(isConst: boolean): ValueNode {
    const token = this.#next();
    if (token.kind === 'punct' && token.value === '$') {
      if (isConst) throw new Error('a variable cannot appear in a constant value');
      return { kind: 'variable', name: this.#expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.#peek().kind === 'punct' && this.#peek().value === ']')) {
        values.push(this.#parseValue(isConst));
        if (this.#peek().kind === 'punct' && this.#peek().value === ',') this.#next();
      }
      this.#expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.#peek().kind === 'punct' && this.#peek().value === '}')) {
        const name = this.#expectName();
        this.#expectPunct(':');
        fields[name] = this.#parseValue(isConst);
        if (this.#peek().kind === 'punct' && this.#peek().value === ',') this.#next();
      }
      this.#expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------------------
// global ids
// ---------------------------------------------------------------------------

function encodeId(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64');
}

function decodeId(id: string): string | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    if (decoded === '' || !/^[\x20-\x7e]+$/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return encodeId(`Repository:${repo.id}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeId(`Issue:${repo.id}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeId(`PullRequest:${repo.id}:${pull.number}`);
}

function commentGlobalId(commentId: number): string {
  return encodeId(`IssueComment:${commentId}`);
}

function cursorFor(repoId: number, number: number): string {
  return encodeId(`cursor:${repoId}:${number}`);
}

function cursorNumber(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  const decoded = decodeId(cursor);
  if (!decoded) return null;
  const match = /^cursor:\d+:(\d+)$/.exec(decoded);
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface TypedValue {
  type: string;
  value: unknown;
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'author', 'labels', 'comments', 'repository'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'files', 'url', 'createdAt', 'author', 'repository',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'createdAt', 'description',
  ],
  User: ['id', 'login', 'name', 'email'],
  Ref: ['id', 'name'],
  IssueComment: ['id', 'body', 'createdAt', 'author'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description', 'ofType', 'interfaces', 'possibleTypes', 'inputFields'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['queryType', 'mutationType', 'types', 'description', 'directives'],
  __FieldConnection: ['nodes', 'pageInfo', 'totalCount'],
  __EnumValueConnection: ['nodes', 'pageInfo', 'totalCount'],
  __TypeConnection: ['nodes', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'pageInfo', 'totalCount'],
  CommentEdge: ['node', 'cursor'],
  Label: ['id', 'name', 'color', 'description'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  MergeStateStatus: ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'MERGEABLE', 'UNKNOWN'],
};

export class GraphQLExecutor {
  #forge: Forge;
  #errors: Array<{ message: string }> = [];

  constructor(forge: Forge) {
    this.#forge = forge;
  }

  execute(document: string, variables: Record<string, unknown>): { data: Record<string, JsonValue | null> | null; errors?: Array<{ message: string }> } {
    this.#errors = [];
    let operations: OperationNode[];
    try {
      operations = new Parser(tokenize(document)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: `GraphQL syntax error: ${(err as Error).message}` }] };
    }
    const operation = operations[0];
    if (!operation) return { data: null, errors: [{ message: 'an empty GraphQL document' }] };
    const vars = { ...variables };
    for (const [name, def] of Object.entries(operation.variables)) {
      if (!(name in vars) && def.defaultValue !== null) {
        vars[name] = this.#value(def.defaultValue, vars);
      }
    }
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const { value, failed } = this.#resolveSelection(rootType, { type: rootType, value: null }, operation.selection, vars);
    const data = (value ?? {}) as Record<string, JsonValue | null>;
    if (failed && Object.keys(data).length === 0) {
      return { data: null, errors: this.#errors };
    }
    return this.#errors.length > 0 ? { data, errors: this.#errors } : { data };
  }

  #value(node: ValueNode, variables: Record<string, unknown>): unknown {
    switch (node.kind) {
      case 'variable':
        return variables[node.name];
      case 'string':
      case 'enum':
        return node.value;
      case 'int':
      case 'float':
      case 'boolean':
        return node.value;
      case 'null':
        return null;
      case 'list':
        return node.values.map((entry) => this.#value(entry, variables));
      case 'object': {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(node.fields)) out[key] = this.#value(entry, variables);
        return out;
      }
    }
  }

  #args(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, node] of Object.entries(field.args)) out[key] = this.#value(node, variables);
    return out;
  }

  #fail(message: string): void {
    this.#errors.push({ message });
  }

  /**
   * Resolve a selection set against a typed value. Returns the object (or null when
   * a child failed, per GraphQL's null propagation) and whether any child failed.
   */
  #resolveSelection(
    parentType: string,
    parent: TypedValue,
    selection: FieldNode[],
    variables: Record<string, unknown>,
  ): { value: Record<string, JsonValue | null> | null; failed: boolean } {
    const out: Record<string, JsonValue | null> = {};
    let failed = false;
    for (const field of selection) {
      if (field.typeCondition !== null && field.typeCondition !== parentType) continue;
      const key = field.alias ?? field.name;
      if (field.name === '__typename') {
        out[key] = parentType;
        continue;
      }
      const known = TYPE_FIELDS[parentType];
      if (!known || !known.includes(field.name)) {
        this.#fail(`Cannot query field "${field.name}" on type "${parentType}".`);
        failed = true;
        out[key] = null;
        continue;
      }
      const resolved = this.#resolveField(parentType, parent, field, variables);
      if (resolved.failed) failed = true;
      out[key] = resolved.value as JsonValue | null;
    }
    return { value: failed ? null : out, failed };
  }

  #resolveField(
    parentType: string,
    parent: TypedValue,
    field: FieldNode,
    variables: Record<string, unknown>,
  ): { value: JsonValue | null; failed: boolean } {
    const args = this.#args(field, variables);
    const child = (type: string, value: unknown): { value: JsonValue | null; failed: boolean } => {
      if (value === null || value === undefined) return { value: null, failed: false };
      if (field.selection === null) {
        return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? { value: value as JsonValue, failed: false }
          : { value: null, failed: false };
      }
      const resolved = this.#resolveSelection(type, { type, value }, field.selection, variables);
      return { value: resolved.value, failed: resolved.failed };
    };

    // Root fields.
    if (parentType === 'Query') {
      if (field.name === 'viewer') {
        return child('User', { login: this.#forge.viewerLogin });
      }
      if (field.name === 'repository') {
        const owner = args.owner as string | undefined;
        const name = args.name as string | undefined;
        const repo = owner !== undefined && name !== undefined ? this.#forge.getRepo(owner, name) : undefined;
        if (!repo) return { value: null, failed: false };
        return child('Repository', repo);
      }
      if (field.name === 'node') {
        const decoded = decodeId(args.id as string);
        if (!decoded) return { value: null, failed: false };
        const match = /^(Repository|Issue|PullRequest|IssueComment):(\d+)(?::(\d+))?$/.exec(decoded);
        if (!match) return { value: null, failed: false };
        const kind = match[1]!;
        const repoId = Number(match[2]);
        if (kind === 'IssueComment') {
          const commentId = Number(match[2]);
          for (const candidate of this.#forge.repos.values()) {
            for (const issue of candidate.issues) {
              const comment = issue.comments.find((entry) => entry.id === commentId);
              if (comment) return child('IssueComment', { repo: candidate, issue, comment });
            }
          }
          return { value: null, failed: false };
        }
        const repo = [...this.#forge.repos.values()].find((candidate) => candidate.id === repoId);
        if (!repo) return { value: null, failed: false };
        if (kind === 'Repository') return child('Repository', repo);
        if (kind === 'Issue') {
          const issue = repo.issues.find((entry) => entry.number === Number(match[3]));
          return issue ? child('Issue', { repo, issue }) : { value: null, failed: false };
        }
        if (kind === 'PullRequest') {
          const pull = repo.pulls.find((entry) => entry.number === Number(match[3]));
          return pull ? child('PullRequest', { repo, pull }) : { value: null, failed: false };
        }
        return { value: null, failed: false };
      }
      if (field.name === '__type') {
        const name = args.name as string | undefined;
        if (!name) return { value: null, failed: false };
        const typeValue: Record<string, unknown> = { name };
        if (TYPE_FIELDS[name]) typeValue.__typeKind = 'OBJECT';
        else if (TYPE_ENUM_VALUES[name]) typeValue.__typeKind = 'ENUM';
        else return { value: null, failed: false };
        return child('__Type', typeValue);
      }
      if (field.name === '__schema') {
        return child('__Schema', { name: '__Schema' });
      }
    }

    // Mutations.
    if (parentType === 'Mutation') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (field.name === 'createIssue') {
        const repo = this.#repoByGlobalId(input.repositoryId as string | undefined);
        if (!repo) {
          this.#fail('createIssue: the repository was not found');
          return { value: null, failed: true };
        }
        const created = this.#forge.createIssue(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
        });
        if (created.error || !created.issue) {
          this.#fail(`createIssue: ${created.error ?? 'failed'}`);
          return { value: null, failed: true };
        }
        return child('CreateIssuePayload', { issue: { repo, issue: created.issue } });
      }
      if (field.name === 'closeIssue') {
        const found = this.#issueByGlobalId(input.issueId as string | undefined);
        if (!found) {
          this.#fail('closeIssue: the issue was not found');
          return { value: null, failed: true };
        }
        const patched = this.#forge.patchIssue(found.repo, found.issue.number, { state: 'closed' });
        if (!patched.issue) {
          this.#fail('closeIssue: the issue could not be closed');
          return { value: null, failed: true };
        }
        return child('CloseIssuePayload', { issue: { repo: found.repo, issue: patched.issue } });
      }
      if (field.name === 'createPullRequest') {
        const repo = this.#repoByGlobalId(input.repositoryId as string | undefined);
        if (!repo) {
          this.#fail('createPullRequest: the repository was not found');
          return { value: null, failed: true };
        }
        const created = this.#forge.createPull(repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
        });
        if (created.error || !created.pull) {
          this.#fail(`createPullRequest: ${created.error ?? 'failed'}`);
          return { value: null, failed: true };
        }
        return child('CreatePullRequestPayload', { pull: { repo, pull: created.pull } });
      }
      if (field.name === 'mergePullRequest') {
        const found = this.#pullByGlobalId(input.pullRequestId as string | undefined);
        if (!found) {
          this.#fail('mergePullRequest: the pull request was not found');
          return { value: null, failed: true };
        }
        const merged = this.#forge.mergePull(found.repo, found.pull.number);
        if (merged.error || !merged.pull) {
          this.#fail(`mergePullRequest: ${merged.error ?? 'failed'}`);
          return { value: null, failed: true };
        }
        return child('MergePullRequestPayload', { pull: { repo: found.repo, pull: merged.pull } });
      }
      if (field.name === 'addComment') {
        const found = this.#issueByGlobalId(input.subjectId as string | undefined);
        if (!found) {
          this.#fail('addComment: the subject was not found');
          return { value: null, failed: true };
        }
        const added = this.#forge.addComment(found.repo, found.issue.number, String(input.body ?? ''));
        if (added.error || !added.comment) {
          this.#fail(`addComment: ${added.error ?? 'failed'}`);
          return { value: null, failed: true };
        }
        return child('AddCommentPayload', {
          commentEdge: { repo: found.repo, issue: found.issue, comment: added.comment },
        });
      }
    }

    // Scalar / object fields on the domain types.
    const value = this.#scalarField(parentType, parent, field, args);
    if (value === undefined) return { value: null, failed: false };
    if (value !== null && typeof value === 'object' && 'typed' in (value as Record<string, unknown>)) {
      const typed = (value as { typed: TypedValue }).typed;
      return child(typed.type, typed.value);
    }
    if (value !== null && typeof value === 'object' && 'connection' in (value as Record<string, unknown>)) {
      const connection = (value as { connection: { type: string; items: TypedValue[]; pageInfo: Record<string, JsonValue> } }).connection;
      if (field.selection === null) return { value: null, failed: false };
      const resolved = this.#resolveConnection(connection, field.selection, variables);
      return { value: resolved.value, failed: resolved.failed };
    }
    if (value !== null && typeof value === 'object' && 'list' in (value as Record<string, unknown>)) {
      const list = (value as { list: TypedValue[] }).list;
      if (field.selection === null) return { value: null, failed: false };
      const items: Array<JsonValue | null> = [];
      let listFailed = false;
      for (const item of list) {
        const resolved = this.#resolveSelection(item.type, item, field.selection, variables);
        items.push(resolved.value);
        if (resolved.failed) listFailed = true;
      }
      return { value: items, failed: listFailed };
    }
    if (field.selection !== null) {
      // A nested object the scalar path did not type: resolve generically.
      return { value: null, failed: false };
    }
    return { value: value as JsonValue, failed: false };
  }

  #resolveConnection(
    connection: { type: string; items: TypedValue[]; pageInfo: Record<string, JsonValue> },
    selection: FieldNode[],
    variables: Record<string, unknown>,
  ): { value: Record<string, JsonValue | null> | null; failed: boolean } {
    const out: Record<string, JsonValue | null> = {};
    let failed = false;
    for (const field of selection) {
      if (field.typeCondition !== null && field.typeCondition !== connection.type) continue;
      const key = field.alias ?? field.name;
      if (field.name === 'nodes') {
        const nodes: Array<JsonValue | null> = [];
        for (const item of connection.items) {
          if (field.selection === null) {
            nodes.push(null);
            continue;
          }
          const resolved = this.#resolveSelection(item.type, item, field.selection, variables);
          nodes.push(resolved.value);
          if (resolved.failed) failed = true;
        }
        out[key] = nodes;
        continue;
      }
      if (field.name === 'pageInfo') {
        if (field.selection === null) {
          out[key] = null;
          continue;
        }
        const info: Record<string, JsonValue | null> = {};
        for (const sub of field.selection) {
          if (sub.name in connection.pageInfo) info[sub.alias ?? sub.name] = connection.pageInfo[sub.name] ?? null;
          else info[sub.alias ?? sub.name] = null;
        }
        out[key] = info;
        continue;
      }
      if (field.name === 'totalCount') {
        out[key] = connection.items.length;
        continue;
      }
      this.#fail(`Cannot query field "${field.name}" on type "${connection.type}".`);
      failed = true;
      out[key] = null;
    }
    return { value: failed ? null : out, failed };
  }

  #repoByGlobalId(id: string | undefined): Repo | undefined {
    if (!id) return undefined;
    const decoded = decodeId(id);
    if (!decoded) return undefined;
    const match = /^Repository:(\d+)$/.exec(decoded);
    if (!match) return undefined;
    return [...this.#forge.repos.values()].find((repo) => repo.id === Number(match[1]));
  }

  #issueByGlobalId(id: string | undefined): { repo: Repo; issue: Issue } | undefined {
    if (!id) return undefined;
    const decoded = decodeId(id);
    if (!decoded) return undefined;
    const match = /^Issue:(\d+):(\d+)$/.exec(decoded);
    if (!match) return undefined;
    const repo = [...this.#forge.repos.values()].find((candidate) => candidate.id === Number(match[1]));
    if (!repo) return undefined;
    const issue = repo.issues.find((entry) => entry.number === Number(match[2]));
    return issue ? { repo, issue } : undefined;
  }

  #pullByGlobalId(id: string | undefined): { repo: Repo; pull: Pull } | undefined {
    if (!id) return undefined;
    const decoded = decodeId(id);
    if (!decoded) return undefined;
    const match = /^PullRequest:(\d+):(\d+)$/.exec(decoded);
    if (!match) return undefined;
    const repo = [...this.#forge.repos.values()].find((candidate) => candidate.id === Number(match[1]));
    if (!repo) return undefined;
    const pull = repo.pulls.find((entry) => entry.number === Number(match[2]));
    return pull ? { repo, pull } : undefined;
  }

  /** Scalar fields and nested-object fields on the domain types. */
  #scalarField(
    parentType: string,
    parent: TypedValue,
    field: FieldNode,
    args: Record<string, unknown>,
  ): unknown {
    const forge = this.#forge;
    if (parentType === 'User') {
      const user = parent.value as { login: string };
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return encodeId(`User:${user.login}`);
      if (field.name === 'name') return user.login;
      if (field.name === 'email') return `${user.login}@example.invalid`;
      return undefined;
    }
    if (parentType === 'Ref') {
      const ref = parent.value as { name: string };
      if (field.name === 'name') return ref.name;
      if (field.name === 'id') return encodeId(`Ref:${ref.name}`);
      return undefined;
    }
    if (parentType === '__Type') {
      const typeValue = parent.value as { name: string; __typeKind?: string };
      if (field.name === 'name') return typeValue.name;
      if (field.name === 'kind') return typeValue.__typeKind ?? 'OBJECT';
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[typeValue.name] ?? [];
        return {
          list: names.map((name) => ({ type: '__Field', value: { name } })),
        };
      }
      if (field.name === 'enumValues') {
        const names = TYPE_ENUM_VALUES[typeValue.name] ?? [];
        return {
          list: names.map((name) => ({ type: '__EnumValue', value: { name } })),
        };
      }
      return undefined;
    }
    if (parentType === '__Field' || parentType === '__EnumValue') {
      const item = parent.value as { name: string };
      if (field.name === 'name') return item.name;
      return undefined;
    }
    if (parentType === '__Schema') {
      if (field.name === 'queryType') return { typed: { type: '__Type', value: { name: 'Query', __typeKind: 'OBJECT' } } };
      if (field.name === 'mutationType') return { typed: { type: '__Type', value: { name: 'Mutation', __typeKind: 'OBJECT' } } };
      if (field.name === 'types') {
        return {
          list: Object.keys(TYPE_FIELDS).map((name) => ({ type: '__Type', value: { name, __typeKind: 'OBJECT' } })),
        };
      }
      return undefined;
    }
    if (parentType === 'Repository') {
      const repo = parent.value as Repo;
      switch (field.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return { typed: { type: 'User', value: { login: repo.owner } } };
        case 'defaultBranchRef': {
          const tip = forge.defaultTip(repo);
          if (tip === undefined) return null;
          return { typed: { type: 'Ref', value: { name: repo.defaultBranch } } };
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}`;
        case 'description':
          return repo.description;
        case 'createdAt':
          return repo.createdAt;
        case 'issue': {
          const number = args.number as number | undefined;
          const issue = number === undefined ? undefined : forge.getIssue(repo, number);
          if (!issue) return null;
          return { typed: { type: 'Issue', value: { repo, issue } } };
        }
        case 'issues': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const after = cursorNumber(args.after as string | null | undefined);
          const states = (args.states as string[] | undefined) ?? ['OPEN'];
          const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
          let list = repo.issues.filter((issue) =>
            states.length === 0 ? true : states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'),
          );
          const direction = orderBy.direction ?? 'ASC';
          list = [...list].sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
          if (after !== null) list = list.filter((issue) => (direction === 'DESC' ? issue.number < after : issue.number > after));
          const page = list.slice(0, first);
          const hasNext = list.length > page.length;
          const endCursor = page.length > 0 ? cursorFor(repo.id, page[page.length - 1]!.number) : null;
          return {
            connection: {
              type: 'IssueConnection',
              items: page.map((issue) => ({ type: 'Issue', value: { repo, issue } })),
              pageInfo: { hasNextPage: hasNext, hasPreviousPage: false, startCursor: null, endCursor },
            },
          };
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const after = cursorNumber(args.after as string | null | undefined);
          const states = (args.states as string[] | undefined) ?? ['OPEN'];
          let list = repo.pulls.filter((pull) => {
            const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
            return states.length === 0 ? true : states.includes(state);
          });
          list = [...list].sort((a, b) => b.number - a.number);
          if (after !== null) list = list.filter((pull) => pull.number < after);
          const page = list.slice(0, first);
          const hasNext = list.length > page.length;
          const endCursor = page.length > 0 ? cursorFor(repo.id, page[page.length - 1]!.number) : null;
          return {
            connection: {
              type: 'PullRequestConnection',
              items: page.map((pull) => ({ type: 'PullRequest', value: { repo, pull } })),
              pageInfo: { hasNextPage: hasNext, hasPreviousPage: false, startCursor: null, endCursor },
            },
          };
        }
        case 'pullRequest': {
          const number = args.number as number | undefined;
          const pull = number === undefined ? undefined : forge.getPull(repo, number);
          if (!pull) return null;
          return { typed: { type: 'PullRequest', value: { repo, pull } } };
        }
        default:
          return undefined;
      }
    }
    if (parentType === 'Issue') {
      const wrapped = parent.value as { repo: Repo; issue: Issue };
      switch (field.name) {
        case 'id':
          return issueGlobalId(wrapped.repo, wrapped.issue);
        case 'number':
          return wrapped.issue.number;
        case 'title':
          return wrapped.issue.title;
        case 'body':
          return wrapped.issue.body;
        case 'state':
          return wrapped.issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'url':
          return `https://github.com/${wrapped.repo.owner}/${wrapped.repo.name}/issues/${wrapped.issue.number}`;
        case 'createdAt':
          return wrapped.issue.createdAt;
        case 'author':
          return { typed: { type: 'User', value: { login: wrapped.repo.owner } } };
        case 'repository':
          return { typed: { type: 'Repository', value: wrapped.repo } };
        case 'labels':
          return {
            connection: {
              type: 'LabelConnection',
              items: wrapped.issue.labels.map((name) => ({ type: 'Label', value: { name } })),
              pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
            },
          };
        case 'comments':
          return {
            connection: {
              type: 'IssueCommentConnection',
              items: wrapped.issue.comments.map((comment) => ({
                type: 'IssueComment',
                value: { repo: wrapped.repo, issue: wrapped.issue, comment },
              })),
              pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
            },
          };
        default:
          return undefined;
      }
    }
    if (parentType === 'PullRequest') {
      const wrapped = parent.value as { repo: Repo; pull: Pull };
      switch (field.name) {
        case 'id':
          return pullGlobalId(wrapped.repo, wrapped.pull);
        case 'number':
          return wrapped.pull.number;
        case 'title':
          return wrapped.pull.title;
        case 'body':
          return wrapped.pull.body;
        case 'state':
          return wrapped.pull.merged ? 'MERGED' : wrapped.pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return wrapped.pull.merged;
        case 'mergeable':
          return forge.pullMergeable(wrapped.repo, wrapped.pull);
        case 'headRefName':
          return wrapped.pull.headRef;
        case 'baseRefName':
          return wrapped.pull.baseRef;
        case 'headRefOid':
          return wrapped.pull.headSha;
        case 'baseRefOid':
          return wrapped.pull.baseSha;
        case 'url':
          return `https://github.com/${wrapped.repo.owner}/${wrapped.repo.name}/pull/${wrapped.pull.number}`;
        case 'createdAt':
          return wrapped.pull.createdAt;
        case 'author':
          return { typed: { type: 'User', value: { login: wrapped.repo.owner } } };
        case 'repository':
          return { typed: { type: 'Repository', value: wrapped.repo } };
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const files = forge.pullFiles(wrapped.repo, wrapped.pull).slice(0, first);
          return {
            connection: {
              type: 'PullRequestFileConnection',
              items: files.map((file) => ({
                type: 'PullRequestFile',
                value: { path: file.filename, additions: file.additions, deletions: file.deletions },
              })),
              pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
            },
          };
        }
        default:
          return undefined;
      }
    }
    if (parentType === 'PullRequestFile') {
      const file = parent.value as { path: string; additions: number; deletions: number };
      if (field.name === 'path') return file.path;
      if (field.name === 'additions') return file.additions;
      if (field.name === 'deletions') return file.deletions;
      if (field.name === 'changeType') return 'MODIFIED';
      return undefined;
    }
    if (parentType === 'IssueComment') {
      const wrapped = parent.value as { repo: Repo; issue: Issue; comment: { id: number; body: string; createdAt: string } };
      if (field.name === 'id') return commentGlobalId(wrapped.comment.id);
      if (field.name === 'body') return wrapped.comment.body;
      if (field.name === 'createdAt') return wrapped.comment.createdAt;
      if (field.name === 'author') return { typed: { type: 'User', value: { login: wrapped.repo.owner } } };
      return undefined;
    }
    if (parentType === 'Label') {
      const label = parent.value as { name: string };
      if (field.name === 'name') return label.name;
      if (field.name === 'id') return encodeId(`Label:${label.name}`);
      return undefined;
    }
    if (parentType === 'CreateIssuePayload' || parentType === 'CloseIssuePayload') {
      const payload = parent.value as { issue: { repo: Repo; issue: Issue } };
      if (field.name === 'issue') return { typed: { type: 'Issue', value: payload.issue } };
      if (field.name === 'clientMutationId') return null;
      return undefined;
    }
    if (parentType === 'CreatePullRequestPayload' || parentType === 'MergePullRequestPayload') {
      const payload = parent.value as { pull: { repo: Repo; pull: Pull } };
      if (field.name === 'pullRequest') return { typed: { type: 'PullRequest', value: payload.pull } };
      if (field.name === 'clientMutationId') return null;
      return undefined;
    }
    if (parentType === 'AddCommentPayload') {
      const payload = parent.value as { commentEdge: { repo: Repo; issue: Issue; comment: { id: number; body: string; createdAt: string } } };
      if (field.name === 'commentEdge') return { typed: { type: 'CommentEdge', value: payload.commentEdge } };
      if (field.name === 'clientMutationId') return null;
      return undefined;
    }
    if (parentType === 'CommentEdge') {
      const edge = parent.value as { repo: Repo; issue: Issue; comment: { id: number; body: string; createdAt: string } };
      if (field.name === 'node') return { typed: { type: 'IssueComment', value: edge } };
      if (field.name === 'cursor') return cursorFor(edge.repo.id, edge.comment.id);
      return undefined;
    }
    return undefined;
  }
}

/** Run one GraphQL request body (a single document or a batch array). */
export function handleGraphQL(
  forge: Forge,
  body: unknown,
): { status: number; payload: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        return { data: null, errors: [{ message: 'a batch entry must be an object' }] };
      }
      const record = entry as Record<string, unknown>;
      const query = typeof record.query === 'string' ? record.query : '';
      const variables = (record.variables ?? {}) as Record<string, unknown>;
      return new GraphQLExecutor(forge).execute(query, variables);
    });
    return { status: 200, payload: results };
  }
  if (typeof body !== 'object' || body === null) {
    return { status: 400, payload: { errors: [{ message: 'a GraphQL request body must be an object' }] } };
  }
  const record = body as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  return { status: 200, payload: new GraphQLExecutor(forge).execute(query, variables) };
}
