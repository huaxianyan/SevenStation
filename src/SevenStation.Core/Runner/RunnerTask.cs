using System.Diagnostics;

namespace SevenStation.Core.Runner;

/// <summary>
/// 执行代理的登录任务。注册这件事由 Seven Station Control 做（它就在用户会话里，用当前用户建自己的
/// 登录任务不需要管理员），核心这边只负责查状态和叫人重启。
/// </summary>
internal static class RunnerTask
{
    public const string Name = "SevenStation Core Runner";

    private static readonly object Gate = new();
    private static bool _registered;
    private static DateTime _checkedAt = DateTime.MinValue;

    /// <summary>查一次就缓存几秒：Control 会轮询状态，别每次都去拉一个进程。</summary>
    public static bool IsRegistered()
    {
        lock (Gate)
        {
            if (DateTime.UtcNow - _checkedAt < TimeSpan.FromSeconds(5))
            {
                return _registered;
            }

            _registered = Run("/query /tn \"" + Name + "\"") == 0;
            _checkedAt = DateTime.UtcNow;
            return _registered;
        }
    }

    /// <summary>让任务立刻跑一次。任务不在已登录的会话里时 schtasks 会报错，照实返回。</summary>
    public static bool Start() => Run("/run /tn \"" + Name + "\"") == 0;

    private static int Run(string arguments)
    {
        try
        {
            var info = new ProcessStartInfo("schtasks.exe")
            {
                Arguments = arguments,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            using var process = Process.Start(info);
            if (process is null)
            {
                return -1;
            }

            process.StandardOutput.ReadToEnd();
            process.StandardError.ReadToEnd();
            process.WaitForExit(5000);
            return process.HasExited ? process.ExitCode : -1;
        }
        catch
        {
            return -1;
        }
    }
}
