using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json.Nodes;
using SevenStation.Core.Agents;
using SevenStation.Shared;

namespace SevenStation.Core.Rpc;

/// <summary>
/// 一个 <c>pi --mode rpc</c> 子进程。协议是严格 JSONL：一行一条记录，只按 LF 切分。
/// stdout 只走协议记录，stderr 只作诊断，不参与解析。
/// </summary>
public sealed class PiSession : IAsyncDisposable
{
    private readonly IPiTransport _transport;
    private readonly StreamWriter _input;
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonObject>> _pending = new();
    private readonly StringBuilder _stderr = new();
    private readonly object _writeLock = new();
    private int _nextId;
    private volatile bool _disposed;

    /// <summary>收到的每一条 stdout 记录（响应之外的会话事件与扩展请求）。</summary>
    public event Action<JsonObject>? RecordReceived;

    /// <summary>子进程退出。参数为退出码与 stderr 尾部。</summary>
    public event Action<int, string>? Exited;

    public string WorkingDirectory { get; }
    public string? SessionPath { get; }
    public bool IsRunning => !_disposed && !_transport.HasExited;

    private PiSession(IPiTransport transport, string workingDirectory, string? sessionPath)
    {
        _transport = transport;
        _input = new StreamWriter(transport.Input, new UTF8Encoding(false)) { AutoFlush = false };
        WorkingDirectory = workingDirectory;
        SessionPath = sessionPath;
    }

    public static PiSession Start(string workingDirectory, string? sessionPath)
    {
        PiLocator.EnsureInstalled();
        if (!Directory.Exists(workingDirectory))
        {
            throw new DirectoryNotFoundException($"工作目录不存在：{workingDirectory}");
        }

        // 谁起这个进程由 PiHost 决定：核心自己（用户会话）或执行代理（服务跑在 Session 0 时）。
        var transport = PiHost.Open(workingDirectory, sessionPath);
        var session = new PiSession(transport, workingDirectory, sessionPath);
        session.ReadStdout();
        session.ReadStderr();
        return session;
    }

    private void ReadStdout()
    {
        _ = Task.Run(async () =>
        {
            try
            {
                var reader = _transport.Output;
                while (await reader.ReadLineAsync().ConfigureAwait(false) is { } line)
                {
                    if (line.Length == 0)
                    {
                        continue;
                    }

                    JsonObject? record;
                    try
                    {
                        record = JsonNode.Parse(line) as JsonObject;
                    }
                    catch
                    {
                        continue;
                    }

                    if (record is null)
                    {
                        continue;
                    }

                    if (record["type"]?.GetValue<string>() == "response")
                    {
                        var id = record["id"]?.GetValue<string>();
                        if (id is not null && _pending.TryRemove(id, out var tcs))
                        {
                            tcs.TrySetResult(record);
                            continue;
                        }

                        // 没有 id 的响应（例如解析失败）也交给上层显示。
                        RecordReceived?.Invoke(record);
                        continue;
                    }

                    RecordReceived?.Invoke(record);
                }
            }
            catch (Exception ex)
            {
                _stderr.Append("[stdout 读取失败] ").Append(ex.Message).Append('\n');
            }

            int code = -1;
            try
            {
                if (_transport.WaitForExit(TimeSpan.FromSeconds(5)))
                {
                    code = _transport.ExitCode;
                }
            }
            catch
            {
                // 进程可能已被释放。
            }

            foreach (var kv in _pending)
            {
                kv.Value.TrySetException(new InvalidOperationException("Pi 子进程已退出。"));
            }

            _pending.Clear();
            Exited?.Invoke(code, StderrTail());
        });
    }

    private void ReadStderr()
    {
        _ = Task.Run(async () =>
        {
            try
            {
                var reader = _transport.Error;
                while (await reader.ReadLineAsync().ConfigureAwait(false) is { } line)
                {
                    AppendStderr(line);
                }
            }
            catch
            {
                // 进程退出时正常发生。
            }
        });
    }

    private void AppendStderr(string line)
    {
        lock (_stderr)
        {
            _stderr.Append(line).Append('\n');
            if (_stderr.Length > 32_000)
            {
                _stderr.Remove(0, _stderr.Length - 16_000);
            }
        }
    }

    public string StderrTail()
    {
        lock (_stderr)
        {
            var lines = _stderr.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries);
            return string.Join('\n', lines.TakeLast(20));
        }
    }

    /// <summary>发一条命令并等它的 response。事件不受影响，继续从 <see cref="RecordReceived"/> 流出。</summary>
    public async Task<JsonObject> SendAsync(JsonObject command, TimeSpan? timeout = null)
    {
        if (_disposed)
        {
            throw new InvalidOperationException("会话已关闭。");
        }

        var id = "req-" + Interlocked.Increment(ref _nextId).ToString();
        command["id"] = id;
        var tcs = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = tcs;

        try
        {
            lock (_writeLock)
            {
                _input.WriteLine(command.ToJsonString());
                _input.Flush();
            }
        }
        catch (Exception ex)
        {
            _pending.TryRemove(id, out _);
            throw new InvalidOperationException($"写入 Pi 子进程失败：{ex.Message}", ex);
        }

        var limit = timeout ?? TimeSpan.FromSeconds(30);
        var finished = await Task.WhenAny(tcs.Task, Task.Delay(limit)).ConfigureAwait(false);
        if (finished != tcs.Task)
        {
            _pending.TryRemove(id, out _);
            throw new TimeoutException($"Pi 在 {limit.TotalSeconds:0} 秒内没有响应 {command["type"]}。");
        }

        return await tcs.Task.ConfigureAwait(false);
    }

    /// <summary>写一条不期待 response 的记录（扩展 UI 应答等）。</summary>
    public void SendNoReply(JsonObject record)
    {
        if (_disposed)
        {
            return;
        }

        lock (_writeLock)
        {
            _input.WriteLine(record.ToJsonString());
            _input.Flush();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        try
        {
            // 关 stdin 请求有序退出；Pi 处理完手头工作再退出，所以给一段时间再强杀。
            _input.Close();
        }
        catch
        {
            // 已退出。
        }

        await Task.Run(() =>
        {
            if (!_transport.WaitForExit(TimeSpan.FromSeconds(8)))
            {
                _transport.Kill();
            }
        }).ConfigureAwait(false);

        await _transport.DisposeAsync().ConfigureAwait(false);
    }
}
