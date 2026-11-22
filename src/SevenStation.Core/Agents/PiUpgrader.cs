using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using SevenStation.Core.Rpc;
using SevenStation.Shared;

namespace SevenStation.Core.Agents;

/// <summary>
/// 升级 Pi 自己（<c>pi update --self</c>）或已装扩展（<c>pi update --extensions</c>）。
///
/// 必须走执行代理：Core 平时跑在 Session 0（服务角色），而 <c>pi update</c> 要读写
/// <c>~/.pi/agent</c>、还要调 npm/git——那些都是用户环境里的东西（D12）。
/// 另外 PATH 里要把 Pi 自带的 node 目录放最前：npm 装法下 node 22 就在 Pi 旁边，
/// 系统那个 node 20 跑 <c>pi update</c> 会直接死在 `enableCompileCache`（实测）。
///
/// 这里只管「跑完没有、退出码是多少」；换不换版本由 Pi 的更新器自己决定，
/// 它失败时会保持原版本（staging 清理、current-version 不动），所以不需要我们回滚。
/// </summary>
public sealed class PiUpgrader
{
    /// <summary>pi update 实测 30 多秒；给足五分钟，卡住就停掉。</summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(5);

    private readonly SemaphoreSlim _gate = new(1, 1);

    public bool Busy => _gate.CurrentCount == 0;

    /// <summary>跑一次 <c>pi update ...</c>。失败时 Message 是能直接给用户看的一句话。</summary>
    public async Task<(bool Ok, string Message)> RunAsync(IReadOnlyList<string> targets)
    {
        if (!await _gate.WaitAsync(0).ConfigureAwait(false))
        {
            return (false, "已经在升级了");
        }

        try
        {
            var launcher = PiLocator.LauncherPath;
            if (string.IsNullOrEmpty(launcher) || !File.Exists(launcher))
            {
                return (false, "找不到 Pi 的启动脚本，先确认 Pi 还装在原来那个目录");
            }

            var node = PiLocator.ResolveNode();
            var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var nodeDirectory = Path.GetDirectoryName(node);
            if (!string.IsNullOrWhiteSpace(nodeDirectory))
            {
                var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
                environment["PATH"] = path.Length == 0 ? nodeDirectory : nodeDirectory + ";" + path;
            }

            var runner = RunnerClient.TryConnect();
            if (runner is null)
            {
                return (false, "这台电脑的执行代理没连上，先确认停在登录后的桌面");
            }

            var tail = new StringBuilder();
            await using var transport = runner.Start(
                new PiCommand(node, new[] { launcher }.Concat(targets).ToArray(), environment),
                PiLocator.AgentDirectory);

            var stdout = PumpAsync(transport.Output, tail);
            var stderr = PumpAsync(transport.Error, tail);

            var finished = await Task.Run(() => transport.WaitForExit(Timeout)).ConfigureAwait(false);
            if (!finished)
            {
                transport.Kill();
                return (false, "升级卡住了，已经把它停掉");
            }

            await Task.WhenAll(stdout, stderr).ConfigureAwait(false);
            if (transport.ExitCode == 0)
            {
                return (true, string.Empty);
            }

            var reason = LastLine(tail.ToString());
            return (false, reason.Length > 0 ? reason : $"升级程序报了错（退出码 {transport.ExitCode}）");
        }
        catch (Exception error)
        {
            Log.Write("升级 Pi 失败：" + error.Message, error);
            return (false, error.Message);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>把子进程的输出读干（不读会把管道堵死），顺手留最后几行当失败原因。</summary>
    private static async Task PumpAsync(TextReader reader, StringBuilder tail)
    {
        try
        {
            while (await reader.ReadLineAsync().ConfigureAwait(false) is { } line)
            {
                var text = line.Trim();
                if (text.Length == 0)
                {
                    continue;
                }

                // 只留最后几行：npm 中间那些进度行对用户没意义。
                tail.Append(text).Append('\n');
                if (tail.Length > 4000)
                {
                    tail.Remove(0, tail.Length - 2000);
                }
            }
        }
        catch (Exception)
        {
            // 进程被杀的时候读会抛，按已经拿到的算。
        }
    }

    private static string LastLine(string text) =>
        text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .LastOrDefault()?.Trim() ?? string.Empty;
}
