use std::process::{Command, Stdio};

fn validate_auth_url(value: &str) -> Result<(), String> {
    let url = tauri::Url::parse(value).map_err(|_| "Invalid authentication URL")?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("auth.openai.com") | Some("chatgpt.com"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("Invalid authentication URL".into());
    }
    Ok(())
}

#[tauri::command]
pub fn open_auth_url(url: String) -> Result<(), String> {
    validate_auth_url(&url)?;
    #[cfg(target_os = "windows")]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let system = std::env::var_os("SystemRoot").ok_or("System directory unavailable")?;
        let mut cmd = Command::new(std::path::PathBuf::from(system).join("System32/rundll32.exe"));
        cmd.args(["url.dll,FileProtocolHandler", &url]);
        cmd.creation_flags(0x08000000);
        cmd
    };
    #[cfg(target_os = "macos")]
    let mut command = { let mut cmd = Command::new("open"); cmd.arg(&url); cmd };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = { let mut cmd = Command::new("xdg-open"); cmd.arg(&url); cmd };
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().map_err(|_| "Could not open the default browser".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_official_https_authentication() {
        assert!(validate_auth_url("https://auth.openai.com/oauth/authorize?state=synthetic").is_ok());
        assert!(validate_auth_url("https://chatgpt.com/auth/login").is_ok());
    }
    #[test]
    fn rejects_non_provider_and_local_execution_urls() {
        for url in ["javascript:alert(1)", "file:///C:/Windows/cmd.exe", "http://auth.openai.com/", "https://auth.openai.com.example.org/", "https://auth.openai.com@evil.example/", "https://auth.openai.com:8443/"] {
            assert!(validate_auth_url(url).is_err(), "{url}");
        }
    }
}
