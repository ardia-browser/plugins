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

pub fn next_code(bytes: &[u8], at: usize) -> Option<(u32, usize)> {
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

pub fn decode(bytes: &[u8]) -> Option<Vec<u8>> {
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

#[cfg(test)]
mod tests {
    use crate::json::{dumps, parse, Style, Value};
    use crate::{py, pystr};

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
        assert_eq!(parse(b"\"a\xed\xa0\x80\""), Some(Value::Str(format!("a{}", pystr::from_code(0xd800)))));
        let split =
            parse(b"[\"\\ud800\xed\xb0\x80\", \"\xed\xa0\x80\xed\xb0\x80\", \"\xed\xa0\x80\\udc00\", \"\\ud800\\udc00\", \"\\ud800\xef\xbf\xbf\"]").unwrap();
        let Value::Array(items) = &split else { panic!() };
        assert_eq!(items[0], items[1]);
        assert_eq!(items[0], items[2]);
        assert_ne!(items[0], items[3]);
        assert_eq!(items.iter().map(|item| py::length(item).unwrap()).collect::<Vec<_>>(), [2, 2, 2, 1, 2]);
        assert_eq!(
            pystr::well_formed(&dumps(&split, Style::Compact, false)),
            "[\"\u{10000}\",\"\u{10000}\",\"\u{10000}\",\"\u{10000}\",\"\u{fffd}\u{ffff}\"]"
        );
        assert!(parse(b"\"a\xc0\x80\"").is_none());
    }
}
