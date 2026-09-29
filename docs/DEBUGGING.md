# Debugging DataFlex from VS Code

Written 2026-08-27, rewritten 2026-08-28 when the first version turned out to be wrong about the
central question. Everything below is implemented and verified against DataFlex 26.0.87.118 unless
it says otherwise.

## What the first version got wrong

The original plan concluded that a real breakpoint debugger was out of reach: the `.dbg` format is
undocumented, the Studio's Attach to Process protocol unpublished, and reverse-engineering both was
weeks of work that a vendor patch could invalidate. It recommended instrumentation-based tracing
instead, and launching the Studio as a stopgap.

That conclusion came from reading the documentation. Reading the *binaries* answers differently.

**`Bin64\vdfdbg.dll` is a registered COM server with a complete type library.** The Studio does not
have privileged access to the debugger; it is a client of an automation API that anything can call.
Nothing had to be reverse-engineered, and no byte of the `.dbg` format is parsed by this
repository — the engine owns that mapping and answers questions about it.

The lesson is cheap to state and was expensive to learn: for an undocumented Windows API, look for
a type library before assuming a protocol needs decoding.

## The API

`VDFDebugger.DebuggerEngine.26.0`, CLSID `{DF260000-FF5E-41E7-A183-046C0028C441}`, in-process,
`ThreadingModel=apartment`, 64-bit only. `scripts/dump-typelib.ps1` prints the whole thing;
`IDebuggerEngine` is a dispinterface with 30 members, and these are the ones that matter:

| Member | What it does |
|---|---|
| `StartProgram(cmdLine, currentDirectory, noDebugHeap, [webApp], [url])` | Starts a program under the debugger. The last two arguments are the whole of web application support. |
| `StopProgram` / `Continue` / `Pause` | |
| `StepInto` / `StepOver` / `StepOut` / `RunToLine` | |
| `SetBreakPoint(file, ref line)` → `bool` | The line is in/out: see below. |
| `SetBreakPointCondition(file, ref line, expr)` | |
| `Eval(expr, out result)` → `bool` | Evaluated in the selected queue level. |
| `SelectActiveQueueLevel(level)` | The call stack, indirectly: see below. |
| `GetSourceLineFromCommand` / `GetCommandFromSourceLine` | The `.dbg` mapping, as an API. |
| `GetAttachableProcesses` / `AttachProcess(pid)` | |
| `IsValidSourceFile(file)` → `bool` | Whether a file is part of the running program. |
| `SetNextInstruction(file, line)` | |

Events arrive on `_IDebuggerEngineEvents` `{DF2600DE-F3F2-47A8-A96A-3123CDBFA262}`:
`OnProgramInit`, `OnProgramExit`, `OnProgramStartupError`, `OnProgramInitError`,
`OnProgramPaused(file, line, limitedBreakMode)`, `OnProgramContinue`, `OnUpdateView(file, line)`,
`OnNewMessage`, `OnUnhandledProgramException`, `OnAcceptWebAppSession(ref accept)`, `OnWebAppError`,
`OnWebAppLog`, `OnBreakPointError`.

## What had to be established by running it

Everything in this section cost a run to learn and none of it is documented anywhere.

**The engine instantiates outside the Studio, with no licence of its own.** This was the question
the whole approach rested on.

**`StartProgram` returns in about 80 ms.** It does not block running the debuggee. The program is
loaded and left waiting; `Continue` starts it.

**Breakpoints are refused before the program is loaded and accepted after.** So a debug adapter must
not send `initialized` until `OnProgramInit` has arrived, or every breakpoint the client sends is
silently dropped.

**A breakpoint binds to an instruction, not to a line.** `SetBreakPoint` takes the line by
reference and moves it to the next line that carries code. Reporting the requested line rather than
the returned one leaves a marker where nothing will ever stop.

**PowerShell cannot subscribe to the events.** `Register-ObjectEvent` fails with "an event with the
name 'OnProgramInit' does not exist", because it looks for CLR events on the runtime-callable
wrapper and a dispinterface connection point has none. This is the single reason a compiled host
exists: everything else in the API is reachable from a script.

**The events need an STA thread with a running message pump.** The engine runs the debuggee on its
own thread, so a call raised there is marshalled and arrives as a window message. Without pumping,
`StartProgram` succeeds and the session then appears to hang forever.

### The call stack, which is not an API

`ICallStack` is an ActiveX control. Its entire interface is `MessageColumnWidth`,
`ObjectColumnWidth` and `ColorTheme`; there is no frame data on it, and `_ICallStackEvents` has no
members at all. `IVariablesWindow` is the same story, and `IWatches` only reads back the expressions
that were put into it. The Studio renders its stack and its locals in controls that hold their own
data and expose none of it.

The stack is recoverable anyway, because `SelectActiveQueueLevel(n)` makes the engine fire
`OnUpdateView(file, line)` for that frame. Walking upward from 0 yields the whole chain. Two things
about that walk are wrong in the obvious implementation:

- **A repeated location is not the end.** Recursion genuinely repeats a call site: in the Order
  Entry example, `Windows.pkg:4847` appears at levels 7, 8 and 9. Stopping at the first repeat
  truncated a 15-frame stack to 8. The only reliable end is the error the engine raises one level
  past the last.
- **The last level is the current frame, not the first.** Level 0 is the outermost frame —
  `Start_UI` — and the innermost is the one the program is paused in.

`Eval` is scoped to the selected level, which is what makes per-frame variables possible at all: a
local reads its value in its own frame and "undefined symbol, or variable out of scope" in every
other. It follows that a stack walk must re-select the innermost level when it finishes, or every
local in the frame the user is looking at reads as out of scope.

## How it is put together

```
VS Code ──DAP──► packages/df-debug          TypeScript. Protocol, scope rules, presentation.
                        │
                        │ line-delimited JSON over stdio
                        ▼
                 dataflex-debug-host.exe    C#. STA, message pump, connection point.
                        │
                        │ COM
                        ▼
                 vdfdbg.dll ──► vdfvm.dll ──► the program
```

The split is not where it first looks like it should be. The obvious design puts the Debug Adapter
Protocol in the host, next to the engine. It is in TypeScript instead, because the interesting half
of a DataFlex variables pane is knowing which locals are in scope at a line — and the language
server already knows that. `localsInScope` in `packages/df-langserver/src/providers/navigation.ts`
is the same scope walk that gives a hover its answer, and the debugger's Variables pane is that list
with `Eval` run over it. Putting the protocol in C# would have meant a second parser.

So the host does only what only it can do: own an STA, pump messages, hold the connection point,
translate calls. It is about 600 lines and has no opinion about debugging.

The host is published self-contained, which costs 67 MB. Trimming was tried and produces a 12 MB
binary that does not work: first because trimming disables built-in COM interop behind a feature
switch, and then, once that is switched back on, because it strips the `[Guid]` attributes off the
interop interfaces, so `typeof(IDebuggerEngineEvents).GUID` computes a hash-based IID and
`FindConnectionPoint` reports no such connection point. `TrimmerRootAssembly` does not bring them
back. `npm run debug-host-check` is what caught both, and is the reason to keep it.

### Which is why debugging is a build-time decision

64 MB of binary compresses to 29 MB of a 30 MB package, and it is a client of a Windows COM server,
so it could never have run on the macOS or Linux VS Code it was being shipped to. There was a
`dataflex.debugging.enabled` setting for a while; a setting is the wrong shape for this, because
everyone pays the 29 MB whether or not they ever turn it on.

So there are two builds, and the standard one does not contain a debugger in any form:

| | `npm run package` | `npm run package:debug` |
| --- | --- | --- |
| size | ~1 MB | ~30 MB |
| bundle | `INCLUDE_DEBUGGER` folds to `false`, so `src/debug.ts`, `@vscode-dataflex/debug` and the parser copy it pulls are tree-shaken out | included |
| `host/dataflex-debug-host.exe` | excluded by `.vscodeignore` | included via `.vscodeignore.debug` |
| manifest | debug type, breakpoints, `onDebug*` activation, the attach command and `dataflex.debuggerProgId` stripped by `scripts/package-extension.mjs` | complete |
| target | platform-neutral | `win32-x64` |

The three have to move together. Code without contributions is dead weight; contributions without
code are worse — VS Code offers a `dataflex` debug type, activates the extension for it, finds no
adapter and fails on F5, which is the failure this whole arrangement exists to prevent.

The committed `package.json` is the complete one, so `npm run build` and the F5 development host
have the debugger with no ceremony; the standard build is the one that subtracts, and the packaging
script writes the manifest back afterwards. Working on the debugger from the repository still needs
`npm run debug-host-build` once, to publish the host.

## Using it

Press **F5** in a DataFlex workspace. With no `launch.json` the extension debugs the project
selected in the status bar, building nothing — the program must already be built.

```jsonc
{
  "type": "dataflex",
  "request": "launch",
  "name": "DataFlex: Debug Project",
  "stopOnEntry": false
}
```

### Web applications do not work yet

Passing `webApp: true` does **not** stop the engine launching the program standalone. The DataFlex
runtime then puts up "This program is a WebApp program and cannot be run standalone. This program
must be run under DataFlex 26.0 Web Application Server", and the session sits on that modal
indefinitely -- which reads as the debugger being unbearably slow rather than as a failure, because
nothing says anything.

An earlier version of this document claimed it worked, on the strength of
`debug-host-check -- --webapp` passing. That check passes for the wrong reason: its breakpoint sits
on `Set psTheme` during construction of `oWebApp`, which is reached *before* the runtime performs
its standalone check. The breakpoint hit, the evaluation worked, and the program was nonetheless
already doomed. A check that stops early enough to miss the failure is worse than no check.

What is established, by driving a real registered application (`MyApp260`, served at
`http://localhost/MyApp260/`) with nothing else debugging it:

| configuration | standalone dialog | POST to the application's `.wso` |
|---|---|---|
| no debug session at all | -- | `500 Error during Web Application Server session initialization`, at once |
| `webApp` = `true` | -- | the same 500, at once: indistinguishable from no session |
| `webApp` = `"MyApp260"` | none | **times out** |

**`webApp` is the WebApp Server application id, not a boolean.** Only the id changes anything: the
Server stops refusing to make a worker and starts waiting for one, which means the session is being
routed at the debugged process. Passing `true` additionally risks a standalone launch -- WebOrder
did exactly that and died on "this program is a WebApp program and cannot be run standalone", which
from outside reads as the debugger hanging rather than as a failure.

**What is still missing is whatever makes the debugged process pick the session up.** It never
answers, so every request hangs.

Ruled out, each by measurement rather than reasoning:

- `SetEmulateProcessPooling`, the one WebApp-Server-side switch `vdfdbg.dll` imports from
  `WASDBG.dll`. Requests behave identically with it on and off. It is still reachable from the host
  (`emulateProcessPooling`) so that nobody has to discover that twice.
- `acceptNewWebAppSessions`. No effect, and `OnAcceptWebAppSession` never fires.
- The `url`, which only decides whether the engine opens a browser.
- The command line: the process the engine launches gets none, and **the Studio's debuggee gets
  none either** -- observed while the Studio had its own session on the same application. So
  whatever the Studio does differently is not passed as an argument.

A warning about measuring this: the Studio holding a debug session on the same application will
answer requests, and its answers are indistinguishable from the ones being looked for. Two
conclusions here were drawn from its replies before that was noticed. Check for a `WebApp.exe`
whose parent is `Studio.exe` before believing anything.

The launch configuration below is accepted and the plumbing is in place, so this is a matter of
finding what the engine wants, not of building anything:

```jsonc
{
  "type": "dataflex",
  "request": "launch",
  "name": "DataFlex: Debug Web Application",
  "webApp": true,
  "url": "http://localhost/WebOrder/"
}
```

The intent is that the engine starts the WebApp Server session and opens the browser itself. A
second browser session arriving mid-debug raises `OnAcceptWebAppSession`, and the answer decides
whether it takes over the session being debugged; the default is to deny it, because silently
abandoning the session the developer is standing in is the worse surprise.
`acceptNewWebAppSessions: true` reverses that. None of this has been observed working.

**DataFlex: Attach to a Running Program** lists what `GetAttachableProcesses` reports. A program
built without debug information is not in the list.

Works, for Windows programs: breakpoints, conditional breakpoints, step in/over/out, pause, run to
line, the call stack, per-frame locals, watches, and hover evaluation. Order Entry's entire startup
runs in about 200 ms under the debugger, measured from `Continue` to a breakpoint on `Start_UI`.

Does not, because the engine offers no way to: write a variable back, set a function or data
breakpoint, or break on an exception before it is unhandled.

## Verifying it

`npm run debug-host-check` drives the published host through a real session — launch, breakpoint,
stop, step, per-frame evaluation, stack walk, exit — against the shipped Order Entry example.
`npm run debug-host-check -- --webapp` exists but currently proves less than it appears to, for the
reason given above. Neither is part of `npm test`, because both need a DataFlex installation and a
built program.

`packages/df-debug/test` covers everything the adapter decides on its own against a scripted engine,
which is where the off-by-one frame numbering and the wrong-line breakpoint reporting would show up.

**What is not automated is a live debug session inside VS Code**, and it was tried. The extension's
integration suite cannot drive one reliably: `vscode.debug.startDebugging` returns a promise that
does not settle in the headless test host even when the session starts and runs correctly, and any
modal the debug service raises blocks the whole host until a human dismisses it -- on the developer's
own desktop, since the test host is a real VS Code window. A test written against it reported a
three-minute timeout for a session that had in fact worked, and left dialogs open twice.

So the seam between VS Code and `DataflexDebugSession` -- the contributed debug type, the
configuration provider, the inline adapter -- is the one part covered by neither check, and is worth
a manual F5 after changing any of it.

To rebuild the target the desktop check uses:

```bash
cd "C:\DataFlex 26.0 Examples\Order Entry"
df-cli build-file "AppSrc/OrderPrecompile.pkg" --precompile --workspace "Order Entry.sws" \
  --toolchain 26.0.0+windows-64
df-cli build "Order Entry.sws" --target Order
```

## Constraints

Windows only, and it needs a DataFlex installation — the same constraint the build, test and
coverage features already carry.

**64-bit only.** DataFlex 26 ships `vdfdbg.dll` in `Bin64` with no `Wow6432Node` registration, so
32-bit programs cannot be debugged this way at all.

**The ProgID is version-stamped.** The host probes `26.0`, `25.0`, `24.0`, `23.0`, `20.1`, `17.1`
and then the unversioned name, newest first, and says which one it bound to in the DataFlex output
channel. `dataflex.debuggerProgId` forces a particular one.

**The API is undocumented.** It is described by its own type library and has been stable in shape
across the versions registered on this machine, which is reassuring but is not a promise. If a
future release changes it, the failure will be loud — a missing member throws — and
`dump-typelib.ps1` re-reads the truth in one command.

## The routes that were not taken

**Automating the Studio** still exists, as `DataFlex: Debug in Studio`. It is the escape hatch for
anything the engine will not do, and it costs nothing to keep.

**Instrumentation-based tracing** — the original recommendation — is not built and is not planned.
`packages/df-coverage` already answers "what ran, and how long did it take" by instrumentation, and
a real breakpoint debugger answers the rest. The two facts that route uncovered are worth keeping,
because anything that has to write results out of a DataFlex program runs into them:

**Nothing after `Start_UI` executes.** A `.src` ends with `Start_UI` and it reads like a call that
returns when the user closes the window. It is not: the process ends inside it. A `Direct_Output`
write on the line below produced no file at all.

**The desktop broadcasts an exit notification, and that is the last DataFlex code to run.**
`Windows.pkg` routes `Exit_Application` through `Exit_System_Confirmation`, then sends
`Desktop_Notify_Exit_Application`, which `Broadcast Send`s `Broadcast_Notify_Exit_Application` to
every object, and only then calls `Abort`. An object declared above `Start_UI` that answers that
message runs on the way out, however the program was closed. Do **not** `Forward Send` it:
`cObject` does not define it, and forwarding a message the superclass has never heard of raises
error 98, "Invalid message", in a dialog at shutdown.
