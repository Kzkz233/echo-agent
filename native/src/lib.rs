use serde::{Deserialize, Serialize};
pub mod avatar_motion;
pub mod avatar_activity;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}
impl Rect {
    pub fn intersect(self, other: Rect) -> Option<Rect> {
        let r = Rect {
            left: self.left.max(other.left),
            top: self.top.max(other.top),
            right: self.right.min(other.right),
            bottom: self.bottom.min(other.bottom),
        };
        if r.right > r.left && r.bottom > r.top {
            Some(r)
        } else {
            None
        }
    }
    pub fn subtract(self, other: Rect) -> Vec<Rect> {
        let Some(i) = self.intersect(other) else {
            return vec![self];
        };
        [
            Rect {
                bottom: i.top,
                ..self
            },
            Rect {
                top: i.bottom,
                ..self
            },
            Rect {
                left: self.left,
                right: i.left,
                top: i.top,
                bottom: i.bottom,
            },
            Rect {
                left: i.right,
                right: self.right,
                top: i.top,
                bottom: i.bottom,
            },
        ]
        .into_iter()
        .filter(|r| r.right > r.left && r.bottom > r.top)
        .collect()
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub r#type: String,
    pub value: String,
    #[serde(default)]
    pub title: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}
fn yes() -> bool {
    true
}
/// A path rule is exact. Never turn it into a broad basename rule on mismatch.
pub fn process_allowed(actual: &str, rule: &str) -> bool {
    let normalize = |s: &str| s.trim().replace('/', "\\").to_lowercase();
    let actual = normalize(actual);
    let expected = normalize(rule);
    if actual.is_empty() || expected.is_empty() {
        return false;
    }
    if expected.contains('\\') {
        actual == expected
    } else {
        actual.rsplit('\\').next() == Some(expected.as_str())
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub rule_id: String,
    pub source: String,
    pub title: String,
}
pub fn host_allowed(url: &str, host: &str) -> bool {
    let url = if url.starts_with("http://") || url.starts_with("https://") {
        url.to_string()
    } else {
        format!("https://{url}")
    };
    let Ok(parsed) = url::Url::parse(&url) else {
        return false;
    };
    if !["https", "http"].contains(&parsed.scheme())
        || parsed.username() != ""
        || parsed.password().is_some()
    {
        return false;
    }
    let Some(actual) = parsed.host_str() else {
        return false;
    };
    let target = host.trim().trim_end_matches('.').to_lowercase();
    !target.is_empty() && (actual == target || actual.ends_with(&format!(".{target}")))
}

#[cfg(windows)]
pub mod platform;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn subtract_keeps_only_visible_pixels() {
        let original = Rect {
            left: 0,
            top: 0,
            right: 100,
            bottom: 100,
        };
        let cover = Rect {
            left: 20,
            top: 20,
            right: 80,
            bottom: 80,
        };
        let parts = original.subtract(cover);
        assert_eq!(
            parts
                .iter()
                .map(|r| (r.right - r.left) * (r.bottom - r.top))
                .sum::<i32>(),
            6400
        );
        assert!(parts.iter().all(|r| r.intersect(cover).is_none()));
    }
    #[test]
    fn completely_covered_is_empty() {
        let r = Rect {
            left: 0,
            top: 0,
            right: 5,
            bottom: 5,
        };
        assert!(r.subtract(r).is_empty());
    }
    #[test]
    fn executable_rules_keep_full_path_identity() {
        let actual = r"C:\Games\Probably Stolen\Probably Stolen.exe";
        assert!(process_allowed(
            actual,
            "c:/games/probably stolen/probably stolen.exe"
        ));
        assert!(process_allowed(actual, "PROBABLY STOLEN.EXE"));
        assert!(!process_allowed(
            actual,
            r"D:\Untrusted\Probably Stolen.exe"
        ));
        assert!(!process_allowed(actual, "stolen.exe"));
        assert!(!process_allowed("", "probably stolen.exe"));
    }
    #[test]
    fn domain_boundary_and_credentials() {
        assert!(host_allowed("www.bilibili.com/video/test", "bilibili.com"));
        assert!(!host_allowed(
            "https://bilibili.com.evil.test",
            "bilibili.com"
        ));
        assert!(!host_allowed(
            "https://bilibili.com@evil.test",
            "bilibili.com"
        ));
        assert!(!host_allowed(
            "https://evil.test/?bilibili.com",
            "bilibili.com"
        ));
    }
}
