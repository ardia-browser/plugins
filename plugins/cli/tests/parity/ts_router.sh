#!/bin/sh
root=$(cd "$(dirname "$0")/.." && pwd -P)
exec "$root/python/bin/python3" -I -c '
import fcntl, json, os, sys
root, args = sys.argv[1], sys.argv[2:]
python = os.path.join(root, "python", "bin", "python3")
program = os.path.join(root, "libexec", "ardia-ts")
if os.path.exists(program):
    from ardia_cli import caller
    wire = json.dumps(caller.current().wire(), ensure_ascii=False, separators=(",", ":")).encode().hex()
    read_end, write_end = os.pipe()
    lifeline = fcntl.fcntl(read_end, fcntl.F_DUPFD, 3)
    os.close(read_end)
    os.set_inheritable(lifeline, True)
    pid = os.fork()
    if pid == 0:
        os.close(write_end)
        os.execv(program, [program, f"--ardia-routed=2:0:{lifeline}:{wire}", *args])
    os.close(lifeline)
    _, status = os.waitpid(pid, 0)
    if os.WIFSIGNALED(status):
        os.kill(os.getpid(), os.WTERMSIG(status))
    if os.WEXITSTATUS(status) != 253:
        sys.exit(os.WEXITSTATUS(status))
    os.close(write_end)
os.execv(python, [python, "-I", "-m", "ardia_cli", *args])
' "$root" "$@"
