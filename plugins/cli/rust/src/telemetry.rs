use crate::clock;
use crate::endpoint;
use crate::json::{self, Map, Style, Value};
use crate::paths::{self, env, Failure};
use crate::usage;
use std::io::Write;
use std::os::fd::OwnedFd;
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

pub const LOGS_URL: &str = "https://ardia.dev/otel/v1/logs";
pub const SERVED_BY: &str = "rust";
const CONSENT_FILE: &str = "telemetry.json";
const FOLDER: &str = "Telemetry";
const SPOOL: &str = "cli-queue.jsonl";
const SPOOL_LOCK: &str = "cli-queue.lock";
const FLUSH_CLAIM_LOCK: &str = "cli-flush-claim.lock";
const FLUSH_STATE: &str = "cli-flush.json";
const MAX_CONSENT_BYTES: usize = 64 * 1024;
const LOCAL_FOLDER: &str = "local";
const LOCAL_PREFIX: &str = "cli-";
const LOCAL_LOCK: &str = "cli-local.lock";
const LOCAL_DAYS: f64 = 7.0;
const LOCAL_ONLY_ID: &str = "local";
const MAX_LOCAL_BYTES: usize = 4 * 1024 * 1024;
const MAX_SPOOL_BYTES: usize = 256 * 1024;
const COUNT_CHECK_BYTES: u64 = 64 * 1024;
const MAX_EVENTS: usize = 500;
const MAX_LINE_BYTES: usize = 32 * 1024;
const MAX_FLAGS: usize = 20;
const FLUSH_INTERVAL_S: f64 = 60.0;
const MAX_MS: f64 = 3_600_000.0;
const TEST_ENDPOINT_FLAGS: &[&str] = &["--port", "--ws", "--cdp"];
const TEST_ENDPOINT_ENV: &[&str] = &["ARDIA_WS", "ARDIA_PORT", "ARDIA_CDP_URL", "AGENT_BROWSER_CDP"];
const OFF_VALUES: &[&str] = &["0", "false", "off", "no"];

pub fn version() -> &'static str {
    option_env!("ARDIA_CLI_VERSION").unwrap_or("0.0.0.dev0")
}

pub fn is_dev_build() -> bool {
    version().contains(".dev") || version().starts_with("0.0.0")
}

pub struct Call {
    pub argv: Vec<String>,
    started: Instant,
    started_at: f64,
    pub command: String,
    pub subcommand: Option<String>,
    pub allowed_flags: Vec<&'static str>,
    pub error_code: Option<String>,
    pub metrics: Map,
}

impl Call {
    pub fn new(argv: &[String]) -> Call {
        Call {
            argv: argv.to_vec(),
            started: Instant::now(),
            started_at: clock::now(),
            command: "none".into(),
            subcommand: None,
            allowed_flags: Vec::new(),
            error_code: None,
            metrics: Map::new(),
        }
    }

    pub fn note_error_code(&mut self, code: &str) {
        if !code.is_empty() {
            self.error_code = Some(code.to_string());
        }
    }
}

pub struct Target {
    pub root: String,
    pub url: String,
    pub environment: &'static str,
}

fn lowered(name: &str) -> String {
    env(name).unwrap_or_default().trim_matches(crate::py::is_space).to_lowercase()
}

pub fn opted_out() -> bool {
    let do_not_track = lowered("DO_NOT_TRACK");
    if !matches!(do_not_track.as_str(), "" | "0" | "false") {
        return true;
    }
    OFF_VALUES.contains(&lowered("ARDIA_TELEMETRY").as_str())
}

pub fn loopback_url(text: &str) -> bool {
    let text = text.strip_suffix('\n').unwrap_or(text);
    let Some(rest) = text.strip_prefix("http://") else { return false };
    let rest = ["127.0.0.1:", "localhost:", "[::1]:"].iter().find_map(|host| rest.strip_prefix(host));
    let Some(rest) = rest else { return false };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if !(1..=5).contains(&digits) {
        return false;
    }
    let Some(path) = rest[digits..].strip_prefix('/') else { return false };
    path.len() <= 200 && path.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

pub fn logs_url() -> Option<String> {
    match paths::env_set("ARDIA_TELEMETRY_URL") {
        Some(url) => loopback_url(&url).then_some(url),
        None if is_dev_build() => None,
        None => Some(LOGS_URL.to_string()),
    }
}

fn environment_for(root: &str) -> &'static str {
    if is_dev_build() {
        return "dev";
    }
    let installed = paths::realpath(&endpoint::installed().to_string_lossy());
    if installed == paths::realpath(root) {
        "production"
    } else {
        "test"
    }
}

pub fn leading_tokens(argv: &[String]) -> &[String] {
    let end = argv.iter().position(|token| token == "--").unwrap_or(argv.len());
    &argv[..end]
}

pub fn data_dir_arg(tokens: &[String]) -> Option<String> {
    let mut found = None;
    for (index, token) in tokens.iter().enumerate() {
        if token == "--data-dir" && index + 1 < tokens.len() {
            found = Some(tokens[index + 1].clone());
        } else if let Some(value) = token.strip_prefix("--data-dir=") {
            found = Some(value.to_string());
        }
    }
    found.filter(|dir| !dir.is_empty())
}

pub fn names_test_endpoint(tokens: &[String]) -> bool {
    tokens
        .iter()
        .filter(|token| token.starts_with("--"))
        .any(|token| TEST_ENDPOINT_FLAGS.contains(&token.split('=').next().unwrap_or("")))
}

pub fn test_endpoint_env() -> bool {
    TEST_ENDPOINT_ENV.iter().any(|name| paths::env_set(name).is_some())
}

pub fn shareable() -> bool {
    !opted_out() && logs_url().is_some() && !test_endpoint_env()
}

pub fn cli_target(argv: &[String]) -> Option<Target> {
    let tokens = leading_tokens(argv);
    if names_test_endpoint(tokens) || opted_out() || test_endpoint_env() {
        return None;
    }
    let url = logs_url()?;
    let root = paths::abspath(&endpoint::data_root(data_dir_arg(tokens).as_deref()));
    let environment = environment_for(&root);
    Some(Target { root, url, environment })
}

pub fn read_consent(root: &Path) -> Option<Map> {
    let fd = paths::open(&root.join(CONSENT_FILE), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK).ok()?;
    let info = paths::metadata(&fd).ok()?;
    if !info.is_file() || info.uid() != paths::uid() || info.size() > MAX_CONSENT_BYTES as u64 {
        return None;
    }
    let raw = paths::read_fd(&fd, MAX_CONSENT_BYTES + 1).ok()?;
    match json::parse(&raw)? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn epoch_seconds(value: &Value) -> Option<f64> {
    match value {
        Value::Int(number) => {
            let number = *number as f64;
            Some(if number > 1e11 { number / 1000.0 } else { number })
        }
        Value::Float(number) => Some(if *number > 1e11 { number / 1000.0 } else { *number }),
        Value::Str(text) => match clock::parse_iso(text) {
            clock::Iso::At(seconds) => Some(seconds),
            clock::Iso::Invalid | clock::Iso::Unported => None,
        },
        _ => None,
    }
}

fn valid_id(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.to_lowercase();
    let groups: Vec<&str> = text.split('-').collect();
    let lengths = [8, 4, 4, 4, 12];
    let valid = groups.len() == 5
        && groups
            .iter()
            .zip(lengths)
            .all(|(group, length)| group.len() == length && group.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    valid.then_some(text)
}

fn unreadable_expiry(doc: &Map) -> bool {
    doc.get("sharing") == Some(&Value::Bool(true))
        && matches!(doc.get("sharingUntil"), Some(Value::Str(text)) if !matches!(clock::parse_iso(text), clock::Iso::At(_)))
}

pub fn consent_unreadable(argv: &[String]) -> bool {
    cli_target(argv)
        .and_then(|target| read_consent(Path::new(&target.root)))
        .is_some_and(|doc| unreadable_expiry(&doc))
}

pub fn sharing_id(doc: Option<&Map>) -> Option<String> {
    let doc = doc?;
    if doc.get("sharing") != Some(&Value::Bool(true)) {
        return None;
    }
    if let Some(until) = doc.get("sharingUntil").filter(|until| **until != Value::Null) {
        if let Some(until) = epoch_seconds(until) {
            if until <= clock::now() {
                return None;
            }
        }
    }
    valid_id(doc.get("installId"))
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    unsafe { libc::getentropy(bytes.as_mut_ptr().cast(), N) };
    bytes
}

pub fn uuid7() -> String {
    let ms = (clock::now() * 1000.0) as u128 & ((1 << 48) - 1);
    let rand = random_bytes::<10>().iter().fold(0u128, |value, byte| (value << 8) | u128::from(*byte));
    let value = (ms << 80) | (0x7 << 76) | (((rand >> 62) & 0xfff) << 64) | (0b10 << 62) | (rand & ((1 << 62) - 1));
    let text = format!("{value:032x}");
    format!("{}-{}-{}-{}-{}", &text[..8], &text[8..12], &text[12..16], &text[16..20], &text[20..])
}

fn session_id(doc: Option<&Map>) -> String {
    if let Some(doc) = doc {
        if doc.get("sessionOpen") == Some(&Value::Bool(true)) {
            if let Some(session) = valid_id(doc.get("sessionId")) {
                return session;
            }
        }
    }
    uuid7()
}

fn watch_report(doc: &Map) -> Option<String> {
    let report = doc.get("watchReport")?.as_str()?;
    let code = report.strip_prefix("FB-")?;
    ((2..=16).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())).then(|| report.to_string())
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

#[cfg(target_os = "macos")]
fn process_started_at() -> Option<f64> {
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
fn process_started_at() -> Option<f64> {
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
    (age >= 0.0).then(|| clock::now() - age)
}

fn whole_ms(value: f64) -> Value {
    Value::Int(value.round_ties_even().clamp(0.0, MAX_MS) as i128)
}

fn timings(call: &Call) -> Map {
    let elapsed = call.started.elapsed().as_secs_f64() * 1000.0;
    let startup = process_started_at().map(|started| (call.started_at - started) * 1000.0);
    let mut values = call.metrics.clone();
    match startup {
        Some(startup) if (0.0..=MAX_MS).contains(&startup) => {
            values.insert("startup_ms", whole_ms(startup));
            values.insert("total_ms", whole_ms(startup + elapsed));
        }
        _ => values.insert("total_ms", whole_ms(elapsed)),
    }
    values
}

fn error_code_ok(code: &str) -> bool {
    let mut bytes = code.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z')) && code.len() <= 41 && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn command_record(call: &Call, status: i64, distinct_id: &str, environment: &str, doc: Option<&Map>) -> Value {
    let error_code = call.error_code.as_deref().filter(|code| error_code_ok(code)).map_or(Value::Null, Value::str);
    let mut properties: Vec<(&str, Value)> = vec![
        ("command", Value::str(&call.command)),
        ("subcommand", call.subcommand.as_deref().map_or(Value::Null, Value::str)),
        ("exit_code", Value::Int(i128::from(status))),
        ("error_code", error_code),
        ("flags", Value::str(&flag_names(&call.argv, &call.allowed_flags))),
    ];
    let measured = timings(call);
    for (key, value) in measured.iter() {
        if !properties.iter().any(|(name, _)| *name == key.as_str()) {
            properties.push((key.as_str(), value.clone()));
        }
    }
    properties.push(("cli_version", Value::str(version())));
    properties.push(("$environment", Value::str(environment)));
    properties.push(("served_by", Value::str(SERVED_BY)));
    properties.push(("$session_id", Value::str(&session_id(doc))));
    if let Some(report) = doc.filter(|doc| sharing_id(Some(doc)).is_some()).and_then(watch_report) {
        properties.push(("watch_report", Value::Str(report)));
    }
    Value::object(vec![
        ("uuid", Value::str(&uuid7())),
        ("event", Value::str("cli_command")),
        ("distinct_id", Value::str(distinct_id)),
        ("timestamp", Value::str(&clock::iso(clock::now()))),
        ("properties", Value::object(properties)),
    ])
}

pub fn finish(call: &Call, status: i64, python: Option<&Path>) {
    usage::record(call, status);
    let Some(target) = cli_target(&call.argv) else { return };
    let root = PathBuf::from(&target.root);
    let doc = read_consent(&root);
    if doc.as_ref().is_some_and(unreadable_expiry) {
        return;
    }
    let install_id = sharing_id(doc.as_ref());
    let record = command_record(call, status, install_id.as_deref().unwrap_or(LOCAL_ONLY_ID), target.environment, doc.as_ref());
    keep_local_copy(&root, &record, install_id.is_some());
    if install_id.is_none() {
        discard_spool(&root);
        return;
    }
    if let Some(dir) = append(&root, &record) {
        start_flush(&dir, &target, python);
    }
}

fn open_folder(root: &Path, create: bool) -> Result<OwnedFd, Failure> {
    paths::open_private(root, &[FOLDER], create)
}

fn keep_local_copy(root: &Path, record: &Value, sent: bool) -> bool {
    let mut with_sent = record.clone();
    if let Value::Object(map) = &mut with_sent {
        map.insert("sent", Value::Bool(sent));
    }
    let mut data = json::dumps(&with_sent, Style::Compact, false).into_bytes();
    data.push(b'\n');
    if data.len() > MAX_LOCAL_BYTES {
        return false;
    }
    let attempt = || -> Result<bool, Failure> {
        let telemetry = open_folder(root, true)?;
        let local = paths::open_child_dir(&telemetry, LOCAL_FOLDER, true)?;
        drop(telemetry);
        let Some(_lock) = paths::take_lock_retrying(LOCAL_LOCK, &local)? else {
            return Ok(false);
        };
        let now = clock::now();
        let fd = paths::open_private_file(&local_name(now), &local, libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND)?;
        paths::write_fd(&fd, &data)?;
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
    let bytes = day.as_bytes();
    bytes.len() == 10 && bytes[4] == b'-' && bytes[7] == b'-' && bytes.iter().enumerate().all(|(index, b)| index == 4 || index == 7 || b.is_ascii_digit())
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

fn read_lines(dir: &OwnedFd) -> Result<Vec<Vec<u8>>, Failure> {
    let fd = match paths::open_private_file(SPOOL, dir, libc::O_RDONLY) {
        Err(error) if error.not_found() => return Ok(Vec::new()),
        other => other?,
    };
    let raw = paths::read_fd(&fd, MAX_SPOOL_BYTES * 2)?;
    Ok(raw
        .split(|byte| *byte == b'\n')
        .filter(|line| line.iter().any(|byte| !byte.is_ascii_whitespace()))
        .map(|line| [line, b"\n"].concat())
        .collect())
}

fn newest(lines: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
    let mut kept = Vec::new();
    let mut size = 0;
    for line in lines.into_iter().rev() {
        if kept.len() >= MAX_EVENTS || size + line.len() > MAX_SPOOL_BYTES {
            break;
        }
        size += line.len();
        kept.push(line);
    }
    kept.reverse();
    kept
}

fn write_lines(dir: &OwnedFd, lines: &[Vec<u8>]) -> Result<(), Failure> {
    if lines.is_empty() {
        paths::unlink_quietly(SPOOL, dir);
        return Ok(());
    }
    paths::write_private(SPOOL, dir, &lines.concat())
}

fn append(root: &Path, record: &Value) -> Option<OwnedFd> {
    let mut line = json::dumps(record, Style::Compact, false).into_bytes();
    line.push(b'\n');
    let data = if line.len() <= MAX_LINE_BYTES { line } else { Vec::new() };
    let dir = open_folder(root, true).ok()?;
    let lock = paths::take_lock_retrying(SPOOL_LOCK, &dir).ok()??;
    let size = paths::size_at(&dir, SPOOL).unwrap_or(0);
    let written = if size + data.len() as u64 <= COUNT_CHECK_BYTES {
        paths::open_private_file(SPOOL, &dir, libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND).and_then(|fd| Ok(paths::write_fd(&fd, &data)?))
    } else {
        read_lines(&dir).and_then(|mut lines| {
            if !data.is_empty() {
                lines.push(data);
            }
            write_lines(&dir, &newest(lines))
        })
    };
    drop(lock);
    written.ok()?;
    Some(dir)
}

fn discard_spool(root: &Path) {
    if std::fs::symlink_metadata(root.join(FOLDER).join(SPOOL)).is_err() {
        return;
    }
    let Ok(dir) = open_folder(root, false) else { return };
    if let Ok(Some(_lock)) = paths::take_lock_retrying(SPOOL_LOCK, &dir) {
        paths::unlink_quietly(SPOOL, &dir);
    }
}

fn number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Int(number)) => *number as f64,
        Some(Value::Float(number)) => *number,
        _ => 0.0,
    }
}

fn start_flush(dir: &OwnedFd, target: &Target, python: Option<&Path>) {
    let Ok(Some(claim)) = paths::take_lock(FLUSH_CLAIM_LOCK, dir) else { return };
    let state = paths::read_private(FLUSH_STATE, dir, 64 * 1024)
        .ok()
        .flatten()
        .and_then(|raw| json::parse(&raw));
    let state = match &state {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let now = clock::now();
    if number(state.get("next_at")) > now {
        return;
    }
    let failures = number(state.get("failures")).trunc();
    let written = Value::object(vec![
        ("failures", Value::Int(failures as i128)),
        ("next_at", Value::Float(now + FLUSH_INTERVAL_S)),
    ]);
    if paths::write_private(FLUSH_STATE, dir, json::dumps(&written, Style::Spaced, false).as_bytes()).is_err() {
        return;
    }
    drop(claim);
    if let Some(python) = python {
        spawn_flusher(python, target);
    }
}

fn spawn_flusher(python: &Path, target: &Target) {
    let config = Value::object(vec![
        ("data_root", Value::str(&target.root)),
        ("url", Value::str(&target.url)),
        ("environment", Value::str(target.environment)),
    ]);
    let mut command = Command::new(python);
    command
        .args(["-I", "-c", "from ardia_cli import telemetry; telemetry.flush_main()"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .current_dir("/");
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            let mut limit: libc::rlimit = std::mem::zeroed();
            let highest = if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) == 0 {
                (limit.rlim_cur as i64).clamp(3, 65_536)
            } else {
                1024
            } as libc::c_int;
            for fd in 3..highest {
                let flags = libc::fcntl(fd, libc::F_GETFD);
                if flags >= 0 {
                    libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
                }
            }
            libc::signal(libc::SIGPIPE, libc::SIG_DFL);
            Ok(())
        });
    }
    if let Ok(mut child) = command.spawn() {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(json::dumps(&config, Style::Spaced, true).as_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_uuid7s() {
        let id = uuid7();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "7");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        assert!(valid_id(Some(&Value::str(&id.to_uppercase()))).is_some());
    }

    #[test]
    fn reads_consent_like_telemetry_py() {
        let id = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
        let doc = json::parse(format!(r#"{{"sharing":true,"installId":"{}","watchReport":"FB-AB12"}}"#, id.to_uppercase()).as_bytes()).unwrap();
        let Value::Object(doc) = doc else { panic!() };
        assert_eq!(sharing_id(Some(&doc)).as_deref(), Some(id));
        assert_eq!(watch_report(&doc).as_deref(), Some("FB-AB12"));
        let mut expired = doc.clone();
        expired.insert("sharingUntil", Value::Int(1000));
        assert_eq!(sharing_id(Some(&expired)), None);
        let mut later = doc.clone();
        later.insert("sharingUntil", Value::str("2999-01-01T00:00:00Z"));
        assert!(sharing_id(Some(&later)).is_some());
        let mut off = doc;
        off.insert("sharing", Value::Int(1));
        assert_eq!(sharing_id(Some(&off)), None);
    }

    #[test]
    fn names_only_known_flags() {
        let argv: Vec<String> = ["--json", "tabs", "--window=w-1", "--flat", "--json", "--", "--usage"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(flag_names(&argv, &["--json", "--window", "--flat", "--usage"]), "--flat,--json,--window");
        assert!(loopback_url("http://127.0.0.1:9/v1/logs"));
        assert!(!loopback_url("http://example.com:9/x"));
        assert!(!loopback_url("https://127.0.0.1:9/x"));
        assert_eq!(data_dir_arg(&["--data-dir".into(), "a".into(), "--data-dir=b".into()]), Some("b".into()));
        assert!(error_code_ok("connection_dropped"));
        assert!(!error_code_ok("Bad"));
    }
}
