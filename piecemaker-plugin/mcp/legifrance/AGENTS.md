# Légifrance MCP — agent instructions

## Scope

These instructions apply to this directory and all descendants. Treat this
MCP server as a standalone Python project. It may be distributed by another
product, but its runtime, tests, configuration, and documentation must never
depend on that product's installer, daemon, hooks, agents, or directory layout.

## Mission

Expose French official legal sources through MCP over local stdio. Preserve
source fidelity, reproducibility, exhaustive-search telemetry, and explicit
failure reporting. Legal conclusions remain the caller's responsibility.

## Runtime contract

- Primary entry point: `mcp_stdio_server.py`.
- Optional shared-local entry point: `mcp_http_local.py`, bound only to
  `127.0.0.1`; configure its port with `LEGIFRANCE_MCP_PORT` (default `8765`).
- Transport: one JSON-RPC 2.0 message per line on stdin/stdout.
- Reserve stdout exclusively for JSON-RPC responses; send every log to stderr.
- Keep `initialize`, `ping`, `tools/list`, and resource discovery functional
  without API credentials. Only network-dependent tool calls may fail.
- Read configuration from environment variables or a local `.env`; never from
  an installer-owned configuration file.
- Required for Légifrance calls: `LEGIFRANCE_CLIENT_ID` and
  `LEGIFRANCE_CLIENT_SECRET`.
- Optional: `LEGIFRANCE_ENV=production|sandbox`, `LEGIFRANCE_DEBUG=1`, and
  `LEGIFRANCE_ENV_FILE=/absolute/path/to/.env`.
- Never print credentials, OAuth tokens, request authorization headers, or
  confidential user content.

## Standalone setup

From this directory:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python mcp_stdio_server.py
# Or, for a shared loopback-only service:
.venv/bin/python mcp_http_local.py
```

Any MCP client can launch the absolute path to `mcp_stdio_server.py` with the
four environment variables above. Do not require plugin-specific placeholders.

## Architecture

```text
legifrance/
├── AGENTS.md                  # standalone operating contract
├── mcp_stdio_server.py        # JSON-RPC/MCP stdio entry point
├── mcp_http_local.py          # optional loopback HTTP adapter
├── requirements.txt           # complete Python runtime dependencies
├── config/
│   ├── mcp_definitions.py     # public schemas
│   └── settings.py            # environment and official endpoints
├── tools/
│   ├── handlers.py            # tool dispatch and responses
│   ├── legifrance_client.py   # PISTE/Légifrance HTTP boundary
│   ├── research_corpus.py     # exhaustive no-RAG pipeline
│   └── ...                    # parsers and other domain clients
├── resources/                 # static MCP resources
└── tests/                     # offline tests owned by this MCP
```

- `config/mcp_definitions.py`: public MCP tool/resource/prompt schemas.
- `config/settings.py`: environment-only configuration and endpoints.
- `tools/handlers.py`: argument-to-domain handler boundary and tool registry.
- `tools/legifrance_client.py`: authenticated PISTE HTTP client.
- `tools/research_corpus.py`: fixed-corpus exhaustive research and validation.
- `resources/`: static MCP resources.
- `tests/`: offline unit and protocol tests.

Keep tool schemas, handler registration, tests, and user-facing documentation
in sync. Domain logic belongs in focused modules, not the stdio loop.

## Exhaustive research invariants

`Build_Research_Corpus` and `Validate_Research_Cards` implement a no-RAG path:

- no embeddings, vector database, semantic top-k, or hidden preselection;
- paginate every declared query up to explicit, reported limits;
- deduplicate by official Légifrance identifier;
- download and scan every available full decision in the fixed manifest;
- preserve every download failure and every truncation in telemetry;
- create one card per downloaded decision; code may close only texts that fail
  a documented broad Boolean test, while every candidate goes to the model;
- include every anchor context for candidates, never a similarity-selected top-k;
- require literal source-substring quotations for legal propositions;
- validate identifiers, cardinality, schema, and quotations statically;
- label character-based token counts as estimates, never provider usage;
- accept exact token usage only when the caller supplies provider telemetry.

A lexical score may order an audit index, but must never remove a decision from
the batches or the validation set.

## Development rules

- Use Python 3 and UTF-8.
- Keep code and operational messages clear in French; stable protocol names
  and conventional technical terms may remain in English.
- Add no framework when the standard library is sufficient.
- Set HTTP timeouts and return actionable errors without secrets.
- Keep official identifiers, dates, decision text, and quotations unmodified.
- Do not silently retry forever; bound retries and record terminal failures.
- Avoid writes outside caller-selected output directories. A default output
  location must be MCP-owned and must not assume another application exists.
- Do not modify parent-project files to implement or test MCP behavior.

## Verification

Run offline tests after every change:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py'
```

Smoke-test protocol discovery without credentials:

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | PYTHONDONTWRITEBYTECODE=1 python3 mcp_stdio_server.py
```

For live tests, use an explicit temporary output directory, report API calls,
identified/downloaded/scanned/failed decisions, limits, and token methodology,
then remove no evidence unless the user asks. Never commit credentials, `.env`,
downloaded corpora, logs, caches, or generated legal reports.

## Definition of done

A change is complete only when standalone startup still works, schemas match
handlers, offline tests pass, stdout remains valid JSON-RPC, failure modes are
explicit, and no dependency on a parent installer or host application has been
introduced.
