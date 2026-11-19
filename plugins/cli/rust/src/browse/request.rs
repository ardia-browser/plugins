use super::args::{self, Found, Int};
use super::errors::BrowseError;
use super::redact::Secrets;
use super::{sha256, url};
use crate::json::Value;
use crate::paths;

pub enum Prepared<T> {
    Ready(T),
    Failed(BrowseError),
    Unported,
}

pub fn env(name: &str) -> Option<String> {
    paths::env(name)
}

fn env_truthy(name: &str) -> bool {
    args::truthy(&env(name).unwrap_or_default())
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value.filter(|value| !value.is_empty()).map(str::to_string)
}

fn humanize_default() -> bool {
    env_truthy("AGENT_BROWSER_HUMANIZE") && !env_truthy("AGENT_BROWSER_NO_HUMANIZE")
}

fn stdout_is_file() -> bool {
    let mut info: libc::stat = unsafe { std::mem::zeroed() };
    unsafe { libc::fstat(1, &mut info) == 0 && info.st_mode & libc::S_IFMT == libc::S_IFREG }
}

fn int_value(text: &str) -> Value {
    match text.parse::<i128>() {
        Ok(number) => Value::Int(number),
        Err(_) => Value::BigInt(text.to_string()),
    }
}

fn listed(found: Option<&Vec<String>>, variable: &str) -> Value {
    let mut items: Vec<Value> = found.into_iter().flatten().map(|item| Value::str(item)).collect();
    items.extend(env(variable).unwrap_or_default().split(',').filter(|item| !item.is_empty()).map(Value::str));
    Value::Array(items)
}

fn optional(value: Option<&str>) -> Value {
    value.map_or(Value::Null, Value::str)
}

fn optional_flag(value: Option<bool>) -> Value {
    value.map_or(Value::Null, Value::Bool)
}

pub struct Options {
    pub entries: Vec<(&'static str, Value)>,
    pub timeout_ms: f64,
}

pub fn options_from(found: &Found) -> Prepared<Options> {
    let mut humanize = humanize_default();
    if found.flag("no_humanize") == Some(true) {
        humanize = false;
    }
    if found.flag("humanize") == Some(true) {
        humanize = true;
    }
    let given = non_empty(found.value("max_output")).or_else(|| env("AGENT_BROWSER_MAX_OUTPUT"));
    let max_output = match given {
        Some(text) => match args::python_int(&text) {
            Int::Value(number) => int_value(&number),
            Int::Invalid => {
                return Prepared::Failed(BrowseError::plain(format!("--max-output takes a number of characters, not {text}")));
            }
            Int::Unported => return Prepared::Unported,
        },
        None if stdout_is_file() => Value::Int(0),
        None => Value::Null,
    };
    let (timeout_value, timeout_ms) = match env("AGENT_BROWSER_DEFAULT_TIMEOUT").filter(|text| !text.is_empty()) {
        Some(text) => match args::python_float(&text) {
            Some(number) => (Value::Str(text), number),
            None => return Prepared::Unported,
        },
        None => (Value::Int(25000), 25000.0),
    };
    let either = |key: &str, variable: &str| found.flag(key) == Some(true) || env_truthy(variable);
    let mut entries = vec![
        ("json", Value::Bool(either("json", "AGENT_BROWSER_JSON"))),
        ("humanize", Value::Bool(humanize)),
        ("timeout_ms", timeout_value),
        ("max_output", max_output),
        ("full", Value::Bool(found.flag("full") == Some(true))),
        ("no_changes", Value::Bool(found.flag("no_changes") == Some(true))),
        ("no_text", Value::Bool(found.flag("no_text") == Some(true))),
        (
            "content_boundaries",
            Value::Bool(either("content_boundaries", "AGENT_BROWSER_CONTENT_BOUNDARIES")),
        ),
        ("annotate", Value::Bool(either("annotate", "AGENT_BROWSER_ANNOTATE"))),
        ("screenshot_dir", optional(found.value("screenshot_dir"))),
        ("screenshot_format", optional(found.value("screenshot_format"))),
        ("screenshot_quality", optional(found.value("screenshot_quality"))),
        ("no_auto_dialog", Value::Bool(either("no_auto_dialog", "AGENT_BROWSER_NO_AUTO_DIALOG"))),
        ("capture_console", optional_flag(found.flag("capture_console"))),
        ("show", optional_flag(found.flag("show"))),
        ("enable", listed(found.enable.as_ref(), "AGENT_BROWSER_ENABLE")),
        ("init_scripts", listed(found.init_script.as_ref(), "AGENT_BROWSER_INIT_SCRIPTS")),
    ];
    if either("pin_tab", "AGENT_BROWSER_PIN_TAB") {
        entries.push(("pin_tab", Value::Bool(true)));
    }
    if found.flag("no_pin_tab") == Some(true) {
        match entries.iter_mut().find(|(key, _)| *key == "pin_tab") {
            Some(slot) => slot.1 = Value::Bool(false),
            None => entries.push(("pin_tab", Value::Bool(false))),
        }
    }
    Prepared::Ready(Options { entries, timeout_ms })
}

pub struct Endpoint {
    pub ws: Option<String>,
    pub port: Option<String>,
    pub data_dir: Option<String>,
}

pub fn endpoint_choice(found: &Found) -> Prepared<Endpoint> {
    let mut ws = found.value("ws").map(str::to_string);
    let mut port = found.value("port").map(str::to_string);
    let cdp = non_empty(found.value("cdp")).or_else(|| env("AGENT_BROWSER_CDP"));
    let blank = |value: &Option<String>| value.as_deref().is_none_or(str::is_empty);
    if let Some(cdp) = cdp.filter(|cdp| !cdp.is_empty()) {
        if blank(&ws) && blank(&port) {
            if !cdp.is_ascii() {
                return Prepared::Unported;
            }
            if cdp.bytes().all(|b| b.is_ascii_digit()) {
                port = Some(cdp);
            } else {
                ws = Some(cdp);
            }
        }
    }
    let port = match port {
        Some(text) => match args::python_int(&text) {
            Int::Value(number) => Some(number),
            Int::Invalid => return Prepared::Failed(BrowseError::plain(format!("--port takes a number, not {text}"))),
            Int::Unported => return Prepared::Unported,
        },
        None => None,
    };
    Prepared::Ready(Endpoint {
        ws,
        port,
        data_dir: found.value("data_dir").map(str::to_string),
    })
}

pub fn register_secrets(ws: Option<&str>, secrets: &mut Secrets) -> Option<()> {
    for url in [ws.map(str::to_string), env("ARDIA_CDP_URL"), env("AGENT_BROWSER_CDP")].into_iter().flatten() {
        if url.is_empty() || !url.contains('?') {
            continue;
        }
        for value in url::query_values(&url::split(&url)?.query) {
            secrets.add(&value);
        }
    }
    Some(())
}

pub fn data_root(data_dir: Option<&str>) -> Option<String> {
    let given = non_empty(data_dir).or_else(|| env("ARDIA_DATA_DIR").filter(|dir| !dir.is_empty()));
    if let Some(dir) = &given {
        if dir.starts_with('~') && dir != "~" && !dir.starts_with("~/") {
            return None;
        }
    }
    Some(crate::endpoint::data_root(given.as_deref()).to_string_lossy().into_owned())
}

pub fn endpoint_key(ws: Option<&str>, port: Option<&str>, root: &str) -> Option<String> {
    let url = match ws.filter(|ws| !ws.is_empty()) {
        Some(ws) => Some(ws.to_string()),
        None if port.is_some() => None,
        None => env("ARDIA_CDP_URL").filter(|url| !url.is_empty()),
    };
    if let Some(url) = url {
        let parts = url::split(&url)?;
        return Some(format!("ws:{}://{}{}", parts.scheme, parts.netloc, parts.path));
    }
    if let Some(port) = port {
        return Some(format!("port:{port}"));
    }
    Some(format!("token:{root}"))
}

pub fn session_key(namespace: &str, endpoint_key: &str, session: &str) -> String {
    sha256::hex_digest(format!("{namespace}\0{endpoint_key}\0{session}").as_bytes())[..24].to_string()
}

pub fn agent_env() -> Value {
    let mut entries = crate::json::Map::new();
    for (name, value) in std::env::vars_os() {
        let (Some(name), Some(value)) = (name.to_str(), value.to_str()) else {
            continue;
        };
        if name.starts_with("AGENT_BROWSER_") {
            entries.insert(name, Value::str(value));
        }
    }
    Value::Object(entries)
}

pub fn environment_is_text() -> bool {
    std::env::vars_os().all(|(name, value)| name.to_str().is_some() && value.to_str().is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_sessions_like_paths_py() {
        assert_eq!(session_key("", "token:/tmp/x", "default"), "036010153c73d397580d4d4f");
        assert_eq!(session_key("ns", "port:9", "s\n"), "17d01f59cc5817865bdfb7ec");
        assert_eq!(
            endpoint_key(Some("WS://h:9/devtools/browser/a?token=x#f"), None, "/r").as_deref(),
            Some("ws:ws://h:9/devtools/browser/a")
        );
        assert_eq!(endpoint_key(Some(""), Some("9333"), "/r").as_deref(), Some("port:9333"));
    }
}
