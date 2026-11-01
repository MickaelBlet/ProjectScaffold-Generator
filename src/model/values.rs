// Default values and constants checked against their type (src/model/defaults.ts valueErrors), and
// values written as the editor writes them (formatValue: a one-line YAML flow literal).
use std::collections::HashSet;

use serde_json::Value as Json;

use super::load::{Index, dh, dl, ds};
use super::text::resolve_plain_value;

// -------------------------------------------------------- JS numbers ----

/// A number as JavaScript's `String(x)` writes it.
pub fn js_num(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x == 0.0 {
        return "0".into();
    }
    // shortest round-trip digits and exponent
    let e = format!("{:e}", x.abs());
    let (mant, exp) = e.split_once('e').unwrap();
    let digits: String = mant.chars().filter(|c| c.is_ascii_digit()).collect();
    let exp: i32 = exp.parse().unwrap();
    let k = digits.len() as i32;
    let n = exp + 1;
    let sign = if x < 0.0 { "-" } else { "" };
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let es = if e >= 0 { format!("+{e}") } else { e.to_string() };
        if k == 1 { format!("{digits}e{es}") } else { format!("{}.{}e{es}", &digits[..1], &digits[1..]) }
    };
    format!("{sign}{body}")
}

/// JavaScript `String()` of a scalar.
pub fn js_str(v: &Json) -> String {
    match v {
        Json::Null => "null".into(),
        Json::Bool(b) => b.to_string(),
        Json::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => i.to_string(),
            (_, Some(u)) => u.to_string(),
            _ => js_num(n.as_f64().unwrap_or(0.0)),
        },
        Json::String(s) => s.clone(),
        Json::Array(a) => a
            .iter()
            .map(|x| if x.is_null() { String::new() } else { js_str(x) })
            .collect::<Vec<_>>()
            .join(","),
        Json::Object(_) => "[object Object]".into(),
    }
}

// ------------------------------------------------------- values as text ----

const INDICATORS: &str = "-?:,[]{}#&*!|>'\"%@`";

/// A string as YAML writes it in flow style: plain when it reads back as the same string.
fn yaml_scalar_str(s: &str) -> String {
    let first = s.chars().next();
    let second = s.chars().nth(1);
    let indicator = first.is_some_and(|c| INDICATORS.contains(c))
        && !(first.is_some_and(|c| "-?:".contains(c)) && second.is_some_and(|c| !" \t,[]{}".contains(c)));
    let quote = s.is_empty()
        || indicator
        || s.contains([',', '[', ']', '{', '}'])
        || s.contains(": ")
        || s.ends_with(':')
        || s.contains(" #")
        || s.starts_with([' ', '\t'])
        || s.ends_with([' ', '\t'])
        || s.contains(['\n', '\r', '\t'])
        || !resolve_plain_value(s).is_string();
    if quote {
        let e = s
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\t', "\\t")
            .replace('\r', "\\r");
        format!("\"{e}\"")
    } else {
        s.to_string()
    }
}

/// Value written as a one-line YAML flow literal: `{ x: 1, y: [ 2, 3 ] }`.
pub fn format_value(v: &Json) -> String {
    match v {
        Json::Null => "null".into(),
        Json::Bool(b) => b.to_string(),
        Json::Number(_) => js_str(v),
        Json::String(s) => yaml_scalar_str(s),
        Json::Array(a) if a.is_empty() => "[]".into(),
        Json::Array(a) => format!("[ {} ]", a.iter().map(format_value).collect::<Vec<_>>().join(", ")),
        Json::Object(o) if o.is_empty() => "{}".into(),
        Json::Object(o) => format!(
            "{{ {} }}",
            o.iter()
                .map(|(k, x)| format!("{}: {}", yaml_scalar_str(k), format_value(x)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

fn describe(v: &Json) -> String {
    match v {
        Json::Null => "null".into(),
        Json::Array(_) => "a list".into(),
        Json::Object(_) => "a mapping".into(),
        Json::String(_) => format!("text {}", format_value(v)),
        Json::Bool(_) => format!("boolean {}", format_value(v)),
        Json::Number(_) => format!("number {}", format_value(v)),
    }
}

// --------------------------------------------------------------- ints ----

/// Range of an integer primitive.
pub fn int_range(name: &str) -> Option<(i128, i128)> {
    Some(match name {
        "int8" => (-128, 127),
        "int16" => (-32768, 32767),
        "int32" => (-2147483648, 2147483647),
        "int64" => (i64::MIN as i128, i64::MAX as i128),
        "uint8" => (0, 255),
        "uint16" => (0, 65535),
        "uint32" => (0, 4294967295),
        "uint64" => (0, u64::MAX as i128),
        _ => return None,
    })
}

pub fn is_int_primitive(name: &str) -> bool {
    int_range(name).is_some()
}

/// Integer of a value: integral numbers, and text in decimal or 0x hexadecimal.
pub fn to_bigint(v: &Json) -> Option<i128> {
    match v {
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                return Some(i as i128);
            }
            if let Some(u) = n.as_u64() {
                return Some(u as i128);
            }
            let x = n.as_f64()?;
            (x.is_finite() && x == x.trunc()).then_some(x as i128)
        }
        Json::String(s) => {
            let (neg, rest) = match s.as_bytes().first() {
                Some(b'-') => (true, &s[1..]),
                Some(b'+') => (false, &s[1..]),
                _ => (false, &s[..]),
            };
            let n = if let Some(h) = rest.strip_prefix("0x").or_else(|| rest.strip_prefix("0X")) {
                if h.is_empty() || !h.chars().all(|c| c.is_ascii_hexdigit()) {
                    return None;
                }
                i128::from_str_radix(h, 16).ok()?
            } else {
                if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_digit()) {
                    return None;
                }
                rest.parse::<i128>().ok()?
            };
            Some(if neg { -n } else { n })
        }
        _ => None,
    }
}

// --------------------------------------------------------------- types ----

/// A type reference after aliases: a non-ref reference, a type definition, or nothing (a
/// deleted type or a cyclic alias).
pub enum Resolved<'a> {
    Ref(&'a Json),
    Def(&'a Json),
    None,
}

pub fn resolve<'a>(ix: &Index<'a>, mut t: &'a Json) -> Resolved<'a> {
    let mut seen = HashSet::new();
    loop {
        if ds(t, "kind") != "ref" {
            return Resolved::Ref(t);
        }
        let key = ds(t, "name");
        let Some(&i) = ix.type_idx.get(&key) else { return Resolved::None };
        if !seen.insert(key) {
            return Resolved::None;
        }
        let def = ix.types[i].def;
        if ds(def, "kind") != "alias" {
            return Resolved::Def(def);
        }
        t = &def["type"];
    }
}

/// Whether a struct field of type `t` may be left out of a value: optional, or a struct whose
/// fields may all be left out.
fn implicit(ix: &Index, t: &Json, seen: &mut HashSet<*const Json>) -> bool {
    match resolve(ix, t) {
        Resolved::Ref(r) if ds(r, "kind") == "optional" => true,
        Resolved::Def(def) if ds(def, "kind") == "struct" => {
            if !seen.insert(def as *const Json) {
                return false;
            }
            dl(def, "fields").iter().all(|f| f.get("default").is_some() || implicit(ix, &f["type"], seen))
        }
        _ => false,
    }
}

// -------------------------------------------------------------- checks ----

fn primitive_error(v: &Json, name: &str) -> Option<String> {
    match name {
        "bool" => (!v.is_boolean()).then(|| format!("Expected true or false, got {}", describe(v))),
        "float32" | "float64" => (!v.is_number()).then(|| format!("Expected a number, got {}", describe(v))),
        "char" => match v {
            Json::String(s) if s.chars().count() == 1 => None,
            _ => Some(format!("Expected one character, got {}", describe(v))),
        },
        "string" | "bytes" => match v {
            Json::String(_) => None,
            Json::Null | Json::Array(_) | Json::Object(_) => {
                Some(format!("Expected text, got {}", describe(v)))
            }
            _ => Some(format!("Expected text, got {} (quote it: \"{}\")", describe(v), js_str(v))),
        },
        _ => {
            let n = match v {
                Json::Bool(_) => None,
                v => to_bigint(v),
            };
            let Some(n) = n else { return Some(format!("Expected an integer, got {}", describe(v))) };
            let (min, max) = int_range(name)?;
            (n < min || n > max).then(|| format!("{n} does not fit in {name}"))
        }
    }
}

struct Checker<'i, 'a> {
    ix: &'i Index<'a>,
    errors: Vec<String>,
}

/// Problems of `v` as a value of type `t`, each prefixed with where it is in the value.
pub fn value_errors(ix: &Index, v: &Json, t: &Json) -> Vec<String> {
    let mut c = Checker { ix, errors: vec![] };
    c.check(v, t, "", &HashSet::new());
    c.errors
}

impl Checker<'_, '_> {
    fn at(&mut self, path: &str, msg: String) {
        self.errors.push(if path.is_empty() { msg } else { format!("{path}: {msg}") });
    }

    /// Map keys are text in YAML: read them as the key type.
    fn key(&self, k: &str, t: &Json) -> Json {
        if let Resolved::Ref(r) = resolve(self.ix, t)
            && ds(r, "kind") == "primitive"
        {
            let n = ds(r, "name");
            if n == "bool" {
                return match k {
                    "true" => Json::Bool(true),
                    "false" => Json::Bool(false),
                    _ => Json::String(k.into()),
                };
            }
            if (n == "float32" || n == "float64") && is_float_text(k) {
                return super::text::js_number(k.parse::<f64>().unwrap_or(0.0));
            }
        }
        Json::String(k.into())
    }

    fn check(&mut self, v: &Json, t: &Json, path: &str, seen: &HashSet<String>) {
        let kind = ds(t, "kind");
        match kind.as_str() {
            "primitive" => {
                let name = ds(t, "name");
                if let Some(e) = primitive_error(v, &name) {
                    self.at(path, e);
                } else if dh(t, "max")
                    && let Json::String(s) = v
                {
                    let size = if name == "bytes" { s.chars().count() } else { s.len() };
                    let max = t["max"].as_f64().unwrap_or(0.0);
                    if size as f64 > max {
                        self.at(path, format!("{size} bytes, more than the bound of {}", js_str(&t["max"])));
                    }
                }
            }
            "optional" => {
                if !v.is_null() {
                    self.check(v, &t["of"], path, seen);
                }
            }
            "array" | "vector" | "list" | "set" => {
                let Json::Array(items) = v else {
                    return self.at(path, format!("Expected a list, got {}", describe(v)));
                };
                let n = items.len();
                if kind == "array" && Some(n as f64) != t["size"].as_f64() {
                    self.at(path, format!("Expected {} elements, got {n}", js_str(&t["size"])));
                }
                if kind != "array" && dh(t, "max") && n as f64 > t["max"].as_f64().unwrap_or(0.0) {
                    self.at(path, format!("{n} elements, more than the bound of {}", js_str(&t["max"])));
                }
                for (i, e) in items.iter().enumerate() {
                    self.check(e, &t["of"], &format!("{path}[{i}]"), seen);
                }
                if kind == "set" {
                    let texts: Vec<String> = items.iter().map(format_value).collect();
                    for (i, s) in texts.iter().enumerate() {
                        if texts.iter().position(|x| x == s) < Some(i) {
                            self.at(path, format!("Duplicate element {s}"));
                        }
                    }
                }
            }
            "map" => {
                let Json::Object(o) = v else {
                    return self.at(path, format!("Expected a mapping, got {}", describe(v)));
                };
                if dh(t, "max") && o.len() as f64 > t["max"].as_f64().unwrap_or(0.0) {
                    self.at(
                        path,
                        format!("{} entries, more than the bound of {}", o.len(), js_str(&t["max"])),
                    );
                }
                for (k, e) in o {
                    let kv = self.key(k, &t["key"]);
                    self.check(&kv, &t["key"], &format!("{path}[{k}]"), seen);
                    self.check(e, &t["value"], &format!("{path}[{k}]"), seen);
                }
            }
            "ref" => self.check_ref(v, t, path, seen),
            _ => {}
        }
    }

    fn check_ref(&mut self, v: &Json, t: &Json, path: &str, seen: &HashSet<String>) {
        let name = ds(t, "name");
        // Deleted types are reported on their own.
        let Some(&i) = self.ix.type_idx.get(&name) else { return };
        let def = self.ix.types[i].def;
        let dname = ds(def, "name");
        match ds(def, "kind").as_str() {
            "primitive" => {}
            "alias" => {
                if !seen.contains(&name) {
                    let mut s2 = seen.clone();
                    s2.insert(name);
                    self.check(v, &def["type"], path, &s2);
                }
            }
            "enum" => {
                let names: Vec<String> = dl(def, "values").iter().map(|x| ds(x, "name")).collect();
                if !v.as_str().is_some_and(|s| names.iter().any(|n| n == s)) {
                    self.at(
                        path,
                        format!("Expected a value of {dname} ({}), got {}", names.join(", "), describe(v)),
                    );
                }
            }
            "bitmask" => {
                let names: Vec<String> = dl(def, "flags").iter().map(|x| ds(x, "name")).collect();
                let Json::Array(items) = v else {
                    return self.at(path, format!("Expected a list of {dname} flags, got {}", describe(v)));
                };
                for (i, e) in items.iter().enumerate() {
                    match e.as_str() {
                        Some(s) if names.iter().any(|n| n == s) => {
                            if items.iter().position(|x| x == e) < Some(i) {
                                self.at(path, format!("Duplicate flag {s}"));
                            }
                        }
                        _ => self.at(
                            &format!("{path}[{i}]"),
                            format!("Expected a flag of {dname} ({}), got {}", names.join(", "), describe(e)),
                        ),
                    }
                }
            }
            "union" => {
                let entries: Vec<(&String, &Json)> =
                    v.as_object().map(|o| o.iter().collect()).unwrap_or_default();
                if entries.len() != 1 {
                    return self.at(
                        path,
                        format!("Expected a mapping of one {dname} case (case: value), got {}", describe(v)),
                    );
                }
                let (cname, e) = entries[0];
                let Some(c) = dl(def, "cases").iter().find(|x| &ds(x, "name") == cname) else {
                    return self.at(path, format!("Unknown case '{cname}' of {dname}"));
                };
                let p = if path.is_empty() { cname.clone() } else { format!("{path}.{cname}") };
                self.check(e, &c["type"], &p, seen);
            }
            _ => {
                // struct / exception
                let Json::Object(o) = v else {
                    return self
                        .at(path, format!("Expected a mapping of {dname} fields, got {}", describe(v)));
                };
                let fields = dl(def, "fields");
                for k in o.keys() {
                    if !fields.iter().any(|f| &ds(f, "name") == k) {
                        self.at(path, format!("Unknown field '{k}' of {dname}"));
                    }
                }
                for f in fields {
                    let fname = ds(f, "name");
                    match o.get(&fname) {
                        Some(e) => {
                            let p = if path.is_empty() { fname.clone() } else { format!("{path}.{fname}") };
                            self.check(e, &f["type"], &p, seen);
                        }
                        None => {
                            if f.get("default").is_none()
                                && !implicit(self.ix, &f["type"], &mut HashSet::new())
                            {
                                self.at(path, format!("Missing field '{fname}' of {dname}"));
                            }
                        }
                    }
                }
            }
        }
    }
}

/// `^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$` (case-insensitive).
fn is_float_text(s: &str) -> bool {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$").unwrap());
    RE.is_match(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers() {
        assert_eq!(js_num(1e-7), "1e-7");
        assert_eq!(js_num(1e21), "1e+21");
        assert_eq!(js_num(123.456), "123.456");
        assert_eq!(js_num(0.000001), "0.000001");
        assert_eq!(js_num(-2.5), "-2.5");
        assert_eq!(js_num(18446744073709551615.0), "18446744073709552000");
    }

    #[test]
    fn flow() {
        let v = serde_json::json!({"a": [1, "x y", "1", ""], "b: c": null, "d": "-x"});
        assert_eq!(format_value(&v), r#"{ a: [ 1, x y, "1", "" ], "b: c": null, d: -x }"#);
    }
}
