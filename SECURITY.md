# Security Policy

## Reporting a vulnerability

Please report security issues **privately** - do not open a public issue for a
suspected vulnerability.

Use GitHub's private vulnerability reporting: open the repository's **Security**
tab and click **"Report a vulnerability."** We aim to acknowledge reports within
a few business days and will keep you updated on the fix.

## Data handling

SuperGrep has two modes, and they have different data-handling properties.
Which one you are in is your own choice: no account for the first; `cx
login --platform` (which asks you first), `cx login --yes` with a key you
have, or `--db` by hand for the second. The agent is never the one who
agrees: the server tells the model to hand the sign-in to you rather than
run it, and the sign-in asks at the terminal before it creates or sends
anything.

**Local-only (no account):** everything runs **locally** -
indexing, storage (`.infino/` in your repo), and the tools it gives you,
`find`, plain `sql` and `read`. The MCP server is a local subprocess over stdio - no
network listener, no remote service, no telemetry, no embedding model
downloaded or run. Your code is never sent to any API, and there is no key
to provision. (Running the server via `npx` also contacts the npm registry;
install the package for fully offline use.) Semantic ranking (`search`) is
not part of this mode: it is a platform capability, so it needs an account.

**With an account (`find` and plain `sql` still local; `search`, a `sql`
statement with a ranked search in it, and `ask` run in the cloud):** the
chunks your index holds - `path`, `start_line`, `end_line`, `lang`, `symbol`
and the code `content` itself - are loaded into a platform database: one of
the directory's own on your account, the first time you use `search` or
`ask` in it (a directory you only `find` in is never uploaded), or one you
name with `--db`, over HTTPS (plain `http://` is accepted for a loopback
host only). A bearer key authenticates every request; it is never passed as
a command-line argument (arguments are visible to every process on the
machine) - it comes from `login`'s own consent-and-store flow, a file
(`--api-key-file`), or the `INFINO_API_KEY` environment variable. By
default the platform's own model embeds that copy server-side
(`--embed-provider local` keeps embedding on this machine and ships the
vectors instead). `search`, a ranked `sql` statement and `ask` send your
question or code to that platform and answer from what it retrieves;
`find` and plain `sql` never leave the local index. If you need the
local-only mode's guarantees, do not sign in (`cx login --logout` undoes
it) and do not pass `--db`.

- Mutating SQL is rejected by client-side statement filtering (a single
  SELECT/WITH statement is allowed) on both the local and the platform
  table. The local index is a derived artifact: it is rebuilt from your
  working tree by `cx index --full` at any time, so it is never the only
  copy of anything.
- Per-directory `.gitignore` files are respected at every level, so files
  ignored there (secrets, envs, build output) stay out of the index, local
  or platform. Global git excludes and `.git/info/exclude` are NOT read -
  keep secrets ignored in-repo if you rely on this. Add `.infino/` to your
  `.gitignore` to keep the local index out of commits.
- The free account created by `login --platform` asks for no email and no
  card, so the key it stores at `~/.infino/key` (mode 600) is the only
  thing that identifies you: back it up.

## Supported versions

Security fixes are released against the latest published version on npm
([`@infino-ai/code-context`](https://www.npmjs.com/package/@infino-ai/code-context)).
