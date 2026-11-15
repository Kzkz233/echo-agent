//! Windows keeps the caption icon (ICON_SMALL) and taskbar icon (ICON_BIG)
//! separately. Tauri's normal icon path sets only the former through Tao.
//! Load the shared large icon from this executable's standard Tauri resource,
//! so every workbench window uses the same artwork without Shell cache fallback.

#[cfg(windows)]
pub fn apply(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{HINSTANCE, HWND, LPARAM, WPARAM},
            System::LibraryLoader::GetModuleHandleW,
            UI::WindowsAndMessaging::{ICON_BIG, IMAGE_ICON, LR_SHARED, LoadImageW, SendMessageW, WM_SETICON},
        },
    };
    let native = window.hwnd().map_err(|e| e.to_string())?;
    unsafe {
        let module = GetModuleHandleW(None).map_err(|e| e.to_string())?;
        // tauri-build embeds the application ICO as resource 32512. LR_SHARED
        // retains this handle for the module lifetime; it must not be destroyed
        // when an individual settings or extension window closes.
        let icon = LoadImageW(
            Some(HINSTANCE(module.0)),
            PCWSTR(32512usize as *const u16),
            IMAGE_ICON,
            256,
            256,
            LR_SHARED,
        ).map_err(|e| e.to_string())?;
        SendMessageW(
            HWND(native.0),
            WM_SETICON,
            Some(WPARAM(ICON_BIG as usize)),
            Some(LPARAM(icon.0 as isize)),
        );
    }
    Ok(())
}
