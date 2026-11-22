using System.Collections.Generic;
using System.IO;

namespace SevenStation.Core.Rpc;

/// <summary>起一个 Pi 要的全部信息。核心这边算好，执行代理那边只照着跑。</summary>
internal sealed record PiCommand(
    string Exe,
    IReadOnlyList<string> Arguments,
    IReadOnlyDictionary<string, string> Environment);
