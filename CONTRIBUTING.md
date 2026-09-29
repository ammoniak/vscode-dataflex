# Contributing

Thanks for looking. This is a TypeScript monorepo with one C# project in it; the
[README](README.md) explains what the pieces do and why, and this file covers what you need to
know before changing them.

Most of this code was written by AI (Claude), directed and reviewed by a human. That does not
change what a patch has to be — it has to be understood by whoever sends it.

## Getting it running

```bash
npm install
npm run build          # type-check the libraries, then bundle the extension
npm test               # 997 unit tests
npm run typecheck      # what CI runs alongside the tests
npm run watch          # tsc --build --watch while you work
```

Then press **F5** to launch an Extension Development Host with the extension loaded. `.vscode/launch.json`
has a configuration pointing at the `WebOrder` example the DataFlex installer ships, and one that
lets you open a folder yourself.

Node 20 or later. Everything except the debug host works without DataFlex installed; see below for
what does not.

## The package boundaries

This is the thing a first patch is most likely to break, because nothing stops you at compile time
except the dependency graph itself.

```
df-parser/        no fs, no vscode. Pure text in, AST out.
df-workspace/     fs and df-cli.exe. Knows nothing about LSP or VS Code.
df-coverage/      probe planning, instrumentation, run session, report.
df-langserver/    the language server: providers, analysis, workspace ownership.
df-mcp/           an MCP server over the same index, analysis, tests and preview.
df-debug/         the debug adapter. Reads source; no other fs.
df-debug-host/    C#: the STA host owning the debugger engine's COM interface.
vscode-dataflex/  the client: grammar, status bar, tasks, Test Explorer, coverage, debugging.
```

Two rules follow from that:

- **`df-parser` stays pure.** It is the only package with no I/O at all, which is what makes it
  testable against 637,000 lines of real DataFlex in `corpus-check`. Adding an `fs` import to it
  costs more than it looks.
- **Language features live in the server, not the extension.** The extension is a thin client. The
  server owns workspace resolution and the symbol index, so the status bar, the build tasks and the
  Test Explorer all read one resolution rather than each shelling out to `df-cli` and possibly
  disagreeing. A feature added to `vscode-dataflex/src` that could have lived in `df-langserver`
  will be asked to move — and the MCP server, which reuses the server's analysis wholesale, is why.

`df-langserver` exports through subpath barrels (`./analysis`, `./preview`) rather than one root
barrel, because the extension is bundled from this package and widening the root pulls code it
never calls into `out/extension.js`.

## Tests

`npm test` is the whole unit suite and needs nothing installed. Tests that talk to a real DataFlex
installation guard themselves — `df-workspace/test/workspace.test.ts` skips when the `WebOrder`
example is absent — so the suite is green on a bare machine and meaningful on yours.

Beyond that there are checks that are not unit tests, each of which needs a real install and is
therefore **not in CI**:

| Command | What it proves |
| --- | --- |
| `npm run corpus-check` | The parser survives whole DataFlex corpora: zero crashes, and the share of logical lines it cannot classify. Point `DATAFLEX_CORPUS` at your own application code to add a third corpus. |
| `npm run preview-check` | A statically built definition is accepted by 600 KB of somebody else's JavaScript in a real browser. A definition can pass every unit test and still draw nothing. |
| `npm run mcp-check` | Every MCP tool answers, and no default response exceeds the 16 KB cap. |
| `npm run debug-host-check` | The C# host actually drives the debugger engine's COM interface. |
| `npm run analysis-check`, `npm run deadcode-check` | Rule findings over a real workspace, so a change in false-positive rate is visible. |
| `npm run test:integration` | A real VS Code with the extension loaded. Skips itself without the `WebOrder` example. |

They exist because the thing being tested is an interaction with software this repository does not
contain. If you change the preview, the MCP tools or the debugger, run the matching check and say
what it reported.

## Style

The codebase explains **why**, in prose, at the point of the decision — not what the code already
says. Most comments describe a constraint discovered the hard way: a framework method that throws
if you call it in the wrong order, a DataFlex idiom the naive reading gets wrong, a measurement
that settled a default. A patch that matches that reads as part of the code; one that does not
stands out immediately.

Concretely:

- No `TODO`, `FIXME` or `HACK`. If it is worth writing down, write down why it is the way it is.
- Cite what you measured. "1,629 findings, cut to 526 by excluding overrides" is worth more than
  "too noisy".
- Tests carry a file-level comment saying what is being asserted and why it matters. The failure
  they were written to catch is the useful part.
- Comments wrap at 100 characters, like the code.

## Reporting DataFlex behaviour

If you hit something the parser or the analyser gets wrong, the most useful bug report is the
smallest snippet of real DataFlex that reproduces it, plus which corpus it came from. The
[README's list of notable DataFlex facts](README.md#notable-dataflex-facts-the-parser-encodes) is
where those end up once they are understood and covered by a test.

## Licence

MIT. By contributing you agree your contribution is licensed under it.
