use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
fn main() {
    #[cfg(windows)]
    echo_native::platform::initialize();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.len() > 100000 {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let method = value.get("method").and_then(Value::as_str).unwrap_or("");
        let params = value.get("params").cloned().unwrap_or(json!({}));
        #[cfg(all(windows, debug_assertions))]
        if method == "diagnose" {
            println!(
                "{}",
                json!({"jsonrpc":"2.0","id":value["id"],"result":echo_native::platform::diagnose_fixture()})
            );
            let _ = io::stdout().flush();
            continue;
        }
        #[cfg(windows)]
        let result = echo_native::platform::handle(method, &params);
        #[cfg(not(windows))]
        let result: Result<Value, String> =
            Err("此原生采集器目前支持 Windows；其他平台可接入采集插件。".into());
        let response = match result {
            Ok(data) => json!({"jsonrpc":"2.0","id":value["id"],"result":data}),
            Err(message) => {
                json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32000,"message":message}})
            }
        };
        println!("{}", response);
        let _ = io::stdout().flush();
    }
}
