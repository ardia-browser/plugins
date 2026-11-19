use std::fmt::Write as _;
use std::io::Write;

fn escaped(text: &str, escape: impl Fn(u32) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        let code = ch as u32;
        if escape(code) {
            let _ = write!(out, "\\u{code:04x}");
        } else {
            out.push(ch);
        }
    }
    out
}

pub fn shown(text: &str) -> String {
    escaped(text, |c| c <= 0x1f || (0x7f..=0x9f).contains(&c))
}

pub fn inert(text: &str) -> String {
    escaped(text, |c| c <= 0x08 || (0x0b..=0x1f).contains(&c) || (0x7f..=0x9f).contains(&c))
}

pub fn json_safe(text: &str) -> String {
    escaped(text, |c| (0x7f..=0x9f).contains(&c))
}

const PYTHON_DEFAULT_BUFFER: usize = 8192;

#[derive(Debug, PartialEq)]
enum Stopped {
    Closed,
    Interrupted,
    Failed(i32),
}

fn write_stdout(mut bytes: &[u8], interrupted: impl Fn() -> bool) -> Result<(), Stopped> {
    while !bytes.is_empty() {
        if interrupted() {
            return Err(Stopped::Interrupted);
        }
        let written = unsafe { libc::write(1, bytes.as_ptr().cast(), bytes.len()) };
        if written >= 0 {
            bytes = &bytes[written as usize..];
        } else {
            match std::io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO) {
                libc::EINTR => {}
                libc::EPIPE | libc::ESHUTDOWN => return Err(Stopped::Closed),
                errno => return Err(Stopped::Failed(errno)),
            }
        }
    }
    Ok(())
}

pub struct Output {
    json: bool,
    closed: bool,
    interrupted: bool,
    failed: Option<(i32, usize)>,
}

impl Output {
    pub fn new(json: bool) -> Output {
        Output {
            json,
            closed: false,
            interrupted: false,
            failed: None,
        }
    }

    pub fn stopped(&self) -> bool {
        self.closed || self.interrupted || self.failed.is_some()
    }

    pub fn python_crash(&self) -> Option<i32> {
        let (errno, line) = self.failed?;
        let exception = format!("{}: [Errno {errno}] {}\n", python_os_error(errno), crate::paths::strerror(errno));
        let mut stderr = std::io::stderr().lock();
        let _ = stderr.write_all(exception.as_bytes());
        if line > python_stdout_buffer() {
            return Some(1);
        }
        let _ = write!(stderr, "Exception ignored on flushing sys.stdout:\n{exception}");
        Some(120)
    }

    pub fn closed(&self) -> bool {
        self.closed
    }

    pub fn interrupted(&self) -> bool {
        self.interrupted
    }

    pub fn say(&mut self, text: &str) {
        if self.stopped() {
            return;
        }
        let text = crate::pystr::well_formed(text);
        let mut line = if self.json { json_safe(&text) } else { inert(&text) };
        line.push('\n');
        match write_stdout(line.as_bytes(), crate::control::interrupted) {
            Ok(()) => {}
            Err(Stopped::Closed) => self.closed = true,
            Err(Stopped::Interrupted) => self.interrupted = true,
            Err(Stopped::Failed(errno)) => self.failed = Some((errno, line.len())),
        }
        if self.stopped() {
            quiet_stdout();
        }
    }

    pub fn complain(&mut self, text: &str) {
        let _ = std::io::stdout().flush();
        let mut stderr = std::io::stderr().lock();
        let _ = stderr.write_all(inert(&crate::pystr::well_formed(text)).as_bytes());
        let _ = stderr.write_all(b"\n");
        let _ = stderr.flush();
    }
}

fn python_os_error(errno: i32) -> &'static str {
    match errno {
        libc::EPIPE | libc::ESHUTDOWN => "BrokenPipeError",
        libc::EAGAIN | libc::EALREADY | libc::EINPROGRESS => "BlockingIOError",
        libc::ECHILD => "ChildProcessError",
        libc::ECONNRESET => "ConnectionResetError",
        libc::ECONNABORTED => "ConnectionAbortedError",
        libc::ECONNREFUSED => "ConnectionRefusedError",
        libc::EEXIST => "FileExistsError",
        libc::ENOENT => "FileNotFoundError",
        libc::EINTR => "InterruptedError",
        libc::EISDIR => "IsADirectoryError",
        libc::ENOTDIR => "NotADirectoryError",
        libc::EACCES | libc::EPERM => "PermissionError",
        libc::ESRCH => "ProcessLookupError",
        libc::ETIMEDOUT => "TimeoutError",
        _ => "OSError",
    }
}

fn python_stdout_buffer() -> usize {
    let mut info: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(1, &mut info) } == 0 && info.st_blksize > 1 {
        info.st_blksize as usize
    } else {
        PYTHON_DEFAULT_BUFFER
    }
}

pub fn stdout_unusable() -> bool {
    let flags = unsafe { libc::fcntl(1, libc::F_GETFL) };
    flags < 0 || flags & libc::O_ACCMODE == libc::O_RDONLY || flags & libc::O_NONBLOCK != 0
}

pub fn stdout_flush_failed(error: &std::io::Error) -> i32 {
    let errno = error.raw_os_error().unwrap_or(0);
    if errno == libc::EBADF {
        return 0;
    }
    let _ = write!(
        std::io::stderr(),
        "Exception ignored on flushing sys.stdout:\n{}: [Errno {errno}] {}\n",
        python_os_error(errno),
        crate::paths::strerror(errno)
    );
    120
}

fn quiet_stdout() {
    let null = std::ffi::CString::new("/dev/null").unwrap_or_default();
    unsafe {
        let sink = libc::open(null.as_ptr(), libc::O_WRONLY);
        if sink >= 0 {
            libc::dup2(sink, 1);
            libc::close(sink);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_like_printable_py() {
        assert_eq!(shown("a\tb\u{7f}\u{85}é"), "a\\u0009b\\u007f\\u0085é");
        assert_eq!(inert("a\tb\nc\u{1b}[0m\u{9f}"), "a\tb\nc\\u001b[0m\\u009f");
        assert_eq!(json_safe("\u{1}\u{80}"), "\u{1}\\u0080");
    }

    #[test]
    fn a_write_stops_when_interrupted() {
        assert_eq!(write_stdout(b"never written", || true), Err(Stopped::Interrupted));
        assert_eq!(write_stdout(b"", || true), Ok(()));
    }

    #[test]
    fn names_the_exception_python_raises() {
        assert_eq!(python_os_error(libc::EPIPE), "BrokenPipeError");
        assert_eq!(python_os_error(libc::EAGAIN), "BlockingIOError");
        assert_eq!(python_os_error(libc::EIO), "OSError");
        assert_eq!(python_os_error(libc::EBADF), "OSError");
        assert_eq!(python_os_error(libc::ENOSPC), "OSError");
    }
}
