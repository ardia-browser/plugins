use super::errors::{self, BrowseError};
use super::url;
use crate::control;
use crate::paths;
use std::io::{ErrorKind, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

pub const DIR_NAME: &str = "Browse";
pub const MAX_RESPONSE: usize = 256 * 1024 * 1024;
const CHUNK: usize = 1 << 20;
const POLL: Duration = Duration::from_millis(100);
const QUEUE_WAIT: f64 = 30.0;
const BEHIND_SCRIPT_WAIT: f64 = 300.0;
const COMMAND_LIMIT: f64 = 120.0;
const LIMIT_MARGIN: f64 = 30.0;
const SCRIPT_DEFAULT: f64 = 90.0;
const DEFAULT_TIMEOUT_MS: f64 = 25000.0;
const LONG_COMMANDS: &[(&str, f64)] = &[("batch", 600.0), ("read", 600.0), ("record", 600.0)];

pub enum Step<T> {
    Done(T),
    Failed(BrowseError),
    Unported,
}

fn digits_with_point(text: &str) -> bool {
    let (whole, fraction) = match text.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (text, None),
    };
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    digits(whole) && fraction.is_none_or(digits)
}

fn seconds_of(text: &str) -> Option<Option<f64>> {
    if text.is_empty() {
        return Some(None);
    }
    if !text.is_ascii() {
        return None;
    }
    let body = text.trim_matches(crate::py::is_space);
    let (number, scale) = if let Some(number) = body.strip_suffix("ms") {
        (number, 0.001)
    } else if let Some(number) = body.strip_suffix('s') {
        (number, 1.0)
    } else if let Some(number) = body.strip_suffix('m') {
        (number, 60.0)
    } else {
        (body, 0.001)
    };
    if !digits_with_point(number) {
        return Some(None);
    }
    Some(number.parse::<f64>().ok().map(|value| value * scale))
}

fn given_timeout(argv: &[String]) -> Option<Option<f64>> {
    let mut given = None;
    for (index, token) in argv.iter().enumerate() {
        if token == "--" {
            break;
        }
        if token == "--timeout" && index + 1 < argv.len() {
            given = seconds_of(&argv[index + 1])?;
        } else if let Some(value) = token.strip_prefix("--timeout=") {
            given = seconds_of(value)?;
        }
    }
    Some(given)
}

fn nonzero(value: Option<f64>) -> Option<f64> {
    value.filter(|value| *value != 0.0)
}

fn command_limit(name: &str, argv: &[String], timeout: f64) -> Option<f64> {
    let given = given_timeout(argv)?;
    if name == "wait" {
        if argv.iter().any(|arg| !arg.is_ascii()) {
            return None;
        }
        let plain = match argv.iter().find(|arg| digits_with_point(arg)) {
            Some(arg) => seconds_of(arg)?,
            None => None,
        };
        let base = nonzero(given).or(nonzero(plain)).unwrap_or(timeout);
        return Some(COMMAND_LIMIT.max(base + LIMIT_MARGIN));
    }
    if name == "script" {
        return Some(nonzero(given).unwrap_or(SCRIPT_DEFAULT) + LIMIT_MARGIN);
    }
    let long = LONG_COMMANDS
        .iter()
        .find(|(command, _)| *command == name)
        .map_or(COMMAND_LIMIT, |(_, limit)| *limit);
    Some(long.max(nonzero(given).unwrap_or(0.0) + LIMIT_MARGIN))
}

fn queue_wait(name: &str, argv: &[String], patient: bool) -> Option<f64> {
    if patient {
        return Some(QUEUE_WAIT.max(command_limit(name, argv, DEFAULT_TIMEOUT_MS / 1000.0)? - LIMIT_MARGIN));
    }
    if name != "script" {
        return Some(QUEUE_WAIT);
    }
    Some(QUEUE_WAIT.max(nonzero(given_timeout(argv)?).unwrap_or(SCRIPT_DEFAULT)))
}

pub fn answer_deadline(argv: &[String], timeout_ms: f64, patient: bool) -> Option<f64> {
    let name = argv.first().map_or("", String::as_str);
    let rest = argv.get(1..).unwrap_or(&[]);
    let timeout = timeout_ms / 1000.0;
    let waits = queue_wait(name, rest, patient)?.max(BEHIND_SCRIPT_WAIT);
    Some(waits + command_limit(name, rest, timeout)? + LIMIT_MARGIN)
}

pub enum Opened {
    Dir(OwnedFd),
    Refused(String),
    Unported,
}

fn private_dir(dir: &OwnedFd, label: &str) -> Result<Option<String>, ()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let info = paths::metadata(dir).map_err(|_| ())?;
    if !info.is_dir() {
        return Ok(Some(format!("{label} isn't a folder")));
    }
    if info.uid() != paths::uid() {
        return Ok(Some(format!("{label} belongs to another user")));
    }
    if info.permissions().mode() & 0o077 != 0 {
        return Ok(Some(format!("{label} must be private (mode 0700)")));
    }
    Ok(None)
}

fn open_dir(path: &str, inside: Option<&OwnedFd>) -> Result<OwnedFd, Result<String, ()>> {
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW;
    let opened = match inside {
        Some(dir) => paths::openat(dir, path, flags, 0),
        None => paths::open(Path::new(path), flags),
    };
    opened.map_err(|error| match error.raw_os_error() {
        Some(libc::ELOOP | libc::ENOTDIR) => Ok(format!("{path} is a symbolic link or not a folder")),
        Some(libc::ENOENT) if inside.is_none() => Ok(format!("{path} doesn't exist")),
        _ => Err(()),
    })
}

pub fn browse_dir(root: &str) -> Opened {
    use std::os::unix::fs::MetadataExt;
    let root_fd = match open_dir(root, None) {
        Ok(fd) => fd,
        Err(Ok(message)) => return Opened::Refused(message),
        Err(Err(())) => return Opened::Unported,
    };
    match paths::metadata(&root_fd) {
        Ok(info) if info.uid() != paths::uid() => return Opened::Refused(format!("{root} belongs to another user")),
        Ok(_) => {}
        Err(_) => return Opened::Unported,
    }
    let name = std::ffi::CString::new(DIR_NAME).unwrap_or_default();
    if unsafe { libc::mkdirat(root_fd.as_raw_fd(), name.as_ptr(), 0o700) } != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
        return Opened::Unported;
    }
    let dir = match open_dir(DIR_NAME, Some(&root_fd)) {
        Ok(fd) => fd,
        Err(Ok(message)) => return Opened::Refused(message),
        Err(Err(())) => return Opened::Unported,
    };
    match private_dir(&dir, DIR_NAME) {
        Ok(None) => Opened::Dir(dir),
        Ok(Some(message)) => Opened::Refused(message),
        Err(()) => Opened::Unported,
    }
}

pub enum Connected {
    Stream(UnixStream),
    Absent,
}

fn socket_is_ours(dir: &OwnedFd, name: &str) -> Step<bool> {
    let cname = std::ffi::CString::new(name).unwrap_or_default();
    let mut info: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(dir.as_raw_fd(), cname.as_ptr(), &mut info, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        return match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ENOENT) => Step::Done(false),
            _ => Step::Unported,
        };
    }
    let refusal = if info.st_mode & libc::S_IFMT != libc::S_IFSOCK {
        Some(format!("{name} isn't a socket"))
    } else if info.st_uid != paths::uid() {
        Some(format!("{name} belongs to another user"))
    } else if info.st_mode & 0o077 != 0 {
        Some(format!("{name} must be mode 0600"))
    } else {
        None
    };
    match refusal {
        Some(why) => Step::Failed(BrowseError::plain(format!("Refusing the session socket: {why}"))),
        None => Step::Done(true),
    }
}

struct WorkingDir(OwnedFd);

impl WorkingDir {
    fn enter(dir: &OwnedFd) -> Option<WorkingDir> {
        let here = paths::open(Path::new("."), libc::O_RDONLY | libc::O_DIRECTORY).ok()?;
        if unsafe { libc::fchdir(dir.as_raw_fd()) } != 0 {
            return None;
        }
        Some(WorkingDir(here))
    }
}

impl Drop for WorkingDir {
    fn drop(&mut self) {
        unsafe { libc::fchdir(self.0.as_raw_fd()) };
    }
}

fn connect_here(name: &str) -> Result<UnixStream, i32> {
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(0);
    }
    let socket = unsafe { OwnedFd::from_raw_fd(fd) };
    unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (slot, byte) in address.sun_path.iter_mut().zip(name.bytes()) {
        *slot = byte as libc::c_char;
    }
    let size = std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
    loop {
        if unsafe { libc::connect(fd, (&address as *const libc::sockaddr_un).cast(), size) } == 0 {
            return Ok(UnixStream::from(socket));
        }
        let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        if code != libc::EINTR {
            return Err(code);
        }
    }
}

pub fn connect(dir: &OwnedFd, key: &str) -> Step<Connected> {
    let name = format!("{key}.sock");
    match socket_is_ours(dir, &name) {
        Step::Done(true) => {}
        Step::Done(false) => return Step::Done(Connected::Absent),
        Step::Failed(error) => return Step::Failed(error),
        Step::Unported => return Step::Unported,
    }
    let Some(inside) = WorkingDir::enter(dir) else { return Step::Unported };
    let connected = connect_here(&name);
    drop(inside);
    let stream = match connected {
        Ok(stream) => stream,
        Err(libc::ECONNREFUSED | libc::ENOENT) => return Step::Done(Connected::Absent),
        Err(_) => return Step::Unported,
    };
    if control::peer_uid(&stream) != Some(paths::uid()) {
        return Step::Failed(BrowseError::plain("The session socket isn't served by your user; refusing it"));
    }
    Step::Done(Connected::Stream(stream))
}

pub enum Reply {
    Raw(Vec<u8>),
    Failed(BrowseError),
    Interrupted,
}

fn shown_seconds(seconds: f64) -> String {
    url::general(seconds)
}

pub fn exchange(mut stream: UnixStream, payload: &[u8], command: &str, seconds: f64, limit: usize) -> Reply {
    let started = Instant::now();
    let deadline = started + Duration::from_secs_f64(seconds.max(0.0));
    let _ = stream.set_write_timeout(Some(POLL));
    let mut sent = 0;
    while sent < payload.len() {
        match stream.write(&payload[sent..]) {
            Ok(0) => {
                return Reply::Failed(BrowseError::unreachable(
                    "the ardia browse daemon closed the connection before taking the command (see the session log)",
                ))
            }
            Ok(count) => sent += count,
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted) => {
                if control::interrupted() {
                    return Reply::Interrupted;
                }
                if Instant::now() >= deadline {
                    return Reply::Failed(BrowseError::unreachable(format!(
                        "the ardia browse daemon didn't take the command in {} s (see the session log)",
                        shown_seconds(seconds)
                    )));
                }
            }
            Err(_) => {
                return Reply::Failed(BrowseError::unreachable(
                    "the ardia browse daemon closed the connection before taking the command (see the session log)",
                ))
            }
        }
    }
    if control::interrupted() {
        return Reply::Interrupted;
    }
    let mut raw = Vec::new();
    let mut chunk = vec![0u8; CHUNK];
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Reply::Failed(errors::stalled(command, &shown_seconds(seconds)));
        }
        let _ = stream.set_read_timeout(Some(POLL.min(deadline - now).max(Duration::from_millis(1))));
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => {
                raw.extend_from_slice(&chunk[..count]);
                if raw.len() > limit {
                    return Reply::Failed(BrowseError::plain("The daemon's answer was too large"));
                }
                if chunk[count - 1] == b'\n' {
                    break;
                }
            }
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted) => {
                if control::interrupted() {
                    return Reply::Interrupted;
                }
            }
            Err(error) if error.kind() == ErrorKind::ConnectionReset => return Reply::Failed(errors::gone(command)),
            Err(_) => return Reply::Failed(errors::gone(command)),
        }
    }
    if raw.last() != Some(&b'\n') {
        return Reply::Failed(errors::gone(command));
    }
    Reply::Raw(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| word.to_string()).collect()
    }

    fn daemon(answer: &'static [u8], hold: Duration) -> (UnixStream, std::thread::JoinHandle<Vec<u8>>) {
        let (client, mut server) = UnixStream::pair().unwrap();
        let handle = std::thread::spawn(move || {
            let mut line = Vec::new();
            let mut byte = [0u8; 1];
            while server.read(&mut byte).unwrap_or(0) == 1 && byte[0] != b'\n' {
                line.push(byte[0]);
            }
            for piece in answer.split_inclusive(|byte| *byte == b'|') {
                let _ = server.write_all(piece.strip_suffix(b"|").unwrap_or(piece));
                std::thread::sleep(Duration::from_millis(20));
            }
            std::thread::sleep(hold);
            line
        });
        (client, handle)
    }

    fn failure(reply: Reply) -> BrowseError {
        match reply {
            Reply::Failed(error) => error,
            Reply::Raw(raw) => panic!("answered {raw:?}"),
            Reply::Interrupted => panic!("interrupted"),
        }
    }

    #[test]
    fn frames_one_line_each_way() {
        let (client, handle) = daemon(b"{\"out\": |\"x\"}\n", Duration::ZERO);
        let Reply::Raw(raw) = exchange(client, b"{\"argv\": [\"get\"]}\n", "get", 5.0, MAX_RESPONSE) else {
            panic!()
        };
        assert_eq!(raw, b"{\"out\": \"x\"}\n");
        assert_eq!(handle.join().unwrap(), b"{\"argv\": [\"get\"]}");
    }

    #[test]
    fn a_silent_daemon_stalls_reads_and_leaves_actions_unknown() {
        let (client, _handle) = daemon(b"", Duration::from_millis(600));
        let stalled = failure(exchange(client, b"{}\n", "get", 0.25, MAX_RESPONSE));
        assert_eq!((stalled.exit, stalled.code), (2, None));
        assert_eq!(stalled.message, "the ardia browse daemon didn't answer in 0.25 s (see the session log)");
        let (client, _handle) = daemon(b"", Duration::from_millis(600));
        let unknown = failure(exchange(client, b"{}\n", "key", 0.25, MAX_RESPONSE));
        assert_eq!(unknown.code, Some("outcome_unknown"));
        assert!(unknown.message.ends_with("the outcome of `press` is unknown, so it wasn't retried"));
    }

    #[test]
    fn a_partial_or_oversized_answer_is_refused() {
        let (client, _handle) = daemon(b"{\"out\": \"x\"}", Duration::ZERO);
        assert_eq!(failure(exchange(client, b"{}\n", "open", 5.0, MAX_RESPONSE)).code, Some("outcome_unknown"));
        let (client, _handle) = daemon(b"0123456789|0123456789\n", Duration::ZERO);
        assert_eq!(failure(exchange(client, b"{}\n", "get", 5.0, 15)).message, "The daemon's answer was too large");
    }

    #[test]
    fn deadlines_follow_limits_py() {
        assert_eq!(answer_deadline(&strings(&["get", "title"]), 25000.0, false), Some(450.0));
        assert_eq!(answer_deadline(&strings(&["batch"]), 25000.0, false), Some(930.0));
        assert_eq!(answer_deadline(&strings(&["click", "--timeout", "200s"]), 25000.0, false), Some(560.0));
        assert_eq!(
            answer_deadline(&strings(&["click", "--timeout=2m", "--", "--timeout", "999s"]), 25000.0, false),
            Some(480.0)
        );
        assert_eq!(answer_deadline(&strings(&["wait", "200000"]), 25000.0, false), Some(560.0));
        assert_eq!(answer_deadline(&strings(&["wait", "@e1"]), 400000.0, false), Some(760.0));
        assert_eq!(answer_deadline(&strings(&["read", "x"]), 25000.0, true), Some(570.0 + 600.0 + 30.0));
        assert_eq!(answer_deadline(&strings(&["click", "--timeout", "٣s"]), 25000.0, false), None);
        assert_eq!(answer_deadline(&strings(&[]), 25000.0, false), Some(450.0));
    }
}
