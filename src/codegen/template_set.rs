// Template sets: a `manifest.yaml` listing the files to generate, and Jinja templates.
use std::collections::BTreeMap;

use serde::Deserialize;

pub const MANIFEST: &str = "manifest.yaml";

/// Whether `path` is relative, `/`-separated and stays inside its directory (`.` segments allowed).
pub fn is_inside_path(path: &str) -> bool {
    let p = path.trim();
    let p: String = {
        let mut s = String::new();
        for c in p.chars() {
            if !(c == '/' && s.ends_with('/')) {
                s.push(c);
            }
        }
        s
    };
    let b = p.as_bytes();
    if p.is_empty()
        || p.starts_with('/')
        || p.contains('\\')
        || (b.len() > 1 && b[0].is_ascii_alphabetic() && b[1] == b':')
    {
        return false;
    }
    !p.split('/').any(|s| s == ".." || s.is_empty())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Output {
    /// Template file, relative to the manifest.
    pub template: String,
    /// Jinja template of the generated file path, relative to the output directory.
    pub path: String,
    /// Jinja expression of a list: one file per item (e.g. `modules`), bound to `as`.
    pub each: Option<String>,
    #[serde(rename = "as", default = "default_as")]
    pub as_: String,
    /// Jinja condition: the file is generated only when it holds.
    pub when: Option<String>,
    /// Line comment starting the user section markers of this output.
    pub comment: Option<String>,
}

fn default_as() -> String {
    "item".into()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum Words {
    List(Vec<String>),
    Text(String),
}

fn words<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    Ok(match Words::deserialize(d)? {
        Words::List(l) => l,
        Words::Text(t) => t.split_whitespace().map(String::from).collect(),
    })
}

fn yes() -> bool {
    true
}

fn slashes() -> String {
    "//".into()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub name: String,
    #[allow(dead_code)] // read by the editor
    pub description: Option<String>,
    /// Reserved words of the target language: names of the project among them are warned about.
    #[serde(default, deserialize_with = "words")]
    pub reserved: Vec<String>,
    /// Line comment starting the user section markers.
    #[serde(default = "slashes")]
    pub comment: String,
    /// Lines holding only a `{% tag %}` leave no line nor indentation (trim_blocks + lstrip_blocks).
    #[serde(default = "yes")]
    pub trim_tag_lines: bool,
    /// Collapse runs of blank lines into one.
    #[serde(default = "yes")]
    pub squeeze_blank_lines: bool,
    /// Templates only imported or included by others.
    #[serde(default)]
    pub partials: Vec<String>,
    pub outputs: Vec<Output>,
}

pub struct TemplateSet {
    pub manifest: Manifest,
    /// Templates by path relative to the manifest.
    pub files: BTreeMap<String, String>,
}

pub fn parse_manifest(text: &str) -> Result<Manifest, String> {
    let m: Manifest = serde_yaml_ng::from_str(text).map_err(|e| format!("{MANIFEST}: {e}"))?;
    for p in m.outputs.iter().map(|o| &o.template).chain(&m.partials) {
        if p.is_empty() || !is_inside_path(p) {
            return Err(format!(
                "{MANIFEST}: '{p}': must be relative, use / and stay inside the template set"
            ));
        }
    }
    Ok(m)
}

/// Files a template set is made of, besides its manifest.
pub fn template_files(m: &Manifest) -> Vec<String> {
    let mut seen = Vec::new();
    for f in m.outputs.iter().map(|o| &o.template).chain(&m.partials) {
        if !seen.contains(f) {
            seen.push(f.clone());
        }
    }
    seen
}

/// Reads a template set through `read` (relative paths); missing templates are errors.
pub fn load_template_set(read: impl Fn(&str) -> Option<String>) -> Result<TemplateSet, String> {
    let text = read(MANIFEST).ok_or_else(|| format!("{MANIFEST} not found"))?;
    let manifest = parse_manifest(&text)?;
    let mut files = BTreeMap::new();
    for f in template_files(&manifest) {
        let content = read(&f).ok_or_else(|| format!("template '{f}' not found"))?;
        files.insert(f, content);
    }
    Ok(TemplateSet { manifest, files })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inside() {
        assert!(is_inside_path("a/./b.j2"));
        assert!(is_inside_path("a//b"));
        assert!(!is_inside_path("../a"));
        assert!(!is_inside_path("/a"));
        assert!(!is_inside_path("C:a"));
        assert!(!is_inside_path("a/"));
    }
}
