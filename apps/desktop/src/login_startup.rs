use std::path::{Path, PathBuf};
use tauri::WebviewWindow;

pub fn login_directory(args: impl IntoIterator<Item = std::ffi::OsString>) -> Option<PathBuf> {
    let mut args = args.into_iter().skip(1);
    if args.next()? != "--login-startup" || args.next()? != "--data-dir" {
        return None;
    }
    let dir = PathBuf::from(args.next()?);
    (dir.is_absolute() && args.next().is_none()).then_some(dir)
}

#[cfg(windows)]
mod registry {
    use super::*;
    use std::io::{Error, ErrorKind, Result};
    use winreg::{
        RegKey,
        enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE},
    };
    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVALS: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    const NAME: &str = "Echo Agent";

    fn quote(path: &Path) -> Result<String> {
        let path = path
            .to_str()
            .filter(|value| !value.contains('"'))
            .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "Invalid startup path"))?;
        let end = path.len() - path.trim_end_matches('\\').len();
        Ok(format!("\"{}{}\"", path, "\\".repeat(end)))
    }
    fn current(key: &RegKey, subkey: &str, name: &str) -> Result<Option<String>> {
        match key
            .open_subkey_with_flags(subkey, KEY_READ)
            .and_then(|k| k.get_value(name))
        {
            Ok(value) => Ok(Some(value)),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }
    fn configure(
        root: &RegKey,
        run: &str,
        approvals: &str,
        command: &str,
        set: Option<bool>,
    ) -> Result<&'static str> {
        let found = current(root, run, NAME)?;
        if found.as_deref().is_some_and(|s| s != command) {
            if set.is_some() {
                return Err(Error::new(
                    ErrorKind::AlreadyExists,
                    "启动项已由另一份 Echo 安装或数据目录使用。",
                ));
            }
            return Ok("conflict");
        }
        if let Some(enable) = set {
            if enable && found.is_none() {
                // Windows Run values have a documented 260-character command-line limit.
                if command.encode_utf16().count() >= 260 {
                    return Err(Error::new(
                        ErrorKind::InvalidInput,
                        "启动路径超过 Windows 登录启动项的长度限制。",
                    ));
                }
                root.create_subkey_with_flags(run, KEY_SET_VALUE)?
                    .0
                    .set_value(NAME, &command)?;
            } else if !enable && found.is_some() {
                root.open_subkey_with_flags(run, KEY_SET_VALUE)?
                    .delete_value(NAME)?;
            }
        }
        if !set.unwrap_or(found.is_some()) {
            return Ok("off");
        }
        let approval = root
            .open_subkey_with_flags(approvals, KEY_READ)
            .and_then(|k| k.get_raw_value(NAME));
        match approval {
            Ok(v) if matches!(v.bytes.first(), Some(3 | 7)) => Ok("disabled"),
            Ok(_) => Ok("on"),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok("on"),
            Err(e) => Err(e),
        }
    }
    pub fn state(set: Option<bool>) -> Result<&'static str> {
        let command = format!(
            "{} --login-startup --data-dir {}",
            quote(&std::env::current_exe()?)?,
            quote(&super::super::data_directory())?
        );
        configure(
            &RegKey::predef(HKEY_CURRENT_USER),
            RUN,
            APPROVALS,
            &command,
            set,
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn isolated_startup_registration_respects_ownership_and_windows_disable() {
            let root = RegKey::predef(HKEY_CURRENT_USER);
            let scratch = format!(r"Software\EchoAgentTests\login-{}", std::process::id());
            let (key, _) = root.create_subkey(&scratch).unwrap();
            let check = |cmd, enabled| configure(&key, "Fixture", "Consent", cmd, enabled).unwrap();
            assert_eq!(check("fixture", None), "off");
            assert_eq!(check("fixture", Some(true)), "on");
            assert_eq!(check("foreign", None), "conflict");
            assert!(configure(&key, "Fixture", "Consent", "foreign", Some(false)).is_err());
            key.create_subkey("Consent")
                .unwrap()
                .0
                .set_raw_value(
                    NAME,
                    &winreg::RegValue {
                        bytes: vec![3, 0, 0, 0].into(),
                        vtype: winreg::enums::REG_BINARY,
                    },
                )
                .unwrap();
            assert_eq!(check("fixture", None), "disabled");
            assert_eq!(check("fixture", Some(false)), "off");
            drop(key);
            root.delete_subkey_all(scratch).unwrap();
        }
        #[test]
        fn login_requires_explicit_flag_and_absolute_anchor() {
            let parse = |args: &[&str]| login_directory(args.iter().map(std::ffi::OsString::from));
            assert!(parse(&["Echo.exe"]).is_none());
            assert!(parse(&["Echo.exe", "--login-startup", "--data-dir", "relative"]).is_none());
            assert_eq!(
                parse(&[
                    "Echo.exe",
                    "--login-startup",
                    "--data-dir",
                    r"C:\Fixture Data"
                ]),
                Some(PathBuf::from(r"C:\Fixture Data"))
            );
            assert_eq!(quote(Path::new(r"C:\")).unwrap(), "\"C:\\\\\"");
        }
    }
}

#[tauri::command]
pub fn login_startup(window: WebviewWindow, enabled: Option<bool>) -> Result<&'static str, String> {
    if window.label() != "settings" {
        return Err("请在应用设置窗口操作。".into());
    }
    #[cfg(windows)]
    {
        registry::state(enabled).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Ok("unsupported")
    }
}
