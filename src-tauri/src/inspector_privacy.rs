use regex::{Regex, RegexSet};
use std::sync::OnceLock;

fn secret_patterns() -> &'static RegexSet {
    static PATTERNS: OnceLock<RegexSet> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        RegexSet::new([
            r"(?i)-----BEGIN [^\r\n]*PRIVATE KEY-----|PuTTY-User-Key-File-",
            r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[A-Za-z0-9_-]{35}\b",
            r"\b(?:gh[pousr]_|github_pat_|xox[baprs]-|sk-(?:ant-|proj-)?|hf_|npm_)[A-Za-z0-9_-]{12,}",
            r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
            r#"(?i)(?:[a-z][a-z0-9+.-]*://)[^\s/"'<>:@]+:[^\s/"'<>@]+@"#,
            r"(?i)\b(?:bearer|basic)\s+[a-z0-9._+/=-]{12,}",
            r#"(?i)\b[\w.-]*(?:password|passwd|pwd|passphrase|api[ _-]?key|client[ _-]?secret|access[ _-]?token|refresh[ _-]?token|auth[ _-]?token|private[ _-]?key|connection[ _-]?string|session[ _-]?cookie|secret|token|authorization|cookie)\b["']?\s*[:=]\s*[^\s,;}]+"#,
            r"\b[A-Za-z0-9_+/=-]{56,}\b",
        ])
        .expect("inspector secret patterns must compile")
    })
}

fn emails() -> &'static Regex {
    static EMAILS: OnceLock<Regex> = OnceLock::new();
    EMAILS.get_or_init(|| {
        Regex::new(r"(?i)[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}")
            .expect("inspector email pattern must compile")
    })
}

pub(crate) fn sensitive_path(name: &str) -> bool {
    name.chars()
        .any(|ch| ch.is_control() || direction_control(ch))
        || contains_credential(name)
        || emails().is_match(name)
}

fn direction_control(ch: char) -> bool {
    matches!(ch, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

pub(crate) fn contains_credential(text: &str) -> bool {
    secret_patterns().is_match(text)
}

pub(crate) fn clean_text(text: &str) -> Option<(String, bool)> {
    if text.chars().any(direction_control) || contains_credential(text) {
        return None;
    }
    let sanitized = emails().replace_all(text, "[email redacted]");
    let redacted = matches!(sanitized, std::borrow::Cow::Owned(_));
    Some((sanitized.into_owned(), redacted))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_credentials_and_removes_email_addresses() {
        for text in [
            "db_password = \"fixture-value\"",
            "https://demo:fixture-value@example.invalid/path",
            "ghp_fixture_fixture_fixture",
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "Authorization: Bearer fixture-value-here",
            "\"accessToken\": \"fixture-value\"",
        ] {
            assert!(clean_text(text).is_none(), "{text}");
        }
        assert_eq!(
            clean_text("Contact fixture@example.invalid").unwrap(),
            ("Contact [email redacted]".into(), true)
        );
        assert!(sensitive_path("fixture@example.invalid.md"));
    }
}
