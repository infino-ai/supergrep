# Tradeoffs

SuperGrep is a ranked retrieval layer, not a do-everything code tool. Where
it wins and where it does not, measured, is on the
[README](../README.md#where-it-wins-and-where-it-does-not); this page is the
rest of the limits.

### It does not do structural code intelligence

No call-graph tracing, dead-code detection, type resolution, or
symbol-precise references. It ranks and retrieves content and aggregates by
relevance. Tools that resolve structure (LSP servers, graph indexes) are
complementary: MCP servers stack, so run both when you need both.

### The first index of a directory pays a one-time vector cost

Keyword search is live in seconds, but the vector stage embeds every chunk
once. It runs on the platform, in the background, and only happens once;
incremental syncs afterward re-embed only changed files.

### Semantic ranking waits for vectors

Until the vector stage finishes, `search` is keyword-ranked (BM25) and says
so. That is a graceful degrade, not a failure, but meaning-only queries with
no shared vocabulary are weaker until vectors land.

### Retrieval quality depends on the embedding model

The platform embeds with its own model by default. `--embed-provider local`
embeds on this machine with a small local model and ships the vectors
instead; that model optimizes quality-per-minute on commodity hardware, and
the choice is documented in [the embedder eval](embedder-eval.md).

### The platform copy puts the network in the build

With an account every build and every sync also writes the platform table,
over HTTPS, and a database that is not yet ready is retried for a bounded
time (`--cold-start-secs`) before the client gives up. `find` and plain `sql`
never wait on it: they read the local index. `search`, a `sql` statement with
a ranked search in it, and `ask` run on the platform copy, so they are as
available as the network is. A sync is not done until both sides have the
diff, and a platform failure is reported and retried by the next sync rather
than papered over.

### Very large or hostile directories

Indexing scales roughly linearly with the tree. Pathological files (parser
stress fixtures, generated blobs) fall back to fixed-window chunking under a
per-parse deadline so a single file cannot stall a run. Two caps bound the
work, `CX_MAX_FILES` (500,000) and `CX_MAX_FILE_BYTES` (1 MB); a tree over
the file cap is indexed partially, and every result says so. The
[FAQ](faq.md#what-happens-on-a-repo-too-big-to-index-fully) has the detail.
A corpus that should not pass through a laptop at all is indexed
[from object storage](../README.md#indexing-from-object-storage) instead.
