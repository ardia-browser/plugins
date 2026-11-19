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

pub fn refuse(why: &str) -> i32 {
    let _ = writeln!(
        std::io::stderr(),
        "✗ ardia browse for a plugin ({PLUGIN_MODE}=1) runs only on the TypeScript client, and {why}; nothing was sent"
    );
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
}
