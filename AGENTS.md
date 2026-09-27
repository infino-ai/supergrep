# SuperGrep: notes for AI agents

Read [CONTRIBUTING.md](CONTRIBUTING.md) first for prerequisites, the build,
test commands, and the PR workflow. This file covers what isn't there: what
the project is, the repo map, and the boundaries that aren't obvious from the
code.

## Project overview

**SuperGrep is retrieval + inference offload for AI coding agents: four
tools over an Infino index kept in two places.** `find` and plain `sql` run
locally - a CLI (`cx`) and MCP server over a ranked index in plain files
inside the repo, exposing read-only SQL over it, so an agent answers
questions about a codebase without crawling files into the context window.
`search`, a `sql` statement with a ranked search inside it, and `ask` run in
the Infino cloud, over the same index's platform copy, where the embeddings
are computed: a bearer key authenticates the connection, and the platform's
own model embeds that copy by default. Without an account the server is
`find`, plain `sql` and `read`, with no key and nothing uploaded. `cx login
--platform` gets the account (it asks the person first - the agent never
agrees on their behalf), and with one stored the server serves every
directory a session opens, each in its own database, so the Claude Code
plugin needs nothing per project. It is built on the
[infino](https://github.com/infino-ai/infino) engine, which runs SQL,
full-text, and vector search over one copy of the data. The package, the CLI
and the MCP server are still named `code-context`; SuperGrep is the product.

The user-facing surface, quick start, measured numbers and configuration
live in [README.md](README.md); the honest limits in
[docs/tradeoffs.md](docs/tradeoffs.md).

## Repo map

- `src/cli.ts`: the `cx` / `code-context` command entry (commander).
  `install`, `login`, `index`, `find`, `search`, `sql`, `status`, `usage`,
  `mcp`.
- `src/mcp/server.ts`: the MCP server. `find`, `sql` and `read` are always
  registered and each takes an optional `path` (repo root) so one server
  serves multiple local repos in a session, defaulting to the startup root.
  `search` and `ask` register too when an account is configured (`--db`);
  `ask` reads the one platform database the server was started with, and
  refuses a `path` naming a different repo. Freshness is not a tool: the
  first query builds the index and every query re-syncs it.
- `src/mcp/repos.ts`: the per-repo registry - resolves and validates a
  requested root, one engine connection per repo, LRU-capped.
- `src/mcp/ensure.ts`: auto-index on first query - a query on a
  never-indexed repo builds the index inline, then answers on the same call
  (`CX_AUTO_INDEX=0` restores the strict "index it first" error).
- `src/core/`: the engine-facing core. `chunker` (tree-sitter chunking),
  `indexer` (build + staged readiness + incremental sync), `searcher`
  (find, hybrid search, SQL), `embedder`/`embed-worker` (local model),
  `filestate` (incremental sync state), `walker`, `manifest`, `config`,
  `context`, `output`, `usage` (the local ledger and receipts). `hosted.ts`
  (the platform client - auth, sync, metering) and `retrieval-agent.ts`
  (the `ask` loop) are the platform half; both exist only with an account.
- `src/commands/`: CLI command implementations (`index-cmd`, `query-cmds`).
- `test/`: vitest suites. `docs/`: docs.

## Build, test, gates

```sh
npm ci
npm run build     # tsc
npm test          # vitest
```

CI runs build + tests on Linux and macOS across Node 22/24 (Node 22.19 or
newer is the floor: undici 8 requires it). Keep it green before opening a PR.

## Conventions

- TypeScript, ES modules. Every source file carries an SPDX header.
- The MCP surface is deliberately four tools, one per question: where does
  this exact text occur (`find`, unranked and complete - the grep
  replacement), what is most relevant (`search`, ranked top-k), how much of
  what is where (`sql`), and - with an account - a question worth delegating
  rather than exploring yourself (`ask`, which returns the rows the
  platform's small models retrieved). `read` returns the numbered lines of
  files the index has named, several in one call, beside the four. Adding
  near-duplicate retrieval tools worsens an agent's tool selection; resist
  it. A new tool must answer a question none of these does. An `explore`
  tool was a second platform tool until it was measured: several asks
  issued together answered the same questions faster and for less than its
  long loop. A `reindex` tool was a fourth local tool until it was measured:
  no Sonnet run called it, Haiku called it where it hurt, and auto-sync
  already does the job.
- Search results carry chunk content, a citation (`cite`, `path:start-end`)
  and `path:line` ranges so answers cite code exactly as a hit gives it;
  keep that contract when touching `searcher` or the tool descriptions.
- Tool descriptions and server instructions are prompt text on every turn
  and were measured to steer tool selection sentence by sentence. Change
  them with a measurement, not by taste. The harness that produced these
  numbers is not in this repository: it lives beside the demo it also
  drives, because its lanes name our own hosted arms. A wording change here
  that has not been run through it is a guess, however well it reads.

## Boundaries

SuperGrep is a ranked **content** retrieval layer, not structural code
intelligence. It does not do call-graph tracing, dead-code detection, or type
resolution, and it should not grow to. Tools that do are complementary and
stack alongside it over MCP. Where it wins and where it does not, by kind of
question, is measured on the [README](README.md#where-it-wins-and-where-it-does-not)
and stated plainly; see [docs/tradeoffs.md](docs/tradeoffs.md) for the rest
of the limits.
