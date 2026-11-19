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

pub struct Output {
    json: bool,
    closed: bool,
}

impl Output {
    pub fn new(json: bool) -> Output {
        Output { json, closed: false }
    }

    pub fn closed(&self) -> bool {
        self.closed
    }

    pub fn say(&mut self, text: &str) {
        if self.closed {
            return;
        }
        let clean = if self.json { json_safe(text) } else { inert(text) };
        let mut stdout = std::io::stdout().lock();
        let written = stdout
            .write_all(clean.as_bytes())
            .and_then(|_| stdout.write_all(b"\n"))
            .and_then(|_| stdout.flush());
        if written.is_err() {
            self.closed = true;
            quiet_stdout();
        }
    }

    pub fn complain(&mut self, text: &str) {
        let _ = std::io::stdout().flush();
        let mut stderr = std::io::stderr().lock();
        let _ = stderr.write_all(inert(text).as_bytes());
        let _ = stderr.write_all(b"\n");
        let _ = stderr.flush();
    }
}

pub fn quiet_stdout() {
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
}
