using System.Diagnostics;
using System.IO;
using System.Text.Json;
using SevenStation.Core.Agents;
using SevenStation.Shared;

namespace SevenStation.Core.Rpc;

/// <summary>
/// 定位本机已安装的 Pi。不打包自己的 Pi，只用 ~/.pi/agent 下那一份。
/// Windows 上 ~/.pi/agent/bin/pi.cmd 与 sh 脚本都不能被 CreateProcess 直接执行，
/// 所以统一走 node + pi-launcher.js，由 launcher 自己解析当前版本目录。
/// </summary>
public static class PiLocator
{
    /// <summary>配置里记下的 Pi 目录；没配过就是空串，<see cref="EnsureInstalled"/> 会给出提示。</summary>
    public static string AgentDirectory => CoreSettings.Current.Agent(AgentRegistry.PiId)?.Directory ?? string.Empty;

    /// <summary>
    /// 要喂给 node 的那个入口。Pi 有两种装法：
    /// 一种是官方安装包，落在 <c>~/.pi/agent</c>，入口是 <c>bin/pi-launcher.js</c>；
    /// 另一种是 npm 装到 <c>%LOCALAPPDATA%\pi-node\current</c> 这种地方，入口在
    /// <c>node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js</c>（见它的 package.json 的 bin）。
    /// 两种都得认，不然人家明明装了也会被判成「没有 Pi」。
    /// </summary>
    public static string LauncherPath => ResolveLaunchScript(AgentDirectory) ?? string.Empty;

    public static string? ResolveLaunchScript(string? directory)
    {
        if (string.IsNullOrWhiteSpace(directory))
        {
            return null;
        }

        var launcher = Path.Combine(directory, "bin", "pi-launcher.js");
        if (File.Exists(launcher))
        {
            return launcher;
        }

        return ResolveNpmEntry(Path.Combine(directory, "node_modules", "@earendil-works", "pi-coding-agent"));
    }

    /// <summary>npm 布局的入口：先看包里的 package.json 怎么说，读不到再按已知路径兜底。</summary>
    private static string? ResolveNpmEntry(string package)
    {
        var manifest = Path.Combine(package, "package.json");
        if (File.Exists(manifest))
        {
            try
            {
                using var document = JsonDocument.Parse(File.ReadAllText(manifest));
                if (document.RootElement.TryGetProperty("bin", out var bin))
                {
                    var entry = bin.ValueKind == JsonValueKind.String
                        ? bin.GetString()
                        : bin.TryGetProperty("pi", out var named) ? named.GetString() : null;

                    if (!string.IsNullOrWhiteSpace(entry))
                    {
                        var resolved = Path.Combine(package, entry.Replace('/', Path.DirectorySeparatorChar));
                        if (File.Exists(resolved)) return resolved;
                    }
                }
            }
            catch (Exception)
            {
                // package.json 坏了就按下面的固定路径试。
            }
        }

        foreach (var relative in new[] { "dist/bundle/cli.js", "dist/cli.js" })
        {
            var candidate = Path.Combine(package, relative.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(candidate)) return candidate;
        }

        return null;
    }

    /// <summary>这个目录是不是一份能跑的 Pi（两种布局都认）。</summary>
    public static bool IsPiDirectory(string? directory) => ResolveLaunchScript(directory) is not null;


    /// <summary>
    /// 这份 Pi 认不认 <c>--append-system-prompt</c>。老版本遇到不认识的参数会直接报错退出，
    /// 所以先问一次 <c>--help</c>；结果缓存，一个进程只问一次。
    /// </summary>
    public static bool SupportsAppendSystemPrompt { get; } = ProbeAppendSystemPrompt();

    private static bool ProbeAppendSystemPrompt()
    {
        var supported = ProbeSupported();
        // 这条只写一次（静态属性只算一次），排「规则没生效」的时候先看它。
        Log.Write(supported
            ? "给 Pi 的界面说明：会随每个会话注入（--append-system-prompt）"
            : "给 Pi 的界面说明：这个 Pi 不支持 --append-system-prompt，没有注入");
        return supported;
    }

    private static bool ProbeSupported()
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo(ResolveNode())
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                ArgumentList = { LauncherPath, "--help" },
            });
            if (process is null) return false;

            var text = process.StandardOutput.ReadToEndAsync();
            process.StandardError.ReadToEnd();
            return process.WaitForExit(4000) && text.Result.Contains("--append-system-prompt", StringComparison.Ordinal);
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>Node 解释器。优先环境变量覆盖，其次 PATH 上的 node，最后是 Pi 自带的 node 副本。</summary>
    public static string ResolveNode()
    {
        var configured = CoreSettings.Current.Agent(AgentRegistry.PiId)?.Node;
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured))
        {
            return configured;
        }

        var overridePath = Environment.GetEnvironmentVariable("PI_GUI_NODE");
        if (!string.IsNullOrWhiteSpace(overridePath) && File.Exists(overridePath))
        {
            return overridePath;
        }

        // npm 装法里 node 就在 Pi 目录旁边，服务账户的 LOCALAPPDATA 里没有它。
        if (!string.IsNullOrEmpty(AgentDirectory))
        {
            var beside = Path.Combine(AgentDirectory, "node.exe");
            if (File.Exists(beside)) return beside;
        }

        var managed = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "pi-node", "current", "node.exe");
        if (File.Exists(managed))
        {
            return managed;
        }

        // PATH 上的 node：交给系统解析，找不到时 Start 会抛异常并由调用方报给界面。
        return "node";
    }


    /// <summary>
    /// Pi 的会话目录。两种装法落点不同：
    /// 官方安装包在 &lt;家&gt;\.pi\agent\sessions（也就是 agent 目录下的 sessions），
    /// npm 装在 &lt;家&gt;\.pi\sessions。挑存在的那个，都没有就按 agent 目录的布局给一个。
    /// </summary>
    public static string SessionsDirectory()
    {
        var agent = AgentDirectory;
        var home = CoreSettings.Current.PiHome;

        var candidates = new List<string>();
        if (!string.IsNullOrEmpty(agent)) candidates.Add(Path.Combine(agent, "sessions"));
        if (!string.IsNullOrEmpty(home))
        {
            candidates.Add(Path.Combine(home, ".pi", "agent", "sessions"));
            candidates.Add(Path.Combine(home, ".pi", "sessions"));
        }

        foreach (var candidate in candidates)
        {
            if (Directory.Exists(candidate)) return candidate;
        }

        return candidates.Count > 0 ? candidates[0] : string.Empty;
    }

    public static void EnsureInstalled()
    {
        if (string.IsNullOrEmpty(AgentDirectory))
        {
            throw new InvalidOperationException(
                "还没有配置 Pi。在 Seven Station Core 的设置里填上 Pi 的安装目录，或设置环境变量 PI_AGENT_DIR 后重启 Seven Station Core。");
        }

        if (string.IsNullOrEmpty(LauncherPath) || !File.Exists(LauncherPath))
        {
            throw new FileNotFoundException(
                $"配置里的 Pi 目录下既没有 bin/pi-launcher.js，也没有 npm 包里的 dist/bundle/cli.js：{AgentDirectory}。检查目录是否被删掉或换过盘。");
        }
    }

    public static string Describe()
    {
        return $"node={ResolveNode()}; launcher={LauncherPath}";
    }

    public static bool TryStartProbe(out string detail)
    {
        try
        {
            EnsureInstalled();
            detail = Describe();
            return true;
        }
        catch (Exception ex)
        {
            detail = ex.Message;
            return false;
        }
    }
}
