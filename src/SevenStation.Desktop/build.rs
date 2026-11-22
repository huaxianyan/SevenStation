fn main() {
    // 自己定义的命令要写进清单，能力表里才允许页面调用。
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["pick_folder", "reveal_path", "reveal_in_explorer", "copy_file", "open_url", "center_local", "client_config_get", "client_config_save"]),
    );
    tauri_build::try_build(attributes).expect("tauri 构建脚本失败");
}
