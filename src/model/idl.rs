// Import of OMG IDL files (IDL 4.2: CORBA, CCM, DDS / XTypes): port of `src/model/idl.ts`.
// A C-like preprocessor runs first (#include, #define, #if...; `import "file";` includes like
// #include), then the whole grammar is read: modules (template modules too), interfaces, valuetypes,
// eventtypes, components, connectors, porttypes, homes, structs, unions, enums, bitmasks, bitsets,
// exceptions, typedefs, constants and annotations. Modules are flattened: entities keep their simple
// name, qualified with their modules when two share it. Components and connectors become modules
// with ports. What the model cannot express is approximated or left out, and reported.
//
// The result is the project file (`toFile(idlProject(..).project, { editor: false })` of the
// TypeScript model): the in-memory project is built here with names instead of ids, and exported.
#![allow(clippy::too_many_arguments)]

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;
use serde_json::{Number, Value as Json, json};

type Res<T> = Result<T, String>;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid regex")
}

// JavaScript semantics

/// JavaScript whitespace (`\s`, `trim`).
fn is_js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{b}'
            | '\u{c}'
            | '\r'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    ) || ('\u{2000}'..='\u{200a}').contains(&c)
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_ws)
}

/// `String(number)`.
fn js_num_str(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if f == 0.0 {
        return "0".into();
    }
    let sign = if f < 0.0 { "-" } else { "" };
    let sci = format!("{:e}", f.abs());
    let (mant, exp) = sci.split_once('e').unwrap();
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap() + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let es = format!("{}{}", if e < 0 { '-' } else { '+' }, e.abs());
        if k == 1 { format!("{digits}e{es}") } else { format!("{}.{}e{es}", &digits[..1], &digits[1..]) }
    };
    format!("{sign}{body}")
}

/// A number as JSON, like `JSON.stringify` writes it (integral values without a fraction).
fn num_json(f: f64) -> Json {
    if !f.is_finite() {
        Json::Null
    } else if f.fract() == 0.0 && f.abs() < 9.0e18 {
        json!(f as i64)
    } else {
        Json::Number(Number::from_f64(f).unwrap())
    }
}

/// First non-empty string (`a || b || c`).
fn or<'a>(parts: &[&'a str]) -> &'a str {
    parts.iter().copied().find(|s| !s.is_empty()).unwrap_or("")
}

// Paths

/// `/`-separated path without `.` and `..` steps.
fn normalize_path(path: &str) -> String {
    let p = path.replace('\\', "/");
    let mut out: Vec<&str> = Vec::new();
    for (i, part) in p.split('/').enumerate() {
        if part == "." || (part.is_empty() && i > 0) {
            continue;
        }
        if part == ".." && out.last().is_some_and(|l| *l != ".." && !l.is_empty()) {
            out.pop();
        } else {
            out.push(part);
        }
    }
    out.join("/")
}

fn dir_of(path: &str) -> &str {
    &path[..path.rfind('/').map_or(0, |i| i + 1)]
}

fn base_name(path: &str) -> &str {
    &path[path.rfind('/').map_or(0, |i| i + 1)..]
}

/// Where an include of `name` from file `from` may be: next to it, then in its ancestor folders.
fn include_candidates(name: &str, from: &str) -> Vec<String> {
    static DRIVE: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-z]:/"));
    let n = normalize_path(name);
    if n.starts_with('/') || DRIVE.is_match(&n) {
        return vec![n];
    }
    let mut dirs: Vec<&str> = Vec::new();
    let mut dir = dir_of(from);
    while !dir.is_empty() {
        dirs.push(dir);
        dir = dir_of(&dir[..dir.len() - 1]);
    }
    let mut out: Vec<String> = Vec::new();
    for c in dirs.iter().map(|d| normalize_path(&format!("{d}{n}"))).chain(std::iter::once(n.clone())) {
        if !out.contains(&c) {
            out.push(c);
        }
    }
    out
}

/// The file of `files` an include names: a candidate path, else any with that path suffix or name.
fn find_include(name: &str, from: &str, files: &IndexMap<String, String>) -> Option<String> {
    for c in include_candidates(name, from) {
        if files.contains_key(&c) {
            return Some(c);
        }
    }
    let n = normalize_path(name);
    let suffix = format!("/{n}");
    files
        .keys()
        .find(|k| k.ends_with(&suffix))
        .or_else(|| files.keys().find(|k| base_name(k) == base_name(&n)))
        .cloned()
}

static INCLUDE_RE: LazyLock<Regex> = LazyLock::new(|| {
    re(r#"(?m)^[ \t]*#[ \t]*(?:include|import)[ \t]*[<"]([^>"\n]+)[>"]|(?-u:\b)import\s+"([^"\n]+)""#)
});

/// Names of the files a text includes.
fn include_names(text: &str) -> Vec<String> {
    INCLUDE_RE
        .captures_iter(text)
        .map(|m| m.get(1).or_else(|| m.get(2)).unwrap().as_str().to_string())
        .collect()
}

fn normalize_files(files: &IndexMap<String, String>) -> IndexMap<String, String> {
    files.iter().map(|(k, v)| (normalize_path(k), v.clone())).collect()
}

/// The file `root` (its `text`) with the files it includes, transitively, that `read` can read.
/// Includes found nowhere are reported by the parser.
pub fn read_idl_includes(
    root: &str,
    text: &str,
    read: &dyn Fn(&str) -> Option<String>,
) -> Result<IndexMap<String, String>, String> {
    let mut all = normalize_files(&IndexMap::from([(root.to_string(), text.to_string())]));
    let mut queue: VecDeque<String> = all.keys().cloned().collect();
    let mut tried: HashSet<String> = HashSet::new();
    while let Some(from) = queue.pop_front() {
        let names = include_names(&all[&from]);
        for name in names {
            if find_include(&name, &from, &all).is_some() {
                continue;
            }
            for c in include_candidates(&name, &from) {
                if !tried.insert(c.clone()) {
                    continue;
                }
                let Some(text) = read(&c) else { continue };
                all.insert(c.clone(), text);
                queue.push_back(c);
                break;
            }
        }
    }
    Ok(all)
}

// Tokens

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TokenKind {
    Ident,
    Int,
    Float,
    Str,
    Char,
    Punct,
    Directive,
}

#[derive(Clone, Debug)]
struct Token {
    kind: TokenKind,
    text: String,
    file: String,
    line: usize,
    /// Comment block right above the token.
    doc: String,
    /// Comment following the token on its line.
    trail: String,
}

impl Token {
    /// A token at the place of `like`.
    fn like(kind: TokenKind, text: &str, like: &Token) -> Token {
        Token {
            kind,
            text: text.to_string(),
            file: like.file.clone(),
            line: like.line,
            doc: String::new(),
            trail: String::new(),
        }
    }
}

/// Where a token is, for messages: its line, and its file when not the main one.
/// Levels of nesting allowed (modules, types, expressions, macros): deeper, the stack would
/// overflow on hostile input.
const MAX_NESTING: usize = 100;
/// Tokens a macro expansion may produce (macros doubling at each level grow exponentially).
const MAX_EXPANSION: usize = 1_000_000;

thread_local! {
    static NESTING: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// One more level of nesting while held; None past `MAX_NESTING`.
struct Nesting;

impl Nesting {
    fn enter() -> Option<Nesting> {
        NESTING.with(|n| {
            if n.get() >= MAX_NESTING {
                return None;
            }
            n.set(n.get() + 1);
            Some(Nesting)
        })
    }
}

impl Drop for Nesting {
    fn drop(&mut self) {
        NESTING.with(|n| n.set(n.get() - 1));
    }
}

fn too_deep(t: Option<&Token>, main: &str) -> String {
    let msg = format!("nested more than {MAX_NESTING} levels deep");
    match t {
        Some(t) => format!("{}: {msg}", at(t, main)),
        None => msg,
    }
}

fn at(t: &Token, main: &str) -> String {
    if !t.file.is_empty() && t.file != main {
        format!("Line {} of {}", t.line, base_name(&t.file))
    } else {
        format!("Line {}", t.line)
    }
}

fn clean_comment(raw: &str) -> String {
    static LINE: LazyLock<Regex> = LazyLock::new(|| re(r"^//[/!]?<?"));
    static BLOCK: LazyLock<Regex> = LazyLock::new(|| re(r"^/\*[*!]?<?|\*/$"));
    static LEAD: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*\*?\s?"));
    let body = if raw.starts_with("//") { LINE.replace(raw, "") } else { BLOCK.replace_all(raw, "") };
    let lines: Vec<String> =
        body.split('\n').map(|l| js_trim_end(&LEAD.replace(l, "")).to_string()).collect();
    js_trim(&lines.join("\n")).to_string()
}

const TOKEN_PATTERN: &str = concat!(
    r#"^(?:([\s\x{FEFF}]+)|(//[^\n]*|/\*[\s\S]*?\*/)|(L?"(?:[^"\\\n]|\\.)*")|(L?'(?:[^'\\\n]|\\.)*')"#,
    r#"|([A-Za-z_][A-Za-z0-9_]*)"#,
    r#"|(0[xX][0-9a-fA-F]+[uUlL]*|(?:[0-9]+\.[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?[fFdDlL]?|[0-9]+[eE][+-]?[0-9]+[fFdDlL]?|[0-9]+[dD]|[0-9]+[uUlL]*)"#,
    r#"|(::|<<|&&|\|\||==|!=|<=|>=|##|\.\.\.|\S))"#
);

/// Tokens of a file; `#` lines are directive tokens unless `directives` is false (macro bodies).
fn tokenize(src: &str, file: &str, first_line: usize, directives: bool) -> Vec<Token> {
    static TOKEN: LazyLock<Regex> = LazyLock::new(|| re(TOKEN_PATTERN));
    static DIRECTIVE: LazyLock<Regex> = LazyLock::new(|| re(r"^#(?:[^\n\\]|\\[\s\S])*"));
    static INT: LazyLock<Regex> = LazyLock::new(|| re(r"^0[xX]|^[0-9]+[uUlL]*$"));
    let text = src.replace("\r\n", "\n").replace('\r', "\n");
    let mut tokens: Vec<Token> = Vec::new();
    let mut line = first_line;
    let mut doc: Vec<String> = Vec::new();
    // Comments after the last token on its line are its trailing comment.
    let mut same_line = false;
    let mut line_start = true;
    let mut pos = 0;
    while pos < text.len() {
        let rest = &text[pos..];
        if directives && line_start && rest.starts_with('#') {
            let d = DIRECTIVE.find(rest).unwrap().as_str();
            tokens.push(Token {
                kind: TokenKind::Directive,
                text: d.to_string(),
                file: file.to_string(),
                line,
                doc: String::new(),
                trail: String::new(),
            });
            doc.clear();
            line += d.matches('\n').count();
            pos += d.len();
            line_start = false;
            same_line = false;
            continue;
        }
        let Some(m) = TOKEN.captures(rest) else {
            // Cannot happen: `\S` and `\s` cover every character.
            pos += rest.chars().next().map_or(1, char::len_utf8);
            continue;
        };
        let s = m.get(0).unwrap().as_str();
        pos += s.len();
        let newlines = s.matches('\n').count();
        if m.get(1).is_some() {
            if newlines > 0 {
                same_line = false;
                line_start = true;
            }
            // A blank line detaches a comment from what follows.
            if newlines > 1 {
                doc.clear();
            }
        } else if m.get(2).is_some() {
            let comment = clean_comment(s);
            match tokens.last_mut() {
                Some(last) if same_line && last.kind != TokenKind::Directive => {
                    last.trail =
                        if last.trail.is_empty() { comment } else { format!("{}\n{}", last.trail, comment) };
                }
                _ => {
                    if !comment.is_empty() {
                        doc.push(comment);
                    }
                }
            }
        } else {
            let kind = if m.get(3).is_some() {
                TokenKind::Str
            } else if m.get(4).is_some() {
                TokenKind::Char
            } else if m.get(5).is_some() {
                TokenKind::Ident
            } else if m.get(6).is_some() {
                if INT.is_match(s) { TokenKind::Int } else { TokenKind::Float }
            } else {
                TokenKind::Punct
            };
            tokens.push(Token {
                kind,
                text: s.to_string(),
                file: file.to_string(),
                line,
                doc: doc.join("\n"),
                trail: String::new(),
            });
            doc.clear();
            same_line = true;
            line_start = false;
        }
        line += newlines;
    }
    tokens
}

// Constant expressions (preprocessor conditions, array sizes and bounds, annotation values)

/// Value of a constant: a bigint (here a 128-bit integer), a number, a string or a boolean.
#[derive(Clone, Debug, PartialEq)]
enum Cv {
    Int(i128),
    Float(f64),
    Str(String),
    Bool(bool),
}

const MAX_SAFE: u128 = 9_007_199_254_740_991;

impl Cv {
    /// `String(value)`.
    fn show(&self) -> String {
        match self {
            Cv::Int(i) => i.to_string(),
            Cv::Float(f) => js_num_str(*f),
            Cv::Str(s) => s.clone(),
            Cv::Bool(b) => b.to_string(),
        }
    }

    /// `Number(value)`.
    fn number(&self) -> f64 {
        match self {
            Cv::Int(i) => *i as f64,
            Cv::Float(f) => *f,
            Cv::Bool(b) => f64::from(u8::from(*b)),
            Cv::Str(s) => {
                static DEC: LazyLock<Regex> = LazyLock::new(|| {
                    re(r"^[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)$")
                });
                let t = js_trim(s);
                if t.is_empty() {
                    0.0
                } else if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
                    u128::from_str_radix(h, 16).map_or(f64::NAN, |v| v as f64)
                } else if DEC.is_match(t) {
                    t.replace("Infinity", "inf").parse::<f64>().unwrap_or(f64::NAN)
                } else {
                    f64::NAN
                }
            }
        }
    }

    /// The value as a JSON constant or default: integers beyond the safe range are strings.
    fn json(&self) -> Json {
        match self {
            Cv::Int(i) => {
                if i.unsigned_abs() <= MAX_SAFE {
                    json!(*i as i64)
                } else {
                    json!(i.to_string())
                }
            }
            Cv::Float(f) => num_json(*f),
            Cv::Str(s) => json!(s),
            Cv::Bool(b) => json!(b),
        }
    }
}

fn js_string_json(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}

fn unescape(literal: &str) -> String {
    static ESC: LazyLock<Regex> =
        LazyLock::new(|| re(r"\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|[0-7]{1,3}|.)"));
    let l = literal.strip_prefix('L').unwrap_or(literal);
    let inner = if l.len() >= 2 { &l[1..l.len() - 1] } else { "" };
    ESC.replace_all(inner, |c: &regex::Captures| {
        let e = &c[1];
        let first = e.chars().next().unwrap();
        if first == 'x' || first == 'u' {
            let code = u32::from_str_radix(&e[1..], 16).unwrap_or(0);
            return char::from_u32(code).unwrap_or('\u{fffd}').to_string();
        }
        if ('0'..='7').contains(&first) {
            return char::from_u32(u32::from_str_radix(e, 8).unwrap()).unwrap_or('\u{fffd}').to_string();
        }
        match first {
            'n' => "\n".into(),
            't' => "\t".into(),
            'r' => "\r".into(),
            'v' => "\u{b}".into(),
            'b' => "\u{8}".into(),
            'f' => "\u{c}".into(),
            'a' => "\u{7}".into(),
            _ => e.to_string(),
        }
    })
    .into_owned()
}

fn literal(t: &Token) -> Option<Cv> {
    match t.kind {
        TokenKind::Int => {
            let s = t.text.trim_end_matches(['u', 'U', 'l', 'L']);
            let v = if let Some(h) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
                i128::from_str_radix(h, 16)
            } else if s.len() > 1 && s.starts_with('0') && s.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
                i128::from_str_radix(&s[1..], 8)
            } else {
                s.parse::<i128>()
            };
            Some(Cv::Int(v.unwrap_or(i128::MAX)))
        }
        TokenKind::Float => {
            let s = match t.text.chars().last() {
                Some('f' | 'F' | 'd' | 'D' | 'l' | 'L') => &t.text[..t.text.len() - 1],
                _ => &t.text,
            };
            Some(Cv::Float(s.parse::<f64>().unwrap_or(f64::NAN)))
        }
        TokenKind::Str | TokenKind::Char => Some(Cv::Str(unescape(&t.text))),
        _ => None,
    }
}

fn truthy(v: &Cv) -> bool {
    !(matches!(v, Cv::Int(0) | Cv::Bool(false))
        || matches!(v, Cv::Float(f) if *f == 0.0)
        || matches!(v, Cv::Str(s) if s.is_empty()))
}

const BINARY_LEVELS: [&[&str]; 10] = [
    &["||"],
    &["&&"],
    &["|"],
    &["^"],
    &["&"],
    &["==", "!="],
    &["<", ">", "<=", ">="],
    &["<<", ">>"],
    &["+", "-"],
    &["*", "/", "%"],
];

enum Nb {
    I(i128),
    F(f64),
}

fn nb_f64(n: &Nb) -> f64 {
    match n {
        Nb::I(i) => *i as f64,
        Nb::F(f) => *f,
    }
}

struct Eval<'a> {
    tokens: Vec<Token>,
    i: usize,
    raw_last: Option<Token>,
    main: &'a str,
    lookup: &'a dyn Fn(&str) -> Option<Cv>,
}

/// Value of a C-like constant expression; `lookup` gives the value of a (scoped) name.
fn evaluate(raw: &[Token], lookup: &dyn Fn(&str) -> Option<Cv>, main: &str) -> Res<Cv> {
    // `>>` comes as two tokens: it also closes nested templates.
    let mut tokens: Vec<Token> = Vec::new();
    for t in raw {
        match tokens.last_mut() {
            Some(last) if last.text == ">" && t.text == ">" => last.text = ">>".into(),
            _ => tokens.push(t.clone()),
        }
    }
    let mut e = Eval { tokens, i: 0, raw_last: raw.last().cloned(), main, lookup };
    let v = e.ternary()?;
    if e.i < e.tokens.len() {
        let t = e.tokens[e.i].clone();
        return e.fail(Some(&t), &format!("unexpected '{}'", t.text));
    }
    Ok(v)
}

impl Eval<'_> {
    fn fail<T>(&self, t: Option<&Token>, msg: &str) -> Res<T> {
        let near = t.or(self.raw_last.as_ref());
        Err(match near {
            Some(n) => format!("{}: {msg}", at(n, self.main)),
            None => msg.to_string(),
        })
    }

    fn int(&self, v: &Cv, t: &Token) -> Res<i128> {
        match v {
            Cv::Int(i) => Ok(*i),
            Cv::Bool(b) => Ok(i128::from(*b)),
            Cv::Float(f) if f.is_finite() && f.fract() == 0.0 => Ok(*f as i128),
            Cv::Str(s) if s.encode_utf16().count() == 1 => Ok(i128::from(s.encode_utf16().next().unwrap())),
            _ => {
                let shown = match v {
                    Cv::Str(s) => js_string_json(s),
                    Cv::Float(f) if !f.is_finite() => "null".into(),
                    other => other.show(),
                };
                self.fail(Some(t), &format!("{shown} is not an integer"))
            }
        }
    }

    fn num(&self, v: &Cv, t: &Token) -> Res<Nb> {
        match v {
            Cv::Float(f) => Ok(Nb::F(*f)),
            _ => Ok(Nb::I(self.int(v, t)?)),
        }
    }

    fn compare(&self, a: &Cv, b: &Cv, t: &Token) -> Res<i32> {
        if let (Cv::Str(x), Cv::Str(y)) = (a, b) {
            return Ok(match x.cmp(y) {
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Equal => 0,
                std::cmp::Ordering::Greater => 1,
            });
        }
        let x = self.num(a, t)?;
        let y = self.num(b, t)?;
        Ok(match (&x, &y) {
            (Nb::I(p), Nb::I(q)) => i32::from(p > q) - i32::from(p < q),
            _ => {
                let (p, q) = (nb_f64(&x), nb_f64(&y));
                if p < q {
                    -1
                } else if p > q {
                    1
                } else {
                    0
                }
            }
        })
    }

    fn shift(&self, a: i128, b: i128, left: bool, t: &Token) -> Res<Cv> {
        let (left, n) = if b < 0 { (!left, -b) } else { (left, b) };
        if left {
            if a == 0 {
                return Ok(Cv::Int(0));
            }
            if n >= 127 {
                return self.fail(Some(t), "constant too large");
            }
            match a.checked_mul(1i128 << n) {
                Some(v) => Ok(Cv::Int(v)),
                None => self.fail(Some(t), "constant too large"),
            }
        } else if n >= 127 {
            Ok(Cv::Int(if a < 0 { -1 } else { 0 }))
        } else {
            Ok(Cv::Int(a >> n))
        }
    }

    fn binary(&self, op: &str, a: &Cv, b: &Cv, t: &Token) -> Res<Cv> {
        let flag = |c: bool| Ok(Cv::Int(i128::from(c)));
        match op {
            "||" => return flag(truthy(a) || truthy(b)),
            "&&" => return flag(truthy(a) && truthy(b)),
            "|" => return Ok(Cv::Int(self.int(a, t)? | self.int(b, t)?)),
            "^" => return Ok(Cv::Int(self.int(a, t)? ^ self.int(b, t)?)),
            "&" => return Ok(Cv::Int(self.int(a, t)? & self.int(b, t)?)),
            "==" => return flag(self.compare(a, b, t)? == 0),
            "!=" => return flag(self.compare(a, b, t)? != 0),
            "<" => return flag(self.compare(a, b, t)? < 0),
            ">" => return flag(self.compare(a, b, t)? > 0),
            "<=" => return flag(self.compare(a, b, t)? <= 0),
            ">=" => return flag(self.compare(a, b, t)? >= 0),
            "<<" => return self.shift(self.int(a, t)?, self.int(b, t)?, true, t),
            ">>" => return self.shift(self.int(a, t)?, self.int(b, t)?, false, t),
            _ => {}
        }
        let x = self.num(a, t)?;
        let y = self.num(b, t)?;
        if let (Nb::I(x), Nb::I(y)) = (&x, &y) {
            if (op == "/" || op == "%") && *y == 0 {
                return self.fail(Some(t), "division by zero");
            }
            let r = match op {
                "+" => x.checked_add(*y),
                "-" => x.checked_sub(*y),
                "*" => x.checked_mul(*y),
                "/" => x.checked_div(*y),
                _ => x.checked_rem(*y),
            };
            return match r {
                Some(v) => Ok(Cv::Int(v)),
                None => self.fail(Some(t), "constant too large"),
            };
        }
        if op == "%" {
            return self.fail(Some(t), "% of a floating-point value");
        }
        let (p, q) = (nb_f64(&x), nb_f64(&y));
        Ok(Cv::Float(match op {
            "+" => p + q,
            "-" => p - q,
            "*" => p * q,
            _ => p / q,
        }))
    }

    fn level(&mut self, n: usize) -> Res<Cv> {
        if n == BINARY_LEVELS.len() {
            return self.unary();
        }
        let mut a = self.level(n + 1)?;
        while let Some(t) = self.tokens.get(self.i) {
            if t.kind != TokenKind::Punct || !BINARY_LEVELS[n].contains(&t.text.as_str()) {
                break;
            }
            let t = t.clone();
            self.i += 1;
            let b = self.level(n + 1)?;
            a = self.binary(&t.text, &a, &b, &t)?;
        }
        Ok(a)
    }

    fn ternary(&mut self) -> Res<Cv> {
        let Some(_nesting) = Nesting::enter() else {
            return Err(too_deep(self.tokens.get(self.i).or(self.raw_last.as_ref()), self.main));
        };
        let c = self.level(0)?;
        if self.tokens.get(self.i).map(|t| t.text.as_str()) != Some("?") {
            return Ok(c);
        }
        self.i += 1;
        let a = self.ternary()?;
        if self.tokens.get(self.i).map(|t| t.text.as_str()) != Some(":") {
            let t = self.tokens.get(self.i).cloned();
            return self.fail(t.as_ref(), "expected ':'");
        }
        self.i += 1;
        let b = self.ternary()?;
        Ok(if truthy(&c) { a } else { b })
    }

    fn unary(&mut self) -> Res<Cv> {
        let Some(_nesting) = Nesting::enter() else {
            return Err(too_deep(self.tokens.get(self.i).or(self.raw_last.as_ref()), self.main));
        };
        let Some(t) = self.tokens.get(self.i).cloned() else {
            self.i += 1;
            return self.fail(None, "expected a constant");
        };
        self.i += 1;
        match t.text.as_str() {
            "-" => {
                let v = self.unary()?;
                return Ok(match v {
                    Cv::Float(f) => Cv::Float(-f),
                    v => match self.int(&v, &t)?.checked_neg() {
                        Some(n) => Cv::Int(n),
                        None => return self.fail(Some(&t), "constant too large"),
                    },
                });
            }
            "+" => return self.unary(),
            "~" => {
                let v = self.unary()?;
                return Ok(Cv::Int(!self.int(&v, &t)?));
            }
            "!" => {
                let v = self.unary()?;
                return Ok(Cv::Int(if truthy(&v) { 0 } else { 1 }));
            }
            "(" => {
                let v = self.ternary()?;
                let close = self.tokens.get(self.i).cloned();
                self.i += 1;
                if close.as_ref().map(|c| c.text.as_str()) != Some(")") {
                    let prev = self.tokens.get(self.i - 1).cloned();
                    return self.fail(prev.as_ref(), "expected ')'");
                }
                return Ok(v);
            }
            _ => {}
        }
        if let Some(v) = literal(&t) {
            return Ok(v);
        }
        if t.kind == TokenKind::Ident || t.text == "::" {
            let mut name = t.text.clone();
            while let Some(n) = self.tokens.get(self.i) {
                if n.text == "::" || (name.ends_with("::") && n.kind == TokenKind::Ident) {
                    name.push_str(&n.text);
                    self.i += 1;
                } else {
                    break;
                }
            }
            if let Some(v) = (self.lookup)(&name) {
                return Ok(v);
            }
        }
        self.fail(Some(&t), &format!("'{}' is not a constant", t.text))
    }
}

// Preprocessor

#[derive(Clone)]
struct Macro {
    /// Absent for an object-like macro.
    params: Option<Vec<String>>,
    variadic: bool,
    body: Vec<Token>,
}

struct Condition {
    /// The current branch is read.
    on: bool,
    /// A branch was read already.
    done: bool,
    /// The enclosing branch is read.
    outer: bool,
}

struct Preprocessor<'a> {
    out: Vec<Token>,
    warnings: Vec<String>,
    missing: Vec<String>,
    /// Files each file includes.
    includes: HashMap<String, Vec<String>>,
    macros: HashMap<String, Macro>,
    /// Files read already: each is read once.
    done: HashSet<String>,
    files: &'a IndexMap<String, String>,
    main: String,
}

impl<'a> Preprocessor<'a> {
    fn new(files: &'a IndexMap<String, String>, main: &str) -> Self {
        Preprocessor {
            out: Vec::new(),
            warnings: Vec::new(),
            missing: Vec::new(),
            includes: HashMap::new(),
            macros: HashMap::new(),
            done: HashSet::new(),
            files,
            main: main.to_string(),
        }
    }

    fn flush(&mut self, run: &mut Vec<Token>) -> Res<()> {
        if !run.is_empty() {
            let expanded = self.expand(run, &HashSet::new())?;
            self.out.extend(expanded);
        }
        run.clear();
        Ok(())
    }

    fn include(&mut self, path: &str, text: &str) -> Res<()> {
        static COMMENTS: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)/\*[\s\S]*?\*/|//.*$"));
        static HEAD: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*([A-Za-z_][A-Za-z0-9_]*)?\s*([\s\S]*)$"));
        static SPEC: LazyLock<Regex> = LazyLock::new(|| re(r#"^"([^"]*)"|^<([^>]*)>"#));
        if !self.done.insert(path.to_string()) {
            return Ok(());
        }
        let tokens = tokenize(text, path, 1, true);
        let mut conditions: Vec<Condition> = Vec::new();
        let mut active = true;
        let mut run: Vec<Token> = Vec::new();
        let mut i = 0;
        while i < tokens.len() {
            let t = &tokens[i];
            i += 1;
            if t.kind != TokenKind::Directive {
                if !active {
                    continue;
                }
                // IDL 4 `import "file";` reads the file like #include.
                if t.text == "import"
                    && tokens.get(i).is_some_and(|x| x.kind == TokenKind::Str)
                    && tokens.get(i + 1).is_some_and(|x| x.text == ";")
                {
                    self.flush(&mut run)?;
                    let name = unescape(&tokens[i].text);
                    self.include_file(&name, t)?;
                    i += 2;
                    continue;
                }
                run.push(t.clone());
                continue;
            }
            self.flush(&mut run)?;
            let stripped = t.text.replace("\\\n", " ");
            let stripped = COMMENTS.replace_all(&stripped, " ");
            let body = &stripped[1..];
            let head = HEAD.captures(body).unwrap();
            let name = head.get(1).map_or("", |m| m.as_str());
            let rest = head.get(2).map_or("", |m| m.as_str());
            match name {
                "if" | "ifdef" | "ifndef" => {
                    let on = active
                        && if name == "if" {
                            self.condition(rest, t)?
                        } else {
                            let first = js_trim(rest).split(is_js_ws).next().unwrap_or("");
                            self.macros.contains_key(first) == (name == "ifdef")
                        };
                    conditions.push(Condition { on, done: on, outer: active });
                    active = on;
                    continue;
                }
                "elif" | "else" => {
                    let Some(c) = conditions.last() else {
                        return Err(format!("{}: #{name} without #if", at(t, &self.main)));
                    };
                    let (outer, done) = (c.outer, c.done);
                    let on = outer && !done && (name == "else" || self.condition(rest, t)?);
                    let c = conditions.last_mut().unwrap();
                    c.on = on;
                    c.done = c.done || on;
                    active = on;
                    continue;
                }
                "endif" => {
                    let Some(c) = conditions.pop() else {
                        return Err(format!("{}: #endif without #if", at(t, &self.main)));
                    };
                    active = c.outer;
                    continue;
                }
                _ => {}
            }
            if !active {
                continue;
            }
            match name {
                "define" => self.define(rest, t)?,
                "undef" => {
                    self.macros.remove(js_trim(rest));
                }
                "include" | "import" => {
                    let mut spec = js_trim(rest).to_string();
                    if !(spec.starts_with('"') || spec.starts_with('<')) {
                        let expanded = self.expand(&tokenize(&spec, path, t.line, false), &HashSet::new())?;
                        spec = expanded.iter().map(|x| x.text.as_str()).collect();
                    }
                    let Some(m) = SPEC.captures(&spec) else {
                        return Err(format!("{}: #include expects \"file\" or <file>", at(t, &self.main)));
                    };
                    let target = m.get(1).or_else(|| m.get(2)).unwrap().as_str().to_string();
                    self.include_file(&target, t)?;
                }
                "error" => return Err(format!("{}: #error {}", at(t, &self.main), js_trim(rest))),
                "warning" => self.warnings.push(format!("{}: {}", at(t, &self.main), js_trim(rest))),
                "" | "pragma" | "line" | "ident" | "sccs" => {}
                _ => self.warnings.push(format!("{}: #{name} ignored", at(t, &self.main))),
            }
        }
        self.flush(&mut run)?;
        if !conditions.is_empty() {
            let b = base_name(path);
            return Err(format!("{}: missing #endif", if b.is_empty() { "IDL" } else { b }));
        }
        Ok(())
    }

    fn include_file(&mut self, name: &str, t: &Token) -> Res<()> {
        let files = self.files;
        let Some(found) = find_include(name, &t.file, files) else {
            if !self.missing.iter().any(|m| m == name) {
                self.missing.push(name.to_string());
                self.warnings.push(format!("{}: {name} not found", at(t, &self.main)));
            }
            return Ok(());
        };
        let from = self.includes.entry(t.file.clone()).or_default();
        if found != t.file && !from.contains(&found) {
            from.push(found.clone());
        }
        self.include(&found, &files[&found])
    }

    fn define(&mut self, rest: &str, t: &Token) -> Res<()> {
        static DEF: LazyLock<Regex> = LazyLock::new(|| re(r"^([A-Za-z_][A-Za-z0-9_]*)(\(([^)]*)\))?"));
        let rest = js_trim(rest);
        let Some(m) = DEF.captures(rest) else {
            return Err(format!("{}: #define expects a name", at(t, &self.main)));
        };
        let whole = m.get(0).unwrap().as_str();
        let body = tokenize(&rest[whole.len()..], &t.file, t.line, false);
        let name = m[1].to_string();
        let Some(list) = m.get(3) else {
            self.macros.insert(name, Macro { params: None, variadic: false, body });
            return Ok(());
        };
        let mut params: Vec<String> =
            list.as_str().split(',').map(|p| js_trim(p).to_string()).filter(|p| !p.is_empty()).collect();
        let variadic = params.last().is_some_and(|p| p == "...");
        if variadic {
            *params.last_mut().unwrap() = "__VA_ARGS__".into();
        }
        self.macros.insert(name, Macro { params: Some(params), variadic, body });
        Ok(())
    }

    /// `#if` / `#elif` condition.
    fn condition(&mut self, rest: &str, t: &Token) -> Res<bool> {
        let raw = tokenize(rest, &t.file, t.line, false);
        let mut tokens: Vec<Token> = Vec::new();
        let mut i = 0;
        while i < raw.len() {
            let x = &raw[i];
            if x.text != "defined" {
                tokens.push(x.clone());
                i += 1;
                continue;
            }
            let paren = raw.get(i + 1).is_some_and(|y| y.text == "(");
            let name = raw.get(i + if paren { 2 } else { 1 }).map_or("", |y| y.text.as_str());
            i += if paren { 4 } else { 2 };
            let mut v = x.clone();
            v.kind = TokenKind::Int;
            v.text = if self.macros.contains_key(name) { "1" } else { "0" }.into();
            tokens.push(v);
        }
        // Names left after expansion are 0, `true` is 1 (C++).
        let expanded: Vec<Token> = self
            .expand(&tokens, &HashSet::new())?
            .into_iter()
            .map(|mut x| {
                if x.kind == TokenKind::Ident {
                    x.kind = TokenKind::Int;
                    x.text = if x.text == "true" { "1" } else { "0" }.into();
                }
                x
            })
            .collect();
        Ok(truthy(&evaluate(&expanded, &|_| None, &self.main)?))
    }

    /// Macro expansion; `hidden` macros are being expanded (no recursion).
    fn expand(&self, tokens: &[Token], hidden: &HashSet<String>) -> Res<Vec<Token>> {
        let Some(_nesting) = Nesting::enter() else {
            return Err(too_deep(tokens.first(), &self.main));
        };
        let mut out: Vec<Token> = Vec::new();
        let mut i = 0;
        while i < tokens.len() {
            let t = &tokens[i];
            if t.kind == TokenKind::Ident && t.text == "__LINE__" {
                let mut x = t.clone();
                x.kind = TokenKind::Int;
                x.text = t.line.to_string();
                out.push(x);
                i += 1;
                continue;
            }
            if t.kind == TokenKind::Ident && t.text == "__FILE__" {
                let mut x = t.clone();
                x.kind = TokenKind::Str;
                x.text = js_string_json(base_name(&t.file));
                out.push(x);
                i += 1;
                continue;
            }
            let m = if t.kind == TokenKind::Ident && !hidden.contains(&t.text) {
                self.macros.get(&t.text)
            } else {
                None
            };
            let Some(m) = m else {
                out.push(t.clone());
                i += 1;
                continue;
            };
            if m.params.is_some() && tokens.get(i + 1).map(|x| x.text.as_str()) != Some("(") {
                out.push(t.clone());
                i += 1;
                continue;
            }
            let mut body = m.body.clone();
            if let Some(params) = &m.params {
                let mut args: Vec<Vec<Token>> = vec![Vec::new()];
                let mut depth = 0i32;
                let mut j = i + 2;
                while j < tokens.len() {
                    let a = &tokens[j];
                    if a.text == ")" && depth == 0 {
                        break;
                    }
                    if a.text == "(" {
                        depth += 1;
                    } else if a.text == ")" {
                        depth -= 1;
                    } else if a.text == "," && depth == 0 && !(m.variadic && args.len() >= params.len()) {
                        args.push(Vec::new());
                        j += 1;
                        continue;
                    }
                    args.last_mut().unwrap().push(a.clone());
                    j += 1;
                }
                if j == tokens.len() {
                    return Err(format!("{}: unterminated use of macro {}", at(t, &self.main), t.text));
                }
                i = j;
                body = self.substitute(m, &args, hidden)?;
            }
            let placed: Vec<Token> = body
                .iter()
                .enumerate()
                .map(|(k, b)| {
                    let mut x = b.clone();
                    x.file = t.file.clone();
                    x.line = t.line;
                    x.doc = if k > 0 { String::new() } else { t.doc.clone() };
                    x.trail = String::new();
                    x
                })
                .collect();
            let mut inner = hidden.clone();
            inner.insert(t.text.clone());
            out.extend(self.expand(&placed, &inner)?);
            if out.len() > MAX_EXPANSION {
                return Err(format!(
                    "{}: macro '{}' expands to more than {MAX_EXPANSION} tokens",
                    at(t, &self.main),
                    t.text
                ));
            }
            i += 1;
        }
        Ok(out)
    }

    /// Body of a function-like macro with its arguments: `#` makes a string, `##` pastes tokens.
    fn substitute(&self, m: &Macro, args: &[Vec<Token>], hidden: &HashSet<String>) -> Res<Vec<Token>> {
        let params = m.params.as_ref().unwrap();
        let arg = |name: &str| -> Option<Vec<Token>> {
            params.iter().position(|p| p == name).map(|k| args.get(k).cloned().unwrap_or_default())
        };
        let mut out: Vec<Token> = Vec::new();
        let mut paste = false;
        let mut i = 0;
        while i < m.body.len() {
            let b = &m.body[i];
            if b.text == "##" {
                paste = true;
                i += 1;
                continue;
            }
            let part: Vec<Token>;
            let next_arg = m.body.get(i + 1).map(|x| x.text.as_str()).unwrap_or("");
            if b.text == "#" && arg(next_arg).is_some() {
                i += 1;
                let words: Vec<String> =
                    arg(&m.body[i].text).unwrap().iter().map(|x| x.text.clone()).collect();
                let mut s = b.clone();
                s.kind = TokenKind::Str;
                s.text = js_string_json(&words.join(" "));
                part = vec![s];
            } else if let Some(a) = arg(&b.text) {
                // Operands of `##` are not expanded.
                let next_paste = m.body.get(i + 1).is_some_and(|x| x.text == "##");
                part = if paste || next_paste { a } else { self.expand(&a, hidden)? };
            } else {
                part = vec![b.clone()];
            }
            if paste && !out.is_empty() && !part.is_empty() {
                let last = out.pop().unwrap();
                let joined = tokenize(&format!("{}{}", last.text, part[0].text), &b.file, b.line, false);
                out.extend(joined);
                out.extend(part.into_iter().skip(1));
            } else {
                out.extend(part);
            }
            paste = false;
            i += 1;
        }
        Ok(out)
    }
}

// Parser

fn int_type(word: &str) -> Option<&'static str> {
    Some(match word {
        "short" | "int16" => "int16",
        "long" | "int32" => "int32",
        "int8" => "int8",
        "int64" => "int64",
        "uint8" | "octet" => "uint8",
        "uint16" => "uint16",
        "uint32" => "uint32",
        "uint64" => "uint64",
        _ => return None,
    })
}

/// Words that start a definition inside interfaces, valuetypes, components and porttypes too.
const DEFINITION_WORDS: [&str; 11] = [
    "struct",
    "union",
    "enum",
    "bitmask",
    "bitset",
    "typedef",
    "const",
    "native",
    "exception",
    "typeid",
    "typeprefix",
];
const CONSTRUCTED: [&str; 5] = ["struct", "union", "enum", "bitmask", "bitset"];
const PORT_WORDS: [&str; 6] = ["provides", "uses", "emits", "publishes", "consumes", "port"];
/// Words that cannot name a type.
const NOT_TYPES: [&str; 9] = ["void", "struct", "union", "enum", "interface", "module", "in", "out", "inout"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum DeclKind {
    Module,
    Type,
    Interface,
    Component,
    Porttype,
    Home,
    Const,
    Enumerator,
    Template,
}

const SEP: char = '\u{0}';
const BUILTIN: char = '\u{1}';

fn builtin_info(word: &str) -> (&'static str, &'static str) {
    match word {
        "any" => ("Any", "Value of any IDL type"),
        "Object" => ("Object", "Reference to any CORBA object"),
        _ => ("ValueBase", "Any value type"),
    }
}

/// IDL escapes (`_name`) removed.
fn unescape_name(name: &str) -> String {
    name.strip_prefix('_').unwrap_or(name).to_string()
}

/// What follows the last `::` of `q` (which may have none).
fn last_segment(q: &str) -> String {
    let s = format!("::{q}");
    s[s.rfind("::").unwrap() + 2..].to_string()
}

fn join_lines(lines: &[&str]) -> String {
    lines.iter().filter(|l| !l.is_empty()).copied().collect::<Vec<_>>().join("\n")
}

fn flip(role: &'static str) -> &'static str {
    if role == "in" { "out" } else { "in" }
}

/// Unsigned type of a bitfield of `bits` bits.
fn bitfield_type(bits: i64) -> Json {
    let name = if bits <= 1 {
        "bool"
    } else if bits <= 8 {
        "uint8"
    } else if bits <= 16 {
        "uint16"
    } else if bits <= 32 {
        "uint32"
    } else {
        "uint64"
    };
    prim(name)
}

fn prim(name: &str) -> Json {
    json!({"kind": "primitive", "name": name})
}

fn ref_json(name: &str) -> Json {
    json!({"kind": "ref", "name": name})
}

/// Smallest integer type of at least `bits` bits holding `values`.
fn int_type_of(values: &[f64], bits: f64, signed_default: bool) -> &'static str {
    let signed = signed_default || values.iter().any(|v| *v < 0.0);
    for width in [8, 16, 32, 64] {
        if f64::from(width) < bits {
            continue;
        }
        let (t, min, max): (&str, i128, i128) = match (signed, width) {
            (true, 8) => ("int8", -(1 << 7), (1 << 7) - 1),
            (true, 16) => ("int16", -(1 << 15), (1 << 15) - 1),
            (true, 32) => ("int32", -(1 << 31), (1 << 31) - 1),
            (true, _) => ("int64", -(1 << 63), (1 << 63) - 1),
            (false, 8) => ("uint8", 0, (1 << 8) - 1),
            (false, 16) => ("uint16", 0, (1 << 16) - 1),
            (false, 32) => ("uint32", 0, (1 << 32) - 1),
            (false, _) => ("uint64", 0, (1i128 << 64) - 1),
        };
        if values.iter().all(|v| (*v as i128) >= min && (*v as i128) <= max) {
            return t;
        }
    }
    if signed { "int64" } else { "uint64" }
}

fn is_reserved_type_name(name: &str) -> bool {
    matches!(
        name,
        "bool"
            | "char"
            | "int8"
            | "int16"
            | "int32"
            | "int64"
            | "uint8"
            | "uint16"
            | "uint32"
            | "uint64"
            | "float32"
            | "float64"
            | "string"
            | "bytes"
            | "array"
            | "vector"
            | "list"
            | "set"
            | "optional"
            | "map"
    )
}

/// Rewrites the user-type references of a type tree.
fn map_type_ref(t: &Json, f: &mut dyn FnMut(&str) -> String) -> Json {
    let mut out = t.clone();
    map_ref_in_place(&mut out, f);
    out
}

fn map_ref_in_place(t: &mut Json, f: &mut dyn FnMut(&str) -> String) {
    let Some(o) = t.as_object_mut() else { return };
    match o.get("kind").and_then(Json::as_str) {
        Some("primitive") => {}
        Some("ref") => {
            let name = f(o.get("name").and_then(Json::as_str).unwrap_or(""));
            o.insert("name".into(), Json::String(name));
        }
        _ => {
            for k in ["of", "key", "value"] {
                if let Some(c) = o.get_mut(k) {
                    map_ref_in_place(c, f);
                }
            }
        }
    }
}

/// Names of the user types a type tree references.
fn ref_names(t: &Json, into: &mut Vec<String>) {
    let Some(o) = t.as_object() else { return };
    match o.get("kind").and_then(Json::as_str) {
        Some("ref") => into.push(o.get("name").and_then(Json::as_str).unwrap_or("").to_string()),
        Some("primitive") => {}
        _ => {
            for k in ["of", "key", "value"] {
                if let Some(c) = o.get(k) {
                    ref_names(c, into);
                }
            }
        }
    }
}

#[derive(Clone)]
struct Field {
    name: String,
    ty: Json,
    description: String,
    default: Option<Json>,
}

#[derive(Clone)]
struct Case {
    name: String,
    ty: Json,
    description: String,
    labels: Vec<Json>,
    is_default: bool,
}

#[derive(Clone)]
enum TypeDef {
    Struct { exception: bool, name: String, description: String, fields: Vec<Field> },
    Union { name: String, description: String, discriminator: Json, cases: Vec<Case> },
    Enum { name: String, description: String, underlying: String, values: Vec<(String, f64)> },
    Bitmask { name: String, description: String, underlying: String, flags: Vec<(String, i64)> },
    Alias { name: String, description: String, ty: Json },
    Primitive { name: String, description: String },
}

impl TypeDef {
    fn name(&self) -> &str {
        match self {
            TypeDef::Struct { name, .. }
            | TypeDef::Union { name, .. }
            | TypeDef::Enum { name, .. }
            | TypeDef::Bitmask { name, .. }
            | TypeDef::Alias { name, .. }
            | TypeDef::Primitive { name, .. } => name,
        }
    }

    fn name_mut(&mut self) -> &mut String {
        match self {
            TypeDef::Struct { name, .. }
            | TypeDef::Union { name, .. }
            | TypeDef::Enum { name, .. }
            | TypeDef::Bitmask { name, .. }
            | TypeDef::Alias { name, .. }
            | TypeDef::Primitive { name, .. } => name,
        }
    }
}

#[derive(Clone)]
struct Param {
    name: String,
    ty: Json,
    direction: String,
    description: Option<String>,
}

#[derive(Clone)]
struct Message {
    name: String,
    description: String,
    params: Vec<Param>,
    returns: Option<Json>,
    raises: Vec<String>,
}

#[derive(Clone)]
struct IfaceDef {
    name: String,
    description: String,
    messages: Vec<Message>,
}

/// Port of a component, connector or porttype.
#[derive(Clone)]
struct IdlPort {
    name: String,
    role: &'static str,
    /// Interface name; None when unknown.
    interface: Option<String>,
    description: String,
}

#[derive(Clone)]
struct IdlAttribute {
    name: String,
    ty: Json,
    description: String,
    readonly: bool,
}

/// CCM component or connector: a module with ports.
#[derive(Clone)]
struct IdlComponent {
    name: String,
    description: String,
    bases: Vec<String>,
    attributes: Vec<IdlAttribute>,
    methods: Vec<Message>,
    ports: Vec<IdlPort>,
    needs: Vec<String>,
    /// Qualified IDL name (`Plant::Tank`), for those written in the files.
    qualified: Option<String>,
}

#[derive(Clone)]
enum Def {
    Type(TypeDef),
    Interface(IfaceDef),
    Component(IdlComponent),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EKind {
    Type,
    Interface,
    Component,
}

#[derive(Clone)]
struct Entity {
    /// Qualified IDL name.
    q: String,
    /// Preferred name in the project.
    simple: String,
    /// Name when `simple` is taken; else from `q`.
    alt: Option<String>,
    /// Made by the import, not defined in the file.
    synthetic: bool,
    /// References to what it needs besides its types (see `IdlFile::needs`).
    needs: Vec<String>,
    /// File defining it.
    file: Option<String>,
    def: Def,
}

impl Entity {
    fn new(q: &str, simple: &str, def: Def) -> Entity {
        Entity {
            q: q.to_string(),
            simple: simple.to_string(),
            alt: None,
            synthetic: false,
            needs: Vec::new(),
            file: None,
            def,
        }
    }

    fn kind(&self) -> EKind {
        match self.def {
            Def::Type(_) => EKind::Type,
            Def::Interface(_) => EKind::Interface,
            Def::Component(_) => EKind::Component,
        }
    }

    fn decl_kind(&self) -> DeclKind {
        match self.kind() {
            EKind::Type => DeclKind::Type,
            EKind::Interface => DeclKind::Interface,
            EKind::Component => DeclKind::Component,
        }
    }

    fn set_name(&mut self, name: &str) {
        match &mut self.def {
            Def::Type(t) => *t.name_mut() = name.to_string(),
            Def::Interface(i) => i.name = name.to_string(),
            Def::Component(c) => c.name = name.to_string(),
        }
    }
}

#[derive(Clone)]
struct Annotation {
    name: String,
    args: Vec<Token>,
}

struct ConstDef {
    q: String,
    file: String,
    name: String,
    description: String,
    ty: Json,
    value: Json,
}

/// What an IDL file defines.
struct IdlFile {
    types: Vec<TypeDef>,
    interfaces: Vec<IfaceDef>,
    constants: Vec<ConstDef>,
    components: Vec<IdlComponent>,
    /// Names each type or interface needs besides the types it references.
    needs: HashMap<String, Vec<String>>,
    /// File defining each type, interface, constant and component, by name.
    origins: HashMap<String, String>,
    /// Innermost IDL module defining each type, interface and constant written in the files, by name.
    scopes: HashMap<String, String>,
    /// Qualified IDL name of each type, interface and constant written in the files, by name.
    qualified: HashMap<String, String>,
    /// Files each file includes.
    includes: HashMap<String, Vec<String>>,
    /// Included files found nowhere (shown by the editor's import, not by the generator).
    #[allow(dead_code)]
    missing: Vec<String>,
    /// What was left out or approximated.
    warnings: Vec<String>,
}

struct Template {
    params: Vec<String>,
    body: Vec<Token>,
}

struct PortType {
    ports: Vec<IdlPort>,
    attributes: Vec<IdlAttribute>,
}

struct AttributeDecl {
    names: Vec<String>,
    ty: Json,
    readonly: bool,
    description: String,
    get_raises: Vec<String>,
    set_raises: Vec<String>,
    refs: Vec<String>,
}

struct Parser {
    tokens: Vec<Token>,
    i: usize,
    scope: Vec<String>,
    decls: HashMap<String, DeclKind>,
    entities: IndexMap<String, Entity>,
    /// Interfaces and valuetypes (qualified) by scope: their names are visible in derived ones.
    inherited: HashMap<String, Vec<String>>,
    consts: HashMap<String, Cv>,
    /// Constants with a value, for the project (qualified IDL name).
    const_defs: Vec<ConstDef>,
    templates: HashMap<String, Template>,
    porttypes: HashMap<String, PortType>,
    instances: usize,
    main: String,
    warnings: Vec<String>,
}

fn is_text(t: Option<&Token>, text: &str) -> bool {
    t.is_some_and(|t| t.text == text && t.kind != TokenKind::Str && t.kind != TokenKind::Char)
}

impl Parser {
    fn new(tokens: Vec<Token>, main: &str, warnings: Vec<String>) -> Parser {
        Parser {
            tokens,
            i: 0,
            scope: Vec::new(),
            decls: HashMap::new(),
            entities: IndexMap::new(),
            inherited: HashMap::new(),
            consts: HashMap::new(),
            const_defs: Vec::new(),
            templates: HashMap::new(),
            porttypes: HashMap::new(),
            instances: 0,
            main: main.to_string(),
            warnings,
        }
    }

    fn parse(&mut self, missing: Vec<String>) -> Res<IdlFile> {
        while self.peek().is_some() {
            self.definition()?;
        }
        self.finish(missing)
    }

    // Tokens

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.i)
    }

    fn peek_at(&self, offset: usize) -> Option<&Token> {
        self.tokens.get(self.i + offset)
    }

    fn next(&mut self) -> Res<Token> {
        let t = self.tokens.get(self.i).cloned();
        self.i += 1;
        t.ok_or_else(|| "Unexpected end of file".to_string())
    }

    fn fail_msg(&self, t: Option<&Token>, expected: &str) -> String {
        match t {
            None => format!("Unexpected end of file, expected {expected}"),
            Some(t) => format!("{}: expected {expected} but found '{}'", at(t, &self.main), t.text),
        }
    }

    fn fail<T>(&self, t: Option<&Token>, expected: &str) -> Res<T> {
        Err(self.fail_msg(t, expected))
    }

    fn warn(&mut self, t: &Token, message: &str) {
        let w = format!("{}: {message}", at(t, &self.main));
        self.warnings.push(w);
    }

    fn is(&self, text: &str) -> bool {
        is_text(self.peek(), text)
    }

    fn is_at(&self, text: &str, offset: usize) -> bool {
        is_text(self.peek_at(offset), text)
    }

    fn accept(&mut self, text: &str) -> Option<Token> {
        if self.is(text) {
            let t = self.tokens[self.i].clone();
            self.i += 1;
            Some(t)
        } else {
            None
        }
    }

    fn expect(&mut self, text: &str) -> Res<Token> {
        match self.accept(text) {
            Some(t) => Ok(t),
            None => self.fail(self.peek(), &format!("'{text}'")),
        }
    }

    /// A simple name, IDL escape removed.
    fn name(&mut self) -> Res<String> {
        let t = self.peek();
        if t.map(|t| t.kind) != Some(TokenKind::Ident) {
            return self.fail(t, "an identifier");
        }
        Ok(unescape_name(&self.next()?.text))
    }

    /// A scoped name (`A::B`, `::A::B`), IDL escapes removed.
    fn scoped(&mut self) -> Res<String> {
        let mut name = if self.accept("::").is_some() { "::".to_string() } else { String::new() };
        name.push_str(&self.name()?);
        while self.is("::") && self.peek_at(1).is_some_and(|t| t.kind == TokenKind::Ident) {
            self.next()?;
            name.push_str("::");
            name.push_str(&self.name()?);
        }
        Ok(name)
    }

    fn scoped_list(&mut self) -> Res<Vec<String>> {
        let mut list = vec![self.scoped()?];
        while self.accept(",").is_some() {
            list.push(self.scoped()?);
        }
        Ok(list)
    }

    /// Skips up to the `;` ending the current definition, over nested braces.
    fn skip_definition(&mut self) -> Res<()> {
        let mut depth = 0i32;
        loop {
            let t = self.next()?;
            if t.text == "{" || t.text == "(" {
                depth += 1;
            } else if t.text == "}" || t.text == ")" {
                depth -= 1;
            } else if t.text == ";" && depth <= 0 {
                return Ok(());
            }
        }
    }

    /// Tokens between `open` and its matching `close`, both consumed.
    fn balanced(&mut self, open: &str, close: &str) -> Res<Vec<Token>> {
        self.expect(open)?;
        let start = self.i;
        let mut depth = 1;
        loop {
            let t = self.next()?;
            if t.text == open {
                depth += 1;
            } else if t.text == close {
                depth -= 1;
                if depth == 0 {
                    return Ok(self.tokens[start..self.i - 1].to_vec());
                }
            }
        }
    }

    /// Tokens up to one of `ends` (or `,`) outside parentheses, not consumed.
    fn until(&mut self, ends: &[&str]) -> Res<Vec<Token>> {
        let start = self.i;
        let mut depth = 0;
        while self.peek().is_some() && !(depth == 0 && (ends.iter().any(|e| self.is(e)) || self.is(","))) {
            let t = self.next()?;
            if t.text == "(" {
                depth += 1;
            } else if t.text == ")" {
                depth -= 1;
            }
        }
        Ok(self.tokens[start..self.i].to_vec())
    }

    /// Trailing comment of the `;` ending the current definition.
    fn end_trail(&self) -> String {
        match self.peek() {
            Some(t) if t.text == ";" => t.trail.clone(),
            _ => String::new(),
        }
    }

    // Names and references

    fn qualified(&self, name: &str) -> String {
        let mut parts = self.scope.clone();
        parts.push(name.to_string());
        parts.join("::")
    }

    /// Qualified name a written name refers to from `scope`, among declarations `ok` accepts.
    fn lookup(&self, written: &str, scope: &[String], ok: &dyn Fn(DeclKind) -> bool) -> Option<String> {
        let has = |q: &str| self.decls.get(q).is_some_and(|k| ok(*k));
        if let Some(rest) = written.strip_prefix("::") {
            return if has(rest) { Some(rest.to_string()) } else { None };
        }
        fn in_scope(
            p: &Parser,
            prefix: &str,
            written: &str,
            has: &dyn Fn(&str) -> bool,
            seen: &mut HashSet<String>,
        ) -> Option<String> {
            let q = if prefix.is_empty() { written.to_string() } else { format!("{prefix}::{written}") };
            if has(&q) {
                return Some(q);
            }
            if !seen.insert(prefix.to_string()) {
                return None;
            }
            for base in p.inherited.get(prefix).cloned().unwrap_or_default() {
                if let Some(found) = in_scope(p, &base, written, has, seen) {
                    return Some(found);
                }
            }
            None
        }
        for k in (0..=scope.len()).rev() {
            let prefix = scope[..k].join("::");
            if let Some(found) = in_scope(self, &prefix, written, &has, &mut HashSet::new()) {
                return Some(found);
            }
        }
        None
    }

    fn lookup_here(&self, written: &str, ok: &dyn Fn(DeclKind) -> bool) -> Option<String> {
        self.lookup(written, &self.scope, ok)
    }

    fn entity(&self, written: &str, kind: EKind) -> Option<Entity> {
        let want = match kind {
            EKind::Type => DeclKind::Type,
            EKind::Interface => DeclKind::Interface,
            EKind::Component => DeclKind::Component,
        };
        let q = self.lookup_here(written, &|k| k == want)?;
        self.entities.get(&q).filter(|e| e.kind() == kind).cloned()
    }

    /// Reference to a written name, resolved at the end.
    fn encode(&self, written: &str) -> String {
        format!("{}{SEP}{written}", self.scope.join("::"))
    }

    fn ref_(&self, written: &str) -> Json {
        ref_json(&self.encode(written))
    }

    fn add(&mut self, mut e: Entity) {
        // Read twice (a file included without guards, a reopened module): the first one stays.
        if self.entities.contains_key(&e.q) {
            return;
        }
        e.file = Some(self.file());
        self.decls.insert(e.q.clone(), e.decl_kind());
        self.entities.insert(e.q.clone(), e);
    }

    /// File of the definition just read.
    fn file(&self) -> String {
        let prev = if self.i >= 1 { self.tokens.get(self.i - 1) } else { None };
        prev.or_else(|| self.peek()).map_or_else(|| self.main.clone(), |t| t.file.clone())
    }

    /// Innermost IDL module holding the definition `q` ('' at file scope).
    fn module_of(&self, q: &str) -> String {
        let mut parts: Vec<&str> = q.split("::").collect();
        parts.pop();
        while !parts.is_empty() && self.decls.get(&parts.join("::")) != Some(&DeclKind::Module) {
            parts.pop();
        }
        parts.join("::")
    }

    fn forward(&mut self, q: &str, kind: DeclKind) {
        self.decls.entry(q.to_string()).or_insert(kind);
    }

    fn const_value(&self, name: &str) -> Option<Cv> {
        if name == "TRUE" {
            return Some(Cv::Bool(true));
        }
        if name == "FALSE" {
            return Some(Cv::Bool(false));
        }
        let constant = |k: DeclKind| k == DeclKind::Const || k == DeclKind::Enumerator;
        // Enumerators are in the scope of their enum's, also written `Enum::VALUE`.
        let parts: Vec<&str> = name.split("::").collect();
        let q = self.lookup_here(name, &constant).or_else(|| {
            if parts.len() > 1 {
                let mut p: Vec<&str> = parts[..parts.len() - 2].to_vec();
                p.push(parts[parts.len() - 1]);
                self.lookup_here(&p.join("::"), &constant)
            } else {
                None
            }
        })?;
        self.consts.get(&q).cloned()
    }

    fn evaluate(&self, tokens: &[Token]) -> Res<Cv> {
        if tokens.is_empty() {
            return self.fail(self.peek(), "a constant");
        }
        evaluate(tokens, &|n| self.const_value(n), &self.main)
    }

    /// A positive integer constant expression, up to one of `ends`.
    fn count(&mut self, ends: &[&str]) -> Res<i64> {
        let tokens = self.until(ends)?;
        let v = self.evaluate(&tokens)?;
        let n = match v {
            Cv::Int(i) => Some(i as f64),
            Cv::Float(f) => Some(f),
            _ => None,
        };
        match n {
            Some(n) if n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE as f64 && n >= 0.0 => {
                Ok(n as i64)
            }
            _ => Err(format!("{}: expected a positive integer", at(&tokens[0], &self.main))),
        }
    }

    /// Bound of a string, sequence or map, up to `>`; none when 0.
    fn bound(&mut self) -> Res<Option<i64>> {
        let n = self.count(&[">"])?;
        Ok(if n > 0 { Some(n) } else { None })
    }

    // Annotations

    fn annotations(&mut self) -> Res<Vec<Annotation>> {
        let mut list = Vec::new();
        while self.is("@") && !self.is_at("annotation", 1) {
            self.next()?;
            let name = self.scoped()?;
            let args = if self.is("(") { self.balanced("(", ")")? } else { Vec::new() };
            list.push(Annotation { name: last_segment(&name), args });
        }
        Ok(list)
    }

    /// Value of an annotation parameter: `key = value`, else the single value.
    fn annotation_value(&self, a: Option<&Annotation>, key: &str) -> Option<Cv> {
        let a = a?;
        if a.args.is_empty() {
            return None;
        }
        let mut tokens: &[Token] = &a.args;
        if a.args.get(1).is_some_and(|t| t.text == "=") {
            let start = (0..a.args.len())
                .find(|&k| a.args[k].text == key && a.args.get(k + 1).is_some_and(|t| t.text == "="))?;
            let end = (0..a.args.len()).find(|&k| {
                k > start && a.args[k].text == "," && a.args.get(k + 2).is_some_and(|t| t.text == "=")
            });
            tokens = &a.args[start + 2..end.unwrap_or(a.args.len())];
        }
        self.evaluate(tokens).ok()
    }

    /// Description of a member: its comment, then what annotations tell about it.
    fn describe(&self, text: &str, anns: &[Annotation]) -> String {
        let find = |n: &str| anns.iter().find(|a| a.name == n);
        let range = find("range");
        let min = self
            .annotation_value(range, "min")
            .or_else(|| self.annotation_value(find("min"), "value"))
            .map(|v| v.show());
        let max = self
            .annotation_value(range, "max")
            .or_else(|| self.annotation_value(find("max"), "value"))
            .map(|v| v.show());
        let unit = self.annotation_value(find("unit"), "value").map(|v| v.show());
        let unit_line = unit.filter(|u| !u.is_empty()).map(|u| format!("Unit: {u}."));
        let range_line = match (&min, &max) {
            (Some(a), Some(b)) => format!("Range: {a} to {b}."),
            (Some(a), None) => format!("Minimum: {a}."),
            (None, Some(b)) => format!("Maximum: {b}."),
            (None, None) => String::new(),
        };
        join_lines(&[text, unit_line.as_deref().unwrap_or(""), &range_line])
    }

    /// `@default` value of a member, as a field default.
    fn default_value(&self, anns: &[Annotation]) -> Option<Json> {
        let v = self.annotation_value(anns.iter().find(|a| a.name == "default"), "value")?;
        match v {
            Cv::Int(i) => {
                if i.unsigned_abs() <= MAX_SAFE {
                    Some(json!(i as i64))
                } else {
                    None
                }
            }
            other => Some(other.json()),
        }
    }

    // Definitions

    fn definition(&mut self) -> Res<()> {
        let first = self.peek().cloned().ok_or("Unexpected end of file")?;
        if self.is("@") && self.is_at("annotation", 1) {
            // Annotation declaration.
            self.next()?;
            self.next()?;
            self.name()?;
            self.balanced("{", "}")?;
            self.expect(";")?;
            return Ok(());
        }
        let anns = self.annotations()?;
        self.declaration(&first, anns)
    }

    fn declaration(&mut self, first: &Token, anns: Vec<Annotation>) -> Res<()> {
        let Some(t) = self.peek().cloned() else { return Ok(()) };
        match t.text.as_str() {
            ";" => {
                self.next()?;
                return Ok(());
            }
            "module" => return self.module(),
            "abstract" | "local" | "custom" => {
                self.next()?;
                if self.is("interface") {
                    return self.interface(first);
                }
                if self.is("custom") {
                    self.next()?;
                }
                if self.is("valuetype") || self.is("eventtype") {
                    return self.valuetype(first, t.text == "abstract");
                }
                return self.fail(self.peek(), "interface, valuetype or eventtype");
            }
            "interface" => return self.interface(first),
            "typedef" => return self.typedef(first),
            "const" => return self.constant(first),
            "native" => {
                self.next()?;
                let name = self.name()?;
                let description = or(&[&first.doc, &self.end_trail(), &first.trail]).to_string();
                self.expect(";")?;
                let q = self.qualified(&name);
                let def = Def::Type(TypeDef::Primitive { name: name.clone(), description });
                self.add(Entity::new(&q, &name, def));
                return Ok(());
            }
            "exception" => return self.exception(first),
            "valuetype" | "eventtype" => return self.valuetype(first, false),
            "component" | "connector" => return self.component(first),
            "porttype" => return self.porttype(),
            "home" => {
                self.next()?;
                let name = self.name()?;
                let q = self.qualified(&name);
                self.decls.insert(q.clone(), DeclKind::Home);
                self.warn(&t, &format!("home {q} left out"));
                return self.skip_definition();
            }
            // Template module referenced in a template module.
            "alias" => return self.module(),
            "typeid" | "typeprefix" | "import" => return self.skip_definition(),
            _ => {}
        }
        if CONSTRUCTED.contains(&t.text.as_str()) {
            self.constructed(first, &anns)?;
            self.expect(";")?;
            return Ok(());
        }
        self.fail(Some(&t), "a definition")
    }

    fn module(&mut self) -> Res<()> {
        let Some(_nesting) = Nesting::enter() else {
            return Err(too_deep(self.peek(), &self.main));
        };
        let keyword = self.next()?;
        let written = self.scoped()?;
        if self.is("<") {
            let args = self.template_args()?;
            if keyword.text == "module" && self.is("{") {
                // Template module: read where instantiated.
                let q = self.qualified(&unescape_name(&written));
                let params =
                    args.iter().map(|a| a.last().map_or(String::new(), |t| t.text.clone())).collect();
                let body = self.balanced("{", "}")?;
                self.templates.insert(q.clone(), Template { params, body });
                self.decls.insert(q, DeclKind::Template);
                self.expect(";")?;
                return Ok(());
            }
            let name = self.name()?;
            self.expect(";")?;
            return self.instantiate(&written, &args, &name, &keyword);
        }
        if keyword.text != "module" {
            return self.fail(self.peek(), "'<'");
        }
        let name = unescape_name(&written);
        let q = self.qualified(&name);
        self.forward(&q, DeclKind::Module);
        self.expect("{")?;
        self.scope.push(name);
        while !self.is("}") {
            if self.peek().is_none() {
                return self.fail(None, "'}'");
            }
            self.definition()?;
        }
        self.scope.pop();
        self.expect("}")?;
        self.expect(";")?;
        Ok(())
    }

    /// `<a, b, ...>` of a template module: the tokens of each parameter or argument.
    fn template_args(&mut self) -> Res<Vec<Vec<Token>>> {
        self.expect("<")?;
        let mut args: Vec<Vec<Token>> = vec![Vec::new()];
        let mut depth = 0;
        loop {
            let t = self.next()?;
            if t.text == ">" && depth == 0 {
                return Ok(args);
            }
            if t.text == "<" || t.text == "(" {
                depth += 1;
            } else if t.text == ">" || t.text == ")" {
                depth -= 1;
            } else if t.text == "," && depth == 0 {
                args.push(Vec::new());
                continue;
            }
            args.last_mut().unwrap().push(t);
        }
    }

    /// Reads an instance of a template module as a module `name` holding its definitions.
    fn instantiate(&mut self, written: &str, args: &[Vec<Token>], name: &str, from: &Token) -> Res<()> {
        let q = self.lookup_here(written, &|k| k == DeclKind::Template);
        let Some(template) = q.and_then(|q| self.templates.get(&q)) else {
            self.warn(from, &format!("template module {written} not found, {name} left out"));
            return Ok(());
        };
        if template.params.len() != args.len() {
            return Err(format!(
                "{}: {written} takes {} parameters, not {}",
                at(from, &self.main),
                template.params.len(),
                args.len()
            ));
        }
        self.instances += 1;
        if self.instances > 1000 {
            return Err(format!("{}: too many template instances", at(from, &self.main)));
        }
        let actual: HashMap<&str, &Vec<Token>> =
            template.params.iter().zip(args).map(|(p, a)| (p.as_str(), a)).collect();
        let mut body: Vec<Token> = Vec::new();
        for t in &template.body {
            match (t.kind == TokenKind::Ident).then(|| actual.get(t.text.as_str())).flatten() {
                Some(a) => body.extend((*a).iter().cloned()),
                None => body.push(t.clone()),
            }
        }
        let mut inserted = vec![
            Token::like(TokenKind::Ident, "module", from),
            Token::like(TokenKind::Ident, name, from),
            Token::like(TokenKind::Punct, "{", from),
        ];
        inserted.extend(body);
        inserted.push(Token::like(TokenKind::Punct, "}", from));
        inserted.push(Token::like(TokenKind::Punct, ";", from));
        let at_i = self.i;
        self.tokens.splice(at_i..at_i, inserted);
        Ok(())
    }

    fn interface(&mut self, first: &Token) -> Res<()> {
        self.expect("interface")?;
        let name = self.name()?;
        let q = self.qualified(&name);
        if self.accept(";").is_some() {
            self.forward(&q, DeclKind::Interface);
            return Ok(());
        }
        let mut messages: Vec<Message> = Vec::new();
        let mut needs: Vec<String> = Vec::new();
        let mut bases: Vec<String> = Vec::new();
        if self.accept(":").is_some() {
            for b in self.scoped_list()? {
                let base = self.entity(&b, EKind::Interface);
                let Some(Entity { q: bq, def: Def::Interface(bdef), needs: bneeds, .. }) = base else {
                    self.warn(first, &format!("{q}: base interface {b} not found"));
                    continue;
                };
                bases.push(bq);
                for m in &bdef.messages {
                    if !messages.iter().any(|x| x.name == m.name) {
                        messages.push(m.clone());
                    }
                }
                needs.extend(bneeds);
            }
        }
        self.expect("{")?;
        self.forward(&q, DeclKind::Interface);
        self.inherited.insert(q.clone(), bases);
        self.scope.push(name.clone());
        while self.accept("}").is_none() {
            let Some(f) = self.peek().cloned() else { return self.fail(None, "'}'") };
            let anns = self.annotations()?;
            let t = self.peek().cloned();
            if t.as_ref().is_some_and(|t| DEFINITION_WORDS.contains(&t.text.as_str())) {
                self.declaration(&f, anns)?;
            } else if self.is("attribute") || self.is("readonly") {
                self.attribute(&f, &mut messages, &mut needs)?;
            } else {
                let (message, raises) = self.operation(&f)?;
                messages.push(message);
                needs.extend(raises);
            }
        }
        self.scope.pop();
        let description = or(&[&first.doc, &self.end_trail(), &first.trail]).to_string();
        self.expect(";")?;
        let mut e =
            Entity::new(&q, &name, Def::Interface(IfaceDef { name: name.clone(), description, messages }));
        e.needs = needs;
        self.add(e);
        Ok(())
    }

    /// `raises (A, B)`: references to the exceptions.
    fn raises(&mut self) -> Res<Vec<String>> {
        self.expect("(")?;
        let names = self.scoped_list()?;
        self.expect(")")?;
        Ok(names.iter().map(|n| self.encode(n)).collect())
    }

    /// Attribute declaration, as messages: `get_x`, and `set_x` unless read-only.
    fn attribute(&mut self, first: &Token, messages: &mut Vec<Message>, needs: &mut Vec<String>) -> Res<()> {
        let a = self.attribute_decl(first)?;
        for n in &a.names {
            messages.push(Message {
                name: format!("get_{n}"),
                description: a.description.clone(),
                params: Vec::new(),
                returns: Some(a.ty.clone()),
                raises: a.get_raises.clone(),
            });
            if !a.readonly {
                messages.push(Message {
                    name: format!("set_{n}"),
                    description: a.description.clone(),
                    params: vec![Param {
                        name: n.clone(),
                        ty: a.ty.clone(),
                        direction: "in".into(),
                        description: None,
                    }],
                    returns: None,
                    raises: a.set_raises.clone(),
                });
            }
        }
        needs.extend(a.refs);
        Ok(())
    }

    fn attribute_decl(&mut self, first: &Token) -> Res<AttributeDecl> {
        let readonly = self.accept("readonly").is_some();
        self.expect("attribute")?;
        let ty = self.type_spec()?;
        let mut names = vec![self.name()?];
        while self.accept(",").is_some() {
            names.push(self.name()?);
        }
        let mut get_raises = Vec::new();
        let mut set_raises = Vec::new();
        while self.is("raises") || self.is("getraises") || self.is("setraises") {
            let which = self.next()?.text;
            let r = self.raises()?;
            if which == "setraises" { set_raises.extend(r) } else { get_raises.extend(r) }
        }
        let end = self.expect(";")?;
        let refs = get_raises.iter().chain(&set_raises).cloned().collect();
        Ok(AttributeDecl {
            names,
            ty,
            readonly,
            description: or(&[&first.doc, &end.trail, &first.trail]).to_string(),
            get_raises,
            set_raises,
            refs,
        })
    }

    fn operation(&mut self, first: &Token) -> Res<(Message, Vec<String>)> {
        self.accept("oneway");
        let returns = if self.accept("void").is_some() { None } else { Some(self.type_spec()?) };
        let name = self.name()?;
        self.expect("(")?;
        let mut params: Vec<Param> = Vec::new();
        if !self.is(")") {
            loop {
                let param = self.peek().cloned().ok_or("Unexpected end of file")?;
                self.annotations()?;
                let dir = if self.is("in") || self.is("out") || self.is("inout") {
                    self.next()?.text
                } else {
                    "in".into()
                };
                let ty = self.type_spec()?;
                let pname = self.name()?;
                params.push(Param {
                    name: pname,
                    ty,
                    direction: dir,
                    description: if param.doc.is_empty() { None } else { Some(param.doc.clone()) },
                });
                if self.accept(",").is_none() {
                    break;
                }
            }
        }
        self.expect(")")?;
        let raised = if self.accept("raises").is_some() { self.raises()? } else { Vec::new() };
        if self.accept("context").is_some() {
            self.balanced("(", ")")?;
        }
        let end = self.expect(";")?;
        let description = or(&[&first.doc, &end.trail, &first.trail]).to_string();
        Ok((Message { name, description, params, returns, raises: raised.clone() }, raised))
    }

    /// Struct, union, enum, bitmask or bitset definition (or forward declaration): its qualified name.
    fn constructed(&mut self, first: &Token, anns: &[Annotation]) -> Res<String> {
        match self.peek().map(|t| t.text.as_str()) {
            Some("struct") => self.struct_(first),
            Some("union") => self.union(first),
            Some("enum") => self.enum_(first, anns),
            Some("bitmask") => self.bitmask(first, anns),
            _ => self.bitset(first),
        }
    }

    /// Struct members up to `}`.
    fn members(&mut self, fields: &mut Vec<Field>) -> Res<()> {
        while self.accept("}").is_none() {
            let Some(member) = self.peek().cloned() else { return self.fail(None, "'}'") };
            let anns = self.annotations()?;
            if self.is("}") {
                continue;
            }
            let optional = anns.iter().any(|a| a.name == "optional");
            let base = self.type_spec()?;
            let declarators = self.declarators(&base, true)?;
            let end = self.expect(";")?;
            let description = self.describe(or(&[&member.doc, &end.trail, &member.trail]), &anns);
            for (name, ty) in declarators {
                fields.push(Field {
                    name,
                    ty: if optional { json!({"kind": "optional", "of": ty}) } else { ty },
                    description: description.clone(),
                    default: self.default_value(&anns),
                });
            }
        }
        Ok(())
    }

    /// Fields of a base struct, valuetype or bitset.
    fn base_fields(&mut self, written: &str, what: &str, first: &Token, q: &str) -> Vec<Field> {
        if let Some(Entity { def: Def::Type(TypeDef::Struct { fields, .. }), .. }) =
            self.entity(written, EKind::Type)
        {
            return fields;
        }
        self.warn(first, &format!("{q}: base {what} {written} not found"));
        Vec::new()
    }

    fn struct_(&mut self, first: &Token) -> Res<String> {
        self.expect("struct")?;
        let name = self.name()?;
        let q = self.qualified(&name);
        if !self.is("{") && !self.is(":") {
            self.forward(&q, DeclKind::Type);
            return Ok(q);
        }
        let mut fields = if self.accept(":").is_some() {
            let w = self.scoped()?;
            self.base_fields(&w, "struct", first, &q)
        } else {
            Vec::new()
        };
        self.expect("{")?;
        self.forward(&q, DeclKind::Type);
        self.scope.push(name.clone());
        self.members(&mut fields)?;
        self.scope.pop();
        let description = or(&[&first.doc, &self.end_trail(), &first.trail]).to_string();
        let def = Def::Type(TypeDef::Struct { exception: false, name: name.clone(), description, fields });
        self.add(Entity::new(&q, &name, def));
        Ok(q)
    }

    fn exception(&mut self, first: &Token) -> Res<()> {
        self.expect("exception")?;
        let name = self.name()?;
        let q = self.qualified(&name);
        self.expect("{")?;
        self.forward(&q, DeclKind::Type);
        self.scope.push(name.clone());
        let mut fields = Vec::new();
        self.members(&mut fields)?;
        self.scope.pop();
        let description = or(&[&first.doc, &self.end_trail(), &first.trail]).to_string();
        self.expect(";")?;
        let def = Def::Type(TypeDef::Struct { exception: true, name: name.clone(), description, fields });
        self.add(Entity::new(&q, &name, def));
        Ok(())
    }

    /// Union: its discriminator and cases, with their labels.
    fn union(&mut self, first: &Token) -> Res<String> {
        self.expect("union")?;
        let name = self.name()?;
        let q = self.qualified(&name);
        if !self.is("switch") {
            self.forward(&q, DeclKind::Type);
            return Ok(q);
        }
        self.expect("switch")?;
        self.expect("(")?;
        self.annotations()?;
        let discriminator = self.type_spec()?;
        self.expect(")")?;
        self.expect("{")?;
        self.forward(&q, DeclKind::Type);
        self.scope.push(name.clone());
        let mut cases: Vec<Case> = Vec::new();
        while self.accept("}").is_none() {
            let mut labels: Vec<Json> = Vec::new();
            let mut is_default = false;
            while self.is("case") || self.is("default") {
                if self.accept("default").is_some() {
                    is_default = true;
                } else {
                    self.next()?;
                    let tokens = self.until(&[":"])?;
                    let v = self.evaluate(&tokens)?;
                    labels.push(match v {
                        Cv::Int(i) if i.unsigned_abs() <= MAX_SAFE => json!(i as i64),
                        Cv::Int(i) => json!(i.to_string()),
                        other => other.json(),
                    });
                }
                self.expect(":")?;
            }
            if labels.is_empty() && !is_default {
                return self.fail(self.peek(), "'case' or 'default'");
            }
            let member = self.peek().cloned().ok_or("Unexpected end of file")?;
            let anns = self.annotations()?;
            let ty = self.type_spec()?;
            let (dname, dty) = self.declarators(&ty, false)?.remove(0);
            let end = self.expect(";")?;
            cases.push(Case {
                name: dname,
                ty: dty,
                description: self.describe(or(&[&member.doc, &end.trail, &member.trail]), &anns),
                labels,
                is_default,
            });
        }
        self.scope.pop();
        let description = or(&[&first.doc, &self.end_trail(), &first.trail]).to_string();
        let def = Def::Type(TypeDef::Union { name: name.clone(), description, discriminator, cases });
        self.add(Entity::new(&q, &name, def));
        Ok(q)
    }

    fn enum_(&mut self, first: &Token, anns: &[Annotation]) -> Res<String> {
        self.expect("enum")?;
        let name = self.name()?;
        let q = self.qualified(&name);
        self.expect("{")?;
        let mut values: Vec<(String, f64)> = Vec::new();
        let mut value = 0.0f64;
        loop {
            if self.is("}") {
                break;
            }
            let an = self.annotations()?;
            if let Some(explicit) = self.annotation_value(an.iter().find(|a| a.name == "value"), "value") {
                value = explicit.number();
            }
            let v = self.name()?;
            values.push((v.clone(), value));
            value += 1.0;
            // Enumerators belong to the enclosing scope.
            let vq = self.qualified(&v);
            self.decls.insert(vq.clone(), DeclKind::Enumerator);
            self.consts.insert(vq, Cv::Str(v));
            if self.accept(",").is_none() {
                break;
            }
        }
        self.expect("}")?;
        let bits = self.annotation_value(anns.iter().find(|a| a.name == "bit_bound"), "value");
        let nums: Vec<f64> = values.iter().map(|v| v.1).collect();
        let underlying = match bits {
            None => {
                if nums.iter().all(|v| *v <= 2147483647.0) {
                    "int32"
                } else {
                    int_type_of(&nums, 32.0, false)
                }
            }
            Some(b) => int_type_of(&nums, b.number(), false),
        };
        let description = or(&[&first.doc, &self.end_trail(), &first.trail]).to_string();
        let def = Def::Type(TypeDef::Enum {
            name: name.clone(),
            description,
            underlying: underlying.into(),
            values,
        });
        self.add(Entity::new(&q, &name, def));
        Ok(q)
    }

    /// Bitmask: an enum of its flags.
    fn bitmask(&mut self, first: &Token, anns: &[Annotation]) -> Res<String> {
        self.expect("bitmask")?;
        let name = self.name()?;
        let q = self.qualified(&name);
        self.expect("{")?;
        let mut flags: Vec<(String, i64)> = Vec::new();
        let mut bit = 0.0f64;
        loop {
            if self.is("}") {
                break;
            }
            let an = self.annotations()?;
            if let Some(p) = self.annotation_value(an.iter().find(|a| a.name == "position"), "value") {
                bit = p.number();
            }
            let flag = self.name()?;
            let fq = self.qualified(&flag);
            self.decls.insert(fq.clone(), DeclKind::Enumerator);
            self.consts.insert(fq, Cv::Str(flag.clone()));
            if bit < 64.0 {
                flags.push((flag, bit as i64));
            } else {
                self.warn(first, &format!("bitmask {q}: flag {flag} above bit 63 left out"));
            }
            bit += 1.0;
            if self.accept(",").is_none() {
                break;
            }
        }
        self.expect("}")?;
        let bound = self
            .annotation_value(anns.iter().find(|a| a.name == "bit_bound"), "value")
            .map_or(32.0, |v| v.number());
        let bits = flags.iter().fold(bound, |m, f| m.max(f.1 as f64 + 1.0));
        let description = or(&[&first.doc, &self.end_trail(), &first.trail]).to_string();
        let underlying = if bits <= 8.0 {
            "uint8"
        } else if bits <= 16.0 {
            "uint16"
        } else if bits <= 32.0 {
            "uint32"
        } else {
            "uint64"
        };
        let def = Def::Type(TypeDef::Bitmask {
            name: name.clone(),
            description,
            underlying: underlying.into(),
            flags,
        });
        self.add(Entity::new(&q, &name, def));
        Ok(q)
    }

    /// Bitset: a struct of its bitfields.
    fn bitset(&mut self, first: &Token) -> Res<String> {
        self.expect("bitset")?;
        let name = self.name()?;
        let q = self.qualified(&name);
        if !self.is("{") && !self.is(":") {
            self.forward(&q, DeclKind::Type);
            return Ok(q);
        }
        let mut fields = if self.accept(":").is_some() {
            let w = self.scoped()?;
            self.base_fields(&w, "bitset", first, &q)
        } else {
            Vec::new()
        };
        self.expect("{")?;
        while self.accept("}").is_none() {
            let member = self.peek().cloned();
            let anns = self.annotations()?;
            self.expect("bitfield")?;
            self.expect("<")?;
            let bits = self.count(&[">"])?;
            let ty = if self.accept(",").is_some() { self.type_spec()? } else { bitfield_type(bits) };
            self.expect(">")?;
            let mut names: Vec<String> = Vec::new();
            if !self.is(";") {
                names.push(self.name()?);
                while self.accept(",").is_some() {
                    names.push(self.name()?);
                }
            }
            let end = self.expect(";")?;
            let doc = member.as_ref().map_or("", |m| m.doc.as_str());
            let description =
                join_lines(&[&self.describe(or(&[doc, &end.trail]), &anns), &format!("{bits} bits.")]);
            for n in names {
                fields.push(Field {
                    name: n,
                    ty: ty.clone(),
                    description: description.clone(),
                    default: None,
                });
            }
        }
        self.warn(first, &format!("bitset {q} imported as a struct of its bitfields"));
        let description = or(&[&first.doc, &self.end_trail(), &first.trail]).to_string();
        let def = Def::Type(TypeDef::Struct { exception: false, name: name.clone(), description, fields });
        self.add(Entity::new(&q, &name, def));
        Ok(q)
    }

    fn typedef(&mut self, first: &Token) -> Res<()> {
        self.expect("typedef")?;
        self.annotations()?;
        let base = self.type_spec()?;
        let declarators = self.declarators(&base, true)?;
        let end = self.expect(";")?;
        let description = or(&[&first.doc, &end.trail, &first.trail]).to_string();
        for (name, ty) in declarators {
            let q = self.qualified(&name);
            let def = Def::Type(TypeDef::Alias { name: name.clone(), description: description.clone(), ty });
            self.add(Entity::new(&q, &name, def));
        }
        Ok(())
    }

    fn constant(&mut self, first: &Token) -> Res<()> {
        self.expect("const")?;
        let warnings = self.warnings.len();
        let ty = self.type_spec()?;
        self.warnings.truncate(warnings);
        let name = self.name()?;
        self.expect("=")?;
        let tokens = self.until(&[";"])?;
        let end = self.expect(";")?;
        let q = self.qualified(&name);
        self.decls.insert(q.clone(), DeclKind::Const);
        let Ok(value) = self.evaluate(&tokens) else {
            // Unknown value: uses of the constant tell.
            self.warn(first, &format!("constant {q} left out: its value is not computed"));
            return Ok(());
        };
        self.consts.insert(q.clone(), value.clone());
        if self.const_defs.iter().any(|c| c.q == q) {
            return Ok(());
        }
        let file = self.file();
        self.const_defs.push(ConstDef {
            q,
            file,
            name,
            description: or(&[&first.doc, &end.trail, &first.trail]).to_string(),
            ty,
            value: value.json(),
        });
        Ok(())
    }

    /// Valuetype or eventtype: a struct of its state members; an abstract one, an interface of its
    /// operations. A value box is an alias of an optional value.
    fn valuetype(&mut self, first: &Token, abstract_: bool) -> Res<()> {
        let keyword = self.next()?.text;
        let name = self.name()?;
        let q = self.qualified(&name);
        let decl = if abstract_ { DeclKind::Interface } else { DeclKind::Type };
        if self.accept(";").is_some() {
            self.forward(&q, decl);
            return Ok(());
        }
        if !self.is(":") && !self.is("supports") && !self.is("{") {
            let ty = self.type_spec()?;
            let description = or(&[&first.doc, &self.end_trail(), &first.trail]).to_string();
            self.expect(";")?;
            let def = Def::Type(TypeDef::Alias {
                name: name.clone(),
                description,
                ty: json!({"kind": "optional", "of": ty}),
            });
            self.add(Entity::new(&q, &name, def));
            return Ok(());
        }
        let mut fields: Vec<Field> = Vec::new();
        let mut messages: Vec<Message> = Vec::new();
        let mut needs: Vec<String> = Vec::new();
        let mut bases: Vec<String> = Vec::new();
        if self.accept(":").is_some() {
            self.accept("truncatable");
            for w in self.scoped_list()? {
                self.inherit(&w, first, &q, &mut fields, &mut messages, &mut needs, &mut bases);
            }
        }
        if self.accept("supports").is_some() {
            for w in self.scoped_list()? {
                self.inherit(&w, first, &q, &mut fields, &mut messages, &mut needs, &mut bases);
            }
        }
        self.expect("{")?;
        self.forward(&q, decl);
        self.inherited.insert(q.clone(), bases);
        self.scope.push(name.clone());
        let mut left = 0;
        while self.accept("}").is_none() {
            let Some(f) = self.peek().cloned() else { return self.fail(None, "'}'") };
            let anns = self.annotations()?;
            let t = self.peek().cloned().ok_or("Unexpected end of file")?;
            if t.text == "public" || t.text == "private" {
                self.next()?;
                let ty = self.type_spec()?;
                let declarators = self.declarators(&ty, true)?;
                let end = self.expect(";")?;
                let description = self.describe(or(&[&f.doc, &end.trail, &f.trail]), &anns);
                for (n, dty) in declarators {
                    fields.push(Field { name: n, ty: dty, description: description.clone(), default: None });
                }
            } else if t.text == "factory" || t.text == "init" {
                self.skip_definition()?;
                left += 1;
            } else if DEFINITION_WORDS.contains(&t.text.as_str()) {
                self.declaration(&f, anns)?;
            } else if t.text == "attribute" || t.text == "readonly" {
                let before = messages.len();
                self.attribute(&f, &mut messages, &mut needs)?;
                if !abstract_ {
                    left += messages.len() - before;
                    messages.truncate(before);
                }
            } else {
                let (message, raises) = self.operation(&f)?;
                if abstract_ {
                    messages.push(message);
                    needs.extend(raises);
                } else {
                    left += 1;
                }
            }
        }
        self.scope.pop();
        let description = or(&[&first.doc, &self.end_trail(), &first.trail]).to_string();
        self.expect(";")?;
        if abstract_ {
            let mut e = Entity::new(
                &q,
                &name,
                Def::Interface(IfaceDef { name: name.clone(), description, messages }),
            );
            e.needs = needs;
            self.add(e);
            return Ok(());
        }
        if left > 0 {
            self.warn(first, &format!("{keyword} {q}: {left} operations, factories or attributes left out"));
        }
        let def = Def::Type(TypeDef::Struct { exception: false, name: name.clone(), description, fields });
        self.add(Entity::new(&q, &name, def));
        Ok(())
    }

    fn inherit(
        &mut self,
        written: &str,
        first: &Token,
        q: &str,
        fields: &mut Vec<Field>,
        messages: &mut Vec<Message>,
        needs: &mut Vec<String>,
        bases: &mut Vec<String>,
    ) {
        let looked = self.lookup_here(written, &|k| k == DeclKind::Type || k == DeclKind::Interface);
        let base = looked.and_then(|l| self.entities.get(&l).cloned());
        match base {
            Some(Entity { def: Def::Type(TypeDef::Struct { fields: f, .. }), q: bq, .. }) => {
                fields.extend(f);
                bases.push(bq);
            }
            Some(Entity { def: Def::Interface(i), q: bq, needs: n, .. }) => {
                for m in &i.messages {
                    if !messages.iter().any(|x| x.name == m.name) {
                        messages.push(m.clone());
                    }
                }
                needs.extend(n);
                bases.push(bq);
            }
            _ => self.warn(first, &format!("{q}: base {written} not found")),
        }
    }

    /// Component or connector: a module with ports and attributes.
    fn component(&mut self, first: &Token) -> Res<()> {
        let keyword = self.next()?.text;
        let name = self.name()?;
        let q = self.qualified(&name);
        if self.accept(";").is_some() {
            self.forward(&q, DeclKind::Component);
            return Ok(());
        }
        let mut def = IdlComponent {
            name: name.clone(),
            description: String::new(),
            bases: Vec::new(),
            attributes: Vec::new(),
            methods: Vec::new(),
            ports: Vec::new(),
            needs: Vec::new(),
            qualified: None,
        };
        let mut needs: Vec<String> = Vec::new();
        if self.accept(":").is_some() {
            let b = self.scoped()?;
            match self.entity(&b, EKind::Component) {
                Some(base) => def.bases.push(format!("{SEP}::{}", base.q)),
                None => self.warn(first, &format!("{q}: base {keyword} {b} not found")),
            }
        }
        if self.accept("supports").is_some() {
            for s in self.scoped_list()? {
                let Some(Entity { def: Def::Interface(iface), needs: n, .. }) =
                    self.entity(&s, EKind::Interface)
                else {
                    self.warn(first, &format!("{q}: supported interface {s} not found"));
                    continue;
                };
                def.methods.extend(iface.messages);
                needs.extend(n);
            }
        }
        self.expect("{")?;
        self.forward(&q, DeclKind::Component);
        self.scope.push(name.clone());
        while self.accept("}").is_none() {
            let Some(f) = self.peek().cloned() else { return self.fail(None, "'}'") };
            let anns = self.annotations()?;
            let t = self.peek().cloned().ok_or("Unexpected end of file")?;
            if t.text == "attribute" || t.text == "readonly" {
                let a = self.attribute_decl(&f)?;
                for n in &a.names {
                    def.attributes.push(IdlAttribute {
                        name: n.clone(),
                        ty: a.ty.clone(),
                        description: a.description.clone(),
                        readonly: a.readonly,
                    });
                }
                needs.extend(a.refs);
            } else if PORT_WORDS.contains(&t.text.as_str()) || t.text == "mirrorport" {
                self.port(&mut def.ports, &mut def.attributes, &f)?;
            } else if DEFINITION_WORDS.contains(&t.text.as_str()) {
                self.declaration(&f, anns)?;
            } else {
                return self.fail(Some(&t), "a port or an attribute");
            }
        }
        self.scope.pop();
        def.description = or(&[&first.doc, &self.end_trail(), &first.trail]).to_string();
        self.expect(";")?;
        let mut e = Entity::new(&q, &name, Def::Component(def));
        e.needs = needs;
        self.add(e);
        Ok(())
    }

    fn porttype(&mut self) -> Res<()> {
        self.expect("porttype")?;
        let name = self.name()?;
        let q = self.qualified(&name);
        if self.accept(";").is_some() {
            self.forward(&q, DeclKind::Porttype);
            return Ok(());
        }
        let mut def = PortType { ports: Vec::new(), attributes: Vec::new() };
        self.expect("{")?;
        self.decls.insert(q.clone(), DeclKind::Porttype);
        self.scope.push(name);
        while self.accept("}").is_none() {
            let Some(f) = self.peek().cloned() else { return self.fail(None, "'}'") };
            let anns = self.annotations()?;
            let t = self.peek().cloned().ok_or("Unexpected end of file")?;
            if t.text == "attribute" || t.text == "readonly" {
                let a = self.attribute_decl(&f)?;
                for n in &a.names {
                    def.attributes.push(IdlAttribute {
                        name: n.clone(),
                        ty: a.ty.clone(),
                        description: a.description.clone(),
                        readonly: a.readonly,
                    });
                }
            } else if PORT_WORDS.contains(&t.text.as_str()) || t.text == "mirrorport" {
                self.port(&mut def.ports, &mut def.attributes, &f)?;
            } else if DEFINITION_WORDS.contains(&t.text.as_str()) {
                self.declaration(&f, anns)?;
            } else {
                return self.fail(Some(&t), "a port or an attribute");
            }
        }
        self.scope.pop();
        self.expect(";")?;
        self.porttypes.insert(q, def);
        Ok(())
    }

    /// Port declaration: `provides` and `consumes` are `in` ports, the others `out` ports.
    fn port(
        &mut self,
        ports: &mut Vec<IdlPort>,
        attributes: &mut Vec<IdlAttribute>,
        first: &Token,
    ) -> Res<()> {
        let keyword = self.next()?.text;
        let multiple = keyword == "uses" && self.accept("multiple").is_some();
        let written = if self.is("Object") { self.next()?.text } else { self.scoped()? };
        let name = self.name()?;
        let end = self.expect(";")?;
        let description = join_lines(&[
            or(&[&first.doc, &end.trail, &first.trail]),
            if multiple { "Multiple connections." } else { "" },
        ]);
        match keyword.as_str() {
            "provides" | "uses" => {
                ports.push(IdlPort {
                    name,
                    role: if keyword == "provides" { "in" } else { "out" },
                    interface: Some(self.encode(&written)),
                    description,
                });
                return Ok(());
            }
            "emits" | "publishes" | "consumes" => {
                let interface = self.event_consumer(&written, first);
                ports.push(IdlPort {
                    name,
                    role: if keyword == "consumes" { "in" } else { "out" },
                    interface: Some(interface),
                    description: join_lines(&[
                        &description,
                        if keyword == "publishes" { "Publishes to any number of consumers." } else { "" },
                    ]),
                });
                return Ok(());
            }
            _ => {}
        }
        let q = self.lookup_here(&written, &|k| k == DeclKind::Porttype);
        let Some(ty) = q.and_then(|q| self.porttypes.get(&q)) else {
            self.warn(first, &format!("porttype {written} not found, port {name} left out"));
            return Ok(());
        };
        for p in &ty.ports {
            let mut p = p.clone();
            p.name = format!("{name}_{}", p.name);
            if keyword == "mirrorport" {
                p.role = flip(p.role);
            }
            ports.push(p);
        }
        for a in &ty.attributes {
            let mut a = a.clone();
            a.name = format!("{name}_{}", a.name);
            attributes.push(a);
        }
        Ok(())
    }

    /// Interface receiving events of an eventtype (CCM's `<Event>Consumer`): its reference.
    fn event_consumer(&mut self, written: &str, first: &Token) -> String {
        let event = self.lookup_here(written, &|k| k == DeclKind::Type);
        if event.is_none() {
            self.warn(first, &format!("eventtype {written} not found"));
        }
        let simple = last_segment(written);
        let q = format!("{}Consumer", event.clone().unwrap_or_else(|| simple.clone()));
        if !self.entities.contains_key(&q) {
            let target = match &event {
                Some(e) => format!("::{e}"),
                None => written.to_string(),
            };
            let mut e = Entity::new(
                &q,
                &format!("{simple}Consumer"),
                Def::Interface(IfaceDef {
                    name: String::new(),
                    description: format!("Receives {simple} events."),
                    messages: vec![Message {
                        name: "push".into(),
                        description: String::new(),
                        params: vec![Param {
                            name: "event".into(),
                            ty: self.ref_(&target),
                            direction: "in".into(),
                            description: None,
                        }],
                        returns: None,
                        raises: Vec::new(),
                    }],
                }),
            );
            e.synthetic = true;
            self.add(e);
        }
        format!("{SEP}::{q}")
    }

    // Types

    fn declarators(&mut self, base: &Json, several: bool) -> Res<Vec<(String, Json)>> {
        let mut list = Vec::new();
        loop {
            let name = self.name()?;
            let mut sizes: Vec<i64> = Vec::new();
            while self.accept("[").is_some() {
                sizes.push(self.count(&["]"])?);
                self.expect("]")?;
            }
            // `T x[2][3]`: two arrays of three.
            let mut ty = base.clone();
            for size in sizes.into_iter().rev() {
                ty = json!({"kind": "array", "of": ty, "size": size});
            }
            list.push((name, ty));
            if !(several && self.accept(",").is_some()) {
                break;
            }
        }
        Ok(list)
    }

    fn type_spec(&mut self) -> Res<Json> {
        let Some(_nesting) = Nesting::enter() else {
            return Err(too_deep(self.peek(), &self.main));
        };
        let t = self.peek().cloned();
        if t.as_ref().is_some_and(|t| t.text == "::") {
            let s = self.scoped()?;
            return Ok(self.ref_(&s));
        }
        let Some(t) = t.filter(|t| t.kind == TokenKind::Ident) else {
            return self.fail(self.peek(), "a type");
        };
        let word = t.text.as_str();
        if CONSTRUCTED.contains(&word)
            && self.peek_at(1).is_some_and(|x| x.kind == TokenKind::Ident)
            && matches!(self.peek_at(2).map(|x| x.text.as_str()), Some("{" | ":" | "switch"))
        {
            let q = self.constructed(&t, &[])?;
            return Ok(ref_json(&format!("{SEP}::{q}")));
        }
        let template = self.is_at("<", 1);
        match word {
            "unsigned" => {
                self.next()?;
                let rest = self.next()?.text;
                let full = if rest == "long" && self.accept("long").is_some() {
                    "long long".to_string()
                } else {
                    rest
                };
                return match full.as_str() {
                    "short" => Ok(prim("uint16")),
                    "long" => Ok(prim("uint32")),
                    "long long" => Ok(prim("uint64")),
                    _ => self.fail(Some(&t), "an unsigned integer type"),
                };
            }
            "long" => {
                self.next()?;
                if self.accept("long").is_some() {
                    return Ok(prim("int64"));
                }
                if self.accept("double").is_some() {
                    self.warn(&t, "long double imported as float64");
                    return Ok(prim("float64"));
                }
                return Ok(prim("int32"));
            }
            "float" => {
                self.next()?;
                return Ok(prim("float32"));
            }
            "double" => {
                self.next()?;
                return Ok(prim("float64"));
            }
            "boolean" => {
                self.next()?;
                return Ok(prim("bool"));
            }
            "char" | "wchar" => {
                self.next()?;
                return Ok(prim("char"));
            }
            "string" | "wstring" => {
                self.next()?;
                if self.accept("<").is_none() {
                    return Ok(prim("string"));
                }
                let max = self.bound()?;
                self.expect(">")?;
                let mut p = prim("string");
                if let Some(m) = max {
                    p["max"] = json!(m);
                }
                return Ok(p);
            }
            "sequence" if template => {
                self.next()?;
                self.expect("<")?;
                let of = self.type_spec()?;
                let max = if self.accept(",").is_some() { self.bound()? } else { None };
                self.expect(">")?;
                let is_u8 = of["kind"] == "primitive" && of["name"] == "uint8";
                let mut out = if is_u8 { prim("bytes") } else { json!({"kind": "vector", "of": of}) };
                if let Some(m) = max {
                    out["max"] = json!(m);
                }
                return Ok(out);
            }
            "map" if template => {
                self.next()?;
                self.expect("<")?;
                let key = self.type_spec()?;
                self.expect(",")?;
                let value = self.type_spec()?;
                let max = if self.accept(",").is_some() { self.bound()? } else { None };
                self.expect(">")?;
                let mut out = json!({"kind": "map", "key": key, "value": value});
                if let Some(m) = max {
                    out["max"] = json!(m);
                }
                return Ok(out);
            }
            "fixed" => {
                self.next()?;
                if self.is("<") {
                    self.balanced("<", ">")?;
                }
                self.warn(&t, "fixed imported as float64");
                return Ok(prim("float64"));
            }
            "any" | "Object" | "ValueBase" => {
                self.next()?;
                return Ok(ref_json(&format!("{BUILTIN}{word}")));
            }
            _ => {}
        }
        if let Some(int) = int_type(word) {
            self.next()?;
            return Ok(prim(int));
        }
        if NOT_TYPES.contains(&word) {
            return self.fail(Some(&t), "a type");
        }
        let s = self.scoped()?;
        Ok(self.ref_(&s))
    }
}

// Result

/// Applies `f` (name, is a type reference) to every reference of an entity.
fn rewrite_entity(e: &mut Entity, f: &mut dyn FnMut(&str, bool) -> String) {
    fn ty(t: &Json, f: &mut dyn FnMut(&str, bool) -> String) -> Json {
        map_type_ref(t, &mut |n| f(n, true))
    }
    fn message(m: &mut Message, f: &mut dyn FnMut(&str, bool) -> String) {
        for p in &mut m.params {
            p.ty = ty(&p.ty, f);
        }
        if let Some(r) = &m.returns {
            m.returns = Some(ty(r, f));
        }
        m.raises = m.raises.iter().map(|n| f(n, false)).collect();
    }
    e.needs = e.needs.iter().map(|n| f(n, false)).collect();
    match &mut e.def {
        Def::Interface(i) => i.messages.iter_mut().for_each(|m| message(m, f)),
        Def::Component(c) => {
            for a in &mut c.attributes {
                a.ty = ty(&a.ty, f);
            }
            c.methods.iter_mut().for_each(|m| message(m, f));
            for p in &mut c.ports {
                p.interface = p.interface.as_ref().map(|i| f(i, false));
            }
            c.bases = c.bases.iter().map(|b| f(b, false)).collect();
        }
        Def::Type(TypeDef::Struct { fields, .. }) => {
            for fl in fields {
                fl.ty = ty(&fl.ty, f);
            }
        }
        Def::Type(TypeDef::Union { discriminator, cases, .. }) => {
            *discriminator = ty(discriminator, f);
            for c in cases {
                c.ty = ty(&c.ty, f);
            }
        }
        Def::Type(TypeDef::Alias { ty: t, .. }) => *t = ty(t, f),
        Def::Type(_) => {}
    }
}

fn dedupe(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in list {
        if !out.contains(s) {
            out.push(s.clone());
        }
    }
    out
}

impl Parser {
    /// Custom primitive standing for references to an interface or component.
    fn object_ref(&mut self, e: &Entity) -> String {
        let q = format!("{}{BUILTIN}Ref", e.q);
        if !self.entities.contains_key(&q) {
            let mut n = Entity::new(
                &q,
                &format!("{}Ref", e.simple),
                Def::Type(TypeDef::Primitive {
                    name: String::new(),
                    description: format!("Reference to a {} object", e.simple),
                }),
            );
            n.alt = Some(format!("{}Ref", e.q.split("::").collect::<Vec<_>>().join("_")));
            n.synthetic = true;
            if e.kind() == EKind::Interface {
                n.needs = vec![e.q.clone()];
            }
            self.add(n);
        }
        q
    }

    fn builtin(&mut self, word: &str) -> String {
        let q = format!("{BUILTIN}{word}");
        let (simple, description) = builtin_info(word);
        if !self.entities.contains_key(&q) {
            let mut n = Entity::new(
                &q,
                simple,
                Def::Type(TypeDef::Primitive { name: String::new(), description: description.into() }),
            );
            n.synthetic = true;
            self.add(n);
        }
        q
    }

    /// Qualified name a reference written in a scope stands for; `?name` when defined nowhere.
    fn target(&mut self, encoded: &str, defined: &[(String, bool)]) -> String {
        if let Some(word) = encoded.strip_prefix(BUILTIN) {
            return self.builtin(word);
        }
        let sep = encoded.find(SEP).unwrap_or(0);
        let scope = &encoded[..sep];
        let written = &encoded[(sep + SEP.len_utf8()).min(encoded.len())..];
        let scope_parts: Vec<String> =
            if scope.is_empty() { Vec::new() } else { scope.split("::").map(String::from).collect() };
        let mut q = self.lookup(written, &scope_parts, &|k| {
            matches!(k, DeclKind::Type | DeclKind::Interface | DeclKind::Component)
        });
        if q.as_ref().is_some_and(|q| !self.entities.contains_key(q)) {
            q = None;
        }
        if q.is_none() {
            // Not visible from there: a single definition of that name anywhere.
            let simple = last_segment(written);
            let same: Vec<&(String, bool)> =
                defined.iter().filter(|(dq, syn)| !syn && last_segment(dq) == simple).collect();
            if same.len() == 1 {
                q = Some(same[0].0.clone());
            }
        }
        q.unwrap_or_else(|| format!("?{}", last_segment(written)))
    }

    fn type_target(&mut self, encoded: &str, defined: &[(String, bool)]) -> String {
        let q = self.target(encoded, defined);
        match self.entities.get(&q).cloned() {
            Some(e) if e.kind() != EKind::Type => self.object_ref(&e),
            _ => q,
        }
    }

    fn finish(&mut self, missing: Vec<String>) -> Res<IdlFile> {
        // References to qualified names; `?name` when defined nowhere.
        let defined: Vec<(String, bool)> =
            self.entities.values().map(|e| (e.q.clone(), e.synthetic)).collect();
        for idx in 0..defined.len() {
            let mut e = self.entities[idx].clone();
            rewrite_entity(&mut e, &mut |n, is_type| {
                if is_type { self.type_target(n, &defined) } else { self.target(n, &defined) }
            });
            self.entities[idx] = e;
        }
        let mut const_defs = std::mem::take(&mut self.const_defs);
        for c in &mut const_defs {
            c.ty = map_type_ref(&c.ty, &mut |n| self.type_target(n, &defined));
        }

        // Project names: simple names, qualified ones for those several entities share.
        let mut all: Vec<Entity> = self.entities.values().cloned().collect();
        let mut names: HashMap<String, String> = HashMap::new();
        for components in [false, true] {
            let list: Vec<usize> =
                (0..all.len()).filter(|i| (all[*i].kind() == EKind::Component) == components).collect();
            let reserved = |n: &str| !components && is_reserved_type_name(n);
            let mut count: HashMap<&str, usize> = HashMap::new();
            for i in &list {
                *count.entry(all[*i].simple.as_str()).or_default() += 1;
            }
            let mut taken: HashSet<String> = HashSet::new();
            let mut assigned: Vec<(String, String, bool, bool)> = Vec::new();
            for i in &list {
                let e = &all[*i];
                let mut n = e.simple.clone();
                if count[n.as_str()] > 1 || reserved(&n) {
                    n = e.alt.clone().unwrap_or_else(|| e.q.split("::").collect::<Vec<_>>().join("_"));
                }
                while taken.contains(&n) || reserved(&n) {
                    n.push('_');
                }
                taken.insert(n.clone());
                assigned.push((e.q.clone(), n.clone(), n != e.simple, e.synthetic));
            }
            for (q, n, renamed, synthetic) in assigned {
                if renamed && !synthetic {
                    self.warnings.push(format!("{q} imported as {n}"));
                }
                names.insert(q, n);
            }
        }
        let name = |n: &str| -> String {
            match n.strip_prefix('?') {
                Some(r) => r.to_string(),
                None => names.get(n).cloned().unwrap_or_else(|| n.to_string()),
            }
        };
        for e in &mut all {
            rewrite_entity(e, &mut |n, _| name(n));
        }
        for e in &mut all {
            let n = names[&e.q].clone();
            e.set_name(&n);
        }
        // Constants: in the namespace of the types and interfaces.
        for c in &mut const_defs {
            c.ty = map_type_ref(&c.ty, &mut |n| name(n));
        }
        let mut taken: HashSet<String> = names.values().cloned().collect();
        let mut const_count: HashMap<String, usize> = HashMap::new();
        for c in &const_defs {
            *const_count.entry(c.name.clone()).or_default() += 1;
        }
        let mut types: HashMap<String, usize> = HashMap::new();
        for (i, e) in all.iter().enumerate() {
            if let Def::Type(t) = &e.def {
                types.insert(t.name().to_string(), i);
            }
        }
        for c in &mut const_defs {
            let simple = c.name.clone();
            let mut n = simple.clone();
            if const_count[&n] > 1 || taken.contains(&n) || is_reserved_type_name(&n) {
                n = c.q.split("::").collect::<Vec<_>>().join("_");
            }
            while taken.contains(&n) || is_reserved_type_name(&n) {
                n.push('_');
            }
            taken.insert(n.clone());
            if n != simple {
                self.warnings.push(format!("{} imported as {n}", c.q));
            }
            c.name = n;
            // A bitmask value: its flags.
            let target =
                if c.ty["kind"] == "ref" { c.ty["name"].as_str().and_then(|n| types.get(n)) } else { None };
            if let Some(i) = target
                && matches!(&all[*i].def, Def::Type(TypeDef::Bitmask { .. }))
                && c.value.is_string()
            {
                c.value = Json::Array(vec![c.value.clone()]);
            }
        }

        let main = self.main.clone();
        let mut file = IdlFile {
            types: Vec::new(),
            interfaces: Vec::new(),
            constants: Vec::new(),
            components: Vec::new(),
            needs: HashMap::new(),
            origins: HashMap::new(),
            scopes: HashMap::new(),
            qualified: HashMap::new(),
            includes: HashMap::new(),
            missing,
            warnings: std::mem::take(&mut self.warnings),
        };
        for e in &all {
            match &e.def {
                Def::Type(t) => file.types.push(t.clone()),
                Def::Interface(i) => file.interfaces.push(i.clone()),
                Def::Component(c) => {
                    let mut c = c.clone();
                    c.needs = dedupe(&e.needs);
                    file.components.push(c);
                }
            }
        }
        for e in &all {
            if e.kind() != EKind::Component && !e.needs.is_empty() {
                let n = match &e.def {
                    Def::Type(t) => t.name(),
                    Def::Interface(i) => &i.name,
                    Def::Component(c) => &c.name,
                };
                file.needs.insert(n.to_string(), dedupe(&e.needs));
            }
        }
        for e in &all {
            let n = match &e.def {
                Def::Type(t) => t.name(),
                Def::Interface(i) => &i.name,
                Def::Component(c) => &c.name,
            };
            file.origins.insert(n.to_string(), e.file.clone().unwrap_or_else(|| main.clone()));
        }
        for c in &const_defs {
            file.origins.insert(c.name.clone(), c.file.clone());
        }
        let mut written: Vec<(String, String)> = Vec::new();
        for e in &all {
            if !e.synthetic && e.kind() != EKind::Component {
                let n = match &e.def {
                    Def::Type(t) => t.name(),
                    Def::Interface(i) => &i.name,
                    Def::Component(c) => &c.name,
                };
                written.push((n.to_string(), e.q.clone()));
            }
        }
        written.extend(const_defs.iter().map(|c| (c.name.clone(), c.q.clone())));
        for (n, q) in written {
            file.scopes.insert(n.clone(), self.module_of(&q));
            file.qualified.insert(n, q);
        }
        for c in &mut file.components {
            c.qualified = all.iter().find_map(|e| match &e.def {
                Def::Component(d) if d.name == c.name => Some(e.q.clone()),
                _ => None,
            });
        }
        file.constants = const_defs;
        Ok(file)
    }
}

/// Reads the definitions of an IDL text and the files it includes.
fn parse_idl(text: &str, file: &str, files: &IndexMap<String, String>) -> Res<IdlFile> {
    let file = normalize_path(file);
    let mut pre = Preprocessor::new(files, &file);
    pre.include(&file, text)?;
    let mut parser = Parser::new(std::mem::take(&mut pre.out), &file, std::mem::take(&mut pre.warnings));
    let mut idl = parser.parse(std::mem::take(&mut pre.missing))?;
    idl.includes = std::mem::take(&mut pre.includes);
    Ok(idl)
}

// Import into a project

fn unique_name(base: &str, taken: &[String]) -> String {
    if !taken.iter().any(|t| t == base) {
        return base.to_string();
    }
    let mut i = 2;
    loop {
        let n = format!("{base}{i}");
        if !taken.contains(&n) {
            return n;
        }
        i += 1;
    }
}

fn message_names(messages: &[Message], into: &mut Vec<String>) {
    for m in messages {
        for p in &m.params {
            ref_names(&p.ty, into);
        }
        if let Some(r) = &m.returns {
            ref_names(r, into);
        }
    }
}

#[derive(Clone, Copy)]
enum EntRef {
    Type(usize),
    Interface(usize),
}

fn used_names(idl: &IdlFile, e: EntRef, needs: &[String]) -> Vec<String> {
    let mut names: Vec<String> = needs.to_vec();
    match e {
        EntRef::Interface(i) => message_names(&idl.interfaces[i].messages, &mut names),
        EntRef::Type(i) => match &idl.types[i] {
            TypeDef::Struct { fields, .. } => fields.iter().for_each(|f| ref_names(&f.ty, &mut names)),
            TypeDef::Union { discriminator, cases, .. } => {
                ref_names(discriminator, &mut names);
                cases.iter().for_each(|c| ref_names(&c.ty, &mut names));
            }
            TypeDef::Alias { ty, .. } => ref_names(ty, &mut names),
            _ => {}
        },
    }
    names
}

/// A module of the project (an IDL component, or a server of IDL interfaces).
struct PModule {
    id: usize,
    name: String,
    description: String,
    parent: Option<usize>,
    bases: Vec<usize>,
    attributes: Vec<IdlAttribute>,
    methods: Vec<Message>,
    ports: Vec<IdlPort>,
}

struct PType {
    def: TypeDef,
    dep: Option<usize>,
    /// Module of this project holding it.
    module: Option<usize>,
    /// Module of its dependency holding it.
    module_path: Option<String>,
}

struct PIface {
    def: IfaceDef,
    dep: Option<usize>,
}

struct PConst {
    def: ConstDef,
    dep: Option<usize>,
    module: Option<usize>,
    module_path: Option<String>,
}

struct PDep {
    name: String,
    file: String,
    uses: Vec<String>,
    indirect: bool,
}

struct Imported {
    types: Vec<PType>,
    interfaces: Vec<PIface>,
    consts: Vec<PConst>,
    modules: Vec<PModule>,
    unresolved: Vec<String>,
}

/// The entities of an IDL file for an empty project: every definition and every component (as
/// modules), with the names the project gives them. Names defined nowhere become custom
/// primitives (empty interfaces for ports).
fn import_idl(idl: &IdlFile) -> Imported {
    let mut by_name: IndexMap<String, EntRef> = IndexMap::new();
    for (i, t) in idl.types.iter().enumerate() {
        by_name.insert(t.name().to_string(), EntRef::Type(i));
    }
    for (i, f) in idl.interfaces.iter().enumerate() {
        by_name.insert(f.name.clone(), EntRef::Interface(i));
    }
    let mut components: IndexMap<String, usize> = IndexMap::new();
    for (i, c) in idl.components.iter().enumerate() {
        components.insert(c.name.clone(), i);
    }
    let with_behavior = !idl.interfaces.is_empty() || !idl.components.is_empty();
    let mut queue: VecDeque<String> = by_name.keys().cloned().collect();
    let mut component_queue: VecDeque<String> =
        if with_behavior { components.keys().cloned().collect() } else { VecDeque::new() };

    // Components reached from the roots, through their bases.
    let mut picked_components: Vec<String> = Vec::new();
    while let Some(name) = component_queue.pop_front() {
        if picked_components.contains(&name) {
            continue;
        }
        picked_components.push(name.clone());
        let c = &idl.components[components[&name]];
        component_queue.extend(c.bases.iter().filter(|b| components.contains_key(*b)).cloned());
        let mut refs = Vec::new();
        for a in &c.attributes {
            ref_names(&a.ty, &mut refs);
        }
        message_names(&c.methods, &mut refs);
        refs.extend(c.needs.iter().cloned());
        queue.extend(refs);
    }
    // The whole file: its constants too, with their types.
    for c in &idl.constants {
        let mut refs = Vec::new();
        ref_names(&c.ty, &mut refs);
        queue.extend(refs);
    }
    let mut port_interfaces: HashSet<String> = HashSet::new();
    for name in &picked_components {
        for p in &idl.components[components[name]].ports {
            if let Some(i) = &p.interface {
                port_interfaces.insert(i.clone());
                queue.push_back(i.clone());
            }
        }
    }

    // Entities reached from the roots.
    let mut picked: HashSet<String> = HashSet::new();
    let mut unresolved: Vec<String> = Vec::new();
    while let Some(name) = queue.pop_front() {
        if picked.contains(&name) || unresolved.contains(&name) {
            continue;
        }
        if let Some(e) = by_name.get(&name) {
            picked.insert(name.clone());
            let needs = idl.needs.get(&name).cloned().unwrap_or_default();
            queue.extend(used_names(idl, *e, &needs));
        } else {
            unresolved.push(name);
        }
    }
    // Undefined names used as types become custom primitives; those only ports use, empty interfaces.
    let mut used_as_type: HashSet<String> = HashSet::new();
    for name in &picked {
        used_as_type.extend(used_names(idl, by_name[name], &[]));
    }
    let mut type_names: Vec<String> = Vec::new();
    for name in &picked_components {
        let c = &idl.components[components[name]];
        for a in &c.attributes {
            ref_names(&a.ty, &mut type_names);
        }
        message_names(&c.methods, &mut type_names);
    }
    used_as_type.extend(type_names);
    let empty_interfaces: HashSet<&String> =
        unresolved.iter().filter(|n| port_interfaces.contains(*n) && !used_as_type.contains(*n)).collect();

    // Names only raised: exceptions without fields.
    let mut raised: HashSet<String> = HashSet::new();
    for n in &picked {
        if let EntRef::Interface(i) = by_name[n] {
            for m in &idl.interfaces[i].messages {
                raised.extend(m.raises.iter().cloned());
            }
        }
    }
    for name in &picked_components {
        for m in &idl.components[components[name]].methods {
            raised.extend(m.raises.iter().cloned());
        }
    }

    let mut types: Vec<TypeDef> = Vec::new();
    let mut interfaces: Vec<IfaceDef> = Vec::new();
    for t in &idl.types {
        if picked.contains(t.name()) {
            types.push(t.clone());
        }
    }
    for i in &idl.interfaces {
        if picked.contains(&i.name) {
            interfaces.push(i.clone());
        }
    }
    let description = "Not defined in the IDL files".to_string();
    for name in &unresolved {
        if empty_interfaces.contains(name) {
            interfaces.push(IfaceDef {
                name: name.clone(),
                description: description.clone(),
                messages: Vec::new(),
            });
        } else if raised.contains(name) && !used_as_type.contains(name) {
            types.push(TypeDef::Struct {
                exception: true,
                name: name.clone(),
                description: description.clone(),
                fields: Vec::new(),
            });
        } else {
            types.push(TypeDef::Primitive { name: name.clone(), description: description.clone() });
        }
    }

    // Names in the project: types, then constants, then interfaces (see `pasteClip`).
    let mut taken: Vec<String> = Vec::new();
    let mut final_names: HashMap<String, String> = HashMap::new();
    for t in &types {
        let n = unique_name(t.name(), &taken);
        taken.push(n.clone());
        final_names.insert(t.name().to_string(), n);
    }
    let mut const_names: Vec<String> = Vec::new();
    for c in &idl.constants {
        let n = unique_name(&c.name, &taken);
        taken.push(n.clone());
        const_names.push(n);
    }
    for i in &interfaces {
        let n = unique_name(&i.name, &taken);
        taken.push(n.clone());
        final_names.insert(i.name.clone(), n);
    }
    let iface_names: HashSet<String> = interfaces.iter().map(|i| i.name.clone()).collect();
    let fin = |n: &str| final_names.get(n).cloned().unwrap_or_else(|| "__deleted__".to_string());
    let map_ty = |t: &Json| map_type_ref(t, &mut |n| fin(n));
    let map_message = |m: &Message| Message {
        name: m.name.clone(),
        description: m.description.clone(),
        params: m.params.iter().map(|p| Param { ty: map_ty(&p.ty), ..p.clone() }).collect(),
        returns: m.returns.as_ref().map(&map_ty),
        raises: m.raises.iter().map(|n| fin(n)).collect(),
    };

    let mut out = Imported {
        types: Vec::new(),
        interfaces: Vec::new(),
        consts: Vec::new(),
        modules: Vec::new(),
        unresolved: unresolved.clone(),
    };
    for mut t in types {
        let n = fin(t.name());
        match &mut t {
            TypeDef::Struct { fields, .. } => fields.iter_mut().for_each(|f| f.ty = map_ty(&f.ty)),
            TypeDef::Union { discriminator, cases, .. } => {
                *discriminator = map_ty(discriminator);
                cases.iter_mut().for_each(|c| c.ty = map_ty(&c.ty));
            }
            TypeDef::Alias { ty, .. } => *ty = map_ty(ty),
            _ => {}
        }
        *t.name_mut() = n;
        out.types.push(PType { def: t, dep: None, module: None, module_path: None });
    }
    for (c, n) in idl.constants.iter().zip(const_names) {
        out.consts.push(PConst {
            def: ConstDef {
                q: c.q.clone(),
                file: c.file.clone(),
                name: n,
                description: c.description.clone(),
                ty: map_ty(&c.ty),
                value: c.value.clone(),
            },
            dep: None,
            module: None,
            module_path: None,
        });
    }
    for i in interfaces {
        out.interfaces.push(PIface {
            def: IfaceDef {
                name: fin(&i.name),
                description: i.description.clone(),
                messages: i.messages.iter().map(&map_message).collect(),
            },
            dep: None,
        });
    }

    // Components, in the order of the file.
    let picked_set: HashSet<&String> = picked_components.iter().collect();
    let mut ids: HashMap<String, usize> = HashMap::new();
    for (k, name) in idl.components.iter().map(|c| &c.name).filter(|n| picked_set.contains(*n)).enumerate() {
        ids.insert(name.clone(), k);
    }
    let mut next_id = 0;
    for c in &idl.components {
        if !picked_set.contains(&c.name) {
            continue;
        }
        let siblings: Vec<String> =
            out.modules.iter().filter(|m| m.parent.is_none()).map(|m| m.name.clone()).collect();
        out.modules.push(PModule {
            id: next_id,
            name: unique_name(&c.name, &siblings),
            description: c.description.clone(),
            parent: None,
            bases: c.bases.iter().filter_map(|b| ids.get(b).copied()).collect(),
            attributes: c
                .attributes
                .iter()
                .map(|a| IdlAttribute { ty: map_ty(&a.ty), ..a.clone() })
                .collect(),
            methods: c.methods.iter().map(&map_message).collect(),
            ports: c
                .ports
                .iter()
                .map(|p| IdlPort {
                    interface: p.interface.as_ref().filter(|i| iface_names.contains(*i)).map(|i| fin(i)),
                    ..p.clone()
                })
                .collect(),
        });
        next_id += 1;
    }
    out
}

fn stem(path: &str) -> String {
    let b = base_name(path);
    match b.rfind('.') {
        Some(i) => b[..i].to_string(),
        None => b.to_string(),
    }
}

/// An identifier made from a project name, for a new dependency.
fn dependency_name(name: &str) -> String {
    static NON_ID: LazyLock<Regex> = LazyLock::new(|| re(r"[^A-Za-z0-9_]+"));
    let id = NON_ID.replace_all(name, "_");
    let id = id.trim_matches('_');
    if id.is_empty() {
        return "Other".into();
    }
    if id.starts_with(|c: char| c.is_ascii_digit()) { format!("_{id}") } else { id.to_string() }
}

/// `path` relative to the folder of `from` (both normalized, of the same root).
fn relative_path(from: &str, path: &str) -> String {
    let dir_str = dir_of(from);
    let mut dir: Vec<&str> = dir_str.split('/').collect();
    dir.pop();
    let parts: Vec<&str> = path.split('/').collect();
    let mut common = 0;
    while common < dir.len() && common + 1 < parts.len() && dir[common] == parts[common] {
        common += 1;
    }
    let mut out: Vec<&str> = dir[common..].iter().map(|_| "..").collect();
    out.extend(&parts[common..]);
    out.join("/")
}

/// Module standing for an IDL module of the file (see `interface_servers`).
struct IdlServer {
    /// Qualified IDL module, '' for the file scope.
    scope: String,
    component: IdlComponent,
}

/// Whether the file `file` defines components: then its modules serve no interfaces.
fn has_components(idl: &IdlFile, file: &str, main: &str) -> bool {
    idl.components.iter().any(|c| idl.origins.get(&c.name).map_or(main, |s| s.as_str()) == file)
}

/// IDL module enclosing the component `c` ('' at file scope).
fn component_scope(c: &IdlComponent) -> String {
    let q = c.qualified.as_deref().unwrap_or("");
    q.rfind("::").map_or(String::new(), |i| q[..i].to_string())
}

/// Modules standing for the IDL modules of the file `main`: one per IDL module holding
/// definitions or components, and per IDL module enclosing those; types and constants of IDL
/// modules are theirs. In files without components (plain CORBA IDL, DDS types), each provides the
/// interfaces of its IDL module on `in` ports, the file's own module those at file scope.
fn interface_servers(idl: &IdlFile, main: &str) -> Vec<IdlServer> {
    let own = |name: &str| idl.origins.get(name).map_or(main, |s| s.as_str()) == main;
    let mut by_scope: IndexMap<String, Vec<String>> = IndexMap::new();
    fn add(by_scope: &mut IndexMap<String, Vec<String>>, scope: &str) {
        if let Some(parent) = scope.rfind("::").filter(|p| *p > 0) {
            add(by_scope, &scope[..parent]);
        }
        by_scope.entry(scope.to_string()).or_default();
    }
    let serves = !has_components(idl, main, main);
    let names = idl
        .types
        .iter()
        .map(|t| (t.name(), false))
        .chain(idl.interfaces.iter().map(|i| (i.name.as_str(), true)))
        .chain(idl.constants.iter().map(|c| (c.name.as_str(), false)));
    for (name, is_interface) in names {
        let Some(scope) = idl.scopes.get(name) else { continue };
        if !own(name) {
            continue;
        }
        if serves && is_interface {
            add(&mut by_scope, scope);
            by_scope.get_mut(scope).unwrap().push(name.to_string());
        } else if !scope.is_empty() {
            add(&mut by_scope, scope);
        }
    }
    for c in &idl.components {
        let scope = component_scope(c);
        if !scope.is_empty() && own(&c.name) {
            add(&mut by_scope, &scope);
        }
    }
    let mut taken: Vec<String> = idl.components.iter().map(|c| c.name.clone()).collect();
    let mut servers = Vec::new();
    for (scope, interfaces) in by_scope {
        let base = if scope.is_empty() {
            dependency_name(&stem(main))
        } else {
            scope.split("::").collect::<Vec<_>>().join("_")
        };
        let name = unique_name(&base, &taken);
        taken.push(name.clone());
        let mut ports: Vec<String> = Vec::new();
        let mut list = Vec::new();
        for i in &interfaces {
            let mut chars = i.chars();
            let lowered: String =
                chars.next().map(|c| c.to_lowercase().collect::<String>()).unwrap_or_default()
                    + chars.as_str();
            let port = unique_name(&lowered, &ports);
            ports.push(port.clone());
            list.push(IdlPort {
                name: port,
                role: "in",
                interface: Some(i.clone()),
                description: String::new(),
            });
        }
        let description = if scope.is_empty() {
            "Serves the interfaces of the file.".to_string()
        } else if !interfaces.is_empty() {
            format!("Serves the interfaces of IDL module {scope}.")
        } else {
            format!("IDL module {scope}.")
        };
        servers.push(IdlServer {
            scope,
            component: IdlComponent {
                name,
                description,
                bases: Vec::new(),
                attributes: Vec::new(),
                methods: Vec::new(),
                ports: list,
                needs: Vec::new(),
                qualified: None,
            },
        });
    }
    servers
}

/// Nest the modules of `servers` like their IDL modules, with the modules of the `components`
/// they enclose, named simply there. Returns the module (its id) of each IDL module, and the
/// qualified IDL names of the components named simply.
fn nest_servers(
    modules: &mut [PModule],
    servers: &[IdlServer],
    components: &[&IdlComponent],
) -> (IndexMap<String, usize>, HashSet<String>) {
    let root =
        |modules: &[PModule], name: &str| modules.iter().position(|x| x.name == name && x.parent.is_none());
    let mut map: IndexMap<String, usize> = IndexMap::new();
    for s in servers {
        if let Some(k) = root(modules, &s.component.name) {
            map.insert(s.scope.clone(), k);
        }
    }
    // Components of IDL modules, with their qualified name.
    let mut held: Vec<(usize, String, String)> = Vec::new();
    for c in components {
        let scope = component_scope(c);
        if !scope.is_empty()
            && map.contains_key(&scope)
            && let Some(k) = root(modules, &c.name)
        {
            held.push((k, scope, c.qualified.clone().unwrap_or_default()));
        }
    }
    let parent_of = |scope: &str| -> Option<String> { scope.rfind("::").map(|i| scope[..i].to_string()) };
    let depth = |scope: &str| if scope.is_empty() { 0 } else { scope.split("::").count() };
    let mut order: Vec<String> = map.keys().cloned().collect();
    order.sort_by_key(|s| std::cmp::Reverse(depth(s)));
    for scope in &order {
        let parent_id = modules[map[scope]].id;
        let mut children: Vec<usize> = map
            .iter()
            .filter(|(s, _)| parent_of(s).as_deref() == Some(scope.as_str()))
            .map(|(_, k)| *k)
            .collect();
        children.extend(held.iter().filter(|h| &h.1 == scope).map(|h| h.0));
        for c in children {
            modules[c].parent = Some(parent_id);
        }
    }
    let rename = |modules: &mut [PModule], k: usize, q: &str| -> bool {
        let simple = last_segment(q);
        let parent = modules[k].parent;
        let siblings: Vec<String> = modules
            .iter()
            .enumerate()
            .filter(|(i, m)| *i != k && m.parent == parent)
            .map(|(_, m)| m.name.clone())
            .collect();
        modules[k].name = unique_name(&simple, &siblings);
        modules[k].name == simple
    };
    let mut simply = HashSet::new();
    for (scope, k) in &map {
        if !scope.is_empty() {
            rename(modules, *k, scope);
        }
    }
    for (k, _, q) in &held {
        if rename(modules, *k, q) {
            simply.insert(q.clone());
        }
    }
    (map.into_iter().map(|(s, k)| (s, modules[k].id)).collect(), simply)
}

/// Makes the types and constants of the IDL modules those of their modules (`modules`, by IDL
/// module, of the file `main`), or of the modules of the included file defining them (by path),
/// named simply there. Returns the qualified IDL names of those named simply.
fn scope_definitions(
    types: &mut [PType],
    consts: &mut [PConst],
    idl: &IdlFile,
    main: &str,
    modules: &IndexMap<String, usize>,
) -> HashSet<String> {
    let mut simply = HashSet::new();
    let mut taken: HashMap<String, Vec<String>> = HashMap::new();
    let all_scopes: Vec<&String> = idl.scopes.values().collect();
    let mut one = |name: &mut String, module: &mut Option<usize>, module_path: &mut Option<String>| {
        let (Some(scope), Some(q)) = (idl.scopes.get(name.as_str()), idl.qualified.get(name.as_str())) else {
            return;
        };
        if scope.is_empty() {
            return;
        }
        let file = idl.origins.get(name.as_str()).map_or(main, |s| s.as_str());
        let found = if file == main { modules.get(scope).copied() } else { None };
        if file == main && found.is_none() {
            return;
        }
        // Unique among the definitions of the module, its submodules and its components.
        let key = format!("{file}|{scope}");
        let names = taken.entry(key).or_insert_with(|| {
            let components: Vec<&IdlComponent> = idl
                .components
                .iter()
                .filter(|c| {
                    c.qualified.is_some() && idl.origins.get(&c.name).map_or(main, |s| s.as_str()) == file
                })
                .collect();
            let prefix = format!("{scope}::");
            let mut list: Vec<String> = Vec::new();
            let inside =
                all_scopes.iter().map(|s| s.to_string()).chain(components.iter().map(|c| component_scope(c)));
            for s in inside {
                if let Some(rest) = s.strip_prefix(&prefix) {
                    let first = rest.split("::").next().unwrap().to_string();
                    if !list.contains(&first) {
                        list.push(first);
                    }
                }
            }
            for c in components.iter().filter(|c| &component_scope(c) == scope) {
                let n = last_segment(c.qualified.as_deref().unwrap());
                if !list.contains(&n) {
                    list.push(n);
                }
            }
            list
        });
        let simple = last_segment(q);
        if !is_reserved_type_name(&simple) {
            *name = unique_name(&simple, names);
        }
        if *name == simple {
            simply.insert(q.clone());
        }
        names.push(name.clone());
        match found {
            Some(id) => *module = Some(id),
            None => *module_path = Some(scope.split("::").collect::<Vec<_>>().join(".")),
        }
    };
    for t in types.iter_mut() {
        one(t.def.name_mut(), &mut t.module, &mut t.module_path);
    }
    for c in consts.iter_mut() {
        one(&mut c.def.name, &mut c.module, &mut c.module_path);
    }
    simply
}

// Export (`toFile` of the TypeScript model, without the editor section)

fn put_description(o: &mut serde_json::Map<String, Json>, description: &str) {
    if !description.is_empty() {
        o.insert("description".into(), json!(description));
    }
}

fn field_json(f: &Field) -> Json {
    let mut o = serde_json::Map::new();
    o.insert("name".into(), json!(f.name));
    o.insert("type".into(), f.ty.clone());
    put_description(&mut o, &f.description);
    if let Some(d) = &f.default {
        o.insert("default".into(), d.clone());
    }
    Json::Object(o)
}

fn type_json(t: &TypeDef) -> Json {
    let mut o = serde_json::Map::new();
    let (kind, name, description) = match t {
        TypeDef::Struct { exception, name, description, .. } => {
            (if *exception { "exception" } else { "struct" }, name, description)
        }
        TypeDef::Union { name, description, .. } => ("union", name, description),
        TypeDef::Enum { name, description, .. } => ("enum", name, description),
        TypeDef::Bitmask { name, description, .. } => ("bitmask", name, description),
        TypeDef::Alias { name, description, .. } => ("alias", name, description),
        TypeDef::Primitive { name, description } => ("primitive", name, description),
    };
    o.insert("kind".into(), json!(kind));
    o.insert("name".into(), json!(name));
    put_description(&mut o, description);
    match t {
        TypeDef::Struct { fields, .. } => {
            o.insert("fields".into(), Json::Array(fields.iter().map(field_json).collect()));
        }
        TypeDef::Union { discriminator, cases, .. } => {
            o.insert("discriminator".into(), discriminator.clone());
            let cases = cases
                .iter()
                .map(|c| {
                    let mut k = serde_json::Map::new();
                    k.insert("name".into(), json!(c.name));
                    k.insert("type".into(), c.ty.clone());
                    put_description(&mut k, &c.description);
                    if !c.labels.is_empty() {
                        k.insert("labels".into(), Json::Array(c.labels.clone()));
                    }
                    if c.is_default {
                        k.insert("default".into(), json!(true));
                    }
                    Json::Object(k)
                })
                .collect();
            o.insert("cases".into(), Json::Array(cases));
        }
        TypeDef::Enum { underlying, values, .. } => {
            o.insert("underlying".into(), json!(underlying));
            let v = values.iter().map(|(n, v)| json!({"name": n, "value": num_json(*v)})).collect();
            o.insert("values".into(), Json::Array(v));
        }
        TypeDef::Bitmask { underlying, flags, .. } => {
            o.insert("underlying".into(), json!(underlying));
            let v = flags.iter().map(|(n, b)| json!({"name": n, "bit": b})).collect();
            o.insert("flags".into(), Json::Array(v));
        }
        TypeDef::Alias { ty, .. } => {
            o.insert("type".into(), ty.clone());
        }
        TypeDef::Primitive { .. } => {}
    }
    Json::Object(o)
}

fn message_json(m: &Message) -> Json {
    let mut o = serde_json::Map::new();
    o.insert("name".into(), json!(m.name));
    put_description(&mut o, &m.description);
    let params = m
        .params
        .iter()
        .map(|p| {
            let mut k = serde_json::Map::new();
            k.insert("name".into(), json!(p.name));
            k.insert("type".into(), p.ty.clone());
            put_description(&mut k, p.description.as_deref().unwrap_or(""));
            if p.direction != "in" {
                k.insert("direction".into(), json!(p.direction));
            }
            Json::Object(k)
        })
        .collect();
    o.insert("params".into(), Json::Array(params));
    o.insert("returns".into(), m.returns.clone().unwrap_or(Json::Null));
    if !m.raises.is_empty() {
        o.insert("raises".into(), json!(m.raises));
    }
    Json::Object(o)
}

fn iface_json(i: &IfaceDef) -> Json {
    let mut o = serde_json::Map::new();
    o.insert("name".into(), json!(i.name));
    put_description(&mut o, &i.description);
    o.insert("messages".into(), Json::Array(i.messages.iter().map(message_json).collect()));
    Json::Object(o)
}

fn const_json(c: &ConstDef) -> Json {
    let mut o = serde_json::Map::new();
    o.insert("name".into(), json!(c.name));
    put_description(&mut o, &c.description);
    o.insert("type".into(), c.ty.clone());
    o.insert("value".into(), c.value.clone());
    Json::Object(o)
}

fn module_path(modules: &[PModule], id: usize) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let mut cur = modules.iter().find(|m| m.id == id);
    while let Some(m) = cur {
        parts.insert(0, &m.name);
        cur = m.parent.and_then(|p| modules.iter().find(|x| x.id == p));
    }
    parts.join(".")
}

fn module_json(modules: &[PModule], m: &PModule, types: &[PType], consts: &[PConst]) -> Json {
    let mut o = serde_json::Map::new();
    o.insert("name".into(), json!(m.name));
    put_description(&mut o, &m.description);
    if !m.bases.is_empty() {
        o.insert(
            "bases".into(),
            Json::Array(m.bases.iter().map(|b| json!(module_path(modules, *b))).collect()),
        );
    }
    let own_types: Vec<Json> =
        types.iter().filter(|t| t.module == Some(m.id)).map(|t| type_json(&t.def)).collect();
    if !own_types.is_empty() {
        o.insert("types".into(), Json::Array(own_types));
    }
    let own_consts: Vec<Json> =
        consts.iter().filter(|c| c.module == Some(m.id)).map(|c| const_json(&c.def)).collect();
    if !own_consts.is_empty() {
        o.insert("constants".into(), Json::Array(own_consts));
    }
    if !m.attributes.is_empty() {
        let attrs = m
            .attributes
            .iter()
            .map(|a| {
                let mut k = serde_json::Map::new();
                k.insert("name".into(), json!(a.name));
                if a.readonly {
                    k.insert("const".into(), json!(true));
                }
                k.insert("type".into(), a.ty.clone());
                put_description(&mut k, &a.description);
                Json::Object(k)
            })
            .collect();
        o.insert("attributes".into(), Json::Array(attrs));
    }
    if !m.methods.is_empty() {
        o.insert("methods".into(), Json::Array(m.methods.iter().map(message_json).collect()));
    }
    let ports = m
        .ports
        .iter()
        .map(|p| {
            let mut k = serde_json::Map::new();
            k.insert("name".into(), json!(p.name));
            k.insert("role".into(), json!(p.role));
            k.insert("interface".into(), p.interface.as_ref().map_or(Json::Null, |i| json!(i)));
            put_description(&mut k, &p.description);
            Json::Object(k)
        })
        .collect();
    o.insert("ports".into(), Json::Array(ports));
    let children: Vec<Json> = modules
        .iter()
        .filter(|c| c.parent == Some(m.id))
        .map(|c| module_json(modules, c, types, consts))
        .collect();
    if !children.is_empty() {
        o.insert("modules".into(), Json::Array(children));
    }
    Json::Object(o)
}

/// The project file an IDL file stands for, to depend on it like on a project file: its
/// definitions, its components as modules (else its IDL modules serving their interfaces), and the
/// files it includes as its dependencies (`indirect` those it includes through others), their
/// definitions being theirs. `files`: the file (`path`) and those it may include, by path.
/// Returns the file, and what was left out or approximated.
pub fn idl_project(path: &str, files: &IndexMap<String, String>) -> Result<(Json, Vec<String>), String> {
    let all = normalize_files(files);
    let main = normalize_path(path);
    let Some(text) = all.get(&main) else { return Err(format!("{}: not read", base_name(&main))) };
    let parsed = parse_idl(text, &main, &all)?;
    let servers = interface_servers(&parsed, &main);
    let mut idl = parsed;
    idl.components.extend(servers.iter().map(|s| s.component.clone()));
    let mut imp = import_idl(&idl);

    // Included files, direct ones first.
    let mut reached: Vec<String> = Vec::new();
    let mut queue: VecDeque<String> = VecDeque::from([main.clone()]);
    while let Some(f) = queue.pop_front() {
        for g in idl.includes.get(&f).cloned().unwrap_or_default() {
            if g != main && !reached.contains(&g) {
                reached.push(g.clone());
                queue.push_back(g);
            }
        }
    }
    let direct = idl.includes.get(&main).cloned().unwrap_or_default();
    let mut deps: IndexMap<String, PDep> = IndexMap::new();
    for f in &reached {
        let taken: Vec<String> = deps.values().map(|d| d.name.clone()).collect();
        deps.insert(
            f.clone(),
            PDep {
                name: unique_name(&dependency_name(&stem(f)), &taken),
                file: relative_path(&main, f),
                uses: Vec::new(),
                indirect: !direct.contains(f),
            },
        );
    }
    let uses: Vec<(String, Vec<String>)> = deps
        .keys()
        .map(|f| {
            let u = idl
                .includes
                .get(f)
                .map(|l| l.iter().filter_map(|g| deps.get(g).map(|d| d.name.clone())).collect());
            (f.clone(), u.unwrap_or_default())
        })
        .collect();
    for (f, u) in uses {
        deps[&f].uses = u;
    }
    let dep_of = |name: &str| deps.get_index_of(idl.origins.get(name).map_or(main.as_str(), |s| s.as_str()));
    for t in &mut imp.types {
        t.dep = dep_of(t.def.name());
    }
    for i in &mut imp.interfaces {
        i.dep = dep_of(&i.def.name);
    }
    for c in &mut imp.consts {
        c.dep = dep_of(&c.def.name);
    }
    // Components of included files are modules of their own project.
    let ours: HashSet<&String> = servers.iter().map(|s| &s.component.name).collect();
    let theirs: HashSet<usize> = imp
        .modules
        .iter()
        .filter(|m| !ours.contains(&m.name) && dep_of(&m.name).is_some())
        .map(|m| m.id)
        .collect();
    if !theirs.is_empty() {
        imp.modules.retain(|m| !theirs.contains(&m.id));
        for m in &mut imp.modules {
            m.bases.retain(|b| !theirs.contains(b));
        }
    }
    let own_components: Vec<&IdlComponent> = idl
        .components
        .iter()
        .filter(|c| idl.origins.get(&c.name).map_or(main.as_str(), |s| s.as_str()) == main)
        .collect();
    let (module_ids, mut simply) = nest_servers(&mut imp.modules, &servers, &own_components);
    let old_names: Vec<String> = imp.types.iter().map(|t| t.def.name().to_string()).collect();
    simply.extend(scope_definitions(&mut imp.types, &mut imp.consts, &idl, &main, &module_ids));

    // References name types as the file writes them: `Core.Sensor.Mode` for a type of a module,
    // `Dep/Core.Sensor.Mode` for a type of a module of a dependency.
    let qualified: HashMap<String, String> = old_names
        .iter()
        .zip(&imp.types)
        .map(|(old, t)| {
            let name = t.def.name();
            let q = if let Some(m) = t.module {
                format!("{}.{name}", module_path(&imp.modules, m))
            } else if let (Some(mp), Some(d)) = (&t.module_path, t.dep) {
                format!("{}/{mp}.{name}", deps[d].name)
            } else {
                name.to_string()
            };
            (old.clone(), q)
        })
        .collect();
    let q = |n: &str| qualified.get(n).cloned().unwrap_or_else(|| n.to_string());
    let ty = |t: &Json| map_type_ref(t, &mut |n| q(n));
    let message = |m: &mut Message| {
        for p in &mut m.params {
            p.ty = ty(&p.ty);
        }
        m.returns = m.returns.as_ref().map(&ty);
        m.raises = m.raises.iter().map(|n| q(n)).collect();
    };
    for t in &mut imp.types {
        match &mut t.def {
            TypeDef::Struct { fields, .. } => fields.iter_mut().for_each(|f| f.ty = ty(&f.ty)),
            TypeDef::Union { discriminator, cases, .. } => {
                *discriminator = ty(discriminator);
                cases.iter_mut().for_each(|c| c.ty = ty(&c.ty));
            }
            TypeDef::Alias { ty: t, .. } => *t = ty(t),
            _ => {}
        }
    }
    for i in &mut imp.interfaces {
        i.def.messages.iter_mut().for_each(message);
    }
    for c in &mut imp.consts {
        c.def.ty = ty(&c.def.ty);
    }
    for m in &mut imp.modules {
        for a in &mut m.attributes {
            a.ty = ty(&a.ty);
        }
        m.methods.iter_mut().for_each(message);
    }

    let owned = |dep: Option<usize>| -> (Vec<Json>, Vec<Json>, Vec<Json>) {
        (
            imp.types
                .iter()
                .filter(|t| t.dep == dep && t.module.is_none() && t.module_path.is_none())
                .map(|t| type_json(&t.def))
                .collect(),
            imp.interfaces.iter().filter(|i| i.dep == dep).map(|i| iface_json(&i.def)).collect(),
            imp.consts
                .iter()
                .filter(|c| c.dep == dep && c.module.is_none() && c.module_path.is_none())
                .map(|c| const_json(&c.def))
                .collect(),
        )
    };
    let mut file = serde_json::Map::new();
    file.insert("schemaVersion".into(), json!(1));
    file.insert("project".into(), json!({"name": stem(&main)}));
    let (types, interfaces, constants) = owned(None);
    file.insert("types".into(), Json::Array(types));
    file.insert("interfaces".into(), Json::Array(interfaces));
    if !constants.is_empty() {
        file.insert("constants".into(), Json::Array(constants));
    }
    let roots: Vec<Json> = imp
        .modules
        .iter()
        .filter(|m| m.parent.is_none())
        .map(|m| module_json(&imp.modules, m, &imp.types, &imp.consts))
        .collect();
    file.insert("modules".into(), Json::Array(roots));
    file.insert("links".into(), Json::Array(Vec::new()));
    if !deps.is_empty() {
        let list = deps
            .values()
            .enumerate()
            .map(|(k, d)| {
                let mut o = serde_json::Map::new();
                o.insert("name".into(), json!(d.name));
                o.insert("file".into(), json!(d.file));
                if !d.uses.is_empty() {
                    o.insert("uses".into(), json!(d.uses));
                }
                if d.indirect {
                    o.insert("indirect".into(), json!(true));
                }
                let (t, i, c) = owned(Some(k));
                o.insert("types".into(), Json::Array(t));
                o.insert("interfaces".into(), Json::Array(i));
                if !c.is_empty() {
                    o.insert("constants".into(), Json::Array(c));
                }
                let mut type_groups: IndexMap<&str, Vec<Json>> = IndexMap::new();
                for t in imp.types.iter().filter(|t| t.dep == Some(k)) {
                    if let Some(mp) = &t.module_path {
                        type_groups.entry(mp).or_default().push(type_json(&t.def));
                    }
                }
                if !type_groups.is_empty() {
                    let groups = type_groups.into_iter().map(|(m, t)| json!({"module": m, "types": t}));
                    o.insert("moduleTypes".into(), Json::Array(groups.collect()));
                }
                let mut const_groups: IndexMap<&str, Vec<Json>> = IndexMap::new();
                for c in imp.consts.iter().filter(|c| c.dep == Some(k)) {
                    if let Some(mp) = &c.module_path {
                        const_groups.entry(mp).or_default().push(const_json(&c.def));
                    }
                }
                if !const_groups.is_empty() {
                    let groups = const_groups.into_iter().map(|(m, c)| json!({"module": m, "constants": c}));
                    o.insert("moduleConstants".into(), Json::Array(groups.collect()));
                }
                Json::Object(o)
            })
            .collect();
        file.insert("dependencies".into(), Json::Array(list));
    }
    // Renames the modules made needless.
    let mut warnings: Vec<String> = idl
        .warnings
        .iter()
        .filter(|w| w.find(" imported as ").is_none_or(|at| !simply.contains(&w[..at])))
        .cloned()
        .collect();
    warnings
        .extend(imp.unresolved.iter().map(|n| format!("{n} is defined in none of the files: added empty")));
    Ok((Json::Object(file), warnings))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(list: &[(&str, &str)]) -> IndexMap<String, String> {
        list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// The project file and warnings of a single IDL text.
    fn read(text: &str) -> (Json, Vec<String>) {
        idl_project("main.idl", &files(&[("main.idl", text)])).unwrap()
    }

    fn error(text: &str) -> String {
        idl_project("main.idl", &files(&[("main.idl", text)])).unwrap_err()
    }

    fn named<'a>(list: &'a Json, name: &str) -> &'a Json {
        list.as_array().unwrap().iter().find(|e| e["name"] == name).unwrap_or_else(|| panic!("no {name}"))
    }

    /// A type of the file, also among those of its modules (and their dependencies' modules).
    fn type_of<'a>(file: &'a Json, name: &str) -> &'a Json {
        fn find<'a>(list: &'a Json, name: &str, out: &mut Option<&'a Json>) {
            for m in list.as_array().into_iter().flatten() {
                for t in m["types"].as_array().into_iter().flatten() {
                    if t["name"] == name {
                        out.get_or_insert(t);
                    }
                }
                find(&m["modules"], name, out);
            }
        }
        let mut found = file["types"].as_array().unwrap().iter().find(|t| t["name"] == name);
        find(&file["modules"], name, &mut found);
        for d in file["dependencies"].as_array().into_iter().flatten() {
            for g in d["moduleTypes"].as_array().into_iter().flatten() {
                found = found.or_else(|| g["types"].as_array().unwrap().iter().find(|t| t["name"] == name));
            }
        }
        found.unwrap_or_else(|| panic!("no {name}"))
    }

    /// `name type` of the fields of a struct or exception.
    fn fields(file: &Json, name: &str) -> Vec<String> {
        type_of(file, name)["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| format!("{} {}", expr(&f["type"]), f["name"].as_str().unwrap()))
            .collect()
    }

    /// Type expression, as `printTypeExpr` prints it.
    fn expr(t: &Json) -> String {
        let bound = |t: &Json| t.get("max").map_or(String::new(), |m| format!(", {m}"));
        match t["kind"].as_str().unwrap() {
            "primitive" => match t.get("max") {
                Some(m) => format!("{}<{m}>", t["name"].as_str().unwrap()),
                None => t["name"].as_str().unwrap().to_string(),
            },
            // The module of a type is left out: `Core.Sensor.Mode` is `Mode`.
            "ref" => t["name"].as_str().unwrap().rsplit('.').next().unwrap().to_string(),
            "array" => format!("array<{}, {}>", expr(&t["of"]), t["size"]),
            "map" => format!("map<{}, {}{}>", expr(&t["key"]), expr(&t["value"]), bound(t)),
            "optional" => format!("optional<{}>", expr(&t["of"])),
            k => format!("{k}<{}{}>", expr(&t["of"]), bound(t)),
        }
    }

    fn alias(file: &Json, name: &str) -> String {
        expr(&type_of(file, name)["type"])
    }

    fn signatures(messages: &Json) -> Vec<String> {
        messages
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                let params: Vec<String> = m["params"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| {
                        format!(
                            "{} {} {}",
                            p["direction"].as_str().unwrap_or("in"),
                            expr(&p["type"]),
                            p["name"].as_str().unwrap()
                        )
                    })
                    .collect();
                let ret =
                    if m["returns"].is_null() { String::new() } else { format!(": {}", expr(&m["returns"])) };
                format!("{}({}){ret}", m["name"].as_str().unwrap(), params.join(", "))
            })
            .collect()
    }

    fn sig(file: &Json, name: &str) -> Vec<String> {
        signatures(&named(&file["interfaces"], name)["messages"])
    }

    const SRC: &str = r#"
#include "base.idl"
#pragma prefix "acme"

module Robot {
  const long AXES = 3;

  /** Position in meters. */
  struct Vec3 { double x, y, z; };

  enum Mode { IDLE, @value(10) RUN, STOP };
  const Mode START = RUN; // first mode
  const string NAME = "robot";

  typedef sequence<Vec3> Path;
  typedef double Matrix[AXES][AXES + 1];

  struct Pose : Vec3 {
    @optional float heading; // degrees
    string<16> frame;
  };

  enum Shape { CIRCLE, SQUARE, LINE };
  union Payload switch (long) { case 1: case 2: long a; default: string b; };
  union Figure switch (Shape) { case CIRCLE: double radius; case Shape::SQUARE: Vec3 side; };

  exception Busy { string reason; };

  module Control {
    // Motion commands.
    interface Motion {
      void move(in Path path, out boolean done) raises (Busy);
      Mode mode();
      oneway void stop();
      readonly attribute Pose pose raises (Busy);
      attribute unsigned long long speed;
      sequence<octet> dump(in map<string, Payload> items, inout ::Robot::Unknown u);
    };

    interface Arm : Motion { void grip(in long force); };
  };
};
"#;

    #[test]
    fn reads_types() {
        let (f, warnings) = read(SRC);
        assert_eq!(
            warnings,
            ["Line 2: base.idl not found", "Unknown is defined in none of the files: added empty"]
        );
        assert_eq!(f["project"]["name"], "main");
        assert_eq!(type_of(&f, "Vec3")["description"], "Position in meters.");
        assert_eq!(fields(&f, "Vec3"), ["float64 x", "float64 y", "float64 z"]);
        assert_eq!(
            type_of(&f, "Mode"),
            &json!({"kind": "enum", "name": "Mode", "underlying": "int32", "values": [
                {"name": "IDLE", "value": 0}, {"name": "RUN", "value": 10}, {"name": "STOP", "value": 11}]})
        );
        assert_eq!(alias(&f, "Path"), "vector<Vec3>");
        assert_eq!(alias(&f, "Matrix"), "array<array<float64, 4>, 3>");
        let pose = type_of(&f, "Pose")["fields"].as_array().unwrap();
        let pose: Vec<(String, String, Option<&str>)> = pose
            .iter()
            .map(|p| (p["name"].as_str().unwrap().to_string(), expr(&p["type"]), p["description"].as_str()))
            .collect();
        assert_eq!(pose[3], ("heading".to_string(), "optional<float32>".to_string(), Some("degrees")));
        assert_eq!(pose[4], ("frame".to_string(), "string<16>".to_string(), None));
        assert_eq!(
            type_of(&f, "Payload"),
            &json!({"kind": "union", "name": "Payload", "discriminator": {"kind": "primitive", "name": "int32"},
                "cases": [
                    {"name": "a", "type": {"kind": "primitive", "name": "int32"}, "labels": [1, 2]},
                    {"name": "b", "type": {"kind": "primitive", "name": "string"}, "default": true}]})
        );
        assert_eq!(type_of(&f, "Figure")["cases"][1]["labels"], json!(["SQUARE"]));
        assert_eq!(type_of(&f, "Busy")["kind"], "exception");
        assert_eq!(
            named(&f["modules"], "Robot")["constants"],
            json!([
                {"name": "AXES", "type": {"kind": "primitive", "name": "int32"}, "value": 3},
                {"name": "START", "description": "first mode", "type": {"kind": "ref", "name": "Robot.Mode"}, "value": "RUN"},
                {"name": "NAME", "type": {"kind": "primitive", "name": "string"}, "value": "robot"}
            ])
        );
    }

    #[test]
    fn reads_interfaces() {
        let (f, _) = read(SRC);
        let motion = named(&f["interfaces"], "Motion");
        assert_eq!(motion["description"], "Motion commands.");
        assert_eq!(
            sig(&f, "Motion"),
            [
                "move(in Path path, out bool done)",
                "mode(): Mode",
                "stop()",
                "get_pose(): Pose",
                "get_speed(): uint64",
                "set_speed(in uint64 speed)",
                "dump(in map<string, Payload> items, inout Unknown u): bytes"
            ]
        );
        assert_eq!(motion["messages"][0]["raises"], json!(["Robot.Busy"]));
        assert_eq!(motion["messages"][3]["raises"], json!(["Robot.Busy"]));
        let mut arm = sig(&f, "Motion");
        arm.push("grip(in int32 force)".into());
        assert_eq!(sig(&f, "Arm"), arm);
        // Names defined nowhere are added as primitives.
        assert_eq!(type_of(&f, "Unknown")["description"], "Not defined in the IDL files");
    }

    #[test]
    fn reports_syntax_errors_with_their_line_and_file() {
        assert_eq!(error("struct A {\n  long;\n};"), "Line 2: expected an identifier but found ';'");
        let all =
            files(&[("dir/main.idl", "#include \"bad.idl\""), ("dir/bad.idl", "\n\nstruct B { long };")]);
        let e = idl_project("dir/main.idl", &all).unwrap_err();
        assert!(e.starts_with("Line 3 of bad.idl"), "{e}");
        assert_eq!(error("#if 1\nstruct A { long x; };"), "main.idl: missing #endif");
        assert_eq!(error("#error unsupported"), "Line 1: #error unsupported");
        assert_eq!(idl_project("x.idl", &files(&[])).unwrap_err(), "x.idl: not read");
    }

    #[test]
    fn hostile_nesting_is_an_error() {
        let deep = |open: &str, close: &str, n: usize| (open.repeat(n), close.repeat(n));
        // Constants not computed are left out with a warning.
        let (o, c) = deep("(", ")", 100_000);
        assert_eq!(read(&format!("const long X = {o}1{c};")).1.len(), 1);
        assert_eq!(read(&format!("const long X = {}1;", "-".repeat(100_000))).1.len(), 1);
        let (o, c) = deep("module a { ", "}; ", 10_000);
        assert!(error(&format!("{o}{c}")).contains("levels deep"));
        let (o, c) = deep("sequence<", ">", 10_000);
        assert!(error(&format!("typedef {o}long{c} T;")).contains("levels deep"));
        // Macros doubling at each level.
        let mut src: String = (0..40).map(|i| format!("#define M{i} M{} M{}\n", i + 1, i + 1)).collect();
        src += "const long X = M0;\n";
        assert!(error(&src).contains("expands to more than"), "{}", error(&src));
        // Fine within the limits.
        let (o, c) = deep("(", ")", 20);
        read(&format!("const long X = {o}1{c};"));
    }

    #[test]
    fn evaluates_constant_expressions() {
        let (f, _) = read(
            r"
            const long N = (1 << 2) + 1;
            const unsigned long long BIG = 0xFFFFFFFFFFFFFFFF;
            const long OCT = 010;
            const boolean B = TRUE;
            typedef sequence<sequence<long>> S;
            typedef octet A[N * 2];
            typedef octet O[OCT];
            typedef octet R[(BIG >> 62) | 0x10];
            module M { const short K = 2; };
            typedef long Q[M :: K];
        ",
        );
        assert_eq!(alias(&f, "S"), "vector<vector<int32>>");
        assert_eq!(alias(&f, "A"), "array<uint8, 10>");
        assert_eq!(alias(&f, "O"), "array<uint8, 8>");
        assert_eq!(alias(&f, "R"), "array<uint8, 19>");
        assert_eq!(alias(&f, "Q"), "array<int32, 2>");
        assert_eq!(named(&f["constants"], "BIG")["value"], "18446744073709551615");
        assert_eq!(named(&f["constants"], "B")["value"], true);
    }

    #[test]
    fn preprocesses_macros_conditions_and_includes_once() {
        let all = files(&[
            (
                "idl/common/types.idl",
                "#ifndef TYPES_IDL\n#define TYPES_IDL\nmodule Common { struct Stamp { long long ns; }; };\n#endif",
            ),
            ("idl/robot/limits.idl", "#include \"../common/types.idl\"\nconst long LIMIT = 4;"),
            (
                "idl/robot/main.idl",
                r#"#include "limits.idl"
#include <common/types.idl>
#define SIZE (LIMIT * 2)
#define SEQ(T, N) sequence<T, N>
#define NAME(x) x ## _t
#define STR(x) #x
#if defined(SIZE) && !defined(NOPE) && (2 > 1 ? 1 : 0)
typedef SEQ(Common::Stamp, SIZE) Stamps;
#elif 1
typedef long Wrong;
#else
typedef long Wrong2;
#endif
#ifdef NOPE
garbage that is never read !
#endif
typedef long NAME(id);
const string S = STR(hello);
#undef SIZE
#ifndef SIZE
typedef long Undefined;
#endif
import "../common/types.idl";"#,
            ),
        ]);
        let (f, warnings) = idl_project("idl/robot/main.idl", &all).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(alias(&f, "Stamps"), "vector<Stamp, 8>");
        assert_eq!(alias(&f, "id_t"), "int32");
        assert_eq!(alias(&f, "Undefined"), "int32");
        let names: Vec<&str> =
            f["types"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(!names.contains(&"Wrong") && !names.contains(&"Wrong2"));
        // Included files are dependencies; the types of the included file are theirs.
        let deps = f["dependencies"].as_array().unwrap();
        assert_eq!(
            deps.iter().map(|d| d["file"].as_str().unwrap()).collect::<Vec<_>>(),
            ["limits.idl", "../common/types.idl"]
        );
        assert!(deps[1].get("indirect").is_none());
        assert_eq!(deps[1]["moduleTypes"][0]["module"], "Common");
        assert_eq!(deps[1]["moduleTypes"][0]["types"][0]["name"], "Stamp");
        assert_eq!(deps[0]["constants"][0]["name"], "LIMIT");
    }

    #[test]
    fn finds_includes_and_reads_them_with_the_host() {
        let disk: HashMap<&str, &str> = HashMap::from([
            ("/w/idl/main.idl", "#include \"inc/b.idl\"\n#include \"shared.idl\""),
            ("/w/idl/inc/b.idl", "struct B { long y; };"),
            ("/w/shared.idl", "struct S { long z; };"),
        ]);
        let read = |p: &str| disk.get(p).map(|s| s.to_string());
        let all = read_idl_includes("/w/idl/main.idl", disk["/w/idl/main.idl"], &read).unwrap();
        let mut keys: Vec<&String> = all.keys().collect();
        keys.sort();
        assert_eq!(keys, ["/w/idl/inc/b.idl", "/w/idl/main.idl", "/w/shared.idl"]);
        assert_eq!(all.keys().next().unwrap(), "/w/idl/main.idl");
        let (f, warnings) = idl_project("/w/idl/main.idl", &all).unwrap();
        assert!(warnings.is_empty());
        let deps = f["dependencies"].as_array().unwrap();
        assert_eq!(deps.iter().map(|d| d["name"].as_str().unwrap()).collect::<Vec<_>>(), ["b", "shared"]);
    }

    #[test]
    fn reads_an_idl_file_as_a_project_its_includes_as_dependencies() {
        let all = files(&[
            (
                "idl/main.idl",
                "#include \"inc/a.idl\"\nstruct M { A a; B b; };\ncomponent Main { provides IA ia; };",
            ),
            (
                "idl/inc/a.idl",
                "#include \"../b.idl\"\nstruct A { B b; };\ninterface IA { void go(); };\ncomponent Other {};",
            ),
            ("idl/b.idl", "struct B { long y; };\nconst long MAX = 3;"),
        ]);
        let (f, warnings) = idl_project("idl/main.idl", &all).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(f["project"]["name"], "main");
        let deps = f["dependencies"].as_array().unwrap();
        assert_eq!(
            deps[0],
            json!({"name": "a", "file": "inc/a.idl", "uses": ["b"],
            "types": [{"kind": "struct", "name": "A", "fields": [{"name": "b", "type": {"kind": "ref", "name": "B"}}]}],
            "interfaces": [{"name": "IA", "messages": [{"name": "go", "params": [], "returns": null}]}]})
        );
        assert_eq!(deps[1]["name"], "b");
        assert_eq!(deps[1]["indirect"], true);
        assert_eq!(deps[1]["constants"][0]["name"], "MAX");
        // Components of included files belong to their own project.
        let modules: Vec<&str> =
            f["modules"].as_array().unwrap().iter().map(|m| m["name"].as_str().unwrap()).collect();
        assert_eq!(modules, ["Main"]);
        assert_eq!(f["types"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn reads_idl_modules_of_a_file_without_components_as_servers() {
        let mut all = files(&[
            (
                "idl/main.idl",
                "#include \"a.idl\"\ninterface Top { void t(); };\nmodule A { module Ctl { interface Arm { void go(); }; interface gripper : Arm {}; }; };\nmodule B { module Ctl { interface Lamp { void on(); }; }; };",
            ),
            ("idl/a.idl", "module Other { interface Far { void f(); }; };"),
        ]);
        let (f, warnings) = idl_project("idl/main.idl", &all).unwrap();
        assert!(warnings.is_empty());
        fn paths(list: &Json, prefix: &str, out: &mut Vec<(String, Vec<String>)>) {
            for m in list.as_array().unwrap_or(&Vec::new()) {
                let path = if prefix.is_empty() {
                    m["name"].as_str().unwrap().to_string()
                } else {
                    format!("{prefix}.{}", m["name"].as_str().unwrap())
                };
                let ports = m["ports"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| {
                        format!(
                            "{} {} {}",
                            p["name"].as_str().unwrap(),
                            p["role"].as_str().unwrap(),
                            p["interface"].as_str().unwrap()
                        )
                    })
                    .collect();
                out.push((path.clone(), ports));
                paths(&m["modules"], &path, out);
            }
        }
        let mut got = Vec::new();
        paths(&f["modules"], "", &mut got);
        let want = |p: &str, ports: &[&str]| {
            (p.to_string(), ports.iter().map(|s| s.to_string()).collect::<Vec<_>>())
        };
        assert_eq!(
            got,
            [
                want("main", &["top in Top"]),
                want("A", &[]),
                want("A.Ctl", &["arm in Arm", "gripper in gripper"]),
                want("B", &[]),
                want("B.Ctl", &["lamp in Lamp"]),
            ]
        );
        // A file with components: only those.
        all.insert(
            "idl/main.idl".into(),
            "interface I { void go(); };\ncomponent C { provides I i; };".into(),
        );
        let (f, _) = idl_project("idl/main.idl", &all).unwrap();
        assert_eq!(f["modules"].as_array().unwrap().len(), 1);
        assert_eq!(f["modules"][0]["name"], "C");
    }

    #[test]
    fn resolves_scoped_names_and_qualifies_shared_names() {
        let (f, warnings) = read(
            r"
            module A { struct Status { long a; }; struct Use { Status s; }; };
            module B {
              struct Status { long b; };
              struct Use2 { Status s; ::A::Status t; A::Status u; };
              interface I { typedef long Local; Local get(); };
              interface J : I { Local again(); };
            };
            struct set { long x; };
        ",
        );
        let written = |name: &str| -> Vec<String> {
            let fields = type_of(&f, name)["fields"].as_array().unwrap();
            fields.iter().map(|x| x["type"]["name"].as_str().unwrap().to_string()).collect()
        };
        assert_eq!(written("Use"), ["A.Status"]);
        assert_eq!(written("Use2"), ["B.Status", "A.Status", "A.Status"]);
        assert_eq!(named(&f["modules"], "A")["types"][0]["name"], "Status");
        assert_eq!(sig(&f, "J"), ["get(): Local", "again(): Local"]);
        assert_eq!(type_of(&f, "set_")["kind"], "struct");
        // The modules make the qualified names needless.
        assert_eq!(warnings, ["set imported as set_"]);
    }

    #[test]
    fn imports_object_references_as_custom_primitives() {
        let (f, _) = read(
            r"
            interface Node;
            interface Tree { Node root(); any value(); Object raw(); };
            interface Node { Tree owner(); };
        ",
        );
        assert_eq!(sig(&f, "Tree"), ["root(): NodeRef", "value(): Any", "raw(): Object"]);
        assert_eq!(
            type_of(&f, "NodeRef"),
            &json!({"kind": "primitive", "name": "NodeRef", "description": "Reference to a Node object"})
        );
    }

    #[test]
    fn reads_annotations() {
        let (f, _) = read(
            r#"
            @annotation Units { string value; };
            @bit_bound(8) enum Small { @value(1) ONE, TWO };
            @bit_bound(16) bitmask Flags { A, @position(9) B };
            bitmask Big { A, @position(63) TOP };
            @final @topic
            struct S {
              @key @default(3) long count;
              @unit("m") @range(min=0, max=10.5) double length;
              @default(TWO) Small small;
              @verbatim(language="c++", text="x") @external @id(4) long other;
            };
        "#,
        );
        assert_eq!(type_of(&f, "Small")["underlying"], "uint8");
        assert_eq!(
            type_of(&f, "Small")["values"],
            json!([{"name": "ONE", "value": 1}, {"name": "TWO", "value": 2}])
        );
        assert_eq!(type_of(&f, "Flags")["underlying"], "uint16");
        assert_eq!(type_of(&f, "Flags")["flags"], json!([{"name": "A", "bit": 0}, {"name": "B", "bit": 9}]));
        assert_eq!(type_of(&f, "Big")["underlying"], "uint64");
        let s = type_of(&f, "S")["fields"].as_array().unwrap();
        assert_eq!(s[0]["default"], 3);
        assert_eq!(s[1]["description"], "Unit: m.\nRange: 0 to 10.5.");
        assert_eq!(s[2]["default"], "TWO");
        assert!(s[3].get("default").is_none() && s[3].get("description").is_none());
    }

    #[test]
    fn reads_valuetypes_eventtypes_bitsets_and_other_definitions() {
        let (f, warnings) = read(
            r#"
            typeprefix M "acme.com";
            native Handle;
            valuetype Name string;
            abstract valuetype Shape { double area(); };
            valuetype Base { public long id; };
            custom valuetype Circle : truncatable Base supports Shape {
              public double radius;
              private string secret;
              factory create(in double r);
              double area();
            };
            eventtype Alarm { public string text; };
            bitset Bits { bitfield<1> on; bitfield<3> level, mode; bitfield<2>; bitfield<12, short> big; };
            typedef struct Inner { long v; } InnerAlias;
            struct Outer { struct Nested { long n; } nested; enum Color { RED, GREEN } color; };
            typeid Base "IDL:Base:1.0";
            typedef fixed<10, 2> Money;
            typedef long double Precise;
        "#,
        );
        assert_eq!(type_of(&f, "Handle")["kind"], "primitive");
        assert_eq!(alias(&f, "Name"), "optional<string>");
        assert_eq!(sig(&f, "Shape"), ["area(): float64"]);
        assert_eq!(fields(&f, "Circle"), ["int32 id", "float64 radius", "string secret"]);
        assert_eq!(fields(&f, "Alarm"), ["string text"]);
        assert_eq!(fields(&f, "Bits"), ["bool on", "uint8 level", "uint8 mode", "int16 big"]);
        assert_eq!(alias(&f, "InnerAlias"), "Inner");
        assert_eq!(fields(&f, "Outer"), ["Nested nested", "Color color"]);
        assert_eq!(alias(&f, "Money"), "float64");
        assert_eq!(
            warnings,
            [
                "Line 7: valuetype Circle: 2 operations, factories or attributes left out",
                "Line 14: bitset Bits imported as a struct of its bitfields",
                "Line 18: fixed imported as float64",
                "Line 19: long double imported as float64"
            ]
        );
    }

    #[test]
    fn instantiates_template_modules() {
        let (f, _) = read(
            r"
            module Buffers<typename T, const long N> {
              struct Ring { T items[N]; long head; };
              interface Queue { void push(in T item); };
            };
            module Buffers<double, 8> Doubles;
            module Buffers<string, 2> Strings;
        ",
        );
        let ring = |module: &str| -> Vec<String> {
            let ring = &named(&f["modules"], module)["types"][0];
            assert_eq!(ring["name"], "Ring");
            ring["fields"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| format!("{} {}", expr(&x["type"]), x["name"].as_str().unwrap()))
                .collect()
        };
        assert_eq!(ring("Doubles"), ["array<float64, 8> items", "int32 head"]);
        assert_eq!(ring("Strings"), ["array<string, 2> items", "int32 head"]);
        assert_eq!(sig(&f, "Doubles_Queue"), ["push(in float64 item)"]);
    }

    #[test]
    fn imports_components_and_connectors_as_modules_with_ports() {
        let (f, warnings) = read(
            r"
            interface Pump { void start(); };
            interface Admin { void reset(); };
            eventtype Level { public double value; };
            porttype Control { provides Pump pump; uses Admin admin; attribute long rate; };
            component Device supports Admin {
              attribute string serial;
              readonly attribute long errors;
            };
            component Tank : Device {
              provides Pump inlet;
              uses multiple Pump outlets;
              publishes Level level;
              consumes Level alarm;
              port Control ctl;
              mirrorport Control back;
            };
            home TankHome manages Tank { factory build(in long size); };
            connector Wire { mirrorport Control a; };
        ",
        );
        assert_eq!(warnings, ["Line 18: home TankHome left out"]);
        let modules = &f["modules"];
        assert_eq!(
            modules.as_array().unwrap().iter().map(|m| m["name"].as_str().unwrap()).collect::<Vec<_>>(),
            ["Device", "Tank", "Wire"]
        );
        let tank = named(modules, "Tank");
        assert_eq!(tank["bases"], json!(["Device"]));
        let ports: Vec<String> = tank["ports"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                format!(
                    "{} {}: {}",
                    p["role"].as_str().unwrap(),
                    p["name"].as_str().unwrap(),
                    p["interface"].as_str().unwrap()
                )
            })
            .collect();
        assert_eq!(
            ports,
            [
                "in inlet: Pump",
                "out outlets: Pump",
                "out level: LevelConsumer",
                "in alarm: LevelConsumer",
                "in ctl_pump: Pump",
                "out ctl_admin: Admin",
                "out back_pump: Pump",
                "in back_admin: Admin"
            ]
        );
        assert_eq!(sig(&f, "LevelConsumer"), ["push(in Level event)"]);
        let device = named(modules, "Device");
        assert_eq!(signatures(&device["methods"]), ["reset()"]);
        assert_eq!(
            device["attributes"][1],
            json!({"name": "errors", "const": true, "type": {"kind": "primitive", "name": "int32"}})
        );
    }

    #[test]
    fn adds_empty_interfaces_for_ports_of_unknown_interfaces() {
        let (f, warnings) = read("component C { provides Missing m; uses Object o; };");
        assert_eq!(
            warnings,
            [
                "Missing is defined in none of the files: added empty",
                "Object is defined in none of the files: added empty"
            ]
        );
        let names: Vec<&str> =
            f["interfaces"].as_array().unwrap().iter().map(|i| i["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["Missing", "Object"]);
        assert_eq!(f["modules"][0]["ports"][0]["interface"], "Missing");
    }

    /// The project file and warnings of an IDL file, as JSON:
    /// `IDL_DUMP=x.idl cargo test dump_idl -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn dump_idl() {
        let Ok(path) = std::env::var("IDL_DUMP") else { return };
        let text = std::fs::read_to_string(&path).unwrap();
        let read = |p: &str| std::fs::read_to_string(p).ok();
        let files = read_idl_includes(&path, &text, &read).unwrap();
        let out = match idl_project(&path, &files) {
            Ok((file, warnings)) => json!({"file": file, "warnings": warnings}),
            Err(e) => json!({"error": e}),
        };
        println!("@@@{}", serde_json::to_string(&out).unwrap());
    }
}
