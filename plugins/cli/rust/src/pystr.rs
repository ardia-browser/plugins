use std::borrow::Cow;

const MARK: char = '\u{ffff}';
const SURROGATE_BASE: u32 = 0xf0000;

pub fn is_surrogate(code: u32) -> bool {
    (0xd800..0xe000).contains(&code)
}

fn is_high(code: u32) -> bool {
    (0xd800..0xdc00).contains(&code)
}

fn is_low(code: u32) -> bool {
    (0xdc00..0xe000).contains(&code)
}

pub fn push_code(out: &mut String, code: u32) {
    if is_surrogate(code) {
        out.push(MARK);
        out.push(char::from_u32(SURROGATE_BASE + code - 0xd800).unwrap_or(MARK));
    } else if code == 0xffff {
        out.push(MARK);
        out.push(MARK);
    } else if let Some(ch) = char::from_u32(code) {
        out.push(ch);
    }
}

pub fn push_text(out: &mut String, text: &str) {
    if text.contains(MARK) {
        text.chars().for_each(|ch| push_code(out, ch as u32));
    } else {
        out.push_str(text);
    }
}

pub fn from_code(code: u32) -> String {
    let mut out = String::new();
    push_code(&mut out, code);
    out
}

pub struct Points<'a> {
    chars: std::str::Chars<'a>,
}

impl Iterator for Points<'_> {
    type Item = u32;

    fn next(&mut self) -> Option<u32> {
        let ch = self.chars.next()?;
        if ch != MARK {
            return Some(ch as u32);
        }
        match self.chars.next() {
            Some(MARK) | None => Some(0xffff),
            Some(coded) => Some(coded as u32 - SURROGATE_BASE + 0xd800),
        }
    }
}

pub fn points(text: &str) -> Points<'_> {
    Points { chars: text.chars() }
}

pub fn len(text: &str) -> usize {
    if text.contains(MARK) {
        points(text).count()
    } else {
        text.chars().count()
    }
}

pub fn well_formed(text: &str) -> Cow<'_, str> {
    if !text.contains(MARK) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut codes = points(text).peekable();
    while let Some(code) = codes.next() {
        let joined = match codes.peek() {
            Some(&low) if is_high(code) && is_low(low) => {
                codes.next();
                char::from_u32(0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00))
            }
            _ => char::from_u32(code),
        };
        out.push(joined.unwrap_or('\u{fffd}'));
    }
    Cow::Owned(out)
}

const PY_DECIMALS: &str = include_str!("../../py-decimals.txt");

fn decimal_ranges() -> &'static [(u32, u32)] {
    static RANGES: std::sync::OnceLock<Vec<(u32, u32)>> = std::sync::OnceLock::new();
    RANGES.get_or_init(|| {
        PY_DECIMALS
            .lines()
            .filter_map(|line| {
                let (start, end) = line.split_once(' ')?;
                Some((u32::from_str_radix(start, 16).ok()?, u32::from_str_radix(end, 16).ok()?))
            })
            .collect()
    })
}

pub fn is_decimal(ch: char) -> bool {
    let code = ch as u32;
    decimal_ranges().iter().any(|(start, end)| (*start..=*end).contains(&code))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn of(codes: &[u32]) -> String {
        let mut out = String::new();
        for code in codes {
            push_code(&mut out, *code);
        }
        out
    }

    #[test]
    fn keeps_python_code_points_apart_until_written() {
        let split = of(&[0xd800, 0xdc00]);
        assert_ne!(split, "\u{10000}");
        assert_ne!(of(&[0xd800, 0xffff]), of(&[0xd800, 0xf0000 + 0x400]));
        assert_eq!(len(&split), 2);
        assert_eq!(len(&of(&[0x61, 0xffff, 0xdfff])), 3);
        assert_eq!(points(&of(&[0xffff, 0xdbff, 0xf0000])).collect::<Vec<_>>(), [0xffff, 0xdbff, 0xf0000]);
        assert_eq!(well_formed(&split), "\u{10000}");
        assert_eq!(well_formed(&of(&[0xdc00, 0xd800, 0x61, 0xffff])), "\u{fffd}\u{fffd}a\u{ffff}");
        let mut pushed = String::from("a");
        push_text(&mut pushed, "b\u{ffff}c");
        assert_eq!(pushed, of(&[0x61, 0x62, 0xffff, 0x63]));
    }

    #[test]
    fn decimals_are_what_python_re_calls_digits() {
        for ch in ['0', '9', '\u{661}', '\u{966}', '\u{ff10}', '\u{1d7ce}', '\u{1fbf9}'] {
            assert!(is_decimal(ch), "{ch:?}");
        }
        for ch in ['a', '/', ':', '\u{b2}', '\u{2460}', '\u{bc}', '\u{2167}', '\u{1d7cc}'] {
            assert!(!is_decimal(ch), "{ch:?}");
        }
        assert_eq!(decimal_ranges().len(), 64);
    }
}
