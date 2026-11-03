// User sections: parts of generated files kept across generations, between comment markers
//   // <user:Core.Sensor.setMode>
//   ...hand-written code...
//   // </user:Core.Sensor.setMode>
// Templates write them with `{% filter user('id') %}default content{% endfilter %}`.
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

// Markers written by the filter, turned into comment lines once the file is rendered.
const OPEN: char = '\u{E000}';
const CLOSE: char = '\u{E001}';
/// Written by filters whose output is empty, e.g. no description: the line holding it is dropped.
pub const DROP: &str = "\u{E002}";

static SENTINEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("\u{E000}([BE])([^\u{E001}]*)\u{E001}").unwrap());
static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[^\s<>]+$").unwrap());

/// The `user` filter: the default content of a section between its markers.
pub fn user_filter(body: String, id: minijinja::Value) -> Result<String, minijinja::Error> {
    let id = super::filters::text(&id);
    if !ID.is_match(&id) {
        return Err(minijinja::Error::new(
            minijinja::ErrorKind::InvalidOperation,
            format!("invalid user section id '{id}'"),
        ));
    }
    Ok(format!("{OPEN}B{id}{CLOSE}{body}{OPEN}E{id}{CLOSE}"))
}

fn leading(s: &str) -> &str {
    &s[..s.len() - s.trim_start_matches([' ', '\t']).len()]
}

/// Turns the markers of a rendered file into comment lines: each marker on a line of its own,
/// indented like the line where the section starts.
pub fn place_markers(text: &str, comment: &str) -> Result<String, String> {
    let mut out: Vec<String> = Vec::new();
    let mut open: Vec<(String, String)> = Vec::new();
    for raw in text.split('\n') {
        let mut line = Some(raw.to_string());
        while let Some(l) = line.take() {
            let Some(m) = SENTINEL.captures(&l) else {
                out.push(l);
                break;
            };
            let whole = m.get(0).unwrap();
            let before = &l[..whole.start()];
            let after = &l[whole.end()..];
            let id = m[2].to_string();
            let indent;
            if &m[1] == "B" {
                indent = leading(before).to_string();
                if !before.trim().is_empty() {
                    out.push(before.trim_end().to_string());
                }
                out.push(format!("{indent}{comment} <user:{id}>"));
                open.push((id, indent.clone()));
            } else {
                let section = open.pop();
                match section {
                    Some((sid, sindent)) if sid == id => {
                        if !before.trim().is_empty() {
                            out.push(before.to_string());
                        }
                        indent = sindent;
                    }
                    _ => return Err(format!("user section '{id}' closed out of order")),
                }
                out.push(format!("{indent}{comment} </user:{id}>"));
            }
            if !after.trim().is_empty() {
                line = Some(format!("{indent}{}", after.trim_start()));
            }
        }
    }
    if let Some((id, _)) = open.first() {
        return Err(format!("user section '{id}' not closed"));
    }
    Ok(out.join("\n"))
}

#[derive(Debug, Clone)]
pub struct Section {
    pub id: String,
    /// Lines between the markers, joined with '\n'.
    pub content: String,
    /// Line index of the opening and closing markers.
    pub start: usize,
    pub end: usize,
}

fn marker_re(comment: &str) -> Regex {
    Regex::new(&format!(r"^[ \t]*{}[ \t]*<(/?)user:([^\s<>]+)>[ \t]*\r?$", regex::escape(comment))).unwrap()
}

/// User sections of a file, in order.
pub fn extract_sections(text: &str, comment: &str) -> Result<Vec<Section>, String> {
    let re = marker_re(comment);
    let lines: Vec<&str> = text.split('\n').collect();
    let mut sections = Vec::new();
    let mut seen = HashSet::new();
    let mut current: Option<(String, usize)> = None;
    for (i, line) in lines.iter().enumerate() {
        let Some(m) = re.captures(line) else { continue };
        let id = m[2].to_string();
        if m[1].is_empty() {
            if let Some((cid, _)) = &current {
                return Err(format!("line {}: user section '{id}' opened inside '{cid}'", i + 1));
            }
            if !seen.insert(id.clone()) {
                return Err(format!("line {}: user section '{id}' appears twice", i + 1));
            }
            current = Some((id, i));
        } else {
            match current.take() {
                Some((cid, start)) if cid == id => {
                    sections.push(Section { id, content: lines[start + 1..i].join("\n"), start, end: i })
                }
                _ => return Err(format!("line {}: unexpected end of user section '{id}'", i + 1)),
            }
        }
    }
    if let Some((id, _)) = current {
        return Err(format!("user section '{id}' not closed"));
    }
    Ok(sections)
}

/// The text with the content of each section replaced by `fill(section)`.
fn replace_sections(
    text: &str,
    comment: &str,
    mut fill: impl FnMut(&Section) -> String,
) -> Result<String, String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut at = 0;
    for s in extract_sections(text, comment)? {
        out.extend(lines[at..=s.start].iter().map(|l| l.to_string()));
        let content = fill(&s);
        if !content.is_empty() {
            out.push(content);
        }
        at = s.end;
    }
    out.extend(lines[at..].iter().map(|l| l.to_string()));
    Ok(out.join("\n"))
}

pub struct MergeResult {
    pub text: String,
    /// Sections of the previous file the new one has no place for.
    pub orphans: Vec<Section>,
    /// Sections of the new text holding the previous file's content (not blank), in order.
    pub kept: Vec<Section>,
}

/// Puts the user sections of the previous file into the newly generated one, by id; those still
/// holding what was generated in them (`untouched`) take the new default content instead.
pub fn merge_sections(
    generated: &str,
    previous: &str,
    comment: &str,
    untouched: impl Fn(&Section) -> bool,
) -> Result<MergeResult, String> {
    // The file keeps its line endings.
    let crlf = previous.contains("\r\n");
    let old = extract_sections(&previous.replace("\r\n", "\n"), comment)?;
    let order: Vec<String> = old.iter().map(|s| s.id.clone()).collect();
    let mut kept: HashMap<String, Section> = old.into_iter().map(|s| (s.id.clone(), s)).collect();
    let mut carried = HashSet::new();
    let text = replace_sections(generated, comment, |s| match kept.remove(&s.id) {
        Some(old) if !untouched(&old) => {
            carried.insert(s.id.clone());
            old.content
        }
        _ => s.content.clone(),
    })?;
    let orphans = order.iter().filter_map(|id| kept.remove(id)).collect();
    let kept = extract_sections(&text, comment)?
        .into_iter()
        .filter(|s| carried.contains(&s.id) && !s.content.trim().is_empty())
        .collect();
    let text = if crlf { CRLF.replace_all(&text, "\r\n").into_owned() } else { text };
    Ok(MergeResult { text, orphans, kept })
}

static CRLF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n").unwrap());

/// The text with every section emptied: what a template generates, whatever the user wrote.
pub fn skeleton(text: &str, comment: &str) -> Result<String, String> {
    replace_sections(&text.replace("\r\n", "\n"), comment, |_| String::new())
}

/// Lines outside the user sections (markers included) with their line number (1-based).
fn outside_lines(text: &str, comment: &str) -> Result<Vec<(usize, String)>, String> {
    let text = text.replace("\r\n", "\n");
    let sections = extract_sections(&text, comment)?;
    let mut s = sections.iter().peekable();
    let mut out = Vec::new();
    for (i, line) in text.split('\n').enumerate() {
        while s.peek().is_some_and(|s| s.end < i) {
            s.next();
        }
        if !s.peek().is_some_and(|s| s.start < i && i < s.end) {
            out.push((i + 1, line.to_string()));
        }
    }
    Ok(out)
}

/// A difference of a file from what is generated, outside its user sections.
#[derive(Debug, PartialEq)]
pub struct Change {
    /// Lines of the file that differ (number from 1, text); none when generated lines are missing.
    pub lines: Vec<(usize, String)>,
    /// Line of the file the change comes after (0: at its start).
    pub after: usize,
    /// What is generated in their place.
    pub generated: Vec<String>,
}

/// Where `text` differs from `generated` outside their user sections.
pub fn changes(text: &str, generated: &str, comment: &str) -> Result<Vec<Change>, String> {
    let a = outside_lines(text, comment)?;
    let b = outside_lines(generated, comment)?;
    let eq = |i: usize, j: usize| a[i].1 == b[j].1;
    let prefix = (0..a.len().min(b.len())).take_while(|&k| eq(k, k)).count();
    let suffix = (0..(a.len() - prefix).min(b.len() - prefix))
        .take_while(|&k| eq(a.len() - 1 - k, b.len() - 1 - k))
        .count();
    let (n, m) = (a.len() - prefix - suffix, b.len() - prefix - suffix);
    // Longest common subsequence of the middle parts (one change when too large for it).
    let mut matches = Vec::new();
    if n > 0 && m > 0 && (n + 1) * (m + 1) <= 4_000_000 {
        let w = m + 1;
        let mut t = vec![0u32; (n + 1) * w];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                t[i * w + j] = if eq(prefix + i, prefix + j) {
                    t[(i + 1) * w + j + 1] + 1
                } else {
                    t[(i + 1) * w + j].max(t[i * w + j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n && j < m {
            if eq(prefix + i, prefix + j) {
                matches.push((i, j));
                (i, j) = (i + 1, j + 1);
            } else if t[(i + 1) * w + j] >= t[i * w + j + 1] {
                i += 1;
            } else {
                j += 1;
            }
        }
    }
    matches.push((n, m));
    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    for (mi, mj) in matches {
        if i < mi || j < mj {
            out.push(Change {
                lines: a[prefix + i..prefix + mi].to_vec(),
                after: if prefix + i == 0 { 0 } else { a[prefix + i - 1].0 },
                generated: b[prefix + j..prefix + mj].iter().map(|l| l.1.clone()).collect(),
            });
        }
        (i, j) = (mi + 1, mj + 1);
    }
    Ok(out)
}

/// Short non-cryptographic hash (cyrb53) over UTF-16 code units, hex: the TypeScript generator's.
pub fn hash(s: &str) -> String {
    let mut h1: u32 = 0xdeadbeef;
    let mut h2: u32 = 0x41c6ce57;
    for c in s.encode_utf16() {
        let c = c as u32;
        h1 = (h1 ^ c).wrapping_mul(2654435761);
        h2 = (h2 ^ c).wrapping_mul(1597334677);
    }
    h1 = (h1 ^ (h1 >> 16)).wrapping_mul(2246822507) ^ (h2 ^ (h2 >> 13)).wrapping_mul(3266489909);
    h2 = (h2 ^ (h2 >> 16)).wrapping_mul(2246822507) ^ (h1 ^ (h1 >> 13)).wrapping_mul(3266489909);
    let v = 4294967296u64 * (2097151 & h2) as u64 + h1 as u64;
    format!("{v:014x}")
}

/// Normalized section content for comparisons: line endings and trailing blanks ignored.
pub fn section_hash(content: &str) -> String {
    hash(content.replace("\r\n", "\n").trim_end())
}

/// Orphan sections as a file of their own, markers included.
pub fn format_orphans(sections: &[Section], comment: &str, from: &str) -> String {
    sections
        .iter()
        .map(|s| {
            format!(
                "{comment} from {from}\n{comment} <user:{id}>\n{content}{nl}{comment} </user:{id}>\n",
                id = s.id,
                content = s.content,
                nl = if s.content.is_empty() { "" } else { "\n" }
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_matches_typescript() {
        // Values printed by src/codegen/sections.ts' hash.
        assert_eq!(hash(""), "0bdcb81aee8d83");
        assert_eq!(hash("a"), "1c2ba782c97901");
        assert_eq!(hash("Core.Sensor é 😀"), "12a25b2f7049e5");
        assert_eq!(super::super::filters::uuid("Robot.Core"), "1f2b0b87-ffa5-8d09-aaed-f985b4501c01");
    }

    #[test]
    fn markers() {
        let t = format!("  x{OPEN}Bid{CLOSE}body{OPEN}Eid{CLOSE}y");
        assert_eq!(place_markers(&t, "//").unwrap(), "  x\n  // <user:id>\n  body\n  // </user:id>\n  y");
    }

    #[test]
    fn merge() {
        let generated = "a\n// <user:x>\ndefault\n// </user:x>\nb";
        let prev = "a\r\n// <user:x>\r\nmine\r\n// </user:x>\r\n// <user:y>\r\nold\r\n// </user:y>\r\nb";
        let r = merge_sections(generated, prev, "//", |_| false).unwrap();
        assert_eq!(r.text, "a\r\n// <user:x>\r\nmine\r\n// </user:x>\r\nb");
        assert_eq!(r.orphans.len(), 1);
        assert_eq!(r.kept.iter().map(|s| (s.id.as_str(), s.start)).collect::<Vec<_>>(), vec![("x", 1)]);
        assert_eq!(
            skeleton(prev, "//").unwrap(),
            "a\n// <user:x>\n// </user:x>\n// <user:y>\n// </user:y>\nb"
        );
    }

    #[test]
    fn changed_lines() {
        let generated = "a\n// <user:x>\ndefault\n// </user:x>\nb\nc\nd\ne";
        let edited = "a\r\n// <user:x>\r\nmine\r\nmore\r\n// </user:x>\r\nB\r\nc\r\ne\r\nf\r\ng";
        let lines =
            |c: &[Change]| c.iter().map(|c| (c.after, c.lines.len(), c.generated.len())).collect::<Vec<_>>();
        let found = changes(edited, generated, "//").unwrap();
        assert_eq!(lines(&found), vec![(5, 1, 1), (7, 0, 1), (8, 2, 0)]);
        assert_eq!(found[0].lines, vec![(6, "B".to_string())]);
        assert_eq!(found[1].generated, vec!["d".to_string()]);
        assert_eq!(lines(&changes("x\na", "a", "//").unwrap()), vec![(0, 1, 0)]);
        assert_eq!(lines(&changes("a", "x\na", "//").unwrap()), vec![(0, 0, 1)]);
        assert!(changes(edited, edited, "//").unwrap().is_empty());
    }
}
