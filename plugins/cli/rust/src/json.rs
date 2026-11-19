use std::fmt::Write;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i128),
    BigInt(String),
    Float(f64),
    Str(String),
    Array(Vec<Value>),
    Object(Map),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Map {
    entries: Vec<(String, Value)>,
}

impl Map {
    pub fn new() -> Map {
        Map { entries: Vec::new() }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn contains(&self, key: &str) -> bool {
        self.entries.iter().any(|(k, _)| k == key)
    }

    pub fn insert(&mut self, key: &str, value: Value) {
        match self.entries.iter_mut().find(|(k, _)| k == key) {
            Some(entry) => entry.1 = value,
            None => self.entries.push((key.to_string(), value)),
        }
    }

    pub fn remove(&mut self, key: &str) {
        self.entries.retain(|(k, _)| k != key);
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.entries.iter().map(|(k, v)| (k, v))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl Value {
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(map) => map.get(key),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(text) => Some(text),
            _ => None,
        }
    }

    pub fn object(entries: Vec<(&str, Value)>) -> Value {
        let mut map = Map::new();
        for (key, value) in entries {
            map.insert(key, value);
        }
        Value::Object(map)
    }

    pub fn str(text: &str) -> Value {
        Value::Str(text.to_string())
    }
}

#[derive(Debug, PartialEq)]
pub struct TooDeep;

pub const TELEMETRY_DEPTH: usize = 9995;
pub const CONTROL_DEPTH: usize = 9991;

pub fn parse(bytes: &[u8]) -> Option<Value> {
    parse_limited(bytes, usize::MAX).ok().flatten()
}

pub fn parse_limited(bytes: &[u8], depth_limit: usize) -> Result<Option<Value>, TooDeep> {
    let Some(text) = decode(bytes) else { return Ok(None) };
    let mut parser = Parser {
        chars: &text,
        at: 0,
        depth: 0,
        depth_limit,
        too_deep: false,
    };
    parser.space();
    let value = parser.value();
    if parser.too_deep {
        return Err(TooDeep);
    }
    let Some(value) = value else { return Ok(None) };
    parser.space();
    Ok((parser.at == parser.chars.len()).then_some(value))
}

fn push_code(out: &mut Vec<u8>, code: u32) {
    match code {
        0..=0x7f => out.push(code as u8),
        0x80..=0x7ff => out.extend([0xc0 | (code >> 6) as u8, 0x80 | (code & 0x3f) as u8]),
        0x800..=0xffff => out.extend([0xe0 | (code >> 12) as u8, 0x80 | ((code >> 6) & 0x3f) as u8, 0x80 | (code & 0x3f) as u8]),
        _ => out.extend([
            0xf0 | (code >> 18) as u8,
            0x80 | ((code >> 12) & 0x3f) as u8,
            0x80 | ((code >> 6) & 0x3f) as u8,
            0x80 | (code & 0x3f) as u8,
        ]),
    }
}

fn next_code(bytes: &[u8], at: usize) -> Option<(u32, usize)> {
    let lead = *bytes.get(at)?;
    let tail = |index: usize| bytes.get(at + index).filter(|byte| *byte & 0xc0 == 0x80).map(|byte| u32::from(byte & 0x3f));
    match lead {
        0..=0x7f => Some((u32::from(lead), 1)),
        0xc2..=0xdf => Some(((u32::from(lead & 0x1f) << 6) | tail(1)?, 2)),
        0xe0..=0xef => {
            let code = (u32::from(lead & 0x0f) << 12) | (tail(1)? << 6) | tail(2)?;
            (code >= 0x800).then_some((code, 3))
        }
        0xf0..=0xf4 => {
            let code = (u32::from(lead & 0x07) << 18) | (tail(1)? << 12) | (tail(2)? << 6) | tail(3)?;
            (0x10000..=0x10ffff).contains(&code).then_some((code, 4))
        }
        _ => None,
    }
}

fn utf8_surrogate_pass(bytes: &[u8]) -> Option<Vec<u8>> {
    if std::str::from_utf8(bytes).is_ok() {
        return Some(bytes.to_vec());
    }
    let mut at = 0;
    while at < bytes.len() {
        at += next_code(bytes, at)?.1;
    }
    Some(bytes.to_vec())
}

fn from_units(units: impl Iterator<Item = u32>) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut pending: Option<u32> = None;
    for unit in units {
        if let Some(high) = pending.take() {
            if (0xdc00..0xe000).contains(&unit) {
                push_code(&mut out, 0x10000 + ((high - 0xd800) << 10) + (unit - 0xdc00));
                continue;
            }
            push_code(&mut out, high);
        }
        if (0xd800..0xdc00).contains(&unit) {
            pending = Some(unit);
        } else {
            push_code(&mut out, unit);
        }
    }
    if let Some(high) = pending {
        push_code(&mut out, high);
    }
    Some(out)
}

fn utf16(bytes: &[u8], big_endian: bool) -> Option<Vec<u8>> {
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    from_units(bytes.chunks(2).map(|pair| {
        let pair = [pair[0], pair[1]];
        u32::from(if big_endian { u16::from_be_bytes(pair) } else { u16::from_le_bytes(pair) })
    }))
}

fn utf32(bytes: &[u8], big_endian: bool) -> Option<Vec<u8>> {
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::new();
    for chunk in bytes.chunks(4) {
        let quad = [chunk[0], chunk[1], chunk[2], chunk[3]];
        let code = if big_endian { u32::from_be_bytes(quad) } else { u32::from_le_bytes(quad) };
        if code > 0x10ffff {
            return None;
        }
        push_code(&mut out, code);
    }
    Some(out)
}

fn decode(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.starts_with(&[0, 0, 0xfe, 0xff]) || bytes.starts_with(&[0xff, 0xfe, 0, 0]) {
        return utf32(&bytes[4..], bytes[0] == 0);
    }
    if bytes.starts_with(&[0xfe, 0xff]) || bytes.starts_with(&[0xff, 0xfe]) {
        return utf16(&bytes[2..], bytes[0] == 0xfe);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return utf8_surrogate_pass(rest);
    }
    if bytes.len() >= 4 {
        if bytes[0] == 0 {
            return if bytes[1] != 0 { utf16(bytes, true) } else { utf32(bytes, true) };
        }
        if bytes[1] == 0 {
            return if bytes[2] != 0 || bytes[3] != 0 {
                utf16(bytes, false)
            } else {
                utf32(bytes, false)
            };
        }
    } else if bytes.len() == 2 {
        if bytes[0] == 0 {
            return utf16(bytes, true);
        }
        if bytes[1] == 0 {
            return utf16(bytes, false);
        }
    }
    utf8_surrogate_pass(bytes)
}

struct Parser<'a> {
    chars: &'a [u8],
    at: usize,
    depth: usize,
    depth_limit: usize,
    too_deep: bool,
}

struct Text {
    shown: String,
    lone: Option<Vec<u32>>,
}

impl Text {
    fn push(&mut self, ch: char) {
        self.shown.push(ch);
        if let Some(lone) = &mut self.lone {
            lone.push(ch as u32);
        }
    }

    fn push_code(&mut self, code: u32) {
        match char::from_u32(code) {
            Some(ch) => self.push(ch),
            None => {
                let lone = self.lone.get_or_insert_with(|| self.shown.chars().map(|ch| ch as u32).collect());
                lone.push(code);
                self.shown.push('\u{fffd}');
            }
        }
    }

    fn push_raw(&mut self, raw: &[u8]) -> Option<()> {
        if self.lone.is_none() {
            if let Ok(text) = std::str::from_utf8(raw) {
                self.shown.push_str(text);
                return Some(());
            }
        }
        let mut at = 0;
        while at < raw.len() {
            let (code, size) = next_code(raw, at)?;
            self.push_code(code);
            at += size;
        }
        Some(())
    }
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.chars.get(self.at).copied()
    }

    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn word(&mut self, word: &str) -> bool {
        if self.chars[self.at..].starts_with(word.as_bytes()) {
            self.at += word.len();
            true
        } else {
            false
        }
    }

    fn nested(&mut self, open: u8) -> Option<Value> {
        self.depth += 1;
        if self.depth > self.depth_limit {
            self.too_deep = true;
            return None;
        }
        let value = if open == b'{' { self.object() } else { self.array() };
        self.depth -= 1;
        value
    }

    fn value(&mut self) -> Option<Value> {
        match self.peek()? {
            open @ (b'{' | b'[') => self.nested(open),
            b'"' => self.string().map(|text| Value::Str(text.shown)),
            b'n' if self.word("null") => Some(Value::Null),
            b't' if self.word("true") => Some(Value::Bool(true)),
            b'f' if self.word("false") => Some(Value::Bool(false)),
            b'N' if self.word("NaN") => Some(Value::Float(f64::NAN)),
            b'I' if self.word("Infinity") => Some(Value::Float(f64::INFINITY)),
            b'-' if self.chars[self.at..].starts_with(b"-Infinity") => {
                self.at += 9;
                Some(Value::Float(f64::NEG_INFINITY))
            }
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        }
    }

    fn object(&mut self) -> Option<Value> {
        self.at += 1;
        let mut map = Map::new();
        let mut lone_keys: Vec<Option<Vec<u32>>> = Vec::new();
        self.space();
        if self.peek() == Some(b'}') {
            self.at += 1;
            return Some(Value::Object(map));
        }
        loop {
            self.space();
            if self.peek() != Some(b'"') {
                return None;
            }
            let key = self.string()?;
            self.space();
            if self.peek() != Some(b':') {
                return None;
            }
            self.at += 1;
            self.space();
            let value = self.value()?;
            let seen = map
                .entries
                .iter()
                .zip(&lone_keys)
                .position(|((shown, _), lone)| *lone == key.lone && (lone.is_some() || *shown == key.shown));
            match seen {
                Some(index) => map.entries[index].1 = value,
                None => {
                    map.entries.push((key.shown, value));
                    lone_keys.push(key.lone);
                }
            }
            self.space();
            match self.peek()? {
                b',' => self.at += 1,
                b'}' => {
                    self.at += 1;
                    return Some(Value::Object(map));
                }
                _ => return None,
            }
        }
    }

    fn array(&mut self) -> Option<Value> {
        self.at += 1;
        let mut items = Vec::new();
        self.space();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Some(Value::Array(items));
        }
        loop {
            self.space();
            items.push(self.value()?);
            self.space();
            match self.peek()? {
                b',' => self.at += 1,
                b']' => {
                    self.at += 1;
                    return Some(Value::Array(items));
                }
                _ => return None,
            }
        }
    }

    fn hex4(&mut self) -> Option<u32> {
        let digits = self.chars.get(self.at..self.at + 4)?;
        let text = std::str::from_utf8(digits).ok()?;
        if !text.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        self.at += 4;
        u32::from_str_radix(text, 16).ok()
    }

    fn string(&mut self) -> Option<Text> {
        self.at += 1;
        let mut out = Text {
            shown: String::new(),
            lone: None,
        };
        loop {
            let start = self.at;
            while let Some(byte) = self.peek() {
                if byte == b'"' || byte == b'\\' || byte < 0x20 {
                    break;
                }
                self.at += 1;
            }
            out.push_raw(&self.chars[start..self.at])?;
            match self.peek()? {
                b'"' => {
                    self.at += 1;
                    return Some(out);
                }
                b'\\' => {
                    self.at += 1;
                    let escape = self.peek()?;
                    self.at += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let unit = self.hex4()?;
                            if (0xd800..0xdc00).contains(&unit) && self.chars[self.at..].starts_with(b"\\u") {
                                let saved = self.at;
                                self.at += 2;
                                match self.hex4() {
                                    Some(low) if (0xdc00..0xe000).contains(&low) => {
                                        let code = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
                                        out.push_code(code);
                                        continue;
                                    }
                                    _ => self.at = saved,
                                }
                            }
                            out.push_code(unit);
                        }
                        _ => return None,
                    }
                }
                _ => return None,
            }
        }
    }

    fn number(&mut self) -> Option<Value> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        match self.peek()? {
            b'0' => self.at += 1,
            b'1'..=b'9' => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.at += 1;
                }
            }
            _ => return None,
        }
        let mut float = false;
        if self.peek() == Some(b'.') && matches!(self.chars.get(self.at + 1), Some(b'0'..=b'9')) {
            float = true;
            self.at += 1;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.at += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            let mut probe = self.at + 1;
            if matches!(self.chars.get(probe), Some(b'+' | b'-')) {
                probe += 1;
            }
            if matches!(self.chars.get(probe), Some(b'0'..=b'9')) {
                float = true;
                self.at = probe;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.at += 1;
                }
            }
        }
        let text = std::str::from_utf8(&self.chars[start..self.at]).ok()?;
        if float {
            return text.parse::<f64>().ok().map(Value::Float);
        }
        match text.parse::<i128>() {
            Ok(number) => Some(Value::Int(number)),
            Err(_) if text.trim_start_matches('-').len() > 4300 => None,
            Err(_) => Some(Value::BigInt(text.to_string())),
        }
    }
}

pub fn float_repr(value: f64) -> String {
    if value.is_nan() {
        return "nan".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "inf" } else { "-inf" }.to_string();
    }
    let magnitude = value.abs();
    let scientific = (0..17)
        .map(|precision| format!("{magnitude:.precision$e}"))
        .find(|text| text.parse::<f64>() == Ok(magnitude))
        .unwrap_or_else(|| format!("{magnitude:e}"));
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let point = exponent + 1;
    let sign = if value.is_sign_negative() { "-" } else { "" };
    if !(-4 < point && point <= 16) {
        let rest = &digits[1..];
        let mantissa = if rest.is_empty() {
            digits[..1].to_string()
        } else {
            format!("{}.{}", &digits[..1], rest)
        };
        let exponent_sign = if exponent < 0 { '-' } else { '+' };
        return format!("{sign}{mantissa}e{exponent_sign}{:02}", exponent.abs());
    }
    if point <= 0 {
        return format!("{sign}0.{}{}", "0".repeat((-point) as usize), digits);
    }
    let point = point as usize;
    if point >= digits.len() {
        return format!("{sign}{}{}.0", digits, "0".repeat(point - digits.len()));
    }
    format!("{sign}{}.{}", &digits[..point], &digits[point..])
}

fn json_float(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_string()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string()
    } else {
        float_repr(value)
    }
}

pub fn quote(text: &str, ensure_ascii: bool, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c if ensure_ascii && (c as u32) > 0x7e => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    let _ = write!(out, "\\u{:04x}", unit);
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[derive(Clone, Copy)]
pub enum Style {
    Compact,
    Spaced,
    Indented,
}

pub fn dumps(value: &Value, style: Style, ensure_ascii: bool) -> String {
    let mut out = String::new();
    write_value(value, style, ensure_ascii, 0, &mut out);
    out
}

fn write_value(value: &Value, style: Style, ensure_ascii: bool, depth: usize, out: &mut String) {
    let (item, pair) = match style {
        Style::Compact => (",", ":"),
        Style::Spaced => (", ", ": "),
        Style::Indented => (",", ": "),
    };
    let newline = |out: &mut String, depth: usize| {
        if let Style::Indented = style {
            out.push('\n');
            out.push_str(&"  ".repeat(depth));
        }
    };
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Int(number) => {
            let _ = write!(out, "{number}");
        }
        Value::BigInt(text) => out.push_str(text),
        Value::Float(number) => out.push_str(&json_float(*number)),
        Value::Str(text) => quote(text, ensure_ascii, out),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (index, child) in items.iter().enumerate() {
                if index > 0 {
                    out.push_str(item);
                }
                newline(out, depth + 1);
                write_value(child, style, ensure_ascii, depth + 1, out);
            }
            newline(out, depth);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (index, (key, child)) in map.iter().enumerate() {
                if index > 0 {
                    out.push_str(item);
                }
                newline(out, depth + 1);
                quote(key, ensure_ascii, out);
                out.push_str(pair);
                write_value(child, style, ensure_ascii, depth + 1, out);
            }
            newline(out, depth);
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn integers_stop_at_python_s_4300_digits_not_counting_the_sign() {
        for (sign, digits, reads) in [("", 4300, true), ("", 4301, false), ("-", 4300, true), ("-", 4301, false)] {
            let text = format!("{sign}1{}", "0".repeat(digits - 1));
            assert_eq!(parse(text.as_bytes()).is_some(), reads, "{sign}{digits} digits");
        }
    }

    use super::*;

    #[test]
    fn floats_print_as_python_repr() {
        let cases = [
            (0.25, "0.25"),
            (1e16, "1e+16"),
            (1e15, "1000000000000000.0"),
            (1e-5, "1e-05"),
            (0.0001, "0.0001"),
            (123456789012345678.0, "1.2345678901234568e+17"),
            (-0.0, "-0.0"),
            (5.0, "5.0"),
            (1763412345.123456, "1763412345.123456"),
            (1.5e-7, "1.5e-07"),
            (2.5e300, "2.5e+300"),
            (807960295084425.2, "807960295084425.2"),
            (0.1 + 0.2, "0.30000000000000004"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
        ];
        for (value, shown) in cases {
            assert_eq!(float_repr(value), shown);
        }
    }

    #[test]
    fn parses_and_dumps_like_python() {
        let value = parse(br#" {"a": [1, 2.0, -0, 1E2, "\ud83d\ude00", "\ud800x", null, true], "b": {}, "a": "last"} "#).unwrap();
        assert_eq!(dumps(&value, Style::Compact, false), r#"{"a":"last","b":{}}"#);
        let value = parse(br#"[1, 2.0, -0, 1E2, "\ud83d\ude00", "\ud800x", "\u007f\u0001", 123456789012345678901234567890123456789012]"#).unwrap();
        assert_eq!(
            dumps(&value, Style::Spaced, false),
            "[1, 2.0, 0, 100.0, \"😀\", \"\u{fffd}x\", \"\u{7f}\\u0001\", 123456789012345678901234567890123456789012]"
        );
        assert_eq!(dumps(&value, Style::Indented, false).lines().count(), 10);
        assert_eq!(dumps(&Value::str("é😀"), Style::Compact, true), "\"\\u00e9\\ud83d\\ude00\"");
    }

    #[test]
    fn reads_bytes_like_json_loads() {
        let doc = r#"{"a": "\u00e9"}"#;
        let expected = parse(doc.as_bytes()).unwrap();
        let utf16le: Vec<u8> = doc.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let utf16be: Vec<u8> = doc.encode_utf16().flat_map(u16::to_be_bytes).collect();
        let utf32le: Vec<u8> = doc.chars().flat_map(|ch| (ch as u32).to_le_bytes()).collect();
        for bytes in [
            [&[0xff, 0xfe][..], &utf16le].concat(),
            utf16le.clone(),
            utf16be,
            [&[0xff, 0xfe, 0, 0][..], &utf32le].concat(),
            utf32le,
            [&[0xef, 0xbb, 0xbf][..], doc.as_bytes()].concat(),
        ] {
            assert_eq!(parse(&bytes).as_ref(), Some(&expected), "{bytes:?}");
        }
        assert!(parse(&[&[0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf][..], doc.as_bytes()].concat()).is_none());
        assert!(parse(&[&[0xff, 0xfe][..], &utf16le, &[0]].concat()).is_none());
        assert_eq!(parse(b"\"a\xed\xa0\x80\""), Some(Value::str("a\u{fffd}")));
        assert!(parse(b"\"a\xc0\x80\"").is_none());
    }

    #[test]
    fn keeps_lone_surrogate_keys_apart() {
        let value = parse(br#"{"\ud800": 1, "\ud801": 2, "\ud800": 3, "\ufffd": 4}"#).unwrap();
        assert_eq!(dumps(&value, Style::Compact, false), "{\"\u{fffd}\":3,\"\u{fffd}\":2,\"\u{fffd}\":4}");
    }

    #[test]
    fn stops_past_the_depth_limit() {
        let nested = |depth: usize| format!("{}{}", "[".repeat(depth), "]".repeat(depth));
        assert!(matches!(parse_limited(nested(5).as_bytes(), 5), Ok(Some(_))));
        assert_eq!(parse_limited(nested(6).as_bytes(), 5), Err(TooDeep));
        assert_eq!(parse_limited(format!("[1,]{}", nested(9)).as_bytes(), 5), Ok(None));
    }

    #[test]
    fn refuses_what_python_refuses() {
        for text in ["", "01", "[1,]", "{\"a\":1,}", "\"a\u{1}\"", "nul", "1 2", "[", "\"\\x\"", "1.", ".5"] {
            assert!(parse(text.as_bytes()).is_none(), "{text}");
        }
        assert!(matches!(parse(b"NaN"), Some(Value::Float(n)) if n.is_nan()));
        assert_eq!(parse(b"-Infinity"), Some(Value::Float(f64::NEG_INFINITY)));
    }
}
