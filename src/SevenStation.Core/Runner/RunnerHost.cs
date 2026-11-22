using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Text;
using System.Text.Json.Nodes;
using SevenStation.Core.Rpc;
using SevenStation.Shared;

namespace SevenStation.Core.Runner;

/// <summary>
/// 执行代理：核心以 <c>--runner</c> 起它，让它待在用户登录的会话里。
/// 它只会一件事——按核心说的起进程、把三根管子转回去；Pi 怎么用、说什么话都归核心管。
/// </summary>
internal static class RunnerHost
{
    private const int PipeBuffer = 64 * 1024;

    public static int Run()
    {
        try
        {
            Log.Initialize(Path.Combine(ProductPaths.ClientHome, "logs"), "runner.log");
        }
        catch
        {
            // 日志写不了也照常干活。
        }

        Log.Write($"执行代理启动，PID {Environment.ProcessId}，" +
            $"用户 {Environment.UserDomainName}\\{Environment.UserName}，会话 {Process.GetCurrentProcess().SessionId}");

        while (true)
        {
            NamedPipeServerStream? server;
            try
            {
                server = new NamedPipeServerStream(
                    RunnerClient.PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous, PipeBuffer, PipeBuffer);
            }
            catch (Exception error)
            {
                // 已经有一个在跑了（同一个用户只该有一个）。
                Log.Write("建不出管道，可能已经有一个代理在跑：" + error.Message);
                return 0;
            }

            using (server)
            {
                server.WaitForConnection();
                Log.Write("核心连上来了。");
                new RunnerConnection(server).Serve();
                Log.Write("核心断开了，收掉这条连接上的 Pi。");
            }
        }
    }
}

/// <summary>一条管道连接 = 一个核心。核心没了就把它的 Pi 全收掉，别留孤儿进程。</summary>
internal sealed class RunnerConnection
{
    private readonly NamedPipeServerStream _pipe;
    private readonly StreamReader _reader;
    private readonly StreamWriter _writer;
    private readonly object _writeLock = new();
    private readonly Dictionary<string, Process> _children = new(StringComparer.Ordinal);

    public RunnerConnection(NamedPipeServerStream pipe)
    {
        _pipe = pipe;
        _reader = new StreamReader(pipe, new UTF8Encoding(false));
        _writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true };
    }

    public void Serve()
    {
        try
        {
            while (_reader.ReadLine() is { } line)
            {
                if (line.Length == 0)
                {
                    continue;
                }

                JsonObject? frame;
                try
                {
                    frame = JsonNode.Parse(line) as JsonObject;
                }
                catch
                {
                    continue;
                }

                if (frame is null)
                {
                    continue;
                }

                try
                {
                    Handle(frame);
                }
                catch (Exception error)
                {
                    Log.Write("代理处理请求失败：" + error.Message, error);
                    Send(new JsonObject
                    {
                        ["op"] = "failed",
                        ["id"] = frame["id"]?.GetValue<string>() ?? string.Empty,
                        ["message"] = error.Message,
                    });
                }
            }
        }
        catch (Exception error)
        {
            Log.Write("读管道失败：" + error.Message);
        }
        finally
        {
            KillAll();
        }
    }

    private void Handle(JsonObject frame)
    {
        var id = frame["id"]?.GetValue<string>() ?? string.Empty;
        switch (frame["op"]?.GetValue<string>())
        {
            case "start":
                Start(frame, id);
                break;

            case "line":
                if (_children.TryGetValue(id, out var target))
                {
                    try
                    {
                        target.StandardInput.WriteLine(frame["text"]?.GetValue<string>() ?? string.Empty);
                        target.StandardInput.Flush();
                    }
                    catch (IOException)
                    {
                        // 已经退出了。
                    }
                }

                break;

            case "eof":
                if (_children.TryGetValue(id, out var closing))
                {
                    try
                    {
                        closing.StandardInput.Close();
                    }
                    catch
                    {
                        // 已退出。
                    }
                }

                break;

            case "kill":
                if (_children.TryGetValue(id, out var victim))
                {
                    try
                    {
                        victim.Kill(entireProcessTree: true);
                    }
                    catch
                    {
                        // 已退出。
                    }
                }

                break;
        }
    }

    /// <summary>
    /// 在自己这个会话里起进程：这就是全部的意义 —— 环境、凭据、窗口站都是登录用户的。
    /// </summary>
    private void Start(JsonObject frame, string id)
    {
        var exe = frame["exe"]?.GetValue<string>()
            ?? throw new InvalidOperationException("没有给可执行文件。");

        var psi = new ProcessStartInfo(exe)
        {
            WorkingDirectory = frame["cwd"]?.GetValue<string>() ?? Environment.CurrentDirectory,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false),
        };

        if (frame["args"] is JsonArray arguments)
        {
            foreach (var argument in arguments)
            {
                psi.ArgumentList.Add(argument?.GetValue<string>() ?? string.Empty);
            }
        }

        if (frame["env"] is JsonObject environment)
        {
            foreach (var pair in environment)
            {
                psi.Environment[pair.Key] = pair.Value?.GetValue<string>() ?? string.Empty;
            }
        }

        Log.Write($"起进程 {exe}，工作目录 {psi.WorkingDirectory}，参数 {psi.ArgumentList.Count} 个");
        var process = Process.Start(psi)
            ?? throw new InvalidOperationException("起不来：" + exe);
        Log.Write($"进程起来了，PID {process.Id}");

        _children[id] = process;
        Send(new JsonObject { ["op"] = "started", ["id"] = id, ["pid"] = process.Id });

        _ = Task.Run(() => Pump(process.StandardOutput, id, "out"));
        _ = Task.Run(() => Pump(process.StandardError, id, "err"));
        _ = Task.Run(() =>
        {
            var code = -1;
            try
            {
                process.WaitForExit();
                code = process.ExitCode;
            }
            catch
            {
                // 拿不到退出码就算了。
            }

            _children.Remove(id);
            Send(new JsonObject { ["op"] = "exit", ["id"] = id, ["code"] = code });
            process.Dispose();
        });
    }

    private void Pump(StreamReader reader, string id, string op)
    {
        try
        {
            while (reader.ReadLine() is { } line)
            {
                Send(new JsonObject { ["op"] = op, ["id"] = id, ["text"] = line });
            }
        }
        catch
        {
            // 进程退出时正常发生。
        }
    }

    private void Send(JsonObject frame)
    {
        lock (_writeLock)
        {
            try
            {
                _writer.WriteLine(frame.ToJsonString());
            }
            catch
            {
                // 核心断了，上层会把子进程收掉。
            }
        }
    }

    private void KillAll()
    {
        foreach (var process in _children.Values.ToArray())
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch
            {
                // 已退出。
            }
        }

        _children.Clear();
    }
}
