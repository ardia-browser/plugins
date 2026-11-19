use std::ffi::OsString;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;

pub const LABEL: &str = "browse";
pub const PLUGIN_MODE: &str = "ARDIA_BROWSE_FOR_PLUGIN";
pub const REFUSED: i32 = 77;
const SHARED_VALUE_FLAGS: [&[u8]; 4] = [b"--port", b"--ws", b"--data-dir", b"--timeout"];

pub fn invoked(raw: &[OsString]) -> bool {
    let mut index = 0;
    while let Some(token) = raw.get(index) {
        let bytes = token.as_bytes();
        if bytes == b"--json" {
            index += 1;
            continue;
        }
        let name = bytes.split(|byte| *byte == b'=').next().unwrap_or(bytes);
        if SHARED_VALUE_FLAGS.contains(&name) {
            index += if bytes.contains(&b'=') { 1 } else { 2 };
            continue;
        }
        return bytes == LABEL.as_bytes();
    }
    false
}

pub fn for_plugin() -> bool {
    std::env::var_os(PLUGIN_MODE).is_some_and(|value| !value.is_empty())
}

pub const REFUSED_CODE: &str = "plugin_refused";

fn truthy(value: &[u8]) -> bool {
    let text = String::from_utf8_lossy(value);
    !matches!(text.trim().to_lowercase().as_str(), "" | "0" | "false" | "no" | "off")
}

pub fn json_requested(raw: &[OsString]) -> bool {
    let from_env = std::env::var_os("AGENT_BROWSER_JSON").is_some_and(|value| truthy(value.as_bytes()));
    let mut wanted = from_env;
    for token in raw {
        let bytes = token.as_bytes();
        if bytes == b"--" {
            break;
        }
        if bytes == b"--json" {
            wanted = true;
        } else if let Some(value) = bytes.strip_prefix(b"--json=") {
            wanted = truthy(value) || from_env;
        }
    }
    wanted
}

fn json_string(text: &str) -> String {
    let mut out = String::from("\"");
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 || (0x7f..=0x9f).contains(&(control as u32)) => out.push_str(&format!("\\u{:04x}", control as u32)),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

pub fn refusal_line(why: &str, as_json: bool) -> String {
    let message = format!("ardia browse for a plugin ({PLUGIN_MODE}=1) runs only on the TypeScript client, and {why}; nothing was sent");
    if as_json {
        format!(
            "{{\"success\":false,\"data\":null,\"error\":{},\"code\":\"{REFUSED_CODE}\"}}\n",
            json_string(&message)
        )
    } else {
        format!("✗ {message}\n")
    }
}

pub fn refuse(raw: &[OsString], why: &str) -> i32 {
    let as_json = json_requested(raw);
    let line = refusal_line(why, as_json);
    let _ = if as_json {
        std::io::stdout().write_all(line.as_bytes()).and_then(|_| std::io::stdout().flush())
    } else {
        std::io::stderr().write_all(line.as_bytes())
    };
    REFUSED
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn finds_browse_after_the_shared_flags() {
        assert!(invoked(&words(&["browse", "get", "title"])));
        assert!(invoked(&words(&["--json", "--port", "9", "browse"])));
        assert!(invoked(&words(&["--ws=ws://h", "--timeout", "5", "browse"])));
        assert!(!invoked(&words(&["--port"])));
        assert!(!invoked(&words(&["tabs", "browse"])));
        assert!(!invoked(&words(&["--session", "x", "browse"])));
        assert!(!invoked(&words(&[])));
    }

    #[test]
    fn a_refusal_under_json_is_one_json_line_with_a_code() {
        assert!(json_requested(&words(&["browse", "--json", "get"])));
        assert!(json_requested(&words(&["--json", "browse", "get"])));
        assert!(!json_requested(&words(&["browse", "get", "--", "--json"])));
        assert!(!json_requested(&words(&["browse", "--json=0", "get"])));
        assert_eq!(
            refusal_line("it \"broke\"\n", true),
            "{\"success\":false,\"data\":null,\"error\":\"ardia browse for a plugin (ARDIA_BROWSE_FOR_PLUGIN=1) runs only on the \
             TypeScript client, and it \\\"broke\\\"\\n; nothing was sent\",\"code\":\"plugin_refused\"}\n"
        );
        assert!(refusal_line("x", false).starts_with("✗ ardia browse for a plugin"));
    }
}
