using System.IO;

namespace SevenStation.Core.Rpc;

/// <summary>
/// Pi 子进程的传输层：谁起的、它的三根管子从哪儿来。
/// 服务跑在 Session 0 时必须走用户会话里的执行代理，否则 Pi 拿到的是 SYSTEM 的环境和窗口站。
/// </summary>
public interface IPiTransport : IAsyncDisposable
{
    /// <summary>写进 Pi 的 stdin（按行）。</summary>
    Stream Input { get; }

    /// <summary>Pi 的 stdout，协议记录一行一条。</summary>
    TextReader Output { get; }

    /// <summary>Pi 的 stderr，只作诊断。</summary>
    TextReader Error { get; }

    bool HasExited { get; }

    int ExitCode { get; }

    /// <summary>等它退出；超时返回 false。</summary>
    bool WaitForExit(TimeSpan timeout);

    void Kill();
}
