use crate::clock;
use crate::json::{self, Style, Value};
use crate::paths::{self, Failure};
use std::os::fd::OwnedFd;
use std::path::Path;

const LOCAL_FOLDER: &str = "local";
const LOCAL_PREFIX: &str = "cli-";
const LOCAL_LOCK: &str = "cli-local.lock";
const LOCAL_DAYS: f64 = 7.0;
const MAX_LOCAL_BYTES: usize = 4 * 1024 * 1024;

fn local_line(record: &Value, sent: bool) -> Vec<u8> {
    let mut with_sent = record.clone();
    if let Value::Object(map) = &mut with_sent {
        map.insert("sent", Value::Bool(sent));
    }
    let mut line = crate::pystr::well_formed(&json::dumps(&with_sent, Style::Compact, false))
        .into_owned()
        .into_bytes();
    line.push(b'\n');
    line
}

pub fn keep(root: &Path, records: &[Value], sent: bool) -> bool {
    let data: Vec<u8> = records.iter().flat_map(|record| local_line(record, sent)).collect();
    if data.is_empty() || data.len() > MAX_LOCAL_BYTES {
        return false;
    }
    let attempt = || -> Result<bool, Failure> {
        let telemetry = crate::telemetry::open_folder(root, true)?;
        let local = paths::open_child_dir(&telemetry, LOCAL_FOLDER, true)?;
        drop(telemetry);
        let Some(_lock) = paths::take_lock_retrying(LOCAL_LOCK, &local)? else {
            return Ok(false);
        };
        let now = clock::now();
        let fd = paths::open_private_file(&local_name(now), &local, libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND)?;
        paths::write_once(&fd, &data)?;
        drop(fd);
        prune_local(&local, now)?;
        Ok(true)
    };
    attempt().unwrap_or(false)
}

fn local_name(now: f64) -> String {
    format!("{LOCAL_PREFIX}{}.jsonl", clock::utc_day(now))
}

fn is_local_file(name: &str) -> bool {
    let Some(day) = name.strip_prefix(LOCAL_PREFIX).and_then(|rest| rest.strip_suffix(".jsonl")) else {
        return false;
    };
    let chars: Vec<char> = day.chars().collect();
    chars.len() == 10
        && chars.iter().enumerate().all(|(index, ch)| {
            if index == 4 || index == 7 {
                *ch == '-'
            } else {
                crate::pystr::is_decimal(*ch)
            }
        })
}

fn prune_local(dir: &OwnedFd, now: f64) -> Result<(), Failure> {
    let oldest_kept = local_name(now - (LOCAL_DAYS - 1.0) * 86_400.0);
    let mut files = Vec::new();
    let mut names: Vec<String> = paths::list_dir(dir)?.into_iter().filter(|name| is_local_file(name)).collect();
    names.sort();
    for name in names {
        let Ok(size) = paths::size_at(dir, &name) else { continue };
        if name < oldest_kept {
            paths::unlink_quietly(&name, dir);
        } else {
            files.push((name, size as usize));
        }
    }
    let mut excess = files.iter().map(|(_, size)| *size as i64).sum::<i64>() - MAX_LOCAL_BYTES as i64;
    for (name, size) in files {
        if excess <= 0 {
            break;
        }
        excess -= drop_oldest_lines(dir, &name, size, excess as usize)? as i64;
    }
    Ok(())
}

fn drop_oldest_lines(dir: &OwnedFd, name: &str, size: usize, excess: usize) -> Result<usize, Failure> {
    let fd = paths::open_private_file(name, dir, libc::O_RDONLY)?;
    let raw = paths::read_fd(&fd, size)?;
    drop(fd);
    let from = excess.saturating_sub(1).min(raw.len());
    let rest = match raw[from..].iter().position(|byte| *byte == b'\n') {
        Some(cut) => raw[from + cut + 1..].to_vec(),
        None => Vec::new(),
    };
    if rest.is_empty() {
        paths::unlink_quietly(name, dir);
        return Ok(size);
    }
    paths::write_private(name, dir, &rest)?;
    Ok(size - rest.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::FromRawFd;

    #[test]
    fn a_local_copy_is_named_with_python_re_digits() {
        assert!(is_local_file("cli-2026-11-19.jsonl"));
        assert!(is_local_file("cli-\u{661}\u{669}\u{669}\u{669}-\u{660}\u{661}-\u{660}\u{661}.jsonl"));
        assert!(is_local_file("cli-\u{ff12}026-11-19.jsonl"));
        assert!(!is_local_file("cli-\u{b2}026-11-19.jsonl"));
        assert!(!is_local_file("cli-2026-11-1.jsonl"));
        assert!(!is_local_file("cli-2026/11-19.jsonl"));
    }

    #[test]
    fn a_copy_dated_in_other_digits_counts_against_the_cap() {
        let dir = std::env::temp_dir().join(format!("ardia-local-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let other = "cli-\u{661}\u{669}\u{669}\u{669}-\u{660}\u{661}-\u{660}\u{661}.jsonl";
        let line = format!("{}\n", "x".repeat(1023));
        std::fs::write(dir.join(other), line.repeat(MAX_LOCAL_BYTES / 1024 + 8)).unwrap();
        let path = std::ffi::CString::new(dir.to_str().unwrap()).unwrap();
        let fd = unsafe { OwnedFd::from_raw_fd(libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY)) };
        assert!(prune_local(&fd, clock::now()).is_ok());
        let left = std::fs::metadata(dir.join(other)).map(|meta| meta.len() as usize).unwrap_or(0);
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(left <= MAX_LOCAL_BYTES, "{left}");
    }
}
