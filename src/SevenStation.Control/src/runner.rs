//! 执行代理的登录任务。
//!
//! Pi 现在只能由用户登录会话里的进程起（服务账户起的话环境、凭据、窗口站都不对）。
//! 那个「执行代理」就是 Seven Station Core 的另一个角色：同一个 exe 加 `--runner`。
//! 这里负责在自己的登录会话里把它挂起来——建任务这一步必须由用户这边做，
//! 服务账户是建不了「跟着这个用户登录跑」的任务的。

/// 计划任务名。核心那边按同名字查询状态，两边要一致。
pub const TASK: &str = "SevenStation Core Runner";

/// 建（或更新）任务并立刻让它跑起来。每次启动都调一遍：
/// 升级后 exe 路径没变也能顺手把参数刷新一次，任务不在就补上。
pub fn ensure(exe: &std::path::Path) -> Result<String, String> {
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

    // 建好就顺手拉起来，用户不用为这件事注销重登。
    let started = run("schtasks.exe", &["/run", "/tn", TASK]);
    if started.0 != 0 {
        // 没登录桌面时这里本来就会失败，不算致命。
        return Ok(format!("任务已注册（{user}），现在没拉起来：{}", started.1.trim()));
    }

    Ok(format!("任务已注册并启动（{user}）"))
}

fn whoami() -> Result<String, String> {
    let (code, text) = run("whoami.exe", &[]);
    if code != 0 || text.trim().is_empty() {
        return Err("认不出当前用户，建不了执行代理的登录任务。".into());
    }

    Ok(text.trim().to_string())
}

fn task_xml(user: &str, exe: &std::path::Path) -> String {
    let exe = escape(&exe.to_string_lossy());
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
        exe = exe
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
        let xml = task_xml("PC-alice", Path::new(r"C:\Program Files\SevenStation Core\SevenStation.Core.exe"));
        assert!(xml.contains("<Arguments>--runner</Arguments>"));
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(xml.contains("SevenStation.Core.exe"));
        // 代理要长期挂着，不能被计划任务三天后收掉。
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(xml.contains("alice"));
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
