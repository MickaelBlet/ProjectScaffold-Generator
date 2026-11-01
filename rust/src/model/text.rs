// Project file text: YAML (1.2 core schema, as the `yaml` package reads it) or JSON, read into a
// JSON value with the line of each node, to locate problems by their data path as the editor does
// (src/model/serialize.ts parseText / lineOfPath).
use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Number, Value as Json};
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser};
use yaml_rust2::scanner::{Marker, TScalarStyle};

/// A step of a data path: an object key or an array index.
#[derive(Debug, Clone, PartialEq)]
pub enum Seg {
    Key(String),
    Idx(usize),
}

pub type DataPath = Vec<Seg>;

/// Builds a data path: `path!["modules", 0, "name"]`.
#[macro_export]
macro_rules! path {
    ($($s:expr),* $(,)?) => { vec![$($crate::model::text::Seg::from($s)),*] };
}

impl From<&str> for Seg {
    fn from(s: &str) -> Self {
        Seg::Key(s.to_string())
    }
}
impl From<String> for Seg {
    fn from(s: String) -> Self {
        Seg::Key(s)
    }
}
impl From<&String> for Seg {
    fn from(s: &String) -> Self {
        Seg::Key(s.clone())
    }
}
impl From<usize> for Seg {
    fn from(i: usize) -> Self {
        Seg::Idx(i)
    }
}

/// Dot-separated text of a path, as zod prints it (`types.0.name`).
pub fn path_text(p: &[Seg]) -> String {
    p.iter()
        .map(|s| match s {
            Seg::Key(k) => k.clone(),
            Seg::Idx(i) => i.to_string(),
        })
        .collect::<Vec<_>>()
        .join(".")
}

/// Lines of the nodes of a document (from 1).
#[derive(Debug, Default)]
pub enum Lines {
    #[default]
    None,
    Scalar(usize),
    /// Start line, and the entries: key, line of the key, value.
    Map(usize, Vec<(String, usize, Lines)>),
    Seq(usize, Vec<Lines>),
}

impl Lines {
    fn start(&self) -> Option<usize> {
        match self {
            Lines::None => None,
            Lines::Scalar(l) | Lines::Map(l, _) | Lines::Seq(l, _) => Some(*l),
        }
    }

    /// Line of a path: that of the key of the deepest entry of the path found (an item: its start).
    pub fn of(&self, path: &[Seg]) -> Option<usize> {
        let mut node = self;
        let mut at = node.start();
        for seg in path {
            let (next, offset) = match (node, seg) {
                (Lines::Map(_, entries), Seg::Key(k)) => match entries.iter().find(|e| &e.0 == k) {
                    Some((_, line, v)) => (v, Some(*line)),
                    None => break,
                },
                (Lines::Seq(_, items), Seg::Idx(i)) => match items.get(*i) {
                    Some(v) => (v, v.start()),
                    None => break,
                },
                _ => break,
            };
            let Some(o) = offset else { break };
            at = Some(o);
            node = next;
        }
        at
    }
}

/// A file read: its data and the lines of its nodes.
pub struct Doc {
    pub value: Json,
    pub lines: Lines,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Format {
    Yaml,
    Json,
}

pub fn format_from_path(path: &str) -> Format {
    if path.to_lowercase().ends_with(".json") { Format::Json } else { Format::Yaml }
}

/// A syntax error: message and line.
pub struct SyntaxError {
    pub message: String,
    pub line: Option<usize>,
}

/// Reads a project file text.
pub fn parse_text(text: &str, format: Format) -> Result<Doc, SyntaxError> {
    match format {
        Format::Json => {
            let value: Json = serde_json::from_str(text)
                .map_err(|e| SyntaxError { message: format!("Invalid JSON: {e}"), line: Some(e.line()) })?;
            // JSON parses as YAML: its lines.
            let lines = parse_yaml(text).map(|d| d.lines).unwrap_or_default();
            Ok(Doc { value: js_numbers(value), lines })
        }
        Format::Yaml => parse_yaml(text)
            .map_err(|(message, line)| SyntaxError { message: format!("Invalid YAML: {message}"), line }),
    }
}

enum Frame {
    Map {
        start: usize,
        map: Map<String, Json>,
        lines: Vec<(String, usize, Lines)>,
        key: Option<(String, usize)>,
    },
    Seq {
        start: usize,
        items: Vec<Json>,
        lines: Vec<Lines>,
    },
}

struct Builder {
    stack: Vec<(Frame, usize)>,
    anchors: HashMap<usize, (Json, usize)>,
    root: Option<(Json, Lines)>,
    error: Option<(String, Option<usize>)>,
    docs: usize,
}

static INT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-+]?[0-9]+$").unwrap());
static OCT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^0o[0-7]+$").unwrap());
static HEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^0x[0-9a-fA-F]+$").unwrap());
static FLOAT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$").unwrap());

/// A JavaScript number as JSON: integral values as integers.
pub fn js_number(x: f64) -> Json {
    if x.is_finite() && x == x.trunc() && x.abs() < 9e15 {
        Json::Number(Number::from(x as i64))
    } else {
        Number::from_f64(x).map(Json::Number).unwrap_or(Json::Null)
    }
}

/// Numbers as JavaScript has them: `1.0` is 1, integers beyond 2^53 rounded.
fn js_numbers(v: Json) -> Json {
    match v {
        Json::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) if i.unsigned_abs() < (1 << 53) => Json::Number(n),
            (None, Some(u)) if u < (1 << 53) => Json::Number(n),
            _ => js_number(n.as_f64().unwrap_or(0.0)),
        },
        Json::Array(a) => Json::Array(a.into_iter().map(js_numbers).collect()),
        Json::Object(o) => js_object(o.into_iter().map(|(k, v)| (k, js_numbers(v))).collect()),
        v => v,
    }
}

/// Whether a key is an array index, which JavaScript objects list first, in ascending order.
fn array_index(k: &str) -> Option<u32> {
    if k == "0" || (!k.starts_with('0') && !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit())) {
        k.parse::<u32>().ok().filter(|&n| n < u32::MAX)
    } else {
        None
    }
}

/// An object with its keys in JavaScript's order: array indexes first, ascending, then the others
/// in insertion order.
fn js_object(entries: Vec<(String, Json)>) -> Json {
    if !entries.iter().any(|(k, _)| array_index(k).is_some()) {
        return Json::Object(entries.into_iter().collect());
    }
    let (mut idx, other): (Vec<_>, Vec<_>) = entries.into_iter().partition(|(k, _)| array_index(k).is_some());
    idx.sort_by_key(|(k, _)| array_index(k));
    Json::Object(idx.into_iter().chain(other).collect())
}

/// A plain scalar, by the YAML 1.2 core schema.
pub fn resolve_plain_value(s: &str) -> Json {
    resolve_plain(s)
}

fn resolve_plain(s: &str) -> Json {
    match s {
        "" | "~" | "null" | "Null" | "NULL" => return Json::Null,
        "true" | "True" | "TRUE" => return Json::Bool(true),
        "false" | "False" | "FALSE" => return Json::Bool(false),
        ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" | "-.inf" | "-.Inf" | "-.INF" | ".nan"
        | ".NaN" | ".NAN" => return Json::Null,
        _ => {}
    }
    if INT.is_match(s) {
        return match s.parse::<f64>() {
            Ok(x) => js_number(x),
            Err(_) => Json::String(s.into()),
        };
    }
    if OCT.is_match(s) {
        return js_number(i128::from_str_radix(&s[2..], 8).map(|x| x as f64).unwrap_or(f64::NAN));
    }
    if HEX.is_match(s) {
        return js_number(i128::from_str_radix(&s[2..], 16).map(|x| x as f64).unwrap_or(f64::NAN));
    }
    if FLOAT.is_match(s) {
        return s.parse::<f64>().map(js_number).unwrap_or(Json::String(s.into()));
    }
    Json::String(s.into())
}

/// Text of a mapping key, as JavaScript makes it an object key.
fn key_text(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        Json::Null => String::new(),
        v => v.to_string(),
    }
}

impl Builder {
    fn add(&mut self, value: Json, lines: Lines, anchor: usize) {
        if anchor > 0 {
            let line = lines.start().unwrap_or(0);
            self.anchors.insert(anchor, (value.clone(), line));
        }
        match self.stack.last_mut() {
            None => {
                self.docs += 1;
                if self.root.is_none() {
                    self.root = Some((value, lines));
                }
            }
            Some((Frame::Seq { items, lines: ls, .. }, _)) => {
                items.push(value);
                ls.push(lines);
            }
            Some((Frame::Map { map, lines: ls, key, .. }, _)) => match key.take() {
                None => *key = Some((key_text(&value), lines.start().unwrap_or(0))),
                Some((k, kline)) => {
                    if map.contains_key(&k) && self.error.is_none() {
                        self.error = Some(("Map keys must be unique".into(), Some(kline)));
                    }
                    map.insert(k.clone(), value);
                    ls.retain(|e| e.0 != k);
                    ls.push((k, kline, lines));
                }
            },
        }
    }
}

impl MarkedEventReceiver for Builder {
    fn on_event(&mut self, ev: Event, mark: Marker) {
        let line = mark.line();
        match ev {
            Event::Scalar(s, style, anchor, tag) => {
                let v = match (style, &tag) {
                    (_, Some(t)) if t.suffix == "str" => Json::String(s),
                    (TScalarStyle::Plain, _) => resolve_plain(&s),
                    _ => Json::String(s),
                };
                self.add(v, Lines::Scalar(line), anchor);
            }
            Event::Alias(id) => {
                let (v, l) = self.anchors.get(&id).cloned().unwrap_or((Json::Null, line));
                let _ = l;
                self.add(v, Lines::Scalar(line), 0);
            }
            Event::SequenceStart(anchor, _) => {
                self.stack.push((Frame::Seq { start: line, items: vec![], lines: vec![] }, anchor))
            }
            Event::MappingStart(anchor, _) => self
                .stack
                .push((Frame::Map { start: line, map: Map::new(), lines: vec![], key: None }, anchor)),
            Event::SequenceEnd | Event::MappingEnd => {
                let Some((frame, anchor)) = self.stack.pop() else { return };
                let (v, l) = match frame {
                    Frame::Seq { start, items, lines } => (Json::Array(items), Lines::Seq(start, lines)),
                    Frame::Map { start, map, lines, .. } => (Json::Object(map), Lines::Map(start, lines)),
                };
                self.add(v, l, anchor);
            }
            _ => {}
        }
    }
}

fn parse_yaml(text: &str) -> Result<Doc, (String, Option<usize>)> {
    let mut b = Builder { stack: vec![], anchors: HashMap::new(), root: None, error: None, docs: 0 };
    let mut parser = Parser::new_from_str(text);
    parser.load(&mut b, true).map_err(|e| (e.info().to_string(), Some(e.marker().line())))?;
    if let Some(e) = b.error {
        return Err(e);
    }
    if b.docs > 1 {
        return Err(("Source contains multiple documents; please use YAML.parseAllDocuments()".into(), None));
    }
    let (value, lines) = b.root.unwrap_or((Json::Null, Lines::None));
    Ok(Doc { value: js_numbers(value), lines })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::useless_vec)] // path! builds the DataPath (a Vec) the code passes
    fn values_and_lines() {
        let d = parse_text("# c\na: 1\nb:\n  - x: 1.0\n    y: '1'\n  - [no, ~, 0x1f, 1e3]\n", Format::Yaml)
            .ok()
            .unwrap();
        assert_eq!(d.value, serde_json::json!({"a": 1, "b": [{"x": 1, "y": "1"}, ["no", null, 31, 1000]]}));
        assert_eq!(d.lines.of(&path!["a"]), Some(2));
        assert_eq!(d.lines.of(&path!["b", 0, "y"]), Some(5));
        assert_eq!(d.lines.of(&path!["b", 1]), Some(6));
        assert_eq!(d.lines.of(&path!["b", 0, "zz"]), Some(4));
        assert_eq!(d.lines.of(&path![]), Some(2));
    }
}
