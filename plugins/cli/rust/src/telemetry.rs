use crate::clock;
use crate::endpoint;
use crate::json::{self, Map, Style, Value};
use crate::paths::{self, env, Failure};
use crate::records;
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
const LOCAL_ONLY_ID: &str = "local";
const MAX_SPOOL_BYTES: usize = 256 * 1024;
const COUNT_CHECK_BYTES: u64 = 64 * 1024;
const MAX_EVENTS: usize = 500;
const MAX_LINE_BYTES: usize = 32 * 1024;
const FLUSH_INTERVAL_S: f64 = 60.0;
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
    pub(crate) started: Instant,
    pub(crate) started_at: f64,
    pub command: String,
    pub subcommand: Option<String>,
    pub allowed_flags: &'static [&'static str],
    pub error_code: Option<String>,
}

impl Call {
    pub fn new(argv: &[String]) -> Call {
        Call {
            argv: argv.to_vec(),
            started: Instant::now(),
            started_at: clock::now(),
            command: "none".into(),
            subcommand: None,
            allowed_flags: &[],
            error_code: None,
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

pub fn read_consent(root: &Path) -> Result<Option<Map>, json::TooDeep> {
    let Ok(fd) = paths::open(&root.join(CONSENT_FILE), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK) else {
        return Ok(None);
    };
    let Ok(info) = paths::metadata(&fd) else { return Ok(None) };
    if !info.is_file() || info.uid() != paths::uid() || info.size() > MAX_CONSENT_BYTES as u64 {
        return Ok(None);
    }
    let Ok(raw) = paths::read_fd(&fd, MAX_CONSENT_BYTES + 1) else {
        return Ok(None);
    };
    match json::parse_limited(&raw, json::TELEMETRY_DEPTH)? {
        Some(Value::Object(map)) => Ok(Some(map)),
        _ => Ok(None),
    }
}

fn epoch_seconds(value: &Value) -> Option<f64> {
    match value {
        Value::Int(number) => {
            let number = *number as f64;
            Some(if number > 1e11 { number / 1000.0 } else { number })
        }
        Value::Float(number) => Some(if *number > 1e11 { number / 1000.0 } else { *number }),
        Value::BigInt(text) => {
            let number = text.parse::<f64>().ok()?;
            Some(if number > 1e11 { number / 1000.0 } else { number })
        }
        Value::Str(text) => match clock::parse_iso(text) {
            clock::Iso::At(seconds) => Some(seconds),
            clock::Iso::Invalid | clock::Iso::Unported => None,
        },
        _ => None,
    }
}

fn valid_id(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.to_lowercase();
    let id = text.strip_suffix('\n').unwrap_or(&text);
    let groups: Vec<&str> = id.split('-').collect();
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

fn expiry_overflows(doc: &Map) -> bool {
    let Some(Value::BigInt(text)) = doc.get("sharingUntil") else { return false };
    let floored = if text.starts_with('-') {
        text.as_str()
    } else {
        &text[..text.len().saturating_sub(3)]
    };
    doc.get("sharing") == Some(&Value::Bool(true)) && floored.parse::<f64>().is_ok_and(f64::is_infinite)
}

pub fn consent_unreadable(argv: &[String]) -> bool {
    cli_target(argv)
        .and_then(|target| read_consent(Path::new(&target.root)).ok().flatten())
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

pub(crate) fn session_id(doc: Option<&Map>) -> String {
    if let Some(doc) = doc {
        if doc.get("sessionOpen") == Some(&Value::Bool(true)) {
            if let Some(session) = valid_id(doc.get("sessionId")) {
                return session;
            }
        }
    }
    uuid7()
}

pub(crate) fn watch_report(doc: &Map) -> Option<String> {
    let report = doc.get("watchReport")?.as_str()?;
    let code = report.strip_prefix("FB-")?;
    ((2..=16).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())).then(|| report.to_string())
}

pub fn finish(call: &Call, status: i64, python: Option<&Path>) {
    finish_with(call, status, None, python);
}

pub fn finish_crashed(call: &Call, errno: i32, python: Option<&Path>) {
    finish_with(call, 1, Some(errno), python);
}

fn finish_with(call: &Call, status: i64, crash: Option<i32>, python: Option<&Path>) {
    usage::record(call, status);
    let Some(target) = cli_target(&call.argv) else { return };
    let root = PathBuf::from(&target.root);
    let Ok(doc) = read_consent(&root) else { return };
    if doc.as_ref().is_some_and(|doc| unreadable_expiry(doc) || expiry_overflows(doc)) {
        return;
    }
    let install_id = sharing_id(doc.as_ref());
    let distinct_id = install_id.as_deref().unwrap_or(LOCAL_ONLY_ID);
    let session = session_id(doc.as_ref());
    let mut records = Vec::new();
    if let Some(errno) = crash {
        records.push(records::exception_record(errno, distinct_id, target.environment, doc.as_ref(), &session));
    }
    records.push(records::command_record(
        call,
        status,
        crash.is_some(),
        distinct_id,
        target.environment,
        doc.as_ref(),
        &session,
    ));
    crate::local_copy::keep(&root, &records, install_id.is_some());
    if install_id.is_none() {
        discard_spool(&root);
        return;
    }
    if let Some(dir) = append(&root, &records) {
        start_flush(&dir, &target, python);
    }
}

pub(crate) fn open_folder(root: &Path, create: bool) -> Result<OwnedFd, Failure> {
    paths::open_private(root, &[FOLDER], create)
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

fn spool_line(record: &Value) -> Option<Vec<u8>> {
    let mut line = crate::pystr::well_formed(&json::dumps(record, Style::Compact, false)).into_owned().into_bytes();
    line.push(b'\n');
    (line.len() <= MAX_LINE_BYTES).then_some(line)
}

fn append(root: &Path, records: &[Value]) -> Option<OwnedFd> {
    let data: Vec<Vec<u8>> = records.iter().filter_map(spool_line).collect();
    let size_of_data: usize = data.iter().map(Vec::len).sum();
    let dir = open_folder(root, true).ok()?;
    let lock = paths::take_lock_retrying(SPOOL_LOCK, &dir).ok()??;
    let size = paths::size_at(&dir, SPOOL).unwrap_or(0);
    let written = if size + size_of_data as u64 <= COUNT_CHECK_BYTES {
        paths::open_private_file(SPOOL, &dir, libc::O_WRONLY | libc::O_CREAT | libc::O_APPEND).and_then(|fd| Ok(paths::write_once(&fd, &data.concat())?))
    } else {
        read_lines(&dir).and_then(|mut lines| {
            lines.extend(data);
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
        Some(Value::BigInt(digits)) => digits.parse().unwrap_or(0.0),
        Some(Value::Float(number)) => *number,
        _ => 0.0,
    }
}

fn whole(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::Int(number)) => Some(Value::Int(*number)),
        Some(Value::BigInt(digits)) => Some(Value::BigInt(digits.clone())),
        Some(Value::Float(number)) if !number.is_finite() => None,
        Some(Value::Float(number)) => {
            let number = number.trunc();
            Some(if number.abs() < 1e18 {
                Value::Int(number as i128)
            } else {
                Value::BigInt(format!("{number:.0}"))
            })
        }
        _ => Some(Value::Int(0)),
    }
}

fn start_flush(dir: &OwnedFd, target: &Target, python: Option<&Path>) {
    let Ok(Some(claim)) = paths::take_lock(FLUSH_CLAIM_LOCK, dir) else { return };
    let raw = paths::read_private(FLUSH_STATE, dir, 64 * 1024).ok().flatten();
    let Ok(state) = raw.map_or(Ok(None), |raw| json::parse_limited(&raw, json::TELEMETRY_DEPTH)) else {
        return;
    };
    let state = match &state {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let now = clock::now();
    if number(state.get("next_at")) > now {
        return;
    }
    let Some(failures) = whole(state.get("failures")) else { return };
    let written = Value::object(vec![("failures", failures), ("next_at", Value::Float(now + FLUSH_INTERVAL_S))]);
    if paths::write_private(
        FLUSH_STATE,
        dir,
        crate::pystr::well_formed(&json::dumps(&written, Style::Spaced, false)).as_bytes(),
    )
    .is_err()
    {
        return;
    }
    drop(claim);
    if let Some(python) = python {
        spawn_flusher(python, target);
    }
}

#[cfg(target_os = "linux")]
const OPEN_DESCRIPTORS: &str = "/proc/self/fd";
#[cfg(not(target_os = "linux"))]
const OPEN_DESCRIPTORS: &str = "/dev/fd";

pub const DESCRIPTOR_SCAN_CAP: libc::c_int = 1 << 20;

fn listed_descriptors(listing: &Path) -> Option<Vec<libc::c_int>> {
    let found: Vec<libc::c_int> = std::fs::read_dir(listing)
        .ok()?
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
        .collect();
    (!found.is_empty()).then_some(found)
}

fn scanned_descriptors(from: libc::c_int) -> Vec<libc::c_int> {
    let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
    let hard = if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } == 0 && limit.rlim_max != libc::RLIM_INFINITY {
        limit.rlim_max.min(DESCRIPTOR_SCAN_CAP as libc::rlim_t) as libc::c_int
    } else {
        DESCRIPTOR_SCAN_CAP
    };
    (from..hard).collect()
}

pub fn close_on_exec_from(from: libc::c_int, listing: &Path) {
    let descriptors = listed_descriptors(listing).unwrap_or_else(|| scanned_descriptors(from));
    for fd in descriptors.into_iter().filter(|fd| *fd >= from) {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags >= 0 && flags & libc::FD_CLOEXEC == 0 {
            unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) };
        }
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
    close_on_exec_from(3, Path::new(OPEN_DESCRIPTORS));
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            libc::signal(libc::SIGPIPE, libc::SIG_DFL);
            libc::signal(libc::SIGXFSZ, libc::SIG_DFL);
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
    fn flush_failures_convert_like_python_int() {
        assert_eq!(whole(Some(&Value::Float(f64::NAN))), None);
        assert_eq!(whole(Some(&Value::Float(f64::NEG_INFINITY))), None);
        assert_eq!(whole(Some(&Value::Float(-3.9))), Some(Value::Int(-3)));
        assert_eq!(whole(Some(&Value::Float(1e300))), Some(Value::BigInt("1000000000000000052504760255204420248704468581108159154915854115511802457988908195786371375080447864043704443832883878176942523235360430575644792184786706982848387200926575803737830233794788090059368953234970799945081119038967640880074652742780142494579258788820056842838115669472196386865459400540160".into())));
        assert_eq!(whole(Some(&Value::Float(-2.5e19))), Some(Value::BigInt("-25000000000000000000".into())));
        assert_eq!(whole(Some(&Value::Bool(true))), Some(Value::Int(0)));
        assert_eq!(whole(None), Some(Value::Int(0)));
        assert_eq!(number(Some(&Value::BigInt("9".repeat(400)))), f64::INFINITY);
    }

    #[test]
    fn marks_descriptors_above_the_soft_limit_when_the_listing_is_missing() {
        let mut pair = [0; 2];
        assert_eq!(unsafe { libc::pipe(pair.as_mut_ptr()) }, 0);
        let high = 4000;
        assert_eq!(unsafe { libc::dup2(pair[1], high) }, high);
        let mut saved: libc::rlimit = unsafe { std::mem::zeroed() };
        unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut saved) };
        let lowered = libc::rlimit {
            rlim_cur: 32,
            rlim_max: saved.rlim_max,
        };
        unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lowered) };
        close_on_exec_from(3, Path::new("/nonexistent-descriptor-listing"));
        unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &saved) };
        let flags = unsafe { libc::fcntl(high, libc::F_GETFD) };
        for fd in [pair[0], pair[1], high] {
            unsafe { libc::close(fd) };
        }
        assert!(flags >= 0 && flags & libc::FD_CLOEXEC != 0, "{flags}");
    }

    #[test]
    fn makes_uuid7s() {
        let id = uuid7();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "7");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        assert!(valid_id(Some(&Value::str(&id.to_uppercase()))).is_some());
        assert_eq!(valid_id(Some(&Value::str(&format!("{}\n", id.to_uppercase())))), Some(format!("{id}\n")));
        assert_eq!(valid_id(Some(&Value::str(&format!("{id}\n\n")))), None);
        assert_eq!(valid_id(Some(&Value::str(&format!("\n{id}")))), None);
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
}
