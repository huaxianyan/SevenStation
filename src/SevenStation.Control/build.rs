fn main() {
    // 自己定义的命令要写进清单，能力表里才允许页面调用。
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "read_state",
            "set_pi_dir",
            "control",
            "set_autostart",
            "set_lan",
            "regenerate_token",
            "copy_text",
            "open_target",
            "runner_restart",
            "core_api",
        ]),
    );
    tauri_build::try_build(attributes).expect("tauri 构建脚本失败");
}
