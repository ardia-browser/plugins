use super::tables;

#[derive(Debug, Clone, PartialEq)]
pub struct BrowseError {
    pub message: String,
    pub code: Option<&'static str>,
    pub exit: i64,
}

impl BrowseError {
    pub fn plain(message: impl Into<String>) -> BrowseError {
        BrowseError {
            message: message.into(),
            code: None,
            exit: 1,
        }
    }

    pub fn unreachable(message: impl Into<String>) -> BrowseError {
        BrowseError {
            message: message.into(),
            code: None,
            exit: 2,
        }
    }

    pub fn outcome_unknown(name: &str, why: &str) -> BrowseError {
        BrowseError {
            message: format!("{why}; the outcome of `{name}` is unknown, so it wasn't retried"),
            code: Some("outcome_unknown"),
            exit: 1,
        }
    }
}

pub fn canonical(name: &str) -> &str {
    tables::ALIASES.iter().find(|(alias, _)| *alias == name).map_or(name, |(_, target)| target)
}

pub fn mutating(name: &str) -> bool {
    tables::MUTATING.contains(&name)
}

pub fn gone(command: &str) -> BrowseError {
    let name = canonical(command);
    if mutating(name) {
        return BrowseError::outcome_unknown(name, "the ardia browse daemon went away after it took the command (see the session log)");
    }
    BrowseError::unreachable("the ardia browse daemon closed the connection without answering (it may have exited; see the session log)")
}

pub fn stalled(command: &str, seconds: &str) -> BrowseError {
    let name = canonical(command);
    let why = format!("the ardia browse daemon didn't answer in {seconds} s (see the session log)");
    if mutating(name) {
        return BrowseError::outcome_unknown(name, &why);
    }
    BrowseError::unreachable(why)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_reads_from_actions() {
        assert_eq!(gone("get").exit, 2);
        let lost = gone("goto");
        assert_eq!(lost.code, Some("outcome_unknown"));
        assert!(lost.message.ends_with("the outcome of `open` is unknown, so it wasn't retried"));
        assert_eq!(
            stalled("click", "450").message.split(';').next(),
            Some("the ardia browse daemon didn't answer in 450 s (see the session log)")
        );
        assert_eq!(stalled("snapshot", "450").exit, 2);
    }
}
