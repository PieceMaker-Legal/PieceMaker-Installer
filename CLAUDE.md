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
  The "Skills et agents" file list holds the repo's own editable hierarchies
  — `CLAUDE.md`/`AGENTS.md`, `piecemaker-plugin/skills/`,
  `piecemaker-plugin/agents/` — plus a read-only "Skills officiels" group:
  the skills of the marketplace plugins currently installed **and** enabled in
  Claude Code (`installedPluginSkills`, sourced from `claude plugin list --json`
  → each plugin's `installPath/skills/<slug>/SKILL.md`, our own
  `@piecemaker` plugin excluded since its skills already list from the repo).
  These carry a synthetic `official-skill:<pluginId>/<slug>` path re-resolved on
  read (`readOfficialSkill`), never editable — so a plugin installed from the
  "Ajouter le plugin legal Claude" pop-up shows its skills here right away. The
  billing ledgers and syntheses under `~/.piecemaker/billing/` are a separate
  hierarchy and are no longer listed there (`readManagedFile` still renders them
  read-only if a path is given).
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
  (`/api/claude`, `/api/openai`, `/api/mistral`, `/api/ollama`),
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

## Anonymisation and mapping

**Local PII scanning** (GLiNER/Presidio, no network call) is the only
anonymisation pipeline — there is no remote service. The standalone
script `websocket-server/scripts/presidio-gliner/presidio-gliner.py`
scans a Markdown file for PII with a Presidio `AnalyzerEngine` + a custom
GLiNER2 `LocalRecognizer`, and writes
`<output_dir>/<stem>_sensitive_map.json`. `smart_converter.py` (see
below) is typically run first to get Markdown, and
`convert_and_scan_pipeline.py` chains the two for batch use, emitting
`PROGRESS:CONVERT:...` / `PROGRESS:SCAN:...` lines on stdout. This local
raw map is transient when the batch pipeline runs: it is merged into
`mapping_default.json` from a private temporary directory. It is what the
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

**Institutional entities are never anonymised** —
`piecemaker-plugin/scripts/lib/institutional-terms.cjs` owns a **global** ban
list (all cases at once) of public institutions GLiNER routinely mis-flags as
organisations: juridictions, registres, publications and administrations
officielles ("Tribunal de Commerce", "Cour de cassation", "Registre du Commerce
et des Sociétés", "RCS", "BODACC"…). Detection is **not** disabled — the terms
are dropped at the one choke point `normalizeMappingDocument` calls
`isInstitutionalEntity` on, so a banned entity never persists in
`mapping_default.json` and is never substituted, on read (hooks) as on write
(pipeline). Matching is case- and accent-insensitive and whole-word-bounded, so
one term covers its geographic variants ("Tribunal de Commerce" bans "Tribunal
de Commerce de Nanterre"). The list lives at
`~/.piecemaker/institutional-terms.json` (env `PIECEMAKER_INSTITUTIONAL_TERMS`
overrides, used by the tests to stay hermetic), is read/written via
`GET/PUT /api/admin/institutional-terms`, and is edited from the **Paramètres**
tab. It sits in the plugin lib for the same reason as `mapping.cjs`: the hooks
require it and ship alone. This is distinct from a case's per-`ignored` list,
which records case-local false positives; the ban list is global and applied at
normalise time, so it needs no re-add guard.

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
- **A registered case with no mapping is read-blocked, not read in clear.**
  Without `mapping_default.json`, `anonymize-read.mjs` has nothing to code, so a
  `.md`/piece-`.json` would leave in clear — a silent leak that *looks* like it
  works. `protect-originals.mjs` therefore denies any readable case surface (and
  a recursive `Grep` at the case root; a `Glob`, names only, stays allowed) while
  the case has no mapping (`caseHasMapping` in `mapping.cjs`, the single mapping
  resolver), telling the model the cause and the fix (run the anonymisation). The
  case's config (`.piecemaker/…`, dotfiles) and its `CLAUDE.md`/`AGENTS.md`
  charter stay readable so the per-case assistant still loads. Contrast the two
  stale-cache failure halves: the deny path above does not depend on the mapping
  *location*, so it keeps working even against a cache that predates the
  `Fichiers convertis PieceMaker/` move — whereas `anonymize-read` silently
  passes clear text there. A `Read` of a case `.md` returning real names is the
  tell (see the auto-memory on stale plugin caches).
- Every hook otherwise fails open: no config, an unrelated path, or (outside a
  registered case) no mapping all end in exit 0 with empty stdout, and
  `anonymize-read.mjs` stays silent when the substitution changes nothing so
  `Read` keeps its native line numbering.

## Originals pipeline (admin)

`websocket-server/originals-pipeline.cjs` drives the per-case pieces frame in
`/admin/`. It is the local pipeline (`smart_converter.py` then
`presidio-gliner.py`) — the only anonymisation pipeline.

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
- DOCX changes in admin history use a compact virtual OOXML fingerprint
  (`commits.cjs`), never the Word binary. Explicitly unprotected DOCX also keep
  a compressed normalized-text snapshot so the admin can render paragraph
  diffs; protected pieces never expose text. The clean path performs only
  asynchronous stats. Changed files read just the ZIP central directory, while
  XML text is inflated asynchronously only on click or commit. The manifest is
  materialized only when a commit is created, so list refresh adds no Git
  process and cannot block the server loop. Repacking identical OOXML creates
  no false change, and restore preserves every original.
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
  run with the case's `Fichiers convertis PieceMaker/` subfolder as their output
  dir (passed `-o`), so the converted `.md` and `mapping_default.json` land there
  and the case root keeps only the originals and the user's working documents.
  The technical scan state stays at the root (`.piecemaker/`), and its manifest
  key is relative to the case root, decoupled from `-o` via `--case-root`
  (`convert_and_scan_pipeline.py`); the raw `*_sensitive_map.json` payloads stay
  in a private temporary directory. A `.md` a previous version left at the root is
  migrated into the subfolder when its piece is next processed (the removal is
  recorded in that job's commit). Only
  Only
  `PROGRESS:` lines and a short stderr tail are kept in a job's log — raw
  script stdout can carry document text.
- **Job scheduling never overloads the machine** (an explicit user requirement).
  A global admission controller in `originals-pipeline.cjs` runs at most **one
  `anonymize` at a time** across all cases (two GLiNER workers would each load
  ~400MB and freeze the box) and lets `convert` jobs run in parallel only while
  their reservations stay under a **RAM budget** (~half of `os.totalmem()`).
  Jobs that don't fit go to a FIFO `waiting` list and auto-start from `pumpQueue`
  when a slot frees (`launchJob`/`admitOrQueue`); a job's public shape gains
  `state: 'queued'` + `queuePosition`. Every spawned child runs at low CPU
  priority (`os.setPriority`, `PIECEMAKER_JOB_NICE`, default 10) with
  `PIECEMAKER_TORCH_THREADS` (default 4) so the machine stays responsive. GLiNER
  itself is **never** parallelised in Python — one sequential worker per scan.
- **Progress is chunk-level, not just per file.** `scanner_worker.py` emits
  `PROGRESS:CHUNKS:…` on its stderr; the pipeline re-emits only that strict
  pattern **clean on stdout** so `spawnTracked` can drive a live bar during a
  long single-file scan (it stayed frozen on "1/1" before). No other worker
  stderr reaches stdout — document text stays behind `PIECEMAKER_DEBUG_ENTITIES`.
- **The GLiNER encoder runs on the Mac GPU when available.**
  `presidio-gliner/coreml_runtime.py` swaps mdeberta's encoder for a CoreML
  MLProgram (`CPU_AND_GPU`) — ~2× faster, output proven identical
  (`eval/BACKENDS_MESURES.md`), CPU freed. The `.mlmodelc` is generated once at
  install by `build_coreml.py` (installer step `03-python-gliner`, macOS,
  best-effort); absent or on any failure, the runtime falls back to torch CPU.
  Never `CPU_AND_NE` (measured 3.3× slower on this model). None of these levers
  touch detection: threshold, entity descriptions, chunking and span arbitration
  are untouched.
- **A job with no `files` covers the whole case and only redoes what is
  missing** (no Markdown, or no matching entry in
  `.piecemaker/anonymization-state.json`); listing `files`
  explicitly — or `force: true` — reprocesses exactly those. When nothing is
  left to do the route returns an already-`done` job and spawns nothing, so
  GLiNER's ~400MB of weights never load for an up-to-date case. The same
  decision is taken again per file inside `convert_and_scan_pipeline.py` via
  `--skip-existing`, which also holds the scanner worker back until it knows at
  least one file needs scanning.
- The individual `*_sensitive_map.json` are temporary and removed after their
  entities are merged. Scan state lives separately in the non-PII manifest
  `.piecemaker/anonymization-state.json`; each hashed relative path carries only
  source size/mtime fingerprints for conversion and scan, so a modified piece is
  reconverted and scanned again automatically.
- **Per-document index (chronology / nature / entity attribution).** The scanner
  worker also runs GLiNER2's *classification* and *structured* heads once per
  document — a single header slice, sub-second — to read its nature
  (`classify_text` against `NATURE_LABELS`) and a header record (`extract_json`:
  date + juridiction), emitting a `document_meta` block inside the transient
  sensitive map. Because only the Python side ever sees per-file entities (the
  sensitive maps are deleted at merge), the pipeline captures each scanned
  document's `document_meta` + entity list in memory before cleanup and, once the
  final mapping is known, writes `.piecemaker/document-index.json`
  (`write_document_index`). That index is **non-PII**: it keys each document by
  the **same `sha256(relpath)` hash** the scan-state manifest uses (a filename can
  carry a client name) and stores only entity **codes** plus nature/date/
  juridiction — never a clear name, never a filename. `websocket-server/document-index.cjs`
  (`buildChronology`) joins it to `originalFilesOverview` and the case mapping to
  produce a chronology + a bipartite pieces↔entities graph; codes are the join
  key, so the graph is inherently anonymised and de-anonymised on the fly (like
  the mapping editor) only for the cabinet's own view. Exposed at
  `GET /api/admin/repository/chronology` (`?deanonymize=0` returns codes only) and
  rendered by the "Chronologie" history-view in `/admin/`. GLiNER2 capabilities,
  the measured timings, and the *entities-empty-in-unified-`extract()`* caveat
  (why entities stay a separate call) are written up in
  `docs/gliner2-capabilities.md`.
- The case mapping is the single
  `<case>/Fichiers convertis PieceMaker/mapping_default.json` (resolved by
  `caseMappingFile`; reads also fall back to a copy left at the case root during
  migration), read/written via
  `GET/PUT /api/admin/mapping` and rebuilt from the scans by
  `POST /api/admin/mapping/rebuild`. The pipeline is pointed at that same file
  with `--mapping-file`. Legacy `mapping_dossier.json` / `mapping_<id>.json`
  files are merged into it before being removed. Entries are stored
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
  list (`linked` / `copied` / `stale` / `conflict` / `missing`).
- An entry that PieceMaker itself put there is *not* a conflict: it comes back
  as `stale` and is taken over silently on the next registration. That covers
  the normal two-clone setup (dev repo + runtime install) — a symlink into any
  `…/piecemaker-plugin/{agents,skills}/<slug>` is recognised as ours and
  re-pointed at the current root. Without it, a server started from the second
  clone reported every asset as conflicting with the first clone's own links,
  i.e. `0 registered / 6 conflicts`, and registered nothing. The copy fallback
  has no path to recognise, so what we copied is recorded in
  `~/.claude/.piecemaker-assets.json` — that receipt is what tells an outdated
  copy of ours from a hand-written file. `pruneClaudeAssets` likewise removes a
  dangling symlink into *any* clone, not just the current one.
- Agent front matter is not skill front matter: agents are created with
  `tools:` and `model:` (validated by `normalizeAgentTools` /
  `normalizeAgentModel` in `admin-routes.cjs`), skills only carry
  `name:` + `description:`.

## Environment variables

| Var | Used in | Purpose |
| --- | --- | --- |
| `PORT` | `server.cjs:20` | HTTPS/WS server port, default `43098` |
| `PIECEMAKER_HOME` | `server.cjs:21` | Firm-global data dir (stamp, `dossier_folders.json`, `ressources/`), default `~/.piecemaker`. There is no longer a configurable workspace root: legal cases are registered individually as `caseFolders` in `~/.piecemaker/config.json` and can live anywhere; `getOutputPath(documentId)` routes each document's output into the registered case that contains it, and `getWorkspacePath()` (used only for the rare no-document case) returns the filesystem root, deliberately non-writable |
| `PYTHON_PATH` | `PYTHON_SCRIPTS`, warmup checks | Python 3 interpreter to spawn for all registered scripts, default `python3` |
| `SMART_CONVERTER_PATH` | `PYTHON_SCRIPTS.convert` | Override the path to `smart_converter.py` |
| `MCP_URL` / `MCP_API_KEY` | `/api/mcp-config` | Address/key echoed to the task pane by `/api/mcp-config`; optional, no default. Vestigial — the MCP tooling is local; there is no remote MCP or anonymisation service |

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
