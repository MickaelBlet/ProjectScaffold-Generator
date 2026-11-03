// Generation into a directory: user sections of the files already there are carried over, files
// changed outside their user sections are left alone (conflicts), and a record of what was
// generated (`.scaffold-gen.json`) tells hand edits and files no longer generated apart.
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};

use super::generate::generate;
use super::sections::{
    Section, changes, extract_sections, format_changes, format_orphans, hash, merge_sections, section_hash,
    skeleton,
};
use super::template_set::{MANIFEST, TemplateSet, load_template_set};

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

impl OutputDir for FsDir {
    fn read(&self, path: &str) -> Result<Option<String>, String> {
        read_or_none(&self.root.join(path))
    }
    fn write(&self, path: &str, text: &str) -> Result<(), String> {
        let p = self.root.join(path);
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
        }
        std::fs::write(&p, text).map_err(|e| format!("{}: {e}", p.display()))
    }
    fn remove(&self, path: &str) -> Result<(), String> {
        match std::fs::remove_file(self.root.join(path)) {
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

#[derive(Default)]
pub struct GenerationReport {
    pub written: Vec<String>,
    pub unchanged: Vec<String>,
    /// Files changed outside their user sections, left as they are: (path, reason).
    pub conflicts: Vec<(String, String)>,
    /// User sections with no place in the new file, saved to `<path>.orphans`: (path, ids).
    pub orphans: Vec<(String, Vec<String>)>,
    /// Files generated before and no longer.
    pub stale: Vec<String>,
    pub removed: Vec<String>,
    pub warnings: Vec<String>,
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
    let previous_record = read_record(dir)?;
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
                    report.conflicts.push((f.path.clone(), e));
                    if let Some(entry) = entry {
                        record.files.insert(f.path.clone(), entry);
                    }
                    continue;
                }
                super::sections::MergeResult { text: f.text.clone(), orphans: vec![] }
            }
        };
        // Against the last generation when recorded, else against this one.
        let hand_edited = match &entry {
            Some(e) => hash(&skeleton(&previous, &f.comment)?) != e.hash,
            None => skeleton(&previous, &f.comment)? != skeleton(&f.text, &f.comment)?,
        };
        if hand_edited && !options.force {
            let mut why = match &entry {
                Some(_) => "changed outside its user sections".to_string(),
                None => "differs outside its user sections (no generation record)".to_string(),
            };
            // Lines against this generation: also template changes when it differs from the last.
            let changed = changes(&previous, &f.text, &f.comment)?;
            if !changed.is_empty() {
                why += &format!(", {}", format_changes(&changed));
                if entry.as_ref().is_some_and(|e| e.hash != next.hash) {
                    why += " (compared with this generation)";
                }
            }
            report.conflicts.push((f.path.clone(), why));
            if let Some(entry) = entry {
                record.files.insert(f.path.clone(), entry);
            }
            continue;
        }
        save_orphans(&mut report, &f.path, edited(merged.orphans, entry.as_ref()), &f.comment)?;
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
                report.conflicts.push((
                    path.clone(),
                    "no longer generated, and changed outside its user sections".into(),
                ));
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

fn read_record(dir: &dyn OutputDir) -> Result<Option<GenRecord>, String> {
    Ok(dir.read(RECORD)?.and_then(|t| serde_json::from_str::<GenRecord>(&t).ok()))
}

static FIRST_MARKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^[ \t]*(\S+)[ \t]*<user:[^\s<>]+>[ \t]*\r?$").unwrap());

/// Comment of the markers of a file no longer generated: guessed from its first marker.
pub fn comment_of(text: &str, fallback: &str) -> String {
    FIRST_MARKER.captures(text).map(|m| m[1].to_string()).unwrap_or_else(|| fallback.to_string())
}

/// One line per file and problem (`written`: list the files written).
pub fn format_report(r: &GenerationReport, dir: &str, written: bool) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut list = |title: &str, items: Vec<String>| {
        if !items.is_empty() {
            lines.push(format!("{title} ({}):", items.len()));
            lines.extend(items.into_iter().map(|i| format!("  {i}")));
        }
    };
    if written {
        list("Written", r.written.clone());
    }
    list("Removed", r.removed.clone());
    list(
        "Conflicts, left as they are (force to overwrite)",
        r.conflicts.iter().map(|(p, why)| format!("{p}: {why}")).collect(),
    );
    list(
        "User sections with no place left, saved to .orphans files",
        r.orphans.iter().map(|(p, ids)| format!("{p}: {}", ids.join(", "))).collect(),
    );
    list("No longer generated (prune to delete)", r.stale.clone());
    list("Warnings", r.warnings.clone());
    lines.push(format!(
        "{dir}: {} written, {} unchanged, {} conflicts",
        r.written.len(),
        r.unchanged.len(),
        r.conflicts.len()
    ));
    lines.join("\n")
}
