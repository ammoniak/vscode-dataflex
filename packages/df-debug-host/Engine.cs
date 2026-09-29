using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text.Json.Nodes;

namespace DataFlex.Debug.Host;

/// <summary>One entry in the debuggee's call chain.</summary>
/// <param name="Level">The engine's queue level. 0 is the outermost frame.</param>
public sealed record Frame(int Level, string File, int Line);

/// <summary>
/// The DataFlex debugger engine, wrapped.
/// </summary>
/// <remarks>
/// Every call goes through <c>InvokeMember</c> by name rather than through a declared
/// <c>[ComImport]</c> interface. <c>IDebuggerEngine</c> is a dispinterface, so name-based
/// <c>IDispatch::Invoke</c> is what the Studio itself uses and what was proven to work from
/// PowerShell before any of this existed. A declared interface would additionally have to keep 30
/// DISPIDs correct forever against an undocumented API; being a little slower on calls a human
/// triggers is not a cost worth paying to avoid that.
/// </remarks>
public sealed class Engine : IDisposable
{
    /// <summary>Newest first: a machine with several DataFlex versions should get the newest.</summary>
    private static readonly string[] ProgIds =
    {
        "VDFDebugger.DebuggerEngine.26.0",
        "VDFDebugger.DebuggerEngine.25.0",
        "VDFDebugger.DebuggerEngine.24.0",
        "VDFDebugger.DebuggerEngine.23.0",
        "VDFDebugger.DebuggerEngine.20.1",
        "VDFDebugger.DebuggerEngine.17.1",
        "VDFDebugger.DebuggerEngine"
    };

    private readonly object _com;
    private readonly Type _type;
    private IConnectionPoint? _connectionPoint;
    private int _cookie;

    /// <summary>The most recent <c>OnUpdateView</c>, which is how a queue level reports its location.</summary>
    private (string File, uint Line)? _lastView;

    private long _messageCount;

    /// <summary>Messages the engine has reported executing.</summary>
    public long MessageCount => Interlocked.Read(ref _messageCount);

    private Engine(object com, string progId)
    {
        _com = com;
        _type = com.GetType();
        ProgId = progId;
    }

    public string ProgId { get; }

    /// <summary>Raised for every engine event, already shaped for the wire.</summary>
    public event Action<JsonObject>? Notify;

    /// <summary>
    /// Whether an incoming web app session takes over the one being debugged. Off by default:
    /// silently abandoning the session the developer is standing in is the worse surprise.
    /// </summary>
    public bool AcceptNewWebAppSessions { get; set; }

    public static Engine Create(string? preferredProgId)
    {
        var candidates = preferredProgId is { Length: > 0 }
            ? new[] { preferredProgId }.Concat(ProgIds).ToArray()
            : ProgIds;

        var tried = new List<string>();
        foreach (var progId in candidates)
        {
            var type = Type.GetTypeFromProgID(progId, throwOnError: false);
            if (type is null)
            {
                tried.Add(progId);
                continue;
            }

            var instance = Activator.CreateInstance(type);
            if (instance is null)
            {
                tried.Add(progId);
                continue;
            }

            return new Engine(instance, progId);
        }

        throw new InvalidOperationException(
            "No DataFlex debugger engine is registered. Tried: " + string.Join(", ", tried) +
            ". The engine ships as Bin64\\vdfdbg.dll with a DataFlex 26 installation and is " +
            "64-bit only.");
    }

    /// <summary>Advises the sink on the engine's connection point.</summary>
    public void Connect()
    {
        if (_com is not IConnectionPointContainer container)
        {
            throw new InvalidOperationException("The engine does not expose IConnectionPointContainer.");
        }

        var iid = typeof(IDebuggerEngineEvents).GUID;
        container.FindConnectionPoint(ref iid, out var point);
        if (point is null)
        {
            throw new InvalidOperationException("The engine has no _IDebuggerEngineEvents connection point.");
        }

        point.Advise(new EngineSink(this), out var cookie);
        _connectionPoint = point;
        _cookie = cookie;
    }

    // -------------------------------------------------------------------------------------------
    // Execution
    // -------------------------------------------------------------------------------------------

    /// <param name="webApp">
    /// Web applications are not a separate mechanism: the same call takes a flag and a URL, and the
    /// engine drives WASDBG.dll's session and browser handling from there.
    /// </param>
    /// <param name="webApp">
    /// Passed straight through as the optional VARIANT. It is not established what the engine wants
    /// here -- a boolean, or the WebApp Server application id -- so both can be tried without
    /// rebuilding, and the two optional arguments are omitted entirely when it is null.
    /// </param>
    public void StartProgram(string commandLine, string workingDirectory, bool noDebugHeap, object? webApp, string? url)
    {
        if (webApp is null)
        {
            Call("StartProgram", commandLine, workingDirectory, noDebugHeap);
            return;
        }

        Call("StartProgram", commandLine, workingDirectory, noDebugHeap, webApp, url ?? string.Empty);
    }

    public void AttachProcess(uint pid) => Call("AttachProcess", pid);

    public uint[] GetAttachableProcesses()
    {
        var result = Call("GetAttachableProcesses");
        return result switch
        {
            uint[] pids => pids,
            int[] signed => signed.Select(i => (uint)i).ToArray(),
            System.Collections.IEnumerable items => items.Cast<object>()
                .Select(o => Convert.ToUInt32(o, CultureInfo.InvariantCulture)).ToArray(),
            _ => Array.Empty<uint>()
        };
    }

    public void StopProgram() => Call("StopProgram");

    public void Continue() => Call("Continue");

    public void StepInto() => Call("StepInto");

    public void StepOver() => Call("StepOver");

    public void StepOut() => Call("StepOut");

    public void Pause() => Call("Pause");

    public void RunToLine(string file, uint line) => Call("RunToLine", file, line);

    public bool SetNextInstruction(string file, uint line) => AsBool(Call("SetNextInstruction", file, line));

    // -------------------------------------------------------------------------------------------
    // Breakpoints
    // -------------------------------------------------------------------------------------------

    /// <summary>
    /// Sets a breakpoint, returning whether it took and the line the engine moved it to.
    /// </summary>
    /// <remarks>
    /// The line is in/out because DataFlex breakpoints bind to an instruction, not to a line: ask
    /// for a blank line or a declaration and the engine answers with the next line that has code.
    /// That adjusted line is what a DAP client must be told, or the marker sits where nothing will
    /// ever stop. Refused entirely before the program is loaded, so callers must apply pending
    /// breakpoints once the program reports it has initialised.
    /// </remarks>
    public (bool Ok, uint Line) SetBreakPoint(string file, uint line)
    {
        var args = new object?[] { file, line };
        var ok = AsBool(CallByRef("SetBreakPoint", args, 1));
        return (ok, Convert.ToUInt32(args[1], CultureInfo.InvariantCulture));
    }

    public (bool Ok, uint Line) SetBreakPointCondition(string file, uint line, string expression)
    {
        var args = new object?[] { file, line, expression };
        var ok = AsBool(CallByRef("SetBreakPointCondition", args, 1));
        return (ok, Convert.ToUInt32(args[1], CultureInfo.InvariantCulture));
    }

    public bool RemoveBreakPoint(string file, uint line) => AsBool(Call("RemoveBreakPoint", file, line));

    public bool IsValidSourceFile(string file) => AsBool(Call("IsValidSourceFile", file));

    public int GetCommandFromSourceLine(string file, uint line) =>
        Convert.ToInt32(Call("GetCommandFromSourceLine", file, line), CultureInfo.InvariantCulture);

    // -------------------------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------------------------

    /// <summary>Evaluates an expression in whichever queue level is currently selected.</summary>
    public (bool Ok, string Value) Eval(string expression)
    {
        var args = new object?[] { expression, string.Empty };
        var ok = AsBool(CallByRef("Eval", args, 1));
        return (ok, args[1] as string ?? string.Empty);
    }

    public void SelectActiveQueueLevel(int level) => Call("SelectActiveQueueLevel", level);

    /// <summary>
    /// Walks the debuggee's call chain, innermost frame first.
    /// </summary>
    /// <remarks>
    /// There is no API that returns the stack. <c>ICallStack</c> is an ActiveX control whose entire
    /// interface is two column widths and a colour theme, so the frames are recovered by selecting
    /// each queue level and reading the <c>OnUpdateView</c> the engine fires in response.
    ///
    /// Two traps, both established by experiment:
    ///
    /// A repeated location is not the end of the chain. Recursion genuinely repeats a call site,
    /// and stopping at the first repeat truncated a 15-frame stack to 8. The only reliable end is
    /// the error the engine raises one level past the last.
    ///
    /// The last level is the paused frame, not the first. Level 0 is the outermost frame, and
    /// locals resolve only in the level that owns them, so leaving the walk finished at level 0
    /// would make every local in the frame the user is looking at read "out of scope". The walk
    /// therefore ends by selecting the innermost level again.
    /// </remarks>
    public List<Frame> Stack()
    {
        var frames = new List<Frame>();
        for (var level = 0; level < MaxStackDepth; level++)
        {
            _lastView = null;
            try
            {
                SelectActiveQueueLevel(level);
            }
            catch (Exception)
            {
                break;
            }

            if (!Pump.Until(() => _lastView is not null, UpdateViewTimeoutMs) || _lastView is null)
            {
                break;
            }

            frames.Add(new Frame(level, _lastView.Value.File, (int)_lastView.Value.Line));
        }

        frames.Reverse();
        if (frames.Count > 0)
        {
            SelectActiveQueueLevel(frames[0].Level);
        }

        return frames;
    }

    private const int MaxStackDepth = 512;
    private const int UpdateViewTimeoutMs = 400;

    // -------------------------------------------------------------------------------------------
    // Events, called from the sink
    // -------------------------------------------------------------------------------------------

    internal void CountMessage() => Interlocked.Increment(ref _messageCount);

    internal void RaiseInit() => Send("init");

    internal void RaiseExit() => Send("exit");

    internal void RaiseContinued() => Send("continued");

    internal void RaisePaused(string file, uint line, bool limited)
    {
        _lastView = (file, line);
        var payload = Payload("paused");
        payload["file"] = file;
        payload["line"] = line;
        payload["limitedBreakMode"] = limited;
        Notify?.Invoke(payload);
    }

    internal void RaiseUpdateView(string file, uint line)
    {
        _lastView = (file, line);
        var payload = Payload("updateView");
        payload["file"] = file;
        payload["line"] = line;
        Notify?.Invoke(payload);
    }

    internal void RaiseError(string kind, string message)
    {
        var payload = Payload(kind);
        payload["message"] = message;
        Notify?.Invoke(payload);
    }

    internal void RaiseException(string description)
    {
        var payload = Payload("exception");
        payload["description"] = description;
        Notify?.Invoke(payload);
    }

    internal void RaiseWebAppLog(int eventId, string text)
    {
        var payload = Payload("webAppLog");
        payload["eventId"] = eventId;
        payload["text"] = text;
        Notify?.Invoke(payload);
    }

    internal void RaiseWebAppSession(bool accepted)
    {
        var payload = Payload("webAppSession");
        payload["accepted"] = accepted;
        Notify?.Invoke(payload);
    }

    private void Send(string name) => Notify?.Invoke(Payload(name));

    private static JsonObject Payload(string name) => new() { ["event"] = name };

    // -------------------------------------------------------------------------------------------

    private object? Call(string name, params object?[] args) =>
        _type.InvokeMember(name, BindingFlags.InvokeMethod, null, _com, args, CultureInfo.InvariantCulture);

    private object? CallByRef(string name, object?[] args, params int[] byRefIndexes)
    {
        var modifier = new ParameterModifier(args.Length);
        foreach (var index in byRefIndexes)
        {
            modifier[index] = true;
        }

        return _type.InvokeMember(
            name, BindingFlags.InvokeMethod, null, _com, args, new[] { modifier },
            CultureInfo.InvariantCulture, null);
    }

    private static bool AsBool(object? value) =>
        value is not null && Convert.ToBoolean(value, CultureInfo.InvariantCulture);

    public void Dispose()
    {
        if (_connectionPoint is not null && _cookie != 0)
        {
            try
            {
                _connectionPoint.Unadvise(_cookie);
            }
            catch (Exception)
            {
                // Tearing down a session that has already gone is not worth reporting.
            }
        }

        _connectionPoint = null;
        _cookie = 0;
    }
}
