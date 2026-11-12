//! ABI v1 for optional native avatar renderers. The host owns all windows and UI.
//! Buffers are borrowed from the instance until the next request; the host copies
//! them immediately. Allocations never cross the dynamic-library boundary.
use serde_json::{Value, json};
use std::{
    ffi::c_void,
    panic::{AssertUnwindSafe, catch_unwind},
};

#[repr(C)]
pub struct Bytes {
    pub ptr: *const u8,
    pub len: usize,
}
impl Bytes {
    pub fn empty() -> Self {
        Self {
            ptr: std::ptr::null(),
            len: 0,
        }
    }
    pub fn borrowed(value: &[u8]) -> Self {
        Self {
            ptr: value.as_ptr(),
            len: value.len(),
        }
    }
}
#[repr(C)]
pub struct Api {
    pub abi_version: u32,
    pub struct_size: u32,
    pub create: unsafe extern "C" fn(*const u8, usize) -> *mut c_void,
    pub request: unsafe extern "C" fn(*mut c_void, *const u8, usize) -> Bytes,
    pub pixels: unsafe extern "C" fn(*mut c_void) -> Bytes,
    pub destroy: unsafe extern "C" fn(*mut c_void),
}
pub trait Renderer {
    /// width, height, fps, maxFps, clips, kind, and optional motionHooks/walkSpeed.
    fn describe(&self) -> Value;
    /// Premultiplied BGRA, top-down. Facing is applied by the renderer so depth
    /// ordering and other direction-sensitive effects can change correctly.
    fn render(&mut self, context: &Value) -> Result<Value, String>;
    fn pixels(&self) -> &[u8];
    /// Optional body motion: a bounded x/y/phase/activities override or null.
    /// The host still owns drag input, work-area bounds and normal locomotion.
    fn motion(&mut self, _context: &Value) -> Result<Value, String> {
        Ok(Value::Null)
    }
}
pub type Factory = fn(&Value) -> Result<Box<dyn Renderer>, String>;
struct Instance {
    renderer: Result<Box<dyn Renderer>, String>,
    response: Vec<u8>,
}
unsafe fn decode(ptr: *const u8, len: usize) -> Result<Value, String> {
    if ptr.is_null() || len == 0 || len > 65_536 {
        return Err("invalid renderer request size".into());
    }
    serde_json::from_slice(unsafe { std::slice::from_raw_parts(ptr, len) })
        .map_err(|e| e.to_string())
}
/// # Safety
/// Input must be readable for len bytes; used only by the exported ABI adapter.
pub unsafe fn create(factory: Factory, ptr: *const u8, len: usize) -> *mut c_void {
    let result = catch_unwind(AssertUnwindSafe(|| {
        unsafe { decode(ptr, len) }.and_then(|v| factory(&v))
    }))
    .unwrap_or_else(|_| Err("renderer initialization panicked".into()));
    Box::into_raw(Box::new(Instance {
        renderer: result,
        response: Vec::new(),
    }))
    .cast()
}
/// # Safety
/// handle must be a live instance created by this library; input must be readable.
pub unsafe extern "C" fn request(handle: *mut c_void, ptr: *const u8, len: usize) -> Bytes {
    if handle.is_null() {
        return Bytes::empty();
    }
    let instance = unsafe { &mut *handle.cast::<Instance>() };
    let result = catch_unwind(AssertUnwindSafe(|| {
        let input = unsafe { decode(ptr, len) }?;
        let renderer = instance.renderer.as_mut().map_err(|e| e.clone())?;
        match input["method"].as_str() {
            Some("describe") => Ok(renderer.describe()),
            Some("render") => renderer.render(&input["params"]),
            Some("motion") => renderer.motion(&input["params"]),
            _ => Err("unknown renderer request".into()),
        }
    }))
    .unwrap_or_else(|_| Err("renderer request panicked".into()));
    instance.response = serde_json::to_vec(&match result {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(error) => json!({"ok":false,"error":error}),
    })
    .unwrap_or_default();
    Bytes::borrowed(&instance.response)
}
/// # Safety
/// handle must be a live instance; the returned bytes are invalidated by requests.
pub unsafe extern "C" fn pixels(handle: *mut c_void) -> Bytes {
    if handle.is_null() {
        return Bytes::empty();
    }
    catch_unwind(AssertUnwindSafe(|| {
        match &unsafe { &*handle.cast::<Instance>() }.renderer {
            Ok(renderer) => Bytes::borrowed(renderer.pixels()),
            Err(_) => Bytes::empty(),
        }
    }))
    .unwrap_or_else(|_| Bytes::empty())
}
/// # Safety
/// Destroy each instance exactly once, before unloading its library.
pub unsafe extern "C" fn destroy(handle: *mut c_void) {
    if !handle.is_null() {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            drop(unsafe { Box::from_raw(handle.cast::<Instance>()) })
        }));
    }
}
#[macro_export]
macro_rules! export_renderer {
    ($factory:path) => {
        unsafe extern "C" fn create_renderer(
            ptr: *const u8,
            len: usize,
        ) -> *mut ::std::ffi::c_void {
            unsafe { $crate::create($factory, ptr, len) }
        }
        static RENDERER_API: $crate::Api = $crate::Api {
            abi_version: 1,
            struct_size: ::std::mem::size_of::<$crate::Api>() as u32,
            create: create_renderer,
            request: $crate::request,
            pixels: $crate::pixels,
            destroy: $crate::destroy,
        };
        #[unsafe(no_mangle)]
        pub extern "C" fn echo_avatar_renderer_v1() -> *const $crate::Api {
            &RENDERER_API
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture;
    impl Renderer for Fixture {
        fn describe(&self) -> Value {
            json!({"kind":"fixture","width":8,"height":8})
        }
        fn render(&mut self, v: &Value) -> Result<Value, String> {
            if v["panic"] == true {
                panic!("fixture failure");
            }
            Ok(json!({"clip":"idle"}))
        }
        fn pixels(&self) -> &[u8] {
            &[1, 2, 3, 4]
        }
    }
    fn factory(_: &Value) -> Result<Box<dyn Renderer>, String> {
        Ok(Box::new(Fixture))
    }
    #[test]
    fn abi_preserves_buffer_ownership_and_contains_errors() {
        unsafe {
            let handle = create(factory, b"{}".as_ptr(), 2);
            let call = |input: &[u8]| {
                let bytes = request(handle, input.as_ptr(), input.len());
                serde_json::from_slice::<Value>(std::slice::from_raw_parts(bytes.ptr, bytes.len))
                    .unwrap()
            };
            assert_eq!(
                call(br#"{"method":"describe"}"#)["result"]["kind"],
                "fixture"
            );
            assert_eq!(
                call(br#"{"method":"render","params":{}}"#)["result"]["clip"],
                "idle"
            );
            let bytes = pixels(handle);
            assert_eq!(
                std::slice::from_raw_parts(bytes.ptr, bytes.len),
                &[1, 2, 3, 4]
            );
            assert_eq!(call(b"invalid")["ok"], false);
            assert_eq!(
                call(br#"{"method":"render","params":{"panic":true}}"#)["ok"],
                false
            );
            assert_eq!(call(br#"{"method":"motion"}"#)["result"], Value::Null);
            destroy(handle);
        }
    }
}
