using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json.Nodes;
using SevenStation.Shared;

namespace SevenStation.Core.Rpc;

/// <summary>
/// 跟用户会话里的执行代理说话的那条管道。一条管道上跑所有 Pi 会话，按 id 分帧。
/// 代理不在（没登录、被关掉）时 <see cref="TryConnect"/> 返回 null，由上层说人话，不回落成 SYSTEM 起 Pi。
/// </summary>
internal sealed class RunnerClient
{
    internal static string PipeName =>
        Environment.GetEnvironmentVariable("SEVENSTATION_RUNNER_PIPE") is { Length: > 0 } custom
            ? custom.Trim()
            : "sevenstation-runner";

    private static readonly object Gate = new();
    private static RunnerClient? _shared;

    /// <summary>执行代理现在连着没有。设置页与 Control 靠它显示状态。</summary>
    public static bool IsConnected
    {
        get
        {
            lock (Gate)
            {
                return _shared is { _dead: false };
            }
        }
    }

    /// <summary>
    /// 连着就回 true，没连就试一次再回。核心平时是懒连的（真要用 Pi 才连），
    /// 但状态页得能看出代理在不在，所以这里主动探一下。
    /// </summary>
    public static bool Probe() => IsConnected || TryConnect() is not null;

    private readonly NamedPipeClientStream _pipe;
    private readonly StreamReader _reader;
    private readonly StreamWriter _writer;
    private readonly ConcurrentDictionary<string, RunnerTransport> _sessions = new();
    private readonly object _writeLock = new();
    private int _nextId;
    private volatile bool _dead;

    private RunnerClient(NamedPipeClientStream pipe)
    {
        _pipe = pipe;
        _reader = new StreamReader(pipe, new UTF8Encoding(false));
        _writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true };
        _ = Task.Run(ReadLoop);
    }

    public static RunnerClient? TryConnect()
    {
        lock (Gate)
        {
            if (_shared is { _dead: false })
            {
                return _shared;
            }

            try
            {
                // 必须用异步句柄：同步句柄上挂着的阻塞读会把同一句柄上的写一起卡住（一边读一边写就死锁）。
                var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
                pipe.Connect(1500);
                _shared = new RunnerClient(pipe);
                Log.Write("连上执行代理（用户会话）。");
                return _shared;
            }
            catch (Exception error)
            {
                Log.Write("连不上执行代理：" + error.Message);
                return null;
            }
        }
    }

    public RunnerTransport Start(PiCommand command, string workingDirectory)
    {
        if (_dead)
        {
            throw new InvalidOperationException("执行代理的连接已经断了。");
        }

        var id = "s" + Interlocked.Increment(ref _nextId);
        var transport = new RunnerTransport(this, id);
        _sessions[id] = transport;

        var arguments = new JsonArray();
        foreach (var argument in command.Arguments)
        {
            arguments.Add(argument);
        }

        var environment = new JsonObject();
        foreach (var pair in command.Environment)
        {
            environment[pair.Key] = pair.Value;
        }

        try
        {
            Send(new JsonObject
            {
                ["op"] = "start",
                ["id"] = id,
                ["exe"] = command.Exe,
                ["args"] = arguments,
                ["cwd"] = workingDirectory,
                ["env"] = environment,
            });
        }
        catch
        {
            _sessions.TryRemove(id, out _);
            throw;
        }

        return transport;
    }

    internal void Send(JsonObject frame)
    {
        if (_dead)
        {
            throw new InvalidOperationException("执行代理的连接已经断了。");
        }

        lock (_writeLock)
        {
            try
            {
                _writer.WriteLine(frame.ToJsonString());
            }
            catch (Exception error)
            {
                _dead = true;
                throw new InvalidOperationException("写不进执行代理：" + error.Message, error);
            }
        }
    }

    internal void Forget(string id) => _sessions.TryRemove(id, out _);

    private void ReadLoop()
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

                var id = frame["id"]?.GetValue<string>();
                if (id is not null && _sessions.TryGetValue(id, out var transport))
                {
                    transport.Handle(frame);
                }
            }
        }
        catch (Exception error)
        {
            Log.Write("执行代理的管道断了：" + error.Message);
        }

        _dead = true;
        lock (Gate)
        {
            if (ReferenceEquals(_shared, this))
            {
                _shared = null;
            }
        }

        // 连接没了，这条连接上的 Pi 一并作废：代理那边已经把它们收掉了。
        foreach (var transport in _sessions.Values)
        {
            transport.Lost();
        }

        _sessions.Clear();
        _pipe.Dispose();
    }
}

/// <summary>一条管道上的一个 Pi 会话。</summary>
internal sealed class RunnerTransport : IPiTransport
{
    private readonly RunnerClient _client;
    private readonly string _id;
    private readonly BlockingLineReader _output = new();
    private readonly BlockingLineReader _error = new();
    private readonly LineInput _input;
    private readonly TaskCompletionSource<int> _exit = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private volatile bool _exited;

    public RunnerTransport(RunnerClient client, string id)
    {
        _client = client;
        _id = id;
        _input = new LineInput(this);
    }

    public Stream Input => _input;

    public TextReader Output => _output;

    public TextReader Error => _error;

    public bool HasExited => _exited;

    public int ExitCode => _exit.Task.IsCompleted ? _exit.Task.Result : -1;

    public bool WaitForExit(TimeSpan timeout) => _exit.Task.Wait(timeout);

    public void Kill()
    {
        try
        {
            _client.Send(new JsonObject { ["op"] = "kill", ["id"] = _id });
        }
        catch
        {
            // 管道断了，代理那边已经把子进程收掉了。
        }
    }

    internal void Handle(JsonObject frame)
    {
        switch (frame["op"]?.GetValue<string>())
        {
            case "out":
                _output.Push(frame["text"]?.GetValue<string>() ?? string.Empty);
                break;
            case "err":
                _error.Push(frame["text"]?.GetValue<string>() ?? string.Empty);
                break;
            case "failed":
                _error.Push(frame["message"]?.GetValue<string>() ?? "执行代理没能起 Pi。");
                Finish(-1);
                break;
            case "exit":
                Finish(frame["code"]?.GetValue<int>() ?? -1);
                break;
        }
    }

    /// <summary>代理那条连接断了：这条会话一起作废，别让上层一直等。</summary>
    internal void Lost()
    {
        _error.Push("执行代理断开了。");
        Finish(-1);
    }

    internal void SendLine(string line) =>
        _client.Send(new JsonObject { ["op"] = "line", ["id"] = _id, ["text"] = line });

    internal void SendEof()
    {
        try
        {
            _client.Send(new JsonObject { ["op"] = "eof", ["id"] = _id });
        }
        catch
        {
            // 已经断了。
        }
    }

    private void Finish(int code)
    {
        _exited = true;
        _output.Complete();
        _error.Complete();
        _exit.TrySetResult(code);
        _client.Forget(_id);
    }

    public ValueTask DisposeAsync()
    {
        // 跟直接起进程一样：先关 stdin 请它有序退出，等不到再杀。
        _input.Close();
        if (!WaitForExit(TimeSpan.FromSeconds(8)))
        {
            Kill();
        }

        _client.Forget(_id);
        return ValueTask.CompletedTask;
    }
}

/// <summary>代理推过来的行，按行排队给 PiSession 读。</summary>
internal sealed class BlockingLineReader : TextReader
{
    private readonly BlockingCollection<string> _lines = new();

    public void Push(string line)
    {
        try
        {
            _lines.Add(line);
        }
        catch (InvalidOperationException)
        {
            // 已经收尾了，后来的行丢掉。
        }
    }

    public void Complete()
    {
        try
        {
            _lines.CompleteAdding();
        }
        catch (ObjectDisposedException)
        {
            // 已经收尾了。
        }
    }

    public override string? ReadLine()
    {
        try
        {
            return _lines.TryTake(out var line, Timeout.Infinite) ? line : null;
        }
        catch (InvalidOperationException)
        {
            // 队列已经收尾（ObjectDisposedException 也是它的子类），读到尾巴了。
            return null;
        }
    }
}

/// <summary>
/// 写进 Pi 的方向：核心只会整行写，所以这里按 LF 切开，一行发一帧。
/// </summary>
internal sealed class LineInput : Stream
{
    private readonly RunnerTransport _owner;
    private readonly List<byte> _pending = new();

    public LineInput(RunnerTransport owner) => _owner = owner;

    public override bool CanRead => false;

    public override bool CanSeek => false;

    public override bool CanWrite => true;

    public override long Length => throw new NotSupportedException();

    public override long Position
    {
        get => throw new NotSupportedException();
        set => throw new NotSupportedException();
    }

    public override void Write(byte[] buffer, int offset, int count) =>
        Write(buffer.AsSpan(offset, count));

    public override void Write(ReadOnlySpan<byte> buffer)
    {
        foreach (var value in buffer)
        {
            if (value != (byte)'\n')
            {
                _pending.Add(value);
                continue;
            }

            // StreamWriter 的换行是 CRLF，行尾的 \r 要吃掉，不然 Pi 收到的 JSON 尾巴多一个字符。
            var line = Encoding.UTF8.GetString(_pending.ToArray()).TrimEnd('\r');
            _pending.Clear();
            _owner.SendLine(line);
        }
    }

    public override void Flush()
    {
        // 每行写完就发了，没有缓冲区。
    }

    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _owner.SendEof();
        }

        base.Dispose(disposing);
    }
}
