use crate::json::{self, Map, Style, Value};
use crate::printable::shown;
use crate::py::{self, dict, get_or_null, iterate_or_empty, str_of, truthy, Shape, Unsupported};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Tabs,
    Groups,
    Windows,
    Commands,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Tabs => "tabs",
            Kind::Groups => "groups",
            Kind::Windows => "windows",
            Kind::Commands => "commands",
        }
    }

    pub fn method(self) -> &'static str {
        match self {
            Kind::Tabs | Kind::Groups => "workspace",
            Kind::Windows => "windows",
            Kind::Commands => "commands",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Listing {
    pub data_dir: Option<String>,
    pub json: bool,
    pub window: Option<String>,
    pub profile: Option<String>,
    pub flat: bool,
    pub usage: bool,
    pub pid: Option<u64>,
}

impl Listing {
    pub fn wants_usage(&self) -> bool {
        self.usage || self.pid.is_some()
    }

    pub fn params(&self, kind: Kind) -> Option<Value> {
        if !matches!(kind, Kind::Tabs | Kind::Groups) {
            return None;
        }
        let mut params = Map::new();
        for (key, value) in [("window", &self.window), ("profile", &self.profile)] {
            if let Some(value) = value.as_ref().filter(|value| !value.is_empty()) {
                params.insert(key, Value::str(value));
            }
        }
        if self.wants_usage() {
            params.insert("usage", Value::Bool(true));
        }
        Some(Value::Object(params))
    }
}

#[derive(Debug, Default, PartialEq)]
pub struct Rendered {
    pub lines: Vec<String>,
    pub complaint: Option<String>,
    pub status: i64,
    pub error_code: Option<String>,
}

impl Rendered {
    fn say(&mut self, line: String) {
        self.lines.push(line);
    }

    fn fail(mut self, status: i64, code: Option<&str>, complaint: String) -> Rendered {
        self.status = status;
        self.error_code = code.map(str::to_string);
        self.complaint = Some(complaint);
        self
    }
}

fn pretty(value: &Value) -> String {
    json::dumps(value, Style::Indented, false)
}

fn shown_of(value: &Value) -> Shape<String> {
    match value {
        Value::Null => Ok(String::new()),
        other => Ok(shown(&str_of(other)?)),
    }
}

pub fn render(kind: Kind, listing: &Listing, result: &Value) -> Shape<Rendered> {
    match kind {
        Kind::Windows => windows(listing, result),
        Kind::Commands => commands(listing, result),
        Kind::Tabs => tabs(listing, result),
        Kind::Groups => groups(listing, result),
    }
}

fn windows(listing: &Listing, result: &Value) -> Shape<Rendered> {
    let mut out = Rendered::default();
    if listing.json {
        out.say(pretty(result));
        return Ok(out);
    }
    for window in iterate_or_empty(result)? {
        let Value::Object(fields) = &window else { continue };
        let mut flags = vec![str_of(fields.get("kind").unwrap_or(&Value::str("normal")))?];
        if fields.get("focused").is_some_and(truthy) {
            flags.push("focused".into());
        }
        let profile = [fields.get("profileName"), fields.get("profile")]
            .into_iter()
            .flatten()
            .find(|value| truthy(value))
            .map_or(Ok(String::new()), str_of)?;
        let id = str_of(fields.get("id").unwrap_or(&Value::Null))?;
        out.say(shown(py::rstrip(&format!("window {id}  {}  {profile}", flags.join(", ")))));
        for tab in iterate_or_empty(fields.get("tabs").unwrap_or(&Value::Null))? {
            let tab = dict(&tab)?;
            let marks = format!(
                "{}{}",
                if tab.get("active").is_some_and(truthy) { "*" } else { " " },
                if tab.get("pinned").is_some_and(truthy) { "p" } else { " " }
            );
            let group = match tab.get("group") {
                Some(group) if *group != Value::Null => format!("  (group {})", str_of(group)?),
                _ => String::new(),
            };
            let title = tab.get("title").filter(|title| truthy(title)).map_or(Ok(String::new()), str_of)?;
            let url = str_of(tab.get("url").unwrap_or(&Value::str("")))?;
            let id = str_of(tab.get("id").unwrap_or(&Value::Null))?;
            out.say(shown(&format!("  {marks} {id}  {title}  {url}{group}")));
        }
    }
    Ok(out)
}

fn commands(listing: &Listing, result: &Value) -> Shape<Rendered> {
    let mut out = Rendered::default();
    if listing.json {
        out.say(pretty(result));
        return Ok(out);
    }
    let rows: Vec<Map> = iterate_or_empty(result)?
        .into_iter()
        .filter_map(|row| if let Value::Object(map) = row { Some(map) } else { None })
        .collect();
    let mut ids = Vec::new();
    for row in &rows {
        ids.push(str_of(row.get("id").unwrap_or(&Value::str("")))?);
    }
    let width = ids.iter().map(|id| crate::pystr::len(id)).max().unwrap_or(0).min(40);
    for (row, id) in rows.iter().zip(ids) {
        let tail = match row.get("variants").filter(|variants| truthy(variants)) {
            Some(variants) => format!("  [{}]", iterate_or_empty(variants)?.iter().map(str_of).collect::<Shape<Vec<_>>>()?.join(", ")),
            None => String::new(),
        };
        let title = str_of(row.get("title").unwrap_or(&Value::str("")))?;
        out.say(shown(&format!("{}  {title}{tail}", py::left(&id, width))));
    }
    Ok(out)
}

const DEEPEST_GROUP_PYTHON_SURELY_WALKS: usize = 500;

fn objects_in(items: &Value) -> Shape<&[Value]> {
    match items {
        _ if !truthy(items) => Ok(&[]),
        Value::Array(items) => Ok(items),
        Value::Str(_) | Value::Object(_) => Ok(&[]),
        _ => Err(Unsupported),
    }
}

fn walk<'a>(items: &'a Value, depth: usize, into: &mut Vec<(&'a Value, usize)>) -> Shape<()> {
    for item in objects_in(items)? {
        let Value::Object(fields) = item else { continue };
        into.push((item, depth));
        if matches!(fields.get("type").and_then(Value::as_str), Some("group" | "folder")) {
            if depth >= DEEPEST_GROUP_PYTHON_SURELY_WALKS {
                return Err(Unsupported);
            }
            walk(fields.get("items").unwrap_or(&Value::Null), depth + 1, into)?;
        }
    }
    Ok(())
}

const SECTIONS: [(&str, &str); 3] = [("Top Apps", "topApps"), ("Pinned", "pinned"), ("Tabs", "tabs")];

fn spaces(tree: &Value) -> Shape<Vec<(Value, Value)>> {
    let mut out = Vec::new();
    for window in iterate_or_empty(get_or_null(tree, "windows")?)? {
        dict(&window)?;
        for space in iterate_or_empty(get_or_null(&window, "spaces")?)? {
            dict(&space)?;
            out.push((window.clone(), space));
        }
    }
    Ok(out)
}

fn merged(item: &Value, extra: Vec<(&str, Value)>, skip: Option<&str>) -> Value {
    let mut map = Map::new();
    if let Value::Object(fields) = item {
        for (key, value) in fields.iter() {
            if Some(key.as_str()) != skip {
                map.insert(key, value.clone());
            }
        }
    }
    for (key, value) in extra {
        map.insert(key, value);
    }
    Value::Object(map)
}

fn flat_tabs(tree: &Value) -> Shape<Vec<Value>> {
    let mut out = Vec::new();
    for (window, space) in spaces(tree)? {
        for (section, key) in SECTIONS {
            let mut walked = Vec::new();
            walk(get_or_null(&space, key)?, 0, &mut walked)?;
            for (item, _) in walked {
                if item.get("type") == Some(&Value::str("tab")) {
                    out.push(merged(
                        item,
                        vec![
                            ("window", get_or_null(&window, "id")?.clone()),
                            ("profile", get_or_null(&space, "profile")?.clone()),
                            ("section", Value::str(section)),
                        ],
                        None,
                    ));
                }
            }
        }
    }
    Ok(out)
}

fn flat_groups(tree: &Value) -> Shape<Vec<Value>> {
    let mut out = Vec::new();
    for (window, space) in spaces(tree)? {
        for (_, key) in SECTIONS {
            let mut walked = Vec::new();
            walk(get_or_null(&space, key)?, 0, &mut walked)?;
            for (index, &(item, depth)) in walked.iter().enumerate() {
                if item.get("type") == Some(&Value::str("group")) {
                    let tabs = walked[index + 1..]
                        .iter()
                        .take_while(|(_, inner)| *inner > depth)
                        .filter(|(tab, _)| tab.get("type") == Some(&Value::str("tab")))
                        .map(|(tab, _)| tab.get("id").cloned().unwrap_or(Value::Null))
                        .collect();
                    out.push(merged(
                        item,
                        vec![
                            ("window", get_or_null(&window, "id")?.clone()),
                            ("profile", get_or_null(&space, "profile")?.clone()),
                            ("depth", Value::Int(depth as i128)),
                            ("tabs", Value::Array(tabs)),
                        ],
                        Some("items"),
                    ));
                }
            }
        }
    }
    Ok(out)
}

fn tab_line(tab: &Value, prefix: &str) -> Shape<String> {
    let fields = dict(tab)?;
    let mut marks = Vec::new();
    if fields.get("muted").is_some_and(truthy) {
        marks.push("muted".to_string());
    }
    if fields.get("asleep").is_some_and(truthy) {
        marks.push("asleep".to_string());
    }
    if let Some(pin) = fields.get("pin").filter(|pin| truthy(pin)) {
        marks.push(format!("pinned {}", str_of(pin)?));
    }
    let title = shown_of(fields.get("title").unwrap_or(&Value::Null))?;
    let tail = if marks.is_empty() {
        String::new()
    } else {
        format!("  ({})", shown(&marks.join(", ")))
    };
    let active = if fields.get("active").is_some_and(truthy) { "*" } else { " " };
    let id = shown_of(fields.get("id").unwrap_or(&Value::Null))?;
    let url = shown_of(fields.get("url").unwrap_or(&Value::Null))?;
    Ok(py::rstrip(&format!("{active} {prefix}{id}  {title}  {url}{tail}")).to_string())
}

fn group_line(group: &Value, indent: &str) -> Shape<String> {
    let fields = dict(group)?;
    let mut looks = Vec::new();
    for key in ["icon", "color"] {
        if let Some(value) = fields.get(key).filter(|value| truthy(value) && **value != Value::str("neutral")) {
            looks.push(shown_of(value)?);
        }
    }
    if fields.get("collapsed").is_some_and(truthy) {
        looks.push("collapsed".into());
    }
    if fields.get("pinned").is_some_and(truthy) {
        looks.push("pinned".into());
    }
    let label = fields.get("label").filter(|label| truthy(label)).cloned().unwrap_or(Value::str(""));
    let mut parts = vec![
        format!("group {}", shown_of(fields.get("id").unwrap_or(&Value::Null))?),
        shown(&json::dumps(&label, Style::Spaced, false)),
    ];
    if !looks.is_empty() {
        parts.push(looks.join(" "));
    }
    if fields.contains("window") {
        parts.push(format!("window {}", shown_of(get_or_null(group, "window")?)?));
        parts.push(format!("profile {}", shown_of(fields.get("profile").ok_or(Unsupported)?)?));
        if let Some(parent) = fields.get("parent").filter(|parent| truthy(parent)) {
            parts.push(format!("in {}", shown_of(parent)?));
        }
    }
    if let Some(tabs) = fields.get("tabs") {
        parts.push(format!("{} tabs", py::length(tabs)?));
    }
    Ok(format!("{indent}{}", parts.join("  ")))
}

fn heat(tab: &Value) -> Shape<(bool, f64, f64)> {
    let cpu = get_or_null(tab, "cpu")?;
    let memory = get_or_null(tab, "memory")?;
    let level = |value: &Value| -> Shape<f64> {
        if !truthy(value) {
            return Ok(0.0);
        }
        Ok(-py::number(value)?)
    };
    Ok((*cpu == Value::Null && *memory == Value::Null, level(cpu)?, level(memory)?))
}

fn by_heat(tabs: Vec<Value>) -> Shape<Vec<Value>> {
    let mut keyed = Vec::new();
    for tab in tabs {
        keyed.push((heat(&tab)?, tab));
    }
    keyed.sort_by(|(a, _), (b, _)| {
        let equal = std::cmp::Ordering::Equal;
        a.0.cmp(&b.0)
            .then(a.1.partial_cmp(&b.1).unwrap_or(equal))
            .then(a.2.partial_cmp(&b.2).unwrap_or(equal))
    });
    Ok(keyed.into_iter().map(|(_, tab)| tab).collect())
}

fn megabytes(memory: &Value) -> Shape<String> {
    if py::is_number(memory) {
        Ok(format!("{:.0} MB", py::number(memory)? / 1_000_000.0))
    } else {
        Ok("-".into())
    }
}

fn usage_line(tab: &Value) -> Shape<String> {
    let pid = match get_or_null(tab, "pid")? {
        Value::Bool(flag) => u8::from(*flag).to_string(),
        value if py::is_int(value) => str_of(value)?,
        _ => "-".into(),
    };
    let cpu = get_or_null(tab, "cpu")?;
    let cpu = if py::is_number(cpu) { format!("{:.1}", py::number(cpu)?) } else { "-".into() };
    let memory = megabytes(get_or_null(tab, "memory")?)?;
    Ok(format!(
        "{}  {}  {}  {}",
        py::right(&pid, 7),
        py::right(&cpu, 6),
        py::right(&memory, 8),
        tab_line(tab, "")?
    ))
}

fn print_usage(out: &mut Rendered, tabs: &[Value]) -> Shape<()> {
    out.say(format!("{}  {}  {}    TAB", py::right("PID", 7), py::right("CPU%", 6), py::right("MEMORY", 8)));
    for tab in tabs {
        out.say(usage_line(tab)?);
    }
    let any_pid = tabs.iter().any(|tab| tab.get("pid").is_some_and(py::is_int));
    let any_memory = tabs.iter().any(|tab| tab.get("memory").is_some_and(|memory| *memory != Value::Null));
    if !tabs.is_empty() && !any_pid && any_memory {
        out.say("(this Ardia doesn't report process ids yet, only CPU and memory; update Ardia for the PID column)".into());
    }
    Ok(())
}

fn tabs(listing: &Listing, tree: &Value) -> Shape<Rendered> {
    let mut out = Rendered::default();
    if let Some(pid) = listing.pid {
        let tabs = flat_tabs(tree)?;
        if !tabs.iter().any(|tab| tab.get("pid").is_some_and(py::is_int)) {
            return Ok(out.fail(
                1,
                Some("no_pid"),
                "ardia tabs: this Ardia doesn't report tab process ids yet; update Ardia (ardia tabs --usage still shows CPU and memory)".into(),
            ));
        }
        let found = by_heat(
            tabs.into_iter()
                .filter(|tab| tab.get("pid").is_some_and(|value| py::equals_int(value, pid)))
                .collect(),
        )?;
        if found.is_empty() {
            return Ok(out.fail(1, Some("no_tab"), format!("ardia tabs: no tab runs in process {pid}; it may be Ardia itself, its GPU or a utility process, an extension, or a frame of another site (ardia tabs --usage lists every tab's process)")));
        }
        if listing.json {
            out.say(pretty(&Value::Array(found)));
        } else {
            print_usage(&mut out, &found)?;
        }
        return Ok(out);
    }
    if listing.json {
        let shown = if listing.flat { Value::Array(flat_tabs(tree)?) } else { tree.clone() };
        out.say(pretty(&shown));
    } else if listing.usage {
        let tabs = by_heat(flat_tabs(tree)?)?;
        print_usage(&mut out, &tabs)?;
    } else if listing.flat {
        for tab in flat_tabs(tree)? {
            let prefix = format!("{}  {}  ", shown_of(get_or_null(&tab, "window")?)?, shown_of(get_or_null(&tab, "profile")?)?);
            out.say(tab_line(&tab, &prefix)?);
        }
    } else {
        print_tree(&mut out, tree)?;
    }
    Ok(out)
}

fn print_tree(out: &mut Rendered, tree: &Value) -> Shape<()> {
    for window in iterate_or_empty(get_or_null(tree, "windows")?)? {
        let fields = dict(&window)?;
        let mut flags = vec![str_of(fields.get("kind").unwrap_or(&Value::str("normal")))?];
        if fields.get("focused").is_some_and(truthy) {
            flags.push("focused".into());
        }
        out.say(format!(
            "window {}  {}",
            shown_of(fields.get("id").unwrap_or(&Value::Null))?,
            shown(&flags.join(", "))
        ));
        for space in iterate_or_empty(fields.get("spaces").unwrap_or(&Value::Null))? {
            let space_fields = dict(&space)?;
            let name = [space_fields.get("profileName"), space_fields.get("profile")]
                .into_iter()
                .flatten()
                .find(|value| truthy(value))
                .cloned()
                .unwrap_or_else(|| space_fields.get("profile").cloned().unwrap_or(Value::Null));
            let shown_flag = if space_fields.get("shown").is_some_and(truthy) { "  shown" } else { "" };
            out.say(format!(
                "  {} ({}){shown_flag}",
                shown_of(&name)?,
                shown_of(space_fields.get("profile").unwrap_or(&Value::Null))?
            ));
            for (section, key) in SECTIONS {
                let items = space_fields.get(key).unwrap_or(&Value::Null);
                if !truthy(items) {
                    continue;
                }
                out.say(format!("    {section}"));
                let mut walked = Vec::new();
                walk(items, 0, &mut walked)?;
                for (item, depth) in walked {
                    let indent = format!("      {}", "    ".repeat(depth));
                    match item.get("type").and_then(Value::as_str) {
                        Some("tab") => out.say(format!("{indent}{}", tab_line(item, "")?)),
                        Some("folder") => {
                            let name = item.get("name").filter(|name| truthy(name)).cloned().unwrap_or(Value::str(""));
                            out.say(format!(
                                "{indent}  folder {}  {}",
                                shown_of(item.get("id").unwrap_or(&Value::Null))?,
                                shown(&json::dumps(&name, Style::Spaced, false))
                            ));
                        }
                        _ => out.say(group_line(item, &format!("{indent}  "))?),
                    }
                }
            }
        }
    }
    Ok(())
}

fn groups(listing: &Listing, tree: &Value) -> Shape<Rendered> {
    let mut out = Rendered::default();
    let groups = flat_groups(tree)?;
    if listing.json {
        out.say(pretty(&Value::Array(groups)));
        return Ok(out);
    }
    for group in &groups {
        out.say(group_line(group, "")?);
    }
    Ok(out)
}

const SOCKET_ERROR_CODES: [&str; 8] =
    ["bad_request", "unknown_method", "unknown_command", "refused", "no_window", "failed", "unsupported_protocol", "password_manager_plugin"];

pub fn recorded_socket_code(code: &str) -> &str {
    if SOCKET_ERROR_CODES.contains(&code) {
        code
    } else {
        "other"
    }
}

pub fn method_failed(kind: Kind, listing: &Listing, code: &str, message: &str) -> Rendered {
    let out = Rendered::default();
    match kind {
        Kind::Windows | Kind::Commands => out.fail(1, None, format!("ardia {}: {message}", kind.name())),
        Kind::Tabs | Kind::Groups => {
            let command = kind.name();
            if listing.wants_usage() && code == "bad_request" && message.contains("not usage") {
                return out.fail(
                    1,
                    Some("unknown_method"),
                    format!("ardia {command}: this Ardia doesn't know --usage and --pid yet; update Ardia"),
                );
            }
            if code == "unknown_method" {
                out.fail(1, Some(code), format!("ardia {command}: this Ardia doesn't know {command} yet; update Ardia"))
            } else {
                out.fail(1, Some(recorded_socket_code(code)), format!("ardia {command}: {message}"))
            }
        }
    }
}

#[cfg(test)]
mod tests;
