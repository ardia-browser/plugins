use crate::browse::tables::{STAR_PROMPT, TASK_COMMANDS};
use crate::clock;
use crate::endpoint;
use crate::json::{self, Map, Style, Value};
use crate::paths;
use crate::py;
use crate::telemetry::{self, Call};
use std::io::Write;
use std::path::PathBuf;

const FOLDER: &str = "Usage";
const STATE: &str = "usage.json";
const LOCK: &str = "usage.lock";
const MAX_STATE_BYTES: usize = 64 * 1024;
const MAX_RECENT: usize = 5;
const TASK_GAP_S: f64 = 30.0 * 60.0;
const NOT_RECORDED: &[&str] = &["feedback", "star", "none"];
const TASKS_BEFORE_ASKING: f64 = 5.0;
const STAR_PROMPT_ENV: &str = "ARDIA_STAR_PROMPT";
const OFF_VALUES: &[&str] = &["0", "false", "off", "no"];
const CI_ENV: &[&str] = &["CI", "GITHUB_ACTIONS", "BUILDKITE", "JENKINS_URL"];

fn cli_home() -> PathBuf {
    let home = paths::env_set("ARDIA_CLI_HOME").unwrap_or_else(|| {
        paths::home()
            .join("Library")
            .join("Application Support")
            .join("Ardia")
            .join("CLI")
            .to_string_lossy()
            .into_owned()
    });
    PathBuf::from(paths::pure_path(&paths::expand_user(&home)))
}

fn recording_home() -> Option<PathBuf> {
    if telemetry::is_dev_build() && paths::env_set("ARDIA_CLI_HOME").is_none() {
        return None;
    }
    Some(cli_home())
}

fn number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Int(number)) => *number as f64,
        Some(Value::Float(number)) => *number,
        _ => 0.0,
    }
}

fn int_of(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Int(number)) => Value::Int(*number),
        Some(Value::Float(number)) if number.is_finite() => Value::Int(number.trunc() as i128),
        _ => Value::Int(0),
    }
}

fn remember(state: &mut Map, name: &str, status: i64) -> py::Shape<()> {
    let mut recent: Vec<Value> = py::iterate_or_empty(state.get("recent").unwrap_or(&Value::Null))?
        .into_iter()
        .filter(|entry| matches!(entry, Value::Str(_)))
        .collect();
    recent.push(Value::Str(if status == 0 { name.to_string() } else { format!("{name} (exit {status})") }));
    let start = recent.len().saturating_sub(MAX_RECENT);
    state.insert("recent", Value::Array(recent.split_off(start)));
    Ok(())
}

fn close_stale_task(tasks: &mut Map, now: f64) {
    if tasks.get("open").is_some_and(py::truthy) && now - number(tasks.get("last_at")) > TASK_GAP_S {
        let done = int_of(tasks.get("done"));
        let done = match done {
            Value::Int(number) => Value::Int(number + 1),
            other => other,
        };
        tasks.insert("done", done);
        tasks.insert("open", Value::Bool(false));
    }
}

fn due_for_prompt(state: &Map) -> bool {
    let empty = Map::new();
    let star = match state.get("star") {
        Some(Value::Object(star)) => star,
        _ => &empty,
    };
    let tasks = match state.get("tasks") {
        Some(Value::Object(tasks)) => tasks,
        _ => &empty,
    };
    let unset = |key: &str| !star.get(key).is_some_and(py::truthy);
    unset("prompted_at") && unset("done_at") && number(tasks.get("done")) >= TASKS_BEFORE_ASKING
}

fn note(state: &mut Map, name: &str, status: i64, task: bool, ask: bool, now: f64) -> py::Shape<bool> {
    remember(state, name, status)?;
    let mut tasks = match state.get("tasks") {
        Some(Value::Object(tasks)) => tasks.clone(),
        _ => Map::new(),
    };
    close_stale_task(&mut tasks, now);
    if task {
        tasks.insert("open", Value::Bool(true));
        tasks.insert("last_at", Value::Float(now));
    }
    state.insert("tasks", Value::Object(tasks));
    if !task || !ask || !due_for_prompt(state) {
        return Ok(false);
    }
    let mut star = match state.get("star") {
        None => Map::new(),
        Some(Value::Object(star)) => star.clone(),
        Some(_) => return Err(py::Unsupported),
    };
    star.insert("prompted_at", Value::Float(now));
    state.insert("star", Value::Object(star));
    Ok(true)
}

fn lowered(name: &str) -> String {
    paths::env(name).unwrap_or_default().trim_matches(py::is_space).to_lowercase()
}

fn prompt_allowed() -> bool {
    if OFF_VALUES.contains(&lowered(STAR_PROMPT_ENV).as_str()) {
        return false;
    }
    !CI_ENV.iter().any(|name| !matches!(lowered(name).as_str(), "" | "0" | "false"))
}

fn is_test_context(argv: &[String]) -> bool {
    let tokens = telemetry::leading_tokens(argv);
    if telemetry::names_test_endpoint(tokens) || telemetry::test_endpoint_env() {
        return true;
    }
    let Some(data_dir) = telemetry::data_dir_arg(tokens).or_else(|| paths::env_set("ARDIA_DATA_DIR")) else {
        return false;
    };
    let given = paths::pure_path(&paths::expand_user(&data_dir));
    paths::realpath(&given) != paths::realpath(&endpoint::installed().to_string_lossy())
}

fn task_of(call: &Call, status: i64) -> bool {
    status == 0 && call.command == "browse" && call.subcommand.as_deref().is_some_and(|name| TASK_COMMANDS.contains(&name)) && !is_test_context(&call.argv)
}

pub fn record(call: &Call, status: i64) {
    let Some(home) = recording_home() else { return };
    if NOT_RECORDED.contains(&call.command.as_str()) {
        return;
    }
    let name = [Some(call.command.as_str()), call.subcommand.as_deref()]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if std::fs::create_dir_all(&home).is_err() {
        return;
    }
    let Ok(dir) = paths::open_private(&home, &[FOLDER], true) else { return };
    let Ok(Some(_lock)) = paths::take_lock_retrying(LOCK, &dir) else { return };
    let state = paths::read_private(STATE, &dir, MAX_STATE_BYTES)
        .ok()
        .flatten()
        .and_then(|raw| json::parse(&raw));
    let mut state = match state {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let Ok(prompt) = note(&mut state, &name, status, task_of(call, status), prompt_allowed(), clock::now()) else {
        return;
    };
    if paths::write_private(STATE, &dir, json::dumps(&Value::Object(state), Style::Spaced, false).as_bytes()).is_err() {
        return;
    }
    if prompt {
        let _ = std::io::stdout().flush();
        let _ = writeln!(std::io::stderr(), "{STAR_PROMPT}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembers_the_last_five_and_closes_stale_tasks() {
        let parsed = json::parse(br#"{"recent":["a","b",3,"c","d","e"],"tasks":{"open":true,"last_at":1000,"done":2.0},"star":{}}"#).unwrap();
        let Value::Object(mut state) = parsed else { panic!() };
        assert!(!note(&mut state, "tabs", 2, false, true, 10_000.0).unwrap());
        assert_eq!(
            json::dumps(&Value::Object(state), Style::Spaced, false),
            r#"{"recent": ["b", "c", "d", "e", "tabs (exit 2)"], "tasks": {"open": false, "last_at": 1000, "done": 3}, "star": {}}"#
        );
    }

    #[test]
    fn counts_tasks_and_asks_once() {
        let parsed = json::parse(br#"{"tasks":{"open":true,"last_at":1000,"done":4}}"#).unwrap();
        let Value::Object(mut state) = parsed else { panic!() };
        assert!(note(&mut state, "browse click", 0, true, true, 10_000.0).unwrap());
        assert_eq!(
            json::dumps(&Value::Object(state.clone()), Style::Spaced, false),
            r#"{"tasks": {"open": true, "last_at": 10000.0, "done": 5}, "recent": ["browse click"], "star": {"prompted_at": 10000.0}}"#
        );
        assert!(!note(&mut state, "browse click", 0, true, true, 10_001.0).unwrap());
        let parsed = json::parse(br#"{"tasks":{"done":9},"star":[1]}"#).unwrap();
        let Value::Object(mut broken) = parsed else { panic!() };
        assert!(note(&mut broken, "browse open", 0, true, true, 1.0).is_err());
    }
}
