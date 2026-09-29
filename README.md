# vscode-dataflex

A VS Code extension, parser and (eventually) language server for **DataFlex 26**.

Written clean-room: no code or grammar is taken from the existing GPL-3.0 `harpercarr.dataflex`
extension, which keeps this project free to stay MIT-licensed.

> Most of this code was written by AI (Claude), directed and reviewed by a human. The tests,
> benchmarks and corpus checks in this README are real runs, not claims.

## Status

| Step | What | State |
|---|---|---|
| 1 | Extension: highlighting, indentation, outline, folding, `Use` navigation, build/run | **done** |
| 2 | Own parser: lexer + tolerant structure parser (layers 1-2) | **done**; preprocessor/linker (layer 3) next |
| 3 | Language server: index, navigation, hover, workspace symbols | **done** |
| 4 | Scope-ranked `WebSet` / `Set` completion | **done** |
| 5 | Static analysis (unused locals, unreachable code) | **done** |
| 6a | DFUnit Test Explorer: discovery, run, pass/fail | **done** |
| 6b | Coverage by instrumentation: probe planning, build overlay, `Run with Coverage` | **done** |
| 7 | Source-level debugging: breakpoints, stepping, call stack, variables | Windows programs **done**, off by default; web applications not working |
| 8 | MCP server: the same tooling, for an AI agent in a DataFlex workspace | **done** |

## Packages

```
packages/
  df-parser/        pure TS: lexer, tolerant structure parser, AST. No fs, no vscode.
  df-workspace/     .sws discovery, df-cli integration, include resolution, symbol index.
  df-coverage/      probe planning, source instrumentation, run session, report.
  df-langserver/    the language server: providers, analysis, workspace ownership.
  df-mcp/           an MCP server: the same index, analysis, tests and preview, for an AI agent.
  df-debug/         the debug adapter: DAP, scope rules, presentation. No fs beyond reading source.
  df-debug-host/    C#: the STA host that owns the debugger engine's COM interface.
  vscode-dataflex/  the client: grammar, status bar, tasks, Test Explorer, coverage, debugging.
```

Everything language-related runs in the **server process**; the extension is a thin client. The
server owns workspace resolution and the symbol index, so the status bar, the build tasks and the
Test Explorer all read one resolution rather than each running `df-cli` and possibly disagreeing.
Beyond standard LSP it answers three custom requests -- `dataflex/status`, `dataflex/reload` and
`dataflex/discoverTests`.

## How it resolves a workspace

Everything comes from one call to `df-cli config --json <workspace>.sws`. That returns
`projects[].makepath`: the compiler's own include search path, already resolving DataFlex 26's
per-workspace package cache. This matters, because in DataFlex 26 the whole Web UI class library
moved out of `C:\Program Files\DataFlex 26.0\Pkg` and into
`<workspace>\DfPkg\DataFlex_dev_Web_UI-<version>\AppSrc`. An indexer that only scans the install
directory finds zero web classes.

DataFlex 26 also ships no standalone console compiler (`dfcomp.dll` only), so builds go through
`df-cli build` as well.

## Installing it to try it out

Two ways. Use **F5** while working on the extension, and **install the VSIX** when you want it
present in your normal editor.

### A. Press F5 (Extension Development Host)

Best for iterating: no install, and reloading picks up your changes.

1. Open your clone of this repository in VS Code.
2. `npm install && npm run build` (once).
3. Press **F5**, or Run → Start Debugging.
4. A second VS Code window ("[Extension Development Host]") opens. In it, **File → Open Folder**
   and pick a DataFlex workspace folder — the one containing the `.sws`, e.g.
   `C:\DataFlex 26.0 Examples\WebOrder`.
5. Open a `.wo` / `.pkg` / `.src` file.

After changing extension code, run `npm run build` and press **Ctrl+R** in the development host to
reload it. `npm run watch` rebuilds automatically so you only need the reload.

### B. Install the VSIX into your normal VS Code

```bash
npm run deploy        # package, then install with a clean console
```

or the two steps separately:

```bash
npm run package       # writes packages/vscode-dataflex/dataflex.vsix
npm run install:vsix  # installs it
```

That vsix is about 1 MB and has no debugger in it at all — not switched off, absent: the code is
dropped from the bundle and the debug contributions from the manifest, so there is no `dataflex`
debug type and no F5. Source-level debugging needs `dataflex-debug-host.exe`, a self-contained .NET
publish that costs 64 MB (29 MB of a 30 MB vsix) and drives a Windows-only COM server, so it ships
as a separate build instead:

```bash
npm run deploy:debug  # or: npm run package:debug, writing dataflex-debug.vsix
```

That one needs the .NET 8 SDK, since it runs `dotnet publish`, and is marked `win32-x64` — the
engine is a Windows COM server, so there is nothing for a macOS or Linux VS Code to install. The
standard vsix stays platform-neutral. See [docs/DEBUGGING.md](docs/DEBUGGING.md).

Installing with `code --install-extension` directly also works, but prints a Node deprecation
warning:

```
(node:40660) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized ...
```

**That warning is not from this extension.** Traced with `NODE_OPTIONS=--trace-deprecation`, the
stack is entirely inside VS Code's own CLI: after installing, it queries the extension marketplace
to refresh metadata, and that HTTP client still uses the deprecated `url.parse()`.

```
at urlParse (node:url)
at Qi.queryRawGalleryExtensions (.../Microsoft VS Code/.../cliProcessMain.js)
at ks.updateMetadata            (.../cliProcessMain.js)
```

The install has already succeeded by then, there is no CLI flag to skip the query, and nothing in
this repo appears on that stack. `npm run install:vsix` simply filters those lines out. It only
suppresses the deprecation block -- a genuine install failure still prints its error and exits
non-zero.

Then reload VS Code. To remove it again:

```bash
code --uninstall-extension vscode-dataflex.vscode-dataflex
```

You can also install through the UI: Extensions view → `...` menu → *Install from VSIX…*.

> **Disable `harpercarr.dataflex` first.** It registers the same file extensions under a different
> language id, and VS Code gives a file to only one of them. If it wins, this extension's outline,
> folding and navigation silently do nothing, because its providers are bound to the `dataflex`
> language. Extensions view → search `dataflex` → Disable on the other one.

### What you should see

Open `C:\DataFlex 26.0 Examples\WebOrder` (or any folder holding a `.sws`) and then a `.wo` file:

- **Status bar, bottom left:** `WebOrder · <project>.src`. Click it to switch project. A warning
  triangle instead means the workspace did not resolve — check the **DataFlex** output channel
  (View → Output → DataFlex).
- **Outline view** (Ctrl+Shift+O, or the Outline panel): the nested object tree, each entry
  labelled `is a cWebForm` and so on.
- **Ctrl+click a `Use cWebForm.pkg` line:** jumps into the resolved package, including into
  `DfPkg\DataFlex_dev_Web_UI-*\AppSrc`.
- **F12 / Peek Definition on a class name**, e.g. the `cCustomerDataDictionary` in
  `Object oCustomerDataDictionary is a cCustomerDataDictionary`: jumps to its `Class` line in
  `DDSrc\cCustomerDataDictionary.dd`. Works for classes, procedures, functions, structs and
  defines, wherever on the search path they live -- workspace, `DfPkg` package, or runtime
  library. Hovering shows the same declaration; for a constant it also shows the value and type --
  what `alignRight` is the position of in its `Enum_List`, or what an alias like
  `Define C_IconDefault for C_IconHistory` resolves to.
- **Ctrl+T** searches every indexed declaration in the workspace and its dependencies.
- **Completion.** Type `Set ps` or `WebSet ps` inside an object and the properties of *that
  object's class* come first, then its parent's, its siblings', the rest of the view, and finally
  the whole workspace. `WebSet` / `WebGet` offer only `{ WebProperty=... }` published properties,
  because using them on anything else is a runtime error. Completion also works after `of`
  (object names) and after `is a` (class names).
- Indexing runs on activation and takes about a second; the status bar shows progress. Until it
  finishes, definition falls back to `Use` navigation only.
- **Folding** on objects, classes, procedures and `Begin`/`End` blocks.
- **Ctrl+Shift+B** or *DataFlex: Build Workspace* runs `df-cli build`; output goes to a terminal
  and compiler errors to the Problems panel.
- **Testing view:** DFUnit suites, discovered without compiling. See below.
- **Greyed-out code** where a local is never read or a statement cannot run. See below.
- **F5** debugs the selected project in the debug build (`npm run deploy:debug`): breakpoints,
  stepping, the call stack and the locals of whichever frame you click. Windows programs only.
  See below.
- **Preview Web View** draws a `.wo` beside its source, with the real controls in the workspace's
  own theme, updating as you type. No build and no server. See below.

Command palette (Ctrl+Shift+P), all prefixed `DataFlex:` — Build Workspace, Rebuild Workspace,
Run Project, Select Project, Show Workspace Configuration, Reload Workspace, Analyze Workspace,
Clear Analysis Results, Refresh Tests, Attach to a Running Program.

Requires `df-cli.exe` from a DataFlex 26 install. It is found automatically via `PATH`, the
registry, then `Program Files\DataFlex <version>\Bin`; override with the `dataflex.cliPath`
setting if yours lives elsewhere.

## Development

```bash
npm install
npm run build          # type-check the libraries, then bundle the extension
npm test               # unit tests (parser, grammar) + df-cli integration tests
npm run corpus-check -- "C:/Program Files/DataFlex 26.0/Pkg"
```

Package boundaries, the checks that are not unit tests, and the comment style are in
[CONTRIBUTING.md](CONTRIBUTING.md).

`npm run corpus-check` parses whole DataFlex corpora and reports crashes (must be zero), block
balance diagnostics, and the *unknown rate* — the share of logical lines the parser could not
classify into anything useful. It also prints the most common unclassified line heads, which is
the to-do list for improving the parser.

With no arguments it checks the two corpora a DataFlex 26 install provides: the runtime library
and the shipped examples. The third below is a private group of nine application workspaces,
which cannot be shipped -- point `DATAFLEX_CORPUS` at your own to include one.

| Corpus | Files | Logical lines | Unknown | Diagnostics | Crashes |
|---|---|---|---|---|---|
| DataFlex 26 runtime library (`Pkg`) | 419 | 152,803 | 0.34% | 0 | 0 |
| DataFlex 26 Examples | 922 | 198,542 | 0.80% | 0 | 0 |
| a private group of nine workspaces | 1,045 | 285,917 | 0.18% | 0 | 0 |
| **all three** | **2,386** | **637,262** | **0.30%** | **0** | **0** |

The remaining unknowns are mostly ActiveX/COM enum type aliases declared in other files; the
workspace linker (step 2, layer 3) is what resolves them.

### Index performance

`npm run index-bench -- <path-to-sws>` reports how long the declaration index takes to build.

| Workspace | Search paths | Files | Names | df-cli | scan | index |
|---|---|---|---|---|---|---|
| WebOrder | 27 | 694 | 20,782 | 220 ms | 17 ms | 662 ms |
| WebOrderMobile | 34 | 724 | 20,715 | 138 ms | 21 ms | 988 ms |
| a private 285k-line workspace | 46 | 910 | 25,179 | 194 ms | 57 ms | 1178 ms |

About a second, so the index is rebuilt from scratch on activation rather than cached to disk.
Caching becomes worthwhile if a workspace grows several times larger.

### VS Code integration tests

```bash
npm run test:integration --workspace packages/vscode-dataflex
```

These launch a real VS Code with the extension loaded against
`C:\DataFlex 26.0 Examples\WebOrder`, and skip themselves if that example is not installed.

## Static analysis

### Where to see it

Analysis is **live** -- there is nothing to start. Open a `.wo` / `.pkg` / `.src` file and
findings appear within a moment.

- **Inline (automatic).** Findings render at `Hint` severity with the `Unnecessary` tag, so the
  code is **greyed out**; hover it for the reason. This is the convention TypeScript uses for
  unused variables. Note that VS Code deliberately does **not list hints in the Problems panel**,
  so inline findings are visible in the editor only.
- **Whole workspace, on demand.** Run **`DataFlex: Analyze Workspace`** from the Command Palette.
  It first asks **which rules to include** -- remembering the choice -- then analyses every file
  the workspace owns (dependencies under `DfPkg` are excluded), lists the results in the
  **Problems panel**, and reports a per-rule summary.
  **`DataFlex: Clear Analysis Results`** empties that list again.

  The rule picker matters on a large codebase: `unused-local` alone finds ~2,200 results in a 285k-line workspace,
  which buries every other rule. Untick it to read the rest.
- **Want inline findings listed too?** Set `dataflex.analysis.severity` to `information` or
  `warning`. At those levels findings appear in the Problems panel and are no longer dimmed.
- **One rule too noisy?** `dataflex.analysis.severityOverrides` sets severity per rule, so a rule
  can stay a greyed-out hint while the rest are listed:

  ```json
  "dataflex.analysis.severity": "warning",
  "dataflex.analysis.severityOverrides": { "unused-local": "hint" }
  ```

  Note that VS Code's own Problems filter box matches message text and file paths, not diagnostic
  codes, so filtering by rule has to happen on this side.
- **In CI or bulk from the repo:** `npm run analysis-check`.

Each rule is switchable under `dataflex.analysis.*`, and `// df-ignore:<rule>` (or
`df-ignore:all`) on the finding's line or the line above silences one.

| Rule | Default | Scope | Findings on a 285k-line workspace (18,500 procedures) |
|---|---|---|---|
| `unused-local` | on | per file | 2,272 |
| `unreachable-code` | on | per file | 5 |
| `duplicate-declaration` | on | per file | 0 |
| `unused-parameter` | off | per file | 526 |
| `dead-procedure` | off | **workspace only** | 6,246 (97% in one generated vendor file) |

`npm run analysis-check` produces that table with samples. The point is to measure a rule before
trusting it: a rule that fires constantly on working, shipped code is wrong about the code.

`unused-parameter` used to fire 1,629 times, almost all of them event overrides. It now skips two
shapes that are allowed to ignore their parameters:

- **an override of something a parent class declares** -- the framework decides the signature, not
  the author;
- **an empty body**, which is a deliberate no-op stub.

That takes it to **526**, and what remains is hand-written procedures genuinely ignoring an
argument. The override test asks the resolved class chain, deliberately *not* a naming convention:
DataFlex events are conventionally `OnSomething`, but a base class can declare any name and the
framework will still call it, so `Refresh_Data` is as much a hook as `OnClick`.

`dead-procedure` is **workspace-only** -- it asks whether anything anywhere calls a method, which
one file cannot answer, so it is reported by *DataFlex: Analyze Workspace* and never live while
typing. It treats a method as reachable if it overrides an ancestor member, is published, or has
its name appear in any string literal (DataFlex dispatches dynamically). It stays off by default:
there it reports 6,246, of which 6,065 are in a single generated ActiveX wrapper -- which is
what `dataflex.analysis.exclude` is for.

`unreachable-code` needed two DataFlex-specific corrections before it was trustworthy, taking it
from 43 findings to 4:

- `If (x) Function_Return 0` guards the return; what follows is reachable.
- A `Case` arm written without `Begin` is a *flat sibling*, not a nested block, so the arm
  following one that returns is the next label -- a fresh entry point, not dead code. Without
  this, every arm after the first return looked unreachable.

The 4 that survive are real, including a `// Test` debugging `Procedure_Return` left in a view
that kills the rest of the procedure.

Rules that need whole-program reachability -- dead procedures above all -- are deliberately
absent: a `#COMMAND` body can `Send` a message the unexpanded parse never sees, so they are unsafe
until the preprocessor layer exists.

## DFUnit Test Explorer

Tests appear in the Testing view without compiling anything: discovery reads the object tree
straight out of the parser and follows `Use` into spec packages, which is how a real suite
(`Use Tests\TestLoader.pkg`, fixtures spread over many files) is found at all.

Both DFUnit test forms are supported:

```DataFlex
{ Published=True }              Object oIntegerMath is a cTest
Procedure TrueIsTrue                Set psTestName to "Integer arithmetic"
    Send Assert True "..."          Procedure Test
End_Procedure                           Send AssertIAreEqual 2 (1 + 1) "1 + 1"
                                    End_Procedure
                                End_Object
```

Names matter, because results are matched back by them. DFUnit reports:

| Declared as | Reported as |
|---|---|
| `Object oX is a cTestFixture` + `Set psTestFixtureName to "Sanity"` | `Sanity` |
| `Object oX is a cTest` + `Set psTestName to "Integer arithmetic"` | `Integer arithmetic` |
| `Object oX is a cTest` with no `psTestName` | `oX` |
| `Procedure If_it_is_divisible_by_4` | `If it is divisible by 4` |

That last rule is the framework's own (`cDFUnitTestCollector.RegisterInterface` strips a `msg_`
prefix and turns `_` into spaces); matching on the raw procedure name would never find a result.

Running builds with `df-cli build --target <project>`, then runs the executable exactly as
DFUnit's own Jenkinsfile does -- `--console -o <file>` -- and parses the JUnit XML. The run has a
timeout (`dataflex.test.timeoutSeconds`, default 300) because a DataFlex program that opens a
modal error dialog would otherwise wait forever for a click that is never coming; if no report is
written, the failure names the exit code and the command to reproduce by hand.

## Previewing web views

Open a `.wo` and run *DataFlex: Preview Web View*. The view is drawn beside the source and follows
you as you type — no build, no server, no DataFlex process.

It is drawn by the DataFlex web framework itself, out of the workspace's own `AppHtml`: the same
`df.WebForm`, `df.WebTabContainer` and `df.WebList` objects the running application uses, laid out
by the same code, in the same theme. Custom controls come along, because the list of scripts to
load is `Index.html`'s managed-includes block. Clicking a control reveals its source.

The language server turns the source into the object definition `df.BaseApp#initJSON` builds a
control tree from — resolving `is a cWebForm` to `df.WebForm` through `psJSClass`, and
`Set peLabelAlign to alignRight` to the `2` the framework wants. **There is no data**: lists and
grids render with their real columns and no rows, because rows come from a server that is not
running. A banner in the panel says so. Values that cannot be read statically are left at the class
default and listed rather than guessed at.

Verified across `C:\DataFlex 26.0 Examples\WebOrder`: of 64 views, 56 draw, 6 correctly report
having nothing renderable, and 2 are the DataFlex Reports viewer, which refuses to start without a
server. `npm run preview-check -- "<workspace>" --all` is that check.

Responsive layouts are a picker in the panel's banner: desktop, tablet and phone, each in both
orientations, plus the base layout with no rules applied. `WebSetResponsive` values never reach the
browser through the object definition -- the server sends each rule as a separate client action --
so the model is rebuilt with the rules that mode would activate, replayed the way the framework
would, and the drawing is given that device's width. `dataflex_preview_model` and
`dataflex_preview_render` take the same modes by name.

See [docs/PREVIEW.md](docs/PREVIEW.md) and [docs/MCP.md](docs/MCP.md).

## Using it from an AI agent

`npm run build` also writes `packages/df-mcp/dist/server.mjs`, a stdio [MCP](https://modelcontextprotocol.io)
server. Registered in a DataFlex workspace, it gives an agent the same index, analysis, DFUnit
discovery, coverage and web-view preview the editor has:

```bash
claude mcp add dataflex --scope project -- node <repo>\packages\df-mcp\dist\server.mjs
```

Nothing that compiles or runs a program is registered unless the server is started with
`--allow-execute`. Responses are capped at 16 KB with counts first and drill-in arguments, because
`unused-local` alone finds 1,936 results on a real workspace and an agent that spends its context on one call
has nothing left to think with. `npm run mcp-check` fails if a default response exceeds that.

See [docs/MCP.md](docs/MCP.md).

## Debugging

**Not in the standard build.** Install `npm run deploy:debug` to get it. There is no setting: the
standard vsix has no debug code and no debug contributions, because the 64 MB Windows-only host is
too much to ship to everyone for a feature that is off — and a debug type that is offered but
cannot finish is worse than one that is not offered at all.

In that build, press **F5**: breakpoints, conditional breakpoints, step in/over/out, pause, run to
line, the call stack, per-frame locals, watches and hover evaluation, for **Windows programs**. A
whole startup runs in about 200 ms under the debugger.

This is the Studio's own debugger, not an imitation of one. `Bin64dfdbg.dll` turns out to be a
registered COM server with a complete type library — the Studio is a client of an automation API,
not the only thing that can reach it — so nothing is reverse-engineered and the `.dbg` format is
never parsed: the engine answers questions about it.

**Web applications do not work yet.** `StartProgram` takes a `webApp` flag and a `url`, and passing
them does not stop the engine launching the program standalone -- at which point the DataFlex
runtime puts up "This program is a WebApp program and cannot be run standalone" and the session
waits on a modal dialog forever. The launch configuration accepts `webApp` and `url` and the
plumbing is there; what the engine wants in order to attach to a WebApp Server session is not yet
understood. See [docs/DEBUGGING.md](docs/DEBUGGING.md).

Two things about the engine shape the adapter, and both are documented at length in
[docs/DEBUGGING.md](docs/DEBUGGING.md):

- **There is no call stack API.** `ICallStack` is an ActiveX control whose entire interface is two
  column widths and a colour theme. The stack is recovered by selecting each queue level and
  reading the `OnUpdateView` the engine fires in response, and `Eval` is scoped to the selected
  level, which is what makes per-frame variables work.
- **There is no variables API either.** The engine can evaluate an expression but cannot say what
  expressions exist. The names come from this repository's own parser -- `localsInScope` is the
  same scope walk that answers a hover -- and the values from `Eval` over that list. Writing a
  parser paid for a debugger feature outright.

Windows only, 64-bit only: DataFlex 26 ships no 32-bit `vdfdbg.dll`.

`npm run debug-host-check` drives the whole thing headlessly against the shipped Order Entry
example. It needs a DataFlex installation, so it is not part of `npm test`. The `-- --webapp`
variant exists but currently passes for the wrong reason: its breakpoint is hit during object
construction, before the runtime notices it is running standalone.

## How completion is ranked

Typing `WebSet ps` in a stock editor offers every string web property in the application, because
nothing models the object tree. DataFlex nests its objects lexically:

```
Object oCustomer is a cWebView
    Object oWebMainPanel is a cWebPanel
        Object oCustomerCity is a cWebForm
            Set ps<cursor>
```

so the object under the cursor -- and therefore its class, and therefore its properties -- is
knowable exactly. `SymbolIndex.membersOf()` walks the class chain and its mixins:

```
cWebForm -> cWebBaseForm -> cWebBaseDEO -> cWebBaseControl -> cWebBaseDEOServer
         -> cWebBaseUIObject -> cWebObject -> cWebBaseObject
mixins: find_edit_mixin, cWebDragDropMixin, cWebBaseUIObject_mixin, cWebObject_mixin
301 members, 60 of them published web properties
```

Candidates are then ranked into tiers, encoded in `sortText`:

| Tier | Source |
|---|---|
| 0 | the target object's own class chain |
| 1 | the parent object's class chain |
| 2 | sibling objects |
| 3 | any other object in the file |
| 4 | anywhere in the workspace (only once 2+ characters are typed) |

Nothing is filtered out except non-published properties under `WebSet`/`WebGet`. `filterText` stays
the bare name, so typing keeps narrowing across every tier -- a mixin the indexer missed can still
never make a property unreachable.

## Deliberate omissions

- **`.inc` is not claimed by the `dataflex` language.** DataFlex uses it
  (`Language_WebApp_English.inc`), but so does classic ASP, and real workspaces keep VBScript
  `.inc` files under `AppHtml` — five such files in one sampled project. Claiming the extension
  would mis-highlight them. Add `"files.associations": {"**/AppSrc/**/*.inc": "dataflex"}` if you
  want it for a specific workspace.
- **`.sws` is not yet registered with a JSON schema.** It is valid JSON and VS Code treats it as
  plain text; a schema is a small later addition.

## Notable DataFlex facts the parser encodes

Discovered by parsing the shipped runtime library, and each covered by a test:

- `;` at end of line is a **continuation**, not a terminator.
- `#` is a legal trailing identifier character (`Row#`, `Col#`), but introduces a preprocessor
  directive at the start of a line.
- `$` is a legal identifier character (`Is$WebApp`).
- `/* */` block comments exist alongside `//` and `#REM`.
- `End_Procedure` and `End_Function` are **interchangeable** — the shipped library relies on it.
- `Procedure Set <Name>` declares a property setter named after the property, not a method
  called `Set`; `Procedure_Section <Name> as <Label>` is the report writer's spelling.
- There are **four** string literal forms, three of which span lines: `"..."`, `@"..."`,
  `@SQL"..."` and the aligned `"""..."""` (DataFlex 2023+). The prefix combines with the
  aligned form, so `@SQL"""` is real — terminating that on the opening quote lexes the embedded
  SQL, and the rest of the file, as code.
- Statement verbs are largely `#COMMAND`-defined, so the parser takes a `knownCommands` set from
  the workspace linker rather than hardcoding them. Only verbs with **no** `#COMMAND` definition
  anywhere in the corpora are treated as built-ins.
- `Type` / `End_Type` is the legacy spelling of `Struct` / `End_Struct`; `Enumeration_List` the
  legacy spelling of `Enum_List`.
- `#COMMAND` bodies are macro *template* text with deliberately unbalanced block keywords, so the
  parser stops tracking block structure inside them.
- Conditional directives (`#IFDEF` …) routinely straddle other constructs, so they are kept flat
  rather than nested.

## License

MIT — see [LICENSE](LICENSE).
