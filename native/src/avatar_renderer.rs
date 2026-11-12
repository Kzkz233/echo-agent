//! Trusted native rendering extensions. All UI remains in the base avatar host.
use echo_avatar_sdk::Api;
use serde_json::{Value, json};
use std::{ffi::c_void, mem::size_of, path::Path};
use windows::{
    Win32::{
        Foundation::{FreeLibrary, HMODULE},
        System::LibraryLoader::*,
    },
    core::{PCWSTR, s},
};

pub struct Renderer {
    module: HMODULE,
    api: *const Api,
    instance: *mut c_void,
    pub metadata: Value,
}
impl Renderer {
    pub fn load(library: &str, directory: &str, scale: f64) -> Result<Self, String> {
        if !Path::new(library).is_absolute() {
            return Err("renderer library must be absolute".into());
        }
        let path = std::fs::canonicalize(library).map_err(|e| e.to_string())?;
        let name: Vec<u16> = path
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            let module = LoadLibraryExW(
                PCWSTR(name.as_ptr()),
                None,
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
            )
            .map_err(|e| e.to_string())?;
            let mut renderer = Self {
                module,
                api: std::ptr::null(),
                instance: std::ptr::null_mut(),
                metadata: Value::Null,
            };
            let entry = GetProcAddress(module, s!("echo_avatar_renderer_v1"))
                .ok_or("renderer ABI entry missing")?;
            let entry: unsafe extern "C" fn() -> *const Api = std::mem::transmute(entry);
            renderer.api = entry();
            if renderer.api.is_null()
                || (*renderer.api).abi_version != 1
                || (*renderer.api).struct_size < size_of::<Api>() as u32
            {
                return Err("unsupported renderer ABI".into());
            }
            let config = serde_json::to_vec(&json!({"directory":directory,"scale":scale}))
                .map_err(|e| e.to_string())?;
            renderer.instance = ((*renderer.api).create)(config.as_ptr(), config.len());
            if renderer.instance.is_null() {
                return Err("renderer initialization failed".into());
            }
            renderer.metadata = renderer.request("describe", json!({}))?;
            let m = &renderer.metadata;
            let valid = (8..=2048).contains(&m["width"].as_u64().unwrap_or(0))
                && (8..=2048).contains(&m["height"].as_u64().unwrap_or(0))
                && (1..=30).contains(&m["maxFps"].as_u64().unwrap_or(30))
                && m["clips"].as_array().is_some_and(|clips| {
                    clips.len() <= 128
                        && clips
                            .iter()
                            .all(|s| s.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 128))
                        && clips.iter().any(|s| s == "idle")
                });
            if !valid {
                return Err("invalid renderer metadata".into());
            }
            Ok(renderer)
        }
    }
    pub fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let input = serde_json::to_vec(&json!({"method":method,"params":params}))
            .map_err(|e| e.to_string())?;
        unsafe {
            let bytes = ((*self.api).request)(self.instance, input.as_ptr(), input.len());
            if bytes.ptr.is_null() || bytes.len > 65_536 || bytes.len == 0 {
                return Err("invalid renderer response".into());
            }
            let v: Value = serde_json::from_slice(std::slice::from_raw_parts(bytes.ptr, bytes.len))
                .map_err(|e| e.to_string())?;
            if v["ok"] != true {
                return Err(v["error"].as_str().unwrap_or("renderer failed").into());
            }
            Ok(v["result"].clone())
        }
    }
    pub fn has_clip(&self, name: &str) -> bool {
        self.metadata["clips"]
            .as_array()
            .is_some_and(|clips| clips.iter().any(|clip| clip == name))
    }
    /// Copy immediately, before another request can invalidate the borrowed data.
    pub unsafe fn copy_pixels(&self, target: *mut u8) -> Result<(), String> {
        let expected = self.metadata["width"].as_u64().unwrap_or(0)
            * self.metadata["height"].as_u64().unwrap_or(0)
            * 4;
        let bytes = unsafe { ((*self.api).pixels)(self.instance) };
        if bytes.ptr.is_null() || bytes.len as u64 != expected {
            return Err("renderer pixel buffer mismatch".into());
        }
        unsafe { std::ptr::copy_nonoverlapping(bytes.ptr, target, bytes.len) };
        Ok(())
    }
}
impl Drop for Renderer {
    fn drop(&mut self) {
        unsafe {
            if !self.instance.is_null() && !self.api.is_null() {
                ((*self.api).destroy)(self.instance);
            }
            let _ = FreeLibrary(self.module);
        }
    }
}
