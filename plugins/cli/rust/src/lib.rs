pub mod browse_route;
#[rustfmt::skip]
pub mod browse_tables;
pub mod caller;
pub mod clock;
pub mod commands;
pub mod control;
pub mod detached;
pub mod endpoint;
pub mod help;
pub mod json;
pub mod json_bytes;
pub mod local_copy;
pub mod paths;
pub mod plist;
pub mod printable;
pub mod py;
pub mod pystr;
pub mod records;
pub mod router;
pub mod standard_fds;
pub mod telemetry;
pub mod usage;

use commands::{Kind, Listing, Rendered};
use json::Value;
use std::ffi::OsString;
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};

const PY_INT_MAX_STR_DIGITS: usize = 4300;
const TOP_FLAGS: &[&str] = &["-h", "--help", "--version", "--skill"];
const TABS_FLAGS: &[&str] = &[
    "-h",
    "--help",
    "--version",
    "--skill",
    "--data-dir",
    "--json",
    "--window",
    "--profile",
    "--flat",
    "--usage",
    "--pid",
];
const GROUPS_FLAGS: &[&str] = &["-h", "--help", "--version", "--skill", "--data-dir", "--json", "--window", "--profile"];
const LISTING_FLAGS: &[&str] = &["-h", "--help", "--version", "--skill", "--data-dir", "--json"];

#[derive(Debug, PartialEq)]
pub enum Route {
    Version,
    Help,
    Listing(Kind, Listing),
    Python,
}

fn value_of<'a>(argv: &'a [String], index: &mut usize, name: &str) -> Option<&'a str> {
    let token = &argv[*index];
    if let Some(value) = token.strip_prefix(name).and_then(|rest| rest.strip_prefix('=')) {
        *index += 1;
        return Some(value);
    }
    if token != name {
        return None;
    }
    let value = argv.get(*index + 1).filter(|value| !value.starts_with('-'))?;
    *index += 2;
    Some(value)
}

pub fn serves(label: &str) -> bool {
    router::Table::compiled().side(label) == Some(router::Side::Rust)
}

impl Route {
    pub fn label(&self) -> Option<&'static str> {
        match self {
            Route::Version => Some("--version"),
            Route::Help => Some("--help"),
            Route::Listing(kind, _) => Some(kind.name()),
            Route::Python => None,
        }
    }
}

pub fn route(argv: &[String]) -> Route {
    match parse_route(argv) {
        route if route.label().is_some_and(|label| !serves(label)) => Route::Python,
        route => route,
    }
}

pub fn parse_route(argv: &[String]) -> Route {
    if argv == ["--version"] {
        return Route::Version;
    }
    if argv.is_empty() || argv == ["--help"] || argv == ["-h"] {
        return Route::Help;
    }
    let mut listing = Listing::default();
    let mut index = 0;
    let kind = loop {
        let Some(token) = argv.get(index) else { return Route::Python };
        if token == "--json" {
            listing.json = true;
            index += 1;
            continue;
        }
        if let Some(value) = value_of(argv, &mut index, "--data-dir") {
            listing.data_dir = Some(value.to_string());
            continue;
        }
        break match token.as_str() {
            "tabs" => Kind::Tabs,
            "groups" => Kind::Groups,
            "windows" => Kind::Windows,
            "commands" => Kind::Commands,
            _ => return Route::Python,
        };
    };
    index += 1;
    while index < argv.len() {
        let token = argv[index].as_str();
        let tabs = kind == Kind::Tabs;
        let picks = matches!(kind, Kind::Tabs | Kind::Groups);
        match token {
            "--json" => listing.json = true,
            "--flat" if tabs => listing.flat = true,
            "--usage" if tabs => listing.usage = true,
            _ => {
                if let Some(value) = value_of(argv, &mut index, "--data-dir") {
                    listing.data_dir = Some(value.to_string());
                    continue;
                }
                if picks {
                    if let Some(value) = value_of(argv, &mut index, "--window") {
                        listing.window = Some(value.to_string());
                        continue;
                    }
                    if let Some(value) = value_of(argv, &mut index, "--profile") {
                        listing.profile = Some(value.to_string());
                        continue;
                    }
                }
                if tabs {
                    if let Some(value) = value_of(argv, &mut index, "--pid") {
                        let Some(pid) = Some(value)
                            .filter(|text| !text.is_empty() && text.len() <= PY_INT_MAX_STR_DIGITS && text.bytes().all(|b| b.is_ascii_digit()))
                            .and_then(|text| text.parse().ok())
                        else {
                            return Route::Python;
                        };
                        listing.pid = Some(pid);
                        continue;
                    }
                }
                return Route::Python;
            }
        }
        index += 1;
    }
    Route::Listing(kind, listing)
}

fn install_root() -> Option<PathBuf> {
    let exe = std::fs::canonicalize(std::env::current_exe().ok()?).ok()?;
    Some(exe.parent()?.parent()?.to_path_buf())
}

struct Lease(Option<PathBuf>);

impl Lease {
    fn take(root: Option<&Path>) -> Lease {
        let Some(leases) = root.map(|root| root.join(".leases")).filter(|leases| leases.is_dir()) else {
            return Lease(None);
        };
        let path = leases.join(std::process::id().to_string());
        let made = std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(&path).is_ok();
        Lease(made.then_some(path))
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn pass_through(python: Option<&Path>, argv: &[OsString]) -> i32 {
    let Some(python) = python.filter(|python| python.exists()) else {
        let place = python.map_or_else(|| "next to this ardia".to_string(), |python| python.display().to_string());
        let _ = writeln!(std::io::stderr(), "ardia: this command runs on the bundled Python, which isn't there ({place})");
        return 127;
    };
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    standard_fds::close_those_closed_at_start();
    let error = std::process::Command::new(python)
        .arg0(python)
        .args(["-I", "-m", "ardia_cli"])
        .args(argv)
        .exec();
    let _ = writeln!(
        std::io::stderr(),
        "ardia: couldn't run {}: {}",
        python.display(),
        paths::strerror(error.raw_os_error().unwrap_or(0))
    );
    127
}

fn serve_help(argv: &[String], python: Option<&Path>) -> Option<i32> {
    let text = help::render()?;
    let mut call = telemetry::Call::new(argv);
    call.allowed_flags = TOP_FLAGS;
    let shown = printable::inert(&text);
    if argv.is_empty() {
        let exit = match printable::write_as_python_buffers(shown.as_bytes(), printable::python_stdout_buffer(), || false) {
            Err(printable::Stopped::Failed { errno, unwritten }) => {
                telemetry::finish_crashed(&call, errno, python);
                printable::report_crash(errno, &unwritten)
            }
            Err(_) => {
                call.note_error_code("stdout_closed");
                telemetry::finish(&call, 141, python);
                141
            }
            Ok(()) => {
                telemetry::finish(&call, 0, python);
                0
            }
        };
        return Some(exit);
    }
    let mut stdout = std::io::stdout().lock();
    let written = stdout.write_all(shown.as_bytes()).and_then(|_| stdout.flush());
    drop(stdout);
    let exit = match written {
        Err(error) => {
            telemetry::finish(&call, 0, python);
            printable::stdout_flush_failed(&error)
        }
        Ok(()) => {
            telemetry::finish(&call, 0, python);
            0
        }
    };
    Some(exit)
}

fn serve_listing(kind: Kind, listing: &Listing, argv: &[String], python: Option<&Path>) -> Option<i32> {
    let mut call = telemetry::Call::new(argv);
    call.command = kind.name().to_string();
    call.allowed_flags = match kind {
        Kind::Tabs => TABS_FLAGS,
        Kind::Groups => GROUPS_FLAGS,
        Kind::Windows | Kind::Commands => LISTING_FLAGS,
    };
    let interrupts = control::catch_interrupts();
    let caller = caller::current();
    let reply = control::call(listing.data_dir.as_deref(), kind.method(), listing.params(kind), &caller);
    let reply = if control::interrupted() { Err(control::Failure::Interrupted) } else { reply };
    let rendered = match reply {
        Ok(result) => {
            if matches!(kind, Kind::Tabs | Kind::Groups) && matches!(result, Value::Bool(_) | Value::Int(_) | Value::BigInt(_)) {
                return None;
            }
            commands::render(kind, listing, &result).ok()?
        }
        Err(failure @ (control::Failure::Unreachable { .. } | control::Failure::Incompatible { .. })) => {
            let (control::Failure::Unreachable { message, .. } | control::Failure::Incompatible { message }) = &failure else {
                unreachable!()
            };
            Rendered {
                complaint: Some(format!("ardia: {message}")),
                status: 2,
                error_code: failure.error_code().map(str::to_string),
                ..Default::default()
            }
        }
        Err(control::Failure::Method { code, message }) => commands::method_failed(kind, listing, &code, &message),
        Err(control::Failure::Unported) => return None,
        Err(control::Failure::Interrupted) => Rendered {
            complaint: Some(format!("ardia {}: interrupted", kind.name())),
            status: 130,
            ..Default::default()
        },
    };
    let mut out = printable::Output::new(listing.json);
    let mut status = rendered.status;
    if let Some(code) = &rendered.error_code {
        call.note_error_code(code);
    }
    for line in &rendered.lines {
        out.say(line);
        if out.stopped() {
            break;
        }
    }
    drop(interrupts);
    if out.interrupted() {
        status = 130;
        if let Some(errno) = out.complain(&format!("ardia {}: interrupted", kind.name())) {
            return Some(complaint_failed(&mut call, errno, python));
        }
    } else if out.closed() {
        call.note_error_code("stdout_closed");
        status = 141;
    } else if let Some(errno) = out.failed() {
        telemetry::finish_crashed(&call, errno, python);
        return Some(out.report_crash());
    } else if let Some(errno) = rendered.complaint.as_deref().and_then(|complaint| out.complain(complaint)) {
        return Some(complaint_failed(&mut call, errno, python));
    }
    telemetry::finish(&call, status, python);
    Some(status as i32)
}

fn complaint_failed(call: &mut telemetry::Call, errno: i32, python: Option<&Path>) -> i32 {
    if matches!(errno, libc::EPIPE | libc::ESHUTDOWN) {
        printable::quiet_stdout();
        call.note_error_code("stdout_closed");
        telemetry::finish(call, 141, python);
        return 141;
    }
    telemetry::finish_crashed(call, errno, python);
    let _ = printable::to_stderr(printable::exception_line(errno).as_bytes());
    1
}

enum Handled {
    Status(i32),
    Signaled(libc::c_int),
    Python,
}

fn run_ts(program: &Path, raw: &[OsString]) -> Handled {
    let interrupts_ignored = router::interrupts_ignored();
    let caller = caller::current();
    match router::run_child(program, |lifeline| router::marker(interrupts_ignored, lifeline, &caller), raw) {
        router::Ended::NotStarted | router::Ended::Exited(router::HAND_BACK) => Handled::Python,
        router::Ended::Exited(status) => Handled::Status(status),
        router::Ended::Signaled(signal) => Handled::Signaled(signal),
    }
}

fn run_rust(route: Route, argv: &[String], python: Option<&Path>) -> Handled {
    if route != Route::Version && (!paths::paths_are_text() || telemetry::consent_unreadable(argv)) {
        return Handled::Python;
    }
    let served = match route {
        Route::Version => match writeln!(std::io::stdout(), "ardia {}", telemetry::version()).and_then(|_| std::io::stdout().flush()) {
            Ok(()) => Some(0),
            Err(error) => Some(printable::version_write_failed(&error)),
        },
        Route::Help => serve_help(argv, python),
        Route::Listing(kind, listing) => serve_listing(kind, &listing, argv, python),
        Route::Python => None,
    };
    served.map_or(Handled::Python, Handled::Status)
}

fn run_for_plugin(root: Option<&Path>, raw: &[OsString]) -> Handled {
    let Some(program) = router::ts_program(root) else {
        return Handled::Status(browse_route::refuse(raw, "this ardia has no TypeScript client"));
    };
    let interrupts_ignored = router::interrupts_ignored();
    let caller = caller::current();
    match router::run_child(&program, |lifeline| router::marker(interrupts_ignored, lifeline, &caller), raw) {
        router::Ended::NotStarted => Handled::Status(browse_route::refuse(raw, "its TypeScript client didn't start")),
        router::Ended::Exited(router::HAND_BACK) => Handled::Status(browse_route::refuse(raw, "its TypeScript client asked for Python")),
        router::Ended::Exited(status) => Handled::Status(status),
        router::Ended::Signaled(signal) => Handled::Signaled(signal),
    }
}

fn handle(root: Option<&Path>, raw: &[OsString], python: Option<&Path>) -> Handled {
    if browse_route::for_plugin() {
        return run_for_plugin(root, raw);
    }
    let Some(argv) = raw.iter().map(|arg| arg.to_str().map(str::to_string)).collect::<Option<Vec<String>>>() else {
        return Handled::Python;
    };
    let route = parse_route(&argv);
    let label = match route.label() {
        Some(label) => label,
        None if browse_route::invoked(raw) => browse_route::LABEL,
        None => return Handled::Python,
    };
    if standard_fds::any_closed_at_start() || standard_fds::any_is_a_directory() || printable::stdout_unusable() || printable::stderr_unusable() {
        return Handled::Python;
    }
    match router::Table::load(root).side(label) {
        Some(router::Side::Rust) => run_rust(route, &argv, python),
        Some(router::Side::Ts) => match router::ts_program(root) {
            Some(program) => run_ts(&program, raw),
            None => Handled::Python,
        },
        None => Handled::Python,
    }
}

pub fn run() -> i32 {
    let file_size = router::ignore_file_size_signal();
    let raw: Vec<OsString> = std::env::args_os().skip(1).collect();
    let root = install_root();
    let python = root.as_ref().map(|root| root.join("python").join("bin").join("python3"));
    let lease = Lease::take(root.as_deref());
    match handle(root.as_deref(), &raw, python.as_deref()) {
        Handled::Status(status) => printable::settle_stderr(status),
        Handled::Python => {
            router::restore_file_size_signal(&file_size);
            pass_through(python.as_deref(), &raw)
        }
        Handled::Signaled(signal) => {
            drop(lease);
            router::die_by(signal)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn routed(words: &[&str]) -> Route {
        route(&words.iter().map(|word| word.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn serves_the_ported_commands() {
        assert_eq!(routed(&["--version"]), Route::Version);
        assert_eq!(routed(&[]), Route::Help);
        assert_eq!(routed(&["-h"]), Route::Help);
        assert_eq!(
            routed(&["--json", "--data-dir", "/d", "tabs", "--window=w-1", "--pid", "42", "--flat"]),
            Route::Listing(
                Kind::Tabs,
                Listing {
                    data_dir: Some("/d".into()),
                    json: true,
                    window: Some("w-1".into()),
                    flat: true,
                    pid: Some(42),
                    ..Default::default()
                }
            )
        );
        assert_eq!(
            routed(&["tabs", "--pid", &"0".repeat(PY_INT_MAX_STR_DIGITS)]),
            Route::Listing(
                Kind::Tabs,
                Listing {
                    pid: Some(0),
                    ..Default::default()
                }
            )
        );
        assert_eq!(
            routed(&["windows", "--data-dir="]),
            Route::Listing(
                Kind::Windows,
                Listing {
                    data_dir: Some(String::new()),
                    ..Default::default()
                }
            )
        );
        assert_eq!(
            routed(&["groups", "--profile", ""]),
            Route::Listing(
                Kind::Groups,
                Listing {
                    profile: Some(String::new()),
                    ..Default::default()
                }
            )
        );
    }

    #[test]
    fn serves_only_what_the_table_lists() {
        for label in ["--version", "--help", "tabs", "groups", "windows", "commands"] {
            assert!(serves(label), "{label}");
        }
        assert!(!serves("tabs open"));
        assert!(!serves(""));
    }

    #[test]
    fn hands_everything_else_to_python() {
        for words in [
            &["--version", "x"][..],
            &["--help", "tabs"],
            &["tabs", "open", "https://example.com"],
            &["tabs", "--win", "w"],
            &["tabs", "--window", "-1"],
            &["tabs", "--pid", "+5"],
            &["tabs", "--pid", "5_0"],
            &["tabs", "--pid", &"0".repeat(PY_INT_MAX_STR_DIGITS + 1)],
            &["tabs", "--json=1"],
            &["tabs", "--help"],
            &["tabs", "--"],
            &["windows", "--flat"],
            &["groups", "--usage"],
            &["--port", "9222", "tabs"],
            &["tabs", "--data-dir"],
            &["--data-dir"],
            &["browse", "snapshot"],
            &["config", "get", "x"],
            &["--json"],
        ] {
            assert_eq!(routed(words), Route::Python, "{words:?}");
        }
    }
}
