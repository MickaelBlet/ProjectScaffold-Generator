// Structure check of a project file against the published JSON Schema (schema/scaffold.schema.json),
// with the messages of zod (the editor's model, which generates the schema): the same errors as the
// editor for the same file.
//
// Only the keywords the schema uses: type, properties, required, items, $ref, enum, const, pattern,
// minLength, minimum, maximum, exclusiveMinimum, propertyNames / additionalProperties (records),
// anyOf (unions; `[X, null]`: nullable X), oneOf (unions discriminated by `kind`). As zod: unknown
// properties are allowed; a type error stops the checks of a value (it "aborts"), the other checks
// (length, bounds, patterns) do not; a union reports the issues of its only option without aborting
// ones, else "Invalid input".
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use regex::Regex;
use serde_json::Value as Json;

use super::text::{DataPath, Seg, path_text};

static SCHEMA: LazyLock<Json> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../../schema/scaffold.schema.json")).unwrap());

pub struct Issue {
    pub path: DataPath,
    /// `path: message`, `<root>` for the root.
    pub message: String,
    aborting: bool,
}

struct Checker<'s> {
    defs: &'s Json,
    issues: Vec<Issue>,
}

/// Issues of a project file, in order.
pub fn check_file(v: &Json) -> Vec<Issue> {
    let mut c = Checker { defs: &SCHEMA["$defs"], issues: vec![] };
    c.check(Some(v), &SCHEMA, &mut vec![]);
    c.issues
}

/// zod's name of the type of a value.
fn received(v: Option<&Json>) -> &'static str {
    match v {
        None => "undefined",
        Some(Json::Null) => "null",
        Some(Json::Array(_)) => "array",
        Some(Json::Object(_)) => "object",
        Some(Json::Number(_)) => "number",
        Some(Json::String(_)) => "string",
        Some(Json::Bool(_)) => "boolean",
    }
}

fn is_int(n: &serde_json::Number) -> bool {
    n.is_i64() || n.is_u64()
}

static REGEXES: LazyLock<Mutex<HashMap<String, Regex>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn matches(s: &str, pattern: &str) -> bool {
    let mut cache = REGEXES.lock().unwrap();
    let re = cache
        .entry(pattern.to_string())
        .or_insert_with(|| Regex::new(&pattern.replace("\\/", "/")).expect("schema pattern"));
    re.is_match(s)
}

/// zod's custom message of the pattern (the schema has none).
fn pattern_message(pattern: &str, path: &str) -> &'static str {
    if pattern == "^[A-Za-z_][A-Za-z0-9_]*$" {
        return "must be a valid identifier";
    }
    if pattern.starts_with("^[A-Za-z_][A-Za-z0-9_]*(") {
        return "must be a dot-separated module path";
    }
    if path.starts_with("editor.") {
        return "must be a dot-separated module path, with its dependency name and a slash for a module of a dependency";
    }
    "must be a type name, with its module path for a type of a module (and its dependency name and a slash for a module of a dependency)"
}

fn num(v: &Json) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

/// A number as JavaScript prints it.
fn js_text(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        v => v.to_string(),
    }
}

impl<'s> Checker<'s> {
    fn issue(&mut self, path: &DataPath, msg: impl Into<String>, aborting: bool) {
        let p = path_text(path);
        let p = if p.is_empty() { "<root>".to_string() } else { p };
        self.issues.push(Issue { path: path.clone(), message: format!("{p}: {}", msg.into()), aborting });
    }

    fn resolve(&self, mut s: &'s Json) -> &'s Json {
        while let Some(r) = s.get("$ref").and_then(Json::as_str) {
            s = &self.defs[r.trim_start_matches("#/$defs/")];
        }
        s
    }

    fn type_issue(&mut self, path: &DataPath, expected: &str, v: Option<&Json>) {
        self.issue(path, format!("Invalid input: expected {expected}, received {}", received(v)), true);
    }

    fn check(&mut self, v: Option<&Json>, s: &'s Json, path: &mut DataPath) {
        let s = self.resolve(s);
        if let Some(opts) = s.get("anyOf").and_then(Json::as_array) {
            return self.any(v, opts, path);
        }
        if let Some(opts) = s.get("oneOf").and_then(Json::as_array) {
            return self.one(v, opts, path);
        }
        if let Some(x) = s.get("const") {
            if v != Some(x) {
                let e = match x {
                    Json::String(t) => format!("\"{t}\""),
                    x => x.to_string(),
                };
                self.issue(path, format!("Invalid input: expected {e}"), true);
            }
            return;
        }
        if let Some(x) = s.get("enum").and_then(Json::as_array) {
            if let Some(Json::String(t)) = v
                && x.iter().any(|e| e.as_str() == Some(t))
            {
                return;
            }
            let e: Vec<String> = x.iter().map(|e| format!("\"{}\"", js_text(e))).collect();
            self.issue(path, format!("Invalid option: expected one of {}", e.join("|")), true);
            return;
        }
        let Some(ty) = s.get("type").and_then(Json::as_str) else { return };
        match ty {
            "string" => {
                let Some(Json::String(t)) = v else { return self.type_issue(path, "string", v) };
                if let Some(min) = s.get("minLength")
                    && (t.chars().count() as f64) < num(min)
                {
                    self.issue(
                        path,
                        format!("Too small: expected string to have >={} characters", js_text(min)),
                        false,
                    );
                }
                if let Some(p) = s.get("pattern").and_then(Json::as_str)
                    && !matches(t, p)
                {
                    let m = pattern_message(p, &path_text(path));
                    self.issue(path, m, false);
                }
            }
            "number" | "integer" => {
                let Some(Json::Number(n)) = v else { return self.type_issue(path, "number", v) };
                if ty == "integer" && !is_int(n) {
                    return self.issue(path, "Invalid input: expected int, received number", true);
                }
                let x = n.as_f64().unwrap_or(0.0);
                if let Some(m) = s.get("exclusiveMinimum")
                    && x <= num(m)
                {
                    self.issue(path, format!("Too small: expected number to be >{}", js_text(m)), false);
                } else if let Some(m) = s.get("minimum")
                    && x < num(m)
                    && num(m) > -9e15
                {
                    self.issue(path, format!("Too small: expected number to be >={}", js_text(m)), false);
                }
                if let Some(m) = s.get("maximum")
                    && x > num(m)
                    && num(m) < 9e15
                {
                    self.issue(path, format!("Too big: expected number to be <={}", js_text(m)), false);
                }
            }
            "boolean" => {
                if !matches!(v, Some(Json::Bool(_))) {
                    self.type_issue(path, "boolean", v);
                }
            }
            "null" => {
                if !matches!(v, Some(Json::Null)) {
                    self.type_issue(path, "null", v);
                }
            }
            "array" => {
                let Some(Json::Array(items)) = v else { return self.type_issue(path, "array", v) };
                if let Some(x) = s.get("items") {
                    for (i, item) in items.iter().enumerate() {
                        path.push(Seg::Idx(i));
                        self.check(Some(item), x, path);
                        path.pop();
                    }
                }
            }
            "object" => {
                let Some(props) = s.get("properties").and_then(Json::as_object) else {
                    // a record: keys checked by propertyNames, values by additionalProperties
                    let Some(Json::Object(o)) = v else { return self.type_issue(path, "record", v) };
                    for (key, value) in o {
                        path.push(Seg::Key(key.clone()));
                        let before = self.issues.len();
                        if let Some(x) = s.get("propertyNames") {
                            self.check(Some(&Json::String(key.clone())), x, path);
                        }
                        if self.issues.len() > before {
                            self.issues.truncate(before);
                            self.issue(path, "Invalid key in record", true);
                        } else if let Some(x) = s.get("additionalProperties").filter(|x| x.is_object()) {
                            self.check(Some(value), x, path);
                        }
                        path.pop();
                    }
                    return;
                };
                let Some(Json::Object(o)) = v else { return self.type_issue(path, "object", v) };
                let required: Vec<&str> = s
                    .get("required")
                    .and_then(Json::as_array)
                    .map(|r| r.iter().filter_map(Json::as_str).collect())
                    .unwrap_or_default();
                for (key, sub) in props {
                    let x = o.get(key);
                    if x.is_none() && !required.contains(&key.as_str()) {
                        continue;
                    }
                    path.push(Seg::Key(key.clone()));
                    self.check(x, sub, path);
                    path.pop();
                }
            }
            _ => {}
        }
    }

    /// anyOf: `[X, {type: null}]` is a nullable X; else a union.
    fn any(&mut self, v: Option<&Json>, opts: &'s [Json], path: &mut DataPath) {
        if opts.len() == 2
            && opts[1].get("type").and_then(Json::as_str) == Some("null")
            && opts[1].get("anyOf").is_none()
        {
            if matches!(v, Some(Json::Null)) {
                return;
            }
            return self.check(v, &opts[0], path);
        }
        // z.json(): any value
        if opts.iter().any(|o| o.get("type").and_then(Json::as_str) == Some("null")) {
            return;
        }
        let start = self.issues.len();
        let mut non_aborting = 0;
        let mut which = 0;
        for (i, o) in opts.iter().enumerate() {
            self.check(v, o, path);
            if self.issues.len() == start {
                return;
            }
            if self.issues[start..].iter().all(|x| !x.aborting) {
                non_aborting += 1;
                which = i;
            }
            self.issues.truncate(start);
        }
        if non_aborting == 1 {
            return self.check(v, &opts[which], path);
        }
        self.issue(path, "Invalid input", true);
    }

    /// oneOf: union discriminated by `kind` (the const of each option's `kind` property).
    fn one(&mut self, v: Option<&Json>, opts: &'s [Json], path: &mut DataPath) {
        let Some(Json::Object(o)) = v else { return self.type_issue(path, "object", v) };
        let kind = o.get("kind").and_then(Json::as_str);
        let mut expected = vec![];
        for opt in opts {
            let c = opt["properties"]["kind"]["const"].as_str().unwrap_or("");
            if Some(c) == kind {
                return self.check(v, opt, path);
            }
            expected.push(format!("'{c}'"));
        }
        path.push(Seg::Key("kind".into()));
        self.issue(path, format!("Invalid discriminator value. Expected {}", expected.join(" | ")), true);
        path.pop();
    }
}
