using System.Net.WebSockets;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Net.NetworkInformation;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Hosting.WindowsServices;
using SevenStation.Core;
using SevenStation.Core.Storage;
using SevenStation.Shared;

[assembly: SupportedOSPlatform("windows")]

// 同一个 exe 两个角色：带 --runner 就是用户会话里的执行代理，只负责起 Pi、转它的 stdio。
// 服务账户起的进程落在 Session 0，用户 PATH、凭据、窗口站全都没有，Pi 只能由登录会话里的代理来起。
if (args.Contains("--runner"))
{
    Environment.Exit(SevenStation.Core.Runner.RunnerHost.Run());
}

var runningAsService = WindowsServiceHelpers.IsWindowsService();
Log.Initialize(ProductPaths.CoreLogs, "center.log");

// 交互式启动要求管理员：改监听、动防火墙、重启服务都要它。不给 UAC 就不启动。
// 服务角色本来就是 SYSTEM，不用；测试用临时目录（SEVENSTATION_CORE_HOME / _DATA_DIR）也放行，
// 不然开发时每次都要过一遍 UAC。
var sandbox = !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("SEVENSTATION_CORE_HOME"))
    || !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("SEVENSTATION_DATA_DIR"));
if (!runningAsService && !sandbox && !args.Contains("--elevated") && !Elevation.IsElevated)
{
    Log.Write("不是管理员，重新以管理员身份启动");
    if (!Elevation.Relaunch())
    {
        Log.Write("没拿到管理员权限，退出");
        Environment.Exit(1);
    }

    Environment.Exit(0);
}
Log.Write($"启动（{(runningAsService ? "Windows 服务" : "Seven Station Control")}），目录 {ProductPaths.CoreHome}，" +
    $"管理员权限 {Elevation.IsElevated}");

MigrateLegacyData();

// 配置里没有的 Agent 在装载时就探测补齐：安装程序不问 Pi 在哪，第一次启动自己找。
var settings = CoreSettings.LoadOrInitialize(ProductPaths.CoreSettingsFile);
var listen = Environment.GetEnvironmentVariable("SEVENSTATION_LISTEN") ?? settings.Listen;
var token = TokenStore.Resolve();

// 静态页永远跟着 exe 走：不管从哪个目录启动，都能找到 wwwroot。
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory,
});
// 被 SCM 拉起时换成服务宿主；Seven Station Control 直接跑时什么也不做。
builder.Host.UseWindowsService();
builder.WebHost.UseUrls(listen);
// 日志写自己的文件，Seven Station Control 只留启动那几行，免得被 ASP.NET 默认日志淹掉。
builder.Logging.ClearProviders();
builder.Logging.AddProvider(new FileLoggerProvider());

var app = builder.Build();

var store = new ConversationStore(Path.Combine(ProductPaths.CoreDataDirectory, "sevenstation.db"));
Log.Write($"对话库：{store.DatabasePath}");
var devices = new DeviceStore(store.DatabasePath);
var hub = new CenterHub(store, listen);

app.UseWebSockets();
app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    // 前端是跟着 Seven Station Core 一起更新的，客户端不能拿着旧缓存跑：每次都要回 Seven Station Core 确认。
    OnPrepareResponse = context =>
        context.Context.Response.Headers.CacheControl = "no-cache, must-revalidate",
});

app.Map("/ws", async (HttpContext context) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    if (!TokenStore.Matches(context, token) && devices.Match(TokenStore.Provided(context)) is null)
    {
        Log.Write("拒绝了一个令牌不匹配的连接");
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return;
    }

    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    var connection = new CenterConnection(socket, hub);
    await connection.RunAsync(context.RequestAborted);
});

// 管理接口只认主令牌：设备令牌能看对话，但不能给自己再发一个。
bool Admin(HttpContext context) => TokenStore.Matches(context, token);

var port = new Uri(listen).Port;

app.MapGet("/api/addresses", (HttpContext context) =>
    Admin(context)
        ? Results.Json(new { port, addresses = DeviceStore.Addresses(port) })
        : Results.StatusCode(StatusCodes.Status401Unauthorized));

app.MapGet("/api/devices", (HttpContext context) =>
    Admin(context)
        ? Results.Json(new { devices = devices.List() })
        : Results.StatusCode(StatusCodes.Status401Unauthorized));

app.MapPost("/api/devices", async (HttpContext context) =>
{
    if (!Admin(context)) return Results.StatusCode(StatusCodes.Status401Unauthorized);

    string? name = null;
    try
    {
        var body = await JsonNode.ParseAsync(context.Request.Body);
        name = body?["name"]?.GetValue<string>();
    }
    catch
    {
        // 没带 body 就用默认名字。
    }

    var device = devices.Add(name ?? string.Empty);
    Log.Write($"新增设备 {device["name"]}（{device["id"]}）");
    return Results.Json(new { device });
});

app.MapPost("/api/devices/{id}/revoke", (HttpContext context, string id) =>
{
    if (!Admin(context)) return Results.StatusCode(StatusCodes.Status401Unauthorized);

    devices.Revoke(id);
    Log.Write($"移除设备 {id}");
    return Results.Json(new { revoked = id });
});

/// <summary>
/// 把一段文字画成二维码（SVG）。Control 拿它直接塞进页面，自己不用引二维码库，
/// Control 那边也就不必处理二进制响应。
/// </summary>
// 执行代理的状态：Pi 只在用户登录会话里跑，这里告诉界面连没连上。
app.MapGet("/api/runner", (HttpContext context) =>
    Admin(context)
        ? Results.Json(new
        {
            connected = SevenStation.Core.Rpc.RunnerClient.Probe(),
            pipe = SevenStation.Core.Rpc.RunnerClient.PipeName,
            log = System.IO.Path.Combine(SevenStation.Shared.ProductPaths.ClientHome, "logs", "runner.log"),
        })
        : Results.StatusCode(StatusCodes.Status401Unauthorized));

app.MapGet("/api/qr", (HttpContext context, string? data) =>
{
    if (!Admin(context)) return Results.StatusCode(StatusCodes.Status401Unauthorized);
    if (string.IsNullOrWhiteSpace(data)) return Results.StatusCode(StatusCodes.Status400BadRequest);

    using var generator = new QRCoder.QRCodeGenerator();
    using var code = generator.CreateQrCode(data, QRCoder.QRCodeGenerator.ECCLevel.M);
    var svg = new QRCoder.SvgQRCode(code).GetGraphic(4);
    return Results.Content(svg, "image/svg+xml");
});

app.MapGet("/health", () => Results.Json(new
{
    status = "ok",
    database = store.DatabasePath,
}));

app.Lifetime.ApplicationStopping.Register(() =>
{
    // 收尾要有上限：Pi 子进程或哪条连接不理人时，不能让服务卡在「停止中」等 SCM 强杀。
    var shutdown = hub.ShutdownAsync();
    if (!shutdown.Wait(TimeSpan.FromSeconds(10)))
    {
        Log.Write("收尾超过 10 秒，先退出去");
    }

    store.Dispose();
    Log.Write("Seven Station Core 停止");
});

Log.Write($"Seven Station Core 启动 {listen}，对话库 {store.DatabasePath}");
if (!runningAsService)
{
    Console.WriteLine($"SevenStation.Core 已启动：{listen}");
    Console.WriteLine($"打开地址：{listen.TrimEnd('/')}/");
    Console.WriteLine($"访问令牌：见 {TokenStore.FilePath}（桌面客户端会自动读取；手机用 ?token= 拼在地址后）");
}

app.Run();

/// <summary>
/// 0.3.0 之前 Seven Station Core 和客户端共用 <c>%LOCALAPPDATA%\SevenStation</c>。按 D7 拆开后 Seven Station Core 搬到
/// <c>%ProgramData%\SevenStation.Core</c>，老库与老令牌复制一次过去，别让用户丢历史。
/// </summary>
static void MigrateLegacyData()
{
    var legacy = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "SevenStation");

    var target = Path.Combine(ProductPaths.CoreDataDirectory, "sevenstation.db");
    var source = Path.Combine(legacy, "data", "sevenstation.db");
    if (!File.Exists(target) && File.Exists(source))
    {
        Directory.CreateDirectory(ProductPaths.CoreDataDirectory);
        foreach (var suffix in new[] { string.Empty, "-wal", "-shm" })
        {
            var from = source + suffix;
            if (File.Exists(from))
            {
                File.Copy(from, target + suffix);
            }
        }

        Log.Write($"把老的对话库搬到 {target}");
    }

    if (!File.Exists(ProductPaths.CoreTokenFile))
    {
        var oldToken = Path.Combine(legacy, "token.txt");
        if (File.Exists(oldToken))
        {
            Directory.CreateDirectory(ProductPaths.CoreHome);
            File.Copy(oldToken, ProductPaths.CoreTokenFile);
            Log.Write($"把老的访问令牌搬到 {ProductPaths.CoreTokenFile}");
        }
    }
}

internal static class TokenStore
{
    public static string FilePath => ProductPaths.CoreTokenFile;

    public static string Resolve()
    {
        var fromEnvironment = Environment.GetEnvironmentVariable("SEVENSTATION_TOKEN");
        if (!string.IsNullOrWhiteSpace(fromEnvironment))
        {
            return fromEnvironment.Trim();
        }

        if (File.Exists(FilePath))
        {
            var existing = File.ReadAllText(FilePath).Trim();
            if (existing.Length >= 16)
            {
                return existing;
            }
        }

        var generated = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        File.WriteAllText(FilePath, generated);
        Log.Write($"生成了新的访问令牌，写在 {FilePath}");
        return generated;
    }

    /// <summary>请求里带的令牌：<c>?token=</c> 或 <c>Authorization: Bearer</c>。</summary>
    public static string Provided(HttpContext context)
    {
        var provided = context.Request.Query["token"].ToString();
        if (string.IsNullOrEmpty(provided))
        {
            var header = context.Request.Headers.Authorization.ToString();
            const string prefix = "Bearer ";
            if (header.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                provided = header[prefix.Length..].Trim();
            }
        }

        return provided;
    }

    /// <summary>跟主令牌比，长度先比再定长比，避免按字节泄露时间差。</summary>
    public static bool Matches(HttpContext context, string expected)
    {
        var provided = Provided(context);
        if (string.IsNullOrEmpty(provided))
        {
            return false;
        }

        var a = Encoding.UTF8.GetBytes(provided);
        var b = Encoding.UTF8.GetBytes(expected);
        return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
    }
}
