use crate::json::{float_repr, Map, Value};
use crate::pystr;

#[derive(Debug, PartialEq)]
pub struct Unsupported;

pub type Shape<T> = Result<T, Unsupported>;

pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Int(number) => *number != 0,
        Value::BigInt(_) => true,
        Value::Float(number) => *number != 0.0,
        Value::Str(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

pub fn get<'a>(value: &'a Value, key: &str) -> Shape<Option<&'a Value>> {
    match value {
        Value::Object(map) => Ok(map.get(key)),
        _ => Err(Unsupported),
    }
}

pub fn get_or_null<'a>(value: &'a Value, key: &str) -> Shape<&'a Value> {
    Ok(get(value, key)?.unwrap_or(&Value::Null))
}

pub fn dict(value: &Value) -> Shape<&Map> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(Unsupported),
    }
}

pub fn iterate_or_empty(value: &Value) -> Shape<Vec<Value>> {
    if !truthy(value) {
        return Ok(Vec::new());
    }
    match value {
        Value::Array(items) => Ok(items.clone()),
        Value::Str(text) => Ok(pystr::points(text).map(|code| Value::Str(pystr::from_code(code))).collect()),
        Value::Object(map) => Ok(map.iter().map(|(key, _)| Value::Str(key.clone())).collect()),
        _ => Err(Unsupported),
    }
}

pub fn length(value: &Value) -> Shape<usize> {
    match value {
        Value::Array(items) => Ok(items.len()),
        Value::Str(text) => Ok(pystr::len(text)),
        Value::Object(map) => Ok(map.len()),
        _ => Err(Unsupported),
    }
}

pub fn is_int(value: &Value) -> bool {
    matches!(value, Value::Int(_) | Value::BigInt(_) | Value::Bool(_))
}

pub fn is_number(value: &Value) -> bool {
    matches!(value, Value::Int(_) | Value::BigInt(_) | Value::Float(_))
}

const EXACT: f64 = 9_007_199_254_740_992.0;

pub fn number(value: &Value) -> Shape<f64> {
    match value {
        Value::Bool(flag) => Ok(f64::from(u8::from(*flag))),
        Value::Int(number) if (*number as f64).abs() <= EXACT => Ok(*number as f64),
        Value::Float(number) if number.is_finite() => Ok(*number),
        _ => Err(Unsupported),
    }
}

pub fn equals_int(value: &Value, wanted: u64) -> bool {
    match value {
        Value::Bool(flag) => u64::from(*flag) == wanted,
        Value::Int(number) => *number == i128::from(wanted),
        Value::Float(number) => number.fract() == 0.0 && *number >= 0.0 && *number == wanted as f64 && (wanted as f64) as u64 == wanted,
        _ => false,
    }
}

pub fn repr_str(text: &str) -> Shape<String> {
    if !text.chars().all(|c| (' '..='~').contains(&c) || matches!(c, '\t' | '\n' | '\r')) {
        return Err(Unsupported);
    }
    let quote = if text.contains('\'') && !text.contains('"') { '"' } else { '\'' };
    let mut out = String::from(quote);
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    Ok(out)
}

pub fn repr(value: &Value) -> Shape<String> {
    match value {
        Value::Str(text) => repr_str(text),
        Value::Array(items) => Ok(format!("[{}]", items.iter().map(repr).collect::<Shape<Vec<_>>>()?.join(", "))),
        Value::Object(map) => {
            let mut parts = Vec::new();
            for (key, child) in map.iter() {
                parts.push(format!("{}: {}", repr_str(key)?, repr(child)?));
            }
            Ok(format!("{{{}}}", parts.join(", ")))
        }
        other => str_of(other),
    }
}

pub fn str_of(value: &Value) -> Shape<String> {
    match value {
        Value::Null => Ok("None".to_string()),
        Value::Bool(true) => Ok("True".to_string()),
        Value::Bool(false) => Ok("False".to_string()),
        Value::Int(number) => Ok(number.to_string()),
        Value::BigInt(text) => Ok(text.clone()),
        Value::Float(number) => Ok(float_repr(*number)),
        Value::Str(text) => Ok(text.clone()),
        Value::Array(_) | Value::Object(_) => repr(value),
    }
}

pub fn is_space(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

pub fn rstrip(text: &str) -> &str {
    text.trim_end_matches(is_space)
}

pub fn right(text: &str, width: usize) -> String {
    let count = pystr::len(text);
    format!("{}{}", " ".repeat(width.saturating_sub(count)), text)
}

pub fn left(text: &str, width: usize) -> String {
    let count = pystr::len(text);
    format!("{}{}", text, " ".repeat(width.saturating_sub(count)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    #[test]
    fn str_matches_python() {
        let value = parse(br#"[null, true, 1.0, 10, "a'b", {"k": [1, "x\"y"]}, 1e16]"#).unwrap();
        assert_eq!(str_of(&value).unwrap(), r#"[None, True, 1.0, 10, "a'b", {'k': [1, 'x"y']}, 1e+16]"#);
        assert_eq!(repr_str("a'b\"c").unwrap(), r#"'a\'b"c'"#);
        assert_eq!(repr_str("é"), Err(Unsupported));
        assert_eq!(rstrip("p\u{1c} \u{85}\u{3000}"), "p");
    }

    #[test]
    fn truthiness_and_iteration_follow_python() {
        let value = parse(br#"[0, 0.0, "", [], {}, null, false]"#).unwrap();
        if let Value::Array(items) = &value {
            assert!(items.iter().all(|item| !truthy(item)));
        }
        assert_eq!(iterate_or_empty(&Value::str("ab")).unwrap(), vec![Value::str("a"), Value::str("b")]);
        assert_eq!(iterate_or_empty(&Value::Int(3)), Err(Unsupported));
        assert!(iterate_or_empty(&Value::Int(0)).unwrap().is_empty());
        assert!(equals_int(&Value::Float(5.0), 5));
        assert!(equals_int(&Value::Bool(true), 1));
        assert!(!equals_int(&Value::Float(5.5), 5));
    }
}
