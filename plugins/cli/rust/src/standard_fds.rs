use std::sync::atomic::{AtomicU8, Ordering};

static CLOSED: AtomicU8 = AtomicU8::new(0);

pub extern "C" fn note() {
    let mut closed = 0;
    for fd in 0..3 {
        if unsafe { libc::fcntl(fd, libc::F_GETFD) } < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EBADF) {
            closed |= 1 << fd;
        }
    }
    CLOSED.store(closed, Ordering::SeqCst);
}

pub fn any_closed_at_start() -> bool {
    CLOSED.load(Ordering::SeqCst) != 0
}

pub fn close_those_closed_at_start() {
    let closed = CLOSED.load(Ordering::SeqCst);
    for fd in 0..3 {
        if closed & (1 << fd) != 0 {
            unsafe { libc::close(fd) };
        }
    }
}
