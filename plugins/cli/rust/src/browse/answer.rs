use super::tables;
use crate::json::{self, Map, Value};
use crate::py;

pub fn clean_metrics(values: Option<&Value>) -> Map {
    let mut out = Map::new();
    let Some(Value::Object(values)) = values else { return out };
    for (key, value) in values.iter() {
        let key = key.as_str();
        if tables::METRIC_FLAGS.contains(&key) {
            if let Value::Bool(flag) = value {
                out.insert(key, Value::Bool(*flag));
            }
            continue;
        }
        let ceiling = if tables::METRIC_DURATIONS.contains(&key) {
            tables::METRIC_MAX_MS
        } else if tables::METRIC_COUNTS.contains(&key) {
            tables::METRIC_MAX_COUNT
        } else {
            continue;
        };
        let whole = match value {
            Value::Int(number) => *number,
            Value::BigInt(text) => {
                if text.starts_with('-') {
                    0
                } else {
                    ceiling
                }
            }
            Value::Float(number) if number.is_finite() => {
                let rounded = number.round_ties_even();
                if rounded >= ceiling as f64 {
                    ceiling
                } else {
                    rounded as i128
                }
            }
            _ => continue,
        };
        out.insert(key, Value::Int(whole.clamp(0, ceiling)));
    }
    out
}

fn python_int_text(text: &str) -> Option<i64> {
    let body = text.trim_matches(py::is_space);
    let (negative, digits) = match body.as_bytes().first() {
        Some(b'-') => (true, &body[1..]),
        Some(b'+') => (false, &body[1..]),
        _ => (false, body),
    };
    let bytes = digits.as_bytes();
    let well_placed = !bytes.is_empty()
        && bytes.first().is_some_and(u8::is_ascii_digit)
        && bytes.last().is_some_and(u8::is_ascii_digit)
        && bytes.iter().all(|b| b.is_ascii_digit() || *b == b'_')
        && !digits.contains("__");
    if !well_placed {
        return None;
    }
    let number: i64 = digits.replace('_', "").parse().ok()?;
    Some(if negative { -number } else { number })
}

pub fn exit_status(value: Option<&Value>) -> Option<i64> {
    let value = value.filter(|value| py::truthy(value));
    match value {
        None => Some(0),
        Some(Value::Bool(_)) => Some(1),
        Some(Value::Int(number)) => i64::try_from(*number).ok(),
        Some(Value::Float(number)) if number.is_finite() && number.abs() < 9.2e18 => Some(number.trunc() as i64),
        Some(Value::Str(text)) => python_int_text(text),
        _ => None,
    }
}

pub enum Text {
    Missing,
    Given(String),
    Unprintable,
}

pub fn text_of(answer: &Map, key: &str) -> Text {
    match answer.get(key) {
        Some(Value::Str(text)) if !text.is_empty() => Text::Given(text.clone()),
        Some(value) if py::truthy(value) => Text::Unprintable,
        _ => Text::Missing,
    }
}

pub fn output_chars(answer: &Map) -> i128 {
    ["out", "err"]
        .iter()
        .filter_map(|key| match answer.get(key) {
            Some(Value::Str(text)) => Some(text.chars().count() as i128),
            _ => None,
        })
        .sum()
}

pub fn parse(raw: &[u8]) -> Option<Map> {
    match json::parse(raw)? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_metrics_like_command_metrics_py() {
        let raw = json::parse(br#"{"refs": 3, "humanize": true, "cdp_calls": 2.5, "connect_ms": -4, "snapshot_chars": 1e300, "daemon_spawned": 1, "output_chars": "9", "total_ms": 3.5}"#).unwrap();
        let cleaned = clean_metrics(Some(&raw));
        assert_eq!(
            json::dumps(&Value::Object(cleaned), json::Style::Compact, false),
            r#"{"humanize":true,"cdp_calls":2,"connect_ms":0,"snapshot_chars":100000000,"total_ms":4}"#
        );
        assert!(clean_metrics(Some(&Value::Int(1))).is_empty());
    }

    #[test]
    fn reads_exit_like_int() {
        let cases: [(&str, Option<i64>); 10] = [
            ("null", Some(0)),
            ("\"2\"", Some(2)),
            ("\" -3 \"", Some(-3)),
            ("\"1_0\"", Some(10)),
            ("\"1__0\"", None),
            ("2.9", Some(2)),
            ("true", Some(1)),
            ("\"\"", Some(0)),
            ("\"x\"", None),
            ("[1]", None),
        ];
        for (text, expected) in cases {
            assert_eq!(exit_status(json::parse(text.as_bytes()).as_ref()), expected, "{text}");
        }
    }
}
