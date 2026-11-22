using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using SevenStation.Core.Agents;
using SevenStation.Shared;

namespace SevenStation.Core.Rpc;

/// <summary>
/// 决定 Pi 由谁起：核心自己（核心就在用户会话里），还是用户会话里的执行代理（核心作为服务跑在 Session 0）。
/// 代理是这个 exe 的另一个角色（<c>--runner</c>），只管起进程和转 stdio，Pi 的事仍然全在核心这边。
/// </summary>
internal static class PiHost
{
    /// <summary>
    /// 会话 0 没有桌面：服务账户起的进程都落在那里，拿不到用户的 PATH 与凭据，起的窗口也看不见。
    /// 判定按会话号来（不认账户名——有的环境里服务进程的账户名并不是 SYSTEM），
    /// 这种情况一律交给用户会话里的代理，连不上就明确报错，不回落 —— 回落等于悄悄把问题装回去。
    /// </summary>
    private static bool NoDesktopSession =>
        Process.GetCurrentProcess().SessionId == 0 ||
        string.Equals(Environment.UserName, "SYSTEM", StringComparison.OrdinalIgnoreCase);

    public static IPiTransport Open(string workingDirectory, string? sessionPath)
    {
        var command = Compose(sessionPath);
        var viaRunner = Environment.GetEnvironmentVariable("SEVENSTATION_PI_TRANSPORT")?.Trim().ToLowerInvariant() switch
        {
            "process" => false,
            "runner" => true,
            _ => NoDesktopSession,
        };

        if (!viaRunner)
        {
            return ProcessTransport.Start(command, workingDirectory);
        }

        var runner = RunnerClient.TryConnect();
        if (runner is null)
        {
            throw new InvalidOperationException(
                "Pi 需要在已登录的桌面会话里运行，那边的执行代理没连上。" +
                "确认这台电脑停在登录后的桌面（锁屏没关系），再发一次；代理的日志在 " +
                Path.Combine(ProductPaths.ClientHome, "logs", "runner.log"));
        }

        return runner.Start(command, workingDirectory);
    }

    /// <summary>node + 启动脚本 + 界面说明 + 续聊会话。解析规则都在 <see cref="PiLocator"/>。</summary>
    private static PiCommand Compose(string? sessionPath)
    {
        var arguments = new List<string> { PiLocator.LauncherPath, "--mode", "rpc" };

        // 界面把回复里的路径和网址做成可点的，怎么写才能被认出来由这份说明约定。
        // Pi 的 --append-system-prompt 只吃文本，所以这里自己读文件再传内容。
        var guidance = Path.Combine(AppContext.BaseDirectory, "Agents", "pi-guidance.md");
        try
        {
            if (File.Exists(guidance) && PiLocator.SupportsAppendSystemPrompt)
            {
                arguments.Add("--append-system-prompt");
                arguments.Add(File.ReadAllText(guidance).Trim());
            }
        }
        catch (Exception error)
        {
            Log.Write("读不到给 Pi 的界面说明：" + error.Message, error);
        }

        if (!string.IsNullOrEmpty(sessionPath))
        {
            arguments.Add("--session");
            arguments.Add(sessionPath);
        }

        // 不再自己改 USERPROFILE/HOME：Pi 现在只会由真实用户会话里的进程起（直接起或经执行代理起），
        // 那个环境本来就是用户的。以前那套覆盖是给 Session 0 打补丁的，现在反而会把配置指错。
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        return new PiCommand(PiLocator.ResolveNode(), arguments, environment);
    }
}
