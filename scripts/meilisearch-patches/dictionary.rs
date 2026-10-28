//! Shared external Jieba text validation. No data or default dictionary is embedded.
#[derive(Debug)]
#[allow(dead_code)]
pub struct DictionaryStats {
    pub entries: usize,
}

/// Accept `word positive-frequency [tag]`. Blank lines are ignored.
pub fn validate_dictionary(text: &str) -> Result<DictionaryStats, String> {
    let mut entries = 0usize;
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<_> = line.split_whitespace().collect();
        if !(2..=3).contains(&fields.len()) {
            return Err(format!("line {}: expected word frequency [tag]", index + 1));
        }
        if fields[1].is_empty() || !fields[1].bytes().all(|b| b.is_ascii_digit()) {
            return Err(format!("line {}: frequency must be a positive integer", index + 1));
        }
        let frequency = fields[1].parse::<usize>().map_err(|_| {
            format!("line {}: frequency does not fit this platform's usize", index + 1)
        })?;
        entries += 1;
        if frequency == 0 {
            return Err(format!("line {}: frequency must be positive", index + 1));
        }
    }
    if entries == 0 {
        return Err("dictionary contains no entries".into());
    }
    Ok(DictionaryStats { entries })
}

#[cfg(test)]
mod tests {
    use super::validate_dictionary;
    #[test]
    fn accepts_positive_frequencies() {
        let stats = validate_dictionary("詞 1 n\n正頻 8\n").unwrap();
        assert_eq!(stats.entries, 2);
    }
    #[test]
    fn rejects_ambiguous_or_unusable_input() {
        for input in ["", "詞 -1 n", "詞 1.5 n", "詞 0 n", "有 空白 3 n", "詞 3 n extra"] {
            assert!(validate_dictionary(input).is_err(), "{input:?}");
        }
    }
}
