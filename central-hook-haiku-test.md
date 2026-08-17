# Central anonymisation hook — Haiku subagent test report

- **Date:** 2026-08-17
- **Branch under test:** central global hook (`feat/mapping-central-hook-global`), installed at
  `~/.claude/hooks/piecemaker-central-anonymize.mjs` + engine `~/.piecemaker/lib/substitution.cjs`
- **Case:** `/Users/tsardet/Documents/07 - PieceMaker/REAL TEST`
- **Targets:** one random converted Markdown piece
  (`Fichiers convertis PieceMaker/10_Lettre_officielle_Avertissement_formel_dURGOT_sur_le_retard.md`)
  and one Word document (`demo-styled.docx`, listed as an *unprotected* exception).
- **Method:** one Haiku subagent per Claude Code tool, each told to use only its assigned tool,
  retrieve the content, and report verbatim whether the real client names (`URGOT`, `Caitlyn`)
  appeared in **content** (filenames don't count).

Real entities in this case and their codes: `URGOT (SA)` → `URGOT SA`, `Caitlyn (SA)` → `SOCIETE_SA_02`.

---

## 1. Test matrix (one Haiku subagent per tool)

| # | Tool | Target | What it did | Result | Verdict |
|---|------|--------|-------------|--------|---------|
| 1 | **Read** | `.md` | Read the piece in full | Body fully coded: `d'URGOT SA`, `à CAITLYN SA`. No real name in content. | ✅ Pass |
| 1b | **Read** | `.docx` | Attempted Read | Native Read refuses binary `.docx` (tool limitation, not a hook event). | ⚪️ N/A |
| 2 | **Grep** | `Fichiers convertis PieceMaker/` | `-i` search for `URGOT`, `CAITLYN`, `SOCIETE_SA`, `société` | Every content line coded. Even `mapping_default.json` values came back coded (`"URGOT SA": "URGOT SA"`). No clear name. | ✅ Pass |
| 3 | **Glob** | case **root** | `**/*.md`, `**/*.docx` | Denied by `protect-originals` ("recherche récursive à la racine… parcourrait des pièces protégées"). Filenames never reached the model via Glob. | ✅ Pass (deny path) |
| 4 | **Bash** | `.md` + `.docx` | `ls -la`, `cat` the `.md`, `unzip -p … \| strip tags` | `.md` content coded. **`ls` filenames leaked in clear.** **`.docx` glued extraction leaked `Caitlyn` in clear.** | ❌ Two leaks found |

Subagent notes:
- The **Grep** subagent (general-purpose) initially couldn't load the Grep tool and refused rather than
  substitute Bash — re-run via the `Explore` agent, which has Grep.
- The **Glob** subagent correctly reported the root deny and asked for a narrower target instead of
  forcing access.
- A **re-test** Bash subagent hit an interactive permission prompt on the `.docx` extraction (subagents
  can't answer those) and its hand-back tried to steer toward adding an allowlist bypass — **not acted on.**
  The re-test was completed directly instead.

---

## 2. Findings — two content leaks, one root cause

Both leaks are the **same failure**: an entity glued directly against another token escapes substitution
because the engine's regex is anchored with Unicode word boundaries.

1. **`ls -la` / directory listings** — filenames like `01_Kbis_Identification_légale_dURGOT_SA.pdf` print
   in clear. In the filename the elided apostrophe is stripped (`d'URGOT` → `dURGOT`), so the `d` glues
   onto the name and the left word-boundary never matches.
2. **`.docx` via `unzip`** — Word stores text in `<w:t>` runs. When tag-stripping concatenates runs with
   no separator, `Test` + `Caitlyn` → `TestCaitlyn`; `Caitlyn` is now preceded by the letter `t`, the left
   boundary fails, and the clear name reaches the model. (Stripping with *spaces* re-separates the runs, so
   the same doc coded correctly — which is why an earlier extraction showed `CAITLYN SA` and the
   subagent's showed `Caitlyn`.)

Content accessed with the name left whole (normal `.md`, boundaried tokens) was **always coded** — Read,
Grep, and `cat` all passed.

---

## 3. Fix — plain substring match for normal entities

The requested rule: a registered entity (e.g. `Urgot`) is coded **wherever its characters appear**,
case-insensitively, replacing only those characters and nothing around them — `durgotz`, `_urgot_`,
`_URGOT_`, `_uRgot_` all code the `Urgot` inside.

Implemented in `buildEntityRegex` (apply direction, entity→code, in `substitution.cjs`):

- **Normal entities (≥ 4 chars):** match as a pure substring — no word boundaries.
- **Short / acronym entities (2–3 chars):** keep word boundaries — otherwise a 2-letter acronym like
  `US` would rewrite the inside of `BUSINESS`.
- **Revert direction (code→entity) unchanged** — codes keep their strict boundaries.

### Validation (fake entities, so the live mapping can't interfere)

| Input | Before | After |
|-------|--------|-------|
| `de Zorblax à la société` (control) | `PM_01` | `PM_01` (no regression) |
| `_urgot_` / `_URGOT_` / `_uRgot_` | unchanged ❌ | `_PM_01_` ✅ |
| `durgotz` (glued both sides) | unchanged ❌ | `dPM_01…` ✅ |
| `TestCaitlyn` (docx glue) | unchanged ❌ | `TestPM_01` ✅ |
| `ZONE interdite` (acronym `ZO` probe) | unchanged ✅ | unchanged ✅ (no false positive) |
| `le ZO arrive` (acronym as word) | coded ✅ | coded ✅ |

### End-to-end proof through the hook itself

Invoking `~/.claude/hooks/piecemaker-central-anonymize.mjs` directly with a synthetic `PostToolUse`
payload, on the real central mapping:

```
in : GLUED=dURGOT_SA|GLUED2=TestCaitlyn|BOUNDED=URGOT Caitlyn
out: GLUED=dSOCIETE_SA_06_SA|GLUED2=TestSOCIETE SA_02|BOUNDED=URGOT SA CAITLYN SA
```

Both previously-leaking forms now code. ✅

---

## 4. Live-effect caveat (important)

The patched engine is **only picked up by freshly-spawned hook processes.** Inside the *running*
Claude Code session, tool calls still used the engine loaded at session start (boundaried), so live
`ls`/`unzip` kept leaking after the edit — while a direct `node` invocation of the same hook coded
correctly. This is the known stale-hook pattern.

**To make the fix live:** restart the Claude Code session (reloads the hook engine). For durability,
the same change must be applied to the source on `feat/mapping-central-hook-global`
(`substitution.cjs`, and the inline `buildEntityRegex` twin in `mapping.cjs` used by the plugin hooks)
and re-installed, otherwise a reinstall would overwrite the patched `~/.piecemaker/lib/substitution.cjs`.

---

## 5. Summary

- Central hook **anonymises content correctly across every tool** (Read, Grep, Bash-`cat`) and the
  **deny path holds** (Glob/recursive search at case root).
- Two real content leaks were found via Bash — **directory-listing filenames** and **`.docx` run-gluing** —
  both from the left word-boundary, both fixed by the substring-match rule.
- Fix is **validated in isolation and through direct hook invocation**; it needs a **session restart** to
  take effect live and a **source-branch + reinstall** to persist.

---

## 6. Full access-vector matrix — for future tests

This session only exercised `Read`, `Grep`, `Glob`, `Bash`. A Haiku agent enumerated the rest of the
tools that can bring text into the model's context. The list below is **curated and corrected** (the raw
enumeration had two errors, noted). "Vector" = how content reaches the model; "Coverage" = how, if at all,
it is anonymised today.

### Covered by the central `PostToolUse Read|Grep|Glob|Bash` hook (tested ✅)

| Tool | Retrieves | Notes |
|------|-----------|-------|
| **Read** | file text, images, PDFs, notebooks | Tested ✅. Native Read refuses binary `.docx`. |
| **Grep** | matching content lines | Tested ✅ |
| **Bash** | arbitrary stdout/stderr (`cat`, `unzip`, `pandoc`, pipes…) | Tested ✅ — the two leaks were found here and fixed. |
| **Glob** | file **paths only** (no content) | Tested ✅ — plus `protect-originals` denies recursive root globs. |

**Correction to the raw enumeration:** subagents do **not** bypass the hooks. Every Haiku subagent in this
report had its `Read`/`Grep`/`Bash` output anonymised — the matcher fires on the child's tool calls, not
just the parent's. A subagent only widens the surface through the *non-matched* tools below, exactly as the
parent would.

### Covered by a different mechanism (not this hook) — needs its own test

| Vector | Mechanism | To verify |
|--------|-----------|-----------|
| MCP **`read_doc` / `edit_doc`** (Word) | Anonymised **server-side** in `server.cjs` via `mapping.cjs` before the result leaves the box (recent commit). Not the hook. | Confirm `read_doc` on a case doc returns codes; confirm `edit_doc` reverses codes→names on write. |
| MCP **telegram `reply` / `edit_message`** | `PreToolUse` de-anonymise (codes→names) before sending outward. | Confirm an outgoing message with a code is expanded to the real name. |

### NOT covered — potential un-anonymised leaks (add to future test runs)

| Vector | Retrieves | Risk |
|--------|-----------|------|
| **WebFetch** | remote page → Markdown | Not matched. (Low PII risk unless fetching internal/case URLs.) |
| **WebSearch** | search snippets | Not matched. |
| **Monitor** | live stdout/stderr of background processes | Not matched — a backgrounded `cat`/scan streams unfiltered. |
| **NotebookEdit** | notebook cells + outputs | Not matched. |
| **Edit / Write** *(read-back)* | echoed `old_string`/`new_string` / written content | `PreToolUse` reverses input (codes→names) for writing; there is no `PostToolUse` re-anonymisation of the echoed result. |
| MCP **`read_case`** | case/dossier content + metadata | **Not matched** — highest priority: "summarise this case" could surface real names. Verify whether it anonymises server-side like `read_doc`. |
| MCP **`get_resource`** | resource file contents | Not matched — verify server-side handling. |
| MCP **legifrance / google_drive / gmail** | legal text, Drive docs, email bodies | Not matched. |
| MCP **litigation-legal** (Everlaw, Trellis, CourtListener, Aurora, TopCounsel…) | discovery, depositions, filings | Not matched. |
| **computer-use** (if enabled) | screenshots + OCR text | Not matched — image bytes bypass text substitution entirely. |

### Suggested future-test checklist

1. One subagent per **non-matched** tool above, each attempting to surface a known case entity.
2. MCP `read_case` and `get_resource` against a real case — confirm codes, not names.
3. `Monitor` on a backgrounded `cat`/scan of a converted `.md`.
4. `WebFetch` of a `file://` or `localhost` URL pointing at case content.
5. Image/OCR path (screenshot of an open case doc) — text-substitution cannot reach image bytes; note as an architectural limit, not a regex fix.
