# Security Policy

## Reporting a vulnerability

Please report security issues **privately** - do not open a public issue for a
suspected vulnerability.

Use GitHub's private vulnerability reporting: open the repository's **Security**
tab and click **"Report a vulnerability."** We aim to acknowledge reports within
a few business days and will keep you updated on the fix.

## Data handling

SuperGrep has two modes, and they have different data-handling properties.
Which one you are in is your own choice: `install` with no flags for the
first, `install --platform` (or `--db` by hand) for the second.

**Local-only (`install` with no flags):** everything runs **locally** -
indexing, storage (`.infino/` in your repo), search, and embedding. The MCP
server is a local subprocess over stdio - no network listener, no remote
service, no telemetry. The embedding model (~25 MB) is downloaded once from
huggingface.co on first use; after that there is no network at query or
index time. Your code is never sent to any API, and there is no key to
provision. (Running the server via `npx` also contacts the npm registry;
install the package for fully offline use.) This mode gives you `find` and
plain `sql`, nothing else.

**With an account (`find` and plain `sql` still local; `search`, a `sql`
statement with a ranked search in it, and `ask` run in the cloud):** the
chunks your index holds - `path`, `start_line`, `end_line`, `lang`, `symbol`
and the code `content` itself - are loaded into a platform database you
name, over HTTPS (plain `http://` is accepted for a loopback host only). A
bearer key authenticates every request; it is never passed as a
command-line argument (arguments are visible to every process on the
machine) - it comes from `install`'s own consent-and-store flow, a file
(`--api-key-file`), or the `INFINO_API_KEY` environment variable. By
default the platform's own model embeds that copy server-side
(`--embed-provider local` keeps embedding on this machine and ships the
vectors instead). `search`, a ranked `sql` statement and `ask` send your
question or code to that platform and answer from what it retrieves;
`find` and plain `sql` never leave the local index. If you need the
local-only mode's guarantees, do not pass `--platform` or `--db`.

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
- The free account created by `install --platform` asks for no email and no
  card, so the key it stores at `~/.infino/key` (mode 600) is the only
  thing that identifies you: back it up.

## Supported versions

Security fixes are released against the latest published version on npm
([`@infino-ai/code-context`](https://www.npmjs.com/package/@infino-ai/code-context)).
