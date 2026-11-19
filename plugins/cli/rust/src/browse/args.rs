use super::tables;
use crate::py;

const SHARED_VALUE_FLAGS: &[&str] = &["--port", "--ws", "--data-dir", "--timeout"];
const BROWSE_SHARED_FLAGS: &[&str] = &["--port", "--ws", "--data-dir", "--json"];
const COMMAND_OWNS: &[(&str, &[&str])] = &[("stream", &["--port"]), ("screenshot", &["--annotate", "--full"]), ("diff", &["--full"])];

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Found {
    pub values: Vec<(String, String)>,
    pub flags: Vec<(String, bool)>,
    pub enable: Option<Vec<String>>,
    pub init_script: Option<Vec<String>>,
}

impl Found {
    pub fn value(&self, key: &str) -> Option<&str> {
        self.values.iter().find(|(name, _)| name == key).map(|(_, value)| value.as_str())
    }

    pub fn flag(&self, key: &str) -> Option<bool> {
        self.flags.iter().find(|(name, _)| name == key).map(|(_, value)| *value)
    }

    pub fn names_endpoint(&self) -> bool {
        ["ws", "port", "cdp"].iter().any(|key| self.value(key).is_some())
    }

    fn set_value(&mut self, key: String, value: String) {
        match self.values.iter_mut().find(|(name, _)| *name == key) {
            Some(slot) => slot.1 = value,
            None => self.values.push((key, value)),
        }
    }

    fn set_flag(&mut self, key: String, value: bool) {
        match self.flags.iter_mut().find(|(name, _)| *name == key) {
            Some(slot) => slot.1 = value,
            None => self.flags.push((key, value)),
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct Usage(pub String);

pub fn truthy(value: &str) -> bool {
    !matches!(value.trim_matches(py::is_space).to_lowercase().as_str(), "" | "0" | "false" | "no" | "off")
}

fn key_of(name: &str) -> String {
    name.trim_start_matches('-').replace('-', "_")
}

pub fn split_globals(argv: &[String]) -> Result<(Found, Vec<String>), Usage> {
    let mut found = Found::default();
    let mut rest = Vec::new();
    let mut command: Option<&str> = None;
    let mut index = 0;
    while index < argv.len() {
        let token = argv[index].as_str();
        index += 1;
        if token == "--" {
            rest.extend(argv[index - 1..].iter().cloned());
            break;
        }
        let (name, inline) = match token.split_once('=') {
            Some((name, value)) if token.starts_with("--") => (name, Some(value.to_string())),
            _ => (token, None),
        };
        let owned = COMMAND_OWNS
            .iter()
            .find(|(owner, _)| Some(*owner) == command)
            .is_some_and(|(_, flags)| flags.contains(&name));
        if tables::VALUE_FLAGS.contains(&name) && !owned {
            let value = match inline {
                Some(value) => value,
                None => {
                    let Some(value) = argv.get(index) else {
                        return Err(Usage(format!("{name} needs a value")));
                    };
                    index += 1;
                    value.clone()
                }
            };
            let key = key_of(name);
            match name {
                "--enable" => found.enable.get_or_insert_with(Vec::new).extend(value.split(',').map(str::to_string)),
                "--init-script" => found.init_script.get_or_insert_with(Vec::new).push(value),
                _ => found.set_value(key, value),
            }
            continue;
        }
        if tables::BOOL_FLAGS.contains(&name) && !owned {
            found.set_flag(key_of(name), inline.as_deref().is_none_or(truthy));
            continue;
        }
        if let Some((_, hint)) = tables::LAUNCH_HINTS.iter().find(|(flag, _)| *flag == name) {
            return Err(Usage(format!(
                "{name} is a launch option agent-browser applies when it starts its own browser; {hint}"
            )));
        }
        if tables::LAUNCH_ONLY.contains(&name) {
            return Err(Usage(format!(
                "{name} doesn't apply to Ardia: ardia browse drives the browser you're running, so launch options have no effect"
            )));
        }
        if command.is_none() && !token.starts_with('-') {
            command = Some(token);
        }
        rest.push(token.to_string());
    }
    Ok((found, rest))
}

pub enum Hoisted {
    Browse(Vec<String>),
    NotBrowse,
}

pub fn browse_argv(argv: &[String], env: impl Fn(&str) -> Option<String>) -> Hoisted {
    let mut leading = Vec::new();
    let mut index = 0;
    while index < argv.len() {
        let token = &argv[index];
        let name = token.split('=').next().unwrap_or("");
        if SHARED_VALUE_FLAGS.contains(&name) {
            if token.contains('=') {
                leading.push(token.clone());
                index += 1;
                continue;
            }
            if index + 1 >= argv.len() {
                return Hoisted::NotBrowse;
            }
            leading.extend(argv[index..index + 2].iter().cloned());
            index += 2;
            continue;
        }
        if token == "--json" {
            leading.push(token.clone());
            index += 1;
            continue;
        }
        break;
    }
    if argv.get(index).map(String::as_str) != Some("browse") {
        return Hoisted::NotBrowse;
    }
    let refused = leading
        .iter()
        .filter(|token| token.starts_with("--"))
        .any(|token| !BROWSE_SHARED_FLAGS.contains(&token.split('=').next().unwrap_or("")));
    if refused {
        return Hoisted::NotBrowse;
    }
    let mut browse: Vec<String> = leading.into_iter().chain(argv[index + 1..].iter().cloned()).collect();
    let Ok((found, _)) = split_globals(&browse) else {
        return Hoisted::Browse(browse);
    };
    if found.names_endpoint() {
        return Hoisted::Browse(browse);
    }
    if let Some(ws) = env("ARDIA_WS").filter(|value| !value.is_empty()) {
        browse.splice(0..0, ["--ws".to_string(), ws]);
    } else if let Some(port) = env("ARDIA_PORT").filter(|value| !value.is_empty()) {
        browse.splice(0..0, ["--port".to_string(), port]);
    }
    Hoisted::Browse(browse)
}

fn command_name(text: &str) -> bool {
    let mut bytes = text.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z')) && text.len() <= 32 && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn subcommand(browse: &[String]) -> String {
    let Ok((_, rest)) = split_globals(browse) else {
        return "other".to_string();
    };
    let name = rest.first().map_or("help", String::as_str);
    let name = match name {
        "--help" | "-h" => "help",
        "--version" | "-V" => "version",
        other => other,
    };
    if command_name(name) {
        name.to_string()
    } else {
        "other".to_string()
    }
}

pub fn allowed_flags(name: &str) -> Vec<&'static str> {
    let mut allowed: Vec<&'static str> = tables::VALUE_FLAGS.iter().chain(tables::BOOL_FLAGS).copied().collect();
    if let Some((_, local)) = tables::COMMAND_FLAGS.iter().find(|(command, _)| *command == name) {
        allowed.extend(local.iter().copied());
    }
    allowed
}

pub fn check_name(kind: &str, name: &str) -> Result<(), String> {
    let body = name.strip_suffix('\n').unwrap_or(name);
    let mut bytes = body.bytes();
    let valid = matches!(bytes.next(), Some(b) if b.is_ascii_alphanumeric())
        && body.len() <= 64
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(format!(
            "{kind} must be 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit"
        ))
    }
}

pub enum Int {
    Value(String),
    Invalid,
    Unported,
}

pub fn python_int(text: &str) -> Int {
    if !text.is_ascii() || text.bytes().any(|b| b.is_ascii_whitespace() || b == b'_' || (0x1c..=0x1f).contains(&b)) {
        return if text.is_ascii() && !text.bytes().any(|b| b.is_ascii_digit()) && !text.contains('_') {
            Int::Invalid
        } else {
            Int::Unported
        };
    }
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Int::Invalid;
    }
    if digits.len() > 4300 {
        return Int::Unported;
    }
    let trimmed = digits.trim_start_matches('0');
    if trimmed.is_empty() {
        return Int::Value("0".to_string());
    }
    Int::Value(if negative { format!("-{trimmed}") } else { trimmed.to_string() })
}

pub fn python_float(text: &str) -> Option<f64> {
    let body = text.trim_matches(|c: char| c.is_ascii_whitespace());
    if !body.is_ascii() || body.is_empty() || body.len() > 300 {
        return None;
    }
    let unsigned = body.strip_prefix(['+', '-']).unwrap_or(body);
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(at) => (&unsigned[..at], Some(&unsigned[at + 1..])),
        None => (unsigned, None),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits_ok = !(whole.is_empty() && fraction.is_empty()) && whole.bytes().all(|b| b.is_ascii_digit()) && fraction.bytes().all(|b| b.is_ascii_digit());
    let exponent_ok = exponent.is_none_or(|exponent| {
        let exponent = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
        !exponent.is_empty() && exponent.bytes().all(|b| b.is_ascii_digit())
    });
    if !digits_ok || !exponent_ok {
        return None;
    }
    body.parse::<f64>().ok().filter(|value| value.is_finite())
}

pub enum Duration {
    Millis(i128),
    Invalid,
    Unported,
}

pub fn parse_duration(value: &str) -> Duration {
    if !value.is_ascii() {
        return Duration::Unported;
    }
    let body = value.trim_matches(py::is_space);
    let (number, unit) = match body.strip_suffix("ms") {
        Some(number) => (number, 1.0),
        None => match body.as_bytes().last() {
            Some(b's') => (&body[..body.len() - 1], 1000.0),
            Some(b'm') => (&body[..body.len() - 1], 60_000.0),
            Some(b'h') => (&body[..body.len() - 1], 3_600_000.0),
            _ => (body, 1.0),
        },
    };
    let (whole, fraction) = match number.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (number, None),
    };
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || !fraction.is_none_or(digits) {
        return Duration::Invalid;
    }
    if number.len() > 300 {
        return Duration::Unported;
    }
    let Ok(parsed) = number.parse::<f64>() else { return Duration::Unported };
    let product = parsed * unit;
    if !product.is_finite() || product.abs() >= 1e38 {
        return Duration::Unported;
    }
    Duration::Millis(product.trunc() as i128)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| word.to_string()).collect()
    }

    #[test]
    fn splits_globals_like_browse_cli() {
        let (found, rest) = split_globals(&strings(&[
            "--json=0",
            "get",
            "--session=w",
            "title",
            "--enable",
            "a,b",
            "--init-script",
            "x.js",
            "--",
            "--json",
        ]))
        .unwrap();
        assert_eq!(found.flag("json"), Some(false));
        assert_eq!(found.value("session"), Some("w"));
        assert_eq!(found.enable, Some(strings(&["a", "b"])));
        assert_eq!(found.init_script, Some(strings(&["x.js"])));
        assert_eq!(rest, strings(&["get", "title", "--", "--json"]));
        let (found, rest) = split_globals(&strings(&["screenshot", "--full", "--annotate", "--show"])).unwrap();
        assert_eq!(found.flag("show"), Some(true));
        assert_eq!(rest, strings(&["screenshot", "--full", "--annotate"]));
        assert_eq!(split_globals(&strings(&["get", "--session"])), Err(Usage("--session needs a value".into())));
        assert!(split_globals(&strings(&["--headed"])).unwrap_err().0.starts_with("--headed doesn't apply"));
        assert!(split_globals(&strings(&["--headers", "{}"])).unwrap_err().0.contains("set headers"));
    }

    #[test]
    fn hoists_and_injects_like_cli_py() {
        let env = |name: &str| (name == "ARDIA_PORT").then(|| "9444".to_string());
        let Hoisted::Browse(argv) = browse_argv(&strings(&["--json", "--data-dir", "/d", "browse", "get", "title"]), env) else {
            panic!()
        };
        assert_eq!(argv, strings(&["--port", "9444", "--json", "--data-dir", "/d", "get", "title"]));
        let Hoisted::Browse(argv) = browse_argv(&strings(&["browse", "--cdp", "1", "get"]), env) else {
            panic!()
        };
        assert_eq!(argv, strings(&["--cdp", "1", "get"]));
        assert!(matches!(browse_argv(&strings(&["--timeout", "5", "browse", "get"]), env), Hoisted::NotBrowse));
        assert!(matches!(browse_argv(&strings(&["--port"]), env), Hoisted::NotBrowse));
        assert!(matches!(browse_argv(&strings(&["tabs"]), env), Hoisted::NotBrowse));
    }

    #[test]
    fn names_subcommands_like_telemetry() {
        assert_eq!(subcommand(&strings(&["--json", "get", "title"])), "get");
        assert_eq!(subcommand(&strings(&[])), "help");
        assert_eq!(subcommand(&strings(&["-V"])), "version");
        assert_eq!(subcommand(&strings(&["Get"])), "other");
        assert_eq!(subcommand(&strings(&["--headed", "open"])), "other");
        assert!(allowed_flags("open").contains(&"--read"));
        assert!(!allowed_flags("").contains(&"--read"));
    }

    #[test]
    fn checks_names_like_paths_py() {
        assert!(check_name("A session name", "work.1_a-b").is_ok());
        assert!(check_name("A session name", "abc\n").is_ok());
        assert!(check_name("A session name", "abc\n\n").is_err());
        assert!(check_name("A session name", "-a").is_err());
        assert!(check_name("A session name", &"a".repeat(65)).is_err());
        assert!(check_name("A session name", "").is_err());
    }

    #[test]
    fn reads_numbers_like_python() {
        assert!(matches!(python_int("+007"), Int::Value(v) if v == "7"));
        assert!(matches!(python_int("-0"), Int::Value(v) if v == "0"));
        assert!(matches!(python_int("abc"), Int::Invalid));
        assert!(matches!(python_int(""), Int::Invalid));
        assert!(matches!(python_int("1.5"), Int::Invalid));
        assert!(matches!(python_int(" 5"), Int::Unported));
        assert!(matches!(python_int("1_0"), Int::Unported));
        assert!(matches!(python_int("٣"), Int::Unported));
        assert_eq!(python_float(" 4000 "), Some(4000.0));
        assert_eq!(python_float("1e3"), Some(1000.0));
        assert_eq!(python_float(".5"), Some(0.5));
        assert_eq!(python_float("inf"), None);
        assert_eq!(python_float("1_0"), None);
        assert!(matches!(parse_duration("1.5s"), Duration::Millis(1500)));
        assert!(matches!(parse_duration(" 3m "), Duration::Millis(180_000)));
        assert!(matches!(parse_duration("10"), Duration::Millis(10)));
        assert!(matches!(parse_duration("10x"), Duration::Invalid));
        assert!(matches!(parse_duration("ms"), Duration::Invalid));
        assert!(matches!(parse_duration("1."), Duration::Invalid));
    }
}
