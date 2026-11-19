use crate::clock;
use crate::json::{self, Map, Style, Value};
use crate::paths;
use crate::py;
use crate::telemetry::{self, Call};
use std::path::PathBuf;

const FOLDER: &str = "Usage";
const STATE: &str = "usage.json";
const LOCK: &str = "usage.lock";
const MAX_STATE_BYTES: usize = 64 * 1024;
const MAX_RECENT: usize = 5;
const TASK_GAP_S: f64 = 30.0 * 60.0;
const NOT_RECORDED: &[&str] = &["feedback", "star", "none"];

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

fn note(state: &mut Map, name: &str, status: i64, now: f64) -> py::Shape<()> {
    remember(state, name, status)?;
    let mut tasks = match state.get("tasks") {
        Some(Value::Object(tasks)) => tasks.clone(),
        _ => Map::new(),
    };
    close_stale_task(&mut tasks, now);
    state.insert("tasks", Value::Object(tasks));
    Ok(())
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
    let raw = paths::read_private(STATE, &dir, MAX_STATE_BYTES).ok().flatten();
    let Ok(state) = raw.map_or(Ok(None), |raw| json::parse_limited(&raw, json::TELEMETRY_DEPTH)) else {
        return;
    };
    let mut state = match state {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    if note(&mut state, &name, status, clock::now()).is_err() {
        return;
    }
    let _ = paths::write_private(
        STATE,
        &dir,
        crate::pystr::well_formed(&json::dumps(&Value::Object(state), Style::Spaced, false)).as_bytes(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembers_the_last_five_and_closes_stale_tasks() {
        let parsed = json::parse(br#"{"recent":["a","b",3,"c","d","e"],"tasks":{"open":true,"last_at":1000,"done":2.0},"star":{}}"#).unwrap();
        let Value::Object(mut state) = parsed else { panic!() };
        note(&mut state, "tabs", 2, 10_000.0).unwrap();
        assert_eq!(
            json::dumps(&Value::Object(state), Style::Spaced, false),
            r#"{"recent": ["b", "c", "d", "e", "tabs (exit 2)"], "tasks": {"open": false, "last_at": 1000, "done": 3}, "star": {}}"#
        );
    }
}
