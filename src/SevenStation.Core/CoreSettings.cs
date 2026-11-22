using System.IO;
using Microsoft.Win32;
using SevenStation.Core.Rpc;
using System.Text.Json;
using System.Text.Json.Serialization;
using SevenStation.Shared;

namespace SevenStation.Core;

/// <summary>
/// Seven Station Core 的配置。安装时不问 Pi 装在哪：第一次启动自己找一遍，找到什么写进这里，之后都按配置走。
/// Pi 只是目前唯一实现了的 Agent，配置按 Agent 分组存，以后接别的不用改结构。
/// </summary>
public sealed class CoreSettings
{
    private static readonly JsonSerializerOptions Format = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>进程内唯一的一份，启动时装载，界面改了就重写。</summary>
    public static CoreSettings Current { get; private set; } = new();

    /// <summary>监听地址。命令行环境变量优先于它，方便开发时临时换端口。</summary>
    public string Listen { get; set; } = "http://127.0.0.1:8787";

    /// <summary>已纳入配置的 Agent，键是 Agent 标识（目前只有 <c>pi</c>）。</summary>
    public Dictionary<string, AgentSettings> Agents { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    public AgentSettings? Agent(string id) =>
        Agents.TryGetValue(id, out var found) ? found : null;

    /// <summary>
    /// Pi 所在的用户家目录。Seven Station Core 作为服务跑在系统账户下时，进程自己的家目录是
    /// <c>C:\Windows\system32\config\systemprofile</c>，而技能、扩展、会话都在
    /// 真实用户的家目录里，所以这些地方一律从这里取，不要直接用进程的 UserProfile。
    /// </summary>
    public string PiHome
    {
        get
        {
            var home = Agent("pi")?.Home;
            if (!string.IsNullOrWhiteSpace(home) && Directory.Exists(home))
            {
                return home;
            }

            return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        }
    }

    /// <summary>
    /// 装载配置。文件不存在就先探测一遍本机已装的 Agent 再落盘——
    /// 这一步就是「安装后第一次启动自动把 Pi 纳进来」。探测不到也照常写文件，界面上可以再填。
    /// </summary>
    public static CoreSettings LoadOrInitialize(string path)
    {
        var exists = File.Exists(path);
        CoreSettings settings;
        if (exists)
        {
            try
            {
                settings = JsonSerializer.Deserialize<CoreSettings>(File.ReadAllText(path), Format) ?? new CoreSettings();
            }
            catch (JsonException ex)
            {
                Log.Write($"配置读不出来，按默认值重来：{ex.Message}");
                settings = new CoreSettings();
            }
        }
        else
        {
            settings = new CoreSettings();
        }

        var discovered = settings.DiscoverMissingAgents() | settings.FillMissingHomes();
        if (!exists || discovered)
        {
            settings.Save(path);
            Log.Write((exists ? "配置里缺的 Agent 已补上：" : "首次启动，已生成配置：") + path);
        }

        Current = settings;
        return settings;
    }

    public void Save(string path)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        File.WriteAllText(path, JsonSerializer.Serialize(this, Format));
    }

    /// <summary>把本机能找到、配置里还没有的 Agent 补进来。返回是否有变化。</summary>
    public bool DiscoverMissingAgents()
    {
        var changed = false;
        var pi = FindPi();
        if (pi is not null && !IsUsable(Agent("pi")))
        {
            Agents["pi"] = pi;
            Log.Write($"找到 Pi：{pi.Directory}");
            changed = true;
        }

        // Pi 要用足够新的 node 才跑得起来（1.5.x 要 22 以上）。服务账户的 PATH 和你登录时的
        // PATH 不是一回事，常常只找到一个旧版 node，于是子进程一起来就语法错误退出。
        var current = Agent("pi");

        // 配过的 node 也要复核：上一版可能挑中了系统里那个旧 node（Pi 1.5 要 22 以上），
        // 留在配置里会让子进程一起来就语法错误退出。
        if (current is not null && !string.IsNullOrWhiteSpace(current.Node))
        {
            var version = File.Exists(current.Node) ? NodeVersion(current.Node) : null;
            if (version is null || version.Major < 22)
            {
                Log.Write($"配置里的 node 版本太低或不存在（{current.Node}），重新找");
                current.Node = null;
            }
        }

        if (current is not null && string.IsNullOrWhiteSpace(current.Node))
        {
            var node = FindNode();
            if (node is not null)
            {
                current.Node = node;
                Log.Write($"用这个 node 跑 Pi：{node}");
                changed = true;
            }
        }

        return changed;
    }

    /// <summary>
    /// 找一个能跑 Pi 的 node：把常见安装位置和 PATH 里的都试一遍，跑 <c>--version</c> 取最高的那个。
    /// 只在配置里没写 node 的时候调用。
    /// </summary>
    private static string? FindNode()
    {
        var candidates = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
                     .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            candidates.Add(Path.Combine(directory.Trim(), "node.exe"));
        }

        var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var usersRoot = Path.Combine(Path.GetDirectoryName(windows) ?? "C:", "Users");

        foreach (var programFiles in new[]
                 {
                     Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                     Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                 })
        {
            if (!string.IsNullOrEmpty(programFiles))
            {
                candidates.Add(Path.Combine(programFiles, "nodejs", "node.exe"));
            }
        }

        try
        {
            foreach (var user in Directory.GetDirectories(usersRoot))
            {
                candidates.Add(Path.Combine(user, "scoop", "apps", "nodejs", "current", "node.exe"));
                // Pi 自己装的那份 node：服务账户的 LOCALAPPDATA 指向系统目录，只有按用户目录找才找得到。
                candidates.Add(Path.Combine(user, "AppData", "Local", "pi-node", "current", "node.exe"));

                var nvm = Path.Combine(user, "AppData", "Roaming", "nvm");
                if (Directory.Exists(nvm))
                {
                    foreach (var version in Directory.GetDirectories(nvm, "v*"))
                    {
                        candidates.Add(Path.Combine(version, "node.exe"));
                    }
                }

                foreach (var programFiles in new[] { "Program Files", "Program Files (x86)" })
                {
                    candidates.Add(Path.Combine(user, "AppData", "Local", programFiles, "nodejs", "node.exe"));
                }
            }
        }
        catch (Exception)
        {
            // 用户目录读不全不影响已经在列表里的候选。
        }

        string? best = null;
        var bestVersion = new Version(0, 0);
        foreach (var candidate in candidates)
        {
            if (!File.Exists(candidate))
            {
                continue;
            }

            var version = NodeVersion(candidate);
            if (version is null || version <= bestVersion)
            {
                continue;
            }

            best = candidate;
            bestVersion = version;
        }

        return best;
    }

    private static Version? NodeVersion(string nodePath)
    {
        try
        {
            using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(nodePath, "--version")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            if (process is null)
            {
                return null;
            }

            var output = process.StandardOutput.ReadToEnd().Trim();
            if (!process.WaitForExit(3000))
            {
                try { process.Kill(true); } catch (Exception) { }
                return null;
            }

            // 形如 v22.11.0，去掉前缀再解析。
            return Version.TryParse(output.TrimStart('v', 'V'), out var version) ? version : null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// 已登录用户自己设的 <c>PI_AGENT_DIR</c>。服务账户看不到用户变量，只能读各用户的注册表配置单元；
    /// 用户没登录时那份 hive 没挂载，读不到就跳过——这种情况由用户档案扫描兜底。
    /// </summary>
    private static IEnumerable<string> UserEnvironmentPiDirectories()
    {
        string[] sids;
        try
        {
            using var users = Registry.Users;
            sids = users.GetSubKeyNames();
        }
        catch (Exception)
        {
            yield break;
        }

        foreach (var sid in sids)
        {
            string? value = null;
            try
            {
                using var environment = Registry.Users.OpenSubKey(sid + @"\Environment");
                value = environment?.GetValue("PI_AGENT_DIR") as string;
            }
            catch (Exception)
            {
                // 别的用户的 hive 读不了就跳过。
            }

            if (string.IsNullOrWhiteSpace(value)) continue;
            yield return Environment.ExpandEnvironmentVariables(value.Trim());
        }
    }

    /// <summary>
    /// 所有用户的家目录：注册表里的 ProfileList 最全（家目录可能在别的盘，也可以是自定义路径），
    /// 再补上 C:\Users 下的目录兜底。
    /// </summary>
    private static IEnumerable<string> UserHomes()
    {
        var homes = new List<string>();

        try
        {
            using var list = Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList");
            foreach (var sid in list?.GetSubKeyNames() ?? [])
            {
                using var entry = list?.OpenSubKey(sid);
                if (entry?.GetValue("ProfileImagePath") is not string raw) continue;

                var home = Environment.ExpandEnvironmentVariables(raw);
                // 系统账户和默认档案里不会有 Pi，扫了也是白跑。
                var name = Path.GetFileName(home.TrimEnd(Path.DirectorySeparatorChar));
                if (string.Equals(name, "systemprofile", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(name, "Default", StringComparison.OrdinalIgnoreCase)) continue;
                if (Directory.Exists(home)) homes.Add(home);
            }
        }
        catch (Exception)
        {
            // 注册表读不了就只用下面的兜底。
        }

        var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var usersRoot = Path.Combine(Path.GetDirectoryName(windows) ?? "C:", "Users");
        try
        {
            foreach (var directory in Directory.GetDirectories(usersRoot))
            {
                if (!homes.Contains(directory, StringComparer.OrdinalIgnoreCase)) homes.Add(directory);
            }
        }
        catch (Exception)
        {
            // C:\Users 都读不了就认了。
        }

        return homes;
    }

    /// <summary>系统账户下按用户目录找一遍 Pi，最近写过的排前面。</summary>
    private static IEnumerable<(string Directory, string Home)> ProfileCandidates()
    {
        // 服务账户的家目录在 C:\Windows\system32\config 下，真正的用户目录要从注册表与 C:\Users 里找。
        var users = UserHomes().ToList();
        if (users.Count == 0)
        {
            yield break;
        }

        var found = new List<(string Directory, string Home, DateTime Stamp)>();
        foreach (var user in users)
        {
            // 两种装法都找：官方安装包在 .pi\agent，npm 装在 AppData\Local\pi-node\current。
            try
            {
                foreach (var directory in new[]
                         {
                             Path.Combine(user, ".pi", "agent"),
                             Path.Combine(user, "AppData", "Local", "pi-node", "current"),
                         })
                {
                    var script = PiLocator.ResolveLaunchScript(directory);
                    if (script is null) continue;
                    found.Add((directory, user, File.GetLastWriteTimeUtc(script)));
                }
            }
            catch (Exception)
            {
                // 别的用户目录读不了就跳过，不是错误。
            }
        }

        foreach (var entry in found.OrderByDescending(item => item.Stamp))
        {
            yield return (entry.Directory, entry.Home);
        }
    }

    /// <summary>
    /// 老配置里只记了目录没记家目录。目录在某个用户的家目录下时把家目录补上——
    /// Seven Station Core 作为服务跑，缺这一项 Pi 就会去找系统账户的 ~/.pi。
    /// </summary>
    public bool FillMissingHomes()
    {
        var changed = false;
        foreach (var agent in Agents.Values)
        {
            if (string.IsNullOrWhiteSpace(agent.Directory))
            {
                continue;
            }

            // 服务账户自己的家写进配置就是错的（Pi 会照它去找配置），一并纠正。
            if (!string.IsNullOrWhiteSpace(agent.Home) && !IsSystemProfile(agent.Home))
            {
                continue;
            }

            var home = HomeOf(agent.Directory);
            if (home is not null)
            {
                agent.Home = home;
                changed = true;
            }
        }

        return changed;
    }

    /// <summary>
    /// 服务账户自己的家目录（systemprofile）。写进配置会让 Pi 去那儿找配置，一条都找不到。
    /// </summary>
    private static bool IsSystemProfile(string home)
    {
        var normalized = home.Replace('/', '\\').TrimEnd('\\');
        return normalized.EndsWith(@"\config\systemprofile", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>从 &lt;用户目录&gt;\.pi\agent 反推用户目录；不是这个形状就返回 null。</summary>
    private static string? HomeOf(string agentDirectory)
    {
        // npm 装法：<家目录>\AppData\Local\pi-node\current
        var segments = agentDirectory.Replace('/', '\\').TrimEnd('\\').Split('\\');
        if (segments.Length >= 4
            && string.Equals(segments[^1], "current", StringComparison.OrdinalIgnoreCase)
            && string.Equals(segments[^2], "pi-node", StringComparison.OrdinalIgnoreCase)
            && string.Equals(segments[^3], "Local", StringComparison.OrdinalIgnoreCase)
            && string.Equals(segments[^4], "AppData", StringComparison.OrdinalIgnoreCase))
        {
            return segments.Length >= 5
                ? string.Join('\\', segments[..^4])
                : null;
        }

        var pi = Path.GetDirectoryName(agentDirectory);
        if (pi is null || !string.Equals(Path.GetFileName(pi), ".pi", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var home = Path.GetDirectoryName(pi);
        return string.IsNullOrEmpty(home) || !Directory.Exists(home) ? null : home;
    }

    private static bool IsUsable(AgentSettings? agent) =>
        agent is not null && Directory.Exists(agent.Directory);

    /// <summary>
    /// 找 Pi 的安装目录。Pi 把 agent 装在自己的家目录下，路径固定，所以按常见位置挨个看一遍即可。
    /// 环境变量 <c>PI_AGENT_DIR</c> 最高优先，服务账户下把路径指过去就能用。
    /// </summary>
    private static AgentSettings? FindPi()
    {
        var candidates = new List<string>();

        // 机器级变量（服务和任何账户都看得到）。
        var fromEnvironment = Environment.GetEnvironmentVariable("PI_AGENT_DIR");
        if (!string.IsNullOrWhiteSpace(fromEnvironment))
        {
            candidates.Add(fromEnvironment.Trim());
        }

        // 用户变量：服务跑在系统账户下，`Environment.GetEnvironmentVariable` 只拿到机器级的那份，
        // 用户在「环境变量」对话框里设的是 HKEY_USERS\<SID>\Environment，得自己去读。
        candidates.AddRange(UserEnvironmentPiDirectories());

        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (!string.IsNullOrEmpty(profile))
        {
            candidates.Add(Path.Combine(profile, ".pi", "agent"));
        }

        var common = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        if (!string.IsNullOrEmpty(common))
        {
            candidates.Add(Path.Combine(common, "pi", "agent"));
        }

        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (!string.IsNullOrEmpty(local))
        {
            candidates.Add(Path.Combine(local, "pi", "agent"));
        }

        foreach (var candidate in candidates)
        {
            if (PiLocator.IsPiDirectory(candidate))
            {
                return new AgentSettings
                {
                    Directory = candidate,
                    Home = HomeOf(candidate) ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                };
            }
        }

        // Seven Station Core 作为服务跑时用的是系统账户，它的家目录里没有 Pi；Pi 装在某个真实用户的家目录下。
        // 这时候挨个用户目录找一遍，挑最近动过的那个——安装完成第一次启动就是靠这一步认出 Pi。
        foreach (var (directory, home) in ProfileCandidates())
        {
            if (PiLocator.IsPiDirectory(directory))
            {
                return new AgentSettings { Directory = directory, Home = home };
            }
        }

        return null;
    }
}

/// <summary>
/// 一个 Agent 在本机的落点。<see cref="Node"/> 留给需要自己解释器的 Agent，
/// 现在只有 Pi 用得上（Windows 上要拿 node 跑 launcher）。
/// </summary>
public sealed class AgentSettings
{
    public string Directory { get; set; } = string.Empty;

    public string? Node { get; set; }

    /// <summary>
    /// 以哪个用户的家目录跑这个 Agent。Seven Station Core 作为服务跑时进程属于系统账户，
    /// 而 Pi 的配置与密钥在真实用户的家目录下，所以要显式指过去。
    /// </summary>
    public string? Home { get; set; }
}
