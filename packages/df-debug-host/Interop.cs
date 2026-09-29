using System.Runtime.InteropServices;

namespace DataFlex.Debug.Host;

/// <summary>
/// The debugger engine's outgoing interface, `_IDebuggerEngineEvents`.
/// </summary>
/// <remarks>
/// The GUID and every DISPID come from the type library embedded in `Bin64\vdfdbg.dll`, dumped by
/// scripts/dump-typelib.ps1. They are not guesses, and they must not be reordered: the engine calls
/// <c>IDispatch::Invoke</c> by DISPID, so a wrong number silently routes a breakpoint hit into the
/// wrong handler.
///
/// PowerShell cannot subscribe to this. <c>Register-ObjectEvent</c> reports "an event with the name
/// 'OnProgramInit' does not exist" because it looks for CLR events on the runtime-callable wrapper
/// and a dispinterface connection point has none. Declaring the interface and advising it directly
/// is what works, and is the reason this host exists in C# rather than in the extension.
/// </remarks>
[ComVisible(true)]
[Guid("DF2600DE-F3F2-47A8-A96A-3123CDBFA262")]
[InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
public interface IDebuggerEngineEvents
{
    [DispId(1)] void OnProgramInit();
    [DispId(2)] void OnProgramExit();
    [DispId(3)] void OnProgramStartupError(string errorMessage);
    [DispId(4)] void OnProgramInitError(string errorMessage);
    [DispId(5)] void OnProgramPaused(string file, uint line, bool limitedBreakMode);
    [DispId(6)] void OnProgramContinue();
    [DispId(7)] void OnUpdateView(string file, uint line);
    [DispId(8)] void OnNewMessage(int stepping);
    [DispId(9)] void OnUnhandledProgramException(string description);
    [DispId(10)] void OnAcceptWebAppSession(ref bool acceptNewSession);
    [DispId(11)] void OnWebAppError(string description);
    [DispId(12)] void OnWebAppLog(int eventId, string text);
    [DispId(13)] void OnBreakPointError(string text);
}

/// <summary>Receives the engine's events and hands them to the <see cref="Engine"/>.</summary>
[ComVisible(true)]
[ClassInterface(ClassInterfaceType.None)]
public sealed class EngineSink : IDebuggerEngineEvents
{
    private readonly Engine _engine;

    public EngineSink(Engine engine) => _engine = engine;

    public void OnProgramInit() => _engine.RaiseInit();

    public void OnProgramExit() => _engine.RaiseExit();

    public void OnProgramStartupError(string errorMessage) => _engine.RaiseError("startupError", errorMessage);

    public void OnProgramInitError(string errorMessage) => _engine.RaiseError("initError", errorMessage);

    public void OnProgramPaused(string file, uint line, bool limitedBreakMode) =>
        _engine.RaisePaused(file, line, limitedBreakMode);

    public void OnProgramContinue() => _engine.RaiseContinued();

    public void OnUpdateView(string file, uint line) => _engine.RaiseUpdateView(file, line);

    /// <remarks>
    /// Fires for every message the program executes, which is far too much traffic to forward and
    /// is not needed for anything the adapter does. Counted so the count can be reported if a
    /// session ever needs to prove the program is running.
    /// </remarks>
    public void OnNewMessage(int stepping) => _engine.CountMessage();

    public void OnUnhandledProgramException(string description) => _engine.RaiseException(description);

    /// <remarks>
    /// A second browser session arriving mid-debug. Accepting abandons the session being debugged;
    /// denying keeps it. The engine asks by reference and the answer decides, so the default here
    /// is deliberate rather than incidental: keep the session the developer is standing in.
    /// </remarks>
    public void OnAcceptWebAppSession(ref bool acceptNewSession)
    {
        acceptNewSession = _engine.AcceptNewWebAppSessions;
        _engine.RaiseWebAppSession(acceptNewSession);
    }

    public void OnWebAppError(string description) => _engine.RaiseError("webAppError", description);

    public void OnWebAppLog(int eventId, string text) => _engine.RaiseWebAppLog(eventId, text);

    public void OnBreakPointError(string text) => _engine.RaiseError("breakpointError", text);
}

/// <summary>Win32 message pump, the transport for cross-thread COM event calls.</summary>
/// <remarks>
/// The engine is apartment-threaded and runs the debuggee on its own thread. A call raised there
/// and marshalled to this STA arrives as a window message, so without pumping, nothing is ever
/// delivered: <c>StartProgram</c> succeeds and then the session appears to hang.
/// </remarks>
internal static class Pump
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Msg
    {
        public IntPtr Hwnd;
        public uint Message;
        public IntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public int X;
        public int Y;
    }

    private const uint PmRemove = 1;

    /// <summary>Wake on any input, and return at once if something is already queued.</summary>
    private const uint QsAllInput = 0x04FF;

    private const uint MwmoInputAvailable = 0x0004;

    [DllImport("user32.dll")]
    private static extern bool PeekMessage(out Msg msg, IntPtr hWnd, uint filterMin, uint filterMax, uint remove);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref Msg msg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Msg msg);

    [DllImport("user32.dll")]
    private static extern uint MsgWaitForMultipleObjectsEx(
        uint count,
        IntPtr[] handles,
        uint milliseconds,
        uint wakeMask,
        uint flags);

    /// <summary>Dispatches everything currently queued and returns.</summary>
    public static void Once()
    {
        while (PeekMessage(out var msg, IntPtr.Zero, 0, 0, PmRemove))
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
    }

    /// <summary>
    /// Blocks until a window message arrives, one of <paramref name="handles"/> is signalled, or
    /// the timeout expires.
    /// </summary>
    /// <remarks>
    /// This is the difference between a debug session that keeps up and one that crawls. A COM call
    /// marshalled into this apartment is delivered by dispatching a window message, so a pump that
    /// sleeps between polls adds its sleep to the latency of *every* callback the engine makes. At
    /// 2 ms a poll that is invisible on a program that raises a few hundred events and minutes of
    /// wall clock on a web application startup that raises hundreds of thousands.
    /// </remarks>
    public static void Wait(int milliseconds, IntPtr[]? handles = null)
    {
        var count = handles is null ? 0u : (uint)handles.Length;
        MsgWaitForMultipleObjectsEx(
            count,
            handles ?? Array.Empty<IntPtr>(),
            (uint)milliseconds,
            QsAllInput,
            MwmoInputAvailable);
    }

    /// <summary>Pumps until <paramref name="until"/> is true or the timeout expires.</summary>
    public static bool Until(Func<bool> until, int timeoutMilliseconds)
    {
        var deadline = Environment.TickCount64 + timeoutMilliseconds;
        while (true)
        {
            Once();
            if (until())
            {
                return true;
            }

            var remaining = deadline - Environment.TickCount64;
            if (remaining <= 0)
            {
                return until();
            }

            Wait((int)Math.Min(remaining, 50));
        }
    }
}
