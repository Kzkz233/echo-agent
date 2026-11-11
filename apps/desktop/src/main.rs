#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod auth;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{
    Manager, State, WebviewUrl, WebviewWindowBuilder,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

#[derive(Clone, Serialize, Deserialize)]
struct Connection {
    url: String,
    token: String,
    pid: u32,
}
struct Runtime {
    connection: Connection,
    child: Mutex<Option<Child>>,
    quitting: AtomicBool,
}
struct DesktopMenu {
    open: MenuItem<tauri::Wry>,
    pet: MenuItem<tauri::Wry>,
    hide: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}
#[tauri::command]
fn set_language(app: tauri::AppHandle, language: String) -> Result<(), String> {
    let menu = app.state::<DesktopMenu>();
    let labels = if language == "en" {
        ["Open Echo", "Show avatar", "Hide avatar", "Quit Echo"]
    } else {
        ["打开 Echo", "显示桌宠", "收起桌宠", "退出 Echo"]
    };
    for (item, label) in [&menu.open, &menu.pet, &menu.hide, &menu.quit]
        .iter()
        .zip(labels)
    {
        item.set_text(label).map_err(|e| e.to_string())?;
    }
    if let Some(window) = app.get_webview_window("settings") {
        window.set_title(if language == "en" { "Echo · Settings" } else { "Echo · 设置" }).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn rpc(
    connection: &Connection,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    rpc_with_timeout(connection, method, params, Duration::from_secs(5))
}
fn rpc_with_timeout(
    connection: &Connection,
    method: &str,
    params: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;
    let result: serde_json::Value = client
        .post(format!("{}/rpc", connection.url))
        .bearer_auth(&connection.token)
        .json(&serde_json::json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
        .send()
        .map_err(|_| "无法连接本机 Echo".to_string())?
        .json()
        .map_err(|_| "Echo 返回格式错误".to_string())?;
    if let Some(error) = result.get("error") {
        return Err(error.to_string());
    }
    Ok(result["result"].clone())
}
fn read_connection(root: &Path) -> Option<Connection> {
    let location = std::fs::read_to_string(root.join("storage-location.json")).ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| if value["format"] == "echo-storage-v1" { value["path"].as_str().map(PathBuf::from) } else { None });
    let root = location.as_deref().filter(|path| path.is_absolute()).unwrap_or(root);
    let text = std::fs::read_to_string(root.join("connection.json")).ok()?;
    let c: Connection = serde_json::from_str(&text).ok()?;
    if !c.url.starts_with("http://127.0.0.1:") {
        return None;
    }
    if rpc(&c, "system.status", serde_json::json!({})).is_ok() {
        Some(c)
    } else {
        None
    }
}
fn data_directory() -> PathBuf {
    std::env::var_os("ECHO_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or(std::env::temp_dir())
                .join("Echo")
        })
}
fn instance_identifier(directory: &Path) -> String {
    let canonical = directory.canonicalize().unwrap_or_else(|_| directory.to_path_buf());
    let normalized = canonical.to_string_lossy().replace('\\', "/").to_lowercase();
    let normalized = normalized.trim_start_matches("//?/").trim_end_matches('/');
    let hash = normalized.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ byte as u64).wrapping_mul(0x100000001b3));
    format!("app.echo.workbench.d{hash:016x}")
}
fn launch(app: &tauri::AppHandle) -> Result<Runtime, String> {
    let data = data_directory();
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    if let Some(connection) = read_connection(&data) {
        return Ok(Runtime {
            connection,
            child: Mutex::new(None),
            quitting: AtomicBool::new(false),
        });
    }
    let project = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("runtime")
    };
    let node = if cfg!(debug_assertions) {
        PathBuf::from(std::env::var("ECHO_NODE").unwrap_or("node".into()))
    } else {
        project.join("node.exe")
    };
    let helper = if cfg!(debug_assertions) {
        project.join("native/target/release/echo-native.exe")
    } else {
        project.join("echo-native.exe")
    };
    let mut command = Command::new(node);
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    command
        .arg(project.join("dist/server.mjs"))
        .env("ECHO_DATA_DIR", &data)
        .env("ECHO_PROJECT_ROOT", &project)
        .env("ECHO_NATIVE_PATH", helper)
        .env("ECHO_STORAGE_ANCHOR", &data)
        .env("ECHO_INSTALL_DIR", executable.parent().ok_or("Missing install directory")?)
        .env("ECHO_DESKTOP_EXE", &executable)
        .env("ECHO_DESKTOP_PID", std::process::id().to_string())
        .env("ECHO_DESKTOP_BUILD", env!("ECHO_BUILD_INFO"))
        .current_dir(&project)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 Echo 核心：{e}"))?;
    let attempts = if std::env::var("ECHO_UPDATE_TOKEN").unwrap_or_default().is_empty() { 6000 } else { 300 };
    for _ in 0..attempts {
        if let Some(connection) = read_connection(&data) {
            return Ok(Runtime {
                connection,
                child: Mutex::new(Some(child)),
                quitting: AtomicBool::new(false),
            });
        }
        if child.try_wait().ok().flatten().is_some() {
            return Err("Echo 核心未能启动，请检查本机数据目录的实例锁和依赖。".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
    Err("等待 Echo 核心启动超时".into())
}
fn show_main(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        window.show().map_err(|e| e.to_string())?;
        let _ = window.set_focus();
        return Ok(());
    }
    workbench_window(WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::App("index.html".into()),
    ))
    .title("Echo")
    .theme(Some(tauri::Theme::Light))
    .inner_size(1260., 840.)
    .min_inner_size(760., 580.)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn workbench_window<'a>(
    mut builder: WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>,
) -> WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle> {
    // WebView2's native file-drop interception prevents HTML5 task/calendar dragging.
    // The workbench handles both internal moves and attachment drops in the DOM.
    builder = builder.disable_drag_drop_handler();
    // Explicit local development opt-in only. No debug listener in ordinary launches.
    if let Ok(port) = std::env::var("ECHO_WEBVIEW_DEBUG_PORT")
        .unwrap_or_default()
        .parse::<u16>()
    {
        if port > 0 {
            builder = builder.additional_browser_args(&format!(
                "--remote-debugging-address=127.0.0.1 --remote-debugging-port={port}"
            ));
            if let Some(path) = std::env::var_os("ECHO_WEBVIEW_TEST_DIR") {
                builder = builder.data_directory(PathBuf::from(path));
            }
        }
    }
    builder
}
#[tauri::command]
fn connection(state: State<Runtime>) -> Connection {
    state.connection.clone()
}
#[tauri::command]
fn desktop_info() -> Result<serde_json::Value, String> {
    serde_json::from_str(env!("ECHO_BUILD_INFO")).map_err(|e| e.to_string())
}
#[tauri::command]
async fn desktop_ready(state: State<'_, Runtime>, frontend: serde_json::Value) -> Result<(), String> {
    let desktop = desktop_info()?;
    if frontend["buildId"] != desktop["buildId"] || frontend["edition"] != desktop["edition"] {
        return Err("Desktop and frontend builds differ".into());
    }
    let connection = state.connection.clone();
    tauri::async_runtime::spawn_blocking(move || rpc(&connection, "updates.confirm", serde_json::json!({"desktop": desktop})))
        .await.map_err(|e| e.to_string())??;
    Ok(())
}
#[tauri::command]
async fn install_update(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if app.state::<Runtime>().child.lock().map_err(|e| e.to_string())?.is_none() {
        return Err("请完整退出现有 Echo 后重新打开，再执行更新。".into());
    }
    let connection = app.state::<Runtime>().connection.clone();
    tauri::async_runtime::spawn_blocking(move || rpc_with_timeout(&connection, "updates.handoff", serde_json::json!({"id": id}), Duration::from_secs(120)))
        .await.map_err(|e| e.to_string())??;
    app.state::<Runtime>().quitting.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}
#[tauri::command]
fn open_workbench(app: tauri::AppHandle) -> Result<(), String> {
    show_main(&app)
}
#[tauri::command]
async fn open_settings(app: tauri::AppHandle, page: String) -> Result<(), String> {
    if !valid_extension_identifier(&page) {
        return Err("Invalid settings page".into());
    }
    if let Some(window) = app.get_webview_window("settings") {
        window
            .eval(&format!(
                "window.dispatchEvent(new CustomEvent('echo:settings-page',{{detail:'{}'}}))",
                page
            ))
            .map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    workbench_window(WebviewWindowBuilder::new(
        &app,
        "settings",
        WebviewUrl::App(format!("index.html?window=settings&page={}", page).into()),
    ))
    .title("Echo · Settings")
    .theme(Some(tauri::Theme::Light))
    .inner_size(1160., 820.)
    .min_inner_size(760., 580.)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn valid_extension_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 160 && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}
#[cfg(test)]
mod frontend_tests {
    use super::{valid_extension_identifier, instance_identifier};
    #[test]
    fn page_identifiers_allow_namespaces_without_script_or_url_characters() {
        for value in ["plugins", "demo.settings", "role-one_2"] { assert!(valid_extension_identifier(value)); }
        for value in ["", "../page", "page?token=1", "x');alert(1)//"] { assert!(!valid_extension_identifier(value)); }
        assert!(!valid_extension_identifier(&"x".repeat(161)));
    }
    #[test]
    fn separate_data_directories_have_separate_desktop_instance_locks() {
        let a = std::env::temp_dir().join("echo-instance-a");
        let b = std::env::temp_dir().join("echo-instance-b");
        assert_eq!(instance_identifier(&a), instance_identifier(&a));
        assert_ne!(instance_identifier(&a), instance_identifier(&b));
    }
}
#[tauri::command]
async fn open_extension_window(app: tauri::AppHandle, page: String, persona_id: Option<String>) -> Result<(), String> {
    use std::hash::{DefaultHasher, Hash, Hasher};
    if !valid_extension_identifier(&page) || !page.contains('.') || persona_id.as_ref().is_some_and(|id| !valid_extension_identifier(id)) {
        return Err("Invalid extension page".into());
    }
    let state = app.state::<Runtime>();
    let pages = rpc(&state.connection, "frontend.pages", serde_json::json!({}))?;
    let entry = pages.as_array().and_then(|rows| rows.iter().find(|row| row["id"] == page)).ok_or("Extension page is unavailable")?;
    let mut hash = DefaultHasher::new();
    (&page, &persona_id).hash(&mut hash);
    let label = format!("extension-{:x}", hash.finish());
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }
    let url = format!("index.html?window=extension&page={}{}", page, persona_id.map(|id| format!("&persona={}", id)).unwrap_or_default());
    workbench_window(WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into())))
        .title(format!("Echo · {}", entry["title"].as_str().unwrap_or("Plugin")))
        .theme(Some(tauri::Theme::Light)).inner_size(1000., 760.).min_inner_size(600., 420.)
        .build().map_err(|e| e.to_string())?;
    Ok(())
}
fn persist_avatar(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<Runtime>();
    let bootstrap = rpc(&state.connection, "system.bootstrap", serde_json::json!({}))?;
    if enabled
        && !bootstrap["plugins"].as_array().is_some_and(|plugins| {
            plugins
                .iter()
                .any(|p| p["id"] == "avatar" && p["enabled"] == true)
        })
    {
        rpc(
            &state.connection,
            "plugins.enable",
            serde_json::json!({"id":"avatar","enabled":true}),
        )?;
    }
    if !enabled && !bootstrap["plugins"].as_array().is_some_and(|plugins| {
        plugins.iter().any(|p| p["id"] == "avatar" && p["enabled"] == true)
    }) { return Ok(()); }
    rpc(
        &state.connection,
        "avatar.setVisible",
        serde_json::json!({"visible":enabled}),
    )?;
    Ok(())
}
#[tauri::command]
fn quit_echo(app: tauri::AppHandle) {
    app.state::<Runtime>()
        .quitting
        .store(true, Ordering::SeqCst);
    app.exit(0);
}
fn main() {
    let mut context = tauri::generate_context!();
    let data = data_directory();
    std::fs::create_dir_all(&data).expect("Echo data directory unavailable");
    // The SQLite instance lock protects the same data. Keep unrelated installations
    // and isolated acceptance fixtures from activating each other's desktop window.
    context.config_mut().identifier = instance_identifier(&data);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = show_main(&app);
            });
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            connection,
            desktop_info,
            desktop_ready,
            install_update,
            open_settings,
            open_extension_window,
            open_workbench,
            set_language,
            auth::open_auth_url,
            quit_echo
        ])
        .setup(|app| {
            let runtime = launch(app.handle()).map_err(std::io::Error::other)?;
            app.manage(runtime);
            let open = MenuItem::with_id(app, "open", "打开 Echo", true, None::<&str>)?;
            let pet = MenuItem::with_id(app, "avatar", "显示桌宠", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "收起桌宠", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 Echo", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &pet, &hide, &quit])?;
            app.manage(DesktopMenu {
                open,
                pet,
                hide,
                quit,
            });
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("Echo")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        let app = app.clone();
                        std::thread::spawn(move || {
                            let _ = show_main(&app);
                        });
                    }
                    "avatar" => {
                        let app = app.clone();
                        std::thread::spawn(move || {
                            let _ = persist_avatar(app, true);
                        });
                    }
                    "hide" => {
                        let app = app.clone();
                        std::thread::spawn(move || {
                            let _ = persist_avatar(app, false);
                        });
                    }
                    "quit" => {
                        app.state::<Runtime>()
                            .quitting
                            .store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle().clone();
                        std::thread::spawn(move || {
                            let _ = show_main(&app);
                        });
                    }
                })
                .build(app)?;
            show_main(app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .build(context)
        .expect("Echo desktop initialization failed");
    app.run(|handle, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if !handle.state::<Runtime>().quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Exit => {
            let state = handle.state::<Runtime>();
            if let Ok(mut child) = state.child.lock() {
                if let Some(process) = child.as_mut() {
                    let _ = rpc(&state.connection, "system.shutdown", serde_json::json!({}));
                    for _ in 0..40 {
                        if process.try_wait().ok().flatten().is_some() {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    let _ = process.kill();
                    let _ = process.wait();
                }
            }
        }
        _ => {}
    });
}
