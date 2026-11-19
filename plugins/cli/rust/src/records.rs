use crate::clock;
use crate::json::{Map, Value};
use crate::telemetry::{leading_tokens, sharing_id, uuid7, version, watch_report, Call, SERVED_BY};

const MAX_FLAGS: usize = 20;
const MAX_MS: f64 = 3_600_000.0;
const MECHANISM: &str = "cli_unhandled";

pub(crate) fn exception_record(errno: i32, distinct_id: &str, environment: &str, doc: Option<&Map>, session: &str) -> Value {
    let kind = crate::printable::python_os_error(errno);
    let value = format!("[Errno {errno}] {}", crate::paths::strerror(errno));
    let mut properties = vec![
        ("$exception_level", Value::str("fatal")),
        ("source", Value::str(MECHANISM)),
        ("$exception_types", Value::Array(vec![Value::str(kind)])),
        ("$exception_values", Value::Array(vec![Value::str(&value)])),
        (
            "$exception_list",
            Value::Array(vec![Value::object(vec![
                ("type", Value::str(kind)),
                ("value", Value::str(&value)),
                (
                    "mechanism",
                    Value::object(vec![
                        ("type", Value::str(MECHANISM)),
                        ("handled", Value::Bool(false)),
                        ("synthetic", Value::Bool(false)),
                    ]),
                ),
                (
                    "stacktrace",
                    Value::object(vec![("type", Value::str("raw")), ("frames", Value::Array(Vec::new()))]),
                ),
            ])]),
        ),
        ("error_code", Value::Null),
        ("cli_version", Value::str(version())),
        ("$environment", Value::str(environment)),
    ];
    common_properties(&mut properties, doc, session);
    event("$exception", distinct_id, properties)
}

fn flag_names(argv: &[String], allowed: &[&str]) -> String {
    let mut names: Vec<&str> = leading_tokens(argv)
        .iter()
        .filter(|token| token.starts_with('-'))
        .map(|token| token.split('=').next().unwrap_or(""))
        .filter(|name| allowed.contains(name))
        .collect();
    names.sort_unstable();
    names.dedup();
    names.truncate(MAX_FLAGS);
    names.join(",")
}

fn whole_ms(value: f64) -> Value {
    Value::Int(value.round_ties_even().clamp(0.0, MAX_MS) as i128)
}

fn timings(call: &Call, into: &mut Vec<(&'static str, Value)>) {
    let elapsed = call.started.elapsed().as_secs_f64() * 1000.0;
    let startup = clock::process_started_at().map(|started| (call.started_at - started) * 1000.0);
    match startup {
        Some(startup) if (0.0..=MAX_MS).contains(&startup) => {
            into.push(("startup_ms", whole_ms(startup)));
            into.push(("total_ms", whole_ms(startup + elapsed)));
        }
        _ => into.push(("total_ms", whole_ms(elapsed))),
    }
}

fn error_code_ok(code: &str) -> bool {
    let mut bytes = code.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z')) && code.len() <= 41 && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

pub(crate) fn command_record(call: &Call, status: i64, crashed: bool, distinct_id: &str, environment: &str, doc: Option<&Map>, session: &str) -> Value {
    let error_code = if crashed { Some("unhandled_exception") } else { call.error_code.as_deref() };
    let error_code = error_code.filter(|code| error_code_ok(code)).map_or(Value::Null, Value::str);
    let mut properties = vec![
        ("command", Value::str(&call.command)),
        ("subcommand", call.subcommand.as_deref().map_or(Value::Null, Value::str)),
        ("exit_code", Value::Int(i128::from(status))),
        ("error_code", error_code),
        ("flags", Value::str(&flag_names(&call.argv, call.allowed_flags))),
    ];
    timings(call, &mut properties);
    properties.push(("cli_version", Value::str(version())));
    properties.push(("$environment", Value::str(environment)));
    properties.push(("served_by", Value::str(SERVED_BY)));
    common_properties(&mut properties, doc, session);
    event("cli_command", distinct_id, properties)
}

pub(crate) fn common_properties(properties: &mut Vec<(&'static str, Value)>, doc: Option<&Map>, session: &str) {
    properties.push(("$session_id", Value::str(session)));
    if let Some(report) = doc.filter(|doc| sharing_id(Some(doc)).is_some()).and_then(watch_report) {
        properties.push(("watch_report", Value::Str(report)));
    }
}

pub(crate) fn event(name: &str, distinct_id: &str, properties: Vec<(&'static str, Value)>) -> Value {
    Value::object(vec![
        ("uuid", Value::str(&uuid7())),
        ("event", Value::str(name)),
        ("distinct_id", Value::str(distinct_id)),
        ("timestamp", Value::str(&clock::iso(clock::now()))),
        ("properties", Value::object(properties)),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry;

    #[test]
    fn names_only_known_flags() {
        let argv: Vec<String> = ["--json", "tabs", "--window=w-1", "--flat", "--json", "--", "--usage"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(flag_names(&argv, &["--json", "--window", "--flat", "--usage"]), "--flat,--json,--window");
        assert!(telemetry::loopback_url("http://127.0.0.1:9/v1/logs"));
        assert!(!telemetry::loopback_url("http://example.com:9/x"));
        assert!(!telemetry::loopback_url("https://127.0.0.1:9/x"));
        assert_eq!(
            telemetry::data_dir_arg(&["--data-dir".into(), "a".into(), "--data-dir=b".into()]),
            Some("b".into())
        );
        assert!(error_code_ok("connection_dropped"));
        assert!(!error_code_ok("Bad"));
    }
}
