//! 执行代理：让 Pi 在用户登录的桌面会话里跑。
//!
//! 服务账户起 Pi 会落在 Session 0，环境、凭据、窗口站都不对；执行代理就是 Seven Station Core
//! 的另一个角色（同一个 exe 加 `--runner`），待在登录会话里替核心起 Pi。
//!
//! 用计划任务把它挂起来，不是图省事：任务用 `InteractiveToken` + `LeastPrivilege` 跑，
//! 所以代理拿到的是**普通（非提权）令牌**——不能让 Pi 继承 Seven Station Control 的管理员身份。
//! 任务 XML 带 Principal，非提权建不了（会报「拒绝访问」），所以 Control 现在就要求管理员启动。

/// 计划任务名。核心那边按同名字查询状态，两边要一致。
pub const TASK: &str = "SevenStation Core Runner";

/// Run 键里那一项的名字。
pub const VALUE: &str = "SevenStation Core Runner";

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

/// 再写一份 Run 键：登录时它比计划任务快得多（任务要给调度器排期，实测差十秒）。
/// 两个都起也没关系——第二个占不到管道会自己退出。
pub fn ensure_autostart(exe: &std::path::Path) -> Result<(), String> {
    let command = format!("\"{}\" --runner", exe.display());
    let (code, text) = run(
        "reg.exe",
        &["add", RUN_KEY, "/v", VALUE, "/t", "REG_SZ", "/d", &command, "/f"],
    );

    if code != 0 {
        return Err(format!("写不了开机启动项：{}", text.trim()));
    }

    Ok(())
}

/// 登录任务在不在。查询不需要管理员。
pub fn registered() -> bool {
    run("schtasks.exe", &["/query", "/tn", TASK]).0 == 0
}

/// 建（或更新）任务并立刻让它跑起来。需要管理员。
pub fn register(exe: &std::path::Path) -> Result<String, String> {
    let user = whoami()?;
    let xml = task_xml(&user, exe);
    let path = std::env::temp_dir().join("sevenstation-runner-task.xml");

    // 任务计划程序只认 Unicode：UTF-16LE 带 BOM，写成 UTF-8 会报「XML 格式不正确」。
    std::fs::write(&path, utf16le(&xml))
        .map_err(|error| format!("写不了任务描述文件：{error}"))?;

    let create = run(
        "schtasks.exe",
        &["/create", "/tn", TASK, "/xml", &path.to_string_lossy(), "/f"],
    );
    let _ = std::fs::remove_file(&path);

    if create.0 != 0 {
        return Err(format!("建不了执行代理的登录任务：{}", create.1.trim()));
    }

    let started = run("schtasks.exe", &["/run", "/tn", TASK]);
    if started.0 != 0 {
        // 用户没登录桌面时这里本来就会失败，不算致命。
        return Ok(format!("任务已注册（{user}），现在没拉起来：{}", started.1.trim()));
    }

    Ok(format!("任务已注册并启动（{user}）"))
}

/// 叫任务跑一次。任务是当前用户的，触发它不需要管理员；用户没登录时会失败。
pub fn run_now() -> Result<(), String> {
    let (code, text) = run("schtasks.exe", &["/run", "/tn", TASK]);
    if code != 0 {
        return Err(text.trim().to_string());
    }

    Ok(())
}

/// 收掉正在跑的代理。任务本身还在，下次登录或 `/run` 还会起来。
pub fn end() {
    // 没在跑时这条会失败，正常。
    run("schtasks.exe", &["/end", "/tn", TASK]);
}

fn whoami() -> Result<String, String> {
    let (code, text) = run("whoami.exe", &[]);
    if code != 0 || text.trim().is_empty() {
        return Err("认不出当前用户，建不了执行代理的登录任务。".into());
    }

    Ok(text.trim().to_string())
}

fn task_xml(user: &str, exe: &std::path::Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>让 Pi 在登录的桌面会话里运行（Seven Station Core 通过它起 Pi）。</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
      <Arguments>--runner</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        user = escape(user),
        exe = escape(&exe.to_string_lossy())
    )
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn utf16le(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

fn run(exe: &str, args: &[&str]) -> (i32, String) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut command = std::process::Command::new(exe);
    command
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);

    match command.output() {
        Ok(output) => {
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            (output.status.code().unwrap_or(-1), text)
        }
        Err(_) => (-1, String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::{task_xml, utf16le, TASK};
    use std::path::Path;

    #[test]
    fn xml_points_at_the_runner_role() {
        let xml = task_xml(
            "PC-alice",
            Path::new(r"C:\Program Files\SevenStation Core\SevenStation.Core.exe"),
        );
        assert!(xml.contains("<Arguments>--runner</Arguments>"));
        // 代理必须是普通权限：不能让 Pi 继承管理员身份。
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        // 代理要长期挂着，不能被计划任务三天后收掉。
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(xml.contains("SevenStation.Core.exe"));
        assert_eq!(TASK, "SevenStation Core Runner");
    }

    #[test]
    fn escapes_xml_specials() {
        let xml = task_xml("PC-a&b", Path::new(r"C:\A & B\x.exe"));
        assert!(xml.contains("a&amp;b"));
        assert!(xml.contains("A &amp; B"));
        assert!(!xml.contains("A & B"));
    }

    #[test]
    fn writes_utf16_with_bom() {
        let bytes = utf16le("abc");
        assert_eq!(&bytes[..2], &[0xFF, 0xFE]);
        assert_eq!(bytes.len(), 2 + 3 * 2);
        assert_eq!(&bytes[2..4], &[b'a', 0]);
    }
}
