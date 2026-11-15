//! Window-local caption geometry. The browser owns appearance; Tao retains
//! native drag/resize behavior and Windows owns the Snap Layout flyout.
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Bounds {
    pub right: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
    pub scale: f64,
}
impl Bounds {
    fn valid(self, client_width: i32, client_height: i32) -> bool {
        self.scale.is_finite()
            && (0.25..=8.0).contains(&self.scale)
            && self.right >= 0
            && self.top >= 0
            && (24.0..=64.0).contains(&(self.width as f64 / self.scale))
            && (24.0..=96.0).contains(&(self.height as f64 / self.scale))
            && self.top as f64 / self.scale <= 10.0
            && (24.0..=80.0).contains(&(self.right as f64 / self.scale))
            && self.right as i64 + self.width as i64 <= client_width as i64
            && self.top as i64 + self.height as i64 <= client_height as i64
    }
}

#[tauri::command]
pub async fn window_chrome_update(
    window: tauri::WebviewWindow,
    owner: String,
    bounds: Option<Bounds>,
) -> Result<bool, String> {
    if !(window.label() == "main"
        || window.label() == "settings"
        || window.label().starts_with("extension-"))
        || owner.is_empty()
        || owner.len() > 80
    {
        return Err("Window chrome is unavailable for this caller".into());
    }
    #[cfg(windows)]
    {
        let handle = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
        let (tx, mut rx) = tauri::async_runtime::channel(1);
        let current = window.clone();
        window
            .run_on_main_thread(move || {
                let result = unsafe { platform::update(current, handle, owner, bounds) };
                let _ = tx.try_send(result);
            })
            .map_err(|e| e.to_string())?;
        rx.recv()
            .await
            .ok_or("Window chrome request was interrupted")?
    }
    #[cfg(not(windows))]
    {
        let _ = (window, owner, bounds);
        Ok(false)
    }
}

#[cfg(windows)]
mod platform {
    // The native child hit target follows the MIT-licensed Snap Layout pattern
    // from Hyph-M/tauri-plugin-snap-layout. Attribution is retained in the bundled
    // license notice. Geometry, lifecycle and host routing are owned by Echo.
    use super::Bounds;
    use std::cell::Cell;
    use tauri::Emitter;
    use windows::{
        Win32::{
            Foundation::{HANDLE, HWND, LPARAM, LRESULT, RECT, WPARAM},
            Graphics::Gdi::ValidateRect,
            UI::{
                HiDpi::GetDpiForWindow,
                Input::KeyboardAndMouse::{
                    TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT, TrackMouseEvent,
                },
                Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
                WindowsAndMessaging::*,
            },
        },
        core::w,
    };
    const PARENT_ID: usize = 0x45434850;
    const CHILD_ID: usize = 0x45434843;
    const PROP: windows::core::PCWSTR = w!("Echo.WindowChrome.Target");
    #[derive(Clone, Copy)]
    struct Layout {
        bounds: Bounds,
        dpi: u32,
    }
    struct Target {
        window: tauri::WebviewWindow,
        parent: HWND,
        child: HWND,
        owner: String,
        layout: Cell<Layout>,
        hovered: Cell<bool>,
        pressed: Cell<bool>,
    }
    impl Target {
        fn emit(&self) {
            let _ = self.window.emit(
                "echo:chrome-snap",
                serde_json::json!({
                    "hovered": self.hovered.get(), "pressed": self.pressed.get(),
                }),
            );
        }
        unsafe fn position(&self) {
            let mut client = RECT::default();
            if unsafe { GetClientRect(self.parent, &mut client) }.is_err() {
                return;
            }
            let layout = self.layout.get();
            let dpi = unsafe { GetDpiForWindow(self.parent) }.max(96);
            let ratio = dpi as f64 / layout.dpi.max(96) as f64;
            let scaled = |value: i32| (value as f64 * ratio).round() as i32;
            let b = layout.bounds;
            // Keep a resize strip above the native maximize hit target.
            let inset = (4.0 * b.scale * ratio).round() as i32;
            let width = scaled(b.width);
            let top = scaled(b.top).max(inset);
            let height = (scaled(b.top + b.height) - top).max(1);
            let _ = unsafe {
                SetWindowPos(
                    self.child,
                    Some(HWND_TOP),
                    (client.right - scaled(b.right) - width).max(0),
                    top,
                    width,
                    height,
                    SWP_NOACTIVATE,
                )
            };
        }
    }

    pub unsafe fn update(
        window: tauri::WebviewWindow,
        raw: usize,
        owner: String,
        bounds: Option<Bounds>,
    ) -> Result<bool, String> {
        let parent = HWND(raw as *mut _);
        let existing = unsafe { GetPropW(parent, PROP) }.0 as *mut Target;
        let Some(bounds) = bounds else {
            if !existing.is_null() && unsafe { &*existing }.owner == owner {
                unsafe { remove(parent, existing) };
            }
            return Ok(true);
        };
        let mut client = RECT::default();
        unsafe { GetClientRect(parent, &mut client) }.map_err(|e| e.to_string())?;
        if !bounds.valid(client.right, client.bottom) {
            return Ok(false);
        }
        let layout = Layout {
            bounds,
            dpi: unsafe { GetDpiForWindow(parent) }.max(96),
        };
        if !existing.is_null() {
            unsafe {
                (*existing).owner = owner;
                (*existing).layout.set(layout);
                (*existing).position();
            }
            return Ok(true);
        }
        let child = unsafe {
            CreateWindowExW(
                WS_EX_TRANSPARENT | WS_EX_NOACTIVATE,
                w!("STATIC"),
                w!(""),
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                0,
                0,
                1,
                1,
                Some(parent),
                None,
                None,
                None,
            )
        }
        .map_err(|e| e.to_string())?;
        let target = Box::into_raw(Box::new(Target {
            window,
            parent,
            child,
            owner,
            layout: Cell::new(layout),
            hovered: Cell::new(false),
            pressed: Cell::new(false),
        }));
        let parent_ok =
            unsafe { SetWindowSubclass(parent, Some(parent_proc), PARENT_ID, target as usize) }
                .as_bool();
        let child_ok =
            unsafe { SetWindowSubclass(child, Some(child_proc), CHILD_ID, target as usize) }
                .as_bool();
        let prop = unsafe { SetPropW(parent, PROP, Some(HANDLE(target as *mut _))) };
        if !parent_ok || !child_ok || prop.is_err() {
            unsafe {
                let _ = RemoveWindowSubclass(parent, Some(parent_proc), PARENT_ID);
                let _ = RemoveWindowSubclass(child, Some(child_proc), CHILD_ID);
                let _ = RemovePropW(parent, PROP);
                let _ = DestroyWindow(child);
                drop(Box::from_raw(target));
            }
            return Err("Could not initialize native window snapping".into());
        }
        unsafe {
            (*target).position();
        }
        Ok(true)
    }
    unsafe fn remove(parent: HWND, state: *mut Target) {
        unsafe {
            let _ = RemoveWindowSubclass(parent, Some(parent_proc), PARENT_ID);
            let _ = RemovePropW(parent, PROP);
            let child = (*state).child;
            let _ = RemoveWindowSubclass(child, Some(child_proc), CHILD_ID);
            if IsWindow(Some(child)).as_bool() {
                let _ = DestroyWindow(child);
            }
            drop(Box::from_raw(state));
        }
    }
    unsafe extern "system" fn parent_proc(
        hwnd: HWND,
        msg: u32,
        wp: WPARAM,
        lp: LPARAM,
        _: usize,
        data: usize,
    ) -> LRESULT {
        if msg == WM_NCDESTROY {
            unsafe {
                remove(hwnd, data as *mut Target);
            }
            return unsafe { DefSubclassProc(hwnd, msg, wp, lp) };
        }
        let result = unsafe { DefSubclassProc(hwnd, msg, wp, lp) };
        if msg == WM_SIZE || msg == WM_DPICHANGED {
            unsafe {
                (*(data as *const Target)).position();
            }
        }
        result
    }
    unsafe extern "system" fn child_proc(
        hwnd: HWND,
        msg: u32,
        wp: WPARAM,
        lp: LPARAM,
        _: usize,
        data: usize,
    ) -> LRESULT {
        let state = unsafe { &*(data as *const Target) };
        match msg {
            WM_NCDESTROY => unsafe {
                let _ = RemoveWindowSubclass(hwnd, Some(child_proc), CHILD_ID);
            },
            WM_NCHITTEST => {
                if !state.hovered.replace(true) {
                    state.emit();
                    let mut track = TRACKMOUSEEVENT {
                        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                        dwFlags: TME_LEAVE | TME_NONCLIENT,
                        hwndTrack: hwnd,
                        dwHoverTime: 0,
                    };
                    unsafe {
                        let _ = TrackMouseEvent(&mut track);
                    }
                }
                return LRESULT(HTMAXBUTTON as isize);
            }
            WM_NCMOUSELEAVE => {
                state.hovered.set(false);
                state.pressed.set(false);
                state.emit();
            }
            WM_NCLBUTTONDOWN if wp.0 == HTMAXBUTTON as usize => {
                state.pressed.set(true);
                state.emit();
                return LRESULT(0);
            }
            WM_NCLBUTTONUP if wp.0 == HTMAXBUTTON as usize => {
                let pressed = state.pressed.replace(false);
                state.emit();
                if pressed {
                    let action = if unsafe { IsZoomed(state.parent) }.as_bool() {
                        SC_RESTORE
                    } else {
                        SC_MAXIMIZE
                    };
                    unsafe {
                        let _ = PostMessageW(
                            Some(state.parent),
                            WM_SYSCOMMAND,
                            WPARAM(action as usize),
                            LPARAM(0),
                        );
                    }
                }
                return LRESULT(0);
            }
            WM_ERASEBKGND => return LRESULT(1),
            WM_PAINT => {
                unsafe {
                    let _ = ValidateRect(Some(hwnd), None);
                }
                return LRESULT(0);
            }
            _ => {}
        }
        unsafe { DefSubclassProc(hwnd, msg, wp, lp) }
    }
}

#[cfg(test)]
mod tests {
    use super::Bounds;
    #[test]
    fn snap_target_is_confined_to_a_caption_control_at_multiple_scales() {
        for scale in [1.0, 1.25, 1.5, 1.75, 2.0, 2.5] {
            let b = Bounds {
                right: (46.0 * scale) as i32,
                top: 0,
                width: (46.0 * scale) as i32,
                height: (65.0 * scale) as i32,
                scale,
            };
            assert!(b.valid((1000.0 * scale) as i32, (700.0 * scale) as i32));
            assert!(
                !Bounds {
                    top: (100.0 * scale) as i32,
                    ..b
                }
                .valid(4000, 4000)
            );
            assert!(!Bounds { right: -1, ..b }.valid(4000, 4000));
            assert!(
                !Bounds {
                    width: i32::MAX,
                    ..b
                }
                .valid(4000, 4000)
            );
            assert!(
                !Bounds {
                    scale: f64::NAN,
                    ..b
                }
                .valid(4000, 4000)
            );
        }
    }
}
