# PieceMaker — CLAUDE.md

PieceMaker is a local HTTPS service with a browser administration interface
and a Microsoft Word task-pane add-in for French legal professionals: document anonymisation (GDPR),
AI-assisted legal research/drafting, case-file (pièces) management, and
exhibit stamping (bordereau de pièces). This file orients an agent working in
this repo — read it before touching `websocket-server/` or `taskpane/`.

## What actually runs

- **`admin/`** — local browser administration UI for settings, the general
  Telegram assistant, one assistant per legal-case directory, the global
  non-LLM monitor, visual skill/agent Markdown editing, and the per-case
  pieces frame (Markdown conversion, local PII pipeline, mapping editor, and
  the per-file protection toggle — see "Piece protection" and "Originals
  pipeline" below), served at `/admin/`.
  The "Skills et agents" file list is restricted to the repo's own hierarchies
  — `CLAUDE.md`/`AGENTS.md`, `piecemaker-plugin/skills/`,
  `piecemaker-plugin/agents/`. The billing ledgers and syntheses under
  `~/.piecemaker/billing/` are a separate hierarchy and are no longer listed
  there (`readManagedFile` still renders them read-only if a path is given).
  Original-document contents must never be read by this UI; original filenames
  are returned only after mapping substitution, with a generic fallback.
  Skills and agents created here are registered with Claude Code immediately —
  see "Claude Code registration" below.
- **`electron/`** — legacy desktop shell, retained as source history but
  disabled in `package.json`; do not add new functionality to it.
- **`websocket-server/server.cjs`** (4449 lines) — single Express server that
  is simultaneously: the REST API, the static file host for the task pane,
  and the WebSocket endpoint. Everything the add-in does goes through this
  one file.
- **`taskpane/`** — the Word add-in itself (loaded by Word via
  `taskpane/manifest.xml`-style sideload). `taskpane/taskpane.js` (6613
  lines) is the frontend entry point/monolith; `taskpane/modules/` holds the
  handful of things that have been extracted out of it as ES6 modules.
- **`websocket-server/scripts/`** — Python scripts invoked as child
  processes by the server (document conversion, PII scanning).
- **`mcp-server/`** — MCP protocol server exposing Word-document tools
  (`read_doc`, `edit_doc`, `read_case`, `get_resource`, `draft`,
  `template_library`, `Stamping`, `Call_Ollama`) to an MCP client (e.g.
  Claude Desktop) over stdio. It talks to `server.cjs` over HTTPS, which
  relays to the task pane over WebSocket, which executes Office.js — see
  "MCP tool flow" below.

`docs/architecture.md` and `ARCHITECTURE_FIX.md` describe an earlier layout
(`addon/taskpane.js`, `addon/server.cjs`); the code has since been split into
`websocket-server/` (backend) and `taskpane/` (frontend). Treat those two
docs as historical context for *why* things are shaped the way they are, not
as a map of current file paths — trust the paths in this file instead.

## Transport architecture

```
Word (task pane)  ──wss://localhost:43098──►  server.cjs (WebSocket)
Word (task pane)  ──https://localhost:43098──► server.cjs (REST, same server)
Browser (admin)   ──https://localhost:43098/admin/──► admin API + Telegram state + allowlisted Markdown/billing files
Claude Desktop (MCP client) ──stdio──► mcp-server/ ──HTTPS──► server.cjs ──WS──► task pane ──Office.js──► Word doc
```

- One HTTPS server (`websocket-server/server.cjs`), created with
  `https.createServer(options, app)`, hosts both Express (REST) and a `ws`
  `WebSocketServer` attached to the same `server` instance. Port comes from
  `process.env.PORT`, default `43098`.
- `app.use(express.static(path.join(__dirname, '..', 'taskpane')))` at
  **server.cjs:72** serves the task pane's static assets directly off this
  same server — there is no separate frontend dev server.
- The WebSocket connection handler is `wss.on('connection', ...)` around
  **server.cjs:4160**; inbound messages are dispatched by a
  `switch (data.type)` around **server.cjs:4169**. Message types include
  `pty-start` / `pty-input` / `pty-resize` / `pty-stop` (Claude CLI terminal),
  `python-exec` / `python-exec-batch` / `python-cancel` (Python bridge), and
  the ad hoc types used for MCP tool relaying / chat.
- REST endpoints all live in `server.cjs` as `app.get/post/put/delete(...)`
  calls — there are ~50 of them, roughly grouped as: AI provider proxies
  (`/api/claude`, `/api/openai`, `/api/mistral`, `/api/ollama`, `/api/mcp`),
  Word document ops (`/api/word/*`), anonymisation (`/api/anonymize/*`,
  partly delegated to a router — see below), Python bridge
  (`/api/python/*`), and legal workflow endpoints (`/api/word/draft-conclusions`,
  `/api/word/template-library`, `/api/word/stamping`, `/api/tampon/*`).

## PTY terminal (Claude CLI)

Around **server.cjs:3740** ("TERMINAL PTY POUR CLAUDE CODE CLI") the server
spawns a PTY per WebSocket client and streams its output back as
`pty-output` / `pty-exit` / `pty-error` / `pty-config` WebSocket messages.
This is how the add-in embeds an interactive Claude Code terminal inside
Word. Client-side wiring is in `taskpane/modules/cli-terminal.js`, following
the module pattern below.

## Python bridge — how to add a script

Server-side registry: the `PYTHON_SCRIPTS` object at **server.cjs:3856**.
Each entry is `{ path, python, description }`:

```js
const PYTHON_SCRIPTS = {
  convert: {
    path: process.env.SMART_CONVERTER_PATH || path.join(__dirname, 'scripts', 'smart_converter.py'),
    python: process.env.PYTHON_PATH || 'python3',
    description: 'Smart Document Converter — auto-routes to markitdown or MinerU'
  },
  'convert-scan': { ... }
  // add new scripts here
};
```

To register a new script: add an entry here (the file has a commented
example immediately below the object). Nothing else on the server needs to
change — upload, spawn, and streaming are generic.

Flow: the client uploads the file via `POST /api/python/upload` (raw
octet-stream, filename in the `X-Filename` header; per-document uploads go to
`output/<documentId>/_uploads/`, otherwise to
`output/_python_uploads/`), then sends a `python-exec` (or
`python-exec-batch`) WebSocket message referencing the `scriptId` and
uploaded `filePath`. The server spawns `python <path> ...` as a child
process, streams stdout/stderr back as `python-output` messages, and finishes
with `python-done` or `python-error`. Output for a job lands in
`output/<jobId>_output/`. `cleanupPythonProcesses(ws)` kills any child
processes still running for a client when its WebSocket closes/errors.

Client side: `taskpane/modules/python-bridge.js` exports
`executePythonScript(scriptId, file, options, callbacks)` and
`executePythonScriptBatch(...)`, both driven by `initPythonBridge(deps)`
called from `Office.onReady` in `taskpane.js`. `handlePythonMessage(message)`
routes `python-output` / `python-done` / `python-error` to the right
per-job callback.

## Anonymisation and mapping — two different pipelines, don't confuse them

1. **Bulk document anonymisation** (`POST /api/anonymize/process`, around
   **server.cjs:644**): the client extracts text from uploaded files
   client-side and posts `extractedTexts` (not raw files, for speed). The
   server does **not** anonymise locally for this path — it forwards the
   texts to a **remote** MCP endpoint
   (`https://mcp.festival-letino-app.com/mcp-remote/api/anonymize/process`,
   authenticated with `MCP_API_KEY`), then polls
   `.../api/anonymize/result/<jobId>` every 60s until the remote service
   returns `mapping` + `reverse_mapping`. Progress/status is tracked in the
   in-memory `anonymizationJobs` Map and exposed via
   `GET /api/anonymize/status/:jobId`. On completion the server writes:
   - `output/mapping_<documentId>.json` — `{ mapping, reverse_mapping }`
   - `output/compilation_dossier_<documentId>.json` — dossier metadata +
     per-document entries.
2. **Local PII scanning** (GLiNER/Presidio, no network call): the standalone
   script `websocket-server/scripts/presidio-gliner/presidio-gliner.py`
   scans a Markdown file for PII with a Presidio `AnalyzerEngine` + a custom
   GLiNER2 `LocalRecognizer`, and writes
   `<output_dir>/<stem>_sensitive_map.json`. `smart_converter.py` (see
   below) is typically run first to get Markdown, and
   `convert_and_scan_pipeline.py` chains the two for batch use, emitting
   `PROGRESS:CONVERT:...` / `PROGRESS:SCAN:...` lines on stdout. This local
   scan is separate from the remote anonymisation job above — it is what the
   `anonymisation` skill (see `piecemaker-plugin/skills/anonymisation/`) and
   the Python bridge's `convert-scan` entry drive.

**Mapping storage/editing API** —
`taskpane/modules/anonymization-server.cjs` mounts a router at
`app.use('/api/anonymize', createAnonymizationRoutes(getOutputPath))`
(**server.cjs:87**). It owns `mapping_<documentId>.json` on disk and an
in-memory `anonymizationMappings` Map, exposing
`GET/PUT/DELETE /api/anonymize/mapping/:documentId` and
`POST /api/anonymize/text` (apply/reverse a mapping to an arbitrary string,
direction `anonymize` or `deanonymize`).

**The substitution engine lives in the plugin** —
`piecemaker-plugin/scripts/lib/mapping.cjs` owns `buildEntityRegex`,
`escapeWithVariants`, `byDescendingEntityLength`, the case-mapping file
resolution (`caseMappingFile` / `normalizeMappingDocument` / `readCaseMapping`)
and the two substitutions `applyMapping` (entity → code) and `revertMapping`
(code → entity). Three consumers require it: the hooks, the admin pipeline
(`originals-pipeline.cjs`, which re-exports the file helpers) and
`anonymization-server.cjs`. It sits in the plugin because the hooks are the one
consumer that ships alone — a hook cannot require `websocket-server/` or
`taskpane/`. Entries are always applied **longest-entity-first**, so a short
name that is a substring of a longer one ("Dupont" inside "Jean Dupont-Martin")
never gets replaced first and corrupts the longer match; `revertMapping` sorts
codes the same way so `PERSONNE_PHYSIQUE_1` cannot eat `PERSONNE_PHYSIQUE_12`.
Both directions are idempotent, which is what lets the hooks run without
tracking what has already been substituted.

## Piece protection and the anonymisation hooks

`docs/anonymisation-hooks.md` is the full account of this boundary — the
execution contract, why the substitution has no size ceiling, how to prove the
chain works on a real case, and why a hook edit needs a `claude plugin update`
before it affects anything. What follows is the summary.

The protection boundary is a property of the **file**, not of its location.
`piecemaker-plugin/scripts/lib/protection.cjs` owns it:

- Everything under a legal case that is not `.md` or `.json` is **protected by
  default**; `<case>/.piecemaker/protection.json` records only the
  *exceptions* (`{ version: 1, unprotected: [...] }`). A piece dropped into a
  case between two visits to `/admin/` is therefore protected with no action.
  `.md`/`.json` are never protected — they are the surfaces the hooks
  anonymise on the fly. The one exception is `isMappingFile`: `mapping*.json`
  and `*_sensitive_map.json` are refused to the model on `Read`/`Grep`/`Glob`/
  `Bash` with no exception possible — reading the mapping de-anonymises the
  whole case at once. It is enforced in `protect-originals.mjs`, not in
  `isProtectedFile`, so case history keeps versioning the mapping.
- `locateCase` / `relativeKey` resolve **both** sides through `realpath`. On
  macOS a `/var/…` tool argument against a `/private/var/…` root never
  overlaps, which silently protected nothing.
- The earlier rule keyed on a "Pièces originales" subfolder is gone
  (`isOriginalDirectoryName` / `isProtectedOriginalPath` no longer exist): a
  firm that files its pieces flat, next to the Markdown they were converted
  from — the common case — got no protection at all.

Four hooks, wired in `piecemaker-plugin/hooks/hooks.json`:

| Event | Matcher | Script |
| --- | --- | --- |
| `PreToolUse` | `Read\|Grep\|Glob\|Bash` | `protect-originals.mjs` — denies a protected piece, pointing at its `.md` |
| `PostToolUse` | `Read\|Grep\|Glob\|Bash` | `anonymize-read.mjs` — `updatedToolOutput` with the mapping applied |
| `PreToolUse` | `Write\|Edit\|mcp__telegram__reply\|mcp__telegram__edit_message` | `deanonymize-write.mjs` — `updatedInput` with the mapping reversed |
| `PostToolUse` | `Write\|Edit` | `commit-track.mjs` — case commit, label reversed |

- **Files on disk are never rewritten.** Only the tool *result* handed to the
  model is coded, and only the tool *input* about to be executed is restored.
  The firm keeps readable Markdown; no real name reaches the API.
- `Edit` has **both** `old_string` and `new_string` reversed. The model read the
  file through the mapping, so its `old_string` carries codes while the disk
  carries names — reversing only `new_string` would fail every edit on "string
  not found".
- Telegram is covered because outgoing messages go through the plugin's MCP
  `reply` tool (`telegram/server.ts`), not through the harness channel — a
  `Stop` hook could not have rewritten them.
- `Bash` is guarded on both sides. This is what closes the hole opened by the
  `docx` skill, which works through `pandoc`, `unzip` and
  `python ooxml/scripts/unpack.py`. `commandPaths` keeps only tokens that
  resolve to an **existing file**, otherwise the program name itself
  (`pandoc`) resolves to `<case>/pandoc` — extensionless, hence "protected" —
  and every command was denied.
- **The hooks never scan.** No GLiNER, no regex heuristics (`pre-anonymize.mjs`
  and `post-anonymize.mjs` were removed). Scanning stays in the admin pipeline,
  the only place the NER models are loaded — loading them per read would make a
  session unusable.
- Every hook fails open: no config, no mapping, or an unrelated path all end in
  exit 0 with empty stdout, and `anonymize-read.mjs` stays silent when the
  substitution changes nothing so `Read` keeps its native line numbering.

## Originals pipeline (admin)

`websocket-server/originals-pipeline.cjs` drives the per-case pieces frame in
`/admin/`. It is the *local* pipeline (`smart_converter.py` then
`presidio-gliner.py`), never the remote bulk anonymisation job.

- `originalFilesOverview` (`commits.cjs`) walks the **whole case recursively**.
  A piece is any file that is not `.md`/`.json`; each carries `converted` /
  `scanned` (pipeline state, `status` is `ready` / `awaiting-scan` /
  `not-converted`) and `protected` (the admin decision). Traversal skips
  dotfiles, symlinks, `IGNORED_DIRECTORY_NAMES` (`node_modules`, `dist`, …) and
  MinerU output directories — a directory whose `documentKey` matches a sibling
  file. Without those skips the test case listed 47 000 entries, and
  `node_modules` `package.json` files were entering case history through
  `safeCaseFiles`. The list is capped at `MAX_ORIGINALS` with a `truncated`
  flag.
- `GET /api/admin/repository/case` returns that list; `GET/PUT
  /api/admin/protection` reads and writes `protection.json` (the PUT takes the
  full `unprotected` list, since only exceptions are stored). The admin column
  offers a "Non traitées / Toutes" scope and a per-row shield toggle — the
  pipeline selection checkbox stays restricted to pieces still to process.
- `GET /api/admin/repository` also carries a `mapping` summary
  (`{ exists, name, entries }` — counts only, never entity contents).
- `POST /api/admin/originals/pipeline` (`action: 'convert' | 'anonymize'`)
  starts a background job scoped to one case and returns its id. `files` are
  paths **relative to the legal-case root**, not to any subfolder;
  `GET/DELETE /api/admin/originals/job?id=` polls or cancels it. Both scripts
  run with the legal-case directory as their output dir, so the `.md` and
  `*_sensitive_map.json` land next to the files already versioned. Only
  `PROGRESS:` lines and a short stderr tail are kept in a job's log — raw
  script stdout can carry document text.
- **A job with no `files` covers the whole case and only redoes what is
  missing** (no Markdown, or no `*_sensitive_map.json`); listing `files`
  explicitly — or `force: true` — reprocesses exactly those. When nothing is
  left to do the route returns an already-`done` job and spawns nothing, so
  GLiNER's ~400MB of weights never load for an up-to-date case. The same
  decision is taken again per file inside `convert_and_scan_pipeline.py` via
  `--skip-existing`, which also holds the scanner worker back until it knows at
  least one file needs scanning.
- The individual `*_sensitive_map.json` are **kept** after the merge (the
  script only deletes them with `--cleanup-scans`): they are what tells a
  scanned original from an unscanned one in the admin list, and what
  `rebuildCaseMapping` merges. Deleting them made every piece look unscanned
  and sent GLiNER over the whole case on every run.
- The case mapping is `<case>/mapping_dossier.json` (that name wins; otherwise
  an existing `mapping*.json` is reused), read/written via
  `GET/PUT /api/admin/mapping` and rebuilt from the scans by
  `POST /api/admin/mapping/rebuild`. The pipeline is pointed at that same file
  with `--mapping-file` — without it, it wrote its own `mapping_default.json`
  next to it, which then shadowed the case mapping. Entries are stored
  longest-entity-first, a code is never reused, and an entry deleted in the
  admin editor is recorded under `ignored` so neither the next rebuild nor the
  Python merge reintroduces that false positive.
- Codes and variants are shared ground between the CLI pipeline and the admin:
  `rebuildCaseMapping` (`originals-pipeline.cjs`) mirrors
  `convert_to_anonymization_format` / `consolidate_duplicate_entities` — same
  code vocabulary (`PERSONNE_PHYSIQUE_NN`, `PERSONNE_MORALE_NN`,
  `SOCIETE_<forme>_NN`, `ADRESSE_NN`), same per-category counters, and the
  several spellings of one person ("M. Gilly", "Bernard Gilly") join a single
  code instead of each getting one. `extracted_data` (variants, parsed
  addresses) is written by the Python side and must survive an admin
  save/rebuild untouched — the partial de-anonymisation of addresses reads it
  (`anonymization-server.cjs`).

## Document conversion

`websocket-server/scripts/smart_converter.py` — CLI: positional `file`,
`-o`/`--output` (required), `--engine {auto,markitdown,mineru}` (default
`auto`), `--mode` (MinerU mode: pipeline/hybrid/vlm), `--lang` (OCR language
code). `auto` inspects the file and picks `markitdown` for regular
text-layer documents (docx, clean PDFs) and `mineru` for scanned/
image-based PDFs that need OCR. Registered server-side as the `convert`
Python-bridge script (see `PYTHON_SCRIPTS` above).

## Module pattern (`taskpane/modules/*.js`)

- ES6 modules, one per concern (`cli-terminal.js`, `python-bridge.js`,
  `doc-tools.js`, `anonymization.js`, `ollama-analyzer.js`; the one `.cjs`
  file, `anonymization-server.cjs`, is server-side, required from
  `server.cjs`, not a browser module).
- Each browser module exports `initXxx(deps)`, called once from
  `Office.onReady` in `taskpane.js`, which injects whatever the module needs
  (state getters, callbacks) rather than importing `taskpane.js` globals
  directly — see `ARCHITECTURE_FIX.md` for why (`doc-tools.js` needs
  `anonymizeText` and `draftConclusionsState` from `taskpane.js`, injected
  via `initDocToolsDependencies({...})`).
- `ws` (the WebSocket) is assigned asynchronously by `connectWebSocket()` in
  `taskpane.js`. Never capture it by value in a module — pass it as a
  getter, e.g. `get ws() { return ws; }`, so modules always see the live
  connection.
- WebSocket message routing in `taskpane.js`'s `ws.onmessage`: check
  `message.type.startsWith('<prefix>-')` and delegate to the matching
  module's handler (e.g. `pty-*` → `cli-terminal.js`, `python-*` →
  `python-bridge.js`).

## MCP tool flow (example: `read_doc`)

1. MCP client calls tool `read_doc` over stdio → `mcp-server/`.
2. `mcp-server/` validates args with Zod, POSTs to
   `https://localhost:43098/api/word/read-doc`.
3. `server.cjs`'s handler broadcasts a WebSocket message
   (`{ requestId, action: 'read_doc', params }`) to connected task-pane
   clients.
4. `taskpane.js`'s `ws.onmessage` dispatches to `handleToolRequest(...)`,
   which calls into `taskpane/modules/doc-tools.js`'s `readDoc()` — this runs
   inside `Word.run(async (context) => { ... })` because Office.js batches
   operations and only exists in the task-pane's browser context (not
   Node — this is why `doc-tools.js` cannot be imported into `mcp-server/`
   directly).
5. `readDoc()` passes extracted text through `deps.anonymizeText(text,
   'anonymize')` if an anonymisation mapping is active for the document,
   then returns Markdown back over WebSocket → HTTPS → stdio.

## Claude Code registration (skills and agents)

`websocket-server/claude-assets.cjs` links every
`piecemaker-plugin/agents/<slug>.md` and `piecemaker-plugin/skills/<slug>/`
into `~/.claude/agents/` and `~/.claude/skills/`, which Claude Code
auto-discovers at session start. This is what makes a skill or agent created
from `/admin/` usable without publishing the repo and re-running
`claude plugin update` (the installed plugin is a frozen marketplace copy).

- Symlinks, so later edits to the Markdown apply with no reinstall; a copy is
  the fallback where symlinks are unavailable, refreshed on every save.
- `registerClaudeAsset()` runs on create (`POST /api/admin/files`) and on save
  (`PUT /api/admin/file`); `syncClaudeAssets()` runs at server startup, in
  installer step `09-claude-assets`, and from `POST /api/admin/files/sync`.
- A pre-existing user file with the same slug is never overwritten — the
  state comes back as `conflict` and is surfaced as a badge in the admin file
  list (`linked` / `copied` / `conflict` / `missing`).
- Agent front matter is not skill front matter: agents are created with
  `tools:` and `model:` (validated by `normalizeAgentTools` /
  `normalizeAgentModel` in `admin-routes.cjs`), skills only carry
  `name:` + `description:`.

## Environment variables

| Var | Used in | Purpose |
| --- | --- | --- |
| `PORT` | `server.cjs:20` | HTTPS/WS server port, default `43098` |
| `OUTPUT_PATH` | `server.cjs:24` (`getOutputPath()`) | Root dir for all generated files (mappings, compilations, uploads), default `<repo>/output` |
| `PYTHON_PATH` | `PYTHON_SCRIPTS`, warmup checks | Python 3 interpreter to spawn for all registered scripts, default `python3` |
| `SMART_CONVERTER_PATH` | `PYTHON_SCRIPTS.convert` | Override the path to `smart_converter.py` |
| `MCP_URL` / `MCP_API_KEY` | `/api/mcp-config`, `/api/mcp`, `/api/anonymize/process` | Address/key for the remote MCP + anonymisation service; `/api/mcp` and the bulk anonymisation job both fail fast (401 / thrown error) without `MCP_API_KEY` |
| `MCP_REMOTE_URL` | `/api/mcp` proxy | Remote MCP endpoint, default `https://mcp.festival-letino-app.com/mcp-remote/mcp` (the anonymisation job additionally hardcodes the sibling `/mcp-remote/api/anonymize/...` paths on the same host) |

## Running things

```bash
npm install
npm link                  # exposes the `piecemaker` command
piecemaker                 # interactive operations + installer menu
piecemaker open            # starts server + opens the local web UI
piecemaker start / stop / status / logs
npm test
```

Electron build commands are intentionally disabled. `npm start` is an alias
for `piecemaker open`.

`npm test` pins `--test-concurrency=4` on purpose. Several test files spawn
child processes (`commits.test.cjs` runs `git` in a loop, `cli.test.mjs` and
`update.test.mjs` spawn `node`), so letting Node fan out to one file per core
starves them of CPU: the same suite took 468s with 5 load-induced failures at
the default, against 85s and none at 4. Raise it only with a measurement.

There is no separate task-pane dev server — Word loads it straight off
`server.cjs`'s static file mount. To sideload manually into Word for
development, use `taskpane/manifest.xml`-equivalent per current tooling; see
`README.md` for the up-to-date steps.

## Conventions for contributors (human or agent)

- Don't invent new state channels between `taskpane.js` and its modules —
  extend an existing `initXxx(deps)` dependency object or add a new module
  following the same pattern; don't reach into `taskpane.js` globals from a
  module file.
- Server-side, prefer adding to the existing route-grouping conventions
  (anonymisation routes live in the `anonymization-server.cjs` router, not
  inline in `server.cjs`; everything else is inline `app.METHOD(...)` calls
  in `server.cjs`, roughly grouped by feature — keep new endpoints near their
  siblings).
- Adding a Python script: register it in `PYTHON_SCRIPTS` (server.cjs:3856)
  rather than spawning ad hoc child processes elsewhere; reuse
  `executePythonScript`/`executePythonScriptBatch` client-side.
- Mapping edits (`PUT /api/anonymize/mapping/:documentId`) must always send
  both `mapping` and `reverse_mapping` together — the route 400s otherwise —
  and any code that *applies* a mapping to text must go through
  `applyMapping`/`revertMapping` in `piecemaker-plugin/scripts/lib/mapping.cjs`
  rather than rolling its own substitution. That module is the single
  implementation shared by the hooks, the admin pipeline and the task-pane
  router; a second one drifts silently.
- A hook script may only require from `piecemaker-plugin/scripts/lib/` — the
  plugin ships standalone from a marketplace copy. Shared server logic that a
  hook needs moves *into* the plugin and is re-exported by the server module,
  never the reverse.
- Anonymisation/mapping data under `output/` can contain real client PII
  before/without a mapping applied — never log full mapping contents, and
  treat `output/` as sensitive (already gitignored).
- Legal citations produced for drafting/research must be verifiable: cite
  the actual instrument/article and version date; never fabricate a
  citation (see `piecemaker-plugin/skills/redaction-juridique/`).
