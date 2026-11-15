# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/toirant/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/toirant/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process: git smart HTTP (protocol v2 upload-pack with shallow fetch, v0 receive-pack with report-status), REST v3, GraphQL v4, and MCP — all served from a single in-memory store, Node stdlib only, no git binary, no network beyond the grading suite.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> MAKEFUN_ENV_URL=http://127.0.0.1:8080 node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the environment at `$MAKEFUN_ENV_URL`, and exits when the environment says the trial is done. `MAKEFUN_TRIAL_NOW` seeds the deterministic logical clock used for server-created commits; `MAKEFUN_TRIAL_SEED` is accepted and unused (the scenario is fixed by the kit).

For local development without an environment, start the server directly and point the kit's local runner at it:

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types -e "import('./app.ts').then(m => m.createApp().listen(18080, () => console.log('listening on 18080')))"
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18080 --token test-token --perf
```

## Layout

- `main.ts` — the entry ↔ environment lifecycle (bind, register, poll `/done`).
- `app.ts` — the HTTP server and router.
- `src/store.ts` — the in-memory forge: repositories, issues, pull requests, labels, contents commits, squash merges with three-way conflict detection.
- `src/git-core.ts` — the git object model, pkt-line codec, packfile read/write (with delta resolution), reachability walks.
- `src/git-http.ts` — smart HTTP: v2/v0 advertisements, ls-refs, fetch (shallow/deepen), receive-pack.
- `src/rest.ts` — REST v3: repos, branches, commits, contents, labels, issues, pulls.
- `src/graphql.ts` — GraphQL v4: a small parser and executor for queries, mutations, introspection and node ids.
- `src/mcp.ts` — MCP over Streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call`.
- `src/scenario.ts` — the contest's fixed scenario seed, used to derive the token owner's login.

## Design notes

- **One store, four surfaces.** Git, REST, GraphQL and MCP all read and write the same in-memory repositories, so an object created over one surface is the same object over the others.
- **Deterministic.** Server-created commits use a logical clock seeded from `MAKEFUN_TRIAL_NOW` (+1s per mutation); no wall clock, no randomness in anything served. A replay of the same trial produces identical objects.
- **Fast.** Everything is in-memory maps; fetch walks are bounded by the requested depth, packs are written plain (no deltas), and responses carry explicit content lengths for keep-alive reuse.

---

<sub>Entered on [make.fun](https://make.fun/?ref=0dhzvgtg&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
