#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <sys/ucred.h>
#include <sys/un.h>
#endif

#ifndef SRC_JS_NATIVE_API_TYPES_H_
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);
#define napi_ok 0
#endif
#ifndef NAPI_AUTO_LENGTH
#define NAPI_AUTO_LENGTH SIZE_MAX
#endif

napi_status napi_get_cb_info(napi_env env, napi_callback_info cbinfo, size_t *argc, napi_value *argv, napi_value *this_arg, void **data);
napi_status napi_get_value_int32(napi_env env, napi_value value, int32_t *result);
napi_status napi_get_value_bool(napi_env env, napi_value value, bool *result);
napi_status napi_get_value_string_utf8(napi_env env, napi_value value, char *buf, size_t bufsize, size_t *result);
napi_status napi_create_int32(napi_env env, int32_t value, napi_value *result);
napi_status napi_create_double(napi_env env, double value, napi_value *result);
napi_status napi_get_boolean(napi_env env, bool value, napi_value *result);
napi_status napi_create_string_utf8(napi_env env, const char *str, size_t length, napi_value *result);
napi_status napi_create_array(napi_env env, napi_value *result);
napi_status napi_set_element(napi_env env, napi_value object, uint32_t index, napi_value value);
napi_status napi_create_function(napi_env env, const char *utf8name, size_t length, napi_callback cb, void *data, napi_value *result);
napi_status napi_set_named_property(napi_env env, napi_value object, const char *utf8name, napi_value value);

#define MAX_ARGS 4

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
  return napi_get_value_int32(call->env, call->argv[index], out) == napi_ok;
}

static bool bool_arg(Call *call, size_t index, bool *out) {
  return napi_get_value_bool(call->env, call->argv[index], out) == napi_ok;
}

static int name_arg(Call *call, size_t index, char *buffer, size_t size) {
  size_t length = 0;
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

static int failed(void) {
  return errno > 0 ? -errno : -EIO;
}

static napi_value peer_uid(napi_env env, napi_callback_info info) {
  Call call;
  int32_t fd;
  if (!take_args(env, info, 1, &call) || !int_arg(&call, 0, &fd)) return status(env, -EINVAL);
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
  if (!take_args(env, info, 4, &call) || !int_arg(&call, 0, &dir) || !int_arg(&call, 2, &flags) || !int_arg(&call, 3, &mode)) return status(env, -EINVAL);
  int checked = name_arg(&call, 1, name, sizeof(name));
  if (checked != 0) return status(env, checked);
  for (;;) {
    int fd = openat(dir, name, flags | O_CLOEXEC, (mode_t)mode);
    if (fd >= 0) return status(env, fd);
    if (errno != EINTR) return status(env, failed());
  }
}

static napi_value mkdir_at(napi_env env, napi_callback_info info) {
  Call call;
  int32_t dir, mode;
  char name[PATH_MAX];
  if (!take_args(env, info, 3, &call) || !int_arg(&call, 0, &dir) || !int_arg(&call, 2, &mode)) return status(env, -EINVAL);
  int checked = name_arg(&call, 1, name, sizeof(name));
  if (checked != 0) return status(env, checked);
  return status(env, mkdirat(dir, name, (mode_t)mode) == 0 ? 0 : failed());
}

static napi_value rename_at(napi_env env, napi_callback_info info) {
  Call call;
  int32_t dir;
  char from[PATH_MAX], to[PATH_MAX];
  if (!take_args(env, info, 3, &call) || !int_arg(&call, 0, &dir)) return status(env, -EINVAL);
  int checked = name_arg(&call, 1, from, sizeof(from));
  if (checked == 0) checked = name_arg(&call, 2, to, sizeof(to));
  if (checked != 0) return status(env, checked);
  return status(env, renameat(dir, from, dir, to) == 0 ? 0 : failed());
}

static napi_value unlink_at(napi_env env, napi_callback_info info) {
  Call call;
  int32_t dir;
  char name[PATH_MAX];
  if (!take_args(env, info, 2, &call) || !int_arg(&call, 0, &dir)) return status(env, -EINVAL);
  int checked = name_arg(&call, 1, name, sizeof(name));
  if (checked != 0) return status(env, checked);
  return status(env, unlinkat(dir, name, 0) == 0 ? 0 : failed());
}

static napi_value size_at(napi_env env, napi_callback_info info) {
  Call call;
  int32_t dir;
  char name[PATH_MAX];
  struct stat found;
  if (!take_args(env, info, 2, &call) || !int_arg(&call, 0, &dir)) return status(env, -EINVAL);
  int checked = name_arg(&call, 1, name, sizeof(name));
  if (checked != 0) return status(env, checked);
  if (fstatat(dir, name, &found, AT_SYMLINK_NOFOLLOW) != 0) return status(env, failed());
  return number(env, (double)found.st_size);
}

static napi_value list_at(napi_env env, napi_callback_info info) {
  Call call;
  int32_t dir;
  napi_value names = NULL;
  if (!take_args(env, info, 1, &call) || !int_arg(&call, 0, &dir)) return status(env, -EINVAL);
  int copy = fcntl(dir, F_DUPFD_CLOEXEC, 0);
  if (copy < 0) return status(env, failed());
  DIR *stream = fdopendir(copy);
  if (stream == NULL) {
    int error = failed();
    close(copy);
    return status(env, error);
  }
  rewinddir(stream);
  if (napi_create_array(env, &names) != napi_ok) {
    closedir(stream);
    return status(env, -ENOMEM);
  }
  uint32_t count = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(stream);
    if (entry == NULL) break;
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    napi_value name = NULL;
    if (napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name) != napi_ok || napi_set_element(env, names, count, name) != napi_ok) {
      closedir(stream);
      return status(env, -ENOMEM);
    }
    count += 1;
  }
  int error = errno;
  closedir(stream);
  if (error != 0) return status(env, -error);
  return names;
}

static napi_value lock(napi_env env, napi_callback_info info) {
  Call call;
  int32_t fd;
  bool exclusive, wait;
  if (!take_args(env, info, 3, &call) || !int_arg(&call, 0, &fd) || !bool_arg(&call, 1, &exclusive) || !bool_arg(&call, 2, &wait)) return status(env, -EINVAL);
  int operation = (exclusive ? LOCK_EX : LOCK_SH) | (wait ? 0 : LOCK_NB);
  for (;;) {
    if (flock(fd, operation) == 0) return status(env, 0);
    if (errno != EINTR) return status(env, failed());
  }
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
  if (!take_args(env, info, 1, &call) || !int_arg(&call, 0, &fd) || fd < 0) return status(env, -EINVAL);
  if (fcntl(fd, F_SETFD, FD_CLOEXEC) != 0) return status(env, failed());
  if (pthread_attr_init(&attributes) != 0) return status(env, -ENOMEM);
  pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
  int started = pthread_create(&thread, &attributes, watch_lifeline_thread, (void *)(intptr_t)fd);
  pthread_attr_destroy(&attributes);
  return status(env, -started);
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
      && define(env, exports, "mkdirAt", mkdir_at)
      && define(env, exports, "renameAt", rename_at)
      && define(env, exports, "unlinkAt", unlink_at)
      && define(env, exports, "sizeAt", size_at)
      && define(env, exports, "listAt", list_at)
      && define(env, exports, "lock", lock)
      && define(env, exports, "watchLifeline", watch_lifeline);
  return ok ? exports : NULL;
}

__attribute__((visibility("default"))) int32_t node_api_module_get_api_version_v1(void) {
  return 8;
}
