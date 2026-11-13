use crate::{Rect, Rule, Source, host_allowed, process_allowed};
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{RgbImage, codecs::jpeg::JpegEncoder};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::ffi::c_void;
use windows::{
    Win32::{
        Foundation::{CloseHandle, HWND, RECT},
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_UNKNOWN,
            Direct3D11::*,
            Dwm::{DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute},
            Dxgi::*,
            Gdi::*,
        },
        Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow},
        System::{Com::*, StationsAndDesktops::*, Threading::*},
        UI::{Accessibility::*, HiDpi::*, WindowsAndMessaging::*},
    },
    core::Interface,
};

pub fn initialize() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}
#[cfg(debug_assertions)]
pub fn diagnose_fixture() -> Value {
    unsafe {
        let mut result = Vec::new();
        let mut window = GetTopWindow(None).ok();
        while let Some(hwnd) = window {
            window = GetWindow(hwnd, GW_HWNDNEXT).ok();
            let name = title(hwnd);
            if !name.contains("Allowed fixture") {
                continue;
            }
            let mut row = json!({"title":name,"visible":IsWindowVisible(hwnd).as_bool(),"process":process_name(hwnd)});
            if let Ok(automation) =
                CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
            {
                if let Ok(root) = automation.ElementFromHandle(hwnd) {
                    if let Ok(condition) = automation.CreatePropertyCondition(
                        UIA_ControlTypePropertyId,
                        &windows::Win32::System::Variant::VARIANT::from(
                            UIA_DocumentControlTypeId.0,
                        ),
                    ) {
                        if let Ok(elements) = root.FindAll(TreeScope_Descendants, &condition) {
                            let mut docs = Vec::new();
                            for i in 0..elements.Length().unwrap_or(0).min(20) {
                                if let Ok(e) = elements.GetElement(i) {
                                    let legacy = e
                                        .GetCurrentPattern(UIA_LegacyIAccessiblePatternId)
                                        .and_then(|p| {
                                            p.cast::<IUIAutomationLegacyIAccessiblePattern>()
                                        })
                                        .and_then(|p| p.CurrentValue())
                                        .map(|v| v.to_string())
                                        .unwrap_or_default();
                                    let value = e
                                        .GetCurrentPattern(UIA_ValuePatternId)
                                        .and_then(|p| p.cast::<IUIAutomationValuePattern>())
                                        .and_then(|p| p.CurrentValue())
                                        .map(|v| v.to_string())
                                        .unwrap_or_default();
                                    docs.push(json!({"name":e.CurrentName().map(|v|v.to_string()).unwrap_or_default(),"legacy":legacy,"value":value,"offscreen":e.CurrentIsOffscreen().map(|v|v.as_bool()).unwrap_or(true)}));
                                }
                            }
                            row["documents"] = json!(docs);
                        }
                    }
                }
            }
            row["authorized"] =
                json!(browser_document(hwnd).map(
                    |doc| json!({"url":doc.url,"rect":doc.rect,"embedded":doc.embedded.len()})
                ));
            result.push(row);
        }
        let mut windows = Vec::new();
        let mut current = GetTopWindow(None).ok();
        while let Some(hwnd) = current {
            current = GetWindow(hwnd, GW_HWNDNEXT).ok();
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                continue;
            }
            let mut rect = RECT::default();
            let _ = GetWindowRect(hwnd, &mut rect);
            if rect.right - rect.left < 20 || rect.bottom - rect.top < 20 {
                continue;
            }
            let mut cloaked = 0u32;
            let _ = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut _ as *mut c_void,
                4,
            );
            let mut alpha = 255u8;
            let mut flags = LAYERED_WINDOW_ATTRIBUTES_FLAGS(0);
            let layered =
                GetLayeredWindowAttributes(hwnd, None, Some(&mut alpha), Some(&mut flags)).is_ok();
            windows.push(json!({"process":process_name(hwnd),"rect":[rect.left,rect.top,rect.right,rect.bottom],"style":GetWindowLongPtrW(hwnd,GWL_EXSTYLE),"cloaked":cloaked,"regions":window_regions(hwnd,Rect{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom}),"layered":layered,"alpha":alpha,"flags":flags.0}));
            if windows.len() > 35 {
                break;
            }
        }
        json!({"fixtures":result,"stack":windows})
    }
}
fn title(hwnd: HWND) -> String {
    let mut text = vec![0u16; 1024];
    let count = unsafe { GetWindowTextW(hwnd, &mut text) };
    String::from_utf16_lossy(&text[..count.max(0) as usize])
}
fn process_name(hwnd: HWND) -> String {
    process_path(hwnd)
        .rsplit('\\')
        .next()
        .unwrap_or("")
        .to_lowercase()
}
fn process_path(hwnd: HWND) -> String {
    unsafe {
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buffer = vec![0u16; 32768];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return String::new();
        }
        String::from_utf16_lossy(&buffer[..size as usize]).to_lowercase()
    }
}
struct BrowserDocument {
    url: String,
    rect: Rect,
    embedded: Vec<(String, Rect)>,
}
fn browser_document(hwnd: HWND) -> Option<BrowserDocument> {
    unsafe {
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let root = automation.ElementFromHandle(hwnd).ok()?;
        let condition = automation
            .CreatePropertyCondition(
                UIA_ControlTypePropertyId,
                &windows::Win32::System::Variant::VARIANT::from(UIA_DocumentControlTypeId.0),
            )
            .ok()?;
        let elements = root.FindAll(TreeScope_Descendants, &condition).ok()?;
        let walker = automation.ControlViewWalker().ok()?;
        let count = elements.Length().ok()?;
        if count > 200 {
            return None;
        }
        let mut top = None;
        let mut embedded = Vec::new();
        for index in 0..count {
            let element = elements.GetElement(index).ok()?;
            if element.CurrentIsOffscreen().ok()?.as_bool() {
                continue;
            }
            let mut parent = walker.GetParentElement(&element).ok()?;
            let mut in_document = false;
            for _ in 0..32 {
                if let Ok(control) = parent.CurrentControlType() {
                    if control == UIA_DocumentControlTypeId {
                        in_document = true;
                        break;
                    }
                }
                let Ok(next) = walker.GetParentElement(&parent) else {
                    break;
                };
                parent = next;
            }
            // The document's accessibility URL is committed content, unlike text typed into the address bar.
            let value = element
                .GetCurrentPattern(UIA_LegacyIAccessiblePatternId)
                .and_then(|raw| raw.cast::<IUIAutomationLegacyIAccessiblePattern>())
                .and_then(|pattern| pattern.CurrentValue())
                .map(|value| value.to_string())
                .unwrap_or_default();
            let bounds = element.CurrentBoundingRectangle().ok()?;
            let rect = Rect {
                left: bounds.left,
                top: bounds.top,
                right: bounds.right,
                bottom: bounds.bottom,
            };
            if in_document {
                embedded.push((value, rect));
            } else if top.is_none()
                && value.len() <= 8192
                && (value.starts_with("https://") || value.starts_with("http://"))
            {
                top = Some((value, rect));
            }
        }
        if let Some((url, rect)) = top {
            return Some(BrowserDocument {
                url,
                rect,
                embedded,
            });
        }
    }
    None
}
#[derive(Clone)]
struct AuthorizedWindow {
    hwnd: HWND,
    regions: Vec<Rect>,
    behind_ignored_window: bool,
}
#[derive(Clone)]
struct Scene {
    width: i32,
    height: i32,
    regions: Vec<Rect>,
    sources: Vec<Source>,
    proof: String,
    denial_reason: String,
    authorized_windows: Vec<AuthorizedWindow>,
}
fn window_regions(hwnd: HWND, bounds: Rect) -> Vec<Rect> {
    unsafe {
        // Windows keeps a fullscreen transparent TabTip host even with the keyboard closed.
        // Only its protected system binary may use the OS input-pane geometry, and an
        // empty pane is trusted only when UI Automation also reports no visible child.
        if process_name(hwnd) == "tabtip.exe" {
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut path = vec![0u16; 32768];
                let mut size = path.len() as u32;
                let ok = QueryFullProcessImageNameW(
                    handle,
                    PROCESS_NAME_WIN32,
                    windows::core::PWSTR(path.as_mut_ptr()),
                    &mut size,
                )
                .is_ok();
                let _ = CloseHandle(handle);
                let actual = String::from_utf16_lossy(&path[..size as usize]).to_lowercase();
                let expected = std::env::var("CommonProgramFiles")
                    .unwrap_or_default()
                    .to_lowercase()
                    + "\\microsoft shared\\ink\\tabtip.exe";
                if ok && actual == expected {
                    if let Ok(pane) =
                        CoCreateInstance::<_, windows::Win32::UI::Shell::IFrameworkInputPane>(
                            &windows::Win32::UI::Shell::FrameworkInputPane,
                            None,
                            CLSCTX_INPROC_SERVER,
                        )
                    {
                        if let Ok(location) = pane.Location() {
                            let rect = Rect {
                                left: location.left,
                                top: location.top,
                                right: location.right,
                                bottom: location.bottom,
                            };
                            if rect.right > rect.left && rect.bottom > rect.top {
                                return rect.intersect(bounds).into_iter().collect();
                            }
                            if let Ok(automation) = CoCreateInstance::<_, IUIAutomation>(
                                &CUIAutomation,
                                None,
                                CLSCTX_INPROC_SERVER,
                            ) {
                                if let Ok(root) = automation.ElementFromHandle(hwnd) {
                                    if let Ok(condition) = automation.CreateTrueCondition() {
                                        if let Ok(elements) =
                                            root.FindAll(TreeScope_Descendants, &condition)
                                        {
                                            let mut visible = false;
                                            let count = elements.Length().unwrap_or(201);
                                            if count <= 200 {
                                                for index in 0..count {
                                                    if let Ok(e) = elements.GetElement(index) {
                                                        if !e
                                                            .CurrentIsOffscreen()
                                                            .map(|v| v.as_bool())
                                                            .unwrap_or(false)
                                                        {
                                                            visible = true;
                                                            break;
                                                        }
                                                    }
                                                }
                                                if !visible {
                                                    return Vec::new();
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if style & WS_EX_LAYERED.0 as isize != 0 {
            let mut alpha = 255u8;
            let mut flags = LAYERED_WINDOW_ATTRIBUTES_FLAGS(0);
            if GetLayeredWindowAttributes(hwnd, None, Some(&mut alpha), Some(&mut flags)).is_ok()
                && flags.0 & LWA_ALPHA.0 != 0
                && alpha == 0
            {
                return Vec::new();
            }
        }
        let region = CreateRectRgn(0, 0, 0, 0);
        if region.is_invalid() {
            return vec![bounds];
        }
        let kind = GetWindowRgn(hwnd, region);
        if kind == NULLREGION {
            let _ = DeleteObject(region.into());
            return Vec::new();
        }
        if kind == SIMPLEREGION || kind == COMPLEXREGION {
            let size = GetRegionData(region, 0, None);
            if size > 0 && size < 1000000 {
                let mut bytes = vec![0u32; (size as usize + 3) / 4];
                let ptr = bytes.as_mut_ptr() as *mut RGNDATA;
                if GetRegionData(region, size, Some(ptr)) > 0 {
                    let count = (*ptr).rdh.nCount as usize;
                    if count <= 256
                        && size as usize
                            >= std::mem::size_of::<RGNDATAHEADER>()
                                + count * std::mem::size_of::<RECT>()
                    {
                        let mut outer = RECT::default();
                        let _ = GetWindowRect(hwnd, &mut outer);
                        let rectangles = std::slice::from_raw_parts(
                            (ptr as *const u8).add(std::mem::size_of::<RGNDATAHEADER>())
                                as *const RECT,
                            count,
                        );
                        let result = rectangles
                            .iter()
                            .filter_map(|r| {
                                (Rect {
                                    left: r.left + outer.left,
                                    top: r.top + outer.top,
                                    right: r.right + outer.left,
                                    bottom: r.bottom + outer.top,
                                })
                                .intersect(bounds)
                            })
                            .collect();
                        let _ = DeleteObject(region.into());
                        return result;
                    }
                }
            }
        }
        let _ = DeleteObject(region.into());
        vec![bounds]
    }
}
fn input_desktop_active() -> bool {
    unsafe {
        let Ok(desktop) = GetThreadDesktop(GetCurrentThreadId()) else {
            return false;
        };
        let mut active = 0u32;
        GetUserObjectInformationW(
            windows::Win32::Foundation::HANDLE(desktop.0),
            UOI_IO,
            Some((&mut active as *mut u32).cast()),
            4,
            None,
        )
        .is_ok()
            && active != 0
    }
}
fn rule_matches_window(rule: &Rule, executable: &str, title_text: &str) -> bool {
    rule.enabled
        && rule.r#type == "process"
        && process_allowed(executable, &rule.value)
        && (rule.title.trim().is_empty() || title_text.contains(rule.title.trim()))
}
fn scene(rules: &[Rule], browser_rules: &[Rule], occlusion_rules: &[Rule]) -> Result<Scene, String> {
    if !input_desktop_active() {
        return Err("当前不是可交互桌面，已暂停采集".into());
    }
    unsafe {
        let width = GetSystemMetrics(SM_CXSCREEN);
        let height = GetSystemMetrics(SM_CYSCREEN);
        if width <= 0 || height <= 0 {
            return Err("没有可采集显示器".into());
        }
        let viewport = Rect {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        };
        let mut covered: Vec<Rect> = Vec::new();
        let mut regions = Vec::new();
        let mut sources = Vec::new();
        let mut proof = Sha256::new();
        let mut denial_reason = String::new();
        let mut large_layered_covers: Vec<(Rect, String)> = Vec::new();
        let mut authorized_windows = Vec::new();
        let mut ignored_above: Vec<Rect> = Vec::new();
        let mut window = GetTopWindow(None).ok();
        let mut count = 0;
        while let Some(hwnd) = window {
            count += 1;
            if count > 1024 {
                break;
            }
            window = GetWindow(hwnd, GW_HWNDNEXT).ok();
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                continue;
            }
            let mut cloaked = 0u32;
            let _ = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut _ as *mut c_void,
                4,
            );
            if cloaked != 0 {
                continue;
            }
            let mut bounds = RECT::default();
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut bounds as *mut _ as *mut c_void,
                std::mem::size_of::<RECT>() as u32,
            )
            .is_err()
            {
                let _ = GetWindowRect(hwnd, &mut bounds);
            }
            let Some(rect) = (Rect {
                left: bounds.left,
                top: bounds.top,
                right: bounds.right,
                bottom: bounds.bottom,
            })
            .intersect(viewport) else {
                continue;
            };
            let shape = window_regions(hwnd, rect);
            if shape.is_empty() {
                continue;
            }
            let executable = process_path(hwnd);
            let process = executable.rsplit('\\').next().unwrap_or("").to_string();
            let window_title = title(hwnd);
            let ignored_occluder = occlusion_rules
                .iter()
                .any(|rule| rule_matches_window(rule, &executable, &window_title));
            // Ignore wins over an allow rule. Its pixels are never an observation source.
            if ignored_occluder {
                ignored_above.extend(shape);
                if ignored_above.len() > 4096 {
                    return Err("忽略窗口的区域过于复杂，已暂停此帧".into());
                }
                continue;
            }
            let mut visible = shape.clone();
            for cover in &covered {
                visible = visible
                    .into_iter()
                    .flat_map(|r| r.subtract(*cover))
                    .collect();
                if visible.is_empty() {
                    break;
                }
                if visible.len() > 4096 {
                    visible.clear();
                    break;
                }
            }
            let process_rule = rules.iter().find(|r| {
                r.enabled && r.r#type == "process" && process_allowed(&executable, &r.value)
            });
            if process_rule.is_some() && visible.is_empty() {
                denial_reason = large_layered_covers
                    .iter()
                    .find(|(cover, _)| cover.intersect(rect).is_some())
                    .map(|(_, name)| format!("白名单窗口被无法确认透明区域的叠层遮挡：{name}"))
                    .unwrap_or_else(|| "白名单程序窗口当前被其他窗口遮挡".into());
            }
            if !visible.is_empty() {
                let mut matched = process_rule;
                let mut source = process.clone();
                let mut authorized_rect = rect;
                let mut blocked_documents = Vec::new();
                if matched.is_none()
                    && browser_rules
                        .iter()
                        .any(|rule| rule_matches_window(rule, &executable, &window_title))
                {
                    if let Some(document) = browser_document(hwnd) {
                        let url = document.url;
                        let document_rect = document.rect;
                        blocked_documents = document
                            .embedded
                            .into_iter()
                            .filter(|(url, _)| {
                                !rules.iter().any(|rule| {
                                    rule.enabled
                                        && rule.r#type == "website"
                                        && host_allowed(url, &rule.value)
                                })
                            })
                            .map(|(_, rect)| rect)
                            .collect();
                        for rule in rules.iter().filter(|r| r.enabled && r.r#type == "website") {
                            if host_allowed(&url, &rule.value) {
                                if let Some(content) = rect.intersect(document_rect) {
                                    matched = Some(rule);
                                    source = url.clone();
                                    authorized_rect = content;
                                }
                                break;
                            }
                        }
                    } else {
                        denial_reason = "来源读取器未取得已加载文档的网址；请检查浏览器的辅助功能支持".into();
                    }
                    if matched.is_none() && denial_reason.is_empty() {
                        denial_reason = "当前文档未匹配网站白名单".into();
                    }
                }
                if let Some(rule) = matched {
                    let mut admitted: Vec<Rect> = visible
                        .into_iter()
                        .filter_map(|part| part.intersect(authorized_rect))
                        .collect();
                    for blocked in &blocked_documents {
                        admitted = admitted
                            .into_iter()
                            .flat_map(|rect| rect.subtract(*blocked))
                            .collect();
                    }
                    if !admitted.is_empty() {
                        let behind_ignored_window = admitted.iter().any(|area|
                            ignored_above.iter().any(|overlay|area.intersect(*overlay).is_some()));
                        proof.update(format!("{:?}:{:?}:{}:{}", hwnd, admitted, source, behind_ignored_window));
                        regions.extend(admitted.iter().copied());
                        authorized_windows.push(AuthorizedWindow { hwnd, regions:admitted, behind_ignored_window });
                        sources.push(Source {
                            rule_id: rule.id.clone(),
                            source,
                            title: window_title.clone(),
                        });
                    }
                }
            }
            // Unmatched windows still occlude lower content; ignored windows were handled above.
            if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_LAYERED.0 as isize != 0
                && (rect.right - rect.left) as i64 * (rect.bottom - rect.top) as i64
                    > (width as i64 * height as i64 * 95 / 100)
            {
                large_layered_covers.push((rect, process));
            }
            covered.extend(shape);
            if covered.len() > 4096 {
                return Err("窗口区域过于复杂，已暂停此帧".into());
            }
        }
        Ok(Scene {
            width,
            height,
            regions,
            sources,
            proof: format!("{:x}", proof.finalize()),
            denial_reason,
            authorized_windows,
        })
    }
}
fn scaled_regions(scene: &Scene, width: u32, height: u32) -> impl Iterator<Item = Rect> + '_ {
    let sx = width as f64 / scene.width as f64;
    let sy = height as f64 / scene.height as f64;
    scene.regions.iter().map(move |region| Rect {
        left: (region.left as f64 * sx).ceil() as i32,
        top: (region.top as f64 * sy).ceil() as i32,
        right: (region.right as f64 * sx).floor() as i32,
        bottom: (region.bottom as f64 * sy).floor() as i32,
    })
}
fn visibility(scene: &Scene, image: &RgbImage) -> Value {
    let regions: Vec<_> = scaled_regions(scene, image.width(), image.height()).collect();
    let mut visible = 0u64;
    let mut lit = 0u64;
    let mut content = 0u64;
    const COLS: u32 = 80;
    const ROWS: u32 = 45;
    for row in 0..ROWS {
        let y = ((2 * row + 1) * image.height() / (2 * ROWS)) as i32;
        for col in 0..COLS {
            let x = ((2 * col + 1) * image.width() / (2 * COLS)) as i32;
            if regions
                .iter()
                .any(|r| x >= r.left && x < r.right && y >= r.top && y < r.bottom)
            {
                visible += 1;
                let pixel = image.get_pixel(x as u32, y as u32).0;
                if pixel.into_iter().any(|v| v > 24) {
                    lit += 1;
                }
                if pixel.into_iter().any(|v| v > 8)
                    || (pixel[0].abs_diff(pixel[1]) > 4
                        || pixel[1].abs_diff(pixel[2]) > 4
                        || pixel[0].abs_diff(pixel[2]) > 4)
                {
                    content += 1;
                }
            }
        }
    }
    let sampled = (COLS * ROWS) as u64;
    json!({
        "visiblePercent": 100 * visible / sampled,
        "litPercent": 100 * lit / visible.max(1),
        "contentPercent": 100 * content / visible.max(1),
        "sampledPercent": 100 * visible / sampled,
    })
}
#[cfg(test)]
#[test]
fn visibility_excludes_masked_pixels_when_measuring_darkness() {
    let scene = Scene {
        width: 80,
        height: 48,
        regions: vec![Rect {
            left: 40,
            top: 0,
            right: 80,
            bottom: 48,
        }],
        sources: vec![],
        proof: String::new(),
        denial_reason: String::new(),
        authorized_windows: vec![],
    };
    let mut image = RgbImage::new(80, 48);
    assert_eq!(
        visibility(&scene, &image),
        json!({"visiblePercent":50,"litPercent":0,"contentPercent":0,"sampledPercent":50})
    );
    for y in 0..48 {
        for x in 40..80 {
            image.put_pixel(x, y, image::Rgb([100, 50, 0]));
        }
    }
    assert_eq!(
        visibility(&scene, &image),
        json!({"visiblePercent":50,"litPercent":100,"contentPercent":100,"sampledPercent":50})
    );
}
#[cfg(test)]
#[test]
fn configured_browser_process_rules_are_exact_and_editable() {
    let rule = Rule {
        id: "custom-browser".into(),
        r#type: "process".into(),
        value: "C:/Browsers/Custom.exe".into(),
        title: "Video".into(),
        enabled: true,
    };
    assert!(rule_matches_window(
        &rule,
        "c:\\browsers\\custom.exe",
        "Video - Example"
    ));
    assert!(!rule_matches_window(
        &rule,
        "c:\\other\\custom.exe",
        "Video - Example"
    ));
    assert!(!rule_matches_window(
        &rule,
        "c:\\browsers\\custom.exe",
        "Other"
    ));
}
fn gdi_pixels(scene: &Scene, width: u32) -> Result<RgbImage, String> {
    unsafe {
        let height =
            ((width as f64 * scene.height as f64 / scene.width as f64).round() as u32).max(1);
        let desktop = GetDC(None);
        if desktop.is_invalid() {
            return Err("无法取得显示器 DC".into());
        }
        let target = CreateCompatibleDC(Some(desktop));
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap =
            match CreateDIBSection(Some(desktop), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
                Ok(v) => v,
                Err(_) => {
                    let _ = DeleteDC(target);
                    ReleaseDC(None, desktop);
                    return Err("无法分配采集缓冲".into());
                }
            };
        let old = SelectObject(target, bitmap.into());
        let _ = PatBlt(target, 0, 0, width as i32, height as i32, BLACKNESS);
        let mut failed = false;
        let sx = width as f64 / scene.width as f64;
        let sy = height as f64 / scene.height as f64;
        for Rect {
            left: l,
            top: t,
            right: r,
            bottom: b,
        } in scaled_regions(scene, width, height)
        {
            if r <= l || b <= t {
                continue;
            }
            let src_l = (l as f64 / sx).ceil() as i32;
            let src_t = (t as f64 / sy).ceil() as i32;
            let src_r = (r as f64 / sx).floor() as i32;
            let src_b = (b as f64 / sy).floor() as i32;
            if !StretchBlt(
                target,
                l,
                t,
                r - l,
                b - t,
                Some(desktop),
                src_l,
                src_t,
                src_r - src_l,
                src_b - src_t,
                SRCCOPY | CAPTUREBLT,
            )
            .as_bool()
            {
                failed = true;
                break;
            }
        }
        let mut rgb = RgbImage::new(width, height);
        if !bits.is_null() && !failed {
            let bytes =
                std::slice::from_raw_parts(bits as *const u8, (width * height * 4) as usize);
            for (index, pixel) in rgb.pixels_mut().enumerate() {
                let p = &bytes[index * 4..index * 4 + 4];
                *pixel = image::Rgb([p[2], p[1], p[0]]);
            }
        }
        SelectObject(target, old);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(target);
        ReleaseDC(None, desktop);
        if failed {
            Err("采集失败，已丢弃整帧".into())
        } else {
            Ok(rgb)
        }
    }
}
fn has_authorized_signal(scene: &Scene, image: &RgbImage) -> bool {
    // A few cursor/HUD pixels cannot establish that a fullscreen game was
    // captured. Measure only authorized pixels; try the next local capture
    // backend if virtually all of that region is black.
    visibility(scene, image)["litPercent"].as_u64().unwrap_or(0) >= 3
}
#[cfg(test)]
#[test]
fn sparse_hud_does_not_hide_a_failed_black_capture() {
    let scene = Scene { width: 80, height: 45,
        regions: vec![Rect { left: 0, top: 0, right: 80, bottom: 45 }],
        sources: vec![], proof: String::new(), denial_reason: String::new(), authorized_windows: vec![] };
    let mut image = RgbImage::new(80, 45);
    image.put_pixel(20, 20, image::Rgb([255,255,255]));
    assert!(!has_authorized_signal(&scene, &image));
    for y in 0..45 { for x in 0..20 { image.put_pixel(x, y, image::Rgb([30,40,50])); } }
    assert!(has_authorized_signal(&scene, &image));
}
fn dxgi_pixels(scene: &Scene, width: u32) -> Result<RgbImage, String> {
    unsafe {
        // Choose the adapter that actually owns the primary desktop output.
        // Creating a device on the default adapter first can select the wrong
        // GPU on hybrid/NVIDIA systems, making Desktop Duplication return a
        // valid but completely black frame for borderless fullscreen games.
        let factory: IDXGIFactory1 =
            CreateDXGIFactory1().map_err(|_| "DXGI 无法创建显卡工厂".to_string())?;
        let mut selected_adapter: Option<IDXGIAdapter> = None;
        let mut selected_output: Option<IDXGIOutput> = None;
        'adapters: for adapter_index in 0..16 {
            let Ok(adapter1) = factory.EnumAdapters1(adapter_index) else {
                break;
            };
            let adapter: IDXGIAdapter = adapter1.cast().map_err(|_| "DXGI 显卡适配器接口不可用")?;
            for output_index in 0..16 {
                let Ok(output) = adapter.EnumOutputs(output_index) else {
                    break;
                };
                let desc = output.GetDesc().map_err(|_| "DXGI 显示器信息不可用")?;
                let rect = desc.DesktopCoordinates;
                if desc.AttachedToDesktop.as_bool()
                    && rect.left == 0
                    && rect.top == 0
                    && rect.right - rect.left == scene.width
                    && rect.bottom - rect.top == scene.height
                {
                    selected_adapter = Some(adapter.clone());
                    selected_output = Some(output);
                    break 'adapters;
                }
            }
        }
        let adapter = selected_adapter.ok_or("DXGI 未找到与白名单坐标一致的主显示器适配器")?;
        let output = selected_output.ok_or("DXGI 主显示器输出不可用")?;
        let mut device = None;
        let mut context = None;
        D3D11CreateDevice(
            Some(&adapter),
            D3D_DRIVER_TYPE_UNKNOWN,
            windows::Win32::Foundation::HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
        .map_err(|_| "DXGI 无法创建桌面采集设备".to_string())?;
        let device = device.ok_or("DXGI 采集设备不可用")?;
        let context = context.ok_or("DXGI 采集上下文不可用")?;
        let output1: IDXGIOutput1 = output.cast().map_err(|_| "DXGI 显示器接口不支持画面复制")?;
        let duplication = output1
            .DuplicateOutput(&device)
            .map_err(|_| "DXGI 无法复制主显示器画面".to_string())?;
        let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource = None;
        duplication
            .AcquireNextFrame(500, &mut frame_info, &mut resource)
            .map_err(|error| {
                if error.code() == DXGI_ERROR_WAIT_TIMEOUT {
                    "DXGI 暂无新显示器帧；等待下一次本地采样".to_string()
                } else if error.code() == DXGI_ERROR_ACCESS_LOST {
                    "DXGI 显示模式已变化；下一次采样会重新连接".to_string()
                } else {
                    "DXGI 无法读取显示器帧".to_string()
                }
            })?;
        let copy = (|| {
            let resource = resource.ok_or("DXGI 没有返回显示器帧")?;
            let frame: ID3D11Texture2D = resource.cast().map_err(|_| "DXGI 帧格式不可读")?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            frame.GetDesc(&mut desc);
            if desc.Width != scene.width as u32 || desc.Height != scene.height as u32 {
                return Err("DXGI 帧尺寸与主显示器不一致".to_string());
            }
            desc.Usage = D3D11_USAGE_STAGING;
            desc.BindFlags = 0;
            desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
            desc.MiscFlags = 0;
            let mut staging = None;
            device
                .CreateTexture2D(&desc, None, Some(&mut staging))
                .map_err(|_| "DXGI 无法创建只读帧缓冲".to_string())?;
            let staging = staging.ok_or("DXGI 只读帧缓冲不可用")?;
            let staging_resource: ID3D11Resource =
                staging.cast().map_err(|_| "DXGI 帧缓冲接口不可用")?;
            let frame_resource: ID3D11Resource =
                frame.cast().map_err(|_| "DXGI 原始帧接口不可用")?;
            context.CopyResource(&staging_resource, &frame_resource);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            context
                .Map(&staging_resource, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .map_err(|_| "DXGI 无法读取只读帧缓冲".to_string())?;
            let output_height =
                ((width as f64 * scene.height as f64 / scene.width as f64).round() as u32).max(1);
            let mut image = RgbImage::new(width, output_height);
            let bytes = mapped.pData as *const u8;
            let sx = width as f64 / scene.width as f64;
            let sy = output_height as f64 / scene.height as f64;
            for region in &scene.regions {
                let left = (region.left as f64 * sx).ceil() as u32;
                let top = (region.top as f64 * sy).ceil() as u32;
                let right = (region.right as f64 * sx).floor().min(width as f64) as u32;
                let bottom = (region.bottom as f64 * sy)
                    .floor()
                    .min(output_height as f64) as u32;
                for y in top..bottom {
                    let src_y = ((y as f64 / sy).floor() as u32).min(desc.Height - 1);
                    let row = std::slice::from_raw_parts(
                        bytes.add(src_y as usize * mapped.RowPitch as usize),
                        mapped.RowPitch as usize,
                    );
                    for x in left..right {
                        let src_x =
                            ((x as f64 / sx).floor() as u32).min(desc.Width - 1) as usize * 4;
                        image.put_pixel(
                            x,
                            y,
                            image::Rgb([row[src_x + 2], row[src_x + 1], row[src_x]]),
                        );
                    }
                }
            }
            context.Unmap(&staging_resource, 0);
            Ok(image)
        })();
        let _ = duplication.ReleaseFrame();
        copy
    }
}
fn print_window_pixels(scene: &Scene, width: u32) -> Result<RgbImage, String> {
    unsafe {
        let height =
            ((width as f64 * scene.height as f64 / scene.width as f64).round() as u32).max(1);
        let mut result = RgbImage::new(width, height);
        let mut printed = false;
        for window in &scene.authorized_windows {
            let hwnd = window.hwnd;
            let mut bounds = RECT::default();
            if GetWindowRect(hwnd, &mut bounds).is_err() {
                continue;
            }
            let window_width = (bounds.right - bounds.left).max(1) as u32;
            let window_height = (bounds.bottom - bounds.top).max(1) as u32;
            let dpi_scale = (GetDpiForWindow(hwnd).max(96) as f64) / 96.0;
            let scale_x = if bounds.left <= 0 && window_width as f64 > scene.width as f64 * 1.2 {
                window_width as f64 / scene.width as f64
            } else {
                dpi_scale
            };
            let scale_y = if bounds.top <= 0 && window_height as f64 > scene.height as f64 * 1.2 {
                window_height as f64 / scene.height as f64
            } else {
                dpi_scale
            };
            let desktop = GetDC(None);
            if desktop.is_invalid() {
                continue;
            }
            let target = CreateCompatibleDC(Some(desktop));
            if target.is_invalid() {
                ReleaseDC(None, desktop);
                continue;
            }
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: window_width as i32,
                    biHeight: -(window_height as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let Ok(bitmap) =
                CreateDIBSection(Some(desktop), &info, DIB_RGB_COLORS, &mut bits, None, 0)
            else {
                let _ = DeleteDC(target);
                ReleaseDC(None, desktop);
                continue;
            };
            let old = SelectObject(target, bitmap.into());
            let ok = PrintWindow(hwnd, target, PRINT_WINDOW_FLAGS(2)).as_bool();
            if ok && !bits.is_null() {
                printed = true;
                let bytes = std::slice::from_raw_parts(
                    bits as *const u8,
                    (window_width * window_height * 4) as usize,
                );
                let sx = width as f64 / scene.width as f64;
                let sy = height as f64 / scene.height as f64;
                let own_scene = Scene { regions:window.regions.clone(), ..scene.clone() };
                for region in scaled_regions(&own_scene, width, height) {
                    let left = region.left.max(0) as u32;
                    let top = region.top.max(0) as u32;
                    let right = region.right.min(width as i32).max(0) as u32;
                    let bottom = region.bottom.min(height as i32).max(0) as u32;
                    for y in top..bottom {
                        let scene_y = ((y as f64 + 0.5) / sy).floor() as i32;
                        let source_y =
                            (scene_y as f64 * scale_y - bounds.top as f64).floor() as i32;
                        if source_y < 0 || source_y >= window_height as i32 {
                            continue;
                        }
                        let row_offset = source_y as usize * window_width as usize * 4;
                        for x in left..right {
                            let scene_x = ((x as f64 + 0.5) / sx).floor() as i32;
                            let source_x =
                                (scene_x as f64 * scale_x - bounds.left as f64).floor() as i32;
                            if source_x < 0 || source_x >= window_width as i32 {
                                continue;
                            }
                            let offset = row_offset + source_x as usize * 4;
                            let p = &bytes[offset..offset + 4];
                            result.put_pixel(x, y, image::Rgb([p[2], p[1], p[0]]));
                        }
                    }
                }
            }
            SelectObject(target, old);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(target);
            ReleaseDC(None, desktop);
        }
        if printed {
            Ok(result)
        } else {
            Err("窗口级 PrintWindow 采集失败".into())
        }
    }
}
fn pixels(scene: &Scene, width: u32, show_capture_border: bool) -> Result<(RgbImage, &'static str), String> {
    if scene.authorized_windows.iter().any(|w|w.behind_ignored_window) {
        // Desktop capture contains ignored overlay pixels. Window capture reads the
        // underlying application and copies only its own locally authorized regions.
        // Never fall back to the composited desktop when exclusion cannot be honored.
        let height=((width as f64*scene.height as f64/scene.width as f64).round() as u32).max(1);
        let mut image=RgbImage::new(width,height);
        let deadline=std::time::Instant::now()+std::time::Duration::from_millis(1800);
        crate::window_capture::with_device(|device|{
            for window in &scene.authorized_windows {
                device.copy_window(window.hwnd,&mut image,(scene.width,scene.height),&window.regions,deadline,show_capture_border)?;
            }
            Ok(())
        })?;
        return Ok((image,"wgc"));
    }
    crate::window_capture::release_device();
    match gdi_pixels(scene, width) {
        Ok(image) if has_authorized_signal(scene, &image) => Ok((image, "gdi")),
        Ok(image) => match dxgi_pixels(scene, width) {
            Ok(fallback) if has_authorized_signal(scene, &fallback) => Ok((fallback, "dxgi")),
            Ok(fallback) => match print_window_pixels(scene, width) {
                Ok(window) if has_authorized_signal(scene, &window) => Ok((window, "printwindow")),
                _ => Ok((fallback, "dxgi")),
            },
            Err(_) => match print_window_pixels(scene, width) {
                Ok(window) if has_authorized_signal(scene, &window) => Ok((window, "printwindow")),
                _ => Ok((image, "gdi")),
            },
        },
        Err(gdi_error) => match dxgi_pixels(scene, width) {
            Ok(image) => Ok((image, "dxgi")),
            Err(_) => print_window_pixels(scene, width)
                .map(|image| (image, "printwindow"))
                .map_err(|_| gdi_error),
        },
    }
}

#[cfg(test)]
mod capture_acceptance {
    use super::*;
    use std::{sync::mpsc, thread, time::Instant};
    use windows::{core::w, Win32::{Foundation::{HINSTANCE,COLORREF,WPARAM,LPARAM}, System::LibraryLoader::GetModuleHandleW}};

    // Synthetic windows only. No image is persisted or sent to an inference provider.
    unsafe extern "system" fn paint(hwnd:HWND,message:u32,w:windows::Win32::Foundation::WPARAM,l:windows::Win32::Foundation::LPARAM)->windows::Win32::Foundation::LRESULT {
        unsafe {
            if message==WM_PAINT {
                let mut ps=PAINTSTRUCT::default();let dc=BeginPaint(hwnd,&mut ps);
                let brush=CreateSolidBrush(COLORREF(GetWindowLongPtrW(hwnd,GWLP_USERDATA) as u32));
                let _=FillRect(dc,&ps.rcPaint,brush);let _=DeleteObject(brush.into());let _=EndPaint(hwnd,&ps);
                return windows::Win32::Foundation::LRESULT(0);
            }
            DefWindowProcW(hwnd,message,w,l)
        }
    }
    struct Fixture { target:HWND, overlay:HWND, thread_id:u32, worker:Option<thread::JoinHandle<()>> }
    impl Drop for Fixture {fn drop(&mut self){unsafe{let _=PostThreadMessageW(self.thread_id,WM_QUIT,WPARAM(0),LPARAM(0));}if let Some(t)=self.worker.take(){let _=t.join();}}}
    impl Fixture {fn open()->Self {
        let (tx,rx)=mpsc::sync_channel(1);
        let worker=thread::spawn(move||unsafe{
            initialize();let module=GetModuleHandleW(None).unwrap();let instance=HINSTANCE(module.0);
            let class=w!("EchoCaptureAcceptanceFixture");
            let _=RegisterClassW(&WNDCLASSW{lpfnWndProc:Some(paint),hInstance:instance,lpszClassName:class,..Default::default()});
            let target=CreateWindowExW(WS_EX_TOOLWINDOW,class,w!("Allowed capture fixture"),WS_POPUP,80,80,360,240,None,None,Some(instance),None).unwrap();
            SetWindowLongPtrW(target,GWLP_USERDATA,0x0028b414);
            let overlay=CreateWindowExW(WS_EX_TOOLWINDOW,class,w!("Excluded capture fixture"),WS_POPUP,160,140,100,80,None,None,Some(instance),None).unwrap();
            SetWindowLongPtrW(overlay,GWLP_USERDATA,0x00d214e6);
            let _=SetWindowPos(target,Some(HWND_TOPMOST),80,80,360,240,SWP_NOACTIVATE|SWP_SHOWWINDOW);
            let _=SetWindowPos(overlay,Some(HWND_TOPMOST),160,140,100,80,SWP_NOACTIVATE|SWP_SHOWWINDOW);
            let _=UpdateWindow(target);let _=UpdateWindow(overlay);
            tx.send((target.0 as usize,overlay.0 as usize,GetCurrentThreadId())).unwrap();
            let mut message=MSG::default();while GetMessageW(&mut message,None,0,0).as_bool(){let _=TranslateMessage(&message);DispatchMessageW(&message);}
            let _=DestroyWindow(overlay);let _=DestroyWindow(target);
        });
        let (target,overlay,thread_id)=rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        Self{target:HWND(target as *mut c_void),overlay:HWND(overlay as *mut c_void),thread_id,worker:Some(worker)}
    }}
    #[test]
    #[ignore = "requires an interactive Windows desktop; run explicitly during native acceptance"]
    fn excluded_overlay_is_removed_without_revealing_masked_pixels(){unsafe{
        initialize();let fixture=Fixture::open();let _=windows::Win32::Graphics::Dwm::DwmFlush();
        let screen=(GetSystemMetrics(SM_CXSCREEN),GetSystemMetrics(SM_CYSCREEN));
        let bounds=Rect{left:80,top:80,right:440,bottom:320};
        // Model an unapproved occluder with a hole in this window's admitted regions.
        let private=Rect{left:300,top:240,right:400,bottom:300};
        let regions=bounds.subtract(private);
        let scene=Scene{width:screen.0,height:screen.1,regions:regions.clone(),sources:vec![],proof:String::new(),denial_reason:String::new(),
            authorized_windows:vec![AuthorizedWindow{hwnd:fixture.target,regions,behind_ignored_window:true}]};
        let desktop=gdi_pixels(&scene,screen.0 as u32).unwrap();
        assert_eq!(desktop.get_pixel(200,180).0,[230,20,210],"fixture overlay must be present in desktop capture");
        let start=Instant::now();let (image,backend)=pixels(&scene,screen.0 as u32,true).unwrap();
        assert_eq!(backend,"wgc");
        assert_eq!(image.get_pixel(200,180).0,[20,180,40],"must recover underlying target pixels");
        assert_eq!(image.get_pixel(350,270).0,[0,0,0],"unapproved content must remain masked");
        assert_eq!(image.get_pixel(20,20).0,[0,0,0],"outside target must remain masked");
        SetWindowLongPtrW(fixture.overlay,GWL_EXSTYLE,GetWindowLongPtrW(fixture.overlay,GWL_EXSTYLE)|WS_EX_LAYERED.0 as isize);
        let _=SetLayeredWindowAttributes(fixture.overlay,COLORREF(0),128,LWA_ALPHA);
        let _=windows::Win32::Graphics::Dwm::DwmFlush();
        let (transparent,backend)=pixels(&scene,screen.0 as u32,true).unwrap();
        assert_eq!(backend,"wgc");
        assert_eq!(transparent.get_pixel(200,180).0,[20,180,40],"transparent overlay must also be excluded");
        let (borderless,backend)=pixels(&scene,screen.0 as u32,false).unwrap();
        assert_eq!(backend,"wgc");
        assert_eq!(borderless.get_pixel(200,180).0,[20,180,40],"borderless capture must still exclude overlays");
        assert_eq!(borderless.get_pixel(350,270).0,[0,0,0],"borderless capture must retain privacy masks");
        let invalid=Scene{authorized_windows:vec![AuthorizedWindow{hwnd:HWND(1usize as *mut c_void),regions:scene.regions.clone(),behind_ignored_window:true}],..scene.clone()};
        assert!(pixels(&invalid,320,true).is_err(),"failed exclusion must never fall back to desktop pixels");
        let own_path=process_path(fixture.target);
        assert!(!own_path.is_empty(),"fixture process must be identifiable");
        let excluded=Rule{id:"custom-overlay".into(),r#type:"process".into(),value:own_path,title:"Excluded capture fixture".into(),enabled:true};
        assert!(rule_matches_window(&excluded,&process_path(fixture.overlay),&title(fixture.overlay)));
        assert!(!rule_matches_window(&excluded,&process_path(fixture.target),&title(fixture.target)));
        let disabled=Rule{enabled:false,..excluded};
        assert!(!rule_matches_window(&disabled,&process_path(fixture.overlay),&title(fixture.overlay)));
        println!("window exclusion snapshot: {} ms; recovered target and retained all masks",start.elapsed().as_millis());
    }}
}
fn signature(image: &RgbImage) -> Vec<u8> {
    let mut result = Vec::with_capacity(80 * 45 * 3);
    for y in 0..45 {
        for x in 0..80 {
            let p = image.get_pixel(
                (x * image.width() / 80).min(image.width() - 1),
                (y * image.height() / 45).min(image.height() - 1),
            );
            let r = p[0] as f32 / 255.;
            let g = p[1] as f32 / 255.;
            let b = p[2] as f32 / 255.;
            let max = r.max(g).max(b);
            let min = r.min(g).min(b);
            let d = max - min;
            let hue = if d == 0. {
                0.
            } else if max == r {
                ((g - b) / d).rem_euclid(6.)
            } else if max == g {
                (b - r) / d + 2.
            } else {
                (r - g) / d + 4.
            };
            result.extend([
                (hue / 6. * 255.) as u8,
                (if max == 0. { 0. } else { d / max * 255. }) as u8,
                (max * 255.) as u8,
            ]);
        }
    }
    result
}
pub fn handle(method: &str, params: &Value) -> Result<Value, String> {
    let rules: Vec<Rule> =
        serde_json::from_value(params.get("allowlist").cloned().unwrap_or(json!([])))
            .map_err(|_| "白名单格式无效")?;
    if rules.len() > 100 {
        return Err("白名单过长".into());
    }
    let browser_rules: Vec<Rule> = serde_json::from_value(
        params
            .get("browserAllowlist")
            .cloned()
            .unwrap_or(json!([])),
    )
    .map_err(|_| "浏览器白名单格式无效")?;
    if browser_rules.len() > 32 {
        return Err("浏览器白名单过长".into());
    }
    let occlusion_rules: Vec<Rule> = serde_json::from_value(
        params
            .get("occlusionAllowlist")
            .cloned()
            .unwrap_or(json!([])),
    )
    .map_err(|_| "遮挡豁免窗口格式无效")?;
    if occlusion_rules.len() > 50 {
        return Err("遮挡豁免窗口过长".into());
    }
    if !input_desktop_active() {
        return Ok(json!({"allowed":false,"sources":[],"reason":"当前不是可交互桌面"}));
    }
    let before = scene(&rules, &browser_rules, &occlusion_rules)?;
    if before.regions.is_empty() {
        crate::window_capture::release_device();
        let reason = if before.denial_reason.is_empty() {
            "没有可见的白名单内容"
        } else {
            &before.denial_reason
        };
        return Ok(json!({"allowed":false,"sources":[],"reason":reason}));
    }
    let show_capture_border=params.get("showCaptureBorder").and_then(Value::as_bool).unwrap_or(false);
    if !show_capture_border && before.authorized_windows.iter().any(|w|w.behind_ignored_window) {
        if let Some(reason)=crate::window_capture::borderless_issue(crate::window_capture::borderless_access()) {
            return Ok(json!({"allowed":false,"sources":[],"reason":reason}));
        }
    }
    if method == "probe" {
        let (image, capture_backend) = pixels(&before, 320, show_capture_border)?;
        let after = scene(&rules, &browser_rules, &occlusion_rules)?;
        if before.proof != after.proof {
            return Ok(json!({"allowed":false,"sources":[],"reason":"窗口切换中"}));
        }
        return Ok(
            json!({"allowed":true,"signature":STANDARD.encode(signature(&image)),"sources":before.sources,"proof":before.proof,"visibility":visibility(&before,&image),"captureBackend":capture_backend,"captureBorder":capture_backend=="wgc"&&show_capture_border}),
        );
    }
    if method == "capture" {
        if params.get("proof").and_then(Value::as_str) != Some(&before.proof) {
            return Ok(json!({"allowed":false,"reason":"授权场景已变化"}));
        }
        let width = params
            .get("width")
            .and_then(Value::as_u64)
            .unwrap_or(840)
            .clamp(280, 1600) as u32;
        let quality = params
            .get("quality")
            .and_then(Value::as_u64)
            .unwrap_or(75)
            .clamp(35, 95) as u8;
        let (image, capture_backend) = pixels(&before, width, show_capture_border)?;
        let after = scene(&rules, &browser_rules, &occlusion_rules)?;
        if before.proof != after.proof {
            return Ok(json!({"allowed":false,"reason":"采集期间窗口发生变化"}));
        }
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, quality)
            .encode_image(&image)
            .map_err(|_| "JPEG 编码失败")?;
        return Ok(
            json!({"allowed":true,"jpeg":STANDARD.encode(jpeg),"timestamp":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"sources":before.sources,"visibility":visibility(&before, &image),"captureBackend":capture_backend,"captureBorder":capture_backend=="wgc"&&show_capture_border}),
        );
    }
    Err("未知原生操作".into())
}
