// Built-in template sets (templates/<set>), embedded in the executable with the
// `builtin-templates` feature; without it, template sets are folders only (-t <folder>).
use super::template_set::TemplateSet;

/// Names of the template sets shipped with the generator, chosen per project.
pub const TEMPLATE_SETS: [&str; 7] = ["cpp17", "cpp20", "cpp14", "cpp11", "cpp98", "python", "sca-cpp98"];

/// Template set of the projects choosing none.
pub const DEFAULT_TEMPLATE_SET: &str = "cpp17";

/// Whether the template sets are embedded in this build.
pub const EMBEDDED: bool = cfg!(feature = "builtin-templates");

pub fn is_template_set(name: &str) -> bool {
    EMBEDDED && TEMPLATE_SETS.contains(&name)
}

#[cfg(feature = "builtin-templates")]
static TEMPLATES: include_dir::Dir<'static> = include_dir::include_dir!("$CARGO_MANIFEST_DIR/templates");

/// A file of a built-in template set.
#[cfg(feature = "builtin-templates")]
pub fn read_builtin(set: &str, path: &str) -> Option<String> {
    TEMPLATES.get_file(format!("{set}/{path}")).and_then(|f| f.contents_utf8()).map(String::from)
}

#[cfg(feature = "builtin-templates")]
pub fn builtin(set: &str) -> Result<TemplateSet, String> {
    super::template_set::load_template_set(|p| read_builtin(set, p))
}

#[cfg(not(feature = "builtin-templates"))]
pub fn builtin(_set: &str) -> Result<TemplateSet, String> {
    Err("no template set: give a folder holding a manifest.yaml with -t, or put one in \
         <out>/.scaffold/templates (this build embeds none)"
        .into())
}

#[cfg(all(test, feature = "builtin-templates"))]
mod tests {
    use super::*;

    #[test]
    fn every_set_loads() {
        for s in TEMPLATE_SETS {
            let set = builtin(s).unwrap_or_else(|e| panic!("{s}: {e}"));
            assert_eq!(set.manifest.name, s);
        }
    }
}
