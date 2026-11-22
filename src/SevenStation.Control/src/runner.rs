//! 执行代理：让 Pi 在用户登录的桌面会话里跑。
//!
//! 服务账户起 Pi 会落在 Session 0，环境、凭据、窗口站都不对；执行代理就是 Seven Station Core
//! 的另一个角色（同一个 exe 加 `--runner`），待在登录会话里替核心起 Pi。
//!
//! 挂法用的是 HKCU 的 Run 键：不需要管理员、没有计划任务那个「跑满三天就被收掉」的限制，
//! 而且计划任务带 Principal 时非提权根本建不了（报「拒绝访问」）。

use std::os::windows::process::CommandExt;
use std::path::Path;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;

/// Run 键里那一项的名字。
pub const VALUE: &str = "SevenStation Core Runner";

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

/// 把「登录时启动执行代理」写进 Run 键。写自己家的键不需要管理员。
pub fn ensure_autostart(exe: &Path) -> Result<(), String> {
    let command = format!("\"{}\" --runner", exe.display());
    let (code, text) = run(
        "reg.exe",
        &[
            "add", RUN_KEY, "/v", VALUE, "/t", "REG_SZ", "/d", &command, "/f",
        ],
    );

    if code != 0 {
        return Err(format!("写不了开机启动项：{}", text.trim()));
    }

    Ok(())
}

/// 现在就把代理拉起来。已经在跑的话，新的那个会因为占不到管道自己退出，所以可以随手调。
pub fn spawn(exe: &Path) -> Result<(), String> {
    let mut command = std::process::Command::new(exe);
    command
        .arg("--runner")
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);

    match command.spawn() {
        Ok(_) => Ok(()),
        Err(error) => Err(format!("起不来执行代理：{error}")),
    }
}

/// 收掉正在跑的代理。按命令行里的 `--runner` 认人——服务用的是同一个 exe，
/// 只按进程名会连服务一起杀掉。
pub fn stop() -> usize {
    let script = r#"Get-CimInstance Win32_Process -Filter "Name='SevenStation.Core.exe'" | Where-Object { $_.CommandLine -like '*--runner*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }"#;
    let (_, text) = run("powershell.exe", &["-NoProfile", "-Command", script]);

    text.lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .count()
}

/// 重启：先收掉旧的，等一下让它把管道让出来，再起一个新的。
pub fn restart(exe: &Path) -> Result<String, String> {
    let stopped = stop();
    std::thread::sleep(std::time::Duration::from_millis(600));
    spawn(exe)?;

    Ok(if stopped > 0 {
        "已重新启动执行代理。".into()
    } else {
        "执行代理起来了。".into()
    })
}

fn run(exe: &str, args: &[&str]) -> (i32, String) {
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
    use super::VALUE;

    #[test]
    fn autostart_value_name_is_stable() {
        // 卸载/排查时靠这个名字找，别随手改。
        assert_eq!(VALUE, "SevenStation Core Runner");
    }
}
