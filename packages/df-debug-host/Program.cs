using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace DataFlex.Debug.Host;

/// <summary>
/// A line-delimited JSON bridge to the DataFlex debugger engine.
/// </summary>
/// <remarks>
/// Deliberately not a debug adapter. The Debug Adapter Protocol is implemented in TypeScript in
/// packages/df-debug, because the interesting half of a DataFlex variables pane is knowing which
/// locals are in scope at a line, and the language server already knows that. Duplicating the
/// parser here to satisfy a protocol boundary would be the tail wagging the dog.
///
/// So this process is the smallest thing that only it can do: own an STA, pump messages, hold the
/// connection point, and translate calls. One JSON object per line in each direction. Requests
/// carry an <c>id</c> and get exactly one reply with the same <c>id</c>; anything without an
/// <c>id</c> is an event from the engine.
/// </remarks>
internal static class Program
{
    private static readonly object WriteLock = new();
    private static readonly JsonSerializerOptions Compact = new() { WriteIndented = false };

    [STAThread]
    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);

        var preferredProgId = ReadOption(args, "--prog-id");

        Engine engine;
        try
        {
            engine = Engine.Create(preferredProgId);
            engine.Connect();
        }
        catch (Exception ex)
        {
            WriteFatal(ex.Message);
            return 1;
        }

        engine.Notify += Write;
        Write(new JsonObject { ["event"] = "ready", ["progId"] = engine.ProgId });

        var incoming = new ConcurrentQueue<string>();
        var stdinClosed = false;
        // Signalled when a command arrives, so the loop below can block on the message queue and
        // this handle together rather than waking on a timer to check both.
        using var arrived = new AutoResetEvent(false);

        var reader = new Thread(() =>
        {
            string? line;
            while ((line = Console.In.ReadLine()) is not null)
            {
                incoming.Enqueue(line);
                arrived.Set();
            }

            Volatile.Write(ref stdinClosed, true);
            arrived.Set();
        })
        {
            IsBackground = true,
            Name = "stdin"
        };
        reader.Start();

        var running = true;
        while (running)
        {
            // The pump must run even when no command is pending: this is how OnProgramPaused and
            // the rest of the engine's events reach this process at all.
            Pump.Once();

            while (incoming.TryDequeue(out var line))
            {
                if (line.Length == 0)
                {
                    continue;
                }

                if (!Handle(engine, line))
                {
                    running = false;
                    break;
                }
            }

            if (Volatile.Read(ref stdinClosed) && incoming.IsEmpty)
            {
                running = false;
                continue;
            }

            // Blocks until the engine marshals a call in or a command arrives. Polling with a sleep
            // here is what made a web application startup crawl: every one of the engine's
            // callbacks waited out the sleep before it could be dispatched.
            Pump.Wait(200, new[] { arrived.SafeWaitHandle.DangerousGetHandle() });
        }

        try
        {
            engine.StopProgram();
        }
        catch (Exception)
        {
            // The program may already have exited; shutting down is not the place to complain.
        }

        engine.Dispose();
        return 0;
    }

    /// <returns>False when the host should shut down.</returns>
    private static bool Handle(Engine engine, string line)
    {
        JsonObject request;
        try
        {
            request = JsonNode.Parse(line) as JsonObject
                      ?? throw new InvalidOperationException("not a JSON object");
        }
        catch (Exception ex)
        {
            Write(new JsonObject { ["event"] = "error", ["message"] = "unreadable request: " + ex.Message });
            return true;
        }

        var id = request["id"]?.GetValue<int>();
        var command = request["cmd"]?.GetValue<string>() ?? string.Empty;

        if (command == "shutdown")
        {
            Reply(id, new JsonObject());
            return false;
        }

        try
        {
            Reply(id, Dispatch(engine, command, request));
        }
        catch (Exception ex)
        {
            // COM failures arrive wrapped; the inner message is the one worth showing.
            var message = (ex.InnerException ?? ex).Message;
            Write(new JsonObject { ["id"] = id, ["ok"] = false, ["error"] = message });
        }

        return true;
    }

    private static JsonObject Dispatch(Engine engine, string command, JsonObject request)
    {
        switch (command)
        {
            case "ping":
                return new JsonObject
                {
                    ["progId"] = engine.ProgId,
                    // How many OnNewMessage callbacks the engine has delivered. Every one is a
                    // marshalled COM call into this apartment, so it is the first number to look at
                    // when a session is slow.
                    ["messages"] = engine.MessageCount
                };

            case "start":
                engine.StartProgram(
                    Str(request, "exe"),
                    Str(request, "cwd"),
                    Bool(request, "noDebugHeap"),
                    WebAppArgument(request["webApp"]),
                    request["url"]?.GetValue<string>());
                return new JsonObject();

            case "attach":
                engine.AttachProcess(UInt(request, "pid"));
                return new JsonObject();

            case "attachable":
            {
                var processes = new JsonArray();
                foreach (var pid in engine.GetAttachableProcesses())
                {
                    processes.Add(pid);
                }

                return new JsonObject { ["processes"] = processes };
            }

            case "stop":
                engine.StopProgram();
                return new JsonObject();

            case "continue":
                engine.Continue();
                return new JsonObject();

            case "stepInto":
                engine.StepInto();
                return new JsonObject();

            case "stepOver":
                engine.StepOver();
                return new JsonObject();

            case "stepOut":
                engine.StepOut();
                return new JsonObject();

            case "pause":
                engine.Pause();
                return new JsonObject();

            case "runToLine":
                engine.RunToLine(Str(request, "file"), UInt(request, "line"));
                return new JsonObject();

            case "setNextInstruction":
                return new JsonObject
                {
                    ["moved"] = engine.SetNextInstruction(Str(request, "file"), UInt(request, "line"))
                };

            case "setBreakpoint":
            {
                var condition = request["condition"]?.GetValue<string>();
                var (ok, actualLine) = string.IsNullOrEmpty(condition)
                    ? engine.SetBreakPoint(Str(request, "file"), UInt(request, "line"))
                    : engine.SetBreakPointCondition(Str(request, "file"), UInt(request, "line"), condition);
                return new JsonObject { ["verified"] = ok, ["line"] = actualLine };
            }

            case "removeBreakpoint":
                return new JsonObject
                {
                    ["removed"] = engine.RemoveBreakPoint(Str(request, "file"), UInt(request, "line"))
                };

            case "isValidSource":
                return new JsonObject { ["valid"] = engine.IsValidSourceFile(Str(request, "file")) };

            case "commandFromLine":
                return new JsonObject
                {
                    ["command"] = engine.GetCommandFromSourceLine(Str(request, "file"), UInt(request, "line"))
                };

            case "selectLevel":
                engine.SelectActiveQueueLevel(Int(request, "level"));
                return new JsonObject();

            case "eval":
            {
                var level = request["level"]?.GetValue<int>();
                if (level is not null)
                {
                    engine.SelectActiveQueueLevel(level.Value);
                }

                var (ok, value) = engine.Eval(Str(request, "expr"));
                return new JsonObject { ["success"] = ok, ["value"] = value };
            }

            case "stack":
            {
                var frames = new JsonArray();
                foreach (var frame in engine.Stack())
                {
                    frames.Add(new JsonObject
                    {
                        ["level"] = frame.Level,
                        ["file"] = frame.File,
                        ["line"] = frame.Line
                    });
                }

                return new JsonObject { ["frames"] = frames };
            }

            case "emulateProcessPooling":
            {
                var result = new JsonObject();
                if (request["value"] is { } wanted)
                {
                    var set = WebAppServer.TrySet(wanted.GetValue<bool>(), out var setError);
                    result["set"] = set;
                    if (setError is not null)
                    {
                        result["setError"] = setError;
                    }
                }

                var readable = WebAppServer.TryGet(out var emulating, out var getError);
                result["readable"] = readable;
                result["emulating"] = emulating;
                if (getError is not null)
                {
                    result["getError"] = getError;
                }

                return result;
            }

            case "acceptWebAppSessions":
                engine.AcceptNewWebAppSessions = Bool(request, "value");
                return new JsonObject();

            default:
                throw new InvalidOperationException("unknown command: " + command);
        }
    }

    private static void Reply(int? id, JsonObject payload)
    {
        payload["id"] = id;
        payload["ok"] = true;
        Write(payload);
    }

    private static void Write(JsonObject payload)
    {
        var text = payload.ToJsonString(Compact);
        lock (WriteLock)
        {
            Console.Out.WriteLine(text);
            Console.Out.Flush();
        }
    }

    private static void WriteFatal(string message) =>
        Write(new JsonObject { ["event"] = "fatal", ["message"] = message });

    /// <summary>
    /// The optional `webApp` VARIANT: a boolean, an application id, or nothing at all.
    /// </summary>
    private static object? WebAppArgument(JsonNode? node)
    {
        if (node is null)
        {
            return null;
        }

        var value = node.GetValue<object>();
        return value switch
        {
            bool flag => flag ? true : null,
            string id when id.Length > 0 => id,
            _ => node.ToString() is { Length: > 0 } text && text != "false" ? text : null
        };
    }

    private static string Str(JsonObject o, string key) => o[key]?.GetValue<string>() ?? string.Empty;

    private static bool Bool(JsonObject o, string key) => o[key]?.GetValue<bool>() ?? false;

    private static int Int(JsonObject o, string key) =>
        o[key] is { } node ? Convert.ToInt32(node.GetValue<double>(), CultureInfo.InvariantCulture) : 0;

    private static uint UInt(JsonObject o, string key) =>
        o[key] is { } node ? Convert.ToUInt32(node.GetValue<double>(), CultureInfo.InvariantCulture) : 0u;

    private static string? ReadOption(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == name)
            {
                return args[i + 1];
            }
        }

        return null;
    }
}
