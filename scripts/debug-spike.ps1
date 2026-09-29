<#
.SYNOPSIS
    Proves (or disproves) that the DataFlex debugger engine can be driven from outside the Studio.

.DESCRIPTION
    Phase 1 of docs/DEBUGGING.md. `VDFDebugger.DebuggerEngine.26.0` is a registered, in-process,
    apartment-threaded COM server whose automation API is fully described by the type library
    embedded in `Bin64\vdfdbg.dll` (dump it with scripts/dump-typelib.ps1). Everything below is a
    question that only running it can answer:

      1. Does the engine instantiate at all outside Studio.exe, or does it need a Studio licence?
      2. Do connection-point events reach a non-Studio host?
      3. Does StartProgram return, or does it block running the debuggee's message loop?
      4. Does SetBreakPoint work before the program is loaded, or only after it?
      5. Does OnProgramPaused carry a usable file and line?
      6. Does Eval return values for locals in scope?
      7. Can SelectActiveQueueLevel + OnUpdateView enumerate call stack frames? ICallStack itself
         is a UI control with nothing but column widths on it, so this is the only candidate route
         to a DAP stackTrace.
      8. Does IWatches.GetWatches return values, or only the expressions that were loaded?

    A first pass answered 1, 3 and 4 from plain PowerShell -- the engine creates, StartProgram
    returns in milliseconds, and breakpoints are refused before the program is loaded and accepted
    after. It could not answer the rest, because `Register-ObjectEvent` cannot bind a dispinterface
    connection point: every subscription failed with "an event with the name 'OnProgramInit' does
    not exist". So the sink below is written in C# and compiled in-process by Add-Type. That is
    still no build toolchain, and the sink is the same shape the real adapter will need.

    Must run STA, and must pump messages: the engine is apartment-threaded, so a call raised on
    the VM's thread is marshalled to this one and arrives as a window message.

.EXAMPLE
    pwsh -STA -NoProfile -File scripts/debug-spike.ps1
#>
[CmdletBinding()]
param(
    [string] $Exe = 'C:\DataFlex 26.0 Examples\Order Entry\Programs\Order64.exe',
    [string] $WorkingDirectory = 'C:\DataFlex 26.0 Examples\Order Entry',
    # A line that runs during startup, so the breakpoint hits without touching the UI.
    [string] $BreakFile = 'C:\DataFlex 26.0 Examples\Order Entry\AppSrc\Order.src',
    [uint32] $BreakLine = 45,
    [string] $EvalExpr = 'hoOptions',
    [string] $ProgId = 'VDFDebugger.DebuggerEngine.26.0',
    [int] $TimeoutSeconds = 40
)

$ErrorActionPreference = 'Stop'

function Note($m) { Write-Host "  $m" }
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Good($m) { Write-Host "  OK   $m" -ForegroundColor Green }
function Bad($m) { Write-Host "  FAIL $m" -ForegroundColor Red }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

/// The engine's outgoing interface. DISPIDs are taken from the type library, not guessed.
[ComVisible(true)]
[Guid("DF2600DE-F3F2-47A8-A96A-3123CDBFA262")]
[InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
public interface IDebuggerEngineEvents
{
    [DispId(1)]  void OnProgramInit();
    [DispId(2)]  void OnProgramExit();
    [DispId(3)]  void OnProgramStartupError(string errorMessage);
    [DispId(4)]  void OnProgramInitError(string errorMessage);
    [DispId(5)]  void OnProgramPaused(string file, uint line, bool limitedBreakMode);
    [DispId(6)]  void OnProgramContinue();
    [DispId(7)]  void OnUpdateView(string file, uint line);
    [DispId(8)]  void OnNewMessage(int stepping);
    [DispId(9)]  void OnUnhandledProgramException(string description);
    [DispId(10)] void OnAcceptWebAppSession(ref bool acceptNewSession);
    [DispId(11)] void OnWebAppError(string description);
    [DispId(12)] void OnWebAppLog(int eventId, string text);
    [DispId(13)] void OnBreakPointError(string text);
}

[ComVisible(true)]
[ClassInterface(ClassInterfaceType.None)]
public class EngineSink : IDebuggerEngineEvents
{
    public static readonly ConcurrentQueue<string> Events = new ConcurrentQueue<string>();
    // OnNewMessage fires for every message the program executes. Counted, never logged.
    public static long MessageCount;

    private static void Log(string s) { Events.Enqueue(s); }

    public void OnProgramInit() { Log("OnProgramInit"); }
    public void OnProgramExit() { Log("OnProgramExit"); }
    public void OnProgramStartupError(string m) { Log("OnProgramStartupError: " + m); }
    public void OnProgramInitError(string m) { Log("OnProgramInitError: " + m); }
    public void OnProgramPaused(string file, uint line, bool limited)
    {
        Log("OnProgramPaused|" + file + "|" + line + "|limited=" + limited);
    }
    public void OnProgramContinue() { Log("OnProgramContinue"); }
    public void OnUpdateView(string file, uint line) { Log("OnUpdateView|" + file + "|" + line); }
    public void OnNewMessage(int stepping) { System.Threading.Interlocked.Increment(ref MessageCount); }
    public void OnUnhandledProgramException(string d) { Log("OnUnhandledProgramException: " + d); }
    public void OnAcceptWebAppSession(ref bool accept) { accept = true; Log("OnAcceptWebAppSession -> accepted"); }
    public void OnWebAppError(string d) { Log("OnWebAppError: " + d); }
    public void OnWebAppLog(int id, string text) { Log("OnWebAppLog(" + id + "): " + text); }
    public void OnBreakPointError(string t) { Log("OnBreakPointError: " + t); }
}

public static class Spike
{
    private static IConnectionPoint _cp;
    private static int _cookie;

    public static string Connect(object engine)
    {
        var container = engine as IConnectionPointContainer;
        if (container == null) return "engine does not implement IConnectionPointContainer";
        var iid = typeof(IDebuggerEngineEvents).GUID;
        IConnectionPoint cp;
        container.FindConnectionPoint(ref iid, out cp);
        if (cp == null) return "no connection point for _IDebuggerEngineEvents";
        int cookie;
        cp.Advise(new EngineSink(), out cookie);
        _cp = cp;
        _cookie = cookie;
        return "advised, cookie " + cookie;
    }

    public static void Disconnect()
    {
        if (_cp != null && _cookie != 0) { try { _cp.Unadvise(_cookie); } catch { } }
        _cp = null; _cookie = 0;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

    [DllImport("user32.dll")] private static extern bool PeekMessage(out MSG msg, IntPtr hWnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref MSG msg);
    private const uint PM_REMOVE = 1;

    /// Pumps the STA message queue, which is how a cross-thread COM event call reaches the sink.
    public static void Pump(int milliseconds)
    {
        var until = DateTime.UtcNow.AddMilliseconds(milliseconds);
        while (DateTime.UtcNow < until)
        {
            MSG msg;
            while (PeekMessage(out msg, IntPtr.Zero, 0, 0, PM_REMOVE))
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
            System.Threading.Thread.Sleep(10);
        }
    }

    public static string[] Drain()
    {
        var list = new System.Collections.Generic.List<string>();
        string s;
        while (EngineSink.Events.TryDequeue(out s)) list.Add(s);
        return list.ToArray();
    }
}
'@

Step "Host"
$apartment = [System.Threading.Thread]::CurrentThread.GetApartmentState()
Note "apartment      : $apartment"
Note "process bitness: $([IntPtr]::Size * 8)-bit"
if ($apartment -ne 'STA') { Bad "not STA -- rerun with: pwsh -STA -NoProfile -File $PSCommandPath"; exit 1 }

Step "Create the engine ($ProgId)"
try {
    $engine = New-Object -ComObject $ProgId
    Good "instantiated outside the Studio"
} catch {
    Bad "could not create: $($_.Exception.Message)"
    exit 1
}

Step "Advise the connection point (question 2)"
$advise = [Spike]::Connect($engine)
if ($advise -like 'advised*') { Good $advise } else { Bad $advise; exit 1 }

$script:seen = New-Object System.Collections.ArrayList

# Pumps and reports; returns the first event whose text starts with $name, or $null on timeout.
function Wait-For([string] $name, [int] $seconds = $TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        [Spike]::Pump(150)
        foreach ($e in [Spike]::Drain()) {
            [void]$script:seen.Add($e)
            Note "<- $e"
            if ($e.StartsWith($name)) { return $e }
        }
    }
    return $null
}

function Drain([int] $seconds = 2) {
    $out = @()
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        [Spike]::Pump(150)
        foreach ($e in [Spike]::Drain()) {
            [void]$script:seen.Add($e)
            $out += $e
            Note "<- $e"
        }
    }
    return $out
}

try {
    Step "StartProgram (question 3)"
    Note "exe: $Exe"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $engine.StartProgram($Exe, $WorkingDirectory, $false)
    $sw.Stop()
    Good "returned after $($sw.ElapsedMilliseconds) ms"

    Step "Wait for OnProgramInit (question 2)"
    $init = Wait-For 'OnProgramInit' 20
    if ($null -eq $init) { Bad "no OnProgramInit within 20 s (events seen: $($script:seen.Count))" }
    else { Good "events reach a non-Studio host" }

    Step "Breakpoint (questions 4, 5)"
    Note "IsValidSourceFile      : $($engine.IsValidSourceFile($BreakFile))"
    Note "GetCommandFromSourceLine: $($engine.GetCommandFromSourceLine($BreakFile, $BreakLine))"
    $line = $BreakLine
    $ok = $engine.SetBreakPoint($BreakFile, [ref] $line)
    if ($ok) { Good "SetBreakPoint -> True, adjusted line = $line" } else { Bad "SetBreakPoint -> False" }

    Step "Continue, and wait for the breakpoint (question 5)"
    $engine.Continue()
    $paused = Wait-For 'OnProgramPaused' $TimeoutSeconds
    if ($null -eq $paused) { Bad "breakpoint never hit within $TimeoutSeconds s" }
    else { Good $paused }
    Note "messages executed so far: $([EngineSink]::MessageCount)"

    Step "Eval (question 6)"
    foreach ($expr in @($EvalExpr, 'Self', 'ghoApplication')) {
        $result = ''
        try {
            $ok = $engine.Eval($expr, [ref] $result)
            if ($ok) { Good "Eval('$expr') -> '$result'" } else { Note "Eval('$expr') -> False ('$result')" }
        } catch { Note "Eval('$expr') threw: $($_.Exception.Message)" }
    }

    Step "Step until the local is assigned, so there is something to see per frame"
    foreach ($n in 1..2) {
        $engine.StepOver()
        Wait-For 'OnProgramPaused' 10 | Out-Null
    }
    $v = ''; [void]$engine.Eval($EvalExpr, [ref] $v)
    Note "$EvalExpr is now '$v'"

    Step "Call stack via SelectActiveQueueLevel + OnUpdateView (question 7)"
    Note "Probing until the level stops resolving. Two things to settle: how deep the stack goes,"
    Note "and whether Eval follows the selected level or always reports the paused frame."
    $frames = @()
    $repeat = 0
    for ($level = 0; $level -lt 60; $level++) {
        try {
            $engine.SelectActiveQueueLevel($level)
            $fired = @([Spike]::Drain() | Where-Object { $_ -like 'OnUpdateView*' })
            if ($fired.Count -eq 0) {
                [Spike]::Pump(200)
                $fired = @([Spike]::Drain() | Where-Object { $_ -like 'OnUpdateView*' })
            }
            $where = if ($fired.Count) { ($fired[-1] -replace '^OnUpdateView\|', '') } else { '(none)' }
            $selfValue = ''; [void]$engine.Eval('Self', [ref] $selfValue)
            $localValue = ''; $localOk = $engine.Eval($EvalExpr, [ref] $localValue)
            Note ("level {0,2} | {1,-70} | Self={2,-5} | {3}={4} ({5})" -f $level, $where, $selfValue, $EvalExpr, $localValue, $localOk)

            # A repeated location is NOT the end of the chain: recursion genuinely repeats a call
            # site (Windows.pkg:4847 appears at levels 7, 8 and 9 here). The only reliable end is
            # the exception one level past the last, so the walk breaks on that and nothing else.
            $frames += $where
        } catch {
            Note "level $level threw: $($_.Exception.Message)"
            Note "-> the chain is $level deep; level $($level - 1) is the paused frame"
            break
        }
    }

    Step "Getting back to the paused frame's scope"
    Note "The walk leaves some other level active, so evaluating a top-frame local must be"
    Note "restorable or per-frame variables are unusable. Candidates, in order:"
    $depth = $frames.Count
    foreach ($candidate in @($depth, ($depth - 1), -1, 0)) {
        try {
            $engine.SelectActiveQueueLevel($candidate)
            [Spike]::Pump(150) | Out-Null
            [Spike]::Drain() | Out-Null
            $v2 = ''
            $ok2 = $engine.Eval($EvalExpr, [ref] $v2)
            if ($ok2) { Good "SelectActiveQueueLevel($candidate) restores scope: $EvalExpr = '$v2'" }
            else { Note "SelectActiveQueueLevel($candidate) -> still out of scope" }
        } catch { Note "SelectActiveQueueLevel($candidate) threw: $($_.Exception.Message)" }
    }

    Step "IWatches (question 8)"
    try {
        $watches = New-Object -ComObject vdfdbg.Watches.26.0
        $watches.LoadWatches([string[]] @($EvalExpr, 'Self'))
        $back = $watches.GetWatches()
        Note "GetWatches -> $((@($back) | ForEach-Object { "'$_'" }) -join ', ')"
    } catch {
        Note "IWatches unusable standalone: $($_.Exception.Message)"
    }

    Step "Stepping (does it move the line?)"
    foreach ($stepName in @('StepOver', 'StepOver', 'StepInto')) {
        $engine.$stepName()
        $p = Wait-For 'OnProgramPaused' 10
        if ($null -eq $p) { Note "$stepName -> no pause event" } else { Good "$stepName -> $p" }
    }

} catch {
    Bad "unhandled: $($_.Exception.Message)"
    Note $_.ScriptStackTrace
} finally {
    Step "Stop"
    try { $engine.StopProgram(); Good "StopProgram" } catch { Note "StopProgram threw: $($_.Exception.Message)" }
    Drain 3 | Out-Null
    [Spike]::Disconnect()
    Note "events seen: $($script:seen.Count); messages executed: $([EngineSink]::MessageCount)"
}
