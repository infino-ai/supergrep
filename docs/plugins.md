# Building on SuperGrep

Plugins and hosted pages run the same published server as everyone else and
set it up with environment variables, never with a fork. This page is the
contract: the settings a consumer may rely on, what each one does, and the
tools each kind of consumer is offered. It is versioned with the package. A
release that changes a setting's meaning or a consumer's tool list says so in
its notes.

`test/consumers-code.test.ts` and `test/consumers-table.test.ts` pin the tool
lists below. A change that adds a tool to a consumer changes those tests and
this page in the same pull request.

## One primary corpus

A server reads one corpus by default, chosen at startup:

| corpus | how it is chosen |
|---|---|
| the code index | the default: the repository at `CX_ROOT`, or the current directory |
| one table of an account | `CX_TABLE=<table>` with a platform database (`--db`) |

Everything else stacks on top of that corpus with its own switch.

## Switches a consumer may set

| variable | default | what it does |
|---|---|---|
| `CX_TABLE` | `chunks` | the table the server reads, for a table loaded by something other than `cx index` |
| `CX_TEXT_COLUMN` | chosen from the table's shape | with `CX_TABLE`, the column searched on a table with several indexed text columns |
| `CX_ACCOUNT_DATA` | on with a platform | `0` turns off the account's other databases: `tables`, `hydrate`, `hydrate_status`, `hydrate_cancel`, and the `database` argument of the query tools. The server then reads its own corpus and nothing else of the account |
| `CX_READ_ONLY` | off | `1` offers no tool that writes: `hydrate` and `hydrate_cancel` are not registered |
| `CX_API_TOOLS` | off | `1` offers the platform's routes as tools (`table_card`, `validate`, and `cite` on the code index), and `sql` then carries no card or verdict of its own |
| `CX_SIBLING_TABLES` | none | comma-separated tables beside the primary that `sql` may join; their schemas go into the `sql` text |
| `CX_SIBLING_NOTES` | none | what the model is told about the siblings beyond their columns, such as the keys that join them |
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
| an agent's own table | `CX_TABLE`, `CX_ACCOUNT_DATA=0` | `find`, `search`, `sql`, `join_keys` |
| a hosted page over one data table | `CX_TABLE`, `CX_ACCOUNT_DATA=0` | `find`, `search`, `sql`, `join_keys`, and `describe_columns` where the card allows |

`CX_API_TOOLS=1` adds `table_card` and `validate` to any consumer with an
account, and `cite` on the code index.

## What a plugin keeps to itself

A plugin adds its own code on top only where it differs from these settings:
its own memory, its own recall, its own way of starting the server. The
[Hermes plugin](../hermes_supergrep/) is one: it starts the server per
repository and indexes each one, and nothing about that is a server setting.
