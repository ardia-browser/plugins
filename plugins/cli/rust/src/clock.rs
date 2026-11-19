use std::time::{SystemTime, UNIX_EPOCH};

pub fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs_f64()).unwrap_or(0.0)
}

pub fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let month = i64::from(month);
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn utc_day(seconds: f64) -> String {
    let (year, month, day) = civil((seconds.floor() as i64).div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}")
}

pub fn iso(seconds: f64) -> String {
    let whole = seconds.floor() as i64;
    let (year, month, day) = civil(whole.div_euclid(86_400));
    let rest = whole.rem_euclid(86_400);
    let millis = ((seconds * 1000.0) as i64).rem_euclid(1000);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

fn digits(text: &str, count: usize) -> Option<i64> {
    if text.len() == count && text.bytes().all(|b| b.is_ascii_digit()) {
        text.parse().ok()
    } else {
        None
    }
}

fn local_offset(seconds: i64) -> i64 {
    let mut parts: libc::tm = unsafe { std::mem::zeroed() };
    let time: libc::time_t = seconds as libc::time_t;
    unsafe { libc::localtime_r(&time, &mut parts) };
    parts.tm_gmtoff as i64
}

fn naive_to_utc(t: i64, local: impl Fn(i64) -> i64) -> i64 {
    let a = local(t) - t;
    let u1 = t - a;
    let t1 = local(u1);
    let b = if t1 == t {
        let earlier = u1 - 86_400;
        let b = local(earlier) - earlier;
        if a == b {
            return u1;
        }
        b
    } else {
        t1 - u1
    };
    let u2 = t - b;
    if local(u2) == t {
        return u2;
    }
    if t1 == t {
        return u1;
    }
    u1.max(u2)
}

fn local_seconds(utc: i64) -> i64 {
    utc + local_offset(utc)
}

#[derive(Debug, PartialEq)]
pub enum Iso {
    At(f64),
    Invalid,
    Unported,
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn clock_of(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let separated = bytes.get(2) == Some(&b':');
    let mut at = 0;
    let mut parts = [0i64; 3];
    let mut fraction = 0.0;
    for (index, part) in parts.iter_mut().enumerate() {
        if index > 0 {
            if at >= bytes.len() || matches!(bytes[at], b'.' | b',') {
                break;
            }
            if separated {
                if bytes[at] != b':' {
                    return None;
                }
                at += 1;
            }
        }
        *part = digits(text.get(at..at + 2)?, 2)?;
        at += 2;
    }
    if at < bytes.len() {
        if !matches!(bytes[at], b'.' | b',') {
            return None;
        }
        let rest = &text[at + 1..];
        if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let kept = &rest[..rest.len().min(6)];
        fraction = kept.parse::<f64>().ok()? / 10f64.powi(kept.len() as i32);
    }
    let [hour, minute, second] = parts;
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    Some((hour * 3600 + minute * 60 + second) as f64 + fraction)
}

pub fn parse_iso(text: &str) -> Iso {
    parse_iso_at(&text.replace('Z', "+00:00")).unwrap_or(Iso::Invalid)
}

fn parse_iso_at(text: &str) -> Option<Iso> {
    let bytes = text.as_bytes();
    let extended = bytes.get(4) == Some(&b'-');
    if bytes.get(if extended { 5 } else { 4 }) == Some(&b'W') {
        return Some(Iso::Unported);
    }
    let (year, month, day, rest) = if extended {
        if bytes.get(7) != Some(&b'-') {
            return None;
        }
        (
            digits(text.get(0..4)?, 4)?,
            digits(text.get(5..7)?, 2)? as u32,
            digits(text.get(8..10)?, 2)? as u32,
            text.get(10..)?,
        )
    } else {
        (
            digits(text.get(0..4)?, 4)?,
            digits(text.get(4..6)?, 2)? as u32,
            digits(text.get(6..8)?, 2)? as u32,
            text.get(8..)?,
        )
    };
    if year < 1 || !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let base = days_from_civil(year, month, day) * 86_400;
    let mut chars = rest.chars();
    if chars.next().is_none() {
        return Some(Iso::At(naive_to_utc(base, local_seconds) as f64));
    }
    let time = chars.as_str();
    let zone_at = time.find(['+', '-']);
    let clock = clock_of(&time[..zone_at.unwrap_or(time.len())])?;
    let Some(zone_at) = zone_at else {
        let whole = clock.floor();
        return Some(Iso::At(naive_to_utc(base + whole as i64, local_seconds) as f64 + (clock - whole)));
    };
    let sign = if time[zone_at..].starts_with('-') { -1.0 } else { 1.0 };
    let offset = clock_of(&time[zone_at + 1..])?;
    Some(Iso::At(base as f64 + clock - sign * offset))
}

#[cfg(target_os = "macos")]
pub fn process_started_at() -> Option<f64> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_PID, std::process::id() as libc::c_int];
    let mut buffer = [0u8; 1024];
    let mut size = buffer.len();
    let result = unsafe { libc::sysctl(mib.as_mut_ptr(), 4, buffer.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) };
    if result != 0 || size < 16 {
        return None;
    }
    let seconds = i64::from_le_bytes(buffer[..8].try_into().ok()?);
    let micros = i32::from_le_bytes(buffer[8..12].try_into().ok()?);
    (seconds > 0).then(|| seconds as f64 + f64::from(micros) / 1e6)
}

#[cfg(not(target_os = "macos"))]
pub fn process_started_at() -> Option<f64> {
    let raw = std::fs::read("/proc/self/stat").ok()?;
    let close = raw.iter().rposition(|byte| *byte == b')')?;
    let fields: Vec<&[u8]> = raw[close + 1..]
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|field| !field.is_empty())
        .collect();
    let ticks: f64 = std::str::from_utf8(fields.get(19)?).ok()?.parse().ok()?;
    let mut boot: libc::timespec = unsafe { std::mem::zeroed() };
    if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut boot) } != 0 {
        return None;
    }
    let per_second = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as f64;
    let age = boot.tv_sec as f64 + boot.tv_nsec as f64 / 1e9 - ticks / per_second;
    (age >= 0.0).then(|| now() - age)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_utc() {
        assert_eq!(iso(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_763_412_345.678), "2025-11-17T20:45:45.678Z");
        assert_eq!(utc_day(951_782_400.0), "2000-02-29");
        assert_eq!(days_from_civil(2000, 2, 29), 11_016);
    }

    #[test]
    fn parses_iso_like_python() {
        assert_eq!(parse_iso("2025-11-17T20:45:45Z"), Iso::At(1_763_412_345.0));
        assert_eq!(parse_iso("2025-11-17T20:45:45.5+01:00"), Iso::At(1_763_408_745.5));
        assert_eq!(parse_iso("2025-11-17"), parse_iso("2025-11-17T00:00:00"));
        for (text, at) in [
            ("2020-01-01T00:00:00+0000", 1_577_836_800.0),
            ("2020-01-01T00:00:00+00", 1_577_836_800.0),
            ("20200101T000000Z", 1_577_836_800.0),
            ("2020-01-01x10:00Z", 1_577_872_800.0),
            ("2020-01-01T10:00:00.1234567+01:00", 1_577_869_200.123_456),
            ("2020-01-01T00:00:00-01:30", 1_577_842_200.0),
        ] {
            assert_eq!(parse_iso(text), Iso::At(at), "{text}");
        }
        for text in [
            "yesterday",
            "2020-02-30T00:00:00Z",
            "2020-01-01T00:00:00z",
            "2020-01-01T25:00",
            "2020-01-01T10:0",
        ] {
            assert_eq!(parse_iso(text), Iso::Invalid, "{text}");
        }
        assert_eq!(parse_iso("2020-W01-1"), Iso::Unported);
    }

    #[test]
    fn reads_a_naive_time_across_daylight_saving_changes_like_python() {
        let pacific = |utc: i64| {
            utc + if (1_583_661_600..1_604_221_200).contains(&utc) {
                -7 * 3600
            } else {
                -8 * 3600
            }
        };
        for ((year, month, day, hour, minute, second), utc) in [
            ((2020, 11, 1, 3, 0, 0), 1_604_228_400),
            ((2020, 11, 1, 1, 30, 0), 1_604_219_400),
            ((2020, 11, 1, 0, 30, 0), 1_604_215_800),
            ((2020, 11, 1, 2, 0, 0), 1_604_224_800),
            ((2020, 3, 8, 2, 30, 0), 1_583_663_400),
            ((2020, 3, 8, 3, 0, 0), 1_583_661_600),
            ((2020, 3, 8, 1, 59, 59), 1_583_661_599),
            ((2020, 7, 1, 12, 0, 0), 1_593_630_000),
        ] {
            let naive = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second;
            assert_eq!(naive_to_utc(naive, pacific), utc, "{year}-{month}-{day} {hour}:{minute}:{second}");
        }
    }

    #[test]
    fn takes_a_fraction_after_any_time_part_like_python() {
        for (text, at) in [
            ("2020-01-01T08:05.5Z", 1_577_865_900.5),
            ("2020-01-01T08.5Z", 1_577_865_600.5),
            ("2020-01-01T0805.5Z", 1_577_865_900.5),
            ("2020-01-01T08:05:06,1234567Z", 1_577_865_906.123_456),
            ("2020-01-01T08:05+05.5", 1_577_847_899.5),
            ("2020-01-01T08:05:06+05:30:15.5", 1_577_846_090.5),
        ] {
            assert_eq!(parse_iso(text), Iso::At(at), "{text}");
        }
        for text in [
            "2020-01-01T08:5Z",
            "2020-01-01T08:0506",
            "2020-01-01T0805:06",
            "2020-01-01T08:05:06.",
            "2020-01-01T08:05:06.5x",
            "2020-01-01T",
        ] {
            assert_eq!(parse_iso(text), Iso::Invalid, "{text}");
        }
    }
}
