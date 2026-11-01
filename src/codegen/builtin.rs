// Built-in template sets (templates/<set>), embedded in the executable.
use include_dir::{Dir, include_dir};

use super::template_set::{TemplateSet, load_template_set};

static TEMPLATES: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/templates");

/// Names of the template sets shipped with the generator, chosen per project.
pub const TEMPLATE_SETS: [&str; 7] = ["cpp17", "cpp20", "cpp14", "cpp11", "cpp98", "python", "sca-cpp98"];

/// Template set of the projects choosing none.
pub const DEFAULT_TEMPLATE_SET: &str = "cpp17";

pub fn is_template_set(name: &str) -> bool {
    TEMPLATE_SETS.contains(&name)
}

/// A file of a built-in template set.
pub fn read_builtin(set: &str, path: &str) -> Option<String> {
    TEMPLATES.get_file(format!("{set}/{path}")).and_then(|f| f.contents_utf8()).map(String::from)
}

pub fn builtin(set: &str) -> Result<TemplateSet, String> {
    load_template_set(|p| read_builtin(set, p))
}

#[cfg(test)]
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
