using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SevenStation.Core.Agents;

/// <summary>
/// Pi 自己与已装扩展有没有新版。
///
/// 判定照搬 Pi 的 <c>PackageManager.checkForAvailableUpdates()</c>（core/package-manager.js）：
/// 钉住的一律跳过（npm 写了精确版本或范围、git 带了任何 ref），npm 比 semver，
/// git 拿本地上游分支跟 <c>ls-remote</c> 比，任何一步出错都当「没有更新」——查不到不该在界面上惊动人。
/// 只查不装：怎么升是另一件事。
/// </summary>
public sealed class PiUpdates
{
    /// <summary>手动点「检查更新」时，缓存最多留这么久（自动的节奏是 6 小时）。</summary>
    private static readonly TimeSpan ManualTtl = TimeSpan.FromMinutes(10);

    private static readonly HttpClient Http = new()
    {
        Timeout = TimeSpan.FromSeconds(8),
    };

    private readonly Func<string> _home;
    private readonly object _lock = new();
    private readonly SemaphoreSlim _gate = new(1, 1);

    private JsonObject? _snapshot;
    private DateTime _checkedAtUtc = DateTime.MinValue;
    private bool _checking;

    public PiUpdates(Func<string> home)
    {
        _home = home;
    }

    /// <summary>上次查到的结果（没查过就只回一个 checking 标记）。给新连上的客户端补一条。</summary>
    public JsonObject Current()
    {
        lock (_lock)
        {
            var copy = _snapshot is null
                ? new JsonObject()
                : _snapshot.DeepClone().AsObject();
            copy["type"] = "updates";
            copy["checking"] = _checking;
            return copy;
        }
    }

    /// <summary>查一次。并发调用共用同一次结果，不会同时打好几个网络。</summary>
    public async Task<JsonObject> CheckAsync(bool force)
    {
        if (!force)
        {
            lock (_lock)
            {
                if (_snapshot is not null && DateTime.UtcNow - _checkedAtUtc < ManualTtl)
                {
                    return Current();
                }
            }
        }

        if (!await _gate.WaitAsync(0).ConfigureAwait(false))
        {
            // 已经有人在查了，等它出结果就行。
            await _gate.WaitAsync().ConfigureAwait(false);
            _gate.Release();
            return Current();
        }

        try
        {
            lock (_lock)
            {
                _checking = true;
            }

            var home = _home();
            var agent = Path.Combine(home, ".pi", "agent");
            var pi = await CheckPiAsync(agent).ConfigureAwait(false);
            var packages = await CheckPackagesAsync(agent).ConfigureAwait(false);

            var snapshot = new JsonObject
            {
                ["type"] = "updates",
                ["checkedAt"] = DateTime.UtcNow.ToString("o"),
                ["pi"] = pi,
                ["packages"] = packages,
            };

            lock (_lock)
            {
                _snapshot = snapshot;
                _checkedAtUtc = DateTime.UtcNow;
                _checking = false;
            }

            return Current();
        }
        finally
        {
            lock (_lock)
            {
                _checking = false;
            }

            _gate.Release();
        }
    }

    // ── Pi 自己 ────────────────────────────────────────────────────────────

    private static async Task<JsonObject> CheckPiAsync(string agent)
    {
        var package = ReadInstalledPackage(agent);
        var installed = ReadInstalledPiVersion(agent, package);
        var entry = new JsonObject
        {
            ["name"] = "Pi",
            ["package"] = package,
            ["installed"] = installed,
            ["latest"] = string.Empty,
            ["hasUpdate"] = false,
            ["pinned"] = false,
            ["error"] = string.Empty,
        };

        // 不是 npm 装的（比如从源码跑、或装在别处）就没有「最新版」可比。
        if (installed.Length == 0 || package.Length == 0)
        {
            return entry;
        }

        try
        {
            var latest = await LatestNpmAsync(package).ConfigureAwait(false);
            entry["latest"] = latest;
            entry["hasUpdate"] = latest.Length > 0 && CompareVersions(latest, installed) > 0;
        }
        catch (Exception)
        {
            entry["error"] = "查不到 Pi 的最新版本";
        }

        return entry;
    }

    /// <summary>
    /// 装着的 Pi 是哪个 npm 包：install/releases/&lt;版本&gt;/package.json 的 dependencies 里那一个。
    /// 不写死名字——上游改包名的时候这里不用跟着改。
    /// </summary>
    private static string ReadInstalledPackage(string agent)
    {
        try
        {
            var root = Path.Combine(agent, "install", "releases", ReadInstalledPi(agent));
            var file = Path.Combine(root, "package.json");
            if (!File.Exists(file) ||
                JsonNode.Parse(File.ReadAllText(file)) is not JsonObject payload ||
                payload["dependencies"] is not JsonObject dependencies)
            {
                return string.Empty;
            }

            foreach (var entry in dependencies)
            {
                if (!string.IsNullOrWhiteSpace(entry.Key))
                {
                    return entry.Key;
                }
            }
        }
        catch (Exception)
        {
            // 读不出来就当没装。
        }

        return string.Empty;
    }

    /// <summary>版本号以装好的包自己报的为准，install/current-version 只是兜底。</summary>
    private static string ReadInstalledPiVersion(string agent, string package)
    {
        if (package.Length > 0)
        {
            var version = ReadPackageVersion(Path.Combine(
                agent, "install", "releases", ReadInstalledPi(agent), "node_modules", package));
            if (version.Length > 0)
            {
                return version;
            }
        }

        return ReadInstalledPi(agent);
    }

    /// <summary>装着的 Pi 版本号：install/current-version 里那行。</summary>
    private static string ReadInstalledPi(string agent)
    {
        try
        {
            var file = Path.Combine(agent, "install", "current-version");
            if (File.Exists(file))
            {
                var text = File.ReadAllText(file).Trim();
                if (text.Length > 0)
                {
                    return text;
                }
            }
        }
        catch (Exception)
        {
            // 读不出来就当没有版本号。
        }

        return string.Empty;
    }

    // ── 扩展 ──────────────────────────────────────────────────────────────

    private async Task<JsonArray> CheckPackagesAsync(string agent)
    {
        var result = new JsonArray();
        foreach (var source in DeclaredPackages(agent))
        {
            var (kind, name) = SplitSource(source);
            if (name.Length == 0)
            {
                continue;
            }

            var entry = new JsonObject
            {
                ["source"] = source,
                ["kind"] = kind,
                ["name"] = name,
                ["installed"] = string.Empty,
                ["latest"] = string.Empty,
                ["hasUpdate"] = false,
                ["pinned"] = false,
                ["error"] = string.Empty,
            };

            try
            {
                switch (kind)
                {
                    case "npm":
                        entry["installed"] = ReadPackageVersion(
                            Path.Combine(agent, "npm", "node_modules", name));
                        entry["pinned"] = SourceHasVersion(source);
                        if (!entry["pinned"]!.GetValue<bool>() && entry["installed"]!.GetValue<string>().Length > 0)
                        {
                            var latest = await LatestNpmAsync(name).ConfigureAwait(false);
                            entry["latest"] = latest;
                            entry["hasUpdate"] = latest.Length > 0 &&
                                CompareVersions(latest, entry["installed"]!.GetValue<string>()) > 0;
                        }

                        break;

                    case "git":
                        var directory = Path.Combine(agent, "git", name);
                        entry["pinned"] = SourceHasVersion(source);
                        if (Directory.Exists(Path.Combine(directory, ".git")))
                        {
                            // 钉住的也报装的是哪个提交，只是不去比远程。
                            await CheckGitAsync(directory, entry, entry["pinned"]!.GetValue<bool>())
                                .ConfigureAwait(false);
                        }

                        break;
                }
            }
            catch (Exception)
            {
                entry["error"] = "查不到这个扩展的最新版本";
            }

            result.Add(entry);
        }

        return result;
    }

    private static async Task CheckGitAsync(string directory, JsonObject entry, bool pinned)
    {
        var head = (await GitAsync(directory, "rev-parse HEAD").ConfigureAwait(false)).Trim();
        entry["installed"] = head.Length > 7 ? head[..7] : head;

        // 钉住的不比远程；没设上游分支的也不比——不知道跟谁比。
        if (pinned || head.Length == 0)
        {
            return;
        }

        var upstreamRef = (await GitAsync(directory, "rev-parse --abbrev-ref @{upstream}").ConfigureAwait(false)).Trim();
        var slash = upstreamRef.IndexOf('/');
        if (slash <= 0)
        {
            return;
        }

        var remote = upstreamRef[..slash];
        var branch = upstreamRef[(slash + 1)..];
        if (branch.Length == 0)
        {
            return;
        }

        // ls-remote 回的是「提交<TAB>引用」；按空白切，别只认空格，否则会把整行当成哈希。
        var remoteLine = (await GitAsync(directory, $"ls-remote {remote} refs/heads/{branch}").ConfigureAwait(false)).Trim();
        var remoteHead = remoteLine.Split(new[] { ' ', '	' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? string.Empty;

        if (remoteHead.Length >= 7)
        {
            entry["latest"] = remoteHead[..7];
            entry["hasUpdate"] = !string.Equals(remoteHead, head, StringComparison.OrdinalIgnoreCase);
        }
    }

    /// <summary>settings.json 里声明的扩展包（只认用户级配置，跟 Pi 的装法一致）。</summary>
    private static List<string> DeclaredPackages(string agent)
    {
        var list = new List<string>();
        try
        {
            var file = Path.Combine(agent, "settings.json");
            if (!File.Exists(file) ||
                JsonNode.Parse(File.ReadAllText(file)) is not JsonObject settings ||
                settings["packages"] is not JsonArray packages)
            {
                return list;
            }

            foreach (var entry in packages)
            {
                var text = entry?.GetValue<string>();
                if (!string.IsNullOrWhiteSpace(text))
                {
                    list.Add(text!);
                }
            }
        }
        catch (Exception)
        {
            // 配置读不出来就当没装扩展。
        }

        return list;
    }

    private static (string Kind, string Name) SplitSource(string source)
    {
        if (source.StartsWith("npm:", StringComparison.OrdinalIgnoreCase))
        {
            return ("npm", BareName(source[4..].Trim()));
        }

        if (source.StartsWith("git:", StringComparison.OrdinalIgnoreCase))
        {
            var rest = source[4..].Trim();
            var at = rest.LastIndexOf('@');
            if (at > rest.LastIndexOf('/'))
            {
                rest = rest[..at];
            }

            return ("git", rest);
        }

        return ("path", source);
    }

    /// <summary>
    /// npm 名字里可能带范围（<c>@scope/pkg@^1.2.3</c>），取到版本前那截。
    /// 作用域名的 @ 在开头，靠「@ 在最后一个 / 之后」把两种 @ 分开。
    /// </summary>
    private static string BareName(string text)
    {
        var at = text.LastIndexOf('@');
        return at > text.LastIndexOf('/') ? text[..at] : text;
    }

    /// <summary>源里写死了版本或 ref 就是钉住的，Pi 自己也不查这种。</summary>
    private static bool SourceHasVersion(string source)
    {
        var text = source.Contains(':') ? source[(source.IndexOf(':') + 1)..] : source;
        text = text.Trim();
        return text.IndexOf('@', text.StartsWith('@') ? 1 : 0) > 0;
    }

    // ── 外面的世界 ─────────────────────────────────────────────────────────

    private static async Task<string> LatestNpmAsync(string name)
    {
        var url = "https://registry.npmjs.org/" + Uri.EscapeDataString(name) + "/latest";
        var text = await Http.GetStringAsync(url).ConfigureAwait(false);
        if (JsonNode.Parse(text) is JsonObject payload &&
            payload["version"]?.GetValue<string>() is { Length: > 0 } version)
        {
            return version;
        }

        return string.Empty;
    }

    private static async Task<string> GitAsync(string directory, string arguments)
    {
        var info = new ProcessStartInfo("git", arguments)
        {
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        using var process = Process.Start(info);
        if (process is null)
        {
            return string.Empty;
        }

        var output = await process.StandardOutput.ReadToEndAsync().ConfigureAwait(false);
        await process.WaitForExitAsync().ConfigureAwait(false);
        return output;
    }

    private static string ReadPackageVersion(string directory)
    {
        try
        {
            var file = Path.Combine(directory, "package.json");
            if (File.Exists(file) &&
                JsonNode.Parse(File.ReadAllText(file)) is JsonObject payload &&
                payload["version"]?.GetValue<string>() is { Length: > 0 } version)
            {
                return version;
            }
        }
        catch (Exception)
        {
            // 版本号读不出来就空着。
        }

        return string.Empty;
    }

    /// <summary>
    /// 比版本号。只认同一种形状：数字三段加可选的 -预发布，比 Pi 那边用 semver 的场合够用。
    /// </summary>
    internal static int CompareVersions(string left, string right)
    {
        var (leftNumbers, leftPre) = VersionParts(left);
        var (rightNumbers, rightPre) = VersionParts(right);

        for (var i = 0; i < Math.Max(leftNumbers.Length, rightNumbers.Length); i++)
        {
            var a = i < leftNumbers.Length ? leftNumbers[i] : 0;
            var b = i < rightNumbers.Length ? rightNumbers[i] : 0;
            if (a != b)
            {
                return a < b ? -1 : 1;
            }
        }

        // 不带预发布标记的更新（1.0.0 > 1.0.0-beta.1）。
        if (leftPre.Length == 0 && rightPre.Length > 0)
        {
            return 1;
        }

        if (rightPre.Length == 0 && leftPre.Length > 0)
        {
            return -1;
        }

        return string.Compare(leftPre, rightPre, StringComparison.OrdinalIgnoreCase);
    }

    private static (int[] Numbers, string Pre) VersionParts(string version)
    {
        var text = version.Trim();
        if (text.StartsWith('v') || text.StartsWith('V'))
        {
            text = text[1..];
        }

        var dash = text.IndexOf('-');
        var pre = dash >= 0 ? text[(dash + 1)..] : string.Empty;
        var core = dash >= 0 ? text[..dash] : text;
        // 去掉构建元数据（1.2.3+abc）。
        var plus = core.IndexOf('+');
        if (plus >= 0)
        {
            core = core[..plus];
        }

        var parts = core.Split('.');
        var numbers = new int[parts.Length];
        for (var i = 0; i < parts.Length; i++)
        {
            numbers[i] = int.TryParse(parts[i], out var value) ? value : 0;
        }

        return (numbers, pre);
    }
}
