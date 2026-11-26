using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using SevenStation.Shared;

namespace SevenStation.Core.Sessions;

/// <summary>
/// 只看不问：读一下工作区的 git 状态，给界面上那个分支胶囊用。
///
/// 三条只读命令，谁都不用装依赖：
/// <list type="bullet">
/// <item><c>rev-parse --show-toplevel</c>：这个目录在不在仓库里，仓库根在哪。</item>
/// <item><c>status --porcelain=v2 --branch</c>：当前分支、领先/落后、改动清单，一次拿全。</item>
/// <item><c>for-each-ref refs/heads</c>：本地分支，按提交时间倒序。</item>
/// </list>
/// 只读是硬约束：这里**不做** checkout / branch / stash，一个字都不写。要动分支走命令，让用户自己确认。
/// </summary>
public static class GitProbe
{
    /// <summary>同一个目录 4 秒内只探一次：切会话、跑完一轮都会问，别每次都起进程。</summary>
    private static readonly ConcurrentDictionary<string, (DateTime At, JsonObject Snapshot)> Cache = new();

    private static readonly TimeSpan Ttl = TimeSpan.FromSeconds(4);

    /// <summary>取工作区的 git 快照；不是仓库、没装 git、超时都返回 <see cref="NotARepo"/>。</summary>
    public static async Task<JsonObject> SnapshotAsync(string workingDirectory, bool force = false)
    {
        if (string.IsNullOrWhiteSpace(workingDirectory)) return NotARepo();

        var key = workingDirectory.TrimEnd('\\', '/');
        if (!force && Cache.TryGetValue(key, out var cached) && DateTime.UtcNow - cached.At < Ttl)
        {
            return (JsonObject)cached.Snapshot.DeepClone();
        }

        var snapshot = await ReadAsync(key).ConfigureAwait(false);
        Cache[key] = (DateTime.UtcNow, snapshot);
        return (JsonObject)snapshot.DeepClone();
    }

    public static JsonObject NotARepo() => new()
    {
        ["repo"] = false,
        ["branch"] = string.Empty,
        ["files"] = new JsonArray(),
        ["branches"] = new JsonArray(),
    };

    private static async Task<JsonObject> ReadAsync(string directory)
    {
        if (!Directory.Exists(directory)) return NotARepo();

        try
        {
            var root = (await RunAsync(directory, "rev-parse --show-toplevel").ConfigureAwait(false)).Trim();
            if (string.IsNullOrEmpty(root)) return NotARepo();

            var status = await RunAsync(root, "status --porcelain=v2 --branch").ConfigureAwait(false);
            // 分支时间用 unix 秒，界面上自己算「3 天前」——git 的 relative 是英文，还是别指望它。
            var branches = await RunAsync(
                root,
                "for-each-ref --sort=-committerdate --count=20 refs/heads " +
                "--format=%(refname:short)%09%(committerdate:unix)").ConfigureAwait(false);

            var snapshot = Parse(root, status, branches);

            // 分离头指针时没有分支名，拿短 SHA 顶上也比空着强。
            if (snapshot["detached"]?.GetValue<bool>() == true)
            {
                var sha = (await RunAsync(root, "rev-parse --short HEAD").ConfigureAwait(false)).Trim();
                if (sha.Length > 0) snapshot["branch"] = sha;
            }

            return snapshot;
        }
        catch (Exception error)
        {
            // git 不在 PATH、目录没权限、进程起不来：界面上就当不是仓库，别报错吓人。
            Log.Write($"读 git 状态失败（{directory}）：{error.Message}");
            return NotARepo();
        }
    }

    /// <summary>解析 porcelain=v2 的输出。分支行以 <c># branch.</c> 开头，其余每行一个改动。</summary>
    public static JsonObject Parse(string root, string status, string refs)
    {
        var result = new JsonObject
        {
            ["repo"] = true,
            ["root"] = root.Replace('/', '\\'),
            ["branch"] = string.Empty,
            ["detached"] = false,
            ["ahead"] = 0,
            ["behind"] = 0,
            ["files"] = new JsonArray(),
            ["branches"] = new JsonArray(),
        };

        var files = (JsonArray)result["files"]!;

        foreach (var raw in status.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.Length == 0) continue;

            if (line.StartsWith("# branch.head ", StringComparison.Ordinal))
            {
                var head = line["# branch.head ".Length..].Trim();
                // 分离头指针时 git 给的是 "(detached)"。
                if (head == "(detached)")
                {
                    result["detached"] = true;
                }
                else
                {
                    result["branch"] = head;
                }
                continue;
            }

            if (line.StartsWith("# branch.ab ", StringComparison.Ordinal))
            {
                // 形如 "+2 -1"：领先 2、落后 1。
                foreach (var token in line["# branch.ab ".Length..].Split(' ', StringSplitOptions.RemoveEmptyEntries))
                {
                    if (token.Length < 2) continue;
                    var value = int.TryParse(token[1..], out var parsed) ? parsed : 0;
                    if (token[0] == '+') result["ahead"] = value;
                    else if (token[0] == '-') result["behind"] = value;
                }
                continue;
            }

            if (line.StartsWith('#')) continue;

            // 普通改动 "1 XY ..."、改名 "2 XY ..."、未跟踪 "? path"、忽略 "!"。
            var entry = ParseEntry(line);
            if (entry is not null) files.Add(entry);
        }

        foreach (var raw in refs.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.Length == 0) continue;
            var parts = line.Split('\t');
            var name = parts[0].Trim();
            if (name.Length == 0) continue;
            ((JsonArray)result["branches"]!).Add(new JsonObject
            {
                ["name"] = name,
                ["at"] = parts.Length > 1 && long.TryParse(parts[1].Trim(), out var at) ? at : 0,
                ["current"] = name == result["branch"]?.GetValue<string>(),
            });
        }

        return result;
    }

    private static JsonObject? ParseEntry(string line)
    {
        var kind = line[0];

        string path;
        string flag;

        if (kind == '?' || kind == '!')
        {
            path = line[2..].Trim();
            flag = kind == '?' ? "new" : "ignored";
        }
        else if (kind is '1' or '2')
        {
            // "1 XY sub mH mI mW hH hI path"：XY 在第二段。
            var fields = line.Split(' ', kind == '1' ? 9 : 10);
            if (fields.Length < (kind == '1' ? 9 : 10)) return null;
            var xy = fields[1];
            path = kind == '1' ? fields[8] : fields[9];
            // 改名时 path 形如 "新路径\t原路径"，只留新路径。
            var tab = path.IndexOf('\t');
            if (tab > 0) path = path[..tab];
            flag = FileFlag(xy);
        }
        else
        {
            return null;
        }

        if (path.Length == 0) return null;
        return new JsonObject { ["flag"] = flag, ["path"] = path };
    }

    /// <summary>XY 两列压成一个字母：A 新增、D 删除、R 改名、C 复制、M 改动、U 冲突。</summary>
    private static string FileFlag(string xy)
    {
        if (xy.Length < 2) return "M";
        if (xy.Contains('U') || xy == "AA" || xy == "DD") return "U";
        if (xy[0] == 'R' || xy[1] == 'R') return "R";
        if (xy[0] == 'C' || xy[1] == 'C') return "C";
        if (xy[0] == 'A' || xy[1] == 'A') return "A";
        if (xy[0] == 'D' || xy[1] == 'D') return "D";
        return "M";
    }

    private static async Task<string> RunAsync(string directory, string arguments)
    {
        var info = new ProcessStartInfo("git", arguments)
        {
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            // 中文路径、中文分支名都要按 UTF-8 读，别用系统代码页。
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardErrorEncoding = System.Text.Encoding.UTF8,
        };
        info.Environment["GIT_OPTIONAL_LOCKS"] = "0"; // 连顺手抢锁都不要

        using var process = Process.Start(info);
        if (process is null) return string.Empty;

        var output = process.StandardOutput.ReadToEndAsync();
        process.StandardError.ReadToEnd();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(6));
        try
        {
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { /* 已经退了 */ }
            return string.Empty;
        }

        return output.Result;
    }
}
