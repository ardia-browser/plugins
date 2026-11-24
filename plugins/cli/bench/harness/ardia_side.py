import datetime
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import grading
import registry
import servers
from procs import (front_pid, http, kill_group, spawn_agent, listener_pids, proc_info, read_json, read_jsonl, same_process, sh,
                   terminate, wait_until, write_json)

HOME = registry.HOME
DATA = HOME / "data-ardia"
INSTANCE = registry.STATE_DIR / "ardia-instance.json"
WORK = HOME / "work"
CODEX_FAKE_HOME = HOME / "codex-home"
DEV_BIN = HOME / "devbin"
CLI_ROOT = HOME / "cli"
INSTALLED_ARDIA = Path.home() / ".local/bin/ardia"
DEFAULTS = {
    "app": str(HOME / "app/Ardia.app"),
    "port": 9371,
    "cli": "dev",
    "ardia_test": "cdpTabsVisible",
    "humanize": False,
    "keep_notes": False,
}
MODELS = {"claude": ("claude-opus-5-5", "high"), "codex": ("gpt-6.2-sol", "high")}
CLAUDE_ROUTE_KEYS = ("claude_base_url", "claude_auth_token")
STRIPPED_ENV_PREFIXES = ("CLAUDECODE", "CLAUDE_CODE_", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_AGENT_SDK", "AI_AGENT",
                         "T3CODE_", "ARDIA_", "AGENT_BROWSER_", "CODEX_")
KEPT_ENV = {"CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX"}
SHELL_TOOLS = {"Bash", "command_execution"}
MCP_PREFIX = "mcp-"
MCP_SERVER = "ardia"
MCP_TOOLS = ("browser_repl", "browser_act")
MCP_TOOL_TIMEOUT_S = 600


def log(msg):
    print(f"[bench] {msg}", file=sys.stderr, flush=True)


def options(overrides=None):
    opts = dict(DEFAULTS)
    opts.update({k: v for k, v in (overrides or {}).items() if v is not None})
    opts["port"] = int(opts["port"])
    return opts


def lane_paths(opts):
    lane = opts.get("lane")
    if not lane:
        return DATA, INSTANCE, CODEX_FAKE_HOME
    return (HOME / f"data-ardia-{lane}", registry.STATE_DIR / f"ardia-instance-{lane}.json",
            HOME / f"codex-home-{lane}")


def dev_name(opts):
    cli = str(opts["cli"])
    if cli == "dev":
        return ""
    if cli.startswith("dev:") and cli[4:].replace("-", "").replace("_", "").isalnum():
        return cli[4:]
    if cli == "installed":
        return None
    raise SystemExit(f"cli must be dev, dev:<name> or installed, not {cli}")


def dev_bin(name=""):
    return HOME / f"devbin-{name}" if name else DEV_BIN


def ardia_bin(opts):
    name = dev_name(opts)
    return str(INSTALLED_ARDIA) if name is None else str(dev_bin(name) / "ardia")


def agent_env(opts, extra=None):
    env = {k: v for k, v in os.environ.items() if k in KEPT_ENV or not k.startswith(STRIPPED_ENV_PREFIXES)}
    path = env.get("PATH", "")
    local_bin = str(INSTALLED_ARDIA.parent)
    if local_bin not in path.split(":"):
        path = f"{local_bin}:{path}"
    if dev_name(opts) is not None:
        path = f"{dev_bin(dev_name(opts))}:{path}"
    env["PATH"] = path
    route = claude_route(opts)
    if "ANTHROPIC_AUTH_TOKEN" in route:
        env.pop("ANTHROPIC_API_KEY", None)
    env.update(route)
    env.update(extra or {})
    return env


def claude_route(opts):
    base = (opts or {}).get("claude_base_url") or os.environ.get("BENCH_CLAUDE_BASE_URL")
    token = (opts or {}).get("claude_auth_token") or os.environ.get("BENCH_CLAUDE_AUTH_TOKEN")
    return {k: v for k, v in (("ANTHROPIC_BASE_URL", base), ("ANTHROPIC_AUTH_TOKEN", token)) if v}


def route_opts(opts):
    return {k: opts.get(k) for k in CLAUDE_ROUTE_KEYS if opts.get(k)}


def claude_route_label(opts):
    return claude_route(opts).get("ANTHROPIC_BASE_URL") or "anthropic"


def freeze_cli(src, name=""):
    src = Path(src).resolve()
    git = sh(["git", "-C", str(src), "rev-parse", "--short", "HEAD"]).stdout.strip()
    dirty = bool(sh(["git", "-C", str(src), "status", "--porcelain", "--", "."]).stdout.strip())
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = CLI_ROOT / f"{stamp}-{git or 'nogit'}"
    version = "0.0.0-bench.1"
    sh(["sh", str(src / "scripts" / "build.sh"), version, str(dest / "packed")], timeout=900).check_returncode()
    tarball = next((dest / "packed").glob(f"ardia-cli-{version}-*.tar.gz"))
    sh(["tar", "-xzf", str(tarball), "-C", str(dest)]).check_returncode()
    program = dest / f"ardia-cli-{version}" / "bin" / "ardia"
    dev_name({"cli": f"dev:{name}" if name else "dev"})
    dev_bin(name).mkdir(parents=True, exist_ok=True)
    link = dev_bin(name) / "ardia"
    link.unlink(missing_ok=True)
    link.symlink_to(program)
    version = sh([str(link), "--version"]).stdout.strip()
    info = {"path": str(dest), "git": git, "dirty": dirty, "version": version,
            "frozen_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds")}
    write_json(CLI_ROOT / (f"{name}.json" if name else "current.json"), info)
    return info


def cli_info(opts):
    name = dev_name(opts)
    if name is not None:
        info = read_json(CLI_ROOT / (f"{name}.json" if name else "current.json"))
        if not info or not (dev_bin(name) / "ardia").exists():
            raise SystemExit(f"no frozen dev CLI; run: bench.py freeze-cli{' --name ' + name if name else ''}")
        return dict(info, kind=f"dev:{name}" if name else "dev")
    return {"kind": "installed", "version": sh([str(INSTALLED_ARDIA), "--version"]).stdout.strip()}


def app_path(opts):
    real = Path(opts["app"]).expanduser().resolve()
    if str(real).startswith("/Applications/"):
        raise SystemExit("refusing an installed app; copy a build into the bench home and pass --app")
    if not (real / "Contents/MacOS/Ardia").exists():
        raise SystemExit(f"no Ardia app at {real}")
    return real


def devtools(opts, method, path, timeout=10):
    req = urllib.request.Request(f"http://127.0.0.1:{opts['port']}{path}", method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
    try:
        return json.loads(body)
    except ValueError:
        return body.decode(errors="replace")


def pages(opts):
    return [t for t in devtools(opts, "GET", "/json/list") if t.get("type") == "page"]


def instance_matches(opts, state):
    return (bool(state) and same_process(state) and state["port"] == opts["port"]
            and state["app"] == str(app_path(opts)) and state.get("ardia_test") == opts["ardia_test"]
            and state["pid"] in listener_pids(opts["port"]))


def launch(opts):
    data, instance, _ = lane_paths(opts)
    app = app_path(opts)
    busy = listener_pids(opts["port"])
    if busy:
        raise SystemExit(f"port {opts['port']} is used by pid {busy}; run bench.py stop or pick --port")
    if data.exists():
        shutil.rmtree(data)
    data.mkdir(parents=True)
    (data / "onboarding.json").write_text(json.dumps({"version": 1, "completedAt": 1}))
    logfile = data / "app.out.log"
    t0 = time.monotonic()
    env_args = ["--env", "ARDIA_BACKGROUND=1", "--env", f"ARDIA_DATA_DIR={data}",
                "--env", f"ARDIA_REMOTE_DEBUGGING_PORT={opts['port']}"]
    if opts["ardia_test"]:
        env_args += ["--env", f"ARDIA_TEST={opts['ardia_test']}"]
    subprocess.run(["open", "-g", "-n", *env_args, "--stdout", str(logfile), "--stderr", str(logfile), str(app)],
                   check=True, timeout=30)
    exe = str(app / "Contents/MacOS/Ardia")

    def owned_listener():
        for pid in listener_pids(opts["port"]):
            info = proc_info(pid)
            if info and info["command"].startswith(exe):
                return pid, info
        return None

    pid, info = wait_until(owned_listener, 90, "Ardia DevTools port")
    state = {"pid": pid, "lstart": info["lstart"], "command": info["command"], "port": opts["port"],
             "app": str(app), "ardia_test": opts["ardia_test"], "data": str(data)}
    write_json(instance, state)
    wait_until(lambda: "Browser" in devtools(opts, "GET", "/json/version"), 60, "DevTools /json/version", pid=pid)
    state["launch_s"] = round(time.monotonic() - t0, 2)
    write_json(instance, state)
    log(f"launched Ardia pid {pid} on port {opts['port']} in {state['launch_s']} s")
    return state, False


def ensure_instance(opts):
    _, instance, _ = lane_paths(opts)
    state = read_json(instance)
    if instance_matches(opts, state):
        return state, True
    if state and same_process(state):
        quit_instance(opts)
    instance.unlink(missing_ok=True)
    return launch(opts)


def lock_held(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    except OSError:
        return False
    finally:
        os.close(fd)
    return False


def browse_daemons(data):
    found = []
    browse = data / "Browse"
    for entry in browse.glob("*.json") if browse.is_dir() else []:
        lock = browse / f"{entry.stem}.lock"
        if not lock_held(lock):
            continue
        try:
            pid = int(json.loads(entry.read_text()).get("pid"))
        except (OSError, ValueError, TypeError, AttributeError):
            continue
        if pid > 1 and proc_info(pid):
            found.append((pid, lock))
    return found


def stop_browse_daemons(data):
    daemons = browse_daemons(data)
    for pid, _ in daemons:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    end = time.monotonic() + 5
    while time.monotonic() < end and any(lock_held(lock) and proc_info(pid) for pid, lock in daemons):
        time.sleep(0.2)
    for pid, lock in daemons:
        if lock_held(lock) and proc_info(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    return [pid for pid, _ in daemons]


def prepare_tab(opts, task):
    extras = task.get("extra_urls", []) if task.get("preopen_extra") else []
    extra_set = set(extras)
    allowed_ports = set((task.get("server") or {}).get("ports") or [])
    seen = []

    def is_start(tab):
        url = tab.get("url") or ""
        if not tab.get("title"):
            return False
        if url == task["start_url"]:
            return True
        if url in extra_set or not allowed_ports:
            return False
        parsed = urllib.parse.urlparse(url)
        return parsed.hostname in ("127.0.0.1", "localhost") and parsed.port in allowed_ports

    def ready():
        current = pages(opts)
        seen[:] = [[t.get("url"), t.get("title")] for t in current]
        starts = [t for t in current if is_start(t)]
        return seen if len(current) == 1 + len(extras) and starts else None

    for attempt in range(3):
        old = pages(opts)
        for url in extras:
            devtools(opts, "PUT", "/json/new?" + urllib.parse.quote(url, safe=":/?&=#"))
        tab = devtools(opts, "PUT", "/json/new?" + urllib.parse.quote(task["start_url"], safe=":/?&=#"))
        devtools(opts, "GET", f"/json/activate/{tab['id']}")
        for t in old:
            try:
                devtools(opts, "GET", f"/json/close/{t['id']}")
            except Exception:
                pass
        try:
            return wait_until(ready, 10, f"one tab on {task['start_url']}")
        except RuntimeError:
            log(f"tab prep attempt {attempt + 1} saw {seen}")
    raise RuntimeError(f"tab on {task['start_url']}: not ready after 3 attempts, last {seen}")


def reset_task(task):
    http(task["reset"]["method"], task["reset"]["url"])
    baseline = http(task["check"]["method"], task["check"]["url"])
    if baseline.get("pass"):
        raise RuntimeError(f"{task['id']}: check passes right after reset")
    return baseline


def reach_line(opts):
    return f"Use the `ardia` command with `--port {opts['port']}` to reach this Ardia instance."


def split_agent(agent):
    agent = str(agent or "")
    if agent.startswith(MCP_PREFIX):
        return agent[len(MCP_PREFIX):], True
    return agent, False


def mcp_line(opts):
    return (f"Drive this Ardia instance (DevTools port {opts['port']}) only through the `{MCP_SERVER}` MCP server, "
            "not the shell `ardia` command. Default to `browser_repl` (persistent JS REPL; top-level const/let survive "
            "calls; no shell quoting). Use fast `page.*` methods instead of `browse(...)`: `page.here()`, "
            "`page.snapshot({interactive:true})`, `page.read()`, `page.form()`, `page.click(sel, {receipt:true})`, "
            "`page.fill(sel, val)`, `page.fillForm(pairs)`, `page.select(sel, val)`, `page.locator(sel)` / "
            "`page.getByRole(role, {name, within})` / `page.getByLabel(lbl)`, `page.fetch(url)` (with page cookies), "
            "`readUrls(urls)`, `openTab(url)`, `listTabs()`, `useTab(id)`, `page.assertText(s)`. "
            "Put loops, multi-field fills, JS filtering of long snapshots/lists, and final verification inside ONE "
            "`browser_repl` call and return only compact results. Use `browser_act` for `screenshot --scale 0.5 --marks`.")


def mcp_server(opts, data):
    env = {"ARDIA_DATA_DIR": str(data), "PATH": agent_env(opts)["PATH"]}
    if opts.get("humanize"):
        env["AGENT_BROWSER_HUMANIZE"] = "1"
    return {"command": ardia_bin(opts), "args": ["--port", str(opts["port"]), "mcp"], "env": env}


def write_mcp_config(path, server):
    config = {"mcpServers": {MCP_SERVER: {"type": "stdio", "command": server["command"], "args": server["args"],
                                          "env": server["env"]}}}
    Path(path).write_text(json.dumps(config, indent=2) + "\n")
    return Path(path)


def mcp_claude_command(model, effort, prompt, config_path):
    cmd = claude_command(model, effort, prompt)
    return cmd[:2] + ["--mcp-config", str(config_path), "--tools", "Read,Write"] + cmd[2:]


def mcp_codex_command(model, effort, workdir, prompt, server):
    cmd = codex_command(model, effort, workdir, prompt)
    key = f"mcp_servers.{MCP_SERVER}"
    env = ", ".join(f"{k} = {json.dumps(v)}" for k, v in server["env"].items())
    flags = ["-c", f"{key}.command={json.dumps(server['command'])}", "-c", f"{key}.args={json.dumps(server['args'])}",
             "-c", f"{key}.env={{ {env} }}", "-c", f"{key}.tool_timeout_sec={MCP_TOOL_TIMEOUT_S}",
             "-c", f"{key}.startup_timeout_sec=60"]
    return cmd[:-1] + flags + [prompt]


def result_text(content):
    if isinstance(content, dict):
        content = content.get("content", content.get("text", ""))
    if isinstance(content, list):
        return "\n".join(str(x.get("text", "")) for x in content if isinstance(x, dict))
    return "" if content is None else str(content)


def mcp_input_text(tool, args):
    if not isinstance(args, dict):
        return ""
    if tool == "browser_repl":
        return str(args.get("code") or "")
    parts = [str(args.get("command") or "")]
    if isinstance(args.get("args"), list):
        parts.extend(str(a) for a in args["args"])
    if args.get("stdin"):
        parts.append(str(args["stdin"]))
    return " ".join(p for p in parts if p)


def mcp_stats(agent, lines):
    calls, by_tool, errors, out_chars, shell = 0, {}, 0, 0, 0
    source_peeks, direct_api = 0, 0
    claude_prefix = f"mcp__{MCP_SERVER}__"
    pending = set()
    for e in lines:
        kind = e.get("type")
        if agent == "claude":
            if kind == "assistant" and not e.get("parent_tool_use_id"):
                for block in e.get("message", {}).get("content", []):
                    if block.get("type") != "tool_use":
                        continue
                    name = block.get("name") or ""
                    if name.startswith(claude_prefix):
                        tool = name[len(claude_prefix):]
                        calls += 1
                        by_tool[tool] = by_tool.get(tool, 0) + 1
                        inp_text = mcp_input_text(tool, block.get("input"))
                        if SOURCE_PEEK.search(inp_text):
                            source_peeks += 1
                        if DIRECT_API.search(inp_text):
                            direct_api += 1
                        if block.get("id"):
                            pending.add(block["id"])
                    elif name in SHELL_TOOLS:
                        shell += 1
            elif kind == "user":
                for block in e.get("message", {}).get("content", []):
                    if block.get("type") == "tool_result" and block.get("tool_use_id") in pending:
                        pending.discard(block.get("tool_use_id"))
                        out_chars += len(result_text(block.get("content")))
                        errors += 1 if block.get("is_error") else 0
        elif kind == "item.completed":
            item = e.get("item", {})
            if item.get("type") == "mcp_tool_call" and item.get("server") == MCP_SERVER:
                tool = item.get("tool") or ""
                calls += 1
                by_tool[tool] = by_tool.get(tool, 0) + 1
                inp_text = mcp_input_text(tool, item.get("arguments"))
                if SOURCE_PEEK.search(inp_text):
                    source_peeks += 1
                if DIRECT_API.search(inp_text):
                    direct_api += 1
                out_chars += len(result_text(item.get("result")))
                result = item.get("result") if isinstance(item.get("result"), dict) else {}
                failed = item.get("status") == "failed" or bool(item.get("error")) or bool(result.get("isError"))
                errors += 1 if failed else 0
            elif item.get("type") in SHELL_TOOLS:
                shell += 1
    return {"mcp_calls": calls, "mcp_by_tool": by_tool, "mcp_errors": errors, "mcp_output_chars": out_chars,
            "mcp_source_peeks": source_peeks, "mcp_direct_api": direct_api, "shell_commands": shell}


def claude_command(model, effort, prompt):
    return ["claude", "-p", "--model", model, "--effort", effort, "--output-format", "stream-json", "--verbose",
            "--dangerously-skip-permissions", "--setting-sources", "project", "--strict-mcp-config",
            "--no-session-persistence", prompt]


CODEX_SHARED_FILES = ("auth.json", "auth.json.lock", "auth.lock", "config.toml", "version.json", "installation_id")


def codex_env(fake_home):
    config = Path(fake_home) / "codex-config"
    if config.is_dir():
        shutil.rmtree(config)
    config.mkdir(parents=True)
    real = Path.home() / ".codex"
    for name in CODEX_SHARED_FILES:
        if (real / name).exists():
            (config / name).symlink_to(real / name)
    return {"HOME": str(fake_home), "CODEX_HOME": str(config)}


def codex_command(model, effort, workdir, prompt):
    return ["codex", "exec", "--json", "-m", model, "-c", f'model_reasoning_effort="{effort}"',
            "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            "--disable", "plugins", "--disable", "apps", "--disable", "browser_use",
            "--disable", "browser_use_external", "--disable", "computer_use", "--disable", "in_app_browser",
            "--disable", "memories", "-C", str(workdir), prompt]


SOURCE_PEEK = re.compile(r"(?:\b(?:curl|wget|python3?|node)\b[^\n]*(?:127\.0\.0\.1|localhost)[^\n]*\.js\b|document\.scripts)", re.I)
DIRECT_API = re.compile(r"(?:\b(?:curl|wget)\b[^\n]*(?:127\.0\.0\.1|localhost)[^\n]*/api/|fetch\(\s*['\"][^'\"]*/api/)", re.I)


def inspect_trace(cmds_and_outs):
    out_chars = 0
    cli_errors = 0
    source_peeks = 0
    direct_api = 0
    for cmd, out, exit_code in cmds_and_outs:
        text = out or ""
        out_chars += len(text)
        if exit_code not in (0, None) or "Exit code 1" in text or "\n✗ " in f"\n{text}":
            cli_errors += 1
        if SOURCE_PEEK.search(cmd or ""):
            source_peeks += 1
        if DIRECT_API.search(cmd or ""):
            direct_api += 1
    return {
        "output_chars": out_chars,
        "cli_errors": cli_errors,
        "shortcuts": {"source_peeks": source_peeks, "direct_api": direct_api},
    }


def parse_claude(lines):
    tools, turns, final, result, init = [], 0, None, None, None
    pending, trace = {}, []
    for e in lines:
        kind = e.get("type")
        if kind == "system" and e.get("subtype") == "init":
            init = {"skills": e.get("skills"), "mcp_servers": e.get("mcp_servers"), "model": e.get("model")}
        elif kind == "assistant" and not e.get("parent_tool_use_id"):
            turns += 1
            for block in e.get("message", {}).get("content", []):
                if block.get("type") == "tool_use":
                    inp = block.get("input", {})
                    text_in = inp.get("command") or inp.get("skill") or json.dumps(inp)
                    tools.append({"name": block.get("name"), "input": text_in[:400]})
                    if block.get("id"):
                        pending[block["id"]] = (block.get("name"), text_in)
                elif block.get("type") == "text":
                    final = block.get("text")
        elif kind == "user":
            for block in e.get("message", {}).get("content", []):
                if block.get("type") == "tool_result":
                    tid = block.get("tool_use_id")
                    name, cmd = pending.pop(tid, (None, ""))
                    content = block.get("content", "")
                    if isinstance(content, list):
                        content = "\n".join(x.get("text", "") for x in content if isinstance(x, dict))
                    if name in SHELL_TOOLS:
                        trace.append((cmd, str(content), 1 if block.get("is_error") else None))
        elif kind == "result":
            result = e
    tokens = cost = None
    if result:
        mu = result.get("modelUsage") or {}
        fresh = sum(m.get("inputTokens", 0) for m in mu.values())
        created = sum(m.get("cacheCreationInputTokens", 0) for m in mu.values())
        read = sum(m.get("cacheReadInputTokens", 0) for m in mu.values())
        out = sum(m.get("outputTokens", 0) for m in mu.values())
        tokens = {"input": fresh + created + read, "cached_input": read, "cache_write_input": created,
                  "uncached_input": fresh, "output": out, "total": fresh + created + read + out,
                  "raw_usage": result.get("usage"), "model_usage": mu}
        cost = result.get("total_cost_usd")
        final = result.get("result", final)
    return {"tokens": tokens, "cost_usd": cost, "tool_calls": len(tools), "tools": tools,
            "turns": result.get("num_turns") if result else turns, "final_message": final,
            "cli_duration_ms": result.get("duration_ms") if result else None,
            "cli_duration_api_ms": result.get("duration_api_ms") if result else None,
            "cli_result_subtype": result.get("subtype") if result else None,
            "cli_is_error": result.get("is_error") if result else None, "init": init,
            **inspect_trace(trace)}


def parse_codex(lines):
    tools, final, usage, turns, errors, trace = [], None, {}, 0, [], []
    for e in lines:
        kind = e.get("type")
        if kind == "turn.completed":
            turns += 1
            for k, v in (e.get("usage") or {}).items():
                if isinstance(v, (int, float)):
                    usage[k] = usage.get(k, 0) + v
        elif kind == "item.completed":
            item = e.get("item", {})
            t = item.get("type")
            if t == "agent_message":
                final = item.get("text")
            elif t == "error":
                errors.append(item.get("message", "")[:400])
            elif t not in ("reasoning", "todo_list"):
                cmd = item.get("command") or item.get("tool") or json.dumps(
                    {k: v for k, v in item.items() if k != "aggregated_output"})
                tools.append({"name": t, "input": cmd[:400], "exit_code": item.get("exit_code")})
                if t in SHELL_TOOLS:
                    trace.append((cmd, item.get("aggregated_output", ""), item.get("exit_code")))
        elif kind in ("turn.failed", "error"):
            errors.append(json.dumps(e)[:400])
    inp, out = usage.get("input_tokens", 0), usage.get("output_tokens", 0)
    cached = usage.get("cached_input_tokens", 0)
    tokens = {"input": inp, "cached_input": cached, "uncached_input": max(0, inp - cached), "output": out,
              "reasoning_output": usage.get("reasoning_output_tokens", 0), "total": inp + out,
              "raw_usage": usage} if usage else None
    return {"tokens": tokens, "cost_usd": None, "tool_calls": len(tools), "tools": tools, "turns": turns,
            "final_message": final, "errors": errors, **inspect_trace(trace)}


def notes_snapshot(data):
    notes = data / "Notes"
    return {f.name: f.read_text(errors="replace") for f in sorted(notes.glob("*.md"))} if notes.is_dir() else {}


def run(task_id, agent, run_id, results_dir, overrides=None, contender=None, on_agent_start=None):
    named = agent
    agent, via_mcp = split_agent(agent)
    if agent not in MODELS:
        raise SystemExit("agent must be claude, codex, mcp-claude or mcp-codex")
    opts = options(overrides)
    data, _, codex_home = lane_paths(opts)
    task = registry.task(task_id, int(opts.get("port_offset") or 0))
    model, effort = opts.get("model") or MODELS[agent][0], opts.get("effort") or MODELS[agent][1]
    deadline = int(opts.get("deadline_s") or task["deadline_s"])
    results_dir = Path(results_dir)
    runs_dir = results_dir / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    out_json = runs_dir / f"{run_id}.json"
    events = runs_dir / f"{run_id}.events.jsonl"
    stderr = runs_dir / f"{run_id}.stderr.log"
    cli = cli_info(opts)
    servers.start(task)
    state, reused = ensure_instance(opts)
    stop_browse_daemons(data)
    if not opts["keep_notes"]:
        shutil.rmtree(data / "Notes", ignore_errors=True)
    baseline = reset_task(task)
    tab = prepare_tab(opts, task)
    workdir = WORK / run_id
    if workdir.exists():
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True)
    target = "claude-code" if agent == "claude" else "codex"
    if not via_mcp:
        sh([ardia_bin(opts), "skills", "install", "--target", target, "--project"], cwd=workdir,
           env=agent_env(opts)).check_returncode()
    prompt = f"{task['prompt']}\n\n{mcp_line(opts) if via_mcp else reach_line(opts)}"
    extra = {"ARDIA_DATA_DIR": str(data)}
    if opts["humanize"]:
        extra["AGENT_BROWSER_HUMANIZE"] = "1"
    server = mcp_server(opts, data) if via_mcp else None
    if agent == "codex":
        extra.update(codex_env(codex_home))
        cmd = mcp_codex_command(model, effort, workdir, prompt, server) if via_mcp else codex_command(model, effort, workdir, prompt)
    elif via_mcp:
        extra["ENABLE_TOOL_SEARCH"] = "false"
        cmd = mcp_claude_command(model, effort, prompt, write_mcp_config(workdir / "ardia-mcp.json", server))
    else:
        cmd = claude_command(model, effort, prompt)
    env = agent_env(opts, extra)
    front_before = front_pid()
    started_at = datetime.datetime.now().astimezone()
    log(f"{run_id}: {agent} on {task_id} (Ardia pid {state['pid']}, {'reused' if reused else 'launched'})")
    with open(events, "wb") as fo, open(stderr, "wb") as fe:
        if on_agent_start:
            on_agent_start()
        start_epoch = time.time()
        t0 = time.monotonic()
        proc = spawn_agent(cmd, cwd=workdir, env=env, stdin=subprocess.DEVNULL, stdout=fo, stderr=fe)
        timed_out = False
        try:
            code = proc.wait(timeout=deadline)
        except subprocess.TimeoutExpired:
            timed_out = True
            kill_group(proc)
            code = proc.returncode
        wall = time.monotonic() - t0
    front_after = front_pid()
    kill_group(proc, grace=2)
    daemons = stop_browse_daemons(data)
    try:
        check = http(task["check"]["method"], task["check"]["url"])
    except Exception as e:
        check = {"pass": False, "error": str(e)}
    passed, reset_by_agent = grading.grade(check, timed_out, baseline_reset_at_ms=baseline.get("reset_at_ms"))
    completed = check.get("completed_at_ms")
    lines = read_jsonl(events)
    parsed = (parse_claude if agent == "claude" else parse_codex)(lines)
    via = mcp_stats(agent, lines) if via_mcp else None
    shell_count = sum(1 for t in parsed["tools"] if t["name"] in SHELL_TOOLS)
    record = {
        "run_id": run_id, "side": "ardia", "contender": contender or f"ardia-{named}", "agent": agent,
        "task": task_id, "started_at": started_at.isoformat(timespec="milliseconds"),
        "model": model, "effort": effort, "claude_route": claude_route_label(opts) if agent == "claude" else None,
        "cli": cli, "humanize": opts["humanize"], "notes_kept": opts["keep_notes"],
        "notes_after": notes_snapshot(data), "lane": opts.get("lane"), "port_offset": task["port_offset"],
        "wall_s": round(wall, 3), "timed_out": timed_out, "deadline_s": deadline, "exit_code": code,
        "pass": passed, "reset_by_agent": reset_by_agent,
        "time_to_correct_s": round(completed / 1000 - start_epoch, 3) if passed and completed else None,
        "commands": shell_count + via["mcp_calls"] if via else shell_count,
        "matched": check.get("matched"), "total": check.get("total"), "extra": check.get("extra"),
        "method": check.get("method"), "invariants": check.get("invariants"),
        "check": check, "check_details": check.get("details"), **parsed,
        "prompt": prompt, "command": cmd, "workdir": str(workdir),
        "instance": {"pid": state["pid"], "port": opts["port"], "app": state["app"], "ardia_test": opts["ardia_test"],
                     "reused": reused, "launch_s": state.get("launch_s"), "tab_before_run": tab},
        "focus": {"front_pid_before": front_before, "front_pid_after": front_after,
                  "ours_in_front": state["pid"] in (front_before, front_after)},
        "browse_daemons_stopped": daemons, "events_file": str(events), "stderr_file": str(stderr),
    }
    if via:
        record.update(via, via="mcp", mcp_server=server)
        record["output_chars"] = (record.get("output_chars") or 0) + via["mcp_output_chars"]
        shortcuts = dict(record.get("shortcuts") or {})
        shortcuts["source_peeks"] = shortcuts.get("source_peeks", 0) + via["mcp_source_peeks"]
        shortcuts["direct_api"] = shortcuts.get("direct_api", 0) + via["mcp_direct_api"]
        record["shortcuts"] = shortcuts
    write_json(out_json, record)
    log(f"{run_id}: pass={passed} wall={record['wall_s']} s tokens={(record['tokens'] or {}).get('total')} "
        f"commands={record['commands']} -> {out_json}")
    return record


def quit_instance(opts=None):
    data, instance, _ = lane_paths(opts or {})
    state = read_json(instance)
    stopped = stop_browse_daemons(data) if data.exists() else []
    if not state:
        log("no recorded Ardia instance")
    elif not same_process(state):
        log(f"recorded Ardia pid {state['pid']} is gone or not ours; nothing to quit")
    else:
        log(f"Ardia pid {state['pid']} {'quit' if terminate(state) else 'still running'}")
    instance.unlink(missing_ok=True)
    if stopped:
        log(f"stopped ardia browse daemons {stopped}")
