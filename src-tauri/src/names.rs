/// Turn a user-typed rename into a safe file base name, or `None` when nothing
/// usable is left (the photo then keeps its original name).
///
/// The name ends up inside `unique/jpg/` and `unique/raw/`, so it must stay a
/// single path segment on every OS: no separators (`Meeting 14/10` would try to
/// create a sub-folder), no characters Windows rejects (`18:00`), no `..`, no
/// absolute paths, no reserved device names. Offending characters become `-`.
/// The frontend mirrors this in `src/lib/names.ts` to preview the result.
pub fn sanitize_name(raw: &str) -> Option<String> {
    const MAX_CHARS: usize = 100;

    let replaced: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();

    // Collapse whitespace runs, then strip what Windows silently drops (trailing
    // dots and spaces) and leading dots (hidden files on Unix, `..` traversal).
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut name = collapsed
        .trim_start_matches('.')
        .trim_end_matches(['.', ' '])
        .trim()
        .to_string();

    if name.chars().count() > MAX_CHARS {
        name = name.chars().take(MAX_CHARS).collect::<String>();
        name = name.trim_end_matches(['.', ' ']).to_string();
    }
    if name.is_empty() {
        return None;
    }
    if is_reserved_on_windows(&name) {
        // `NUL.txt` is still the device, so the suffix goes before the first dot.
        let at = name.find('.').unwrap_or(name.len());
        name.insert(at, '_');
    }
    Some(name)
}

/// `CON`, `NUL`, `COM1` ... are device names on Windows, with or without an
/// extension, in any case.
fn is_reserved_on_windows(name: &str) -> bool {
    let head = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(head.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (head.len() == 4
            && (head.starts_with("COM") || head.starts_with("LPT"))
            && head.as_bytes()[3].is_ascii_digit()
            && head.as_bytes()[3] != b'0')
}

#[cfg(test)]
mod tests {
    use super::sanitize_name;

    #[test]
    fn keeps_ordinary_names() {
        assert_eq!(sanitize_name("Hackathon 2026").as_deref(), Some("Hackathon 2026"));
        assert_eq!(sanitize_name("  spaced   out  ").as_deref(), Some("spaced out"));
        assert_eq!(sanitize_name("Zażółć gęślą").as_deref(), Some("Zażółć gęślą"));
    }

    #[test]
    fn separators_and_windows_characters_become_dashes() {
        assert_eq!(sanitize_name("Spotkanie 14/10").as_deref(), Some("Spotkanie 14-10"));
        assert_eq!(sanitize_name("start 18:00").as_deref(), Some("start 18-00"));
        assert_eq!(sanitize_name(r"a\b*c?d").as_deref(), Some("a-b-c-d"));
    }

    #[test]
    fn traversal_and_absolute_paths_cannot_escape() {
        assert_eq!(sanitize_name("../../evil").as_deref(), Some("-..-evil"));
        assert_eq!(sanitize_name("/etc/passwd").as_deref(), Some("-etc-passwd"));
        assert_eq!(sanitize_name(r"C:\Users\x").as_deref(), Some("C--Users-x"));
        assert_eq!(sanitize_name(".."), None);
        assert_eq!(sanitize_name("."), None);
    }

    #[test]
    fn empty_results_mean_no_rename() {
        assert_eq!(sanitize_name(""), None);
        assert_eq!(sanitize_name("   "), None);
        assert_eq!(sanitize_name("..."), None);
    }

    #[test]
    fn trailing_dots_are_dropped() {
        assert_eq!(sanitize_name("name.").as_deref(), Some("name"));
        assert_eq!(sanitize_name(".hidden").as_deref(), Some("hidden"));
    }

    #[test]
    fn reserved_device_names_get_a_suffix() {
        assert_eq!(sanitize_name("con").as_deref(), Some("con_"));
        assert_eq!(sanitize_name("COM1").as_deref(), Some("COM1_"));
        assert_eq!(sanitize_name("nul.txt").as_deref(), Some("nul_.txt"));
        assert_eq!(sanitize_name("COM0").as_deref(), Some("COM0"));
        assert_eq!(sanitize_name("console").as_deref(), Some("console"));
    }

    #[test]
    fn long_names_are_capped() {
        let long = "x".repeat(300);
        assert_eq!(sanitize_name(&long).unwrap().chars().count(), 100);
    }
}
