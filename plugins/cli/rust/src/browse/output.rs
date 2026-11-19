use super::answer::{self, Text};
use super::errors::BrowseError;
use super::redact::Secrets;
use crate::json::{self, Map, Style, Value};
use crate::printable::{inert, json_safe, quiet_stdout};
use crate::telemetry::{self, Call};
use std::io::Write;

const CLOSED: i64 = 141;

#[derive(Default)]
pub struct Printer {
    closed: bool,
}

impl Printer {
    fn emit(&mut self, fd: i32, bytes: &[u8]) {
        if self.closed || bytes.is_empty() {
            return;
        }
        let written = if fd == 1 {
            let mut stdout = std::io::stdout().lock();
            stdout.write_all(bytes).and_then(|_| stdout.flush())
        } else {
            let _ = std::io::stdout().flush();
            let mut stderr = std::io::stderr().lock();
            stderr.write_all(bytes).and_then(|_| stderr.flush())
        };
        if written.is_err() {
            self.closed = true;
            quiet_stdout();
        }
    }

    fn out(&mut self, text: &str) {
        self.emit(1, json_safe(text).as_bytes());
    }

    fn err(&mut self, text: &str) {
        self.emit(2, inert(text).as_bytes());
    }

    fn settle(&self, status: i64) -> i64 {
        if self.closed {
            CLOSED
        } else {
            status
        }
    }

    pub fn usage_error(&mut self, message: &str) -> i64 {
        self.err(&format!("✗ {message}\n"));
        self.settle(1)
    }

    pub fn say_version(&mut self) -> i64 {
        self.out(&format!("ardia browse {}\n", telemetry::version()));
        self.settle(0)
    }

    pub fn interrupted(&mut self) -> i64 {
        self.err("✗ interrupted\n");
        self.settle(130)
    }

    pub fn error(&mut self, error: &BrowseError, as_json: bool, secrets: &Secrets, call: &mut Call) -> i64 {
        if let Some(code) = error.code {
            call.note_error_code(code);
        }
        if as_json {
            let mut payload = vec![
                ("success", Value::Bool(false)),
                ("data", Value::Null),
                ("error", Value::Str(secrets.redact(&error.message))),
            ];
            if let Some(code) = error.code {
                payload.push(("code", Value::Str(secrets.redact(code))));
            }
            let rendered = json_safe(&json::dumps(&Value::object(payload), Style::Compact, false)) + "\n";
            let text = secrets.redact(&secrets.redact(&rendered));
            self.out(&text);
        } else {
            let rendered = format!("✗ {}\n", inert(&error.message));
            let text = secrets.redact(&secrets.redact(&rendered));
            self.err(&text);
        }
        self.settle(error.exit)
    }

    pub fn answer(&mut self, answer: &Map, secrets: &Secrets, call: &mut Call) -> i64 {
        if let Some(Value::Str(code)) = answer.get("code") {
            call.note_error_code(code);
        }
        for (key, value) in answer::clean_metrics(answer.get("metrics")).iter() {
            call.metrics.insert(key, value.clone());
        }
        call.metrics.insert("output_chars", Value::Int(answer::output_chars(answer)));
        for (key, fd) in [("out", 1), ("err", 2)] {
            match answer::text_of(answer, key) {
                Text::Missing => {}
                Text::Given(text) => {
                    let text = secrets.redact(&text);
                    if fd == 1 {
                        self.out(&text);
                    } else {
                        self.err(&text);
                    }
                    if self.closed {
                        return CLOSED;
                    }
                }
                Text::Unprintable => return self.crashed(&format!("its {key} isn't text"), call),
            }
        }
        match answer::exit_status(answer.get("exit")) {
            Some(status) => status,
            None => self.crashed("its exit isn't a whole number", call),
        }
    }

    pub fn crashed(&mut self, why: &str, call: &mut Call) -> i64 {
        call.note_error_code("malformed_answer");
        self.err(&format!("✗ the ardia browse daemon's answer couldn't be read ({why}); see the session log\n"));
        self.settle(1)
    }
}
