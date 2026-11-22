using System.Diagnostics;
using System.IO;
using System.Text;

namespace SevenStation.Core.Rpc;

/// <summary>
/// 核心自己起的 Pi 子进程。只有在核心本身就跑在用户会话里时才用（开发时直接跑、或用户态常驻）。
/// 作为服务跑在 Session 0 时走 <see cref="RunnerClient"/>，否则 Pi 拿到的是 SYSTEM 的环境。
/// </summary>
internal sealed class ProcessTransport : IPiTransport
{
    private readonly Process _process;

    private ProcessTransport(Process process) => _process = process;

    public Stream Input => _process.StandardInput.BaseStream;

    public TextReader Output => _process.StandardOutput;

    public TextReader Error => _process.StandardError;

    public bool HasExited
    {
        get
        {
            try
            {
                return _process.HasExited;
            }
            catch
            {
                return true;
            }
        }
    }

    public int ExitCode
    {
        get
        {
            try
            {
                return _process.ExitCode;
            }
            catch
            {
                return -1;
            }
        }
    }

    public static ProcessTransport Start(PiCommand command, string workingDirectory)
    {
        var psi = new ProcessStartInfo(command.Exe)
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false),
        };
        foreach (var argument in command.Arguments)
        {
            psi.ArgumentList.Add(argument);
        }

        // Pi 的家目录按真实用户算：核心如果是被别的账户拉起来的，进程自己的 ~ 未必是用户的 ~。
        foreach (var pair in command.Environment)
        {
            psi.Environment[pair.Key] = pair.Value;
        }

        var process = Process.Start(psi) ?? throw new InvalidOperationException("无法启动 Pi 子进程。");
        return new ProcessTransport(process);
    }

    public bool WaitForExit(TimeSpan timeout) => _process.WaitForExit((int)timeout.TotalMilliseconds);

    public void Kill()
    {
        try
        {
            _process.Kill(entireProcessTree: true);
        }
        catch
        {
            // 已经没了。
        }
    }

    public ValueTask DisposeAsync()
    {
        try
        {
            _process.StandardInput.Close();
        }
        catch
        {
            // 已退出。
        }

        if (!WaitForExit(TimeSpan.FromSeconds(8)))
        {
            Kill();
        }

        _process.Dispose();
        return ValueTask.CompletedTask;
    }
}
