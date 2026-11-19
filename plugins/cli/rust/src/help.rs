pub const DESCRIPTION: &str = "Control a running Ardia from the terminal. ardia browse drives the browser (ardia browse --help); ardia computer operates native Mac apps through the bundled cua-driver (ardia computer --help). Agents: skip if an ardia skill is already in your context; otherwise run ardia --skill.";

pub const EPILOG: &str = "Shared options go before the command or after it, for the commands that take them:
  --port N        a plain DevTools server on 127.0.0.1:N (testing; $ARDIA_PORT)
  --ws URL        a browser WebSocket URL ($ARDIA_WS)
  --data-dir DIR  the Ardia data dir ($ARDIA_DATA_DIR, else the installed app's)
  --timeout S     and --json
A flag wins over its environment variable.

Examples:
  ardia --port 9222 browse snapshot -i
  ardia browse --port 9222 snapshot -i
  ardia windows --json
  ardia tabs --json
  ardia groups create tab-1 tab-2 --name Work --icon \u{1f680}
  ardia methods
  ardia call run -p command=newTab
";

pub const COMMANDS: &[(&str, &str)] = &[
    ("browse", "drive the browser with agent-browser's commands (ardia browse --help)"),
    ("notes", "read and write notes (ardia notes --help)"),
    (
        "computer",
        "operate native Mac apps through the bundled cua-driver: computer use (ardia computer --help)",
    ),
    ("pinned", "list favorites and pinned tabs"),
    ("history", "list recent history"),
    ("skills", "print or install the ardia agent skill"),
    ("scripts", "write, test and install userscripts"),
    ("config", "read, write and check config.json"),
    ("theme", "make, pick, edit and check themes"),
    ("run", "run one of Ardia's commands"),
    ("commands", "list the commands ardia run can run"),
    ("windows", "list Ardia's windows and their tabs"),
    ("events", "print events as they happen"),
    ("on", "run a program for each event"),
    ("hooks", "run hooks from hooks.json, at login if you like"),
    ("tabs", "list and organize tabs"),
    ("groups", "list and organize tab groups"),
    ("apply", "apply several tab and group operations at once (JSON)"),
    ("call", "send any method to Ardia's control socket (ardia methods lists them)"),
    ("methods", "list the methods ardia call can send"),
    ("plugins", "install, list and manage plugins"),
    ("feedback", "report a problem or idea to Ardia's developer (agents welcome)"),
    ("star", "star the Ardia repo on GitHub, only after the user says yes"),
];

const OPTIONS: &[(&str, &str)] = &[
    ("-h, --help", "show this help message and exit"),
    ("--version", "show program's version number and exit"),
    (
        "--skill",
        "print the agent skill that ships with this ardia (SKILL.md) and exit; same as ardia skills get",
    ),
];

const USAGE: &str = "ardia [-h] [--version] [--skill] <command> ...";

fn is_letter(c: char) -> bool {
    (c.is_alphanumeric() || c == '_') && !c.is_numeric()
}

fn chunks(text: &str) -> Option<Vec<String>> {
    let mut out = Vec::new();
    for (index, word) in text.split(' ').enumerate() {
        if index > 0 {
            out.push(" ".to_string());
        }
        if word.contains("--") && !word.starts_with("--") {
            return None;
        }
        let chars: Vec<char> = word.chars().collect();
        let mut start = 0;
        for at in 1..chars.len() {
            if chars[at] != '-' || at < 2 || at - start < 1 {
                continue;
            }
            let before = is_letter(chars[at - 1]) && is_letter(chars[at - 2]);
            let alternate = at >= 3 && is_letter(chars[at - 1]) && chars[at - 2] == '-' && is_letter(chars[at - 3]);
            let next = chars.get(at + 1).copied().is_some_and(is_letter)
                && (chars.get(at + 2).copied().is_some_and(is_letter)
                    || (chars.get(at + 2) == Some(&'-') && chars.get(at + 3).copied().is_some_and(is_letter)));
            if (before || alternate) && next {
                out.push(chars[start..=at].iter().collect());
                start = at + 1;
            }
        }
        out.push(chars[start..].iter().collect());
    }
    Some(out.into_iter().filter(|chunk| !chunk.is_empty()).collect())
}

fn wrap(text: &str, width: usize) -> Option<Vec<String>> {
    let mut pending = chunks(text)?;
    pending.reverse();
    let mut lines = Vec::new();
    while !pending.is_empty() {
        let mut line: Vec<String> = Vec::new();
        let mut length = 0;
        if !lines.is_empty() && pending.last().is_some_and(|chunk| chunk.trim().is_empty()) {
            pending.pop();
        }
        while let Some(chunk) = pending.last() {
            let size = chunk.chars().count();
            if length + size <= width {
                length += size;
                line.push(pending.pop().unwrap_or_default());
            } else {
                break;
            }
        }
        if pending.last().is_some_and(|chunk| chunk.chars().count() > width) {
            return None;
        }
        if line.last().is_some_and(|chunk| chunk.trim().is_empty()) {
            line.pop();
        }
        if !line.is_empty() {
            lines.push(line.concat());
        }
    }
    Some(lines)
}

fn columns() -> Option<usize> {
    let from_env = std::env::var_os("COLUMNS").map(|value| value.to_string_lossy().trim().to_string());
    let lines_set = std::env::var_os("LINES").is_some_and(|value| value.to_string_lossy().trim().parse::<i64>().is_ok_and(|lines| lines > 0));
    let parsed = match &from_env {
        Some(text) if text.is_empty() => 0,
        Some(text) => {
            let digits = text.strip_prefix('+').unwrap_or(text);
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                let negative = text
                    .strip_prefix('-')
                    .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()));
                if negative || !text.chars().any(char::is_numeric) {
                    0
                } else {
                    return None;
                }
            } else {
                digits.parse::<usize>().ok()?
            }
        }
        None => 0,
    };
    if parsed > 0 && lines_set {
        return Some(parsed);
    }
    let mut size: libc::winsize = unsafe { std::mem::zeroed() };
    let terminal = unsafe { libc::ioctl(1, libc::TIOCGWINSZ, &mut size) } == 0;
    if parsed > 0 {
        return Some(parsed);
    }
    if terminal && size.ws_col > 0 {
        Some(usize::from(size.ws_col))
    } else {
        Some(80)
    }
}

pub fn render() -> Option<String> {
    render_at(columns()?)
}

pub fn render_at(columns: usize) -> Option<String> {
    let width = columns.checked_sub(2)?;
    let max_help_position = 24.min(width.saturating_sub(20).max(4));
    let longest = COMMANDS
        .iter()
        .map(|(name, _)| name.chars().count() + 4)
        .chain(OPTIONS.iter().map(|(name, _)| name.chars().count() + 2))
        .chain(std::iter::once("<command>".len() + 2))
        .max()?;
    let help_position = (longest + 2).min(max_help_position);
    let help_width = width.saturating_sub(help_position).max(11);
    if "usage: ".len() + USAGE.len() > width {
        return None;
    }
    let item = |indent: usize, name: &str, help: &str| -> Option<String> {
        let action_width = help_position.checked_sub(indent + 2)?;
        let lines = wrap(help, help_width)?;
        let mut out = if name.chars().count() <= action_width {
            format!("{}{}  {}\n", " ".repeat(indent), crate::py::left(name, action_width), lines.first()?)
        } else {
            format!("{}{}\n{}{}\n", " ".repeat(indent), name, " ".repeat(help_position), lines.first()?)
        };
        for line in &lines[1..] {
            out.push_str(&format!("{}{}\n", " ".repeat(help_position), line));
        }
        Some(out)
    };
    let mut text = format!("usage: {USAGE}\n\n{DESCRIPTION}\n\n\npositional arguments:\n  <command>\n");
    for (name, help) in COMMANDS {
        text.push_str(&item(4, name, help)?);
    }
    text.push_str("\n\noptions:\n");
    for (name, help) in OPTIONS {
        text.push_str(&item(2, name, help)?);
    }
    text.push_str(&format!("\n{EPILOG}\n\n"));
    while text.contains("\n\n\n") {
        text = text.replace("\n\n\n", "\n\n");
    }
    Some(format!("{}\n", text.trim_matches('\n')))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_like_textwrap() {
        assert_eq!(
            wrap("operate native Mac apps through the bundled cua-driver: computer use", 40).unwrap(),
            vec!["operate native Mac apps through the", "bundled cua-driver: computer use",]
        );
        assert_eq!(wrap("aaaa bundled cua-driver", 16).unwrap(), vec!["aaaa bundled", "cua-driver"]);
        assert_eq!(wrap("aaaa bundled cua-driver", 17).unwrap(), vec!["aaaa bundled cua-", "driver"]);
        assert_eq!(chunks("(ardia browse --help)").unwrap(), vec!["(ardia", " ", "browse", " ", "--help)"]);
    }

    #[test]
    fn falls_back_when_the_usage_would_wrap() {
        assert!(render_at(40).is_none());
        let text = render_at(100).unwrap();
        assert!(text.starts_with("usage: ardia [-h] [--version] [--skill] <command> ...\n\n"));
        assert!(text.contains("\n    browse    drive the browser"));
        assert!(text.ends_with("--icon \u{1f680}\n  ardia methods\n  ardia call run -p command=newTab\n"));
    }
}
