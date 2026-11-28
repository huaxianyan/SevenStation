using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using SevenStation.Core.Rpc;
using SevenStation.Core.Agents;
using SevenStation.Core.Sessions;
using SevenStation.Core.Storage;
using SevenStation.Shared;

namespace SevenStation.Core;

/// <summary>
/// 对话 Seven Station Core。对话是 SevenStation.Core 自己的概念：存在本地数据库里，客户端只跟这里打交道。
/// 每个对话在需要时对应一个 <c>pi --mode rpc</c> 子进程，Pi 的会话文件只是一条内部绑定，
/// 用来续聊，不暴露给客户端。每轮结束把消息取回来存进数据库，之后看历史不再经过 Pi。
/// </summary>
public sealed class CenterHub
{
    private sealed class Live
    {
        public required Conversation Conversation { get; init; }
        public required PiSession Session { get; init; }
        public bool Streaming { get; set; }

        /// <summary>这个子进程起的时候，Pi 是哪个版本。升级只改旁边那个指针，进程里还是老代码。</summary>
        public string PiVersion { get; set; } = string.Empty;

        /// <summary>模型与思考等级已经推给这个子进程了。新起的子进程默认用它自己的配置，不推就对不上。</summary>
        public bool SettingsApplied { get; set; }

        /// <summary>最后一次收到 Pi 事件的时刻。Pi 卡在工具里时它一直不走，界面只能看秒数。</summary>
        public DateTimeOffset LastEventAt { get; set; } = DateTimeOffset.UtcNow;

        /// <summary>上一次为「没动静」记日志的时刻，免得每分钟刷一行。</summary>
        public DateTimeOffset QuietLoggedAt { get; set; } = DateTimeOffset.MinValue;

        /// <summary>上一次问 Pi 要用量的时刻。一轮进行中不能每条消息都问一遍。</summary>
        public DateTimeOffset StatsAskedAt { get; set; } = DateTimeOffset.MinValue;

        /// <summary>
        /// 工作中追加的输入。存在这里而不是直接推给 Pi：
        /// Pi 的队列只有 clear_queue（整队清空），单条改不了也删不掉。
        /// </summary>
        public List<QueuedPrompt> Queue { get; } = new();

        /// <summary>本轮已经写进库的消息指纹，同一条只落一次。</summary>
        public HashSet<string> Persisted { get; } = new();

        /// <summary>
        /// 用户按过停止。这时候别再偷偷把排队的话塞回去——他只想要现在停下来，
        /// 不是「停完接着干下一件」。到 agent_settled 时清掉。
        /// </summary>
        public bool StopRequested { get; set; }
    }

    private sealed record QueuedPrompt(string Id, string Text, JsonArray? Images);

    public static readonly JsonSerializerOptions SerializerOptions = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly object _gate = new();
    private readonly Dictionary<string, Live> _live = new();
    private int _queueSeq;

    /// <summary>演示开关用：记录第几次发送，单数失败、双数放行。</summary>
    private int _demoAttempts;

    /// <summary>每分钟看一眼在跑的会话多久没动静了。</summary>
    private Timer? _quietTimer;

    /// <summary>模型缓存的保鲜期：超过就从 Pi 重新取一次。</summary>
    private const long ModelsTtlMs = 24 * 60 * 60 * 1000;
    private readonly Dictionary<string, TerminalSession> _terminals = new();
    private readonly object _terminalGate = new();
    private readonly List<CenterConnection> _clients = new();
    private readonly ConversationStore _store;
    private readonly PiUpdates _updates;
    private readonly PiUpgrader _upgrader = new();

    public CenterHub(ConversationStore store, string listenUrl)
    {
        _store = store;
        ListenUrl = listenUrl;
        _updates = new PiUpdates(() => CoreSettings.Current.PiHome);

        _quietTimer = new Timer(_ =>
        {
            try { WatchQuietSessions(); }
            catch (Exception error) { Log.Write($"检查静默会话失败：{error.Message}"); }
        }, null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
    }

    /// <summary>Seven Station Core 对外报的地址，界面拿去给人看，方便照着连别的设备。</summary>
    public string ListenUrl { get; }

    public void Join(CenterConnection connection)
    {
        lock (_gate)
        {
            _clients.Add(connection);
        }

        connection.Send(new JsonObject
        {
            ["type"] = "hello",
            ["center"] = "SevenStation",
            ["version"] = typeof(CenterHub).Assembly.GetName().Version?.ToString() ?? "0",
            ["data"] = _store.DatabasePath,
            ["agent"] = AgentRegistry.PrimaryId,
            ["agents"] = AgentPayload(),
            ["listen"] = ListenUrl,
            ["css"] = _store.GetSetting("custom_css"),
            ["workspaces"] = new JsonArray(RecentWorkspaces().Select(entry => (JsonNode?)JsonValue.Create(entry)).ToArray()),
        });

        // 更新状态可能已经查过了，新连上的客户端不用干等下一轮；
        // 还没查过就现在查一次，别让人对着空白等 20 秒。
        var known = _updates.Current();
        if (known["checkedAt"] is not null)
        {
            connection.Send(WithModels(known));
        }
        else
        {
            _ = CheckUpdatesAsync(force: true);
        }
    }

    public void Leave(CenterConnection connection)
    {
        lock (_gate)
        {
            _clients.Remove(connection);
        }
    }

    private void Broadcast(JsonObject payload)
    {
        CenterConnection[] targets;
        lock (_gate)
        {
            targets = _clients.ToArray();
        }

        foreach (var target in targets)
        {
            target.Send(payload);
        }
    }

    public async Task HandleAsync(JsonObject message, CenterConnection sender)
    {
        var type = message["type"]?.GetValue<string>();
        var key = message["key"]?.GetValue<string>();
        try
        {
            switch (type)
            {
                case "list_conversations":
                    SendConversationList(sender);
                    break;

                case "load_older":
                    SendOlderMessages(Require(message["key"]?.GetValue<string>(), "对话标识"), message, sender);
                    break;

                case "open_conversation":
                    SendState(Require(message["id"]?.GetValue<string>(), "对话标识"), sender);
                    break;

                case "new_conversation":
                    await NewConversationAsync(message, sender);
                    break;

                case "rename_conversation":
                    RenameConversation(Require(message["id"]?.GetValue<string>(), "对话标识"), message, sender);
                    break;

                case "delete_conversation":
                    await DeleteConversationAsync(Require(message["id"]?.GetValue<string>(), "对话标识"));
                    SendConversationList(sender);
                    break;

                case "refresh_state":
                    SendState(Require(key, "对话标识"), sender);
                    break;

                case "refresh_stats":
                    SendStats(Require(key, "对话标识"), sender);
                    break;

                case "git_status":
                    await SendGitStatusAsync(Require(key, "对话标识"), sender);
                    break;

                case "prompt":
                    await PromptAsync(Require(key, "对话标识"), message, sender);
                    break;

                case "queue_edit":
                    EditQueued(LiveFor(Require(key, "对话标识")), message);
                    break;

                case "queue_remove":
                    RemoveQueued(LiveFor(Require(key, "对话标识")), message["id"]?.GetValue<string>());
                    break;

                case "queue_clear":
                    ClearQueue(LiveFor(Require(key, "对话标识")));
                    break;

                case "abort":
                    await AbortAsync(Require(key, "对话标识"), sender);
                    break;

                case "compact":
                    await SimpleAsync(Require(key, "对话标识"), "compact");
                    break;

                case "set_model":
                    await SetModelAsync(Require(key, "对话标识"), message, sender);
                    break;

                case "set_thinking":
                    await SetThinkingAsync(Require(key, "对话标识"), message, sender);
                    break;

                case "reveal_path":
                    RevealPath(sender, message);
                    break;

                case "list_models":
                    await SendModelsAsync(Require(key, "对话标识"), sender, message["force"]?.GetValue<bool>() == true);
                    break;

                case "list_commands":
                    await SendCommandsAsync(Require(key, "对话标识"), sender);
                    break;

                case "complete_files":
                    CompleteFiles(Require(key, "对话标识"), message, sender);
                    break;

                case "set_css":
                    SetCustomCss(message["css"]?.GetValue<string>() ?? string.Empty);
                    break;

                case "read_log":
                    ReadLog(message["lines"]?.GetValue<int?>() ?? 120, sender);
                    break;

                case "search":
                    SearchConversations(Require(message["query"]?.GetValue<string>() ?? string.Empty, "关键词"), sender);
                    break;

                case "list_skills":
                    SendSkills(message["cwd"]?.GetValue<string>() ?? string.Empty, sender);
                    break;

                case "upgrade_pi":
                    _ = UpgradePiAsync(message["stopRunning"]?.GetValue<bool>() ?? false);
                    break;

                case "check_updates":
                    _ = CheckUpdatesAsync(message["force"]?.GetValue<bool>() ?? false);
                    break;

                case "list_extensions":
                    _ = SendExtensionsAsync(message["cwd"]?.GetValue<string>() ?? string.Empty, sender);
                    break;

                case "list_restore_candidates":
                    SendRestoreCandidates(sender);
                    break;

                case "resolve_resume_command":
                    ResolveResumeCommand(message["command"]?.GetValue<string>() ?? string.Empty, sender);
                    break;

                case "restore_session":
                    RestoreSession(message, sender);
                    break;

                case "browse_dir":
                    BrowseDirectory(message["path"]?.GetValue<string>() ?? string.Empty, sender);
                    break;

                case "check_path":
                    CheckPath(Require(message["path"]?.GetValue<string>() ?? string.Empty, "路径"), sender);
                    break;

                case "list_dir":
                    ListDirectory(Require(key, "对话标识"), message, sender);
                    break;

                case "read_file":
                    ReadFile(Require(key, "对话标识"), message, sender);
                    break;

                case "terminal_start":
                    StartTerminal(Require(key, "对话标识"), sender);
                    break;

                case "terminal_input":
                    WriteTerminal(Require(key, "对话标识"), message);
                    break;

                case "terminal_stop":
                    StopTerminal(Require(key, "对话标识"), sender);
                    break;

                case "extension_response":
                    RespondToExtension(Require(key, "对话标识"), message);
                    break;

                default:
                    sender.Send(new JsonObject
                    {
                        ["type"] = "error",
                        ["key"] = key,
                        ["message"] = $"未知命令：{type}",
                    });
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Write($"命令 {type} 失败（key={key}）", ex);
            sender.Send(new JsonObject
            {
                ["type"] = "error",
                ["key"] = key,
                ["message"] = ex.Message,
            });
        }
    }

    private static string Require(string? value, string what)
    {
        if (string.IsNullOrEmpty(value))
        {
            throw new InvalidOperationException($"缺少{what}。");
        }

        return value;
    }

    private Conversation RequireConversation(string id) =>
        _store.Get(id) ?? throw new InvalidOperationException("这个对话已经不在了。");

    /// <summary>
    /// magpie 那边给的是一整条命令（`Set-Location -LiteralPath '...'; pi --session &lt;id&gt;`），
    /// 这里把它翻译成一段具体的会话，界面先给用户看一眼再决定恢复。
    /// </summary>
    private void ResolveResumeCommand(string command, CenterConnection sender)
    {
        var (id, cwd) = PiSessionLibrary.ParseResumeCommand(command);
        var candidate = id is null ? null : PiSessionLibrary.Resolve(id);

        sender.Send(new JsonObject
        {
            ["type"] = "resume_resolved",
            ["cwd"] = cwd ?? candidate?.Cwd ?? string.Empty,
            ["item"] = candidate is null
                ? null
                : new JsonObject
                {
                    ["id"] = candidate.Id,
                    ["cwd"] = candidate.Cwd,
                    ["title"] = candidate.Title,
                    ["startedAt"] = candidate.StartedAt,
                    ["messageCount"] = candidate.MessageCount,
                    ["sizeBytes"] = candidate.SizeBytes,
                    ["model"] = candidate.Model,
                    ["lastMessage"] = candidate.LastMessage,
                    ["imported"] = _store.List().Any(conversation =>
                        string.Equals(conversation.PiSessionFile, candidate.Path, StringComparison.OrdinalIgnoreCase)),
                },
        });
    }

    /// <summary>
    /// 恢复会话页：Pi 那边还有哪些会话、哪些已经收进对话库了。
    /// </summary>
    private void SendRestoreCandidates(CenterConnection sender)
    {
        var imported = _store.List()
            .Select(conversation => conversation.PiSessionFile)
            .Where(file => !string.IsNullOrWhiteSpace(file))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var items = new JsonArray();
        foreach (var candidate in PiSessionLibrary.Scan())
        {
            items.Add(new JsonObject
            {
                ["id"] = candidate.Id,
                ["cwd"] = candidate.Cwd,
                ["title"] = candidate.Title,
                ["startedAt"] = candidate.StartedAt,
                ["messageCount"] = candidate.MessageCount,
                ["sizeBytes"] = candidate.SizeBytes,
                ["model"] = candidate.Model,
                ["lastMessage"] = candidate.LastMessage,
                ["imported"] = imported.Contains(candidate.Path),
            });
        }

        sender.Send(new JsonObject
        {
            ["type"] = "restore_candidates",
            ["items"] = items,
        });
    }

    /// <summary>
    /// 把一段 Pi 会话收进对话库：对话绑定到那个会话文件，消息按原样搬进来。
    /// 之后续聊还是原来那个 Pi 会话，这里不复制出第二个。
    /// </summary>
    private void RestoreSession(JsonObject message, CenterConnection sender)
    {
        var id = Require(message["sessionId"]?.GetValue<string>() ?? string.Empty, "会话标识");
        var candidate = PiSessionLibrary.Resolve(id)
            ?? throw new InvalidOperationException("Seven Station Core 这台机器上找不到这段会话，可能已经被删掉了。");

        var existing = _store.List()
            .FirstOrDefault(conversation =>
                string.Equals(conversation.PiSessionFile, candidate.Path, StringComparison.OrdinalIgnoreCase));

        if (existing is not null)
        {
            sender.Send(new JsonObject
            {
                ["type"] = "session_restored",
                ["id"] = existing.Id,
                ["already"] = true,
                ["messageCount"] = existing.MessageCount,
            });
            return;
        }

        var cwd = candidate.Cwd;
        if (string.IsNullOrWhiteSpace(cwd))
        {
            throw new InvalidOperationException("这段会话没记工作目录，得先新建一个对话再接着聊。");
        }

        var conversation = _store.Create(cwd, candidate.Title, candidate.Path, candidate.StartedAt);

        // 读大文件要一两秒，按字节回报，界面才不会一直只有转圈。
        var lastReport = 0L;
        var messages = PiSessionLibrary.ReadMessages(candidate.Path, (read, total, count) =>
        {
            var now = Environment.TickCount64;
            if (now - lastReport < 120)
            {
                return;
            }

            lastReport = now;
            sender.Send(new JsonObject
            {
                ["type"] = "restore_progress",
                ["stage"] = "read",
                ["done"] = read,
                ["total"] = total,
                ["messages"] = count,
            });
        });

        var added = _store.AppendMessages(conversation.Id, messages.ToArray());
        sender.Send(new JsonObject
        {
            ["type"] = "restore_progress",
            ["stage"] = "write",
            ["done"] = added,
            ["total"] = added,
            ["messages"] = added,
        });

        Log.Write($"恢复会话 {candidate.Id} → {conversation.Id}（{added} 条消息）");
        Broadcast(new JsonObject { ["type"] = "conversation_saved" });
        SendConversationList(sender);

        sender.Send(new JsonObject
        {
            ["type"] = "session_restored",
            ["id"] = conversation.Id,
            ["already"] = false,
            ["messageCount"] = added,
        });
    }

    /// <summary>
    /// 侧栏的「工作中」跟着跑：开始和结束都要告诉所有连着的客户端，
    /// 以前只在 list/new/rename/delete 时推，转圈就时有时无。
    /// </summary>
    private void BroadcastConversations()
    {
        CenterConnection[] targets;
        lock (_gate)
        {
            targets = _clients.ToArray();
        }

        foreach (var target in targets)
        {
            SendConversationList(target);
        }
    }

    /// <summary>改「工作中」状态并顺手刷新侧栏，状态没变就不打扰别人。</summary>
    private void SetStreaming(Live live, bool value)
    {
        if (live.Streaming == value) return;
        live.Streaming = value;
        // 状态错乱时（侧栏说没在跑、对话里还在转）只有这条日志能对上时间线。
        Log.Write($"对话 {live.Conversation.Id} {(value ? "开始工作" : "这次工作结束")}");
        BroadcastConversations();
    }

    /// <summary>
    /// 打开一个路径：目录开文件夹，文件用关联程序打开。界面里出现的绝对路径点一下就能过去，省掉复制粘贴。
    /// 只认本机存在且是绝对路径的，别的一律不动手。
    /// </summary>
    private void RevealPath(CenterConnection sender, JsonObject message)
    {
        var path = message["path"]?.GetValue<string>()?.Trim();
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path))
        {
            sender.Send(new JsonObject { ["type"] = "notice", ["text"] = "这个路径打不开：" + path, ["kind"] = "warning" });
            return;
        }

        if (!Directory.Exists(path) && !File.Exists(path))
        {
            sender.Send(new JsonObject { ["type"] = "notice", ["text"] = "找不到这个路径：" + path, ["kind"] = "warning" });
            return;
        }

        try
        {
            var start = new ProcessStartInfo("explorer.exe") { UseShellExecute = false };
            // 目录开文件夹，文件交给默认程序（explorer 自己认关联）。
            start.ArgumentList.Add(path);
            Process.Start(start);
        }
        catch (Exception ex)
        {
            Log.Write("打开路径失败 " + path + "：" + ex.Message, ex);
            sender.Send(new JsonObject { ["type"] = "notice", ["text"] = "打不开这个路径，可能被系统挡住了", ["kind"] = "error" });
        }
    }

    private void SendConversationList(CenterConnection sender)
    {
        var items = new JsonArray();
        foreach (var conversation in _store.List())
        {
            bool working;
            lock (_gate)
            {
                working = _live.TryGetValue(conversation.Id, out var live) && live.Streaming;
            }

            items.Add(new JsonObject
            {
                ["id"] = conversation.Id,
                ["title"] = conversation.Title,
                ["cwd"] = conversation.Cwd,
                ["updatedAt"] = conversation.UpdatedAt,
                ["messageCount"] = conversation.MessageCount,
                ["working"] = working,
                // 跑完的对话是「完成」，空对话才是「没开始」，界面上用不同颜色区分。
                ["status"] = working ? "working" : conversation.MessageCount > 0 ? "ready" : "empty",
            });
        }

        sender.Send(new JsonObject
        {
            ["type"] = "conversation_list",
            ["items"] = items,
            ["workspaces"] = new JsonArray(RecentWorkspaces().Select(entry => (JsonNode?)JsonValue.Create(entry)).ToArray()),
        });
    }

    /// <summary>打开会话时先给这么多条，剩下的往上翻再要。</summary>
    private const int MessagePageSize = 120;

    private void SendState(string id, CenterConnection sender)
    {
        var conversation = RequireConversation(id);
        Live? live;
        lock (_gate)
        {
            _live.TryGetValue(id, out live);
        }

        var (messages, total) = _store.MessageWindow(id, MessagePageSize);

        // 没有在跑的回合时，把尾巴上没结果的步骤标成中断：进程被杀、客户端关掉都会留下这种尾巴，
        // 界面按「有结果才算完成」渲染，不标就永远转「运行中」，重启也治不好（状态在库里）。
        if (live is null || !live.Streaming)
        {
            MarkInterruptedSteps(messages);
        }

        sender.Send(new JsonObject
        {
            ["type"] = "session_state",
            ["key"] = id,
            ["cwd"] = conversation.Cwd,
            ["title"] = conversation.Title,
            ["state"] = StateWithModel(conversation, live),
            ["messages"] = messages,
            ["messageTotal"] = total,
            ["hasMore"] = total > messages.Count,
            ["stats"] = Parse(conversation.Stats),
        });
    }

    /// <summary>把没有 toolResult 的 toolCall 标成中断。只在没在跑的回合上调用。</summary>
    private static void MarkInterruptedSteps(JsonArray messages)
    {
        var answered = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in messages)
        {
            if (node is not JsonObject message) continue;
            if (message["role"]?.GetValue<string>() != "toolResult") continue;
            if (message["toolCallId"]?.GetValue<string>() is { } callId) answered.Add(callId);
        }

        foreach (var node in messages)
        {
            if (node is not JsonObject message) continue;
            if (message["content"] is not JsonArray content) continue;
            foreach (var item in content)
            {
                if (item is not JsonObject block) continue;
                if (block["type"]?.GetValue<string>() != "toolCall") continue;
                var callId = block["id"]?.GetValue<string>();
                if (callId is not null && answered.Contains(callId)) continue;
                block["interrupted"] = true;
            }
        }
    }

    /// <summary>往前翻一页：<c>loaded</c> 是界面上已有的条数，返回它前面那一段。</summary>
    private void SendOlderMessages(string id, JsonNode message, CenterConnection sender)
    {
        var loaded = Math.Max(0, message["loaded"]?.GetValue<int>() ?? 0);
        var (messages, total) = _store.MessageWindow(id, MessagePageSize, loaded);
        sender.Send(new JsonObject
        {
            ["type"] = "older_messages",
            ["key"] = id,
            ["messages"] = messages,
            ["hasMore"] = total > loaded + messages.Count,
        });
    }

    /// <summary>对话的标题、模型、思考等级变了：只回这几项，绝不重发消息，免得覆盖界面上的内容。</summary>
    private static JsonObject Settings(Conversation conversation)
    {
        var payload = new JsonObject
        {
            ["type"] = "conversation_settings",
            ["key"] = conversation.Id,
            ["title"] = conversation.Title,
        };

        if (Parse(conversation.Model) is { } model)
        {
            payload["model"] = model.DeepClone();
        }

        if (!string.IsNullOrEmpty(conversation.ThinkingLevel))
        {
            payload["thinkingLevel"] = conversation.ThinkingLevel;
        }

        return payload;
    }

    /// <summary>
    /// 记住用过的工作区，新建对话时直接挑，不用每次都手打路径。
    /// </summary>
    private void RememberWorkspace(string cwd)
    {
        if (string.IsNullOrWhiteSpace(cwd))
        {
            return;
        }

        var list = RecentWorkspaces();
        list.RemoveAll(entry => string.Equals(entry, cwd, StringComparison.OrdinalIgnoreCase));
        list.Insert(0, cwd);

        var payload = new JsonArray();
        foreach (var entry in list.Take(8))
        {
            payload.Add(entry);
        }

        _store.SetSetting("recent_workspaces", payload.ToJsonString());
    }

    private List<string> RecentWorkspaces()
    {
        if (ParseNode(_store.GetSetting("recent_workspaces")) is not JsonArray stored)
        {
            return new List<string>();
        }

        return stored
            .Select(node => node?.GetValue<string>())
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Select(value => value!)
            .ToList();
    }

    /// <summary>Seven Station Core 这台机器上的 Pi 装好了没有，界面在设置里给个准话。</summary>
    /// <summary>把注册表里的 Agent 名片转成协议里的形状。</summary>
    private static JsonArray AgentPayload()
    {
        var agents = new JsonArray();
        foreach (var agent in AgentRegistry.Describe())
        {
            var capabilities = new JsonObject();
            capabilities["tools"] = agent.Capabilities.Tools;
            capabilities["thinkingLevels"] = agent.Capabilities.ThinkingLevels;
            capabilities["models"] = agent.Capabilities.Models;
            capabilities["contextUsage"] = agent.Capabilities.ContextUsage;
            capabilities["compaction"] = agent.Capabilities.Compaction;
            capabilities["extensions"] = agent.Capabilities.Extensions;
            capabilities["skills"] = agent.Capabilities.Skills;
            capabilities["commands"] = agent.Capabilities.Commands;
            capabilities["attachments"] = agent.Capabilities.Attachments;

            var info = new JsonArray();
            foreach (var row in agent.Info)
            {
                info.Add(new JsonObject
                {
                    ["label"] = row.Label,
                    ["value"] = row.Value,
                });
            }

            agents.Add(new JsonObject
            {
                ["id"] = agent.Id,
                ["name"] = agent.Name,
                ["version"] = agent.Version,
                ["ready"] = agent.Ready,
                ["capabilities"] = capabilities,
                ["info"] = info,
            });
        }

        return agents;
    }

    /// <summary>
    /// 选工作区时在里面翻目录用：只给盘符和子目录名，不读文件内容。
    /// </summary>
    private static void BrowseDirectory(string path, CenterConnection sender)
    {
        var drives = new JsonArray();
        foreach (var drive in DriveInfo.GetDrives())
        {
            try
            {
                if (!drive.IsReady)
                {
                    continue;
                }

                var label = string.IsNullOrWhiteSpace(drive.VolumeLabel)
                    ? drive.Name
                    : $"{drive.VolumeLabel} ({drive.Name.TrimEnd('\\')})";

                drives.Add(new JsonObject
                {
                    ["name"] = label,
                    ["path"] = drive.Name,
                });
            }
            catch (Exception)
            {
                // 光驱、没插的移动盘读卷标会抛，跳过就好。
            }
        }

        var current = string.Empty;
        string? parent = null;
        var dirs = new JsonArray();
        var error = string.Empty;

        if (!string.IsNullOrWhiteSpace(path))
        {
            try
            {
                var full = Path.GetFullPath(path.Trim().Trim('"'));
                if (Directory.Exists(full))
                {
                    current = full;
                    parent = Directory.GetParent(full)?.FullName;
                    dirs = ListSubdirectories(full);
                }
                else
                {
                    error = "这个目录不存在";
                }
            }
            catch (Exception)
            {
                error = "这个路径打不开";
            }
        }

        sender.Send(new JsonObject
        {
            ["type"] = "browse_dir",
            ["path"] = current,
            ["parent"] = parent,
            ["error"] = error,
            ["drives"] = drives,
            ["dirs"] = dirs,
        });
    }

    private static JsonArray ListSubdirectories(string folder)
    {
        var items = new JsonArray();
        List<string> entries;

        try
        {
            entries = Directory.EnumerateDirectories(folder).ToList();
        }
        catch (Exception)
        {
            return items;
        }

        foreach (var entry in entries.OrderBy(item => Path.GetFileName(item), StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var info = new DirectoryInfo(entry);
                if (info.Attributes.HasFlag(FileAttributes.Hidden) || info.Attributes.HasFlag(FileAttributes.System))
                {
                    continue;
                }

                items.Add(new JsonObject
                {
                    ["name"] = info.Name,
                    ["path"] = info.FullName,
                });
            }
            catch (Exception)
            {
                // 权限不足的目录单独跳过，不影响整层。
            }
        }

        return items;
    }

    /// <summary>
    /// 技能页的清单：直接读磁盘上的 SKILL.md，不经过 Pi，没有对话也能看。
    /// </summary>
    private static void SendSkills(string cwd, CenterConnection sender)
    {
        var items = new JsonArray();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var (root, scope) in SkillRoots(cwd))
        {
            List<string> directories;
            try
            {
                if (!Directory.Exists(root))
                {
                    continue;
                }

                directories = Directory.EnumerateDirectories(root, "*", SearchOption.AllDirectories).ToList();
            }
            catch (Exception)
            {
                continue;
            }

            foreach (var directory in directories.OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
            {
                var file = Path.Combine(directory, "SKILL.md");
                if (!File.Exists(file) || !seen.Add(file))
                {
                    continue;
                }

                var skill = ReadSkillHeader(file, Path.GetFileName(directory));
                items.Add(new JsonObject
                {
                    ["name"] = skill.Name,
                    ["description"] = skill.Description,
                    ["path"] = file,
                    ["scope"] = scope,
                    ["commandOnly"] = skill.CommandOnly,
                });
            }
        }

        sender.Send(new JsonObject
        {
            ["type"] = "skills",
            ["cwd"] = cwd,
            ["items"] = items,
        });
    }

    private static IEnumerable<(string Root, string Scope)> SkillRoots(string cwd)
    {
        var home = CoreSettings.Current.PiHome;
        yield return (Path.Combine(home, ".pi", "agent", "skills"), "用户");
        yield return (Path.Combine(home, ".agents", "skills"), "用户");

        if (string.IsNullOrWhiteSpace(cwd))
        {
            yield break;
        }

        string full;
        try
        {
            full = Path.GetFullPath(cwd);
        }
        catch (Exception)
        {
            yield break;
        }

        yield return (Path.Combine(full, ".pi", "skills"), "项目");
        yield return (Path.Combine(full, ".agents", "skills"), "项目");
    }

    private static (string Name, string Description, bool CommandOnly) ReadSkillHeader(string file, string fallbackName)
    {
        var name = fallbackName;
        var description = string.Empty;
        var commandOnly = false;

        try
        {
            var lines = File.ReadAllLines(file).Take(80).ToList();
            if (lines.Count == 0 || lines[0].Trim() != "---")
            {
                return (name, description, commandOnly);
            }

            for (var index = 1; index < lines.Count; index++)
            {
                var line = lines[index];
                if (line.Trim() == "---")
                {
                    break;
                }

                var colon = line.IndexOf(':');
                if (colon <= 0)
                {
                    continue;
                }

                var key = line[..colon].Trim().ToLowerInvariant();
                var value = line[(colon + 1)..].Trim();

                if (key == "disable-model-invocation")
                {
                    commandOnly = value.Equals("true", StringComparison.OrdinalIgnoreCase);
                    continue;
                }

                if (key == "name" && value.Length > 0)
                {
                    name = Unquote(value);
                    continue;
                }

                if (key != "description")
                {
                    continue;
                }

                // 描述可能是 > 或 | 折起来的块，往下把缩进行都收过来。
                if (value is ">" or ">-" or "|" or "|-")
                {
                    var parts = new List<string>();
                    while (index + 1 < lines.Count)
                    {
                        var next = lines[index + 1];
                        if (next.Trim().Length == 0)
                        {
                            index++;
                            continue;
                        }

                        if (next.StartsWith(" ", StringComparison.Ordinal) || next.StartsWith('\t'))
                        {
                            parts.Add(next.Trim());
                            index++;
                            continue;
                        }

                        break;
                    }

                    description = string.Join(" ", parts);
                }
                else
                {
                    description = Unquote(value);
                }
            }
        }
        catch (Exception)
        {
            // 读不通就当没有描述，别让一页清单挂掉。
        }

        return (name, description, commandOnly);
    }

    private static string Unquote(string value)
    {
        if (value.Length >= 2 &&
            ((value[0] == '"' && value[^1] == '"') || (value[0] == '\'' && value[^1] == '\'')))
        {
            return value[1..^1];
        }

        return value;
    }

    /// <summary>
    /// 启动后 20 秒查一次有没有新版，之后每 6 小时一次。查不到就什么也不说——
    /// 网络不通不该在界面上留个红点。
    /// </summary>
    public void StartUpdateLoop()
    {
        _ = Task.Run(async () =>
        {
            await Task.Delay(TimeSpan.FromSeconds(20)).ConfigureAwait(false);
            while (true)
            {
                try
                {
                    await CheckUpdatesAsync(force: true).ConfigureAwait(false);
                }
                catch (Exception error)
                {
                    Log.Write($"检查更新失败：{error.Message}");
                }

                await Task.Delay(TimeSpan.FromHours(6)).ConfigureAwait(false);
            }
        });
    }

    /// <summary>
    /// 升级：Pi 自己先升，再升扩展。一次只跑一个。
    /// 有对话正在跑时要用户点头（<paramref name="stopRunning"/>），点头了就先把它们停下：
    /// 升级会把更老的版本目录删掉，正在用的进程还指着那边。
    /// </summary>
    private async Task UpgradePiAsync(bool stopRunning)
    {
        if (_upgrader.Busy)
        {
            Broadcast(JobFailed("已经在升级了，等这一次跑完"));
            return;
        }

        var running = _live.Values.Where(state => state.Streaming).ToList();
        if (running.Count > 0)
        {
            if (!stopRunning)
            {
                // 界面那边先问过用户了；这里只是兜底，别让人以为「点了没反应」。
                Broadcast(JobFailed("现在有对话正在跑。要马上升级就先停下它们，或者等这一轮结束。"));
                return;
            }

            Broadcast(new JsonObject
            {
                ["type"] = "update_job",
                ["state"] = "running",
                ["text"] = $"先把 {running.Count} 个正在跑的对话停下…",
            });
            await StopAllForUpgradeAsync(running).ConfigureAwait(false);
        }

        // 还没查过就现查一次：点得比第一轮检查还早的时候，不能让「没有要升级的东西」糊弄过去。
        var before = _updates.Current();
        if (before["checkedAt"] is null)
        {
            before = await _updates.CheckAsync(force: true).ConfigureAwait(false);
            Broadcast(WithModels(before));
        }

        var pi = before["pi"];
        var from = pi?["installed"]?.GetValue<string>() ?? string.Empty;
        var to = pi?["latest"]?.GetValue<string>() ?? string.Empty;
        var piOutdated = pi?["hasUpdate"]?.GetValue<bool>() == true;
        var stale = (before["packages"] as JsonArray)?
            .Count(item => item?["hasUpdate"]?.GetValue<bool>() == true) ?? 0;

        if (!piOutdated && stale == 0)
        {
            Broadcast(JobFailed("没有要升级的东西"));
            return;
        }

        if (piOutdated)
        {
            Broadcast(JobRunning("Pi", from, to));
            var (ok, message) = await _upgrader.RunAsync(new[] { "update", "--self" }).ConfigureAwait(false);
            if (!ok)
            {
                var still = from.Length > 0 ? $"，还在 {from}" : string.Empty;
                Broadcast(JobFailed($"升级没成功：{message}{still}"));
                return;
            }
        }

        if (stale > 0)
        {
            Broadcast(JobRunning("extensions", string.Empty, string.Empty));
            var (ok, message) = await _upgrader.RunAsync(new[] { "update", "--extensions" }).ConfigureAwait(false);
            if (!ok)
            {
                Broadcast(JobFailed($"扩展没更新成功：{message}"));
                return;
            }
        }

        // 先把结果说出来：界面上的卡片立刻翻面，不用等重新查一遍的网络往返。
        var installed = to.Length > 0 ? to : from;
        Broadcast(new JsonObject
        {
            ["type"] = "update_job",
            ["state"] = "done",
            ["text"] = piOutdated && stale > 0
                ? $"Pi 已升级到 {installed}，{stale} 个扩展也更新好了"
                : piOutdated
                    ? $"Pi 已升级到 {installed}，新开的对话就用这个版本"
                    : $"{stale} 个扩展已更新",
        });

        // 然后重新查一遍，让版本号和提示条跟上（也顺手确认真的换了）。
        Broadcast(WithModels(await _updates.CheckAsync(force: true).ConfigureAwait(false)));
    }

    private static JsonObject JobRunning(string target, string from, string to) => new()
    {
        ["type"] = "update_job",
        ["state"] = "running",
        ["target"] = target,
        ["from"] = from,
        ["to"] = to,
    };

    private static JsonObject JobFailed(string text) => new()
    {
        ["type"] = "update_job",
        ["state"] = "failed",
        ["text"] = text,
    };

    /// <summary>更新消息顺带把模型清单的状态带上：设置页「运行时」那张卡片要显示它。</summary>
    private JsonObject WithModels(JsonObject snapshot)
    {
        var copy = snapshot.DeepClone().AsObject();
        var models = Parse(_store.GetSetting("models"));
        var cachedAt = long.TryParse(_store.GetSetting("modelsAt"), out var stamp) ? stamp : 0;
        copy["models"] = new JsonObject
        {
            ["count"] = (models?["models"] as JsonArray)?.Count ?? 0,
            ["cachedAt"] = cachedAt > 0
                ? DateTimeOffset.FromUnixTimeMilliseconds(cachedAt).ToString("o")
                : null,
        };
        return copy;
    }

    private async Task CheckUpdatesAsync(bool force)
    {
        var snapshot = await _updates.CheckAsync(force).ConfigureAwait(false);
        Broadcast(WithModels(snapshot));
    }

    /// <summary>
    /// 扩展页：Pi 配置里声明的扩展包（装没装、什么版本），加上当前工作区里
    /// Pi 报过的扩展命令。
    /// </summary>
    private async Task SendExtensionsAsync(string cwd, CenterConnection sender)
    {
        var home = CoreSettings.Current.PiHome;
        var settingsPath = Path.Combine(home, ".pi", "agent", "settings.json");
        var problems = new JsonArray();
        var packages = new JsonArray();
        var declared = new List<string>();

        try
        {
            if (File.Exists(settingsPath) &&
                JsonNode.Parse(File.ReadAllText(settingsPath)) is JsonObject settings &&
                settings["packages"] is JsonArray list)
            {
                foreach (var entry in list)
                {
                    var text = entry?.GetValue<string>();
                    if (!string.IsNullOrWhiteSpace(text))
                    {
                        declared.Add(text!);
                    }
                }
            }
        }
        catch (Exception)
        {
            problems.Add("读不出 Pi 的扩展配置");
        }

        foreach (var source in declared)
        {
            var (kind, name) = SplitPackageSource(source);
            var directory = PackageDirectory(home, kind, name);
            packages.Add(new JsonObject
            {
                ["source"] = source,
                ["kind"] = kind,
                ["name"] = name,
                ["path"] = directory ?? string.Empty,
                ["installed"] = directory is not null && Directory.Exists(directory),
                ["version"] = directory is null ? string.Empty : ReadPackageVersion(directory),
            });
        }

        // 扩展命令只认缓存：不去为了列个清单悄悄起一个 Pi 会话。
        // 用户打开对话、在输入框里打过 / 之后，Seven Station Core 这边就有了这个工作区的缓存。
        var commands = new JsonArray();
        if (!string.IsNullOrWhiteSpace(cwd) &&
            ParseNode(_store.GetSetting("commands:" + cwd.ToLowerInvariant())) is JsonArray cached)
        {
            foreach (var entry in cached.OfType<JsonObject>())
            {
                if (entry["source"]?.GetValue<string>() != "extension")
                {
                    continue;
                }

                commands.Add(new JsonObject
                {
                    ["name"] = entry["name"]?.GetValue<string>() ?? string.Empty,
                    ["description"] = entry["description"]?.GetValue<string>() ?? string.Empty,
                    ["scope"] = (entry["sourceInfo"] as JsonObject)?["scope"]?.GetValue<string>() ?? string.Empty,
                });
            }
        }

        sender.Send(new JsonObject
        {
            ["type"] = "extensions",
            ["cwd"] = cwd,
            ["settingsPath"] = settingsPath,
            ["packages"] = packages,
            ["commands"] = commands,
            ["problems"] = problems,
        });

        await Task.CompletedTask;
    }

    private static (string Kind, string Name) SplitPackageSource(string source)
    {
        if (source.StartsWith("npm:", StringComparison.OrdinalIgnoreCase))
        {
            return ("npm", source[4..].Trim());
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

        return ("path", source.Trim());
    }

    private static string? PackageDirectory(string home, string kind, string name)
    {
        return kind switch
        {
            "npm" => Path.Combine(home, ".pi", "agent", "npm", "node_modules", name),
            "git" => Path.Combine(home, ".pi", "agent", "git", name),
            "path" => name,
            _ => null,
        };
    }

    private static string ReadPackageVersion(string directory)
    {
        try
        {
            var manifest = Path.Combine(directory, "package.json");
            if (File.Exists(manifest) &&
                JsonNode.Parse(File.ReadAllText(manifest)) is JsonObject json)
            {
                return json["version"]?.GetValue<string>() ?? string.Empty;
            }
        }
        catch (Exception)
        {
            // 版本读不出来不影响列表。
        }

        return string.Empty;
    }

    /// <summary>
    /// 自定义样式存在 Seven Station Core，换设备打开也是同一套；改完推给所有在线客户端，立刻生效。
    /// </summary>
    private void SetCustomCss(string css)
    {
        _store.SetSetting("custom_css", css);
        Broadcast(new JsonObject
        {
            ["type"] = "css",
            ["css"] = css,
        });
    }

    /// <summary>Seven Station Core 日志的尾巴。手机上出了问题先看这一屏，不用回电脑翻文件。</summary>
    private static void ReadLog(int lines, CenterConnection sender)
    {
        var tail = Math.Clamp(lines, 20, 500);
        var path = Log.FilePath;
        var text = string.Empty;

        try
        {
            if (File.Exists(path))
            {
                text = string.Join('\n', File.ReadLines(path).TakeLast(tail));
            }
        }
        catch (Exception ex)
        {
            text = "日志读不出来：" + ex.Message;
        }

        sender.Send(new JsonObject
        {
            ["type"] = "log_tail",
            ["path"] = path,
            ["text"] = text,
        });
    }

    /// <summary>按标题和正文搜对话。</summary>
    private void SearchConversations(string query, CenterConnection sender)
    {
        var hits = _store.Search(query);
        var items = new JsonArray();

        foreach (var (conversation, snippet) in hits)
        {
            items.Add(new JsonObject
            {
                ["id"] = conversation.Id,
                ["title"] = conversation.Title,
                ["cwd"] = conversation.Cwd,
                ["updatedAt"] = conversation.UpdatedAt,
                ["messageCount"] = conversation.MessageCount,
                ["snippet"] = snippet,
            });
        }

        sender.Send(new JsonObject
        {
            ["type"] = "search_results",
            ["query"] = query,
            ["items"] = items,
        });
    }

    /// <summary>新建对话前先看看这个目录在不在，别等建完才发现写不进会话。</summary>
    private static void CheckPath(string path, CenterConnection sender)
    {
        var cleaned = path.Trim().Trim('"');
        var exists = false;
        var isDirectory = false;
        var reason = string.Empty;

        if (cleaned.Length == 0)
        {
            reason = "先填一个目录";
        }
        else
        {
            try
            {
                var full = Path.GetFullPath(cleaned);
                exists = Directory.Exists(full) || File.Exists(full);
                isDirectory = Directory.Exists(full);
                if (!exists)
                {
                    reason = "这个目录不存在";
                }
                else if (!isDirectory)
                {
                    reason = "这个路径是个文件，不是目录";
                }
                else
                {
                    cleaned = full;
                }
            }
            catch (Exception)
            {
                reason = "这个路径写不出合法路径";
            }
        }

        sender.Send(new JsonObject
        {
            ["type"] = "path_check",
            ["path"] = cleaned,
            ["exists"] = exists && isDirectory,
            ["reason"] = reason,
        });
    }

    /// <summary>工作区文件浏览：只读，只允许在工作区里走。</summary>
    private void ListDirectory(string id, JsonObject message, CenterConnection sender)
    {
        const int limit = 500;
        var conversation = RequireConversation(id);
        var relative = message["path"]?.GetValue<string>() ?? string.Empty;
        var target = ResolveInWorkspace(conversation.Cwd, relative);
        var items = new JsonArray();

        if (target is not null && Directory.Exists(target))
        {
            try
            {
                var entries = new List<(string Name, bool IsDirectory, long Size, DateTime Modified)>();
                foreach (var directory in Directory.EnumerateDirectories(target))
                {
                    entries.Add((Path.GetFileName(directory), true, 0, SafeModified(directory)));
                }

                foreach (var file in Directory.EnumerateFiles(target))
                {
                    entries.Add((Path.GetFileName(file), false, SafeSize(file), SafeModified(file)));
                }

                foreach (var entry in entries
                             .OrderBy(entry => entry.IsDirectory ? 0 : 1)
                             .ThenBy(entry => entry.Name, StringComparer.OrdinalIgnoreCase)
                             .Take(limit))
                {
                    var childRelative = string.IsNullOrEmpty(relative)
                        ? entry.Name
                        : relative.TrimEnd('/') + "/" + entry.Name;

                    items.Add(new JsonObject
                    {
                        ["name"] = entry.Name,
                        ["path"] = childRelative,
                        ["dir"] = entry.IsDirectory,
                        ["size"] = entry.Size,
                        ["modified"] = entry.Modified.ToString("O"),
                    });
                }
            }
            catch (Exception ex)
            {
                Log.Write($"列目录失败：{target}", ex);
            }
        }

        sender.Send(new JsonObject
        {
            ["type"] = "dir_listing",
            ["key"] = id,
            ["path"] = relative,
            ["items"] = items,
            ["exists"] = target is not null && Directory.Exists(target),
        });
    }

    /// <summary>读一个文本文件给界面看。二进制与超大文件不猜，直接说明原因。</summary>
    private void ReadFile(string id, JsonObject message, CenterConnection sender)
    {
        const long maxBytes = 512 * 1024;
        var conversation = RequireConversation(id);
        var relative = message["path"]?.GetValue<string>() ?? string.Empty;
        var target = ResolveInWorkspace(conversation.Cwd, relative);

        string? content = null;
        string? reason = null;

        if (target is null || !File.Exists(target))
        {
            reason = "找不到这个文件";
        }
        else
        {
            var info = new FileInfo(target);
            if (info.Length > maxBytes)
            {
                reason = "文件超过 512 KB，没有打开";
            }
            else
            {
                try
                {
                    var bytes = File.ReadAllBytes(target);
                    var probe = bytes.AsSpan(0, Math.Min(bytes.Length, 8 * 1024));
                    if (probe.IndexOf((byte)0) >= 0)
                    {
                        reason = "看起来是二进制文件，没有打开";
                    }
                    else
                    {
                        content = System.Text.Encoding.UTF8.GetString(bytes);
                    }
                }
                catch (Exception ex)
                {
                    Log.Write($"读文件失败：{target}", ex);
                    reason = "读不出来：" + ex.Message;
                }
            }
        }

        sender.Send(new JsonObject
        {
            ["type"] = "file_content",
            ["key"] = id,
            ["path"] = relative,
            ["text"] = content,
            ["reason"] = reason,
        });
    }

    /// <summary>把相对路径收进工作区。越界（..、绝对路径跑到外面）就返回 null。</summary>
    private static string? ResolveInWorkspace(string cwd, string relative)
    {
        try
        {
            var root = Path.GetFullPath(cwd);
            var rootWithSep = root.EndsWith(Path.DirectorySeparatorChar)
                ? root
                : root + Path.DirectorySeparatorChar;
            var target = Path.GetFullPath(Path.Combine(root, relative.Replace('\\', '/')));

            if (string.Equals(target, root, StringComparison.OrdinalIgnoreCase))
            {
                return target;
            }

            return target.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase) ? target : null;
        }
        catch
        {
            return null;
        }
    }

    private static long SafeSize(string path)
    {
        try
        {
            return new FileInfo(path).Length;
        }
        catch
        {
            return 0;
        }
    }

    private static DateTime SafeModified(string path)
    {
        try
        {
            return File.GetLastWriteTime(path);
        }
        catch
        {
            return DateTime.MinValue;
        }
    }

    /// <summary>Pi 里能用的 / 命令：扩展命令、提示词模板、技能。跟工作区有关，按目录缓存。</summary>
    private async Task SendCommandsAsync(string id, CenterConnection sender)
    {
        var conversation = RequireConversation(id);
        var cacheKey = "commands:" + conversation.Cwd.ToLowerInvariant();
        if (ParseNode(_store.GetSetting(cacheKey)) is JsonArray cached)
        {
            sender.Send(new JsonObject
            {
                ["type"] = "commands",
                ["key"] = id,
                ["items"] = cached.DeepClone(),
            });
            return;
        }

        var live = EnsureLive(conversation);
        var response = await live.Session.SendAsync(new JsonObject { ["type"] = "get_commands" });
        var commands = Data(response)?["commands"] as JsonArray;
        if (commands is not null)
        {
            _store.SetSetting(cacheKey, commands.ToJsonString());
        }

        sender.Send(new JsonObject
        {
            ["type"] = "commands",
            ["key"] = id,
            ["items"] = commands?.DeepClone() ?? new JsonArray(),
        });
    }

    /// <summary>
    /// 输入框里打 @ 时的路径补全。这活不经过 Pi：Seven Station Core 自己扫工作区，
    /// 会话在哪台机器上，补的就是哪台机器上的文件。
    /// </summary>
    private void CompleteFiles(string id, JsonObject message, CenterConnection sender)
    {
        var conversation = RequireConversation(id);
        var query = message["query"]?.GetValue<string>() ?? string.Empty;
        var items = new JsonArray();

        var normalized = query.Replace('\\', '/');
        var slash = normalized.LastIndexOf('/');
        var dirPart = slash >= 0 ? normalized[..(slash + 1)] : string.Empty;
        var prefix = slash >= 0 ? normalized[(slash + 1)..] : normalized;

        var root = Path.GetFullPath(conversation.Cwd);
        var baseDir = Path.GetFullPath(Path.Combine(root, dirPart.TrimEnd('/')));

        // 只允许在工作区里面找。
        var rootWithSep = root.EndsWith(Path.DirectorySeparatorChar)
            ? root
            : root + Path.DirectorySeparatorChar;
        if (!baseDir.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(baseDir, root, StringComparison.OrdinalIgnoreCase))
        {
            sender.Send(new JsonObject { ["type"] = "file_completions", ["key"] = id, ["query"] = query, ["items"] = items });
            return;
        }

        if (Directory.Exists(baseDir))
        {
            var entries = new List<(string Name, bool IsDirectory)>();
            try
            {
                foreach (var directory in Directory.EnumerateDirectories(baseDir))
                {
                    entries.Add((Path.GetFileName(directory), true));
                }

                foreach (var file in Directory.EnumerateFiles(baseDir))
                {
                    entries.Add((Path.GetFileName(file), false));
                }
            }
            catch (Exception ex)
            {
                Log.Write($"补全时读目录失败：{baseDir}", ex);
            }

            foreach (var entry in entries
                         .Where(entry => entry.Name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                         .OrderBy(entry => entry.IsDirectory ? 0 : 1)
                         .ThenBy(entry => entry.Name, StringComparer.OrdinalIgnoreCase)
                         .Take(60))
            {
                items.Add(new JsonObject
                {
                    ["path"] = dirPart + entry.Name + (entry.IsDirectory ? "/" : string.Empty),
                    ["dir"] = entry.IsDirectory,
                });
            }
        }

        sender.Send(new JsonObject
        {
            ["type"] = "file_completions",
            ["key"] = id,
            ["query"] = query,
            ["items"] = items,
        });
    }

    /// <summary>只发用量，不碰线程内容：收尾后界面会来问一次，不能拿库里的旧副本覆盖流式结果。</summary>
    /// <summary>工作区的 git 快照。只读：界面拿它画分支胶囊，这里不写仓库。</summary>
    private async Task SendGitStatusAsync(string id, CenterConnection sender)
    {
        var conversation = RequireConversation(id);
        var snapshot = await GitProbe.SnapshotAsync(conversation.Cwd).ConfigureAwait(false);
        sender.Send(new JsonObject
        {
            ["type"] = "git_status",
            ["key"] = id,
            ["data"] = snapshot,
        });
    }

    private void SendStats(string id, CenterConnection sender)
    {
        var conversation = RequireConversation(id);
        sender.Send(new JsonObject
        {
            ["type"] = "stats",
            ["key"] = id,
            ["data"] = Parse(conversation.Stats),
        });
    }

    /// <summary>
    /// 对话没选过模型时补上 Pi 自己的默认（settings.json 的 defaultProvider + defaultModel）。
    /// 不补的话界面会兜到模型列表第一条，显示成根本不是当前在跑的那个模型。
    /// </summary>
    private JsonObject StateWithModel(Conversation conversation, Live? live)
    {
        var state = BuildState(conversation, live?.Streaming == true, live is null ? null : QueueEntries(live));
        if (!state.ContainsKey("model") && PiDefaultModel() is { } fallback)
        {
            state["model"] = fallback;
        }

        return state;
    }

    /// <summary>Pi 配置文件里的默认模型，补全字段时优先用缓存下来的模型列表。</summary>
    private JsonObject? PiDefaultModel()
    {
        var agent = CoreSettings.Current.Agent(AgentRegistry.PiId);
        var directory = agent?.Directory;
        if (string.IsNullOrWhiteSpace(directory)) return null;

        var path = Path.Combine(directory, "settings.json");
        string? provider = null;
        string? modelId = null;
        try
        {
            var settings = JsonNode.Parse(File.ReadAllText(path)) as JsonObject;
            provider = settings?["defaultProvider"]?.GetValue<string>();
            modelId = settings?["defaultModel"]?.GetValue<string>();
        }
        catch
        {
            return null;
        }

        if (string.IsNullOrWhiteSpace(modelId))
        {
            return null;
        }

        if (Parse(_store.GetSetting("models")) is JsonObject cached
            && cached["models"] is JsonArray entries)
        {
            foreach (var entry in entries)
            {
                if (entry is not JsonObject model) continue;
                if (model["id"]?.GetValue<string>() != modelId) continue;
                if (provider is not null && model["provider"]?.GetValue<string>() != provider) continue;
                return (JsonObject)model.DeepClone();
            }
        }

        var bare = new JsonObject { ["id"] = modelId, ["name"] = modelId };
        if (!string.IsNullOrWhiteSpace(provider)) bare["provider"] = provider;
        return bare;
    }

    private static JsonObject BuildState(Conversation conversation, bool streaming, JsonArray? queue)
    {
        var state = new JsonObject
        {
            ["sessionName"] = conversation.Title,
            ["isStreaming"] = streaming,
        };

        if (queue is not null)
        {
            state["queue"] = queue;
        }

        if (Parse(conversation.Model) is { } model)
        {
            state["model"] = model;
        }

        if (!string.IsNullOrEmpty(conversation.ThinkingLevel))
        {
            state["thinkingLevel"] = conversation.ThinkingLevel;
        }

        return state;
    }

    private async Task NewConversationAsync(JsonObject message, CenterConnection sender)
    {
        var cwd = message["cwd"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(cwd) || !Directory.Exists(cwd))
        {
            throw new InvalidOperationException($"工作目录不存在：{cwd}");
        }

        var title = message["title"]?.GetValue<string>();
        var conversation = _store.Create(cwd, title);
        InheritLastSettings(conversation);
        RememberWorkspace(conversation.Cwd);
        Log.Write($"新对话 {conversation.Id} cwd={cwd}");
        SendState(conversation.Id, sender);
        SendConversationList(sender);
    }

    private void RenameConversation(string id, JsonObject message, CenterConnection sender)
    {
        RequireConversation(id);
        var title = message["title"]?.GetValue<string>()?.Trim();
        if (string.IsNullOrEmpty(title))
        {
            throw new InvalidOperationException("标题不能为空。");
        }

        _store.Rename(id, title);
        var updated = RequireConversation(id);
        Broadcast(Settings(updated));
        SendConversationList(sender);
    }

    private async Task DeleteConversationAsync(string id)
    {
        Live? live;
        lock (_gate)
        {
            _live.Remove(id, out live);
        }

        if (live is not null)
        {
            await live.Session.DisposeAsync();
        }

        StopTerminalInternal(id);
        _store.Delete(id);
        Log.Write($"删除对话 {id}（Pi 那边的会话文件保留在原处）");
    }

    /// <summary>拿到这个对话对应的活子进程，没有就按绑定续上。</summary>
    private Live EnsureLive(Conversation conversation)
    {
        lock (_gate)
        {
            if (_live.TryGetValue(conversation.Id, out var existing) && existing.Session.IsRunning)
            {
                return existing;
            }
        }

        if (!Directory.Exists(conversation.Cwd))
        {
            throw new InvalidOperationException(
                $"这个对话的工作目录不在了（{conversation.Cwd}），历史还能看，但没法继续聊。");
        }

        var resume = conversation.PiSessionFile;
        if (!string.IsNullOrEmpty(resume) && !File.Exists(resume))
        {
            // Pi 那边的记录被清掉了：历史还在 SevenStation.Core，只是接不上原来那段上下文。
            Log.Write($"对话 {conversation.Id} 的 Pi 会话文件已不存在，改开新会话：{resume}");
            resume = null;
        }

        var session = PiSession.Start(conversation.Cwd, resume);
        var live = new Live
        {
            Conversation = conversation,
            Session = session,
            PiVersion = PiLocator.CurrentVersion(),
        };
        Log.Write($"对话 {conversation.Id} 起子进程 cwd={conversation.Cwd} resume={resume ?? "（新建）"}");

        session.RecordReceived += record =>
        {
            live.LastEventAt = DateTimeOffset.UtcNow;
            var name = record["type"]?.GetValue<string>();
            if (name == "agent_start")
            {
                SetStreaming(live, true);
                // 新一轮从零开始记，判重集合不用一直长。
                lock (live.Persisted)
                {
                    live.Persisted.Clear();
                }
            }
            else if (name == "turn_end")
            {
                // 一个回合（模型这一轮回答 + 它的工具调用）结束了。排队的话就在这儿交给 Pi：
                // 带 streamingBehavior: "steer"，Pi 会在下一次调模型前采用它。
                // 等 agent_settled 才送的话，一整轮跑多久就要等多久，那不叫追加。
                if (live.Streaming && !live.StopRequested) _ = DeliverQueuedAsync(live, steering: true);
            }
            else if (name == "agent_end")
            {
                // 这里**不**放掉「忙」。agent_end 只结束一次底层 run，重试、溢出恢复、压缩、
                // steering、follow-up 都可能接着来（Pi 的 rpc 文档明写），中间这一段侧栏会误报「没在跑」，
                // 而实际上下一段还在干活。判「Pi 不会自己继续了」只看 agent_settled。
            }
            else if (name == "agent_settled")
            {
                SetStreaming(live, false);
                _ = PersistTurnAsync(live);

                // 用户按下停止时不替他继续干活：排队的留在面板里，由他自己决定发还是删。
                var aborted = record["aborted"]?.GetValue<bool>() == true;
                live.StopRequested = false;
                if (!aborted) _ = DeliverQueuedAsync(live);
            }
            else if (name == "message_end")
            {
                // 用户的话和模型每段输出一产生就落库：这一轮还没结束，
                // 中途切到别的对话再切回来，看到的不是空白。
                AppendLiveMessage(live, record["message"] as JsonObject);
                AskLiveStats(live);
            }
            else if (name == "tool_execution_end")
            {
                AppendLiveMessage(live, ToolResultMessage(record));
                AskLiveStats(live);
            }

            Broadcast(new JsonObject
            {
                ["type"] = "event",
                ["key"] = conversation.Id,
                ["event"] = record.DeepClone(),
            });
        };

        session.Exited += (code, stderr) =>
        {
            lock (_gate)
            {
                if (_live.TryGetValue(conversation.Id, out var current) && ReferenceEquals(current.Session, session))
                {
                    _live.Remove(conversation.Id);
                }
            }

            Log.Write($"对话 {conversation.Id} 子进程退出 code={code} stderr={stderr.Replace(Environment.NewLine, " | ")}");
            Broadcast(new JsonObject
            {
                ["type"] = "process_exit",
                ["key"] = conversation.Id,
                ["code"] = code,
                ["stderr"] = stderr,
            });
        };

        lock (_gate)
        {
            _live[conversation.Id] = live;
        }

        // 子进程一起来就把默认模型与思考等级记下来，之后打开这个对话不用再问 Pi。
        _ = CaptureSettingsAsync(live);
        Broadcast(new JsonObject { ["type"] = "conversation_saved", ["key"] = conversation.Id });

        return live;
    }

    /// <summary>把一条消息追加进库，同一轮里重复的事件不重复写。</summary>
    private void AppendLiveMessage(Live live, JsonObject? message)
    {
        if (message is null)
        {
            return;
        }

        var role = message["role"]?.GetValue<string>();
        if (role is not ("user" or "assistant" or "toolResult"))
        {
            return;
        }

        // 工具结果按调用号判重，其它按时间点；拿不到标识就照写，宁可多一条也不漏。
        var identity = role == "toolResult"
            ? message["toolCallId"]?.GetValue<string>()
            : message["timestamp"]?.ToJsonString();

        lock (live.Persisted)
        {
            if (!string.IsNullOrEmpty(identity) && !live.Persisted.Add(role + ":" + identity))
            {
                return;
            }
        }

        try
        {
            _store.AppendMessages(live.Conversation.Id, new JsonNode?[] { message.DeepClone() });
        }
        catch (Exception ex)
        {
            // 落不下来只是这段历史少一截，不能让正在跑的这一轮跟着挂。
            Log.Write($"对话 {live.Conversation.Id} 追加消息失败", ex);
        }
    }

    /// <summary>
    /// 工具结果事件转成 Pi 的消息形状，跟历史里存的那条一致，
    /// 这样中途切回来、完成后再看，走的是同一套渲染。
    /// </summary>
    private static JsonObject? ToolResultMessage(JsonObject record)
    {
        var id = record["toolCallId"]?.GetValue<string>();
        if (string.IsNullOrEmpty(id))
        {
            return null;
        }

        return new JsonObject
        {
            ["role"] = "toolResult",
            ["toolCallId"] = id,
            ["toolName"] = record["toolName"]?.GetValue<string>(),
            ["content"] = record["result"] is JsonObject result && result["content"] is JsonArray content
                ? content.DeepClone()
                : new JsonArray(),
            ["isError"] = record["isError"]?.GetValue<bool>() ?? false,
            ["durationMs"] = record["durationMs"]?.GetValue<long>() ?? 0,
            ["timestamp"] = DateTimeOffset.Now.ToUnixTimeMilliseconds(),
        };
    }

    /// <summary>
    /// 一轮还在跑的时候，用量（tokens / 上下文占比）也要跟着动。
    /// 每段输出、每次工具调用之后问 Pi 要一次；3 秒节流，问不动就悄悄放过。
    /// 落库还是等一轮结束（PersistTurnAsync），这里只推给界面看。
    /// </summary>
    private void AskLiveStats(Live live)
    {
        var now = DateTimeOffset.UtcNow;
        if (now - live.StatsAskedAt < TimeSpan.FromSeconds(3)) return;
        live.StatsAskedAt = now;
        _ = RefreshLiveStatsAsync(live);
    }

    private async Task RefreshLiveStatsAsync(Live live)
    {
        try
        {
            var stats = await live.Session.SendAsync(
                new JsonObject { ["type"] = "get_session_stats" },
                TimeSpan.FromSeconds(5));
            if (Data(stats) is not { } data) return;
            Broadcast(new JsonObject
            {
                ["type"] = "stats",
                ["key"] = live.Conversation.Id,
                ["data"] = data.DeepClone(),
            });
        }
        catch (Exception error)
        {
            // 长命令期间 Pi 没空回话是常事：退避 30 秒再试，别每节流一次就记一行日志。
            live.StatsAskedAt = DateTimeOffset.UtcNow.AddSeconds(30);
            Log.Write($"对话 {live.Conversation.Id} 刷新用量失败：{error.Message}");
        }
    }
    /// <summary>一轮结束后把 Pi 那边的消息取回来，存成 SevenStation.Core 自己的副本。</summary>
    private async Task PersistTurnAsync(Live live)
    {
        try
        {
            var messages = await live.Session.SendAsync(new JsonObject { ["type"] = "get_messages" });
            var stats = await live.Session.SendAsync(new JsonObject { ["type"] = "get_session_stats" });
            var state = await live.Session.SendAsync(new JsonObject { ["type"] = "get_state" });

            var data = Data(messages);
            var stored = data?["messages"] as JsonArray;
            var conversation = _store.Get(live.Conversation.Id);
            var title = string.IsNullOrEmpty(conversation?.Title)
                ? DeriveTitleFrom(stored)
                : null;

            var statsData = Data(stats);
            _store.SaveTurn(live.Conversation.Id, stored, statsData, Data(state), title);

            // 存完立刻把最新用量推回去，别让界面等下一次刷新。
            Broadcast(new JsonObject
            {
                ["type"] = "stats",
                ["key"] = live.Conversation.Id,
                ["data"] = statsData?.DeepClone(),
            });
            Broadcast(new JsonObject
            {
                ["type"] = "conversation_saved",
                ["key"] = live.Conversation.Id,
            });
        }
        catch (Exception ex)
        {
            // 存不下来只是历史少一段，不能让对话本身挂掉。
            Log.Write($"对话 {live.Conversation.Id} 保存失败", ex);
        }
    }

    private static string? DeriveTitleFrom(JsonArray? messages)
    {
        if (messages is null)
        {
            return null;
        }

        foreach (var node in messages)
        {
            if (node is not JsonObject message || message["role"]?.GetValue<string>() != "user")
            {
                continue;
            }

            var text = message["content"] switch
            {
                JsonValue value => value.ToString(),
                JsonArray blocks => string.Join(" ", blocks
                    .OfType<JsonObject>()
                    .Where(block => block["type"]?.GetValue<string>() == "text")
                    .Select(block => block["text"]?.GetValue<string>())),
                _ => null,
            };

            if (string.IsNullOrWhiteSpace(text))
            {
                continue;
            }

            var firstLine = text.Split('\n')[0].Trim();
            return firstLine.Length > 40 ? firstLine[..40] + "…" : firstLine;
        }

        return null;
    }

    /// <summary>
    /// 升级之后，老对话的子进程还指着旧版本目录：Pi 的升级只改 <c>current-version</c> 这个指针，
    /// 已经起来的进程里还是老代码。发话前对一眼，不一致就重起一个——Pi 那边 resume 的是同一个
    /// 会话文件，历史不丢；而且只在空闲时走这条路，不会把一轮半路掐断。
    /// </summary>
    private async Task<Live> RollForwardPiVersionAsync(Live live)
    {
        var current = PiLocator.CurrentVersion();
        if (string.IsNullOrEmpty(current)
            || string.IsNullOrEmpty(live.PiVersion)
            || live.PiVersion == current)
        {
            return live;
        }

        Log.Write($"对话 {live.Conversation.Id} 的 Pi 还停在 {live.PiVersion}，换成 {current} 重起");
        lock (_gate)
        {
            _live.Remove(live.Conversation.Id);
        }

        try
        {
            await live.Session.DisposeAsync();
        }
        catch
        {
            // 已经退了。
        }

        return EnsureLive(live.Conversation);
    }

    private async Task PromptAsync(string id, JsonObject message, CenterConnection sender)
    {
        var conversation = RequireConversation(id);
        var live = EnsureLive(conversation);
        if (!live.Streaming) live = await RollForwardPiVersionAsync(live);
        await ApplyStoredSettingsAsync(live);

        // 工作中说的话不再直接丢给 Pi：那边只能整队清空，单条改不了。
        // 先存在 Core 里，等 agent_settled 时再依次送出去。
        if (live.Streaming)
        {
            EnqueuePrompt(live, message);
            return;
        }

        var command = new JsonObject
        {
            ["type"] = "prompt",
            ["message"] = message["message"]?.GetValue<string>() ?? string.Empty,
        };

        if (message["images"] is JsonArray images)
        {
            command["images"] = images.DeepClone();
        }

        // 演示用：起实例时带上 SEVENSTATION_DEBUG_FAIL_PROMPT=1，每句话都当场失败，
        // 方便看「没发出去」那个红圈长什么样。正式运行时不必设置。
        // 单数失败、双数成功：先看到红圈，点「重新发送」就能看到它转起来并送达。
        if (Environment.GetEnvironmentVariable("SEVENSTATION_DEBUG_FAIL_PROMPT") == "1"
            && Interlocked.Increment(ref _demoAttempts) % 2 == 1)
        {
            sender.Send(new JsonObject
            {
                ["type"] = "error",
                ["key"] = id,
                ["message"] = "（演示）这条没有发出去",
            });
            return;
        }

        // 第一次说话就用这句话当标题，省一次模型调用。
        if (string.IsNullOrEmpty(conversation.Title))
        {
            var text = command["message"]?.GetValue<string>() ?? string.Empty;
            var firstLine = text.Split('\n')[0].Trim();
            if (firstLine.Length > 0)
            {
                _store.Rename(id, firstLine.Length > 40 ? firstLine[..40] + "…" : firstLine);
                // 标题是服务端定的，推回去让开着的界面立刻改名，不用等重开。
                Broadcast(Settings(RequireConversation(id)));
                Broadcast(new JsonObject { ["type"] = "conversation_saved", ["key"] = id });
            }
        }

        // 从这里开始算「正在干活」：Pi 的 agent_start 不一定每次都到，
        // 用自己发出去的这条 prompt 来判断，排队才不会漏。
        SetStreaming(live, true);
        var response = await live.Session.SendAsync(command, TimeSpan.FromSeconds(60));
        sender.Send(new JsonObject
        {
            ["type"] = "prompt_accepted",
            ["key"] = id,
            ["disposition"] = Data(response)?["disposition"]?.GetValue<string>(),
        });
    }

    /// <summary>取已经在跑的会话；没跑就等于没东西可排，直接忽略。</summary>
    private Live? LiveFor(string id)
    {
        lock (_gate)
        {
            return _live.TryGetValue(id, out var live) ? live : null;
        }
    }

    private void EnqueuePrompt(Live live, JsonObject message)
    {
        var text = message["message"]?.GetValue<string>()?.TrimEnd();
        if (string.IsNullOrWhiteSpace(text)) return;

        var images = message["images"] is JsonArray source ? (JsonArray)source.DeepClone() : null;
        var id = "q" + Interlocked.Increment(ref _queueSeq);
        lock (live.Queue)
        {
            live.Queue.Add(new QueuedPrompt(id, text, images));
        }

        BroadcastQueue(live);
    }

    private void EditQueued(Live? live, JsonObject message)
    {
        if (live is null) return;

        var id = message["id"]?.GetValue<string>();
        if (string.IsNullOrEmpty(id)) throw new InvalidOperationException("缺少条目标识。");

        var text = message["message"]?.GetValue<string>()?.TrimEnd();
        if (string.IsNullOrWhiteSpace(text))
        {
            RemoveQueued(live, id);
            return;
        }

        lock (live.Queue)
        {
            var index = live.Queue.FindIndex((item) => item.Id == id);
            if (index >= 0) live.Queue[index] = live.Queue[index] with { Text = text };
        }

        BroadcastQueue(live);
    }

    private void RemoveQueued(Live? live, string? id)
    {
        if (live is null || string.IsNullOrEmpty(id)) return;
        lock (live.Queue)
        {
            live.Queue.RemoveAll((item) => item.Id == id);
        }

        BroadcastQueue(live);
    }

    private void ClearQueue(Live? live)
    {
        if (live is null) return;
        lock (live.Queue)
        {
            live.Queue.Clear();
        }

        BroadcastQueue(live);
    }

    /// <summary>排队条目的对外样子：只给标识和正文，图片不出界面。</summary>
    private static JsonArray QueueEntries(Live live)
    {
        var entries = new JsonArray();
        lock (live.Queue)
        {
            foreach (var item in live.Queue)
            {
                entries.Add(new JsonObject { ["id"] = item.Id, ["text"] = item.Text });
            }
        }

        return entries;
    }

    private void BroadcastQueue(Live live)
    {
        Broadcast(new JsonObject
        {
            ["type"] = "queue_state",
            ["key"] = live.Conversation.Id,
            ["entries"] = QueueEntries(live),
        });
    }

    /// <summary>
    /// 送一条排队的话给 Pi。一次只送一条，剩下的等下一回合，跟排队时看到的一致。
    /// <paramref name="steering"/> 为真时带 <c>streamingBehavior: "steer"</c>，
    /// Pi 会在下一次调模型前插进去；整轮都结束了才叫（agent_settled）就不带，当作新一轮的起点。
    /// </summary>
    private async Task DeliverQueuedAsync(Live live, bool steering = false)
    {
        QueuedPrompt? next;
        lock (live.Queue)
        {
            if (live.Queue.Count == 0) return;
            next = live.Queue[0];
            live.Queue.RemoveAt(0);
        }

        BroadcastQueue(live);

        var command = new JsonObject { ["type"] = "prompt", ["message"] = next.Text };
        if (steering)
        {
            command["streamingBehavior"] = "steer";
        }
        if (next.Images is not null)
        {
            command["images"] = next.Images.DeepClone();
        }

        try
        {
            if (!steering) SetStreaming(live, true);
            await live.Session.SendAsync(command, TimeSpan.FromSeconds(60));
        }
        catch (Exception error)
        {
            Log.Write($"送出排队消息失败 {live.Conversation.Id}：{error.Message}");
        }
    }

    private async Task SimpleAsync(string id, string command, TimeSpan? timeout = null)
    {
        var live = EnsureLive(RequireConversation(id));
        await live.Session.SendAsync(new JsonObject { ["type"] = command }, timeout ?? TimeSpan.FromSeconds(120));
    }

    /// <summary>
    /// 中止当前这一轮。Pi 正常会秒回；它要是不理人，别跟着 120 秒的通用超时干等——
    /// 把子进程收掉，这一轮就算结束了，界面也能从「运行中」里出来。
    /// </summary>
    /// <summary>
    /// 升级前把在跑的那些收掉：先发 abort 让 Pi 自己收尾（这一轮的输出会落库），
    /// 十几秒还不理人就收子进程——升级要等它，不能无限等下去。
    /// </summary>
    private async Task StopAllForUpgradeAsync(List<Live> running)
    {
        foreach (var live in running)
        {
            live.StopRequested = true;
            try
            {
                await live.Session.SendAsync(new JsonObject { ["type"] = "abort" }, TimeSpan.FromSeconds(5));
            }
            catch (Exception error)
            {
                Log.Write($"升级前中止 {live.Conversation.Id} 没成功：{error.Message}");
            }
        }

        var deadline = DateTimeOffset.UtcNow.AddSeconds(15);
        while (DateTimeOffset.UtcNow < deadline && running.Any(live => live.Streaming))
        {
            await Task.Delay(300).ConfigureAwait(false);
        }

        foreach (var live in running.Where(live => live.Streaming).ToList())
        {
            Log.Write($"升级前 {live.Conversation.Id} 15 秒内没收尾，收掉子进程");
            live.StopRequested = false;
            try
            {
                await live.Session.DisposeAsync();
            }
            catch
            {
                // 已经退了。
            }

            SetStreaming(live, false);
        }

        Log.Write($"升级前停下了 {running.Count} 个正在跑的对话");
    }

    private async Task AbortAsync(string id, CenterConnection sender)
    {
        var live = EnsureLive(RequireConversation(id));
        live.StopRequested = true;

        try
        {
            await live.Session.SendAsync(new JsonObject { ["type"] = "abort" }, TimeSpan.FromSeconds(5));
            // 成功路径也留一条：出「按了停止没反应」的时候，得能判断 abort 到底发没发到 Pi。
            Log.Write($"中止 {id}：Pi 已接受，等它收尾");
            return;
        }
        catch (Exception error)
        {
            Log.Write($"中止 {id} 没成功：{error.Message}，收掉子进程");
        }

        live.StopRequested = false;
        try
        {
            await live.Session.DisposeAsync();
        }
        catch
        {
            // 已经没了。
        }

        SetStreaming(live, false);
        sender.Send(new JsonObject
        {
            ["type"] = "notice",
            ["kind"] = "warning",
            ["text"] = "Pi 没响应中止请求，这一轮已经强制结束。",
        });
        SendState(id, sender);
    }

    private async Task SetModelAsync(string id, JsonObject message, CenterConnection sender)
    {
        var live = EnsureLive(RequireConversation(id));
        await live.Session.SendAsync(new JsonObject
        {
            ["type"] = "set_model",
            ["provider"] = message["provider"]?.GetValue<string>(),
            ["modelId"] = message["modelId"]?.GetValue<string>(),
        });
        await CaptureSettingsAsync(live);
        RememberRecentModel(
            message["provider"]?.GetValue<string>() ?? string.Empty,
            message["modelId"]?.GetValue<string>() ?? string.Empty);
        sender.Send(Settings(RequireConversation(id)));
    }

    /// <summary>
    /// 最近用过的模型，最近的在最前，最多 <see cref="RecentModelLimit"/> 个。
    /// 面板左栏第一项「常用」就是它：常在三四个模型之间来回切，没有这份短名单每次都得翻半天。
    /// 选过的重复选只往前挪、不占新位置；存 settings 所以桌面和手机看到的是同一份。
    /// </summary>
    private JsonArray RecentModels()
    {
        return Parse(_store.GetSetting("recentModels"))?["models"] as JsonArray ?? new JsonArray();
    }

    private void RememberRecentModel(string provider, string modelId)
    {
        if (string.IsNullOrWhiteSpace(modelId)) return;

        var next = new JsonArray
        {
            new JsonObject { ["provider"] = provider, ["id"] = modelId },
        };
        foreach (var node in RecentModels())
        {
            if (next.Count >= RecentModelLimit) break;
            if (node is not JsonObject item) continue;
            if (item["id"]?.GetValue<string>() == modelId
                && (item["provider"]?.GetValue<string>() ?? string.Empty) == provider)
            {
                continue;   // 已经在名单里：这次只是回到最前面，不重复占位。
            }

            next.Add(item.DeepClone());
        }

        _store.SetSetting("recentModels", new JsonObject { ["models"] = next }.ToJsonString());

        // 这份名单是全局的：别的对话、别的设备开着的面板也要立刻看到新顺序。
        // 不带 key，前端当全局数据处理——按对话各存一份的话，两边就会各说各的。
        Broadcast(new JsonObject
        {
            ["type"] = "recent_models",
            ["items"] = next.DeepClone(),
        });
    }

    private async Task SetThinkingAsync(string id, JsonObject message, CenterConnection sender)
    {
        var live = EnsureLive(RequireConversation(id));
        await live.Session.SendAsync(new JsonObject
        {
            ["type"] = "set_thinking_level",
            ["level"] = message["level"]?.GetValue<string>(),
        });
        await CaptureSettingsAsync(live);
        sender.Send(Settings(RequireConversation(id)));
    }

    /// <summary>模型与思考等级是对话自己的设置，改了立刻记下来，下次打开还对得上。</summary>
    private async Task CaptureSettingsAsync(Live live)
    {
        var state = await live.Session.SendAsync(new JsonObject { ["type"] = "get_state" });
        var data = Data(state);
        _store.SaveTurn(live.Conversation.Id, null, null, data);
        RememberLastSettings(data);
    }

    /// <summary>
    /// 记下这台机器上「上次用的模型与思考等级」，新建对话时沿用。
    /// 存 settings 而不是挑最近那条对话：删掉对话后还能记住他上次选的是什么。
    /// </summary>
    /// <summary>
    /// 新对话沿用上次用的模型与思考等级。
    /// 不这么做的话 Pi 那边用它自己的默认，界面又回落到等级列表第一条（通常是 low），
    /// 用户看到的就是「每次新建都变回 low」。
    /// </summary>
    private void InheritLastSettings(Conversation conversation)
    {
        var state = new JsonObject();
        if (Parse(_store.GetSetting("lastModel")) is JsonObject model)
        {
            state["model"] = model.DeepClone();
        }

        if (_store.GetSetting("lastThinkingLevel") is { Length: > 0 } level)
        {
            state["thinkingLevel"] = level;
        }

        if (state.Count == 0) return;
        _store.SaveTurn(conversation.Id, null, null, state);
    }

    /// <summary>
    /// 新起的 Pi 子进程用它自己的配置（模型、思考等级都是 Pi 的默认），
    /// 而界面显示的是对话库里记的——不推过去就是「看到 A、实际跑 B」。
    /// 每个子进程只推一次；推不动（模型被删了之类）只记日志，不拦着用户说话。
    /// </summary>
    private async Task ApplyStoredSettingsAsync(Live live)
    {
        if (live.SettingsApplied) return;
        live.SettingsApplied = true;

        var conversation = _store.Get(live.Conversation.Id) ?? live.Conversation;
        try
        {
            if (Parse(conversation.Model) is JsonObject model
                && model["id"]?.GetValue<string>() is { Length: > 0 } modelId)
            {
                var command = new JsonObject
                {
                    ["type"] = "set_model",
                    ["modelId"] = modelId,
                };
                if (model["provider"]?.GetValue<string>() is { Length: > 0 } provider)
                {
                    command["provider"] = provider;
                }
                await live.Session.SendAsync(command);
            }

            if (!string.IsNullOrEmpty(conversation.ThinkingLevel))
            {
                await live.Session.SendAsync(new JsonObject
                {
                    ["type"] = "set_thinking_level",
                    ["level"] = conversation.ThinkingLevel,
                });
            }
        }
        catch (Exception error)
        {
            Log.Write($"按对话设置初始化 Pi 失败（{conversation.Id}）：{error.Message}");
        }
    }
    private void RememberLastSettings(JsonObject? state)
    {
        if (state?["model"] is JsonObject model)
        {
            _store.SetSetting("lastModel", model.ToJsonString());
        }

        if (state?["thinkingLevel"]?.GetValue<string>() is { Length: > 0 } level)
        {
            _store.SetSetting("lastThinkingLevel", level);
        }
    }

    /// <summary>「常用」最多摆几个，超出去的从末尾挤掉。</summary>
    private const int RecentModelLimit = 7;

    private async Task SendModelsAsync(string id, CenterConnection sender, bool force = false)
    {
        RequireConversation(id);

        // 模型列表跟对话无关，缓存起来：只为看一眼历史不该起 Pi 进程。
        // 缓存要能过期：Pi 那边删掉或改名一个模型，这里不刷新就会一直显示老清单。
        var cachedModels = Parse(_store.GetSetting("models"));
        var cachedLevels = Parse(_store.GetSetting("thinkingLevels"));
        var cachedAt = long.TryParse(_store.GetSetting("modelsAt"), out var stamp) ? stamp : 0;
        var age = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - cachedAt;
        var fresh = cachedModels is not null && cachedLevels is not null && !force && age < ModelsTtlMs;
        if (fresh)
        {
            sender.Send(new JsonObject
            {
                ["type"] = "models",
                ["key"] = id,
                ["data"] = cachedModels!.DeepClone(),
                ["thinkingLevels"] = cachedLevels!.DeepClone(),
                ["recent"] = RecentModels().DeepClone(),
            });
            return;
        }

        var live = EnsureLive(RequireConversation(id));
        var models = await live.Session.SendAsync(new JsonObject { ["type"] = "get_available_models" });
        var levels = await live.Session.SendAsync(new JsonObject { ["type"] = "get_available_thinking_levels" });
        var modelData = Data(models);
        var levelData = Data(levels);

        if (modelData is not null && levelData is not null)
        {
            _store.SetSetting("models", modelData.ToJsonString());
            _store.SetSetting("thinkingLevels", levelData.ToJsonString());
            _store.SetSetting("modelsAt", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString());
        }

        sender.Send(new JsonObject
        {
            ["type"] = "models",
            ["key"] = id,
            ["recent"] = RecentModels().DeepClone(),
            ["data"] = modelData?.DeepClone(),
            ["thinkingLevels"] = levelData?.DeepClone(),
        });
    }

    private void RespondToExtension(string id, JsonObject message)
    {
        Live live;
        lock (_gate)
        {
            if (!_live.TryGetValue(id, out live!))
            {
                return;
            }
        }

        var response = new JsonObject
        {
            ["type"] = "extension_ui_response",
            ["id"] = message["id"]?.GetValue<string>(),
        };

        if (message["cancelled"]?.GetValue<bool>() == true)
        {
            response["cancelled"] = true;
        }
        else if (message.ContainsKey("confirmed"))
        {
            response["confirmed"] = message["confirmed"]?.GetValue<bool>() ?? false;
        }
        else
        {
            response["value"] = message["value"]?.DeepClone();
        }

        live.Session.SendNoReply(response);
    }

    /// <summary>
    /// 每 60 秒看一眼：在跑的会话如果一直收不到 Pi 的事件，就把「多久没动静」写进日志。
    /// 只记不改状态——Pi 可能真的卡在一个长命令里，替他判死会把消息丢在半路；
    /// 界面那边会把这个时长显示出来，用户自己能看出是卡住了。
    /// </summary>
    private void WatchQuietSessions()
    {
        var now = DateTimeOffset.UtcNow;
        List<Live> running;
        lock (_gate)
        {
            running = _live.Values.Where(live => live.Streaming).ToList();
        }

        foreach (var live in running)
        {
            var quiet = now - live.LastEventAt;
            if (quiet < TimeSpan.FromMinutes(5)) continue;
            if (now - live.QuietLoggedAt < TimeSpan.FromMinutes(10)) continue;

            live.QuietLoggedAt = now;
            Log.Write($"对话 {live.Conversation.Id} 已经 {Math.Round(quiet.TotalMinutes)} 分钟没收到 Pi 的事件（streaming=true）");
        }
    }

    public async Task ShutdownAsync()
    {
        _quietTimer?.Dispose();
        _quietTimer = null;

        // 先断开所有客户端：宿主关闭要等连接收尾，客户端还挂着进程就退不出去，
        // 服务会停在「停止中」，Control 的重启那一步就等到超时（以前就是这么卡住的）。
        CenterConnection[] clients;
        lock (_gate)
        {
            clients = _clients.ToArray();
            _clients.Clear();
        }

        foreach (var client in clients)
        {
            client.Abort();
        }

        Live[] entries;
        lock (_gate)
        {
            entries = _live.Values.ToArray();
            _live.Clear();
        }

        foreach (var entry in entries)
        {
            await entry.Session.DisposeAsync();
        }

        TerminalSession[] terminals;
        lock (_terminalGate)
        {
            terminals = _terminals.Values.ToArray();
            _terminals.Clear();
        }

        foreach (var terminal in terminals)
        {
            terminal.Dispose();
        }
    }

    /* ------------------------------------------------------------------ *
     * 终端：每条对话一个常驻 shell，多端看到的是同一份输出
     * ------------------------------------------------------------------ */

    private void StartTerminal(string id, CenterConnection sender)
    {
        var conversation = RequireConversation(id);
        var terminal = EnsureTerminal(conversation);

        sender.Send(new JsonObject
        {
            ["type"] = "terminal_state",
            ["key"] = id,
            ["running"] = terminal.Running,
            ["cwd"] = terminal.Cwd,
            ["shell"] = terminal.ShellName,
        });

        // 另一个设备先开过，就把已经跑出来的输出补上。
        var tail = terminal.Tail;
        if (tail.Length > 0)
        {
            sender.Send(new JsonObject
            {
                ["type"] = "terminal_output",
                ["key"] = id,
                ["text"] = tail,
                ["replay"] = true,
            });
        }
    }

    private void WriteTerminal(string id, JsonObject message)
    {
        var conversation = RequireConversation(id);
        var line = message["text"]?.GetValue<string>() ?? string.Empty;
        var terminal = EnsureTerminal(conversation);
        terminal.Write(line);
    }

    private void StopTerminal(string id, CenterConnection sender)
    {
        StopTerminalInternal(id);
        sender.Send(new JsonObject
        {
            ["type"] = "terminal_state",
            ["key"] = id,
            ["running"] = false,
        });
    }

    private void StopTerminalInternal(string id)
    {
        TerminalSession? terminal;
        lock (_terminalGate)
        {
            _terminals.Remove(id, out terminal);
        }

        terminal?.Dispose();
    }

    private TerminalSession EnsureTerminal(Conversation conversation)
    {
        lock (_terminalGate)
        {
            if (_terminals.TryGetValue(conversation.Id, out var existing) && existing.Running)
            {
                return existing;
            }
        }

        var terminal = new TerminalSession(
            conversation.Cwd,
            onOutput: (text) => Broadcast(new JsonObject
            {
                ["type"] = "terminal_output",
                ["key"] = conversation.Id,
                ["text"] = text,
            }),
            onExit: (code) =>
            {
                lock (_terminalGate)
                {
                    _terminals.Remove(conversation.Id);
                }

                Broadcast(new JsonObject
                {
                    ["type"] = "terminal_exit",
                    ["key"] = conversation.Id,
                    ["code"] = code,
                });
            });

        lock (_terminalGate)
        {
            _terminals[conversation.Id] = terminal;
        }

        return terminal;
    }

    private static JsonNode? ParseNode(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(json);
        }
        catch
        {
            return null;
        }
    }

    private static JsonObject? Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(json) as JsonObject;
        }
        catch
        {
            return null;
        }
    }

    private static JsonObject? Data(JsonObject response)
    {
        if (response["success"]?.GetValue<bool>() != true)
        {
            throw new InvalidOperationException(
                response["error"]?.GetValue<string>() ?? "Pi 拒绝了这条命令。");
        }

        return response["data"] as JsonObject;
    }
}
