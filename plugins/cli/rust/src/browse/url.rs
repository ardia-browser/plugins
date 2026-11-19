pub struct Split {
    pub scheme: String,
    pub netloc: String,
    pub path: String,
    pub query: String,
}

pub fn plain(url: &str) -> bool {
    url.bytes().all(|byte| (0x21..=0x7e).contains(&byte) && byte != b'[' && byte != b']')
}

pub fn split(url: &str) -> Option<Split> {
    if !plain(url) {
        return None;
    }
    let mut scheme = String::new();
    let mut rest = url;
    if let Some(colon) = url.find(':') {
        let head = &url[..colon];
        let starts_alpha = head.bytes().next().is_some_and(|byte| byte.is_ascii_alphabetic());
        if colon > 0 && starts_alpha && head.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.')) {
            scheme = head.to_ascii_lowercase();
            rest = &url[colon + 1..];
        }
    }
    let mut netloc = String::new();
    if let Some(after) = rest.strip_prefix("//") {
        let end = after.find(['/', '?', '#']).unwrap_or(after.len());
        netloc = after[..end].to_string();
        rest = &after[end..];
    }
    let rest = rest.split_once('#').map_or(rest, |(before, _)| before);
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    Some(Split {
        scheme,
        netloc,
        path: path.to_string(),
        query: query.to_string(),
    })
}

fn hex_value(byte: u8) -> Option<u8> {
    (byte as char).to_digit(16).map(|digit| digit as u8)
}

pub fn unquote(text: &str) -> String {
    if !text.contains('%') {
        return text.to_string();
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if let (Some(high), Some(low)) = (
                bytes.get(index + 1).and_then(|b| hex_value(*b)),
                bytes.get(index + 2).and_then(|b| hex_value(*b)),
            ) {
                out.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn query_values(query: &str) -> Vec<String> {
    let mut values = Vec::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let Some((_, value)) = pair.split_once('=') else { continue };
        if !value.is_empty() {
            values.push(unquote(&value.replace('+', " ")));
        }
    }
    values
}

pub fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn general(value: f64) -> String {
    if value == 0.0 {
        return if value.is_sign_negative() { "-0" } else { "0" }.to_string();
    }
    if !value.is_finite() {
        return if value.is_nan() {
            "nan".to_string()
        } else if value > 0.0 {
            "inf".to_string()
        } else {
            "-inf".to_string()
        };
    }
    let scientific = format!("{value:.5e}");
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    if !(-4..6).contains(&exponent) {
        let mantissa = trim_zeros(mantissa);
        let sign = if exponent < 0 { '-' } else { '+' };
        return format!("{mantissa}e{sign}{:02}", exponent.abs());
    }
    let decimals = (5 - exponent).max(0) as usize;
    trim_zeros(&format!("{value:.decimals$}")).to_string()
}

fn trim_zeros(text: &str) -> &str {
    if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.')
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_like_urlsplit() {
        let found = split("WS://H:9/p?a=1&b=&c&d=x+y%2F%zz%e2%82&a=2#f").unwrap();
        assert_eq!((found.scheme.as_str(), found.netloc.as_str(), found.path.as_str()), ("ws", "H:9", "/p"));
        assert_eq!(query_values(&found.query), ["1", "x y/%zz\u{fffd}", "2"]);
        let found = split("ws:h/p").unwrap();
        assert_eq!((found.scheme.as_str(), found.netloc.as_str(), found.path.as_str()), ("ws", "", "h/p"));
        let found = split("1ws://x").unwrap();
        assert_eq!((found.scheme.as_str(), found.path.as_str()), ("", "1ws://x"));
        let found = split("ws://h#a?b").unwrap();
        assert_eq!((found.netloc.as_str(), found.query.as_str()), ("h", ""));
        assert!(split("ws://[::1]:9/").is_none());
        assert!(split("ws://h/ p").is_none());
    }

    #[test]
    fn quotes_like_urllib() {
        assert_eq!(quote("a b/~.-_é"), "a%20b%2F~.-_%C3%A9");
        assert_eq!(unquote("%e2%82x%C3%A9%4"), "\u{fffd}x\u{e9}%4");
        assert_eq!(unquote("%ff%fe"), "\u{fffd}\u{fffd}");
    }

    #[test]
    fn formats_like_python_g() {
        let cases = [
            (450.0, "450"),
            (31.234567, "31.2346"),
            (1234567.0, "1.23457e+06"),
            (0.0001, "0.0001"),
            (1e-5, "1e-05"),
            (100000.0, "100000"),
            (1e16, "1e+16"),
            (999999.5, "1e+06"),
            (0.5, "0.5"),
        ];
        for (value, shown) in cases {
            assert_eq!(general(value), shown, "{value}");
        }
    }
}
