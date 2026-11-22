using System.Diagnostics;
using System.Runtime.InteropServices;
using SevenStation.Shared;

namespace SevenStation.Core;

/// <summary>
/// 管理员权限。Seven Station Core 交互式启动时要求它：改监听、动防火墙规则、重启服务都要，
/// 与其每动一下就弹一次确认，不如一开始就要。服务角色与执行代理不需要（前者本来就是 SYSTEM，
/// 后者刻意用普通权限，免得 Pi 继承管理员身份）。
/// </summary>
internal static class Elevation
{
    private const uint TokenQuery = 0x0008;
    private const int TokenElevation = 20;

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int kind, out int data, int length, out int returned);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static bool IsElevated
    {
        get
        {
            if (!OpenProcessToken(GetCurrentProcess(), TokenQuery, out var token))
            {
                return false;
            }

            try
            {
                return GetTokenInformation(token, TokenElevation, out var elevated, sizeof(int), out _) && elevated != 0;
            }
            finally
            {
                CloseHandle(token);
            }
        }
    }

    /// <summary>
    /// 以管理员身份重新起一个自己。带 <c>--elevated</c> 标记，保证重新起来的那份不会再要求一次
    /// ——万一判定权限的代码有毛病，也不会变成无限弹 UAC。
    /// </summary>
    public static bool Relaunch()
    {
        var exe = Environment.ProcessPath;
        if (string.IsNullOrEmpty(exe))
        {
            return false;
        }

        var script = $"Start-Process -FilePath '{exe}' -ArgumentList '--elevated' -Verb RunAs";
        try
        {
            using var process = Process.Start(new ProcessStartInfo("powershell.exe")
            {
                Arguments = "-NoProfile -WindowStyle Hidden -Command \"" + script.Replace("\"", "\\\"") + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
            });

            // Start-Process 自己会返回；用户拒了 UAC 会在它的输出里报错，这里只能看它有没有起来。
            return process is not null && process.WaitForExit(15000) && process.ExitCode == 0;
        }
        catch (Exception error)
        {
            Log.Write("起不了管理员进程：" + error.Message, error);
            return false;
        }
    }
}
