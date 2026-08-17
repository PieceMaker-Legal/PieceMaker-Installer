# OS-level filesystem sandbox (microsoft/mxc)

This is the OS-level half of piece protection. The anonymisation **hooks**
(`docs/anonymisation-hooks.md`) are the transform layer — they hand the model
coded Markdown and restore names on write — but as an enforcement boundary they
are **bypassable**: a `PreToolUse` hook parses raw command text, so `$VAR`,
`python -c "open(...)"`, `cd`+relative paths and `find … -exec cat {}` all read a
protected file without the hook ever resolving the path (the
`hook-protection-contournable` finding, tested 2026-08-16). A hook cannot decide
which files a shell command will read; only the kernel can.

`microsoft/mxc` (Microsoft Execution Container) closes that gap. It launches a
command under an OS containment backend with a filesystem policy, so the
task-pane's Claude Code session runs with three targets denied at the **syscall**
level, however the agent phrases the read:

1. the Python env — `config.venvPath` (default `~/.piecemaker/venv`)
2. the case mapping — `mapping_default.json` + any `mapping*.json` /
   `*_sensitive_map.json` in the case
3. the central mapping — `~/.piecemaker/central-mapping.json`

## How it is wired

- **Install (best-effort):** `installer/steps/14-mxc-sandbox.mjs` builds mxc
  (`v0.7.0`, needs the Rust toolchain — rustup fetches the pinned 1.93 via the
  repo's `rust-toolchain.toml`), copies the executor to `~/.piecemaker/mxc/`, and
  records `mxcPath` + `mxcEnabled` in `~/.piecemaker/config.json` (and
  `PIECEMAKER_MXC_PATH` in `.env`). The step then runs an **enforcement proof** —
  it denies a throwaway canary file and asserts the read fails — before trusting
  the binary. Any failure (no Rust, build error, proof fails) degrades to
  `partial`/`skipped` and leaves the hooks as the only layer; the step never
  fails the install and is `required: false`.
- **Runtime:** `websocket-server/mxc-sandbox.cjs` builds a per-session policy at
  PTY start. `createPtyTerminal` (`server.cjs`) spawns `mxc-exec` with that policy
  instead of the bare shell whenever `isMxcAvailable()` is true, and falls back to
  the plain shell otherwise. The policy's `process.commandLine` is the user's
  interactive shell; `seatbelt.launchMethod: "exec"` makes it inherit node-pty's
  controlling terminal, and `network.defaultPolicy: "allow"` keeps Claude's API
  and `localhost:43098` reachable (the sandbox is for the filesystem, not the
  network).

## Honest limits (do not oversell this)

- **mxc self-declares "not a security boundary currently."** This is
  **defence-in-depth**, not a replacement for the hooks. The hooks stay wired and
  are never removed.
- **It contains a process, not a file.** Only the shell we launch through mxc is
  sandboxed. A file is not locked against every other program on the machine.
- **Windows cannot express `deniedPaths`** — it is allowlist-only
  (`readwritePaths`/`readonlyPaths`). So on Windows:
  - `.venv` and the central mapping are protected **by omission** —
    `~/.piecemaker` is never granted.
  - `mapping_default.json` lives **inside** the case folder the agent must read
    (alongside the `.md`), so it cannot be excluded from the allowlist and stays
    **hook-only** there. The only fully robust fix would be to relocate the case
    mapping outside any granted root; that is a larger change and out of scope
    here.
- **macOS/Linux are clean:** `deniedPaths` is deny-all-except, so all three
  targets are blocked while everything else the agent needs stays reachable.

## Escape hatch

Set `PIECEMAKER_MXC_DISABLE=1` (or `config.mxcEnabled=false`) to run the session
unsandboxed if a policy ever breaks a workflow. The hooks continue to apply.

## Verifying end to end

1. `piecemaker --step 14-mxc-sandbox` (macOS) → builds mxc; the enforcement proof
   confirms containment works.
2. `piecemaker open`, open the task pane on a real case, and from the embedded
   Claude terminal try each bypass vector against `mapping_default.json`,
   `~/.piecemaker/venv` and the central mapping:
   ```bash
   cat "Fichiers convertis PieceMaker/mapping_default.json"
   f="Fichiers convertis PieceMaker/mapping_default.json"; cat "$f"
   python3 -c "print(open('Fichiers convertis PieceMaker/mapping_default.json').read())"
   find . -name mapping_default.json -exec cat {} +
   ```
   Each must return **Permission denied**, while a normal `.md` read still works
   and Claude still reaches its API.
3. `npm test` (the `mxc-sandbox` suite; the macOS enforcement test auto-skips when
   no binary is installed).
