// Generation into a directory: user sections of the files already there are carried over, files
// changed outside their user sections are left alone (conflicts), and a record of what was
// generated (`.scaffold-gen.json`) tells hand edits and files no longer generated apart.
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};

use super::generate::{generate, output_path};
use super::sections::{
    Change, Section, changes, extract_sections, format_orphans, hash, merge_sections, section_hash, skeleton,
};
use super::template_set::{MANIFEST, TemplateSet, is_inside_path, load_template_set};
use crate::diagnostic::{Diagnostic, Level, content_span};
use crate::style::Style;

pub const RECORD: &str = ".scaffold-gen.json";
/// Template set of an output directory, used instead of the built-in one.
pub const LOCAL_TEMPLATES: &str = ".scaffold/templates";
pub const ORPHANS: &str = ".orphans";

/// Directory generated files are written to; paths are relative and `/`-separated.
pub trait OutputDir {
    /// Content of a file; None when it does not exist.
    fn read(&self, path: &str) -> Result<Option<String>, String>;
    /// Writes a file, creating its directories.
    fn write(&self, path: &str, text: &str) -> Result<(), String>;
    fn remove(&self, path: &str) -> Result<(), String>;
}

/// A directory of the file system.
pub struct FsDir {
    pub root: PathBuf,
    pub label: String,
}

/// Content of a file; None when it does not exist.
pub fn read_or_none(path: &std::path::Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

impl FsDir {
    /// `path` under the root, refused when it leaves it or goes through a symbolic link there
    /// (written or removed through it, a file outside the directory would be).
    fn checked(&self, path: &str) -> Result<PathBuf, String> {
        if !is_inside_path(path) {
            return Err(format!("{path}: path outside the output directory"));
        }
        let mut p = self.root.clone();
        let mut exists = true;
        for part in path.split('/').filter(|s| !s.is_empty() && *s != ".") {
            p.push(part);
            if !exists {
                continue;
            }
            match std::fs::symlink_metadata(&p) {
                Ok(m) if m.file_type().is_symlink() => {
                    return Err(format!("{}: symbolic link, not written through", p.display()));
                }
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => exists = false,
                Err(e) => return Err(format!("{}: {e}", p.display())),
            }
        }
        Ok(p)
    }
}

impl OutputDir for FsDir {
    fn read(&self, path: &str) -> Result<Option<String>, String> {
        read_or_none(&self.root.join(path))
    }
    /// Through a temporary file renamed over the file: never left half written; its
    /// permissions kept.
    fn write(&self, path: &str, text: &str) -> Result<(), String> {
        let p = self.checked(path)?;
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
        }
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let tmp = p.with_file_name(format!(".{name}.scaffold-gen-tmp"));
        let r = (|| {
            std::fs::write(&tmp, text)?;
            if let Ok(m) = std::fs::metadata(&p) {
                std::fs::set_permissions(&tmp, m.permissions())?;
            }
            std::fs::rename(&tmp, &p)
        })();
        r.map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("{}: {e}", p.display())
        })
    }
    fn remove(&self, path: &str) -> Result<(), String> {
        match std::fs::remove_file(self.checked(path)?) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{path}: {e}")),
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecordEntry {
    /// Hash of the file with its user sections emptied.
    hash: String,
    /// Hash of the generated (default) content of each user section.
    sections: IndexMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct GenRecord {
    generator: String,
    files: BTreeMap<String, RecordEntry>,
}

#[derive(Default)]
pub struct RunOptions {
    /// Overwrite files changed outside their user sections.
    pub force: bool,
    /// Delete files no longer generated (their user code is kept in `.orphans` files).
    pub prune: bool,
    /// Report only, write nothing.
    pub dry_run: bool,
}

pub struct Conflict {
    pub path: String,
    pub why: String,
    /// Line of the file the reason is about.
    pub line: Option<usize>,
    /// Where the file differs from the generated one.
    pub changes: Vec<Change>,
    /// Said of each change (`(compared with this generation)`), or empty.
    pub qualifier: String,
    /// The file as it is.
    pub text: Option<String>,
}

static LINE_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^line (\d+): (.*)$").unwrap());

impl Conflict {
    /// A `line N: …` reason points at that line.
    fn new(path: &str, why: impl Into<String>) -> Conflict {
        let why = why.into();
        let (line, why) = match LINE_PREFIX.captures(&why) {
            Some(m) => (m[1].parse().ok(), m[2].to_string()),
            None => (None, why),
        };
        Conflict { path: path.to_string(), why, line, changes: vec![], qualifier: String::new(), text: None }
    }
}

#[derive(Default)]
pub struct GenerationReport {
    pub written: Vec<String>,
    pub unchanged: Vec<String>,
    /// Files changed outside their user sections, left as they are.
    pub conflicts: Vec<Conflict>,
    /// User sections with no place in the new file, saved to `<path>.orphans`: (path, ids).
    pub orphans: Vec<(String, Vec<String>)>,
    /// Files generated before and no longer.
    pub stale: Vec<String>,
    pub removed: Vec<String>,
    pub warnings: Vec<String>,
    /// User sections whose content was carried over from the file there: (path, sections of
    /// the new file).
    pub kept: Vec<(String, Vec<Section>)>,
}

/// The output directory's own template set if it has one, else `fallback`.
pub fn template_set_for(
    dir: &dyn OutputDir,
    fallback: impl FnOnce() -> Result<TemplateSet, String>,
) -> Result<TemplateSet, String> {
    if dir.read(&format!("{LOCAL_TEMPLATES}/{MANIFEST}"))?.is_none() {
        return fallback();
    }
    load_template_set(|p| dir.read(&format!("{LOCAL_TEMPLATES}/{p}")).ok().flatten())
}

fn entry_of(text: &str, comment: &str) -> Result<RecordEntry, String> {
    Ok(RecordEntry {
        hash: hash(&skeleton(text, comment)?),
        sections: extract_sections(text, comment)?
            .into_iter()
            .map(|s| (s.id, section_hash(&s.content)))
            .collect(),
    })
}

/// Sections holding something else than what was generated in them.
fn edited(sections: Vec<Section>, entry: Option<&RecordEntry>) -> Vec<Section> {
    sections
        .into_iter()
        .filter(|s| {
            !s.content.trim().is_empty()
                && entry.and_then(|e| e.sections.get(&s.id)) != Some(&section_hash(&s.content))
        })
        .collect()
}

pub fn generate_into(
    ctx: &minijinja::Value,
    set: &TemplateSet,
    dir: &dyn OutputDir,
    options: &RunOptions,
) -> Result<GenerationReport, String> {
    let generation = generate(ctx, set)?;
    let mut report = GenerationReport { warnings: generation.warnings, ..Default::default() };
    let previous_record = read_record(dir, &mut report.warnings)?;
    let mut record = GenRecord { generator: set.manifest.name.clone(), files: BTreeMap::new() };
    let write = |path: &str, text: &str| -> Result<(), String> {
        if options.dry_run { Ok(()) } else { dir.write(path, text) }
    };
    let save_orphans = |report: &mut GenerationReport,
                        path: &str,
                        sections: Vec<Section>,
                        comment: &str|
     -> Result<(), String> {
        if sections.is_empty() {
            return Ok(());
        }
        report.orphans.push((path.to_string(), sections.iter().map(|s| s.id.clone()).collect()));
        let target = format!("{path}{ORPHANS}");
        let before = dir.read(&target)?.unwrap_or_default();
        let sep = format!(
            "{}{}",
            if !before.is_empty() && !before.ends_with('\n') { "\n" } else { "" },
            if before.is_empty() { "" } else { "\n" }
        );
        write(&target, &format!("{before}{sep}{}", format_orphans(&sections, comment, path)))
    };
    let prev_entry = |path: &str| previous_record.as_ref().and_then(|r| r.files.get(path)).cloned();

    for f in &generation.files {
        let previous = dir.read(&f.path)?;
        let entry = prev_entry(&f.path);
        let next = entry_of(&f.text, &f.comment)?;
        let Some(previous) = previous else {
            write(&f.path, &f.text)?;
            report.written.push(f.path.clone());
            record.files.insert(f.path.clone(), next);
            continue;
        };
        let merged = match merge_sections(&f.text, &previous, &f.comment, |s| {
            entry.as_ref().and_then(|e| e.sections.get(&s.id)) == Some(&section_hash(&s.content))
        }) {
            Ok(m) => m,
            Err(e) => {
                if !options.force {
                    report.conflicts.push(Conflict { text: Some(previous), ..Conflict::new(&f.path, e) });
                    if let Some(entry) = entry {
                        record.files.insert(f.path.clone(), entry);
                    }
                    continue;
                }
                super::sections::MergeResult { text: f.text.clone(), orphans: vec![], kept: vec![] }
            }
        };
        // Against the last generation when recorded, else against this one.
        let hand_edited = match &entry {
            Some(e) => hash(&skeleton(&previous, &f.comment)?) != e.hash,
            None => skeleton(&previous, &f.comment)? != skeleton(&f.text, &f.comment)?,
        };
        if hand_edited && !options.force {
            let mut conflict = Conflict::new(
                &f.path,
                match &entry {
                    Some(_) => "changed outside its user sections",
                    None => "differs outside its user sections (no generation record)",
                },
            );
            // Lines against this generation: also template changes when it differs from the last.
            let changed = changes(&previous, &f.text, &f.comment)?;
            conflict.qualifier = match &entry {
                Some(e) if e.hash != next.hash => " (compared with this generation)".into(),
                Some(_) => String::new(),
                None => " (no generation record)".into(),
            };
            conflict.changes = changed;
            conflict.text = Some(previous);
            report.conflicts.push(conflict);
            if let Some(entry) = entry {
                record.files.insert(f.path.clone(), entry);
            }
            continue;
        }
        save_orphans(&mut report, &f.path, edited(merged.orphans, entry.as_ref()), &f.comment)?;
        if !merged.kept.is_empty() {
            report.kept.push((f.path.clone(), merged.kept));
        }
        if previous == merged.text {
            report.unchanged.push(f.path.clone());
        } else {
            write(&f.path, &merged.text)?;
            report.written.push(f.path.clone());
        }
        record.files.insert(f.path.clone(), next);
    }

    // Files generated before and no longer.
    let comments: HashMap<&str, &str> =
        generation.files.iter().map(|f| (f.path.as_str(), f.comment.as_str())).collect();
    if let Some(prev) = &previous_record {
        for (path, entry) in &prev.files {
            if comments.contains_key(path.as_str()) {
                continue;
            }
            let Some(previous) = dir.read(path)? else { continue };
            if !options.prune {
                report.stale.push(path.clone());
                record.files.insert(path.clone(), entry.clone());
                continue;
            }
            let comment = comment_of(&previous, &set.manifest.comment);
            if hash(&skeleton(&previous, &comment)?) != entry.hash && !options.force {
                report
                    .conflicts
                    .push(Conflict::new(path, "no longer generated, and changed outside its user sections"));
                record.files.insert(path.clone(), entry.clone());
                continue;
            }
            save_orphans(
                &mut report,
                path,
                edited(extract_sections(&previous, &comment)?, Some(entry)),
                &comment,
            )?;
            if !options.dry_run {
                dir.remove(path)?;
            }
            report.removed.push(path.clone());
        }
    }

    if !options.dry_run {
        let text = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
        dir.write(RECORD, &format!("{text}\n"))?;
    }
    Ok(report)
}

/// The record of the last generation; paths that are not those of generated files (outside the
/// directory, the record itself...) are left out with a warning: the record may come from
/// anywhere, as the directory does.
fn read_record(dir: &dyn OutputDir, warnings: &mut Vec<String>) -> Result<Option<GenRecord>, String> {
    let Some(mut record) = dir.read(RECORD)?.and_then(|t| serde_json::from_str::<GenRecord>(&t).ok()) else {
        return Ok(None);
    };
    record.files.retain(|path, _| {
        let ok = output_path(path).is_ok_and(|p| p == *path) && !reserved_output(path);
        if !ok {
            warnings.push(format!("{RECORD}: '{path}' is not a generated file path, ignored"));
        }
        ok
    });
    Ok(Some(record))
}

/// Paths the generator writes for itself: its record, the directory's template set, `.orphans` files.
pub fn reserved_output(path: &str) -> bool {
    path == RECORD || path.starts_with(&format!("{LOCAL_TEMPLATES}/")) || path.ends_with(ORPHANS)
}

static FIRST_MARKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^[ \t]*(\S+)[ \t]*<user:[^\s<>]+>[ \t]*\r?$").unwrap());

/// Comment of the markers of a file no longer generated: guessed from its first marker.
pub fn comment_of(text: &str, fallback: &str) -> String {
    FIRST_MARKER.captures(text).map(|m| m[1].to_string()).unwrap_or_else(|| fallback.to_string())
}

/// Diagnostics of a conflict, its path prefixed with `out` (the output directory).
fn conflict_diagnostics(c: &Conflict, out: &str) -> Vec<Diagnostic> {
    let path = prefixed(out, &c.path);
    let text = c.text.as_deref();
    if let Some(l) = c.line {
        return vec![Diagnostic::new(&path, Level::Error, &c.why).at_line(l, text)];
    }
    if c.changes.is_empty() {
        return vec![Diagnostic::new(&path, Level::Error, &c.why)];
    }
    c.changes
        .iter()
        .map(|ch| {
            let (what, line) = match (ch.lines.is_empty(), ch.generated.is_empty()) {
                (true, _) if ch.after == 0 => ("generated lines missing before this line", 1),
                (true, _) => ("generated lines missing after this line", ch.after),
                (false, true) => ("added outside its user sections", ch.lines[0].0),
                (false, false) => ("changed outside its user sections", ch.lines[0].0),
            };
            let mut d =
                Diagnostic::new(&path, Level::Error, &format!("{what}{}", c.qualifier)).at_line(line, text);
            if ch.lines.is_empty() {
                // A single mark past the end of the line (at its start: before it).
                if let Some((_, src)) = d.excerpt.first() {
                    d.col = Some(if ch.after == 0 { 1 } else { src.trim_end().chars().count() + 1 });
                    d.mark = Some(0);
                }
            } else {
                d.excerpt = ch.lines.clone();
                if let ([(_, mine)], [theirs]) = (ch.lines.as_slice(), ch.generated.as_slice()) {
                    // From the first character that differs.
                    let same = mine.chars().zip(theirs.chars()).take_while(|(a, b)| a == b).count();
                    let (start, len) = content_span(mine);
                    let col = (same + 1).max(start);
                    d.col = Some(col);
                    d.mark = Some((start + len).saturating_sub(col + 1));
                }
            }
            d.generated = ch.generated.clone();
            d
        })
        .collect()
}

fn prefixed(out: &str, path: &str) -> String {
    if out == "." || out.is_empty() { path.to_string() } else { format!("{out}/{path}") }
}

/// What to list in a report besides the problems.
#[derive(Default, Clone, Copy)]
pub struct ReportOptions {
    /// The files written.
    pub written: bool,
    /// The user sections carried over, with their content.
    pub kept: bool,
}

/// One line per file and problem, then the kept sections (notes) and the conflicts as
/// diagnostics, their paths prefixed with `out`.
pub fn format_report(r: &GenerationReport, dir: &str, out: &str, show: ReportOptions, st: Style) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut list = |title: String, items: Vec<String>| {
        if !items.is_empty() {
            lines.push(format!("{title} ({}):", items.len()));
            lines.extend(items.into_iter().map(|i| format!("  {i}")));
        }
    };
    let paths = |v: &[String], paint: fn(Style, &str) -> String| v.iter().map(|p| paint(st, p)).collect();
    if show.written {
        list(st.green("Written"), paths(&r.written, Style::green));
    }
    list(st.yellow("Removed"), paths(&r.removed, Style::yellow));
    list(
        st.yellow("User sections with no place left, saved to .orphans files"),
        r.orphans.iter().map(|(p, ids)| format!("{}: {}", st.bold(p), st.cyan(&ids.join(", ")))).collect(),
    );
    list(st.yellow("No longer generated (prune to delete)"), paths(&r.stale, Style::dim));
    list(st.yellow("Warnings"), r.warnings.clone());
    if show.kept {
        for (path, sections) in &r.kept {
            for s in sections {
                let content: Vec<&str> = s.content.split('\n').collect();
                let mut d = Diagnostic::new(
                    &prefixed(out, path),
                    Level::Note,
                    &format!(
                        "user section '{}' kept ({} line{})",
                        s.id,
                        content.len(),
                        if content.len() > 1 { "s" } else { "" }
                    ),
                );
                d.line = Some(s.start + 2);
                d.col = Some(1);
                d.excerpt =
                    content.iter().enumerate().map(|(i, l)| (s.start + 2 + i, l.to_string())).collect();
                d.max_lines = usize::MAX;
                lines.push(d.render(st));
            }
        }
    }
    for c in &r.conflicts {
        lines.extend(conflict_diagnostics(c, out).iter().map(|d| d.render(st)));
    }
    let count = |n: usize, what: &str, paint: fn(Style, &str) -> String| {
        let s = format!("{n} {what}");
        if n == 0 { st.dim(&s) } else { paint(st, &s) }
    };
    lines.push(format!(
        "{}: {}, {}, {}",
        st.bold(dir),
        count(r.written.len(), "written", Style::green),
        count(r.unchanged.len(), "unchanged", |_, s| s.to_string()),
        count(r.conflicts.len(), "conflicts", Style::red),
    ));
    if !r.conflicts.is_empty() {
        lines.last_mut().unwrap().push_str(" (--force to overwrite)");
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    use super::*;
    use crate::codegen::template_set::parse_manifest;

    /// An output directory in memory.
    #[derive(Default)]
    struct MemDir(RefCell<BTreeMap<String, String>>);

    impl OutputDir for MemDir {
        fn read(&self, path: &str) -> Result<Option<String>, String> {
            Ok(self.0.borrow().get(path).cloned())
        }
        fn write(&self, path: &str, text: &str) -> Result<(), String> {
            self.0.borrow_mut().insert(path.into(), text.into());
            Ok(())
        }
        fn remove(&self, path: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(path);
            Ok(())
        }
    }

    impl MemDir {
        fn get(&self, path: &str) -> Option<String> {
            self.0.borrow().get(path).cloned()
        }
        fn set(&self, path: &str, text: &str) {
            self.0.borrow_mut().insert(path.into(), text.into());
        }
    }

    /// A set of `manifest` over one template with a user section.
    fn set_of(manifest: &str) -> TemplateSet {
        let files = [(
            "a.j2".to_string(),
            "head {{ item }}\n{% filter user('body') %}default\n{% endfilter %}\ntail\n".to_string(),
        )];
        TemplateSet { manifest: parse_manifest(manifest).unwrap(), files: files.into_iter().collect() }
    }

    fn files_set() -> TemplateSet {
        set_of("name: t\noutputs:\n  - template: a.j2\n    each: names\n    path: '{{ item }}.txt'\n")
    }

    fn ctx(names: &[&str]) -> minijinja::Value {
        minijinja::Value::from(minijinja::value::Serde(serde_json::json!({ "names": names })))
    }

    fn run(dir: &MemDir, names: &[&str], options: RunOptions) -> GenerationReport {
        generate_into(&ctx(names), &files_set(), dir, &options).unwrap()
    }

    #[test]
    fn record_paths_outside_ignored() {
        let dir = MemDir::default();
        run(&dir, &["a"], RunOptions::default());
        let mut record: serde_json::Value = serde_json::from_str(&dir.get(RECORD).unwrap()).unwrap();
        for p in ["../victim.txt", "/abs.txt", RECORD, "x.txt.orphans"] {
            record["files"][p] = serde_json::json!({ "hash": "x", "sections": {} });
            dir.set(p, "keep");
        }
        dir.set(RECORD, &record.to_string());
        let r = run(&dir, &["a"], RunOptions { prune: true, force: true, ..Default::default() });
        assert!(r.removed.is_empty());
        assert_eq!(r.warnings.len(), 4);
        assert_eq!(dir.get("../victim.txt").as_deref(), Some("keep"));
    }

    #[test]
    fn reserved_and_case_collisions_refused() {
        let dir = MemDir::default();
        let set =
            |path: &str| set_of(&format!("name: t\noutputs:\n  - template: a.j2\n    path: '{path}'\n"));
        for p in [RECORD, ".scaffold/templates/manifest.yaml", "a.txt.orphans"] {
            let e = generate_into(&ctx(&[]), &set(p), &dir, &RunOptions::default()).err().unwrap();
            assert!(e.contains("file of the generator"), "{e}");
        }
        let e = generate_into(&ctx(&["a", "A"]), &files_set(), &dir, &RunOptions::default()).err().unwrap();
        assert!(e.contains("letter case"), "{e}");
    }

    #[test]
    fn fs_dir_refuses_symlinks() {
        let root = std::env::temp_dir().join(format!("scaffold-gen-run-{}", std::process::id()));
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let dir = FsDir { root: root.join("out"), label: "out".into() };
        dir.write("sub/a.txt", "1").unwrap();
        dir.write("sub/a.txt", "2").unwrap();
        assert_eq!(dir.read("sub/a.txt").unwrap().as_deref(), Some("2"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("out/link")).unwrap();
            assert!(dir.write("link/b.txt", "x").unwrap_err().contains("symbolic link"));
            assert!(!outside.join("b.txt").exists());
            assert!(dir.remove("link/b.txt").is_err());
        }
        assert!(dir.write("../c.txt", "x").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
