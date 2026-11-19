#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdatomic.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/syscall.h>
#endif
#if defined(__APPLE__)
#include <sys/ucred.h>
#include <sys/un.h>
#endif

#ifndef SRC_JS_NATIVE_API_TYPES_H_
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef int napi_status;
typedef int napi_valuetype;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);
#define napi_ok 0
#define napi_number 3
#define napi_bigint 9
#endif
#ifndef NAPI_AUTO_LENGTH
#define NAPI_AUTO_LENGTH SIZE_MAX
#endif

napi_status napi_get_cb_info(napi_env env, napi_callback_info cbinfo, size_t *argc, napi_value *argv, napi_value *this_arg, void **data);
napi_status napi_typeof(napi_env env, napi_value value, napi_valuetype *result);
napi_status napi_get_value_double(napi_env env, napi_value value, double *result);
napi_status napi_throw_type_error(napi_env env, const char *code, const char *msg);
napi_status napi_throw_range_error(napi_env env, const char *code, const char *msg);
napi_status napi_get_value_bool(napi_env env, napi_value value, bool *result);
napi_status napi_get_value_string_utf8(napi_env env, napi_value value, char *buf, size_t bufsize, size_t *result);
napi_status napi_create_int32(napi_env env, int32_t value, napi_value *result);
napi_status napi_create_double(napi_env env, double value, napi_value *result);
napi_status napi_create_bigint_uint64(napi_env env, uint64_t value, napi_value *result);
napi_status napi_get_value_bigint_uint64(napi_env env, napi_value value, uint64_t *result, bool *lossless);
napi_status napi_get_boolean(napi_env env, bool value, napi_value *result);
napi_status napi_get_null(napi_env env, napi_value *result);
napi_status napi_create_string_utf8(napi_env env, const char *str, size_t length, napi_value *result);
napi_status napi_create_array(napi_env env, napi_value *result);
napi_status napi_is_buffer(napi_env env, napi_value value, bool *result);
napi_status napi_get_buffer_info(napi_env env, napi_value value, void **data, size_t *length);
napi_status napi_create_buffer_copy(napi_env env, size_t length, const void *data, void **result_data, napi_value *result);
napi_status napi_set_element(napi_env env, napi_value object, uint32_t index, napi_value value);
napi_status napi_create_function(napi_env env, const char *utf8name, size_t length, napi_callback cb, void *data, napi_value *result);
napi_status napi_set_named_property(napi_env env, napi_value object, const char *utf8name, napi_value value);

#define MAX_ARGS 8

typedef struct {
  napi_env env;
  napi_value argv[MAX_ARGS];
  size_t argc;
} Call;

static bool take_args(napi_env env, napi_callback_info info, size_t wanted, Call *call) {
  call->env = env;
  call->argc = MAX_ARGS;
  if (napi_get_cb_info(env, info, &call->argc, call->argv, NULL, NULL) != napi_ok) return false;
  return call->argc >= wanted;
}

static bool int_arg(Call *call, size_t index, int32_t *out) {
  napi_valuetype type;
  double value = 0;
  if (napi_typeof(call->env, call->argv[index], &type) != napi_ok || type != napi_number
      || napi_get_value_double(call->env, call->argv[index], &value) != napi_ok) {
    napi_throw_type_error(call->env, NULL, "ardia-libc: expected an integer");
    return false;
  }
  if (!isfinite(value) || value < INT32_MIN || value > INT32_MAX || value != trunc(value)) {
    napi_throw_range_error(call->env, NULL, "ardia-libc: expected a 32-bit integer");
    return false;
  }
  *out = (int32_t)value;
  return true;
}

static bool bool_arg(Call *call, size_t index, bool *out) {
  if (napi_get_value_bool(call->env, call->argv[index], out) == napi_ok) return true;
  napi_throw_type_error(call->env, NULL, "ardia-libc: expected a boolean");
  return false;
}

static int name_arg(Call *call, size_t index, char *buffer, size_t size) {
  size_t length = 0;
  bool is_buffer = false;
  if (napi_is_buffer(call->env, call->argv[index], &is_buffer) == napi_ok && is_buffer) {
    void *data = NULL;
    if (napi_get_buffer_info(call->env, call->argv[index], &data, &length) != napi_ok) return -EINVAL;
    if (length == 0) return -ENOENT;
    if (length >= size) return -ENAMETOOLONG;
    if (memchr(data, 0, length) != NULL) return -EINVAL;
    memcpy(buffer, data, length);
    buffer[length] = 0;
    return 0;
  }
  if (napi_get_value_string_utf8(call->env, call->argv[index], NULL, 0, &length) != napi_ok) return -EINVAL;
  if (length == 0) return -ENOENT;
  if (length >= size) return -ENAMETOOLONG;
  if (napi_get_value_string_utf8(call->env, call->argv[index], buffer, size, &length) != napi_ok) return -EINVAL;
  if (strlen(buffer) != length) return -EINVAL;
  return 0;
}

static napi_value number(napi_env env, double value) {
  napi_value result = NULL;
  napi_create_double(env, value, &result);
  return result;
}

static napi_value status(napi_env env, int value) {
  napi_value result = NULL;
  napi_create_int32(env, value, &result);
  return result;
}

static napi_value owned_fd(napi_env env, int fd) {
  napi_value result = NULL;
  if (napi_create_int32(env, fd, &result) == napi_ok) return result;
  close(fd);
  return NULL;
}

static int failed(void) {
  return errno > 0 ? -errno : -EIO;
}

static napi_value peer_uid(napi_env env, napi_callback_info info) {
  Call call;
  int32_t fd;
  if (!take_args(env, info, 1, &call)) return status(env, -EINVAL);
  if (!int_arg(&call, 0, &fd)) return NULL;
#if defined(__APPLE__)
  struct xucred credentials;
  socklen_t size = sizeof(credentials);
  memset(&credentials, 0, sizeof(credentials));
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, &credentials, &size) != 0) return status(env, failed());
  if (size < offsetof(struct xucred, cr_ngroups) || credentials.cr_version != XUCRED_VERSION) return status(env, -EPROTO);
  return number(env, (double)credentials.cr_uid);
#else
  struct ucred credentials;
  socklen_t size = sizeof(credentials);
  memset(&credentials, 0, sizeof(credentials));
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &size) != 0) return status(env, failed());
  if (size < sizeof(credentials)) return status(env, -EPROTO);
  return number(env, (double)credentials.uid);
#endif
}

static napi_value interrupts_ignored(napi_env env, napi_callback_info info) {
  struct sigaction current;
  napi_value result = NULL;
  (void)info;
  memset(&current, 0, sizeof(current));
  if (sigaction(SIGINT, NULL, &current) != 0) return status(env, failed());
  napi_get_boolean(env, current.sa_handler == SIG_IGN, &result);
  return result;
}

static napi_value open_at(napi_env env, napi_callback_info info) {
  Call call;
  int32_t dir, flags, mode;
  char name[PATH_MAX];
  if (!take_args(env, info, 4, &call)) return status(env, -EINVAL);
  if (!int_arg(&call, 0, &dir) || !int_arg(&call, 2, &flags) || !int_arg(&call, 3, &mode)) return NULL;
  int checked = name_arg(&call, 1, name, sizeof(name));
  if (checked != 0) return status(env, checked);
  for (;;) {
    int fd = openat(dir, name, flags | O_CLOEXEC, (mode_t)mode);
    if (fd >= 0) return owned_fd(env, fd);
    if (errno != EINTR) return status(env, failed());
  }
}

static napi_value not_regular(napi_env env) {
  napi_value result = NULL;
  napi_get_null(env, &result);
  return result;
}

static bool waiting_fifo(int dir, const char *name) {
  struct stat found;
  return fstatat(dir, name, &found, AT_SYMLINK_NOFOLLOW) == 0 && S_ISFIFO(found.st_mode);
}

static napi_value open_file_at(napi_env env, napi_callback_info info) {
  Call call;
  int32_t dir, flags, mode;
  char name[PATH_MAX];
  if (!take_args(env, info, 4, &call)) return status(env, -EINVAL);
  if (!int_arg(&call, 0, &dir) || !int_arg(&call, 2, &flags) || !int_arg(&call, 3, &mode)) return NULL;
  int checked = name_arg(&call, 1, name, sizeof(name));
  if (checked != 0) return status(env, checked);
  int fd;
  do {
    fd = openat(dir, name, flags | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC, (mode_t)mode);
  } while (fd < 0 && errno == EINTR);
  if (fd < 0) {
    int error = failed();
    if (error == -ENXIO && waiting_fifo(dir, name)) return not_regular(env);
    return status(env, error);
  }
  struct stat found;
  if (fstat(fd, &found) != 0) {
    int error = failed();
    close(fd);
    return status(env, error);
  }
  if (!S_ISREG(found.st_mode)) {
    close(fd);
    return not_regular(env);
  }
  int now = fcntl(fd, F_GETFL);
  if (now < 0 || fcntl(fd, F_SETFL, now & ~O_NONBLOCK) != 0) {
    int error = failed();
    close(fd);
    return status(env, error);
  }
  return owned_fd(env, fd);
}

static napi_value mkdir_at(napi_env env, napi_callback_info info) {
  Call call;
  int32_t dir, mode;
  char name[PATH_MAX];
  if (!take_args(env, info, 3, &call)) return status(env, -EINVAL);
  if (!int_arg(&call, 0, &dir) || !int_arg(&call, 2, &mode)) return NULL;
  int checked = name_arg(&call, 1, name, sizeof(name));
  if (checked != 0) return status(env, checked);
  return status(env, mkdirat(dir, name, (mode_t)mode) == 0 ? 0 : failed());
}

static napi_value rename_at(napi_env env, napi_callback_info info) {
  Call call;
  int32_t dir;
  char from[PATH_MAX], to[PATH_MAX];
  if (!take_args(env, info, 3, &call)) return status(env, -EINVAL);
  if (!int_arg(&call, 0, &dir)) return NULL;
  int checked = name_arg(&call, 1, from, sizeof(from));
  if (checked == 0) checked = name_arg(&call, 2, to, sizeof(to));
  if (checked != 0) return status(env, checked);
  return status(env, renameat(dir, from, dir, to) == 0 ? 0 : failed());
}

static napi_value unlink_at(napi_env env, napi_callback_info info) {
  Call call;
  int32_t dir;
  char name[PATH_MAX];
  if (!take_args(env, info, 2, &call)) return status(env, -EINVAL);
  if (!int_arg(&call, 0, &dir)) return NULL;
  int checked = name_arg(&call, 1, name, sizeof(name));
  if (checked != 0) return status(env, checked);
  return status(env, unlinkat(dir, name, 0) == 0 ? 0 : failed());
}

static napi_value size_at(napi_env env, napi_callback_info info) {
  Call call;
  int32_t dir;
  char name[PATH_MAX];
  struct stat found;
  if (!take_args(env, info, 2, &call)) return status(env, -EINVAL);
  if (!int_arg(&call, 0, &dir)) return NULL;
  int checked = name_arg(&call, 1, name, sizeof(name));
  if (checked != 0) return status(env, checked);
  if (fstatat(dir, name, &found, AT_SYMLINK_NOFOLLOW) != 0) return status(env, failed());
  return number(env, (double)found.st_size);
}

static bool plain_name(const char *name) {
  return name[0] != 0 && strchr(name, '/') == NULL && strcmp(name, ".") != 0 && strcmp(name, "..") != 0;
}

static napi_value big(napi_env env, uint64_t value) {
  napi_value result = NULL;
  napi_create_bigint_uint64(env, value, &result);
  return result;
}

static napi_value stat_at(napi_env env, napi_callback_info info) {
  Call call;
  int32_t dir;
  char name[PATH_MAX];
  struct stat found;
  napi_value result = NULL;
  if (!take_args(env, info, 2, &call) || call.argc != 2) return status(env, -EINVAL);
  if (!int_arg(&call, 0, &dir)) return NULL;
  if (dir < 0) return status(env, -EBADF);
  int checked = name_arg(&call, 1, name, sizeof(name));
  if (checked != 0) return status(env, checked);
  if (!plain_name(name)) return status(env, -EINVAL);
  if (fstatat(dir, name, &found, AT_SYMLINK_NOFOLLOW) != 0) return status(env, failed());
#if defined(__APPLE__)
  double mtime = (double)found.st_mtimespec.tv_sec + (double)found.st_mtimespec.tv_nsec / 1e9;
#else
  double mtime = (double)found.st_mtim.tv_sec + (double)found.st_mtim.tv_nsec / 1e9;
#endif
  napi_value fields[5] = {number(env, (double)found.st_mode), number(env, (double)found.st_uid), big(env, (uint64_t)found.st_dev),
                          big(env, (uint64_t)found.st_ino), number(env, mtime)};
  if (napi_create_array(env, &result) != napi_ok) return status(env, -ENOMEM);
  for (uint32_t index = 0; index < 5; index += 1) {
    if (fields[index] == NULL || napi_set_element(env, result, index, fields[index]) != napi_ok) return status(env, -ENOMEM);
  }
  return result;
}

static void finish_listing(DIR *stream) {
  rewinddir(stream);
  closedir(stream);
}

static napi_value list_at(napi_env env, napi_callback_info info) {
  Call call;
  int32_t dir;
  napi_value names = NULL;
  if (!take_args(env, info, 1, &call)) return status(env, -EINVAL);
  if (!int_arg(&call, 0, &dir)) return NULL;
  int copy = fcntl(dir, F_DUPFD_CLOEXEC, 0);
  if (copy < 0) return status(env, failed());
  DIR *stream = fdopendir(copy);
  if (stream == NULL) {
    int error = failed();
    close(copy);
    return status(env, error);
  }
  if (napi_create_array(env, &names) != napi_ok) {
    finish_listing(stream);
    return status(env, -ENOMEM);
  }
  uint32_t count = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(stream);
    if (entry == NULL) break;
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    napi_value name = NULL;
    if (napi_create_buffer_copy(env, strlen(entry->d_name), entry->d_name, NULL, &name) != napi_ok || napi_set_element(env, names, count, name) != napi_ok) {
      finish_listing(stream);
      return status(env, -ENOMEM);
    }
    count += 1;
  }
  int error = errno;
  finish_listing(stream);
  if (error != 0) return status(env, -error);
  return names;
}

static napi_value lock(napi_env env, napi_callback_info info) {
  Call call;
  int32_t fd;
  bool exclusive, wait;
  if (!take_args(env, info, 3, &call)) return status(env, -EINVAL);
  if (!int_arg(&call, 0, &fd) || !bool_arg(&call, 1, &exclusive) || !bool_arg(&call, 2, &wait)) return NULL;
  int operation = (exclusive ? LOCK_EX : LOCK_SH) | (wait ? 0 : LOCK_NB);
  for (;;) {
    if (flock(fd, operation) == 0) return status(env, 0);
    if (errno != EINTR) return status(env, failed());
  }
}

static napi_value error_text(napi_env env, napi_callback_info info) {
  Call call;
  int32_t code;
  char buffer[256];
  napi_value result = NULL;
  if (!take_args(env, info, 1, &call)) return status(env, -EINVAL);
  if (!int_arg(&call, 0, &code)) return NULL;
  memset(buffer, 0, sizeof(buffer));
#if defined(__GLIBC__) && defined(_GNU_SOURCE)
  const char *text = strerror_r(code, buffer, sizeof(buffer));
#else
  (void)strerror_r(code, buffer, sizeof(buffer));
  const char *text = buffer;
#endif
  if (napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &result) != napi_ok) return status(env, -ENOMEM);
  return result;
}

static ssize_t write_once(int fd, const char *bytes, size_t length) {
  for (;;) {
    ssize_t wrote = write(fd, bytes, length);
    if (wrote >= 0) return wrote;
    if (errno != EINTR) return failed();
  }
}

static napi_value write_some(napi_env env, napi_callback_info info) {
  Call call;
  int32_t fd, offset;
  void *data = NULL;
  size_t length = 0;
  bool is_buffer = false;
  if (!take_args(env, info, 3, &call)) return status(env, -EINVAL);
  if (!int_arg(&call, 0, &fd) || !int_arg(&call, 2, &offset)) return NULL;
  if (napi_is_buffer(env, call.argv[1], &is_buffer) != napi_ok || !is_buffer || napi_get_buffer_info(env, call.argv[1], &data, &length) != napi_ok) {
    napi_throw_type_error(env, NULL, "ardia-libc: expected a buffer");
    return NULL;
  }
  if (offset < 0 || (size_t)offset > length) {
    napi_throw_range_error(env, NULL, "ardia-libc: offset outside the buffer");
    return NULL;
  }
  struct sigaction kept, plain;
  memset(&kept, 0, sizeof(kept));
  memset(&plain, 0, sizeof(plain));
  plain.sa_handler = SIG_DFL;
  sigemptyset(&plain.sa_mask);
  if (sigaction(SIGINT, NULL, &kept) != 0) return status(env, failed());
  bool swapped = kept.sa_handler != SIG_IGN && sigaction(SIGINT, &plain, NULL) == 0;
  ssize_t result = write_once(fd, (const char *)data + offset, length - (size_t)offset);
  if (swapped) sigaction(SIGINT, &kept, NULL);
  return number(env, (double)result);
}

static void *watch_lifeline_thread(void *argument) {
  int fd = (int)(intptr_t)argument;
  char sink[64];
  for (;;) {
    ssize_t got = read(fd, sink, sizeof(sink));
    if (got > 0 || (got < 0 && errno == EINTR)) continue;
    kill(getpid(), SIGKILL);
    _exit(137);
  }
  return NULL;
}

static napi_value watch_lifeline(napi_env env, napi_callback_info info) {
  Call call;
  int32_t fd;
  pthread_t thread;
  pthread_attr_t attributes;
  if (!take_args(env, info, 1, &call)) return status(env, -EINVAL);
  if (!int_arg(&call, 0, &fd)) return NULL;
  if (fd < 0) return status(env, -EINVAL);
  if (fcntl(fd, F_SETFD, FD_CLOEXEC) != 0) return status(env, failed());
  if (pthread_attr_init(&attributes) != 0) return status(env, -ENOMEM);
  pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
  int started = pthread_create(&thread, &attributes, watch_lifeline_thread, (void *)(intptr_t)fd);
  pthread_attr_destroy(&attributes);
  return status(env, -started);
}

static bool bigint_arg(Call *call, size_t index, uint64_t *out) {
  napi_valuetype type;
  bool lossless = false;
  if (napi_typeof(call->env, call->argv[index], &type) != napi_ok || type != napi_bigint) return false;
  return napi_get_value_bigint_uint64(call->env, call->argv[index], out, &lossless) == napi_ok && lossless;
}

enum { WATCHDOG_IDLE, WATCHDOG_ARMED, WATCHDOG_DISARMED };
static atomic_int watchdog_state = WATCHDOG_IDLE;

typedef struct {
  int dir;
  char name[PATH_MAX];
  uint64_t dev;
  uint64_t ino;
  int64_t deadline;
  int code;
} Watchdog;

static Watchdog watchdog;

static int64_t monotonic_ms(void) {
  struct timespec clock;
  clock_gettime(CLOCK_MONOTONIC, &clock);
  return (int64_t)clock.tv_sec * 1000 + clock.tv_nsec / 1000000;
}

static void *watchdog_thread(void *argument) {
  (void)argument;
  for (;;) {
    if (atomic_load(&watchdog_state) != WATCHDOG_ARMED) return NULL;
    int64_t left = watchdog.deadline - monotonic_ms();
    if (left <= 0) break;
    int64_t nap = left < 50 ? left : 50;
    struct timespec pause = {.tv_sec = 0, .tv_nsec = (long)nap * 1000000L};
    nanosleep(&pause, NULL);
  }
  if (atomic_load(&watchdog_state) != WATCHDOG_ARMED) return NULL;
  struct stat found;
  if (fstatat(watchdog.dir, watchdog.name, &found, AT_SYMLINK_NOFOLLOW) == 0 && S_ISSOCK(found.st_mode)
      && (uint64_t)found.st_dev == watchdog.dev && (uint64_t)found.st_ino == watchdog.ino) {
    unlinkat(watchdog.dir, watchdog.name, 0);
  }
  _exit(watchdog.code);
  return NULL;
}

static napi_value arm_watchdog(napi_env env, napi_callback_info info) {
  Call call;
  int32_t dir, ms, code;
  uint64_t dev, ino;
  char name[PATH_MAX];
  if (!take_args(env, info, 6, &call) || call.argc != 6) return status(env, -EINVAL);
  if (!int_arg(&call, 0, &dir) || !int_arg(&call, 4, &ms) || !int_arg(&call, 5, &code)) return NULL;
  if (dir < 0) return status(env, -EBADF);
  if (ms < 1 || ms > 86400000 || code < 0 || code > 255) return status(env, -EINVAL);
  if (!bigint_arg(&call, 2, &dev) || !bigint_arg(&call, 3, &ino)) return status(env, -EINVAL);
  int checked = name_arg(&call, 1, name, sizeof(name));
  if (checked != 0) return status(env, checked);
  if (!plain_name(name)) return status(env, -EINVAL);
  int expected = WATCHDOG_IDLE;
  if (!atomic_compare_exchange_strong(&watchdog_state, &expected, WATCHDOG_ARMED)) return status(env, -EBUSY);
  int copy = fcntl(dir, F_DUPFD_CLOEXEC, 0);
  if (copy < 0) {
    int error = failed();
    atomic_store(&watchdog_state, WATCHDOG_DISARMED);
    return status(env, error);
  }
  watchdog.dir = copy;
  memcpy(watchdog.name, name, sizeof(name));
  watchdog.dev = dev;
  watchdog.ino = ino;
  watchdog.code = code;
  watchdog.deadline = monotonic_ms() + ms;
  pthread_t thread;
  pthread_attr_t attributes;
  if (pthread_attr_init(&attributes) != 0) {
    atomic_store(&watchdog_state, WATCHDOG_DISARMED);
    return status(env, -ENOMEM);
  }
  pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
  int started = pthread_create(&thread, &attributes, watchdog_thread, NULL);
  pthread_attr_destroy(&attributes);
  if (started != 0) atomic_store(&watchdog_state, WATCHDOG_DISARMED);
  return status(env, -started);
}

static napi_value disarm_watchdog(napi_env env, napi_callback_info info) {
  Call call;
  if (!take_args(env, info, 0, &call) || call.argc != 0) return status(env, -EINVAL);
  int expected = WATCHDOG_ARMED;
  return status(env, atomic_compare_exchange_strong(&watchdog_state, &expected, WATCHDOG_DISARMED) ? 0 : -EINVAL);
}

static napi_value rename_exclusive_at(napi_env env, napi_callback_info info) {
  Call call;
  int32_t from_dir, to_dir;
  char from[PATH_MAX], to[PATH_MAX];
  if (!take_args(env, info, 4, &call) || call.argc != 4) return status(env, -EINVAL);
  if (!int_arg(&call, 0, &from_dir) || !int_arg(&call, 2, &to_dir)) return NULL;
  if (from_dir < 0 || to_dir < 0) return status(env, -EBADF);
  int checked = name_arg(&call, 1, from, sizeof(from));
  if (checked == 0) checked = name_arg(&call, 3, to, sizeof(to));
  if (checked != 0) return status(env, checked);
  if (!plain_name(from) || !plain_name(to)) return status(env, -EINVAL);
#if defined(__APPLE__)
  int done = renameatx_np(from_dir, from, to_dir, to, RENAME_EXCL);
#elif defined(__linux__)
  int done = (int)syscall(SYS_renameat2, from_dir, from, to_dir, to, 1u);
#else
  int done = -1;
  errno = ENOSYS;
#endif
  return status(env, done == 0 ? 0 : failed());
}

static napi_value remove_dir_at(napi_env env, napi_callback_info info) {
  Call call;
  int32_t dir;
  char name[PATH_MAX];
  if (!take_args(env, info, 2, &call) || call.argc != 2) return status(env, -EINVAL);
  if (!int_arg(&call, 0, &dir)) return NULL;
  if (dir < 0) return status(env, -EBADF);
  int checked = name_arg(&call, 1, name, sizeof(name));
  if (checked != 0) return status(env, checked);
  if (!plain_name(name)) return status(env, -EINVAL);
  return status(env, unlinkat(dir, name, AT_REMOVEDIR) == 0 ? 0 : failed());
}

static napi_value non_blocking(napi_env env, napi_callback_info info) {
  Call call;
  int32_t fd;
  if (!take_args(env, info, 1, &call) || call.argc != 1) return status(env, -EINVAL);
  if (!int_arg(&call, 0, &fd)) return NULL;
  if (fd < 0) return status(env, -EBADF);
  int now = fcntl(fd, F_GETFL);
  if (now < 0) return status(env, failed());
  return status(env, fcntl(fd, F_SETFL, now | O_NONBLOCK) == 0 ? 0 : failed());
}

static bool define(napi_env env, napi_value exports, const char *name, napi_callback callback) {
  napi_value function = NULL;
  return napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, NULL, &function) == napi_ok
      && napi_set_named_property(env, exports, name, function) == napi_ok;
}

__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  bool ok = define(env, exports, "peerUid", peer_uid)
      && define(env, exports, "interruptsIgnored", interrupts_ignored)
      && define(env, exports, "openAt", open_at)
      && define(env, exports, "openFileAt", open_file_at)
      && define(env, exports, "mkdirAt", mkdir_at)
      && define(env, exports, "renameAt", rename_at)
      && define(env, exports, "unlinkAt", unlink_at)
      && define(env, exports, "sizeAt", size_at)
      && define(env, exports, "statAt", stat_at)
      && define(env, exports, "armWatchdog", arm_watchdog)
      && define(env, exports, "disarmWatchdog", disarm_watchdog)
      && define(env, exports, "renameExclusiveAt", rename_exclusive_at)
      && define(env, exports, "removeDirAt", remove_dir_at)
      && define(env, exports, "nonBlocking", non_blocking)
      && define(env, exports, "listAt", list_at)
      && define(env, exports, "lock", lock)
      && define(env, exports, "watchLifeline", watch_lifeline)
      && define(env, exports, "writeSome", write_some)
      && define(env, exports, "strerror", error_text);
  return ok ? exports : NULL;
}

__attribute__((visibility("default"))) int32_t node_api_module_get_api_version_v1(void) {
  return 8;
}
