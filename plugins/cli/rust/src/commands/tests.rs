use super::*;

fn tree() -> Value {
    json::parse(
        r#"{"windows":[{"id":"w-1","kind":"normal","focused":true,"spaces":[{"profile":"p-1","profileName":"Personal","shown":true,
        "topApps":[{"type":"tab","id":"tab-1","title":"Mail","url":"https://mail.example","pin":"tile","cpu":2.25,"memory":120000000,"pid":41}],
        "pinned":[{"type":"group","id":"g-1","label":"Work","icon":"🚀","color":"blue","pinned":true,"items":[{"type":"tab","id":"tab-2","title":"Docs\u001b","url":"https://docs.example","muted":true,"cpu":7.5,"memory":3000000,"pid":42}]}],
        "tabs":[{"type":"folder","id":"f-1","name":"Old","items":[{"type":"tab","id":"tab-3","title":"","url":"about:blank","asleep":true,"cpu":null,"memory":null,"pid":null}]}]}]}]}"#
            .as_bytes(),
    )
    .unwrap()
}

#[test]
fn prints_the_tree() {
    let out = tabs(&Listing::default(), &tree()).unwrap();
    assert_eq!(
        out.lines,
        vec![
            "window w-1  normal, focused",
            "  Personal (p-1)  shown",
            "    Top Apps",
            "        tab-1  Mail  https://mail.example  (pinned tile)",
            "    Pinned",
            "        group g-1  \"Work\"  🚀 blue pinned",
            "            tab-2  Docs\\u001b  https://docs.example  (muted)",
            "    Tabs",
            "        folder f-1  \"Old\"",
            "            tab-3    about:blank  (asleep)",
        ]
    );
}

#[test]
fn prints_usage_hottest_first() {
    let out = tabs(
        &Listing {
            usage: true,
            ..Default::default()
        },
        &tree(),
    )
    .unwrap();
    assert_eq!(out.lines[0], "    PID    CPU%    MEMORY    TAB");
    assert_eq!(out.lines[1], "     42     7.5      3 MB    tab-2  Docs\\u001b  https://docs.example  (muted)");
    assert_eq!(out.lines[2], "     41     2.2    120 MB    tab-1  Mail  https://mail.example  (pinned tile)");
    assert_eq!(out.lines[3], "      -       -         -    tab-3    about:blank  (asleep)");
    let missing = tabs(
        &Listing {
            pid: Some(7),
            ..Default::default()
        },
        &tree(),
    )
    .unwrap();
    assert_eq!((missing.status, missing.error_code.as_deref()), (1, Some("no_tab")));
}

#[test]
fn lists_groups_flat() {
    let out = groups(&Listing::default(), &tree()).unwrap();
    assert_eq!(out.lines, vec!["group g-1  \"Work\"  🚀 blue pinned  window w-1  profile p-1  1 tabs"]);
    let json = groups(
        &Listing {
            json: true,
            ..Default::default()
        },
        &tree(),
    )
    .unwrap();
    assert!(json.lines[0].contains("\"depth\": 0,\n    \"tabs\": [\n      \"tab-2\"\n    ]"));
}

#[test]
fn hands_odd_shapes_to_python() {
    assert_eq!(tabs(&Listing::default(), &Value::str("x")), Err(Unsupported));
    assert_eq!(windows(&Listing::default(), &Value::Int(3)), Err(Unsupported));
    assert!(windows(&Listing::default(), &Value::Null).unwrap().lines.is_empty());
}

fn nested_groups(depth: usize) -> Value {
    let mut items = Value::Array(vec![Value::object(vec![("type", Value::str("tab")), ("id", Value::str("t"))])]);
    for level in (0..depth).rev() {
        items = Value::Array(vec![Value::object(vec![
            ("type", Value::str("group")),
            ("id", Value::Str(format!("g{level}"))),
            ("items", items),
        ])]);
    }
    let space = Value::object(vec![("profile", Value::str("p")), ("tabs", items)]);
    let window = Value::object(vec![("id", Value::str("w")), ("spaces", Value::Array(vec![space]))]);
    Value::object(vec![("windows", Value::Array(vec![window]))])
}

#[test]
fn hands_groups_deeper_than_python_walks_to_python() {
    let checked = std::thread::Builder::new().stack_size(256 << 20).spawn(|| {
        for (depth, served) in [(500, true), (501, false), (2000, false)] {
            assert_eq!(tabs(&Listing::default(), &nested_groups(depth)).is_ok(), served, "{depth}");
        }
        assert!(groups(&Listing::default(), &nested_groups(60)).is_ok());
        assert_eq!(groups(&Listing::default(), &nested_groups(501)), Err(Unsupported));
    });
    checked.unwrap().join().unwrap();
}
