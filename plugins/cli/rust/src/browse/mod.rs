pub mod answer;
pub mod args;
pub mod client;
pub mod errors;
pub mod output;
pub mod redact;
pub mod request;
pub mod sha256;
#[rustfmt::skip]
pub mod tables;
pub mod url;

use crate::caller;
use crate::control;
use crate::json::{self, Map, Style, Value};
use crate::telemetry::{self, Call};
use args::Hoisted;
use client::{Connected, Opened, Reply, Step};
use errors::BrowseError;
use output::Printer;
use redact::Secrets;
use request::Prepared;

const PYTHON_COMMANDS: &[&str] = &["auth", "notes", "flow", "plugin", "read", "session", "script"];
const HELP_WORDS: &[&str] = &["help", "--help", "-h"];

#[derive(Debug, PartialEq)]
pub struct Plan {
    pub label: String,
    browse: Vec<String>,
}

pub enum Served {
    Status(i64),
    Python(Option<Vec<u8>>),
}

fn takes_out(command: &str, browse: &[String]) -> bool {
    tables::TAKES_OUT.contains(&command) && browse.iter().any(|token| token == "--out" || token.starts_with("--out="))
}

pub fn plan(argv: &[String]) -> Option<Plan> {
    let Hoisted::Browse(browse) = args::browse_argv(argv, request::env) else {
        return None;
    };
    let label = format!("browse {}", args::subcommand(&browse));
    let Ok((_, rest)) = args::split_globals(&browse) else {
        return Some(Plan { label, browse });
    };
    let command = rest.first()?.as_str();
    let tail = &rest[1..];
    let hands_off = HELP_WORDS.contains(&command)
        || (!matches!(command, "--version" | "-V") && tail.iter().any(|token| token == "--help" || token == "-h"))
        || PYTHON_COMMANDS.contains(&command)
        || (command == "close" && tail.iter().any(|token| token == "--all"))
        || takes_out(command, &browse);
    (!hands_off).then_some(Plan { label, browse })
}

impl Plan {
    pub fn subcommand(&self) -> &str {
        self.label.strip_prefix("browse ").unwrap_or("")
    }
}

fn eval_code_given(args: &[String]) -> bool {
    let mut index = 0;
    while index < args.len() {
        let token = args[index].as_str();
        if matches!(token, "--out" | "--timeout" | "--max-output") {
            index += 2;
            continue;
        }
        if !token.starts_with('-') || token == "-" {
            return true;
        }
        index += 1;
    }
    false
}

fn stdin_is_tty() -> Option<bool> {
    if unsafe { libc::fcntl(0, libc::F_GETFD) } < 0 {
        return None;
    }
    Some(unsafe { libc::isatty(0) } == 1)
}

fn reads_stdin(command: &str, args: &[String]) -> Option<bool> {
    let flagged = matches!(command, "eval" | "addinitscript") && args.iter().any(|arg| arg == "--stdin");
    if flagged {
        return Some(true);
    }
    let wants = match command {
        "eval" => !eval_code_given(args),
        "batch" => args.iter().all(|arg| arg.starts_with("--")),
        _ => false,
    };
    if !wants {
        return Some(false);
    }
    Some(!stdin_is_tty()?)
}

enum Input {
    Text(String),
    Undecodable(Vec<u8>),
    Interrupted,
}

fn read_stdin() -> Input {
    let mut raw = Vec::new();
    let mut buffer = vec![0u8; 65536];
    loop {
        let got = unsafe { libc::read(0, buffer.as_mut_ptr().cast(), buffer.len()) };
        if got > 0 {
            raw.extend_from_slice(&buffer[..got as usize]);
            continue;
        }
        if got == 0 {
            break;
        }
        if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            if control::interrupted() {
                return Input::Interrupted;
            }
            continue;
        }
        return Input::Undecodable(raw);
    }
    match String::from_utf8(raw) {
        Ok(text) => Input::Text(text),
        Err(error) => Input::Undecodable(error.into_bytes()),
    }
}

struct Session {
    payload: Map,
    command: String,
    timeout_ms: f64,
    root: String,
    namespace: String,
    endpoint_key: String,
    session: String,
}

enum Flow {
    Answer(Map),
    Malformed(&'static str),
    Error(BrowseError),
    Interrupted,
    Python,
}

fn ask(stream: std::os::unix::net::UnixStream, payload: &Map, command: &str, timeout_ms: f64, patient: bool) -> Flow {
    let argv: Vec<String> = match payload.get("argv") {
        Some(Value::Array(items)) => items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    };
    let Some(seconds) = client::answer_deadline(&argv, timeout_ms, patient) else {
        return Flow::Error(BrowseError::plain("the answer deadline couldn't be worked out"));
    };
    let mut line = json::dumps(&Value::Object(payload.clone()), Style::Spaced, false).into_bytes();
    line.push(b'\n');
    match client::exchange(stream, &line, command, seconds, client::MAX_RESPONSE) {
        Reply::Raw(raw) => match answer::parse(&raw) {
            Some(answer) => Flow::Answer(answer),
            None => Flow::Malformed("it isn't a JSON object"),
        },
        Reply::Failed(error) => Flow::Error(error),
        Reply::Interrupted => Flow::Interrupted,
    }
}

fn open_session(root: &str, key: &str) -> Result<std::os::unix::net::UnixStream, Flow> {
    let dir = match client::browse_dir(root) {
        Opened::Dir(dir) => dir,
        Opened::Refused(message) => return Err(Flow::Error(BrowseError::plain(message))),
        Opened::Unported => return Err(Flow::Python),
    };
    match client::connect(&dir, key) {
        Step::Done(Connected::Stream(stream)) => Ok(stream),
        Step::Done(Connected::Absent) | Step::Unported => Err(Flow::Python),
        Step::Failed(error) => Err(Flow::Error(error)),
    }
}

fn read_beside(session: &Session) -> Flow {
    let beside = format!("{}-side", session.session.chars().take(59).collect::<String>());
    let key = request::session_key(&session.namespace, &session.endpoint_key, &beside);
    let stream = match open_session(&session.root, &key) {
        Ok(stream) => stream,
        Err(Flow::Python) => {
            return Flow::Error(BrowseError::unreachable(
                "the ardia browse daemon asked to run this beside a busy session, and that session's daemon isn't running",
            ))
        }
        Err(other) => return other,
    };
    let mut payload = session.payload.clone();
    if let Some(Value::Object(options)) = payload.get("options") {
        let mut options = options.clone();
        options.insert("_session", Value::str(&beside));
        payload.insert("options", Value::Object(options));
    }
    payload.remove("beside_if_busy");
    payload.insert("patient_queue", Value::Bool(true));
    match ask(stream, &payload, &session.command, session.timeout_ms, true) {
        Flow::Answer(mut answer) => {
            let mut metrics = match answer.get("metrics") {
                Some(Value::Object(metrics)) => metrics.clone(),
                _ => Map::new(),
            };
            metrics.insert("read_beside_busy", Value::Bool(true));
            answer.insert("metrics", Value::Object(metrics));
            Flow::Answer(answer)
        }
        other => other,
    }
}

fn prepare(found: &args::Found, rest: &[String], secrets: &mut Secrets) -> Result<(Session, bool), Flow> {
    let options = match request::options_from(found) {
        Prepared::Ready(options) => options,
        Prepared::Failed(error) => return Err(Flow::Error(error)),
        Prepared::Unported => return Err(Flow::Python),
    };
    let session = request::env("AGENT_BROWSER_SESSION");
    let session = found
        .value("session")
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or(session.filter(|value| !value.is_empty()))
        .unwrap_or_else(|| "default".to_string());
    if let Err(message) = args::check_name("A session name", &session) {
        return Err(Flow::Error(BrowseError::plain(message)));
    }
    let namespace = found
        .value("namespace")
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or(request::env("AGENT_BROWSER_NAMESPACE"))
        .unwrap_or_default();
    if !namespace.is_empty() {
        if let Err(message) = args::check_name("A namespace", &namespace) {
            return Err(Flow::Error(BrowseError::plain(message)));
        }
    }
    let endpoint = match request::endpoint_choice(found) {
        Prepared::Ready(endpoint) => endpoint,
        Prepared::Failed(error) => return Err(Flow::Error(error)),
        Prepared::Unported => return Err(Flow::Python),
    };
    request::register_secrets(endpoint.ws.as_deref(), secrets).ok_or(Flow::Python)?;
    let root = request::data_root(endpoint.data_dir.as_deref()).ok_or(Flow::Python)?;
    let endpoint_key = request::endpoint_key(endpoint.ws.as_deref(), endpoint.port.as_deref(), &root).ok_or(Flow::Python)?;
    let command = rest[0].clone();
    let args = &rest[1..];
    let mut entries = Map::new();
    for (key, value) in options.entries {
        entries.insert(key, value);
    }
    entries.insert("_session", Value::str(&session));
    let mut payload = Map::new();
    payload.insert("argv", Value::Array(rest.iter().map(|arg| Value::str(arg)).collect()));
    payload.insert("options", Value::Object(entries));
    let stdin = reads_stdin(&command, args).ok_or(Flow::Python)?;
    let session = Session {
        payload,
        command,
        timeout_ms: options.timeout_ms,
        root,
        namespace,
        endpoint_key,
        session,
    };
    Ok((session, stdin))
}

fn check_idle(found: &args::Found) -> Result<(), Flow> {
    let idle = found
        .value("idle_timeout")
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or(request::env("AGENT_BROWSER_IDLE_TIMEOUT_MS").filter(|value| !value.is_empty()));
    let Some(idle) = idle else { return Ok(()) };
    match args::parse_duration(&idle) {
        args::Duration::Millis(_) => Ok(()),
        args::Duration::Invalid => Err(Flow::Error(BrowseError::plain(format!(
            "--idle-timeout takes 10s, 3m, 1h or milliseconds, not {idle}"
        )))),
        args::Duration::Unported => Err(Flow::Python),
    }
}

fn round_trip(found: &args::Found, rest: &[String], secrets: &mut Secrets, stdin: &mut Option<Vec<u8>>) -> Flow {
    let (mut session, wants_stdin) = match prepare(found, rest, secrets) {
        Ok(prepared) => prepared,
        Err(flow) => return flow,
    };
    let text = if wants_stdin {
        match read_stdin() {
            Input::Text(text) => {
                *stdin = Some(text.clone().into_bytes());
                Value::Str(text)
            }
            Input::Undecodable(raw) => {
                *stdin = Some(raw);
                return Flow::Python;
            }
            Input::Interrupted => return Flow::Interrupted,
        }
    } else {
        Value::Null
    };
    if let Err(flow) = check_idle(found) {
        return flow;
    }
    let Ok(cwd) = std::env::current_dir() else { return Flow::Python };
    let Some(cwd) = cwd.to_str().map(str::to_string) else { return Flow::Python };
    let argv: Vec<String> = rest.to_vec();
    if client::answer_deadline(&argv, session.timeout_ms, false).is_none() {
        return Flow::Python;
    }
    session.payload.insert("cwd", Value::Str(cwd));
    session.payload.insert("env", request::agent_env());
    session.payload.insert("stdin", text);
    session.payload.insert("telemetry", Value::Bool(telemetry::shareable()));
    session.payload.insert("caller", caller::current().wire());
    let key = request::session_key(&session.namespace, &session.endpoint_key, &session.session);
    let stream = match open_session(&session.root, &key) {
        Ok(stream) => stream,
        Err(flow) => return flow,
    };
    if control::interrupted() {
        return Flow::Interrupted;
    }
    match ask(stream, &session.payload, &session.command, session.timeout_ms, false) {
        Flow::Answer(answer) if answer.get("busy_elsewhere").is_some_and(crate::py::truthy) => read_beside(&session),
        other => other,
    }
}

pub fn serve(plan: &Plan, argv: &[String], python: Option<&std::path::Path>) -> Served {
    if !request::environment_is_text() {
        return Served::Python(None);
    }
    let mut call = Call::new(argv);
    call.command = "browse".into();
    call.subcommand = Some(plan.subcommand().to_string());
    call.allowed_flags = args::allowed_flags(plan.subcommand());
    let mut printer = Printer::default();
    let status = match args::split_globals(&plan.browse) {
        Err(usage) => printer.usage_error(&usage.0),
        Ok((_, rest)) if matches!(rest.first().map(String::as_str), Some("--version" | "-V")) => printer.say_version(),
        Ok((found, rest)) => {
            let as_json = found.flag("json") == Some(true) || args::truthy(&request::env("AGENT_BROWSER_JSON").unwrap_or_default());
            let mut secrets = Secrets::default();
            let mut stdin = None;
            let interrupts = control::catch_interrupts_unrestarted();
            let flow = round_trip(&found, &rest, &mut secrets, &mut stdin);
            drop(interrupts);
            match flow {
                Flow::Python => return Served::Python(stdin),
                Flow::Interrupted => printer.interrupted(),
                Flow::Error(error) => printer.error(&error, as_json, &secrets, &mut call),
                Flow::Malformed(why) => printer.crashed(why, &mut call),
                Flow::Answer(answer) => printer.answer(&answer, &secrets, &mut call),
            }
        }
    };
    telemetry::finish(&call, status, python);
    Served::Status(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn planned(words: &[&str]) -> Option<String> {
        plan(&words.iter().map(|word| word.to_string()).collect::<Vec<_>>()).map(|plan| plan.label)
    }

    #[test]
    fn plans_the_daemon_round_trip() {
        assert_eq!(planned(&["browse", "get", "title"]).as_deref(), Some("browse get"));
        assert_eq!(
            planned(&["--json", "browse", "--session", "w", "click", "@e1"]).as_deref(),
            Some("browse click")
        );
        assert_eq!(planned(&["browse", "--version"]).as_deref(), Some("browse version"));
        assert_eq!(planned(&["browse", "--headed", "open"]).as_deref(), Some("browse other"));
        assert_eq!(planned(&["browse", "Get"]).as_deref(), Some("browse other"));
        assert_eq!(planned(&["browse", "close"]).as_deref(), Some("browse close"));
    }

    #[test]
    fn hands_the_rest_to_python() {
        for words in [
            &["browse"][..],
            &["browse", "--help"],
            &["browse", "help", "get"],
            &["browse", "get", "--help"],
            &["browse", "read", "https://example.com"],
            &["browse", "auth", "list"],
            &["browse", "script"],
            &["browse", "close", "--all"],
            &["browse", "get", "text", "body", "--out", "x.txt"],
            &["--timeout", "5", "browse", "get"],
            &["tabs"],
        ] {
            assert_eq!(planned(words), None, "{words:?}");
        }
    }

    #[test]
    fn reads_stdin_when_python_does() {
        let words = |list: &[&str]| list.iter().map(|word| word.to_string()).collect::<Vec<_>>();
        assert!(eval_code_given(&words(&["1+1"])));
        assert!(!eval_code_given(&words(&["--timeout", "5", "--stdin"])));
        assert!(eval_code_given(&words(&["-"])));
        assert_eq!(reads_stdin("addinitscript", &words(&["--stdin"])), Some(true));
        assert_eq!(reads_stdin("get", &words(&["--stdin"])), Some(false));
    }
}
