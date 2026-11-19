use super::{input_desktop_active, process_path, title};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::VecDeque;
use windows::{
    Win32::{
        Foundation::HWND,
        System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance},
        UI::{
            Accessibility::*,
            WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
        },
    },
    core::{BSTR, Interface},
};

struct Snapshot {
    hwnd: HWND,
    pid: u32,
    root: IUIAutomationElement,
    elements: Vec<IUIAutomationElement>,
}
thread_local! { static LAST:RefCell<Option<Snapshot>>=const {RefCell::new(None)}; }

fn foreground(params: &Value) -> Result<(HWND, u32), String> {
    if !input_desktop_active() {
        return Err("当前桌面不可用".into());
    }
    let hwnd = unsafe { GetForegroundWindow() };
    let path = process_path(hwnd);
    let granted = params["allowed"]
        .as_array()
        .is_some_and(|rows| rows.iter().any(|v| v.as_str() == Some(&path)));
    if hwnd.0.is_null() || path.is_empty() || !granted {
        return Err("前台应用未获授权".into());
    }
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    Ok((hwnd, pid))
}
fn safe_element(element: &IUIAutomationElement, pid: u32) -> bool {
    unsafe {
        element.CurrentProcessId().ok() == Some(pid as i32)
            && element.CurrentIsPassword().is_ok_and(|v| !v.as_bool())
            && element.CurrentIsOffscreen().is_ok_and(|v| !v.as_bool())
    }
}
pub(super) fn handle(method: &str, params: &Value) -> Result<Value, String> {
    let (hwnd, pid) = foreground(params)?;
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|_| "Windows 辅助功能不可用")?;
    let walker = unsafe { automation.ControlViewWalker() }.map_err(|_| "控件树不可用")?;
    if method == "desktop.inspect" {
        LAST.with_borrow_mut(|slot| *slot = None);
        let root = unsafe { automation.ElementFromHandle(hwnd) }.map_err(|_| "窗口不可访问")?;
        let mut queue = VecDeque::from([root.clone()]);
        let mut elements = Vec::new();
        let mut rows = Vec::new();
        while let Some(el) = queue.pop_front() {
            if !safe_element(&el, pid) {
                continue;
            }
            let index = elements.len();
            let name = unsafe { el.CurrentName() }
                .map(|s| s.to_string().chars().take(180).collect::<String>())
                .unwrap_or_default();
            let kind = unsafe { el.CurrentLocalizedControlType() }
                .map(|s| s.to_string())
                .unwrap_or_default();
            let invoke = unsafe { el.GetCurrentPattern(UIA_InvokePatternId) }.is_ok();
            let fill = unsafe { el.GetCurrentPattern(UIA_ValuePatternId) }
                .and_then(|p| p.cast::<IUIAutomationValuePattern>())
                .is_ok_and(|p| unsafe { p.CurrentIsReadOnly() }.is_ok_and(|v| !v.as_bool()));
            rows.push(json!({"index":index,"name":name,"kind":kind,"invoke":invoke,"fill":fill}));
            elements.push(el.clone());
            if elements.len() >= 200 {
                break;
            }
            let mut child = unsafe { walker.GetFirstChildElement(&el) }.ok();
            while let Some(c) = child {
                if queue.len() + elements.len() >= 200 {
                    break;
                }
                child = unsafe { walker.GetNextSiblingElement(&c) }.ok();
                queue.push_back(c);
            }
        }
        if foreground(params)? != (hwnd, pid) {
            return Err("前台窗口已改变".into());
        }
        let window_title = title(hwnd);
        LAST.with_borrow_mut(|slot| {
            *slot = Some(Snapshot {
                hwnd,
                pid,
                root,
                elements,
            })
        });
        return Ok(json!({"window":window_title,"controls":rows}));
    }
    if method != "desktop.act" {
        return Err("未知操作".into());
    }
    let snap = LAST
        .with_borrow_mut(Option::take)
        .ok_or("请先观察前台窗口")?;
    if snap.hwnd != hwnd || snap.pid != pid {
        return Err("前台窗口已改变".into());
    }
    let i = params["index"].as_u64().ok_or("控件编号无效")? as usize;
    let el = snap.elements.get(i).ok_or("控件已失效")?;
    if !safe_element(el, pid) || !unsafe { el.CurrentIsEnabled() }.is_ok_and(|v| v.as_bool()) {
        return Err("控件不可操作".into());
    }
    let mut cursor = Some(el.clone());
    let mut same_root = false;
    for _ in 0..64 {
        let Some(node) = cursor else { break };
        if unsafe { automation.CompareElements(&node, &snap.root) }.is_ok_and(|b| b.as_bool()) {
            same_root = true;
            break;
        }
        cursor = unsafe { walker.GetParentElement(&node) }.ok();
    }
    if !same_root || foreground(params)? != (hwnd, pid) {
        return Err("控件已移出授权窗口".into());
    }
    match params["action"].as_str() {
        Some("invoke") => unsafe {
            el.GetCurrentPattern(UIA_InvokePatternId)
                .and_then(|p| p.cast::<IUIAutomationInvokePattern>())
                .and_then(|p| p.Invoke())
        },
        Some("fill") => {
            let text = params["text"]
                .as_str()
                .filter(|v| v.chars().count() <= 8000)
                .ok_or("文字无效")?;
            unsafe {
                el.GetCurrentPattern(UIA_ValuePatternId)
                    .and_then(|p| p.cast::<IUIAutomationValuePattern>())
                    .and_then(|p| p.SetValue(&BSTR::from(text)))
            }
        }
        _ => return Err("未知控件操作".into()),
    }
    .map_err(|_| "控件操作未完成")?;
    Ok(json!({"completed":true}))
}
