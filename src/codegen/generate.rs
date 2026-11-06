// Renders a template set over a generation context: the files to generate, with the default
// content of their user sections. Pure: merging with the files on disk is done by run.rs.
use std::collections::HashSet;
use std::sync::LazyLock;

use minijinja::{AutoEscape, Environment, UndefinedBehavior, Value};
use regex::Regex;

use super::filters;
use super::inline::inline_blocks;
use super::run::reserved_output;
use super::sections::{DROP, place_markers, user_filter};
use super::template_set::{TemplateSet, is_inside_path};

pub struct GeneratedFile {
    /// Relative to the output directory, `/`-separated.
    pub path: String,
    pub text: String,
    /// Line comment of the user section markers.
    pub comment: String,
}

pub struct Generation {
    pub files: Vec<GeneratedFile>,
    pub warnings: Vec<String>,
}

/// Checks and normalizes a generated file path: relative, inside the output directory.
pub fn output_path(path: &str) -> Result<String, String> {
    if !is_inside_path(path) {
        return Err(format!("invalid output path '{path}': must be relative, use '/' and stay inside"));
    }
    Ok(path.trim().split('/').filter(|s| !s.is_empty() && *s != ".").collect::<Vec<_>>().join("/"))
}

static DROP_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?m)^[ \t]*{DROP}[ \t]*\r?\n")).unwrap());
static SQUEEZE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n[ \t]*(?:\n[ \t]*)+\n").unwrap());
static LEADING_BLANK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\n").unwrap());
static TRAILING_BLANK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*$").unwrap());

fn drop_lines(text: &str) -> String {
    DROP_LINE.replace_all(text, "").replace(DROP, "")
}

/// Error message of a template error, with its cause chain.
pub fn describe(e: &minijinja::Error) -> String {
    if std::env::var_os("SCAFFOLD_GEN_DEBUG").is_some() {
        return format!("{e:#}");
    }
    let mut s = e.to_string();
    let mut cause = std::error::Error::source(e);
    while let Some(c) = cause {
        s.push_str(&format!(": {c}"));
        cause = c.source();
    }
    s
}

/// Jinja environment of a template set: the context as globals (imported macros see them), and
/// only language-neutral additions: the `user` filter and the case / comment filters.
pub fn create_env(set: &TemplateSet, globals: &[(String, Value)]) -> Result<Environment<'static>, String> {
    let mut env = Environment::new();
    let trim = set.manifest.trim_tag_lines;
    env.set_syntax(
        minijinja::syntax::SyntaxConfig::builder()
            .trim_blocks(trim)
            .lstrip_blocks(trim)
            .keep_trailing_newline(true)
            .build()
            .map_err(|e| describe(&e))?,
    );
    // Undefined values are errors, but in tests of `if` (Liquid's lenientIf).
    env.set_undefined_behavior(UndefinedBehavior::SemiStrict);
    env.set_debug(std::env::var_os("SCAFFOLD_GEN_DEBUG").is_some());
    env.set_auto_escape_callback(|_| AutoEscape::None);
    // none prints nothing, as nil in Liquid.
    env.set_formatter(
        |out, state, value| {
            if value.is_none() { Ok(()) } else { minijinja::escape_formatter(out, state, value) }
        },
    );
    env.set_unknown_method_callback(unknown_method);
    filters::register(&mut env);
    env.add_filter("user", user_filter);
    // Its blocks are joined on one line when the templates are added (inline.rs).
    env.add_filter("inline", |v: Value| v);
    for (k, v) in globals {
        env.add_global(k.clone(), v.clone());
    }
    for (name, text) in &set.files {
        env.add_template_owned(name.clone(), inline_blocks(text)).map_err(|e| describe(&e))?;
    }
    Ok(env)
}

/// Python string methods (pycompat), and `rsplit`.
fn unknown_method(
    state: &mut minijinja::State,
    value: &Value,
    method: &str,
    args: &[Value],
) -> Result<Value, minijinja::Error> {
    if let (Some(s), "rsplit") = (value.as_str(), method) {
        let sep = args.first().and_then(|a| a.as_str()).unwrap_or(" ");
        let n = args.get(1).and_then(|a| i64::try_from(a.clone()).ok()).unwrap_or(-1);
        let mut parts: Vec<&str> =
            if n < 0 { s.rsplit(sep).collect() } else { s.rsplitn(n as usize + 1, sep).collect() };
        parts.reverse();
        return Ok(Value::from_iter(parts.into_iter().map(Value::from)));
    }
    minijinja_contrib::pycompat::unknown_method_callback(state, value, method, args)
}

/// Items of the list at `k` of a context value.
fn items(v: &Value, k: &str) -> Vec<Value> {
    v.get_attr(k).ok().and_then(|l| l.try_iter().ok().map(|i| i.collect())).unwrap_or_default()
}

/// Text at `k` of a context value ("" when absent).
fn text_at(v: &Value, k: &str) -> String {
    v.get_attr(k).ok().and_then(|x| x.as_str().map(String::from)).unwrap_or_default()
}

/// Names of the project that are reserved words of the target language.
pub fn reserved_names(ctx: &Value, reserved: &[String]) -> Vec<String> {
    let words: HashSet<&str> = reserved.iter().map(String::as_str).collect();
    let mut warnings = Vec::new();
    let mut check = |n: &str, where_: String| {
        if words.contains(n) {
            warnings.push(format!("{where_}: '{n}' is a reserved word, renamed in the generated code"));
        }
    };
    for t in items(ctx, "types") {
        let tn = text_at(&t, "name");
        check(&tn, tn.clone());
        let members = match text_at(&t, "kind").as_str() {
            "struct" | "exception" => "fields",
            "enum" => "values",
            "bitmask" => "flags",
            _ => "",
        };
        if !members.is_empty() {
            for f in items(&t, members) {
                let n = text_at(&f, "name");
                check(&n, format!("{tn}.{n}"));
            }
        }
    }
    for c in items(ctx, "constants") {
        let n = text_at(&c, "name");
        check(&n, n.clone());
    }
    for i in items(ctx, "interfaces") {
        let iname = text_at(&i, "name");
        check(&iname, iname.clone());
        for m in items(&i, "messages") {
            let mn = text_at(&m, "name");
            check(&mn, format!("{iname}.{mn}"));
            for p in items(&m, "params") {
                let n = text_at(&p, "name");
                check(&n, format!("{iname}.{mn}({n})"));
            }
        }
    }
    for m in items(ctx, "modules") {
        let path = text_at(&m, "path");
        check(&text_at(&m, "name"), path.clone());
        for a in items(&m, "attributes") {
            let n = text_at(&a, "name");
            check(&n, format!("{path}.{n}"));
        }
        for x in items(&m, "methods") {
            let xn = text_at(&x, "name");
            check(&xn, format!("{path}.{xn}"));
            for p in items(&x, "params") {
                let n = text_at(&p, "name");
                check(&n, format!("{path}.{xn}({n})"));
            }
        }
        for p in items(&m, "ports") {
            let n = text_at(&p, "name");
            check(&n, format!("{path}:{n}"));
        }
    }
    warnings
}

/// Renders a template set over a generation context (`warnings` holds the context's own).
pub fn generate(ctx: &Value, set: &TemplateSet) -> Result<Generation, String> {
    let manifest = &set.manifest;
    let keys: Vec<Value> = ctx.try_iter().map_err(|e| describe(&e))?.collect();
    let mut globals: Vec<(String, Value)> =
        keys.iter().filter_map(|k| Some((k.as_str()?.to_string(), ctx.get_item(k).ok()?))).collect();
    globals.push(("files".into(), Value::from(Vec::<Value>::new())));
    globals.push((
        "generator".into(),
        Value::from(minijinja::value::Serde(
            serde_json::json!({ "name": manifest.name, "reserved": manifest.reserved }),
        )),
    ));
    let mut env = create_env(set, &globals)?;
    let mut files: Vec<GeneratedFile> = Vec::new();
    let mut paths: HashSet<String> = HashSet::new();
    // Lower-cased: one file on case-insensitive file systems (Windows, macOS).
    let mut folded: HashSet<String> = HashSet::new();

    for out in &manifest.outputs {
        let template = &out.template;
        let fail = |e: String, item: Option<&Value>| -> String {
            let name = item
                .and_then(|i| i.get_attr("name").ok())
                .filter(|n| !n.is_undefined() && !n.is_none())
                .map(|n| format!(" ({n})"))
                .unwrap_or_default();
            format!("{template}{name}: {e}")
        };
        if !set.files.contains_key(template) {
            return Err(fail("template not found".into(), None));
        }
        let items: Vec<Option<Value>> = match &out.each {
            Some(each) => {
                let list = env
                    .compile_expression(each)
                    .and_then(|x| x.eval(minijinja::context! {}))
                    .map_err(|e| fail(describe(&e), None))?;
                if list.kind() != minijinja::value::ValueKind::Seq {
                    return Err(fail(format!("'each: {each}' is not a list"), None));
                }
                list.try_iter().map_err(|e| fail(describe(&e), None))?.map(Some).collect()
            }
            None => vec![None],
        };
        let comment = out.comment.as_deref().unwrap_or(&manifest.comment);
        for item in items {
            let local = match &item {
                Some(v) => Value::from_pairs([(out.as_.as_str(), v.clone())]),
                None => minijinja::context! {},
            };
            let attempt = || -> Result<Option<GeneratedFile>, String> {
                if let Some(when) = &out.when {
                    let v = env
                        .compile_expression(when)
                        .and_then(|x| x.eval(local.clone()))
                        .map_err(|e| describe(&e))?;
                    // Liquid truthiness: only false and nil are false.
                    if v.is_undefined() || v.is_none() || v == Value::from(false) {
                        return Ok(None);
                    }
                }
                let path = env.render_str(&out.path, local.clone()).map_err(|e| describe(&e))?;
                let path = output_path(&path)?;
                if paths.contains(&path) {
                    return Err(format!("'{path}' is generated twice"));
                }
                if folded.contains(&path.to_lowercase()) {
                    return Err(format!("'{path}' is generated twice (letter case aside)"));
                }
                if reserved_output(&path) {
                    return Err(format!("'{path}' is a file of the generator, not generated"));
                }
                let tpl = env.get_template(template).map_err(|e| describe(&e))?;
                let mut text = drop_lines(&tpl.render(local.clone()).map_err(|e| describe(&e))?);
                if manifest.squeeze_blank_lines {
                    text = SQUEEZE.replace_all(&text, "\n\n").into_owned();
                }
                let text = place_markers(&text, comment)?;
                let text = LEADING_BLANK.replace(&text, "");
                let text = TRAILING_BLANK.replace(&text, "\n").into_owned();
                Ok(Some(GeneratedFile { path, text, comment: comment.to_string() }))
            };
            match attempt() {
                Ok(Some(f)) => {
                    folded.insert(f.path.to_lowercase());
                    paths.insert(f.path.clone());
                    files.push(f);
                    let list: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
                    env.add_global("files", Value::from(minijinja::value::Serde(&list)));
                }
                Ok(None) => {}
                Err(e) => return Err(fail(e, item.as_ref())),
            }
        }
    }
    let mut warnings: Vec<String> =
        items(ctx, "warnings").iter().filter_map(|x| x.as_str().map(String::from)).collect();
    warnings.extend(reserved_names(ctx, &manifest.reserved));
    Ok(Generation { files, warnings })
}
