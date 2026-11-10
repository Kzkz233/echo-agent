use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub priority: u16,
    pub clip: String,
    #[serde(default)]
    pub fallback: String,
}
/// Pure projection. Multiple sources may hold a state; selection never ends those activities.
pub fn choose(rules: &[Rule], active: &[String], available: impl Fn(&str) -> bool) -> String {
    let mut candidates: Vec<&Rule> = rules.iter().filter(|r| r.id == "avatar.idle" || active.contains(&r.id)).collect();
    candidates.sort_by(|a,b| b.priority.cmp(&a.priority).then_with(|| a.id.cmp(&b.id)));
    for rule in candidates {
        let mut current = rule;
        let mut visited = std::collections::HashSet::new();
        while visited.insert(&current.id) {
            if available(&current.clip) { return current.clip.clone(); }
            let Some(next) = rules.iter().find(|r| r.id == current.fallback) else { break; };
            current = next;
        }
    }
    "idle".into()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn priority_fallback_and_cycles() {
        let rules: Vec<Rule> = serde_json::from_value(serde_json::json!([
            {"id":"avatar.idle","priority":0,"clip":"idle"},
            {"id":"a.work","priority":40,"clip":"walk","fallback":"avatar.idle"},
            {"id":"b.talk","priority":70,"clip":"talk","fallback":"a.work"}
        ])).unwrap();
        let active=vec!["a.work".into(),"b.talk".into()];
        assert_eq!(choose(&rules,&active,|s| s=="walk" || s=="idle"),"walk");
        assert_eq!(choose(&rules,&active,|_|true),"talk");
        assert_eq!(choose(&rules,&[],|_|true),"idle");
    }
}
