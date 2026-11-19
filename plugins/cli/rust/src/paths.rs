use std::ffi::{CStr, CString, OsStr};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub const LINUX: bool = cfg!(target_os = "linux");

pub fn env(name: &str) -> Option<String> {
    std::env::var_os(name).map(|value| value.to_string_lossy().into_owned())
}

pub fn env_set(name: &str) -> Option<String> {
    env(name).filter(|value| !value.is_empty())
}

pub fn uid() -> u32 {
    unsafe { libc::getuid() }
}

pub fn strerror(code: i32) -> String {
    unsafe { CStr::from_ptr(libc::strerror(code)).to_string_lossy().into_owned() }
}

fn passwd_home(name: Option<&str>) -> Option<String> {
    unsafe {
        let entry = match name {
            Some(name) => {
                let name = CString::new(name).ok()?;
                libc::getpwnam(name.as_ptr())
            }
            None => libc::getpwuid(libc::getuid()),
        };
        if entry.is_null() || (*entry).pw_dir.is_null() {
            return None;
        }
        Some(CStr::from_ptr((*entry).pw_dir).to_string_lossy().into_owned())
    }
}

const PATH_VARIABLES: &[&str] = &["ARDIA_DATA_DIR", "HOME", "ARDIA_CLI_HOME", "ARDIA_CONFIG_HOME", "XDG_CONFIG_HOME"];

pub fn paths_are_text() -> bool {
    let variables = PATH_VARIABLES
        .iter()
        .all(|name| std::env::var_os(name).is_none_or(|value| value.to_str().is_some()));
    let cwd = std::env::current_dir().map_or(true, |dir| dir.to_str().is_some());
    let account_home = std::env::var_os("HOME").is_some() || passwd_home_bytes().is_none_or(|bytes| std::str::from_utf8(&bytes).is_ok());
    variables && cwd && account_home
}

fn passwd_home_bytes() -> Option<Vec<u8>> {
    unsafe {
        let entry = libc::getpwuid(libc::getuid());
        if entry.is_null() || (*entry).pw_dir.is_null() {
            return None;
        }
        Some(CStr::from_ptr((*entry).pw_dir).to_bytes().to_vec())
    }
}

pub fn home() -> PathBuf {
    PathBuf::from(env("HOME").or_else(|| passwd_home(None)).unwrap_or_default())
}

pub fn expand_user(text: &str) -> String {
    if !text.starts_with('~') {
        return text.to_string();
    }
    let (user, rest) = match text.find('/') {
        Some(slash) => (&text[1..slash], &text[slash..]),
        None => (&text[1..], ""),
    };
    let base = if user.is_empty() {
        env("HOME").or_else(|| passwd_home(None))
    } else {
        passwd_home(Some(user))
    };
    match base {
        Some(base) => {
            let base = if base.len() > 1 { base.trim_end_matches('/').to_string() } else { base };
            let joined = format!("{base}{rest}");
            if joined.is_empty() {
                "/".to_string()
            } else {
                joined
            }
        }
        None => text.to_string(),
    }
}

pub fn pure_path(text: &str) -> String {
    if text.is_empty() {
        return ".".to_string();
    }
    let root = if text.starts_with("//") && !text.starts_with("///") {
        "//"
    } else if text.starts_with('/') {
        "/"
    } else {
        ""
    };
    let parts: Vec<&str> = text.split('/').filter(|part| !part.is_empty() && *part != ".").collect();
    let joined = format!("{root}{}", parts.join("/"));
    if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

pub fn abspath(path: &Path) -> String {
    let text = path.to_string_lossy();
    let full = if text.starts_with('/') {
        text.into_owned()
    } else {
        let cwd = std::env::current_dir().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default();
        format!("{cwd}/{text}")
    };
    normpath(&full)
}

pub fn normpath(text: &str) -> String {
    let root = if text.starts_with("//") && !text.starts_with("///") {
        "//"
    } else if text.starts_with('/') {
        "/"
    } else {
        ""
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in text.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if root.is_empty() {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let joined = format!("{root}{}", parts.join("/"));
    if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

pub fn realpath(text: &str) -> String {
    let absolute = if text.starts_with('/') {
        text.to_string()
    } else {
        format!(
            "{}/{text}",
            std::env::current_dir().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default()
        )
    };
    let mut pending: Vec<String> = absolute.split('/').filter(|part| !part.is_empty()).rev().map(str::to_string).collect();
    let mut resolved = PathBuf::from("/");
    let mut hops = 0;
    while let Some(part) = pending.pop() {
        if part == "." {
            continue;
        }
        if part == ".." {
            resolved.pop();
            continue;
        }
        let next = resolved.join(&part);
        match std::fs::read_link(&next) {
            Ok(target) if hops < 40 => {
                hops += 1;
                if target.is_absolute() {
                    resolved = PathBuf::from("/");
                }
                let target = target.to_string_lossy().into_owned();
                pending.extend(target.split('/').filter(|piece| !piece.is_empty()).rev().map(str::to_string));
            }
            _ => resolved = next,
        }
    }
    resolved.to_string_lossy().into_owned()
}

pub fn cstring(path: &Path) -> io::Result<CString> {
    CString::new(path.as_os_str().as_bytes()).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))
}

fn cname(name: &str) -> io::Result<CString> {
    CString::new(name).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))
}

fn check(result: libc::c_int) -> io::Result<libc::c_int> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result)
    }
}

pub fn open(path: &Path, flags: libc::c_int) -> io::Result<OwnedFd> {
    let path = cstring(path)?;
    let fd = check(unsafe { libc::open(path.as_ptr(), flags | libc::O_CLOEXEC) })?;
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

pub fn openat(dir: &OwnedFd, name: &str, flags: libc::c_int, mode: libc::mode_t) -> io::Result<OwnedFd> {
    let name = cname(name)?;
    let fd = check(unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags | libc::O_CLOEXEC, libc::c_uint::from(mode)) })?;
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

pub fn metadata(fd: &OwnedFd) -> io::Result<std::fs::Metadata> {
    let file = std::mem::ManuallyDrop::new(unsafe { std::fs::File::from_raw_fd(fd.as_raw_fd()) });
    file.metadata()
}

pub fn read_fd(fd: &OwnedFd, limit: usize) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut buffer = [0u8; 65536];
    while out.len() < limit {
        let want = (limit - out.len()).min(buffer.len());
        let got = unsafe { libc::read(fd.as_raw_fd(), buffer.as_mut_ptr().cast(), want) };
        if got < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if got == 0 {
            break;
        }
        out.extend_from_slice(&buffer[..got as usize]);
    }
    Ok(out)
}

pub fn write_fd(fd: &OwnedFd, mut data: &[u8]) -> io::Result<()> {
    while !data.is_empty() {
        let wrote = unsafe { libc::write(fd.as_raw_fd(), data.as_ptr().cast(), data.len()) };
        if wrote < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        data = &data[wrote as usize..];
    }
    Ok(())
}

#[derive(Debug)]
pub struct PathError;

pub enum Failure {
    Io(io::Error),
    Path(PathError),
}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Failure {
        Failure::Io(error)
    }
}

impl From<PathError> for Failure {
    fn from(error: PathError) -> Failure {
        Failure::Path(error)
    }
}

impl Failure {
    pub fn not_found(&self) -> bool {
        matches!(self, Failure::Io(error) if error.kind() == io::ErrorKind::NotFound)
    }
}

fn open_dir(dir: Option<&OwnedFd>, name: &str) -> Result<OwnedFd, Failure> {
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW;
    let opened = match dir {
        Some(dir) => openat(dir, name, flags, 0),
        None => open(Path::new(name), flags),
    };
    opened.map_err(|error| match error.raw_os_error() {
        Some(libc::ELOOP | libc::ENOTDIR) => Failure::Path(PathError),
        _ => Failure::Io(error),
    })
}

fn check_private_dir(fd: &OwnedFd) -> Result<(), Failure> {
    let info = metadata(fd)?;
    if !info.is_dir() || info.uid() != uid() || info.permissions().mode() & 0o077 != 0 {
        return Err(Failure::Path(PathError));
    }
    Ok(())
}

fn mkdirat(dir: &OwnedFd, name: &str, mode: libc::mode_t) -> io::Result<()> {
    let name = cname(name)?;
    match check(unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), mode) }) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn open_private(root: &Path, parts: &[&str], create: bool) -> Result<OwnedFd, Failure> {
    let mut fd = match open_dir(None, &root.to_string_lossy()) {
        Err(error) if error.not_found() => return Err(Failure::Path(PathError)),
        other => other?,
    };
    if metadata(&fd)?.uid() != uid() {
        return Err(Failure::Path(PathError));
    }
    for part in parts {
        if create {
            mkdirat(&fd, part, 0o700)?;
        }
        let child = open_dir(Some(&fd), part)?;
        fd = child;
        check_private_dir(&fd)?;
    }
    Ok(fd)
}

pub fn open_child_dir(dir: &OwnedFd, name: &str, check_mode: bool) -> Result<OwnedFd, Failure> {
    mkdirat(dir, name, 0o700)?;
    let fd = openat(dir, name, libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW, 0)?;
    let info = metadata(&fd)?;
    let mode_ok = if check_mode { info.permissions().mode() & 0o022 == 0 } else { true };
    if !info.is_dir() || info.uid() != uid() || !mode_ok {
        return Err(Failure::Path(PathError));
    }
    Ok(fd)
}

fn waiting_fifo(dir: &OwnedFd, name: &str) -> bool {
    let Ok(name) = cname(name) else { return false };
    let mut found: libc::stat = unsafe { std::mem::zeroed() };
    unsafe { libc::fstatat(dir.as_raw_fd(), name.as_ptr(), &mut found, libc::AT_SYMLINK_NOFOLLOW) == 0 && found.st_mode & libc::S_IFMT == libc::S_IFIFO }
}

fn open_regular(name: &str, dir: &OwnedFd, flags: libc::c_int) -> Result<OwnedFd, Failure> {
    let fd = match openat(dir, name, flags | libc::O_NOFOLLOW | libc::O_NONBLOCK, 0o600) {
        Err(error) if error.raw_os_error() == Some(libc::ENXIO) && waiting_fifo(dir, name) => return Err(Failure::Path(PathError)),
        other => other?,
    };
    if !metadata(&fd)?.is_file() {
        return Err(Failure::Path(PathError));
    }
    let now = check(unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) })?;
    check(unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, now & !libc::O_NONBLOCK) })?;
    Ok(fd)
}

pub fn open_private_file(name: &str, dir: &OwnedFd, flags: libc::c_int) -> Result<OwnedFd, Failure> {
    let mut retries = if flags & libc::O_CREAT != 0 { 4 } else { 0 };
    let fd = loop {
        match open_regular(name, dir, flags) {
            Err(error) if error.not_found() && retries > 0 => retries -= 1,
            other => break other?,
        }
    };
    let info = metadata(&fd)?;
    if info.uid() != uid() {
        return Err(Failure::Path(PathError));
    }
    if info.permissions().mode() & 0o077 != 0 {
        unsafe { libc::fchmod(fd.as_raw_fd(), 0o600) };
    }
    Ok(fd)
}

pub fn take_lock(name: &str, dir: &OwnedFd) -> Result<Option<OwnedFd>, Failure> {
    let fd = open_private_file(name, dir, libc::O_RDWR | libc::O_CREAT)?;
    if unsafe { libc::flock(fd.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(fd));
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
        return Ok(None);
    }
    Err(Failure::Io(error))
}

pub fn take_lock_retrying(name: &str, dir: &OwnedFd) -> Result<Option<OwnedFd>, Failure> {
    for attempt in 0..5 {
        if let Some(lock) = take_lock(name, dir)? {
            return Ok(Some(lock));
        }
        if attempt < 4 {
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }
    Ok(None)
}

pub fn unlink_quietly(name: &str, dir: &OwnedFd) {
    if let Ok(name) = cname(name) {
        unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) };
    }
}

pub fn rename_in(dir: &OwnedFd, from: &str, to: &str) -> io::Result<()> {
    let from = cname(from)?;
    let to = cname(to)?;
    check(unsafe { libc::renameat(dir.as_raw_fd(), from.as_ptr(), dir.as_raw_fd(), to.as_ptr()) }).map(|_| ())
}

pub fn size_at(dir: &OwnedFd, name: &str) -> io::Result<u64> {
    let name = cname(name)?;
    let mut info: libc::stat = unsafe { std::mem::zeroed() };
    check(unsafe { libc::fstatat(dir.as_raw_fd(), name.as_ptr(), &mut info, libc::AT_SYMLINK_NOFOLLOW) })?;
    Ok(info.st_size as u64)
}

pub fn list_dir(dir: &OwnedFd) -> io::Result<Vec<String>> {
    let copy = check(unsafe { libc::fcntl(dir.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) })?;
    let stream = unsafe { libc::fdopendir(copy) };
    if stream.is_null() {
        let error = io::Error::last_os_error();
        unsafe { libc::close(copy) };
        return Err(error);
    }
    let mut names = Vec::new();
    let failure = loop {
        unsafe { *errno_location() = 0 };
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            let error = io::Error::last_os_error();
            break (error.raw_os_error() != Some(0)).then_some(error);
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        let name = OsStr::from_bytes(name.to_bytes()).to_string_lossy().into_owned();
        if name != "." && name != ".." {
            names.push(name);
        }
    };
    unsafe {
        libc::rewinddir(stream);
        libc::closedir(stream);
    }
    failure.map_or(Ok(names), Err)
}

#[cfg(target_os = "macos")]
fn errno_location() -> *mut libc::c_int {
    unsafe { libc::__error() }
}

#[cfg(not(target_os = "macos"))]
fn errno_location() -> *mut libc::c_int {
    unsafe { libc::__errno_location() }
}

pub fn write_private(name: &str, dir: &OwnedFd, data: &[u8]) -> Result<(), Failure> {
    let temp = format!(".{name}.{}.tmp", std::process::id());
    let fd = open_private_file(&temp, dir, libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC)?;
    write_fd(&fd, data)?;
    drop(fd);
    rename_in(dir, &temp, name)?;
    Ok(())
}

pub fn read_private(name: &str, dir: &OwnedFd, limit: usize) -> Result<Option<Vec<u8>>, Failure> {
    let fd = match open_private_file(name, dir, libc::O_RDONLY) {
        Err(error) if error.not_found() => return Ok(None),
        other => other?,
    };
    let raw = read_fd(&fd, limit + 1)?;
    if raw.len() > limit {
        return Err(Failure::Path(PathError));
    }
    Ok(Some(raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_normalize_like_python() {
        assert_eq!(pure_path("a//b/./c/"), "a/b/c");
        assert_eq!(pure_path("//x"), "//x");
        assert_eq!(pure_path("///x"), "/x");
        assert_eq!(pure_path("./"), ".");
        assert_eq!(normpath("/a/b/../c/./"), "/a/c");
        assert_eq!(normpath("a/../../b"), "../b");
        assert_eq!(normpath("/../a"), "/a");
    }

    #[test]
    fn resolves_links_before_parent_steps_like_posixpath() {
        let base = std::env::temp_dir().join(format!("ardia-realpath-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("srv/a/b")).unwrap();
        std::fs::create_dir_all(base.join("rp")).unwrap();
        std::os::unix::fs::symlink(base.join("srv/a/b"), base.join("rp/link")).unwrap();
        std::os::unix::fs::symlink("../srv/a/b", base.join("rp/relative")).unwrap();
        let real = std::fs::canonicalize(&base).unwrap().to_string_lossy().into_owned();
        let found = (
            realpath(&format!("{}/rp/link/../data", base.display())),
            realpath(&format!("{}/rp/relative/../../a/./b/..//missing/..", base.display())),
        );
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(found.0, format!("{real}/srv/a/data"));
        assert_eq!(found.1, format!("{real}/srv/a"));
    }

    #[test]
    fn expands_the_home_folder() {
        let home = env("HOME").unwrap_or_default();
        assert_eq!(expand_user("~/x"), format!("{}/x", home.trim_end_matches('/')));
        assert_eq!(expand_user("a/~"), "a/~");
        assert_eq!(expand_user("~no-such-user-here/x"), "~no-such-user-here/x");
    }

    #[test]
    fn listing_leaves_the_folder_descriptor_where_it_was() {
        use std::os::fd::FromRawFd;
        let dir = std::env::temp_dir().join(format!("ardia-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["a", "b", "c"] {
            std::fs::write(dir.join(name), "").unwrap();
        }
        let path = CString::new(dir.to_str().unwrap()).unwrap();
        let fd = unsafe { OwnedFd::from_raw_fd(libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY)) };
        let mut names = list_dir(&fd).unwrap();
        names.sort();
        let offset = unsafe { libc::lseek(fd.as_raw_fd(), 0, libc::SEEK_CUR) };
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(names, ["a", "b", "c"]);
        assert_eq!(offset, 0);
    }

    fn folder_opened_before_its_files(tag: &str) -> (PathBuf, OwnedFd) {
        use std::os::fd::FromRawFd;
        let dir = std::env::temp_dir().join(format!("ardia-list-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("before"), "").unwrap();
        let path = CString::new(dir.to_str().unwrap()).unwrap();
        let fd = unsafe { OwnedFd::from_raw_fd(libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)) };
        for name in ["after-1", "after-2"] {
            std::fs::write(dir.join(name), "").unwrap();
        }
        (dir, fd)
    }

    #[test]
    fn lists_what_python_lists_in_a_folder_opened_before_its_files() {
        use std::os::unix::process::CommandExt;
        let python = std::env::var("ARDIA_TEST_PYTHON").unwrap_or_else(|_| "python3".into());
        let (theirs, their_fd) = folder_opened_before_its_files("python");
        let (mine, my_fd) = folder_opened_before_its_files("rust");
        let raw = their_fd.as_raw_fd();
        let script = "import json, os; names = sorted(os.listdir(3)); print(json.dumps([names, os.lseek(3, 0, os.SEEK_CUR)]))";
        let mut command = std::process::Command::new(&python);
        command.args(["-I", "-c", script]);
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(raw, 3) == 3 && libc::fcntl(3, libc::F_SETFD, 0) == 0 {
                    Ok(())
                } else {
                    Err(io::Error::last_os_error())
                }
            });
        }
        let python_saw = command.output().unwrap();
        assert!(python_saw.status.success(), "{}", String::from_utf8_lossy(&python_saw.stderr));
        let mut names = list_dir(&my_fd).unwrap();
        names.sort();
        let offset = unsafe { libc::lseek(my_fd.as_raw_fd(), 0, libc::SEEK_CUR) };
        std::fs::remove_dir_all(&theirs).unwrap();
        std::fs::remove_dir_all(&mine).unwrap();
        let ours = format!("[{names:?}, {offset}]\n");
        assert_eq!(String::from_utf8_lossy(&python_saw.stdout), ours);
    }
}
