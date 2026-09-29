using System.Runtime.InteropServices;

namespace DataFlex.Debug.Host;

/// <summary>
/// The WebApp Server side of debugging, which the engine does not expose.
/// </summary>
/// <remarks>
/// A DataFlex web application is served by workers the WebApp Server keeps in a pool, so a debugged
/// process is not something the Server would ever route a request to. The Studio gets around that,
/// and attaches its debuggee to the pool even for an application registered as disabled.
///
/// `Bin64\WASDBG.dll` exports <c>SetEmulateProcessPooling</c> and <c>GetEmulateProcessPooling</c>,
/// and `vdfdbg.dll` imports them, so the flag is read by the engine rather than owned by it. The
/// DLL is already loaded in this process by the time the engine exists, which is what makes calling
/// it here mean the same thing as the engine calling it: one module, one piece of state.
///
/// Undecorated exports on x64, where there is only one calling convention, so there is nothing to
/// get wrong about how they are called -- only about what they mean, which is undocumented.
/// </remarks>
internal static class WebAppServer
{
    private const string Library = "WASDBG.dll";

    [DllImport(Library, ExactSpelling = true)]
    private static extern int GetEmulateProcessPooling();

    [DllImport(Library, ExactSpelling = true)]
    private static extern void SetEmulateProcessPooling(int emulate);

    /// <summary>Whether the flag can be reached at all, and its current value.</summary>
    public static bool TryGet(out bool emulating, out string? error)
    {
        try
        {
            emulating = GetEmulateProcessPooling() != 0;
            error = null;
            return true;
        }
        catch (Exception ex)
        {
            emulating = false;
            error = ex.Message;
            return false;
        }
    }

    public static bool TrySet(bool emulate, out string? error)
    {
        try
        {
            SetEmulateProcessPooling(emulate ? 1 : 0);
            error = null;
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }
}
