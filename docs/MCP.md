# The MCP server

`packages/df-mcp` exposes this project's index, analysis, tests, coverage and web-view preview to
an AI agent as MCP tools, so that an agent working in a **DataFlex application workspace** can ask
the same questions the extension answers in the editor.

It is a separate process from the language server. The extension is not involved and does not need
to be running.

## Why it exists

Running Claude Code inside VS Code next to this extension does **not** give it access to the
extension's features. The IDE integration shares the active file, the selection and
`vscode.languages.getDiagnostics()` — and that last one is the only thing that crosses over, since
the analysis rules publish real diagnostics and `getDiagnostics()` is not severity-filtered the way
the Problems panel is. Everything else — the symbol index, hover, coverage, the preview — has no
channel at all.

Almost none of it needed writing twice. The architecture the README describes — *everything
language-related runs in the server process; the extension is a thin client* — means the
capabilities were already plain TypeScript with no `vscode` import. This package is mostly
plumbing and output shaping over code that already existed.

## Installing it

Build once, in this repository:

```bash
npm install
npm run build                     # or: npm run build --workspace packages/df-mcp
```

That writes `packages/df-mcp/dist/server.mjs`, a single self-contained file. It needs nothing else
on disk, which is what lets it be launched from an unrelated folder.

Then, **in the DataFlex workspace** (the folder holding the `.sws`):

```bash
claude mcp add dataflex --scope project -- node C:\ws\vscode-dataflex\packages\df-mcp\dist\server.mjs
```

| Scope | Where it is written | Use it when |
|---|---|---|
| `--scope local` (default) | Claude's own state | just you, just this machine |
| `--scope project` | `.mcp.json` in the workspace, checked in | the team should get it too |
| `--scope user` | your user config, every project | you work in DataFlex workspaces most of the time |

`--scope user` is safe despite being global: the server is lazy, so in a folder with no `.sws`
`dataflex_status` answers "no .sws found" in milliseconds and nothing else is paid for.

The equivalent `.mcp.json`, written by hand:

```json
{
  "mcpServers": {
    "dataflex": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\ws\\vscode-dataflex\\packages\\df-mcp\\dist\\server.mjs"],
      "env": {}
    }
  }
}
```

Check it with `claude mcp list`, then `/mcp` inside Claude Code.

## Which workspace it uses

In order: `--sws <path>`, then `--root <dir>`, then the `DATAFLEX_SWS` / `DATAFLEX_WORKSPACE`
environment variables, then the current working directory. The cwd default is what makes a bare
registration work — an MCP server inherits the client's working directory, so it lands in whatever
folder you have open.

**That folder does not have to be the workspace.** Starting an agent one level up is an ordinary
thing to do when the shared libraries, docs and several applications sit side by side. So when the
starting folder holds no `.sws`, the server looks up to two levels below it, skipping directories
that never hold one (`AppHtml`, `Data`, `Programs`, `DfPkg`, `node_modules`).

- **Exactly one found** — it is used, and the log says where it came from.
- **Several found** — none is chosen. Picking between unrelated applications by directory order
  would be a guess with consequences. Instead every tool that needs a workspace fails with the
  list, so the agent learns what to choose from without a second round trip.

Choosing is meant to be cheap. `dataflex_reload` takes the shortest thing that identifies one:

```
dataflex_reload { sws: "MyApp" }            the containing folder
dataflex_reload { sws: "MyApp.sws" }        the file, with or without the extension
dataflex_reload { sws: "MyApp/MyApp.sws" }  a relative path, either separator
dataflex_reload { sws: "C:\...\MyApp.sws" }  the absolute path it reported
```

A file name beats the folder that holds it, so `Editor` means `Editor.sws` and not "one of the
two workspaces in `Editor/`". A name that genuinely matches two workspaces — the same `.sws`
name under two different folders — is refused rather than resolved by order; name the folder too.

To skip all of this, pin one at registration:

```
claude mcp add dataflex -- node <repo>\packages\df-mcp\dist\server.mjs --sws C:\Libraries\MyApp\MyApp.sws
```

**Which DataFlex.** The `.sws` names the version it wants in its `df` key, and several versions are
routinely installed side by side, so the workspace is resolved *before* the compiler is chosen and
that version's `df-cli` is preferred. `dataflex_status` reports both, and flags a mismatch — without
this, a `"df": 26.0` workspace resolved with the 27 CLI silently indexes the wrong runtime library.

## Execution is off by default

The tools that run a compiler, execute a built program or start a browser are **not registered**
unless the server is started with `--allow-execute` (or `DATAFLEX_MCP_ALLOW_EXECUTE=1`). Not
hidden — not registered, so `tools/list` never advertises them and the model cannot attempt one.

A default registration dropped into a production library workspace is therefore incapable of
building or running anything. To turn them on, add the flag to the registration:

```json
"args": ["C:\\ws\\...\\dist\\server.mjs", "--allow-execute"]
```

| | Tools |
|---|---|
| Always | status, reload, search_symbols, describe, definition, references, class, table, analyze_file, analyze_workspace, dead_code, discover_tests, coverage_targets, preview_model |
| Only with `--allow-execute` | `dataflex_run_tests`, `dataflex_preview_render` |

`dataflex_run_tests` compiles the project and runs the resulting executable. Under `coverage: true`
it writes an instrumented program — named apart from your own build — into the workspace's
`Programs` directory and deletes it (and its `.dbg`) when the run finishes; your own build
artifacts are never touched. A run that hangs on a modal dialog is killed after `timeoutSeconds`
(default 300).

## The tools

| Tool | What it answers |
|---|---|
| `dataflex_status` | What resolved: the `df-cli`, the `.sws`, the projects, the index size. Call it first when something fails — it names the reason. |
| `dataflex_reload` | Re-resolve and rebuild the index. For new files, a changed `.sws`, or switching workspace. |
| `dataflex_search_symbols` | Substring search over every declaration on the compiler's include path. |
| `dataflex_describe` | The hover: declaration, class chain, constant value and its `Enum_List`, call syntax, how widely it is used. |
| `dataflex_definition` | Where a name is declared, by name or by file position. |
| `dataflex_references` | Where a name is used, with a per-file breakdown — and whether it appears in a string literal. |
| `dataflex_class` | The resolved inheritance chain and every member, including mixins. |
| `dataflex_table` | Tables and their columns, from the workspace's `.fd` files. |
| `dataflex_analyze_file` | The analysis rules over one file. |
| `dataflex_analyze_workspace` | The rules over everything the workspace owns, summarised by rule and by file. |
| `dataflex_dead_code` | Methods nothing calls, with why candidates were spared and how findings concentrate. |
| `dataflex_discover_tests` | The DFUnit suites, read out of the object tree without compiling. |
| `dataflex_coverage_targets` | What a coverage run would instrument — the cost, before paying it. |
| `dataflex_run_tests` | Build, run the suite, report results and optionally line coverage. |
| `dataflex_preview_model` | The control tree a `.wo` would draw, with `df.*` classes and resolved property values. |
| `dataflex_preview_render` | The same view actually drawn, as a PNG. |

### Responsive layouts

Both preview tools take a `mode`: `desktop`, `tablet`, `tablet-portrait`, `tablet-landscape`,
`mobile`, `mobile-portrait`, `mobile-landscape`. Omit it for the desktop base layout.

This is worth knowing about, because responsive values do **not** travel in the object definition.
`cWebObject_mixin.PassPropertyRules` sends each `WebSetResponsive` rule to the browser separately
as a `propRule` client action, and the client applies the ones its own detected mode activates. So
a statically built definition is the base layout and nothing else. Asking for a mode replays those
rules the way the framework would. The extension's preview panel offers the same modes in a picker,
off the same table (`df-langserver/src/preview/modes.ts`), so the two cannot drift.

The selection is the framework's own, from `df.WebObject#enforceRule`: rules are held sorted by
mode descending and the first whose mode is **at or below** the active one wins. A threshold, not
an exact match — so a rule written for `rmTablet` (20) is still in force on a phone (32) unless a
mobile rule outranks it. That is reproduced rather than tidied up, because it is what the running
application does.

`tablet` and `mobile` mean the portrait variants, since a real client never reports the bare
`rmTablet` (20) or `rmMobile` (30) — `detectMode` only ever yields 21/22 and 31/32. Asking for the
bare value would apply the base rules while ignoring every portrait-specific one, which is a layout
no device ever shows.

`dataflex_preview_render` also sizes its window to match, so a phone layout is captured at phone
width rather than stretched across 1280px. Pass `width`/`height` to override.

## Output is budgeted, deliberately

`unused-local` alone finds around two thousand results on a real workspace and `dead-procedure`
several thousand more. A tool that returned them would spend an agent's whole context on one call.

So every response is capped at **16 KB**, truncation is by whole lines, and the footer names the
argument that narrows the result. Whole-workspace tools default to `limit: 0` — a summary, counts
by rule and by file, and nothing else — with `rule:`, `file:` and `offset:` to drill in, and
`out:` to write the full result to a JSON Lines file the agent can grep instead of read.

`npm run mcp-check` fails if any default response exceeds that ceiling. That is what stops the
design rotting; it plays the same role for the tools that `preview-check` plays for the renderer.

```bash
npm run mcp-check                          # against the WebOrder example
npm run mcp-check -- "C:/path/to/workspace" --verbose
```

It needs a DataFlex installation and the built bundle, so it is not part of `npm test`.

## Telling the agent to use it

Registered tools that never get chosen are worth nothing, and tool descriptions alone do not
reliably beat a model's habit of reaching for `grep`. Put something like this in the **DataFlex
workspace's** own `CLAUDE.md`:

```markdown
## DataFlex tooling

This workspace has the `dataflex` MCP server. Prefer it over text search:

- To find where something is declared, use `dataflex_search_symbols` / `dataflex_describe`, not
  Grep. They know the compiler's include path, which reaches outside this folder into the `DfPkg`
  package cache and the DataFlex runtime library — a text search of the workspace finds neither.
- Before deleting or renaming a method, check `dataflex_references`. DataFlex dispatches
  dynamically, so it also reports whether the name appears in a string literal.
- To find what a class can do, use `dataflex_class` — members come from the whole resolved chain
  and its mixins, spread over many files.
- Run `dataflex_analyze_workspace` with no arguments first; it returns a summary. Only then drill
  into one rule or one file.
```

## Notes

- **Staleness.** The agent edits the files, so the index is re-checked against file modification
  times before each index-backed call and changed files are re-indexed; the response says how many.
  A file created *after* startup is not noticed — that is what `dataflex_reload` is for.
- **Startup cost.** Nothing loads until the first tool call. Resolving the workspace is one
  `df-cli config --json`; the index build is a few seconds on a large workspace and is shared by
  concurrent calls rather than run twice.
- **Stdout is the transport.** The server redirects `console.log` and direct `process.stdout.write`
  to stderr and hands the real stdout to the transport alone. A single stray line of output would
  corrupt a JSON-RPC frame, and the symptom is a server that connects and then appears to hang.
