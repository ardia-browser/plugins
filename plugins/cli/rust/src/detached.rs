use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

pub const DESCRIPTOR_SCAN_CAP: libc::c_int = 1 << 20;

pub fn mark_close_on_exec_by_scan(from: libc::c_int) {
    let mut limit: libc::rlimit = unsafe { std::mem::zeroed() };
    let highest = if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } == 0
        && limit.rlim_max != libc::RLIM_INFINITY
        && limit.rlim_max < DESCRIPTOR_SCAN_CAP as libc::rlim_t
    {
        limit.rlim_max as libc::c_int
    } else {
        DESCRIPTOR_SCAN_CAP
    };
    for fd in from..highest {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags >= 0 && flags & libc::FD_CLOEXEC == 0 {
            unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) };
        }
    }
}

fn c_string(bytes: &[u8]) -> Option<CString> {
    CString::new(bytes).ok()
}

pub fn spawn_with_input(program: &Path, args: &[&str], input: &[u8]) {
    let Some(program) = c_string(program.as_os_str().as_bytes()) else { return };
    let Some(argv) = std::iter::once(Some(program.clone()))
        .chain(args.iter().map(|arg| c_string(arg.as_bytes())))
        .collect::<Option<Vec<CString>>>()
    else {
        return;
    };
    platform::spawn_with_input(&program, &argv, input);
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::CString;
    use std::io::Write;
    use std::os::fd::FromRawFd;

    const POSIX_SPAWN_SETSID: libc::c_int = 0x0400;

    fn pipe_for_input() -> Option<(libc::c_int, libc::c_int)> {
        let mut ends = [0; 2];
        if unsafe { libc::pipe(ends.as_mut_ptr()) } != 0 {
            return None;
        }
        for fd in ends {
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
        }
        Some((ends[0], ends[1]))
    }

    unsafe fn spawn(program: &CString, argv: &[CString], stdin: libc::c_int) -> bool {
        let null = c"/dev/null";
        let root = c"/";
        let mut attributes: libc::posix_spawnattr_t = std::ptr::null_mut();
        let mut actions: libc::posix_spawn_file_actions_t = std::ptr::null_mut();
        if libc::posix_spawnattr_init(&mut attributes) != 0 {
            return false;
        }
        if libc::posix_spawn_file_actions_init(&mut actions) != 0 {
            libc::posix_spawnattr_destroy(&mut attributes);
            return false;
        }
        let mut defaults: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut defaults);
        libc::sigaddset(&mut defaults, libc::SIGPIPE);
        libc::sigaddset(&mut defaults, libc::SIGXFSZ);
        let mut mask: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut mask);
        let flags = libc::POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSID | libc::POSIX_SPAWN_SETSIGDEF | libc::POSIX_SPAWN_SETSIGMASK;
        let prepared = libc::posix_spawnattr_setflags(&mut attributes, flags as libc::c_short) == 0
            && libc::posix_spawnattr_setsigdefault(&mut attributes, &defaults) == 0
            && libc::posix_spawnattr_setsigmask(&mut attributes, &mask) == 0
            && libc::posix_spawn_file_actions_adddup2(&mut actions, stdin, 0) == 0
            && libc::posix_spawn_file_actions_addopen(&mut actions, 1, null.as_ptr(), libc::O_WRONLY, 0) == 0
            && libc::posix_spawn_file_actions_addopen(&mut actions, 2, null.as_ptr(), libc::O_WRONLY, 0) == 0
            && libc::posix_spawn_file_actions_addchdir_np(&mut actions, root.as_ptr()) == 0;
        let mut pointers: Vec<*mut libc::c_char> = argv.iter().map(|arg| arg.as_ptr().cast_mut()).collect();
        pointers.push(std::ptr::null_mut());
        let mut pid: libc::pid_t = 0;
        let started = prepared && libc::posix_spawn(&mut pid, program.as_ptr(), &actions, &attributes, pointers.as_ptr(), *libc::_NSGetEnviron()) == 0;
        libc::posix_spawn_file_actions_destroy(&mut actions);
        libc::posix_spawnattr_destroy(&mut attributes);
        started
    }

    pub fn spawn_with_input(program: &CString, argv: &[CString], input: &[u8]) {
        let Some((reader, writer)) = pipe_for_input() else { return };
        let started = unsafe { spawn(program, argv, reader) };
        unsafe { libc::close(reader) };
        let mut sink = unsafe { std::fs::File::from_raw_fd(writer) };
        if started {
            let _ = sink.write_all(input);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use std::ffi::{CString, OsStr};
    use std::io::Write;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    #[cfg(target_os = "linux")]
    fn mark_listed_close_on_exec(from: libc::c_int) -> bool {
        let listing = unsafe { libc::open(c"/proc/self/fd".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
        if listing < 0 {
            return false;
        }
        let mut buffer = [0u8; 1024];
        let mut seen = false;
        loop {
            let read = unsafe { libc::syscall(libc::SYS_getdents64, listing, buffer.as_mut_ptr(), buffer.len()) };
            if read <= 0 {
                break;
            }
            let mut at = 0usize;
            while at + 19 < read as usize {
                let length = u16::from_ne_bytes([buffer[at + 16], buffer[at + 17]]) as usize;
                if length == 0 {
                    break;
                }
                let mut fd: i64 = 0;
                let mut digits = 0;
                for &byte in buffer[at + 19..at + length].iter().take_while(|byte| **byte != 0) {
                    if !byte.is_ascii_digit() || fd > i32::MAX as i64 {
                        digits = 0;
                        break;
                    }
                    fd = fd * 10 + (byte - b'0') as i64;
                    digits += 1;
                }
                if digits > 0 {
                    seen = true;
                    let fd = fd as libc::c_int;
                    if fd >= from && fd != listing {
                        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
                        if flags >= 0 {
                            unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) };
                        }
                    }
                }
                at += length;
            }
        }
        unsafe { libc::close(listing) };
        seen
    }

    #[cfg(not(target_os = "linux"))]
    fn mark_listed_close_on_exec(_from: libc::c_int) -> bool {
        false
    }

    #[cfg(target_os = "linux")]
    fn close_range_from(from: libc::c_int) -> bool {
        let from = from as libc::c_uint;
        unsafe {
            libc::syscall(libc::SYS_close_range, from, libc::c_uint::MAX, libc::CLOSE_RANGE_CLOEXEC) == 0
                || libc::syscall(libc::SYS_close_range, from, libc::c_uint::MAX, 0 as libc::c_uint) == 0
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn close_range_from(_from: libc::c_int) -> bool {
        false
    }

    fn leave_nothing_inherited() {
        if !close_range_from(3) && !mark_listed_close_on_exec(3) {
            super::mark_close_on_exec_by_scan(3);
        }
    }

    pub fn spawn_with_input(program: &CString, argv: &[CString], input: &[u8]) {
        let mut command = Command::new(OsStr::from_bytes(program.as_bytes()));
        command
            .args(argv[1..].iter().map(|arg| OsStr::from_bytes(arg.as_bytes())))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .current_dir("/");
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                libc::signal(libc::SIGPIPE, libc::SIG_DFL);
                libc::signal(libc::SIGXFSZ, libc::SIG_DFL);
                leave_nothing_inherited();
                Ok(())
            });
        }
        if let Ok(mut child) = command.spawn() {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(input);
            }
        }
    }
}

