// Language-neutral filters: identifier case conversions, name-based UUIDs, doc comments.
use std::sync::LazyLock;

use minijinja::Value;
use regex::Regex;

use super::sections::{DROP, hash};

static LOWER_UPPER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([a-z0-9])([A-Z])").unwrap());
static UPPER_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([A-Z]+)([A-Z][a-z])").unwrap());
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z0-9]+").unwrap());

/// A filter input as text: strings as they are, objects as JSON rather than `[object Object]`.
pub fn text(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        return s.to_string();
    }
    if v.is_undefined() || v.is_none() {
        return String::new();
    }
    match v.kind() {
        minijinja::value::ValueKind::Number | minijinja::value::ValueKind::Bool => v.to_string(),
        _ => serde_json::to_string(v).unwrap_or_default(),
    }
}

/// Words of an identifier: `rateHz` → rate, Hz; `HTTPServer` → HTTP, Server; `snake_case` → snake, case.
pub fn words(s: &str) -> Vec<String> {
    let s = LOWER_UPPER.replace_all(s, "$1 $2");
    let s = UPPER_RUN.replace_all(&s, "$1 $2");
    WORD.find_iter(&s).map(|m| m.as_str().to_string()).collect()
}

fn cap(w: &str) -> String {
    let mut c = w.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase(),
        None => String::new(),
    }
}

pub fn snake(s: &str) -> String {
    words(s).iter().map(|w| w.to_lowercase()).collect::<Vec<_>>().join("_")
}

pub fn kebab(s: &str) -> String {
    words(s).iter().map(|w| w.to_lowercase()).collect::<Vec<_>>().join("-")
}

pub fn constant(s: &str) -> String {
    words(s).iter().map(|w| w.to_uppercase()).collect::<Vec<_>>().join("_")
}

pub fn pascal(s: &str) -> String {
    words(s).iter().map(|w| cap(w)).collect()
}

pub fn camel(s: &str) -> String {
    lcfirst(&pascal(s))
}

/// First letter upper case, the rest unchanged (`rateHz` → `RateHz`).
pub fn ucfirst(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// First letter lower case, the rest unchanged (`Sensor` → `sensor`).
pub fn lcfirst(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_lowercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// UUID made from a text: the same text always gives the same UUID. Version 8 (custom), not a
/// cryptographic hash.
pub fn uuid(s: &str) -> String {
    let h: String = (0..3).map(|i| hash(&format!("{i}:{s}"))).collect();
    let digit = u32::from_str_radix(&h[16..17], 16).unwrap_or(0);
    let variant = format!("{:x}", (digit & 0x3) | 0x8);
    format!("{}-{}-8{}-{}{}-{}", &h[0..8], &h[8..12], &h[13..16], variant, &h[17..20], &h[20..32])
}

/// Each line of a description after `prefix` (e.g. `  /// `); no line for no description.
pub fn doc_comment(text: &str, prefix: Option<&str>) -> String {
    if text.is_empty() {
        return DROP.to_string();
    }
    let prefix = prefix.unwrap_or("/// ");
    text.split('\n')
        .map(|l| format!("{prefix}{}", l.strip_suffix('\r').unwrap_or(l)).trim_end().to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Registers the filters on an environment.
pub fn register(env: &mut minijinja::Environment<'_>) {
    fn case(f: fn(&str) -> String) -> impl Fn(Value) -> String + Send + Sync + 'static {
        move |v: Value| f(&text(&v))
    }
    env.add_filter("snake", case(snake));
    env.add_filter("kebab", case(kebab));
    env.add_filter("constant", case(constant));
    env.add_filter("pascal", case(pascal));
    env.add_filter("camel", case(camel));
    env.add_filter("ucfirst", case(ucfirst));
    env.add_filter("lcfirst", case(lcfirst));
    env.add_filter("uuid", case(uuid));
    // A project name as an identifier, as dependencies name the project: `Plant Demo` -> `Plant_Demo`.
    env.add_filter("as_identifier", case(super::context::dependency_name));
    env.add_filter("doc_comment", |v: Value, prefix: Option<Value>| {
        doc_comment(&text(&v), prefix.as_ref().map(text).as_deref())
    });
    // Jinja2's replace: an optional count of occurrences.
    env.add_filter("replace", |v: Value, from: Value, to: Value, count: Option<usize>| {
        let (s, from, to) = (text(&v), text(&from), text(&to));
        match count {
            Some(n) => s.replacen(&from, &to, n),
            None => s.replace(&from, &to),
        }
    });
    // Liquid's escape: & < > " ' only (minijinja's escapes / too).
    env.add_filter("escape", |v: Value| {
        text(&v)
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&#34;")
            .replace('\'', "&#39;")
    });
    // JSON.stringify's output: no escaping of `<`, `>`, `&`, `'` (unlike tojson).
    env.add_filter("json", |v: Value| serde_json::to_string(&v).unwrap_or_default());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cases() {
        assert_eq!(words("HTTPServer"), ["HTTP", "Server"]);
        assert_eq!(snake("rateHz"), "rate_hz");
        assert_eq!(constant("rateHz"), "RATE_HZ");
        assert_eq!(pascal("snake_case"), "SnakeCase");
        assert_eq!(camel("HTTPServer"), "httpServer");
        assert_eq!(kebab("Core.Sensor"), "core-sensor");
        assert_eq!(ucfirst("rateHz"), "RateHz");
        assert_eq!(super::super::context::dependency_name("Plant Demo"), "Plant_Demo");
        assert_eq!(super::super::context::dependency_name("C++ / 2 robots!"), "C_2_robots");
    }

    #[test]
    fn doc() {
        assert_eq!(doc_comment("", None), DROP);
        assert_eq!(doc_comment("a\n\nb", Some("// ")), "// a\n//\n// b");
    }
}
