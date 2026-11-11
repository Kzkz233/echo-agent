#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(windows)]
mod desktop {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use echo_native::avatar_motion::{Motion, Phase};
    use image::imageops::{FilterType, crop_imm, resize};
    use image::{DynamicImage, ImageDecoder, codecs::png::PngDecoder};
    use serde_json::{Value, json};
    use std::{
        collections::HashMap,
        ffi::c_void,
        fs,
        io::{self, BufRead, Cursor},
        mem::size_of,
        ptr,
        sync::mpsc,
        time::Instant,
    };
    use windows::{
        Win32::{
            Foundation::*,
            Graphics::{Dwm::*, Gdi::*},
            System::LibraryLoader::GetModuleHandleW,
            UI::{HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
        },
        core::w,
    };
    const INPUT: u32 = WM_APP + 1;
    struct FrameClip {
        frames: Vec<Vec<u8>>,
        fps: u64,
    }
    struct Canvas {
        dc: HDC,
        bitmap: HBITMAP,
        old: HGDIOBJ,
        bits: *mut c_void,
        w: i32,
        h: i32,
        clips: HashMap<String, FrameClip>,
        fps: u64,
        fps_override: Option<u64>,
    }
    impl Drop for Canvas {
        fn drop(&mut self) {
            unsafe {
                SelectObject(self.dc, self.old);
                let _ = DeleteObject(self.bitmap.into());
                let _ = DeleteDC(self.dc);
            }
        }
    }
    struct State {
        rx: mpsc::Receiver<Value>,
        canvas: Option<Canvas>,
        started: Instant,
        working: bool,
        playing: String,
        scene: Option<Motion>,
        scene_start: Instant,
        last_tick: Instant,
        next_work_area_check: Instant,
        grab_offset: Option<POINT>,
        track_button: bool,
        motion: [String; 3],
        state_rules: Vec<echo_native::avatar_activity::Rule>,
        active_states: Vec<String>,
        hwnd: HWND,
        bubble: HWND,
        composer: HWND,
        edit: HWND,
        edit_proc: WNDPROC,
        ime_active: bool,
        english: bool,
        font: HFONT,
        small_font: HFONT,
        card_brush: HBRUSH,
        composer_issue: String,
        text: String,
        bubble_image: Option<image::RgbaImage>,
        bubble_image_painted: bool,
        conversation: String,
        conversation_title: String,
        default_conversation: String,
        default_title: String,
        reply_conversation: String,
        reply_title: String,
        reply_sequence: u64,
        pending_reply: Option<String>,
        instance: String,
        expires: Option<Instant>,
        docked: bool,
        scale: f64,
        paints: u64,
        left: bool,
        slot: u32,
        home_offset: Option<f64>,
    }
    fn utf(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    fn respond(id: Value, result: Value) {
        println!("{}", json!({"jsonrpc":"2.0","id":id,"result":result}));
    }
    fn error(id: Value, reason: &str) {
        println!(
            "{}",
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":reason}})
        );
    }
    unsafe fn load(
        directory: &str,
        scale: f64,
        renderer: &str,
        motion: &[String],
        fps_override: Option<u64>,
    ) -> Result<Canvas, Box<dyn std::error::Error>> {
        unsafe {
            let root = std::path::Path::new(directory);
            if renderer != "frames" {
                return Err("unknown renderer".into());
            }
            let dimensions = image::image_dimensions(root.join("atlas.png"))?;
            if dimensions.0 as u64 * dimensions.1 as u64 > 64_000_000 {
                return Err("atlas pixel budget exceeded".into());
            }
            let manifest: Value = serde_json::from_slice(&fs::read(root.join("manifest.json"))?)?;
            if manifest["format"].as_str() != Some("frame-atlas-v1") {
                return Err("expected frame-atlas-v1 material".into());
            }
            let atlas = image::open(root.join("atlas.png"))?.into_rgba8();
            let idle = manifest["clips"]["idle"]["frames"]
                .as_array()
                .ok_or("idle frames absent")?;
            let first = idle.first().ok_or("idle frames absent")?;
            let w = (first["w"].as_u64().ok_or("width")? as f64 * scale).round() as i32;
            let h = (first["h"].as_u64().ok_or("height")? as f64 * scale).round() as i32;
            if !(8..=2048).contains(&w) || !(8..=2048).contains(&h) {
                return Err("frame dimensions invalid".into());
            }
            let mut clips = HashMap::new();
            let mut total_frames = 0usize;
            for name in ["idle", "walk"].into_iter().chain(motion.iter().map(String::as_str))
            {
                if clips.contains_key(name) {
                    continue;
                }
                let Some(frames) = manifest["clips"][name]["frames"].as_array() else {
                    continue;
                };
                if frames.is_empty() || frames.len() > 120 {
                    return Err("frame count invalid".into());
                }
                total_frames += frames.len();
                if w as u64 * h as u64 * 4 * total_frames as u64 > 64 * 1024 * 1024 {
                    return Err("decoded frame budget exceeded".into());
                }
                let mut decoded = Vec::with_capacity(frames.len());
                let coord =
                    |f: &Value, key: &str| -> Option<u32> { u32::try_from(f[key].as_u64()?).ok() };
                for f in frames {
                    let x = coord(f, "x").ok_or("x")?;
                    let y = coord(f, "y").ok_or("y")?;
                    let cw = coord(f, "w").ok_or("w")?;
                    let ch = coord(f, "h").ok_or("h")?;
                    if cw == 0
                        || ch == 0
                        || x.checked_add(cw).is_none_or(|end| end > atlas.width())
                        || y.checked_add(ch).is_none_or(|end| end > atlas.height())
                    {
                        return Err("atlas frame outside image".into());
                    }
                    let crop = crop_imm(&atlas, x, y, cw, ch).to_image();
                    let mut bytes =
                        resize(&crop, w as u32, h as u32, FilterType::Triangle).into_raw();
                    for p in bytes.chunks_exact_mut(4) {
                        let alpha = p[3] as u16;
                        let red = p[0];
                        p[0] = (p[2] as u16 * alpha / 255) as u8;
                        p[1] = (p[1] as u16 * alpha / 255) as u8;
                        p[2] = (red as u16 * alpha / 255) as u8;
                    }
                    decoded.push(bytes);
                }
                let fps = manifest["clips"][name]["fps"]
                    .as_u64()
                    .unwrap_or(10)
                    .clamp(1, 30);
                let fps = fps_override.unwrap_or(fps).clamp(1, 30);
                clips.insert(
                    name.to_owned(),
                    FrameClip {
                        frames: decoded,
                        fps,
                    },
                );
            }
            let fps = clips["idle"].fps;
            create_canvas(w, h, clips, fps, fps_override)
        }
    }
    unsafe fn create_canvas(
        w: i32,
        h: i32,
        clips: HashMap<String, FrameClip>,
        fps: u64,
        fps_override: Option<u64>,
    ) -> Result<Canvas, Box<dyn std::error::Error>> {
        unsafe {
            let dc = CreateCompatibleDC(None);
            let mut info = BITMAPINFO::default();
            info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
            info.bmiHeader.biWidth = w;
            info.bmiHeader.biHeight = -h;
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            let mut bits = ptr::null_mut();
            let bitmap = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)?;
            let old = SelectObject(dc, bitmap.into());
            Ok(Canvas {
                dc,
                bitmap,
                old,
                bits,
                w,
                h,
                clips,
                fps,
                fps_override,
            })
        }
    }
    unsafe fn work_area(s: &State) -> Option<[f64; 4]> {
        unsafe {
            let c = s.canvas.as_ref()?;
            let mut area = RECT::default();
            if SystemParametersInfoW(
                SPI_GETWORKAREA,
                0,
                Some((&mut area as *mut RECT).cast()),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
            .is_err()
            {
                return None;
            }
            let margin = dip(s, 12.);
            let left = area.left + margin;
            let top = area.top + margin;
            let right = (area.right - c.w - margin).max(left);
            let bottom = (area.bottom - c.h - margin).max(top);
            Some([left, top, right, bottom].map(f64::from))
        }
    }
    unsafe fn position(s: &mut State, roam: bool) {
        unsafe {
            if let (Some(bounds), Some(c)) = (work_area(s), &s.canvas) {
                s.scene_start = Instant::now();
                s.last_tick = s.scene_start;
                let mut scene = Motion::new(
                    bounds,
                    s.left && !s.docked,
                    roam,
                );
                scene.place_slot(s.slot as usize, c.w as f64 + 16. * s.scale, s.left && !s.docked);
                if let Some(offset) = s.home_offset { scene.set_home_offset(offset, s.left && !s.docked); }
                scene.dock(s.docked, 0.);
                let _ = SetWindowPos(
                    s.hwnd,
                    Some(HWND_TOPMOST),
                    scene.x.round() as i32,
                    scene.y.round() as i32,
                    c.w,
                    c.h,
                    SWP_NOACTIVATE,
                );
                s.scene = Some(scene);
            }
        }
    }
    unsafe fn drop_avatar(s: &mut State) {
        s.grab_offset = None;
        s.track_button = false;
        if let Some(scene) = &mut s.scene {
            scene.drop_at(s.scene_start.elapsed().as_secs_f64());
        }
    }
    const BUBBLE_THUMBNAIL: f64 = 72.;
    fn bubble_image(text: &str) -> Option<image::RgbaImage> {
        if text.len() > 2_796_204 {
            return None;
        }
        let bytes = STANDARD.decode(text).ok()?;
        let decoder = PngDecoder::new(Cursor::new(bytes)).ok()?;
        let (w, h) = decoder.dimensions();
        if w == 0 || h == 0 || w > 512 || h > 512 {
            return None;
        }
        let mut image = DynamicImage::from_decoder(decoder)
            .ok()?
            .thumbnail(144, 144)
            .into_rgba8();
        for pixel in image.pixels_mut() {
            let [r, g, b, a] = pixel.0.map(u16::from);
            let on_white = |v| ((v * a + 255 * (255 - a)) / 255) as u8;
            pixel.0 = [on_white(b), on_white(g), on_white(r), 255];
        }
        Some(image)
    }
    fn bubble_image_column(s: &State) -> i32 {
        if s.bubble_image.is_some() {
            dip(s, BUBBLE_THUMBNAIL + 12.)
        } else {
            0
        }
    }
    unsafe fn paint_bubble_image(s: &State, dc: HDC, right: i32) -> bool {
        let Some(image) = &s.bubble_image else {
            return false;
        };
        let (w, h) = (image.width() as i32, image.height() as i32);
        let size = dip(s, BUBBLE_THUMBNAIL);
        let dw = (w * size / w.max(h)).max(1);
        let dh = (h * size / w.max(h)).max(1);
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = w;
        info.bmiHeader.biHeight = -h;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        unsafe {
            StretchDIBits(
                dc,
                right - dip(s, 18.) - dw,
                dip(s, 18.),
                dw,
                dh,
                0,
                0,
                w,
                h,
                Some(image.as_ptr().cast()),
                &info,
                DIB_RGB_COLORS,
                SRCCOPY,
            ) > 0
        }
    }
    unsafe fn bubble_position(s: &State) {
        unsafe {
            let mut rect = RECT::default();
            let _ = GetWindowRect(s.hwnd, &mut rect);
            let w = dip(s, 344.);
            let dc = GetDC(Some(s.bubble));
            let old = SelectObject(dc, s.font.into());
            let mut measured = RECT {
                left: 0,
                top: 0,
                right: w - dip(s, 36.) - bubble_image_column(s),
                bottom: 0,
            };
            let mut text = utf(&s.text);
            let n = text.len() - 1;
            DrawTextW(
                dc,
                &mut text[..n],
                &mut measured,
                DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX,
            );
            SelectObject(dc, old);
            ReleaseDC(Some(s.bubble), dc);
            let content = if s.bubble_image.is_some() {
                measured.bottom.max(dip(s, BUBBLE_THUMBNAIL))
            } else {
                measured.bottom
            };
            let h = (content + dip(s, 62.)).clamp(dip(s, 76.), dip(s, 296.));
            if IsWindowVisible(s.composer).as_bool() {
                let _ = GetWindowRect(s.composer, &mut rect);
            }
            let _ = SetWindowPos(
                s.bubble,
                Some(HWND_TOPMOST),
                (rect.right - w).max(0),
                (rect.top - h - dip(s, 10.)).max(0),
                w,
                h,
                SWP_NOACTIVATE,
            );
            round_window(s.bubble, w, h, dip(s, 20.));
        }
    }
    fn dip(s: &State, value: f64) -> i32 {
        (value * s.scale).round() as i32
    }
    unsafe fn round_window(hwnd: HWND, w: i32, h: i32, radius: i32) {
        unsafe {
            let region = CreateRoundRectRgn(0, 0, w + 1, h + 1, radius, radius);
            // A successful SetWindowRgn transfers ownership to Windows.
            if SetWindowRgn(hwnd, Some(region), true) == 0 {
                let _ = DeleteObject(region.into());
            }
        }
    }
    unsafe fn cancel_composer(s: &mut State) {
        unsafe {
            let _ = ShowWindow(s.composer, SW_HIDE);
            bubble_position(s);
            if s.pending_reply.is_none() {
                let _ = SetWindowTextW(s.edit, w!(""));
                s.reply_conversation.clear();
                s.composer_issue.clear();
            }
        }
    }
    unsafe fn card(s: &State, hwnd: HWND, dc: HDC) {
        unsafe {
            let mut r = RECT::default();
            let _ = GetClientRect(hwnd, &mut r);
            let pen = CreatePen(PS_SOLID, 1, COLORREF(0x00e9e1dc));
            let old_pen = SelectObject(dc, pen.into());
            let old_brush = SelectObject(dc, s.card_brush.into());
            let _ = RoundRect(dc, 0, 0, r.right, r.bottom, dip(s, 20.), dip(s, 20.));
            SelectObject(dc, old_brush);
            SelectObject(dc, old_pen);
            let _ = DeleteObject(pen.into());
            SetBkMode(dc, TRANSPARENT);
        }
    }
    unsafe fn caption(s: &State, dc: HDC, text: &str, mut rect: RECT, color: COLORREF) {
        unsafe {
            let old = SelectObject(dc, s.small_font.into());
            SetTextColor(dc, color);
            let mut text = utf(text);
            let n = text.len() - 1;
            DrawTextW(
                dc,
                &mut text[..n],
                &mut rect,
                DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX,
            );
            SelectObject(dc, old);
        }
    }
    fn activity(s: &State) -> &'static str {
        if s.expires.is_some() {
            "speaking"
        } else if s.working {
            "working"
        } else {
            "idle"
        }
    }
    unsafe fn paint(s: &mut State) -> Result<(), windows::core::Error> {
        unsafe {
            let phase = s.scene.as_ref().map_or(Phase::Idle, |scene| scene.phase);
            let facing_left = s.scene.as_ref().is_some_and(|scene| scene.facing_left);
            let mut active = s.active_states.clone();
            if s.expires.is_some() { active.push("avatar.speaking".into()); }
            if matches!(phase, Phase::Drag) { active.push("avatar.dragging".into()); }
            if matches!(phase, Phase::Roam | Phase::Dock) { active.push("avatar.roaming".into()); }
            if let Some(c) = &mut s.canvas {
                let selected = echo_native::avatar_activity::choose(&s.state_rules, &active, |name| c.clips.contains_key(name));
                // Keep ties deterministic and suppress sub-frame animation churn.
                if s.playing != selected && (s.started.elapsed().as_millis() >= 180 || !c.clips.contains_key(&s.playing)) {
                    s.playing = selected;
                    s.started = Instant::now();
                }
                let clip = &c.clips[&s.playing];
                c.fps = c.fps_override.unwrap_or(clip.fps);
                let index = (s.started.elapsed().as_millis() as u64 * c.fps / 1000) as usize
                    % clip.frames.len();
                let frame = &clip.frames[index];
                ptr::copy_nonoverlapping(frame.as_ptr(), c.bits.cast(), frame.len());
                if facing_left {
                    let stride = c.w as usize;
                    let pixels =
                        std::slice::from_raw_parts_mut(c.bits.cast::<u32>(), stride * c.h as usize);
                    for row in pixels.chunks_exact_mut(stride) {
                        row.reverse();
                    }
                }
                let mut rect = RECT::default();
                let _ = GetWindowRect(s.hwnd, &mut rect);
                let point = POINT {
                    x: s.scene
                        .as_ref()
                        .map_or(rect.left, |scene| scene.x.round() as i32),
                    y: s.scene
                        .as_ref()
                        .map_or(rect.top, |scene| scene.y.round() as i32),
                };
                let size = SIZE { cx: c.w, cy: c.h };
                let source = POINT { x: 0, y: 0 };
                let blend = BLENDFUNCTION {
                    BlendOp: AC_SRC_OVER as u8,
                    BlendFlags: 0,
                    SourceConstantAlpha: 255,
                    AlphaFormat: AC_SRC_ALPHA as u8,
                };
                UpdateLayeredWindow(
                    s.hwnd,
                    None,
                    Some(&point),
                    Some(&size),
                    Some(c.dc),
                    Some(&source),
                    COLORREF(0),
                    Some(&blend),
                    ULW_ALPHA,
                )?;
                if (phase == Phase::Drag || rect.left != point.x || rect.top != point.y)
                    && s.expires.is_some()
                {
                    bubble_position(s);
                }
            }
            s.paints += 1;
            Ok(())
        }
    }
    unsafe fn place_composer(s: &State) {
        unsafe {
            let mut rect = RECT::default();
            let _ = GetWindowRect(s.hwnd, &mut rect);
            let width = dip(s, 344.);
            let height = dip(s, 136.);
            let _ = SetWindowPos(
                s.composer,
                Some(HWND_TOPMOST),
                (rect.right - width).max(0),
                (rect.top - height - dip(s, 10.)).max(0),
                width,
                height,
                SWP_NOACTIVATE,
            );
        }
    }
    unsafe fn compose(s: &mut State) {
        unsafe {
            if GetWindowTextLengthW(s.edit) == 0 {
                let bubble = IsWindowVisible(s.bubble).as_bool();
                s.reply_conversation = if bubble {
                    s.conversation.clone()
                } else {
                    s.default_conversation.clone()
                };
                s.reply_title = if bubble {
                    s.conversation_title.clone()
                } else {
                    s.default_title.clone()
                };
            }
            s.composer_issue.clear();
            let width = dip(s, 344.);
            let height = dip(s, 136.);
            place_composer(s);
            round_window(s.composer, width, height, dip(s, 20.));
            let _ = SetWindowPos(
                s.edit,
                None,
                dip(s, 18.),
                dip(s, 44.),
                width - dip(s, 36.),
                dip(s, 54.),
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
            let _ = ShowWindow(s.bubble, SW_HIDE);
            let _ = ShowWindow(s.composer, SW_SHOWNOACTIVATE);
            let _ = InvalidateRect(Some(s.composer), None, true);
            let _ = SetForegroundWindow(s.composer);
            let _ = SetFocus(Some(s.edit));
        }
    }
    unsafe fn commands(s: &mut State) {
        unsafe {
            while let Ok(v) = s.rx.try_recv() {
                let id = v["id"].clone();
                let p = &v["params"];
                if v.get("method").is_none() {
                    if s.pending_reply
                        .as_deref()
                        .is_some_and(|pending| v["id"].as_str() == Some(pending))
                    {
                        s.pending_reply = None;
                        let _ = EnableWindow(s.edit, true);
                        if v["result"]["accepted"].as_bool() == Some(true) {
                            let _ = SetWindowTextW(s.edit, w!(""));
                            let _ = ShowWindow(s.composer, SW_HIDE);
                            bubble_position(s);
                        } else {
                            s.composer_issue = if s.english {
                                "Not sent. Draft kept; press Enter to retry."
                            } else {
                                "未能发送，草稿已保留，回车重试"
                            }
                            .into();
                            let _ = InvalidateRect(Some(s.composer), None, true);
                        }
                    }
                    continue;
                }
                match v["method"].as_str().unwrap_or("") {
                    "avatar.configure" => {
                        s.english = p["language"].as_str() == Some("en");
                        s.instance = p["instanceId"].as_str().unwrap_or("").into();
                        s.left = p["corner"].as_str() == Some("left");
                        s.slot = p["slot"].as_u64().unwrap_or(0).min(32) as u32;
                        s.home_offset = p["homeOffset"].as_f64();
                        s.default_conversation = p["conversationId"].as_str().unwrap_or("").into();
                        s.default_title = p["conversationTitle"].as_str().unwrap_or("Echo").into();
                        let scale = p["scale"].as_f64().unwrap_or(1.).clamp(0.4, 2.)
                            * 0.75
                            * GetDpiForSystem() as f64
                            / 96.;
                        let motion = ["idle", "working", "speaking"].map(|name| {
                            p["animationClips"][name]
                                .as_str()
                                .unwrap_or("idle")
                                .to_owned()
                        });
                        let fps_override = Some(p["fps"].as_u64().unwrap_or(10).clamp(1, 30));
                        let requested_motion: Vec<String> = motion.iter().cloned().chain(
                            p["stateRules"].as_array().into_iter().flatten()
                                .filter_map(|rule| rule["clip"].as_str().map(str::to_owned))
                        ).collect();
                        match load(
                            p["directory"].as_str().unwrap_or(""),
                            scale,
                            p["renderer"].as_str().unwrap_or("frames"),
                            &requested_motion,
                            fps_override,
                        ) {
                            Ok(canvas) => {
                                s.canvas = Some(canvas);
                                s.motion = motion;
                                s.state_rules = serde_json::from_value(p["stateRules"].clone()).unwrap_or_else(|_| vec![
                                    echo_native::avatar_activity::Rule{id:"avatar.idle".into(),priority:0,clip:s.motion[0].clone(),fallback:String::new()},
                                    echo_native::avatar_activity::Rule{id:"avatar.working".into(),priority:40,clip:s.motion[1].clone(),fallback:"avatar.idle".into()},
                                    echo_native::avatar_activity::Rule{id:"avatar.speaking".into(),priority:70,clip:s.motion[2].clone(),fallback:"avatar.idle".into()},
                                ]);
                                s.playing.clear();
                                s.scale = (GetDpiForSystem() as f64 / 96.).max(1.);
                                position(s, p["roam"].as_bool().unwrap_or(true));
                                let result = paint(s);
                                let _ = ShowWindow(s.hwnd, SW_SHOWNOACTIVATE);
                                if result.is_ok() {
                                    respond(
                                        id,
                                        json!({"ready":true,"pid":std::process::id(),"renderer":"win32"}),
                                    );
                                } else {
                                    error(id, "native paint failed");
                                }
                            }
                            Err(e) => error(id, &format!("cannot decode avatar: {e}")),
                        }
                    }
                    "avatar.activity" => {
                        s.working = p["working"].as_bool().unwrap_or(false);
                        s.active_states = serde_json::from_value(p["states"].clone()).unwrap_or_else(|_| if s.working { vec!["avatar.working".into()] } else { vec![] });
                        let _ = paint(s);
                        respond(id, json!({"activity":activity(s)}));
                    }
                    "avatar.show" => {
                        s.bubble_image = p["image"].as_str().and_then(bubble_image);
                        s.bubble_image_painted = false;
                        s.text = p["text"]
                            .as_str()
                            .unwrap_or("")
                            .chars()
                            .take(1000)
                            .collect();
                        s.conversation = p["conversationId"].as_str().unwrap_or("").into();
                        s.conversation_title =
                            p["conversationTitle"].as_str().unwrap_or("Echo").into();
                        s.expires = Some(
                            Instant::now()
                                + std::time::Duration::from_secs(
                                    p["seconds"].as_u64().unwrap_or(25).clamp(5, 120),
                                ),
                        );
                        bubble_position(s);
                        let _ = InvalidateRect(Some(s.bubble), None, true);
                        let _ = ShowWindow(s.bubble, SW_SHOWNOACTIVATE);
                        let _ = UpdateWindow(s.bubble);
                        respond(
                            id,
                            json!({"shown":true,"imageShown":s.bubble_image_painted}),
                        );
                    }
                    "avatar.dock" => {
                        s.docked = true;
                        if let Some(scene) = &mut s.scene {
                            scene.dock(true, s.scene_start.elapsed().as_secs_f64());
                        }
                        respond(id, json!({"docked":true}));
                    }
                    "avatar.release" => {
                        s.docked = false;
                        if let Some(scene) = &mut s.scene {
                            scene.dock(false, s.scene_start.elapsed().as_secs_f64());
                        }
                        respond(id, json!({"docked":false}));
                    }
                    "avatar.layout" => {
                        let offset = p["homeOffset"].as_f64().unwrap_or(0.).max(0.);
                        s.home_offset = Some(offset);
                        if let Some(scene) = &mut s.scene { scene.set_home_offset(offset, s.left && !s.docked); }
                        let _ = paint(s);
                        respond(id, json!({"ready":true}));
                    }
                    "avatar.status" => {
                        let mut rect = RECT::default();
                        let _ = GetWindowRect(s.hwnd, &mut rect);
                        respond(
                            id,
                            json!({"language":if s.english {"en"} else {"zh-CN"},"renderer":"win32","borderless":GetClassLongPtrW(s.hwnd,GCL_STYLE)&(CS_DROPSHADOW.0 as usize)==0,"animation":"frames","docked":s.docked,"motion":s.scene.as_ref().map(|scene| scene.phase.name()),"roam":s.scene.as_ref().is_some_and(|scene| scene.roam),"pid":std::process::id(),"activity":activity(s),"clip":s.playing,"paints":s.paints,"visible":IsWindowVisible(s.hwnd).as_bool(),"bubbleVisible":IsWindowVisible(s.bubble).as_bool(),"composerVisible":IsWindowVisible(s.composer).as_bool(),"draftLength":GetWindowTextLengthW(s.edit),"imeComposing":s.ime_active,"pendingReply":s.pending_reply.is_some(),"conversationId":s.conversation,"text":s.text,"left":rect.left,"top":rect.top,"width":rect.right-rect.left,"height":rect.bottom-rect.top}),
                        );
                    }
                    "avatar.quit" => {
                        respond(id, json!({"closed":true}));
                        let _ = DestroyWindow(s.hwnd);
                    }
                    _ => error(id, "unknown native operation"),
                }
            }
        }
    }
    unsafe extern "system" fn procedure(
        hwnd: HWND,
        message: u32,
        wp: WPARAM,
        lp: LPARAM,
    ) -> LRESULT {
        unsafe {
            if message == WM_NCCREATE {
                let c = &*(lp.0 as *const CREATESTRUCTW);
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, c.lpCreateParams as isize);
            }
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut State;
            if ptr.is_null() {
                return DefWindowProcW(hwnd, message, wp, lp);
            }
            let s = &mut *ptr;
            match message {
                INPUT => {
                    commands(s);
                    LRESULT(0)
                }
                WM_DISPLAYCHANGE | WM_SETTINGCHANGE | WM_DPICHANGED if hwnd == s.hwnd => {
                    s.next_work_area_check = Instant::now();
                    DefWindowProcW(hwnd, message, wp, lp)
                }
                WM_TIMER if hwnd == s.hwnd => {
                    if s.expires.is_some_and(|e| Instant::now() >= e) {
                        let _ = ShowWindow(s.bubble, SW_HIDE);
                        s.expires = None;
                        s.bubble_image = None;
                        s.bubble_image_painted = false;
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","method":"avatar.dismissed","params":{}})
                        );
                    }
                    let now = Instant::now();
                    let mut work_area_changed = false;
                    if now >= s.next_work_area_check {
                        // Some remote-display changes only update the work area.
                        s.next_work_area_check = now + std::time::Duration::from_secs(3);
                        if let (Some(bounds), Some(scene)) = (work_area(s), &mut s.scene) {
                            work_area_changed = scene.update_bounds(bounds);
                        }
                    }
                    let dt = now.duration_since(s.last_tick).as_secs_f64().min(0.15);
                    s.last_tick = now;
                    if s.track_button {
                        if GetAsyncKeyState(VK_LBUTTON.0 as i32) >= 0 {
                            drop_avatar(s);
                            if GetCapture() == hwnd {
                                let _ = ReleaseCapture();
                            }
                        } else if let (Some(scene), Some(offset)) = (&mut s.scene, s.grab_offset) {
                            let mut pointer = POINT::default();
                            if GetCursorPos(&mut pointer).is_ok() {
                                scene.drag_to(
                                    (pointer.x - offset.x) as f64,
                                    (pointer.y - offset.y) as f64,
                                );
                            }
                        }
                    }
                    if let Some(scene) = &mut s.scene {
                        let occupied = s.working
                            || s.expires.is_some()
                            || IsWindowVisible(s.composer).as_bool();
                        scene.tick(s.scene_start.elapsed().as_secs_f64(), dt, s.scale, occupied);
                    }
                    let _ = paint(s);
                    if work_area_changed && IsWindowVisible(s.composer).as_bool() {
                        place_composer(s);
                    }
                    let fps = s.canvas.as_ref().map(|c| c.fps).unwrap_or(10);
                    let ms = s.started.elapsed().as_millis() as u64;
                    SetTimer(
                        Some(hwnd),
                        1,
                        (1000 / fps - ms % (1000 / fps)).max(1) as u32,
                        None,
                    );
                    LRESULT(0)
                }
                WM_ERASEBKGND if hwnd == s.hwnd => LRESULT(1),
                WM_NCPAINT if hwnd == s.hwnd => LRESULT(0),
                WM_NCHITTEST if hwnd == s.hwnd => {
                    if let Some(c) = &s.canvas {
                        let mut p = POINT {
                            x: (lp.0 as u32 & 0xffff) as i16 as i32,
                            y: ((lp.0 as u32 >> 16) & 0xffff) as i16 as i32,
                        };
                        let _ = ScreenToClient(hwnd, &mut p);
                        if p.x >= 0 && p.y >= 0 && p.x < c.w && p.y < c.h {
                            let pixel = ptr::read(
                                c.bits
                                    .cast::<u8>()
                                    .add(((p.y * c.w + p.x) * 4 + 3) as usize),
                            );
                            if pixel > 12 {
                                return LRESULT(HTCLIENT as isize);
                            }
                        }
                    }
                    LRESULT(HTTRANSPARENT as isize)
                }
                WM_LBUTTONDOWN if hwnd == s.hwnd => {
                    if IsWindowVisible(s.composer).as_bool() {
                        cancel_composer(s);
                    }
                    if let Some(scene) = &mut s.scene {
                        s.grab_offset = Some(POINT {
                            x: lp.0 as i16 as i32,
                            y: (lp.0 >> 16) as i16 as i32,
                        });
                        scene.grab();
                        s.track_button = GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0;
                        SetCapture(hwnd);
                        let _ = paint(s);
                    }
                    LRESULT(0)
                }
                WM_MOUSEMOVE if hwnd == s.hwnd && s.grab_offset.is_some() => {
                    let mut p = POINT {
                        x: lp.0 as i16 as i32,
                        y: (lp.0 >> 16) as i16 as i32,
                    };
                    let _ = ClientToScreen(hwnd, &mut p);
                    let offset = s.grab_offset.unwrap();
                    if let Some(scene) = &mut s.scene {
                        scene.drag_to((p.x - offset.x) as f64, (p.y - offset.y) as f64);
                        let _ = SetWindowPos(
                            hwnd,
                            None,
                            scene.x.round() as i32,
                            scene.y.round() as i32,
                            0,
                            0,
                            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                        );
                    }
                    LRESULT(0)
                }
                WM_LBUTTONUP | WM_CANCELMODE | WM_CAPTURECHANGED if hwnd == s.hwnd => {
                    drop_avatar(s);
                    if message != WM_CAPTURECHANGED && GetCapture() == hwnd {
                        let _ = ReleaseCapture();
                    }
                    LRESULT(0)
                }
                WM_RBUTTONUP | WM_LBUTTONDBLCLK => {
                    compose(s);
                    LRESULT(0)
                }
                WM_LBUTTONUP if hwnd == s.bubble => {
                    if IsWindowVisible(s.composer).as_bool() {
                        cancel_composer(s);
                    } else {
                        compose(s);
                    }
                    LRESULT(0)
                }
                WM_ACTIVATE if hwnd == s.composer && (wp.0 & 0xffff) == WA_INACTIVE as usize => {
                    cancel_composer(s);
                    LRESULT(0)
                }
                WM_CTLCOLOREDIT if hwnd == s.composer => {
                    let dc = HDC(wp.0 as *mut c_void);
                    SetTextColor(dc, COLORREF(0x00473225));
                    SetBkColor(dc, COLORREF(0x00ffffff));
                    LRESULT(s.card_brush.0 as isize)
                }
                WM_ERASEBKGND if hwnd == s.bubble || hwnd == s.composer => LRESULT(1),
                WM_PAINT if hwnd == s.composer => {
                    let mut ps = PAINTSTRUCT::default();
                    let dc = BeginPaint(hwnd, &mut ps);
                    card(s, hwnd, dc);
                    let mut r = RECT::default();
                    let _ = GetClientRect(hwnd, &mut r);
                    caption(
                        s,
                        dc,
                        &s.reply_title,
                        RECT {
                            left: dip(s, 18.),
                            top: dip(s, 13.),
                            right: r.right - dip(s, 18.),
                            bottom: dip(s, 33.),
                        },
                        COLORREF(0x00a39083),
                    );
                    let hint = if !s.composer_issue.is_empty() {
                        s.composer_issue.as_str()
                    } else if s.pending_reply.is_some() {
                        if s.english {
                            "Sending…"
                        } else {
                            "正在发送…"
                        }
                    } else {
                        if s.english {
                            "Enter to send  ·  Shift+Enter for a new line"
                        } else {
                            "Enter 发送  ·  Shift+Enter 换行"
                        }
                    };
                    caption(
                        s,
                        dc,
                        hint,
                        RECT {
                            left: dip(s, 18.),
                            top: r.bottom - dip(s, 32.),
                            right: r.right - dip(s, 18.),
                            bottom: r.bottom - dip(s, 12.),
                        },
                        if s.composer_issue.is_empty() {
                            COLORREF(0x00a39083)
                        } else {
                            COLORREF(0x006263b9)
                        },
                    );
                    let _ = EndPaint(hwnd, &ps);
                    LRESULT(0)
                }
                WM_PAINT if hwnd == s.bubble => {
                    let mut ps = PAINTSTRUCT::default();
                    let dc = BeginPaint(hwnd, &mut ps);
                    let mut rect = RECT::default();
                    let _ = GetClientRect(hwnd, &mut rect);
                    card(s, hwnd, dc);
                    s.bubble_image_painted = paint_bubble_image(s, dc, rect.right);
                    caption(
                        s,
                        dc,
                        if s.english {
                            "Click to reply"
                        } else {
                            "点击回复"
                        },
                        RECT {
                            left: dip(s, 18.),
                            top: rect.bottom - dip(s, 30.),
                            right: rect.right - dip(s, 18.),
                            bottom: rect.bottom - dip(s, 10.),
                        },
                        COLORREF(0x00b18485),
                    );
                    SetTextColor(dc, COLORREF(0x00473225));
                    let old = SelectObject(dc, s.font.into());
                    rect.left += dip(s, 18.);
                    rect.top += dip(s, 18.);
                    rect.right -= dip(s, 18.) + bubble_image_column(s);
                    rect.bottom -= dip(s, 36.);
                    let mut text = utf(&s.text);
                    DrawTextW(
                        dc,
                        &mut text[..s.text.encode_utf16().count()],
                        &mut rect,
                        DT_WORDBREAK | DT_NOPREFIX | DT_END_ELLIPSIS | DT_EDITCONTROL,
                    );
                    SelectObject(dc, old);
                    let _ = EndPaint(hwnd, &ps);
                    LRESULT(0)
                }
                WM_COMMAND if hwnd == s.composer && (wp.0 & 0xffff) == 101 => {
                    if s.pending_reply.is_some() {
                        return LRESULT(0);
                    }
                    if s.reply_conversation.is_empty() {
                        s.composer_issue = if s.english {
                            "Select a conversation in Avatar settings."
                        } else {
                            "请先在 Avatar 设置中选择对话"
                        }
                        .into();
                        let _ = InvalidateRect(Some(hwnd), None, true);
                        return LRESULT(0);
                    }
                    let len = GetWindowTextLengthW(s.edit);
                    if len > 0 {
                        let mut text = vec![0u16; len as usize + 1];
                        let n = GetWindowTextW(s.edit, &mut text);
                        let text = String::from_utf16_lossy(&text[..n as usize]);
                        if text.trim().is_empty() {
                            return LRESULT(0);
                        }
                        s.reply_sequence += 1;
                        let request_id = format!("native-{}-{}", s.instance, s.reply_sequence);
                        s.pending_reply = Some(request_id.clone());
                        let _ = EnableWindow(s.edit, false);
                        let _ = InvalidateRect(Some(hwnd), None, true);
                        println!(
                            "{}",
                            json!({"jsonrpc":"2.0","id":request_id,"method":"avatar.reply","params":{"text":text,"conversationId":s.reply_conversation,"requestId":request_id}})
                        );
                    }
                    LRESULT(0)
                }
                WM_CLOSE if hwnd != s.hwnd => {
                    if hwnd == s.composer {
                        cancel_composer(s);
                    } else {
                        let _ = ShowWindow(hwnd, SW_HIDE);
                    }
                    LRESULT(0)
                }
                WM_DESTROY if hwnd == s.hwnd => {
                    PostQuitMessage(0);
                    LRESULT(0)
                }
                _ => DefWindowProcW(hwnd, message, wp, lp),
            }
        }
    }
    unsafe extern "system" fn edit_procedure(
        hwnd: HWND,
        message: u32,
        wp: WPARAM,
        lp: LPARAM,
    ) -> LRESULT {
        unsafe {
            let p = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut State;
            if p.is_null() {
                return DefWindowProcW(hwnd, message, wp, lp);
            }
            let s = &mut *p;
            match message {
                WM_IME_STARTCOMPOSITION => s.ime_active = true,
                WM_IME_ENDCOMPOSITION => s.ime_active = false,
                WM_KEYDOWN if wp.0 == VK_ESCAPE.0 as usize && !s.ime_active => {
                    cancel_composer(s);
                    return LRESULT(0);
                }
                WM_KEYDOWN
                    if wp.0 == VK_RETURN.0 as usize
                        && !s.ime_active
                        && GetKeyState(VK_SHIFT.0 as i32) >= 0 =>
                {
                    let _ =
                        SendMessageW(s.composer, WM_COMMAND, Some(WPARAM(101)), Some(LPARAM(0)));
                    return LRESULT(0);
                }
                WM_CHAR if wp.0 == 13 && !s.ime_active && GetKeyState(VK_SHIFT.0 as i32) >= 0 => {
                    return LRESULT(0);
                }
                _ => (),
            }
            CallWindowProcW(s.edit_proc, hwnd, message, wp, lp)
        }
    }
    pub fn run() -> Result<(), Box<dyn std::error::Error>> {
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let instance = GetModuleHandleW(None)?;
            let class = w!("EchoNativeCompanion");
            let wc = WNDCLASSW {
                style: CS_DBLCLKS,
                lpfnWndProc: Some(procedure),
                hInstance: instance.into(),
                lpszClassName: class,
                hCursor: LoadCursorW(None, IDC_ARROW)?,
                hbrBackground: HBRUSH::default(),
                ..Default::default()
            };
            if RegisterClassW(&wc) == 0 {
                return Err("window registration failed".into());
            }
            let card_class = w!("EchoNativeCard");
            let card = WNDCLASSW {
                style: CS_DBLCLKS | CS_DROPSHADOW,
                lpszClassName: card_class,
                hbrBackground: HBRUSH((COLOR_WINDOW.0 + 1) as usize as *mut c_void),
                ..wc
            };
            if RegisterClassW(&card) == 0 {
                return Err("card window registration failed".into());
            }
            let (tx, rx) = mpsc::channel();
            let mut lf = LOGFONTW::default();
            lf.lfHeight = -(14. * GetDpiForSystem() as f64 / 96.).round() as i32;
            lf.lfWeight = 400;
            lf.lfQuality = CLEARTYPE_QUALITY;
            lf.lfCharSet = DEFAULT_CHARSET;
            for (i, c) in "Microsoft YaHei UI".encode_utf16().enumerate() {
                lf.lfFaceName[i] = c;
            }
            let font = CreateFontIndirectW(&lf);
            lf.lfHeight = -(11.5 * GetDpiForSystem() as f64 / 96.).round() as i32;
            let small_font = CreateFontIndirectW(&lf);
            let card_brush = CreateSolidBrush(COLORREF(0x00ffffff));
            let mut s = Box::new(State {
                rx,
                canvas: None,
                started: Instant::now(),
                working: false,
                playing: String::new(),
                scene: None,
                scene_start: Instant::now(),
                last_tick: Instant::now(),
                next_work_area_check: Instant::now(),
                grab_offset: None,
                track_button: false,
                motion: ["idle".into(), "idle".into(), "idle".into()],
                state_rules: vec![],
                active_states: vec![],
                hwnd: HWND::default(),
                bubble: HWND::default(),
                composer: HWND::default(),
                edit: HWND::default(),
                edit_proc: None,
                ime_active: false,
                english: false,
                font,
                small_font,
                card_brush,
                composer_issue: String::new(),
                text: String::new(),
                bubble_image: None,
                bubble_image_painted: false,
                conversation: String::new(),
                conversation_title: String::new(),
                default_conversation: String::new(),
                default_title: String::new(),
                reply_conversation: String::new(),
                reply_title: String::new(),
                reply_sequence: 0,
                pending_reply: None,
                instance: String::new(),
                expires: None,
                docked: false,
                scale: (GetDpiForSystem() as f64 / 96.).max(1.),
                paints: 0,
                left: false,
                slot: 0,
                home_offset: None,
            });
            let pointer = (&mut *s as *mut State).cast();
            s.hwnd = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
                class,
                w!("Echo Native Avatar"),
                WS_POPUP,
                0,
                0,
                1,
                1,
                None,
                None,
                Some(instance.into()),
                Some(pointer),
            )?;
            let policy = DWMNCRP_DISABLED;
            let _ = DwmSetWindowAttribute(
                s.hwnd,
                DWMWA_NCRENDERING_POLICY,
                (&policy as *const DWMNCRENDERINGPOLICY).cast(),
                size_of::<DWMNCRENDERINGPOLICY>() as u32,
            );
            let no_border = COLORREF(0xFFFFFFFE);
            let _ = DwmSetWindowAttribute(
                s.hwnd,
                DWMWA_BORDER_COLOR,
                (&no_border as *const COLORREF).cast(),
                size_of::<COLORREF>() as u32,
            );
            s.bubble = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
                card_class,
                w!("Echo Native Bubble"),
                WS_POPUP,
                0,
                0,
                360,
                180,
                Some(s.hwnd),
                None,
                Some(instance.into()),
                Some(pointer),
            )?;
            s.composer = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                card_class,
                w!("Reply to Echo"),
                WS_POPUP | WS_CLIPCHILDREN,
                0,
                0,
                400,
                220,
                Some(s.hwnd),
                None,
                Some(instance.into()),
                Some(pointer),
            )?;
            s.edit = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("EDIT"),
                w!(""),
                WS_CHILD
                    | WS_VISIBLE
                    | WS_TABSTOP
                    | WINDOW_STYLE(
                        ES_MULTILINE as u32 | ES_AUTOVSCROLL as u32 | ES_WANTRETURN as u32,
                    ),
                10,
                40,
                365,
                120,
                Some(s.composer),
                None,
                Some(instance.into()),
                None,
            )?;
            let _ = SendMessageW(
                s.edit,
                WM_SETFONT,
                Some(WPARAM(font.0 as usize)),
                Some(LPARAM(1)),
            );
            let _ = SendMessageW(s.edit, 0x00c5, Some(WPARAM(100000)), Some(LPARAM(0))); // EM_SETLIMITTEXT
            SetWindowLongPtrW(s.edit, GWLP_USERDATA, (&mut *s as *mut State) as isize);
            let previous =
                SetWindowLongPtrW(s.edit, GWLP_WNDPROC, edit_procedure as *const () as isize);
            s.edit_proc = std::mem::transmute::<isize, WNDPROC>(previous);
            let hwnd = s.hwnd.0 as usize;
            std::thread::spawn(move || {
                for line in io::stdin().lock().lines() {
                    if let Ok(line) = line {
                        if line.len() > 1000000 {
                            continue;
                        }
                        if let Ok(v) = serde_json::from_str(&line) {
                            if tx.send(v).is_err() {
                                break;
                            }
                            let _ = PostMessageW(
                                Some(HWND(hwnd as *mut c_void)),
                                INPUT,
                                WPARAM(0),
                                LPARAM(0),
                            );
                        }
                    } else {
                        break;
                    }
                }
                let _ = PostMessageW(
                    Some(HWND(hwnd as *mut c_void)),
                    WM_CLOSE,
                    WPARAM(0),
                    LPARAM(0),
                );
            });
            SetTimer(Some(s.hwnd), 1, 100, None);
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = DestroyWindow(s.bubble);
            let _ = DestroyWindow(s.composer);
            let _ = DeleteObject(s.font.into());
            let _ = DeleteObject(s.small_font.into());
            let _ = DeleteObject(s.card_brush.into());
            Ok(())
        }
    }
}
fn main() {
    #[cfg(windows)]
    if desktop::run().is_err() {
        std::process::exit(1);
    }
    #[cfg(not(windows))]
    eprintln!("Native avatar currently requires Windows");
}
