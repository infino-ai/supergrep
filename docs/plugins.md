# Building on SuperGrep

Plugins and hosted pages run the same published server as everyone else and
set it up with environment variables, never with a fork. This page is the
contract: the settings a consumer may rely on, what each one does, and the
tools each kind of consumer is offered. It is versioned with the package. A
release that changes a setting's meaning or a consumer's tool list says so in
its notes.

`test/consumers-code.test.ts` and `test/consumers-table.test.ts` pin the tool
lists below, for the settings each row names. A change that adds a tool to one
of those consumers changes those tests and this page in the same pull request.
The tools that depend on an account's agent routes or on the data
(`web_fetch`, `page`, `describe_columns`) are not pinned beyond what the rows
say.

## One primary corpus

A server reads one corpus by default, chosen at startup:

| corpus | how it is chosen |
|---|---|
| the code index | the default: the repository at `CX_ROOT`, or the current directory |
| one table of an account | `CX_TABLE=<table>` with a platform database (`--db`) |

Everything else stacks on top of that corpus with its own switch.

## How much of the account a server reaches

With a platform, a server reaches as much of the account as `CX_ACCOUNT_DATA`
says:

| `CX_ACCOUNT_DATA` | the server reaches |
|---|---|
| `account`, the default (also `1`, `true`, `yes`) | every database the key may see: the `tables` and `hydrate` tools, and the `database` argument of the query tools |
| `database` (also `0`, `false`, `no`) | its own database only. Every table in it is described in the `sql` text, and `sql` and `join_keys` may join them |
| `table` | the one table it was started for. The other tables of its database are not described, `join_keys` is not offered, and a `sql` statement that names one is refused before it runs |

Any other value stops the server at startup. Whatever the key could see beyond
the scope, the server does not reach.

## Switches a consumer may set

| variable | default | what it does |
|---|---|---|
| `CX_TABLE` | `chunks` | the table the server reads, for a table loaded by something other than `cx index` |
| `CX_ACCOUNT_DATA` | `account` | how much of the account the server reaches, as above |
| `CX_READ_ONLY` | off | `1` offers no tool that writes: `hydrate` and `hydrate_cancel` are not registered |
| `CX_API_TOOLS` | off | `1` offers the platform's routes as tools (`table_card`, `validate`, and `cite` on the code index), and `sql` then carries no card or verdict of its own |
| `CX_CARD_TIER` | `enriched` | the card folded into the `sql` text: `enriched`, or `lean` |
| `CX_MEMORY` | off | `1` recalls the database's memory beside the platform's searches |
| `CX_WEB_FETCH` | off | `1` offers `web_fetch` on an account with the agent routes |
| `CX_PLAYBOOK` | none | a playbook file whose bullets are added to the server's instructions |
| `CX_STARTUP_CACHE_SECS` | 0 | how long the startup's reads of the database are kept, so a server restarted inside the window starts without asking again |

The indexing and search settings in [the reference](reference.md#configuration)
(`CX_ROOT`, `CX_INDEX_DIR`, `CX_AUTO_INDEX`, `CX_AUTO_SYNC`, `CX_NO_EMBED` and
the rest) are part of the contract as well.

Two tools depend on the data rather than on a switch:

- `describe_columns` is offered when a table's card maps its columns or names
  the column that tells its kinds of row apart.
- `page` is offered when the platform says a table's rows were made from
  documents it can read back a page of.

## The tools each consumer is offered

| consumer | settings | tools |
|---|---|---|
| code search, no account | none | `find`, `read`, `sql` |
| code search with an account | `--db` or a stored login | `find`, `read`, `search`, `sql`, `join_keys`, `tables`, `hydrate`, `hydrate_status`, `hydrate_cancel` |
| the same, read-only | `CX_READ_ONLY=1` | as above, without `hydrate` and `hydrate_cancel` |
| a table of an account | `CX_TABLE` | `find`, `search`, `sql`, `join_keys`, `tables`, `hydrate`, `hydrate_status`, `hydrate_cancel` |
| a hosted page over one database | `CX_TABLE`, `CX_ACCOUNT_DATA=database` | `find`, `search`, `sql`, `join_keys`, and `describe_columns` where the card allows |
| an agent's own table | `CX_TABLE`, `CX_ACCOUNT_DATA=table` | `find`, `search`, `sql` |

`CX_API_TOOLS=1` adds `table_card` and `validate` to any consumer with an
account, and `cite` on the code index.

## What a plugin keeps to itself

A plugin adds its own code on top only where it differs from these settings:
its own memory, its own recall, its own way of starting the server. The
[Hermes plugin](../hermes_supergrep/) is one: it starts the server per
repository and indexes each one, and nothing about that is a server setting.
