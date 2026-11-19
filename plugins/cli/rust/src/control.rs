use crate::caller::Caller;
use crate::endpoint::{self, NOT_REACHABLE};
use crate::json::{self, Style, Value};
use crate::paths::{self, LINUX};
use crate::py;
use std::io::{ErrorKind, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub const SOCKET_FILE: &str = "ArdiaControl.sock";
const SUN_PATH_MAX: usize = 103;
const LINUX_SUN_PATH_MAX: usize = 107;
pub const MAX_LINE: usize = 1024 * 1024;
pub const CONNECT_TIMEOUT: f64 = 5.0;
pub const CALL_TIMEOUT: f64 = 30.0;
const POLL: Duration = Duration::from_millis(100);

static INTERRUPTED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_interrupt(_: libc::c_int) {
    INTERRUPTED.store(true, Ordering::SeqCst);
}

pub struct Interrupts(libc::sigaction);

impl Drop for Interrupts {
    fn drop(&mut self) {
        unsafe { libc::sigaction(libc::SIGINT, &self.0, std::ptr::null_mut()) };
    }
}

pub fn catch_interrupts() -> Interrupts {
    let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
    unsafe { libc::sigaction(libc::SIGINT, std::ptr::null(), &mut previous) };
    if previous.sa_sigaction != libc::SIG_IGN {
        let handler: extern "C" fn(libc::c_int) = on_interrupt;
        let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
        action.sa_sigaction = handler as libc::sighandler_t;
        unsafe {
            libc::sigemptyset(&mut action.sa_mask);
            libc::sigaction(libc::SIGINT, &action, std::ptr::null_mut());
        }
    }
    Interrupts(previous)
}

pub fn interrupted() -> bool {
    INTERRUPTED.load(Ordering::SeqCst)
}

#[derive(Debug, PartialEq)]
pub enum Failure {
    Unreachable { message: String, sent: bool },
    Incompatible { message: String },
    Method { code: String, message: String },
    Interrupted,
    Unported,
}

impl Failure {
    pub fn error_code(&self) -> Option<&str> {
        match self {
            Failure::Unreachable { sent: true, .. } => Some("connection_dropped"),
            Failure::Unreachable { sent: false, .. } => Some("unreachable"),
            Failure::Incompatible { .. } => Some("unsupported_protocol"),
            _ => None,
        }
    }
}

pub const PROTOCOL: i128 = 4;
pub const MIN_APP_PROTOCOL: i128 = 1;

fn unreachable(detail: Option<&str>) -> Failure {
    let message = match detail {
        Some(detail) => format!("{NOT_REACHABLE} ({detail})"),
        None => NOT_REACHABLE.to_string(),
    };
    Failure::Unreachable { message, sent: false }
}

fn sent(failure: Failure) -> Failure {
    match failure {
        Failure::Unreachable { message, .. } => Failure::Unreachable { message, sent: true },
        other => other,
    }
}

pub fn socket_path(data_dir: Option<&str>) -> PathBuf {
    endpoint::data_root(data_dir).join(SOCKET_FILE)
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
}

pub fn check_socket(path: &Path) -> Result<(), Failure> {
    let size = path.as_os_str().as_bytes().len();
    let limit = if LINUX { LINUX_SUN_PATH_MAX } else { SUN_PATH_MAX };
    if size > limit {
        return Err(Failure::Unreachable {
            message: format!(
                "the control socket path is {size} bytes, over the {limit} a Unix socket allows: {}; use a shorter data dir",
                path.display()
            ),
            sent: false,
        });
    }
    let name = file_name(path);
    let info = match std::fs::symlink_metadata(path) {
        Ok(info) => info,
        Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR)) => return Err(unreachable(None)),
        Err(error) => return Err(unreachable(Some(&format!("{name}: {}", paths::strerror(error.raw_os_error().unwrap_or(0)))))),
    };
    if !info.file_type().is_socket() {
        return Err(unreachable(Some(&format!("{name} isn't a socket"))));
    }
    if info.uid() != paths::uid() {
        return Err(unreachable(Some(&format!("{name} belongs to another user"))));
    }
    Ok(())
}

fn connect_socket(path: &Path, timeout: f64) -> Result<UnixStream, Failure> {
    let name = file_name(path);
    let os_failure = |code: i32| -> Failure {
        if code == libc::ENOENT || code == libc::ECONNREFUSED {
            unreachable(None)
        } else {
            unreachable(Some(&format!("{name}: {}", paths::strerror(code))))
        }
    };
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(os_failure(std::io::Error::last_os_error().raw_os_error().unwrap_or(0)));
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    unsafe {
        libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC);
        let flags = libc::fcntl(fd.as_raw_fd(), libc::F_GETFL);
        libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    let bytes = path.as_os_str().as_bytes();
    for (slot, byte) in address.sun_path.iter_mut().zip(bytes) {
        *slot = *byte as libc::c_char;
    }
    let length = (std::mem::size_of::<libc::sa_family_t>() + bytes.len() + 1) as libc::socklen_t;
    let connected = unsafe { libc::connect(fd.as_raw_fd(), (&address as *const libc::sockaddr_un).cast(), length) };
    if connected != 0 {
        let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
        if code != libc::EINPROGRESS && code != libc::EAGAIN {
            return Err(os_failure(code));
        }
        let mut poll = libc::pollfd {
            fd: fd.as_raw_fd(),
            events: libc::POLLOUT,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut poll, 1, (timeout * 1000.0) as libc::c_int) };
        if ready == 0 {
            return Err(unreachable(Some(&format!("{name} didn't accept in {} s", g(timeout)))));
        }
        let mut code: libc::c_int = 0;
        let mut size = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
        unsafe {
            libc::getsockopt(
                fd.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                (&mut code as *mut libc::c_int).cast(),
                &mut size,
            )
        };
        if code != 0 {
            return Err(os_failure(code));
        }
    }
    unsafe {
        let flags = libc::fcntl(fd.as_raw_fd(), libc::F_GETFL);
        libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags & !libc::O_NONBLOCK);
    }
    Ok(UnixStream::from(fd))
}

pub fn g(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e16 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

#[cfg(target_os = "macos")]
fn peer_uid(stream: &UnixStream) -> Option<u32> {
    let mut raw = [0u8; 76];
    let mut size = raw.len() as libc::socklen_t;
    let result = unsafe { libc::getsockopt(stream.as_raw_fd(), 0, 1, raw.as_mut_ptr().cast(), &mut size) };
    if result != 0 || size < 8 {
        return None;
    }
    Some(u32::from_ne_bytes([raw[4], raw[5], raw[6], raw[7]]))
}

#[cfg(not(target_os = "macos"))]
fn peer_uid(stream: &UnixStream) -> Option<u32> {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut size,
        )
    };
    if result != 0 || (size as usize) < std::mem::size_of::<libc::ucred>() {
        return None;
    }
    Some(credentials.uid)
}

const HIGH_WATER: usize = 64 * 1024;
const LOW_WATER: usize = 16 * 1024;

pub struct Connection {
    stream: UnixStream,
    buffer: Vec<u8>,
    next_id: i64,
    lost: Option<String>,
    reader_stopped: bool,
    pending: Option<i64>,
    reply: Option<Value>,
    unsent: Vec<u8>,
    write_failure: Option<String>,
    pub info: Value,
}

fn broke(error: &std::io::Error) -> String {
    format!("the connection broke ({})", paths::strerror(error.raw_os_error().unwrap_or(0)))
}

impl Connection {
    fn new(stream: UnixStream) -> Connection {
        let _ = stream.set_nonblocking(true);
        Connection {
            stream,
            buffer: Vec::new(),
            next_id: 0,
            lost: None,
            reader_stopped: false,
            pending: None,
            reply: None,
            unsent: Vec::new(),
            write_failure: None,
            info: Value::Null,
        }
    }

    fn lose(&mut self, reason: &str) {
        if self.lost.is_none() && !self.reader_stopped {
            self.lost = Some(reason.to_string());
        }
    }

    fn receive(&mut self) {
        while let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=end).collect();
            if line.len() > MAX_LINE + 1 {
                return self.lose("Ardia sent a line longer than 1 MB");
            }
            let message = match json::parse_limited(&line, json::CONTROL_DEPTH) {
                Ok(Some(message)) => message,
                Ok(None) => return self.lose("Ardia sent a line that isn't JSON"),
                Err(json::TooDeep) => {
                    self.reader_stopped = true;
                    self.buffer.clear();
                    return;
                }
            };
            if let (Some(Value::Int(id)), Some(ident)) = (message.get("id"), self.pending) {
                if *id == i128::from(ident) {
                    self.pending = None;
                    self.reply = Some(message);
                }
            }
        }
        if self.buffer.len() > MAX_LINE + 2 {
            self.lose("Ardia sent a line longer than 1 MB");
        }
    }

    fn read_some(&mut self) {
        let mut chunk = [0u8; 65536];
        loop {
            match self.stream.read(&mut chunk) {
                Ok(0) => return self.lose("Ardia closed the connection"),
                Ok(count) => {
                    self.buffer.extend_from_slice(&chunk[..count]);
                    self.receive();
                    if self.lost.is_some() || self.reader_stopped || self.reply.is_some() {
                        return;
                    }
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) if error.kind() == ErrorKind::WouldBlock => return,
                Err(error) => return self.lose(&broke(&error)),
            }
        }
    }

    fn write_some(&mut self) {
        while !self.unsent.is_empty() && self.write_failure.is_none() {
            match self.stream.write(&self.unsent) {
                Ok(count) => {
                    self.unsent.drain(..count);
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) if error.kind() == ErrorKind::WouldBlock => return,
                Err(error) => {
                    let reason = broke(&error);
                    self.unsent.clear();
                    self.lose(&reason);
                    self.write_failure = Some(reason);
                }
            }
        }
    }

    fn wait(&mut self, wait: Duration) {
        let reading = self.lost.is_none() && !self.reader_stopped;
        let writing = !self.unsent.is_empty() && self.write_failure.is_none();
        let mut events = 0;
        if reading {
            events |= libc::POLLIN;
        }
        if writing {
            events |= libc::POLLOUT;
        }
        let mut poll = libc::pollfd {
            fd: self.stream.as_raw_fd(),
            events,
            revents: 0,
        };
        let millis = wait.as_millis().clamp(1, POLL.as_millis()) as libc::c_int;
        if unsafe { libc::poll(&mut poll, 1, millis) } <= 0 {
            return;
        }
        if writing && poll.revents & (libc::POLLOUT | libc::POLLERR | libc::POLLHUP) != 0 {
            self.write_some();
        }
        if reading && poll.revents & (libc::POLLIN | libc::POLLERR | libc::POLLHUP) != 0 {
            self.read_some();
        }
    }

    fn drain(&mut self) -> Result<(), Failure> {
        if self.write_failure.is_some() {
            return Err(sent(unreachable(Some("the connection broke (Connection lost)"))));
        }
        if self.unsent.len() <= HIGH_WATER {
            return Ok(());
        }
        while self.unsent.len() > LOW_WATER {
            if let Some(reason) = &self.write_failure {
                return Err(sent(unreachable(Some(reason))));
            }
            if interrupted() {
                return Err(Failure::Interrupted);
            }
            self.wait(POLL);
        }
        Ok(())
    }

    fn await_reply(&mut self, method: &str, timeout: Option<f64>) -> Result<Value, Failure> {
        let deadline = timeout.map(|seconds| Instant::now() + Duration::from_secs_f64(seconds));
        loop {
            if let Some(reply) = self.reply.take() {
                return Ok(reply);
            }
            if let Some(reason) = &self.lost {
                return Err(unreachable(Some(reason)));
            }
            if interrupted() {
                return Err(Failure::Interrupted);
            }
            let wait = match deadline {
                Some(deadline) => {
                    let now = Instant::now();
                    if now >= deadline {
                        self.pending = None;
                        let seconds = timeout.unwrap_or_default();
                        return Err(unreachable(Some(&format!("Ardia didn't answer {method} in {} s", g(seconds)))));
                    }
                    (deadline - now).min(POLL)
                }
                None => POLL,
            };
            self.wait(wait);
        }
    }

    pub fn call(&mut self, method: &str, params: Option<Value>, timeout: Option<f64>) -> Result<Value, Failure> {
        if let Some(reason) = &self.lost {
            return Err(unreachable(Some(reason)));
        }
        self.next_id += 1;
        let ident = self.next_id;
        let mut request = vec![("id", Value::Int(i128::from(ident))), ("method", Value::str(method))];
        if let Some(params) = params {
            request.push(("params", params));
        }
        let mut line = json::dumps(&Value::object(request), Style::Compact, false).into_bytes();
        line.push(b'\n');
        if line.len() > MAX_LINE {
            return Err(Failure::Method {
                code: "bad_request".into(),
                message: "the request is longer than 1 MB".into(),
            });
        }
        self.pending = Some(ident);
        self.reply = None;
        self.unsent.extend_from_slice(&line);
        self.write_some();
        if let Err(failure) = self.drain() {
            self.pending = None;
            return Err(failure);
        }
        let reply = self.await_reply(method, timeout).map_err(sent)?;
        if let Some(error) = reply.get("error") {
            let code = error.get("code").filter(|code| py::truthy(code)).map_or(Ok("failed".to_string()), py::str_of);
            let message = error
                .get("message")
                .filter(|text| py::truthy(text))
                .map_or(Ok("failed".to_string()), py::str_of);
            let (Ok(code), Ok(message)) = (code, message) else {
                return Err(Failure::Unported);
            };
            return Err(Failure::Method { code, message });
        }
        Ok(reply.get("result").cloned().unwrap_or(Value::Null))
    }
}

pub fn connect(path: &Path, timeout: f64, caller: &Caller) -> Result<Connection, Failure> {
    check_socket(path)?;
    let stream = connect_socket(path, timeout)?;
    let name = file_name(path);
    match peer_uid(&stream) {
        Some(uid) if uid == paths::uid() => {}
        Some(_) => return Err(unreachable(Some(&format!("{name} is served by another user")))),
        None => return Err(unreachable(Some(&format!("{name} couldn't check who serves it")))),
    }
    let mut connection = Connection::new(stream);
    let hello = Value::object(vec![("caller", caller.wire()), ("protocol", Value::Int(PROTOCOL))]);
    match connection.call("hello", Some(hello), Some(timeout)) {
        Ok(info) => {
            if info.get("app") != Some(&Value::str("Ardia")) {
                return Err(unreachable(Some(&format!("something other than Ardia answers on {name}"))));
            }
            let spoken = match info.get("protocol") {
                Some(Value::Int(spoken)) => spoken.to_string(),
                Some(Value::BigInt(spoken)) => spoken.clone(),
                _ => "1".to_string(),
            };
            let older = match spoken.parse::<i128>() {
                Ok(number) => number < MIN_APP_PROTOCOL,
                Err(_) => spoken.starts_with('-'),
            };
            if older {
                let version = match info.get("version") {
                    None => String::new(),
                    Some(version) => py::str_of(version).map_err(|_| Failure::Unported)?,
                };
                return Err(Failure::Incompatible {
                    message: format!("Ardia {version} speaks control protocol {spoken}, and this ardia needs {MIN_APP_PROTOCOL} or later: update Ardia"),
                });
            }
            connection.info = info;
            Ok(connection)
        }
        Err(Failure::Method { code, message }) if code == "unsupported_protocol" => Err(Failure::Incompatible { message }),
        Err(Failure::Method { message, .. }) => Err(unreachable(Some(&format!("hello failed: {message}")))),
        Err(Failure::Unreachable { message, .. }) => Err(Failure::Unreachable { message, sent: false }),
        Err(other) => Err(other),
    }
}

pub fn call(data_dir: Option<&str>, method: &str, params: Option<Value>, caller: &Caller) -> Result<Value, Failure> {
    let mut connection = connect(&socket_path(data_dir), CONNECT_TIMEOUT, caller)?;
    connection.call(method, params, Some(CALL_TIMEOUT))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;
    use std::os::unix::net::UnixListener;

    fn serve(name: &str, answer: impl Fn(&Value) -> Option<String> + Send + 'static) -> (PathBuf, std::thread::JoinHandle<Vec<Value>>) {
        let dir = PathBuf::from(format!("/tmp/ardia-control-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(SOCKET_FILE);
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut writer = stream.try_clone().unwrap();
            let mut seen = Vec::new();
            for line in std::io::BufReader::new(stream).lines() {
                let Ok(line) = line else { break };
                let request = json::parse(line.as_bytes()).unwrap();
                seen.push(request.clone());
                match answer(&request) {
                    Some(reply) => {
                        if writer.write_all(reply.as_bytes()).is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            seen
        });
        (dir, server)
    }

    fn caller() -> Caller {
        Caller {
            name: "Test".into(),
            app: None,
        }
    }

    #[test]
    fn says_hello_then_calls() {
        let (dir, server) = serve("ok", |request| {
            let id = json::dumps(request.get("id").unwrap(), Style::Compact, false);
            match request.get("method").and_then(Value::as_str) {
                Some("hello") => Some(format!("{{\"event\":\"tab.opened\"}}\n{{\"id\":{id},\"result\":{{\"app\":\"Ardia\"}}}}\n")),
                _ => Some(format!("{{\"id\":{id},\"result\":[1,2]}}\n")),
            }
        });
        let result = call(Some(dir.to_str().unwrap()), "windows", None, &caller()).unwrap();
        assert_eq!(result, Value::Array(vec![Value::Int(1), Value::Int(2)]));
        let seen = server.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            json::dumps(&seen[0], Style::Compact, false),
            r#"{"id":1,"method":"hello","params":{"caller":{"name":"Test"},"protocol":4}}"#
        );
        assert_eq!(json::dumps(&seen[1], Style::Compact, false), r#"{"id":2,"method":"windows"}"#);
    }

    #[test]
    fn a_protocol_mismatch_says_which_side_to_update() {
        let (dir, server) = serve("old-app", |request| {
            let id = json::dumps(request.get("id").unwrap(), Style::Compact, false);
            Some(format!(
                "{{\"id\":{id},\"result\":{{\"app\":\"Ardia\",\"version\":\"0.1.0\",\"protocol\":0}}}}\n"
            ))
        });
        let failure = call(Some(dir.to_str().unwrap()), "windows", None, &caller()).unwrap_err();
        assert!(matches!(&failure, Failure::Incompatible { message } if message.contains("update Ardia") && !message.contains(NOT_REACHABLE)));
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        let (dir, server) = serve("old-cli", |request| {
            let id = json::dumps(request.get("id").unwrap(), Style::Compact, false);
            Some(format!(
                "{{\"id\":{id},\"error\":{{\"code\":\"unsupported_protocol\",\"message\":\"update the command\"}}}}\n"
            ))
        });
        let failure = call(Some(dir.to_str().unwrap()), "windows", None, &caller()).unwrap_err();
        assert_eq!(
            failure,
            Failure::Incompatible {
                message: "update the command".into()
            }
        );
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reports_method_errors_and_drops() {
        let (dir, server) = serve("error", |request| {
            let id = json::dumps(request.get("id").unwrap(), Style::Compact, false);
            match request.get("method").and_then(Value::as_str) {
                Some("hello") => Some(format!("{{\"id\":{id},\"result\":{{\"app\":\"Ardia\"}}}}\n")),
                _ => Some(format!("{{\"id\":{id},\"error\":{{\"code\":\"unknown_method\",\"message\":\"nope\"}}}}\n")),
            }
        });
        let failure = call(Some(dir.to_str().unwrap()), "workspace", Some(Value::Object(Default::default())), &caller()).unwrap_err();
        assert_eq!(
            failure,
            Failure::Method {
                code: "unknown_method".into(),
                message: "nope".into()
            }
        );
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        let (dir, server) = serve("drop", |request| match request.get("method").and_then(Value::as_str) {
            Some("hello") => Some("{\"id\":1,\"result\":{\"app\":\"Ardia\"}}\n".into()),
            _ => None,
        });
        let failure = call(Some(dir.to_str().unwrap()), "windows", None, &caller()).unwrap_err();
        assert_eq!(
            failure,
            Failure::Unreachable {
                message: format!("{NOT_REACHABLE} (Ardia closed the connection)"),
                sent: true
            }
        );
        assert_eq!(failure.error_code(), Some("connection_dropped"));
        server.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_what_is_not_ardia() {
        let (dir, server) = serve("other", |_| Some("{\"id\":1,\"result\":{\"app\":\"Other\"}}\n".into()));
        let failure = call(Some(dir.to_str().unwrap()), "windows", None, &caller()).unwrap_err();
        assert_eq!(
            failure,
            Failure::Unreachable {
                message: format!("{NOT_REACHABLE} (something other than Ardia answers on ArdiaControl.sock)"),
                sent: false
            }
        );
        drop(server);
        let _ = std::fs::remove_dir_all(&dir);
        let missing = call(Some("/tmp/ardia-no-such-dir-here"), "windows", None, &caller()).unwrap_err();
        assert_eq!(
            missing,
            Failure::Unreachable {
                message: NOT_REACHABLE.into(),
                sent: false
            }
        );
        let long = format!("/tmp/{}", "x".repeat(120));
        let Failure::Unreachable { message, .. } = call(Some(&long), "windows", None, &caller()).unwrap_err() else {
            panic!()
        };
        assert!(message.starts_with("the control socket path is 143 bytes, over the"));
    }
}
