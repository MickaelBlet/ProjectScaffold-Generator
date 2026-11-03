// Diagnostics printed as clang does: `path:line:col: error: message`, the source lines below with
// their numbers, a `^~~~` mark, and generated lines (`+`) where they differ.
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use crate::style::Style;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Level {
    Error,
    Warning,
    Note,
}

/// Source lines shown at most, generated ones as well.
const MAX_LINES: usize = 6;
const TAB: usize = 8;

#[derive(Debug)]
pub struct Diagnostic {
    pub path: String,
    pub line: Option<usize>,
    /// Column (from 1, in characters) of the first excerpt line the mark starts at.
    pub col: Option<usize>,
    pub level: Level,
    pub message: String,
    /// Source lines: number, text.
    pub excerpt: Vec<(usize, String)>,
    /// Characters marked on the first excerpt line, from `col` (0: a single `^`).
    pub mark: Option<usize>,
    /// Lines the generator writes there.
    pub generated: Vec<String>,
    /// Excerpt lines shown at most.
    pub max_lines: usize,
}

/// Tabs expanded to spaces, as terminals show them.
fn expand(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c == '\t' {
            out.push_str(&" ".repeat(TAB - out.chars().count() % TAB));
        } else {
            out.push(c);
        }
    }
    out
}

/// Columns (from 1) of the first non-blank character of `line` and of its end.
pub fn content_span(line: &str) -> (usize, usize) {
    let start = line.chars().take_while(|c| c.is_whitespace()).count();
    (start + 1, line.trim_end().chars().count().saturating_sub(start))
}

static LINE_MESSAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^Line (\d+)(?: of (\S+))?: (.*)$").unwrap());

impl Diagnostic {
    pub fn new(path: &str, level: Level, message: &str) -> Diagnostic {
        Diagnostic {
            path: path.to_string(),
            line: None,
            col: None,
            level,
            message: message.to_string(),
            excerpt: vec![],
            mark: None,
            generated: vec![],
            max_lines: MAX_LINES,
        }
    }

    /// The line of `text` (the file at `path`) as excerpt, marked from its first non-blank character.
    pub fn at_line(mut self, line: usize, text: Option<&str>) -> Diagnostic {
        self.line = Some(line);
        let source = text.and_then(|t| t.split('\n').nth(line.wrapping_sub(1)));
        if let Some(source) = source {
            let source = source.trim_end_matches('\r');
            let (col, len) = content_span(source);
            self.col = Some(col);
            self.mark = Some(len.saturating_sub(1));
            self.excerpt = vec![(line, source.to_string())];
        }
        self
    }

    /// A message of the project's model (`Line N: …`, `Line N of file.idl: …`) at its line of
    /// `text`, the content of `path`.
    pub fn from_message(path: &str, text: Option<&str>, level: Level, msg: &str) -> Diagnostic {
        let Some(m) = LINE_MESSAGE.captures(msg) else { return Diagnostic::new(path, level, msg) };
        let line: usize = m[1].parse().unwrap_or(0);
        let (path, other) = match m.get(2) {
            Some(file) => {
                let p = Path::new(path).with_file_name(file.as_str());
                (p.to_string_lossy().into_owned(), std::fs::read_to_string(&p).ok())
            }
            None => (path.to_string(), None),
        };
        let text = if m.get(2).is_some() { other.as_deref() } else { text };
        Diagnostic::new(&path, level, &m[3]).at_line(line, text)
    }

    pub fn render(&self, st: Style) -> String {
        let mut loc = self.path.clone();
        if let Some(l) = self.line {
            loc += &format!(":{l}");
            if let Some(c) = self.col {
                loc += &format!(":{c}");
            }
        }
        let level = match self.level {
            Level::Error => st.error(),
            Level::Warning => st.warning(),
            Level::Note => st.note(),
        };
        let mut out = vec![format!("{}: {level} {}", st.bold(&loc), st.bold(&self.message))];
        let width = self.excerpt.iter().map(|(n, _)| n.to_string().len()).max().unwrap_or(0).max(4);
        let blank = " ".repeat(width);
        for (i, (n, text)) in self.excerpt.iter().take(self.max_lines).enumerate() {
            out.push(format!("{n:>width$} | {}", expand(text)));
            // The first line from the column, the next ones (a range) from their first character.
            let span = match (i, self.col, self.mark) {
                (0, Some(col), Some(len)) => Some((col, len)),
                (_, Some(_), Some(_)) => {
                    let (col, len) = content_span(text);
                    (len > 0).then(|| (col, len - 1))
                }
                _ => None,
            };
            if let Some((col, len)) = span {
                // Display columns of the mark, tabs expanded.
                let chars: Vec<char> = text.chars().collect();
                let at = |c: usize| {
                    expand(&chars[..c.min(chars.len())].iter().collect::<String>()).chars().count()
                };
                let start = at(col - 1);
                let end = at(col + len).max(start + 1);
                let marks = if i == 0 {
                    format!("^{}", "~".repeat(end - start - 1))
                } else {
                    "~".repeat(end - start)
                };
                out.push(format!("{blank} | {}{}", " ".repeat(start), st.caret(&marks)));
            }
        }
        if self.excerpt.len() > self.max_lines {
            out.push(format!("{blank} | … ({} more lines)", self.excerpt.len() - self.max_lines));
        }
        for g in self.generated.iter().take(MAX_LINES) {
            out.push(format!("{blank} + {}", st.green(&expand(g))));
        }
        if self.generated.len() > MAX_LINES {
            out.push(format!("{blank} + … ({} more lines)", self.generated.len() - MAX_LINES));
        }
        out.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render() {
        let text = "a: 1\n\tname: Client\n";
        let d = Diagnostic::from_message("p.yaml", Some(text), Level::Error, "Line 2: Duplicate 'Client'");
        assert_eq!(
            d.render(Style::default()),
            "p.yaml:2:2: error: Duplicate 'Client'\n   2 |         name: Client\n     |         ^~~~~~~~~~~~"
        );
        let d = Diagnostic::from_message("p.yaml", None, Level::Warning, "no line");
        assert_eq!(d.render(Style::default()), "p.yaml: warning: no line");
    }
}
