use super::url;
use crate::py;

const MASK: &str = "***";
const TOKEN: &str = "token=";

#[derive(Default)]
pub struct Secrets {
    known: Vec<String>,
}

impl Secrets {
    fn remember(&mut self, secret: String) {
        if !self.known.contains(&secret) {
            self.known.push(secret);
        }
    }

    pub fn add(&mut self, secret: &str) {
        if secret.is_empty() {
            return;
        }
        self.remember(secret.to_string());
        self.remember(url::quote(secret));
    }

    pub fn redact(&self, text: &str) -> String {
        let mut ordered: Vec<&String> = self.known.iter().collect();
        ordered.sort_by_key(|secret| std::cmp::Reverse(secret.chars().count()));
        let mut text = text.to_string();
        for secret in ordered {
            if text.contains(secret.as_str()) {
                text = text.replace(secret.as_str(), MASK);
            }
        }
        mask_tokens(&text)
    }
}

fn token_char(c: char) -> bool {
    !matches!(c, '&' | '\'' | '"' | '<' | '>') && !py::is_space(c)
}

pub fn mask_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(found) = rest.find(TOKEN) {
        let after = &rest[found + TOKEN.len()..];
        let run = after.find(|c: char| !token_char(c)).unwrap_or(after.len());
        if run == 0 {
            let step = found + rest[found..].chars().next().map_or(1, char::len_utf8);
            out.push_str(&rest[..step]);
            rest = &rest[step..];
            continue;
        }
        out.push_str(&rest[..found]);
        out.push_str(TOKEN);
        out.push_str(MASK);
        rest = &after[run..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_like_redact_py() {
        let mut secrets = Secrets::default();
        secrets.add("ab/c");
        secrets.add("");
        assert_eq!(secrets.redact("x ab/c ab%2Fc y"), "x *** *** y");
        assert_eq!(
            mask_tokens("a?token=xyz&b=1 token= token=\"q\" token=token=p"),
            "a?token=***&b=1 token= token=\"q\" token=***"
        );
        assert_eq!(mask_tokens("token=é\u{3000}x"), "token=***\u{3000}x");
        assert_eq!(mask_tokens("ttoken=1"), "ttoken=***");
    }

    #[test]
    fn longest_secret_goes_first() {
        let mut secrets = Secrets::default();
        secrets.add("abc");
        secrets.add("abcdef");
        assert_eq!(secrets.redact("abcdef abc"), "*** ***");
    }
}
