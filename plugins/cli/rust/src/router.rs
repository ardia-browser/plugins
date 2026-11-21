use crate::caller::Caller;
use crate::json::{self, Style};
use std::ffi::{CString, OsString};
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};

pub const HAND_BACK: i32 = 253;
pub const MARKER_VERSION: u32 = 2;
const LIFELINE_FLOOR: libc::c_int = 3;
const COMPILED: &str = include_str!("../../served.txt");
const TABLE_LIMIT: u64 = 64 * 1024;
const FORWARDED: [libc::c_int; 3] = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP];
const RUNTIME_PREFIXES: [&[u8]; 4] = [b"BUN_", b"JSC_", b"NODE_", b"UV_"];
const RUNTIME_PREFIXES_ANY_CASE: [&[u8]; 1] = [b"MIMALLOC_"];

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Side {
    Rust,
    Ts,
}

#[derive(Debug, PartialEq)]
pub struct Table(Vec<(String, Side)>);

impl Table {
    pub fn parse(text: &str) -> Option<Table> {
        let mut rows: Vec<(String, Side)> = Vec::new();
        for line in text.lines() {
            let words: Vec<&str> = line.split_whitespace().collect();
            let Some((side, label)) = words.split_last() else { continue };
            if label.is_empty() {
                return None;
            }
            let side = match *side {
                "rust" => Side::Rust,
                "ts" => Side::Ts,
                _ => return None,
            };
            let label = label.join(" ");
            if rows.iter().any(|(known, _)| *known == label) {
                return None;
            }
            rows.push((label, side));
        }
        Some(Table(rows))
    }

    pub fn compiled() -> Table {
        Table::parse(COMPILED).unwrap_or(Table(Vec::new()))
    }

    pub fn load(root: Option<&Path>) -> Table {
        root.and_then(|root| read_table(&root.join("served.txt")))
            .and_then(|text| Table::parse(&text))
            .unwrap_or_else(Table::compiled)
    }

    pub fn side(&self, label: &str) -> Option<Side> {
        self.0.iter().find(|(known, _)| known == label).map(|(_, side)| *side)
    }
}

fn read_table(path: &Path) -> Option<String> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .ok()?;
    let found = file.metadata().ok()?;
    if !found.file_type().is_file() || found.len() > TABLE_LIMIT {
        return None;
    }
    let mut text = String::new();
    file.take(TABLE_LIMIT + 1).read_to_string(&mut text).ok()?;
    (text.len() as u64 <= TABLE_LIMIT).then_some(text)
}

pub fn ts_program(root: Option<&Path>) -> Option<PathBuf> {
    root.map(|root| root.join("libexec").join("ardia-ts")).filter(|path| path.exists())
}

pub fn marker(interrupts_ignored: bool, lifeline: libc::c_int, caller: &Caller) -> String {
    let wire = json::dumps(&caller.wire(), Style::Compact, false);
    let hex: String = wire.bytes().map(|byte| format!("{byte:02x}")).collect();
    format!("--ardia-routed={MARKER_VERSION}:{}:{lifeline}:{hex}", u8::from(interrupts_ignored))
}

struct Lifeline {
    child_end: OwnedFd,
    kept: OwnedFd,
}

fn above_stdio(fd: &OwnedFd, command: libc::c_int) -> Option<OwnedFd> {
    let moved = unsafe { libc::fcntl(fd.as_raw_fd(), command, LIFELINE_FLOOR) };
    (moved >= 0).then(|| unsafe { OwnedFd::from_raw_fd(moved) })
}

fn lifeline() -> Option<Lifeline> {
    let mut ends: [libc::c_int; 2] = [-1; 2];
    if unsafe { libc::pipe(ends.as_mut_ptr()) } != 0 {
        return None;
    }
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(ends[0]), OwnedFd::from_raw_fd(ends[1])) };
    Some(Lifeline {
        child_end: above_stdio(&read, libc::F_DUPFD)?,
        kept: above_stdio(&write, libc::F_DUPFD_CLOEXEC)?,
    })
}

fn disposition(signal: libc::c_int) -> libc::sighandler_t {
    let mut current: libc::sigaction = unsafe { std::mem::zeroed() };
    unsafe { libc::sigaction(signal, std::ptr::null(), &mut current) };
    current.sa_sigaction
}

pub fn interrupts_ignored() -> bool {
    disposition(libc::SIGINT) == libc::SIG_IGN
}

#[derive(Debug, PartialEq)]
pub enum Ended {
    NotStarted,
    Exited(i32),
    Signaled(libc::c_int),
}

static CHILD: AtomicI32 = AtomicI32::new(0);

extern "C" fn forward(signal: libc::c_int) {
    let child = CHILD.load(Ordering::SeqCst);
    if child > 0 {
        unsafe { libc::kill(child, signal) };
    }
}

struct Saved {
    signal: libc::c_int,
    action: libc::sigaction,
}

fn set_handler(signal: libc::c_int, handler: libc::sighandler_t) -> Saved {
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = handler;
    action.sa_flags = libc::SA_RESTART;
    unsafe { libc::sigemptyset(&mut action.sa_mask) };
    let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
    unsafe { libc::sigaction(signal, &action, &mut previous) };
    Saved { signal, action: previous }
}

pub struct FileSizeSignal(Saved);

pub fn ignore_file_size_signal() -> FileSizeSignal {
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = libc::SIG_IGN;
    unsafe { libc::sigemptyset(&mut action.sa_mask) };
    let mut previous: libc::sigaction = unsafe { std::mem::zeroed() };
    unsafe { libc::sigaction(libc::SIGXFSZ, &action, &mut previous) };
    FileSizeSignal(Saved {
        signal: libc::SIGXFSZ,
        action: previous,
    })
}

pub fn restore_file_size_signal(saved: &FileSizeSignal) {
    restore(std::slice::from_ref(&saved.0));
}

fn restore(saved: &[Saved]) {
    for entry in saved.iter().rev() {
        unsafe { libc::sigaction(entry.signal, &entry.action, std::ptr::null_mut()) };
    }
}

fn signal_set(signals: &[libc::c_int]) -> libc::sigset_t {
    let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
    unsafe { libc::sigemptyset(&mut set) };
    for signal in signals {
        unsafe { libc::sigaddset(&mut set, *signal) };
    }
    set
}

#[cfg(target_os = "macos")]
fn environment() -> *const *mut libc::c_char {
    unsafe { *libc::_NSGetEnviron() as *const *mut libc::c_char }
}

#[cfg(not(target_os = "macos"))]
fn environment() -> *const *mut libc::c_char {
    extern "C" {
        static environ: *const *mut libc::c_char;
    }
    unsafe { environ }
}

fn read_by_runtime(entry: &[u8]) -> bool {
    let name = entry.split(|byte| *byte == b'=').next().unwrap_or(entry);
    RUNTIME_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
        || RUNTIME_PREFIXES_ANY_CASE
            .iter()
            .any(|prefix| name.len() >= prefix.len() && name[..prefix.len()].eq_ignore_ascii_case(prefix))
}

fn child_environment() -> Vec<*mut libc::c_char> {
    let mut kept = Vec::new();
    let mut at = environment();
    if !at.is_null() {
        loop {
            let entry = unsafe { *at };
            if entry.is_null() {
                break;
            }
            if !read_by_runtime(unsafe { std::ffi::CStr::from_ptr(entry) }.to_bytes()) {
                kept.push(entry);
            }
            at = unsafe { at.add(1) };
        }
    }
    kept.push(std::ptr::null_mut());
    kept
}

fn words(program: &Path, marker: &str, argv: &[OsString]) -> Option<Vec<CString>> {
    let mut words = vec![CString::new(program.as_os_str().as_bytes()).ok()?, CString::new(marker).ok()?];
    for word in argv {
        words.push(CString::new(word.as_bytes()).ok()?);
    }
    Some(words)
}

fn spawn(words: &[CString], mask: &libc::sigset_t) -> Option<libc::pid_t> {
    let mut pointers: Vec<*mut libc::c_char> = words.iter().map(|word| word.as_ptr() as *mut libc::c_char).collect();
    pointers.push(std::ptr::null_mut());
    let defaults = signal_set(&[libc::SIGPIPE]);
    let mut attributes: libc::posix_spawnattr_t = unsafe { std::mem::zeroed() };
    if unsafe { libc::posix_spawnattr_init(&mut attributes) } != 0 {
        return None;
    }
    let flags = (libc::POSIX_SPAWN_SETSIGMASK | libc::POSIX_SPAWN_SETSIGDEF) as libc::c_short;
    let mut pid: libc::pid_t = 0;
    let environment = child_environment();
    let spawned = unsafe {
        libc::posix_spawnattr_setsigmask(&mut attributes, mask) == 0
            && libc::posix_spawnattr_setsigdefault(&mut attributes, &defaults) == 0
            && libc::posix_spawnattr_setflags(&mut attributes, flags) == 0
            && libc::posix_spawn(&mut pid, pointers[0], std::ptr::null(), &attributes, pointers.as_ptr(), environment.as_ptr()) == 0
    };
    unsafe { libc::posix_spawnattr_destroy(&mut attributes) };
    spawned.then_some(pid)
}

fn wait(pid: libc::pid_t) -> Ended {
    loop {
        let mut status = 0;
        let done = unsafe { libc::waitpid(pid, &mut status, 0) };
        if done == pid {
            if libc::WIFSIGNALED(status) {
                return Ended::Signaled(libc::WTERMSIG(status));
            }
            if libc::WIFEXITED(status) {
                return Ended::Exited(libc::WEXITSTATUS(status));
            }
            continue;
        }
        if done < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return Ended::Exited(1);
        }
    }
}

pub fn run_child(program: &Path, marker: impl FnOnce(libc::c_int) -> String, argv: &[OsString]) -> Ended {
    let Some(lifeline) = lifeline() else {
        return Ended::NotStarted;
    };
    let Some(words) = words(program, &marker(lifeline.child_end.as_raw_fd()), argv) else {
        return Ended::NotStarted;
    };
    let blocked = signal_set(&FORWARDED);
    let mut original: libc::sigset_t = unsafe { std::mem::zeroed() };
    unsafe { libc::sigprocmask(libc::SIG_BLOCK, &blocked, &mut original) };
    let children = set_handler(libc::SIGCHLD, libc::SIG_DFL);
    let Some(pid) = spawn(&words, &original) else {
        restore(&[children]);
        unsafe { libc::sigprocmask(libc::SIG_SETMASK, &original, std::ptr::null_mut()) };
        return Ended::NotStarted;
    };
    drop(lifeline.child_end);
    CHILD.store(pid, Ordering::SeqCst);
    let handler: extern "C" fn(libc::c_int) = forward;
    let mut saved = vec![children];
    for signal in FORWARDED {
        if disposition(signal) == libc::SIG_DFL {
            saved.push(set_handler(signal, handler as libc::sighandler_t));
        }
    }
    unsafe { libc::sigprocmask(libc::SIG_SETMASK, &original, std::ptr::null_mut()) };
    let ended = wait(pid);
    unsafe { libc::sigprocmask(libc::SIG_BLOCK, &blocked, std::ptr::null_mut()) };
    CHILD.store(0, Ordering::SeqCst);
    restore(&saved);
    unsafe { libc::sigprocmask(libc::SIG_SETMASK, &original, std::ptr::null_mut()) };
    drop(lifeline.kept);
    ended
}

pub fn die_by(signal: libc::c_int) -> i32 {
    unsafe {
        libc::signal(signal, libc::SIG_DFL);
        let only = signal_set(&[signal]);
        libc::sigprocmask(libc::SIG_UNBLOCK, &only, std::ptr::null_mut());
        libc::raise(signal);
    }
    128 + signal
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_runtime_variables_are_kept_from_the_child() {
        for entry in [
            &b"BUN_BE_BUN=1"[..],
            b"BUN_OPTIONS=--print 7",
            b"NODE_OPTIONS=",
            b"JSC_useJIT=0",
            b"UV_THREADPOOL_SIZE=1",
            b"MIMALLOC_VERBOSE=1",
            b"mimalloc_verbose=1",
            b"MiMalloc_Show_Stats=1",
            b"BUN_",
        ] {
            assert!(read_by_runtime(entry), "{entry:?}");
        }
        for entry in [
            &b"HOME=/x"[..],
            b"ARDIA_DATA_DIR=BUN_X",
            b"XBUN_BE_BUN=1",
            b"bun_be_bun=1",
            b"jsc_useJIT=0",
            b"node_options=x",
            b"MIMALLOC=1",
            b"XMIMALLOC_VERBOSE=1",
            b"PATH=/bin",
            b"NODE",
        ] {
            assert!(!read_by_runtime(entry), "{entry:?}");
        }
    }

    #[test]
    fn reads_the_table_strictly() {
        let table = Table::parse("tabs ts\n\n  windows   rust \n").unwrap();
        assert_eq!(table.side("tabs"), Some(Side::Ts));
        assert_eq!(table.side("windows"), Some(Side::Rust));
        assert_eq!(table.side("groups"), None);
        for body in ["tabs\n", "tabs go\n", "tabs rust\ntabs ts\n", "tabs rust extra\n", "tabs Rust\n"] {
            assert_eq!(Table::parse(body), None, "{body:?}");
        }
        assert_eq!(Table::parse(""), Some(Table(Vec::new())));
    }

    #[test]
    fn a_label_may_name_a_subcommand() {
        let table = Table::parse("scripts list ts\nscripts  new   ts\n").unwrap();
        assert_eq!(table.side("scripts list"), Some(Side::Ts));
        assert_eq!(table.side("scripts new"), Some(Side::Ts));
        assert_eq!(table.side("scripts"), None);
        assert_eq!(Table::parse("scripts list ts\nscripts list rust\n"), None);
    }

    #[test]
    fn the_compiled_table_is_valid() {
        assert_eq!(Table::parse(COMPILED), Some(Table::compiled()));
        assert!(Table::compiled().side("windows").is_some());
    }

    #[test]
    fn an_invalid_file_falls_back_to_the_compiled_table() {
        let dir = std::env::temp_dir().join(format!("ardia-router-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("served.txt"), "windows ts\ntabs go\n").unwrap();
        assert_eq!(Table::load(Some(&dir)), Table::compiled());
        std::fs::write(dir.join("served.txt"), "windows ts\n").unwrap();
        assert_eq!(Table::load(Some(&dir)).side("windows"), Some(Side::Ts));
        assert_eq!(Table::load(Some(&dir)).side("tabs"), None);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(Table::load(Some(&dir)), Table::compiled());
    }

    #[test]
    fn a_table_that_is_not_a_regular_file_falls_back_without_blocking() {
        let dir = std::env::temp_dir().join(format!("ardia-router-fifo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let table = dir.join("served.txt");
        let name = CString::new(table.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let (sender, receiver) = std::sync::mpsc::channel();
        let place = dir.clone();
        std::thread::spawn(move || sender.send(Table::load(Some(&place))).unwrap());
        let loaded = receiver.recv_timeout(std::time::Duration::from_secs(5));
        let _ = std::fs::OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK).open(&table);
        assert_eq!(loaded.ok(), Some(Table::compiled()));
        std::fs::remove_file(&table).unwrap();
        std::fs::write(dir.join("real.txt"), "windows ts\n").unwrap();
        std::os::unix::fs::symlink(dir.join("real.txt"), &table).unwrap();
        assert_eq!(Table::load(Some(&dir)), Table::compiled());
        std::fs::remove_file(&table).unwrap();
        std::fs::write(&table, format!("windows ts\n{}", " ".repeat(TABLE_LIMIT as usize))).unwrap();
        assert_eq!(Table::load(Some(&dir)), Table::compiled());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_marker_carries_the_interrupt_state_and_the_caller_as_hex() {
        let caller = Caller {
            name: "Claude Code".into(),
            app: Some("/Applications/É.app".into()),
        };
        let routed = marker(true, 7, &caller);
        let rest = routed.strip_prefix("--ardia-routed=2:1:7:").unwrap();
        let bytes: Vec<u8> = (0..rest.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&rest[at..at + 2], 16).unwrap())
            .collect();
        assert_eq!(String::from_utf8(bytes).unwrap(), r#"{"name":"Claude Code","app":"/Applications/É.app"}"#);
        assert!(marker(false, 12, &caller).starts_with("--ardia-routed=2:0:12:"));
    }

    #[test]
    fn reports_how_the_child_ended() {
        let sh = Path::new("/bin/sh");
        let run = |script: &str| run_child(sh, |_| "-c".into(), &[OsString::from(script)]);
        assert_eq!(run("exit 7"), Ended::Exited(7));
        assert_eq!(run("kill -TERM $$"), Ended::Signaled(libc::SIGTERM));
        assert_eq!(run_child(Path::new("/nonexistent/ardia-ts"), |_| "-c".into(), &[]), Ended::NotStarted);
        let script = std::env::temp_dir().join(format!("ardia-lifeline-{}.sh", std::process::id()));
        let lifeline = |body: &str| {
            run_child(
                sh,
                |fd| {
                    std::fs::write(&script, body.replace("FD", &fd.to_string())).unwrap();
                    script.display().to_string()
                },
                &[],
            )
        };
        assert_eq!(lifeline("[ -p /dev/fd/FD ] && [ FD -ge 3 ] && exit 4"), Ended::Exited(4));
        std::fs::remove_file(&script).unwrap();
    }
}
