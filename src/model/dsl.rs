// Scaffold text syntax (`*.scaffold`): a compact, .proto-like form of the project file, read into the
// same data as YAML/JSON (then checked by the schema). Port of the reader of the editor's
// `src/model/dsl.ts` (`parseDsl`, `dslLineOfPath`): same grammar (viewer/docs/scaffold-text.md),
// same messages. The generator only reads it: no writer.
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value as Json};

use super::text::{Lines, Seg, js_number, js_object};

type Obj = Map<String, Json>;
type Path = Vec<Seg>;

/// A syntax error: message and line.
pub struct DslError {
    pub message: String,
    pub line: usize,
}

type Res<T> = Result<T, DslError>;

fn err<T>(message: impl Into<String>, line: usize) -> Res<T> {
    Err(DslError { message: message.into(), line })
}

// Lexer

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Ident,
    Str,
    Number,
    Punct,
    Doc,
    Eof,
}

#[derive(Clone, Debug)]
struct Tok {
    kind: Kind,
    /// Source text; a string's value, a doc comment's text, an escaped identifier's name.
    text: String,
    line: usize,
    start: usize,
    end: usize,
    escaped: bool,
}

static NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?").unwrap());
static UNSAFE_INT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-?[0-9]+$").unwrap());
static SYNTAX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^scaffold([1-9][0-9]*)$").unwrap());
const PUNCTS: [&str; 18] =
    ["<->", "->", "+=", "{", "}", "(", ")", "[", "]", "<", ">", ",", ";", ":", "=", ".", "/", "?"];

fn ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_'
}
fn ident_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn tok(kind: Kind, text: impl Into<String>, line: usize, start: usize, end: usize) -> Tok {
    Tok { kind, text: text.into(), line, start, end, escaped: false }
}

fn lex(text: &str) -> Res<Vec<Tok>> {
    let s = text.as_bytes();
    let n = s.len();
    let mut toks = vec![];
    let mut i = 0;
    let mut line = 1;
    while i < n {
        let c = s[i];
        if c == b'\n' {
            line += 1;
            i += 1;
            continue;
        }
        if matches!(c, b' ' | b'\t' | b'\r' | b'\x0c' | b'\x0b') {
            i += 1;
            continue;
        }
        if text[i..].starts_with('\u{feff}') {
            i += 3;
            continue;
        }
        if text[i..].starts_with("//") {
            let end = text[i..].find('\n').map_or(n, |k| i + k);
            if text[i..].starts_with("///") && s.get(i + 3) != Some(&b'/') {
                let mut doc = &text[i + 3..end];
                doc = doc.strip_suffix('\r').unwrap_or(doc);
                doc = doc.strip_prefix(' ').unwrap_or(doc);
                toks.push(tok(Kind::Doc, doc, line, i, end));
            }
            i = end;
            continue;
        }
        if text[i..].starts_with("/*") {
            let Some(k) = text[i + 2..].find("*/") else { return err("unterminated comment", line) };
            let end = i + 2 + k;
            line += text[i..end].bytes().filter(|&b| b == b'\n').count();
            i = end + 2;
            continue;
        }
        if ident_start(c) {
            let mut j = i + 1;
            while j < n && ident_char(s[j]) {
                j += 1;
            }
            toks.push(tok(Kind::Ident, &text[i..j], line, i, j));
            i = j;
            continue;
        }
        if c == b'`' {
            let mut j = i + 1;
            while j < n && ident_char(s[j]) {
                j += 1;
            }
            if s.get(j) != Some(&b'`') || !s.get(i + 1).is_some_and(|&b| ident_start(b)) {
                return err("invalid `name`", line);
            }
            let mut t = tok(Kind::Ident, &text[i + 1..j], line, i, j + 1);
            t.escaped = true;
            toks.push(t);
            i = j + 1;
            continue;
        }
        if c == b'"' {
            let mut j = i + 1;
            while j < n && s[j] != b'"' {
                if s[j] == b'\n' {
                    return err("unterminated string", line);
                }
                j += if s[j] == b'\\' { 2 } else { 1 };
            }
            if j >= n {
                return err("unterminated string", line);
            }
            let Ok(value) = serde_json::from_str::<String>(&text[i..=j]) else {
                return err("invalid string", line);
            };
            toks.push(tok(Kind::Str, value, line, i, j + 1));
            i = j + 1;
            continue;
        }
        if (c == b'-' || c.is_ascii_digit())
            && let Some(m) = NUMBER.find(&text[i..])
        {
            let j = i + m.end();
            if j < n && (ident_char(s[j]) || s[j] == b'.') {
                let next = text[j..].chars().next().map_or(0, char::len_utf8);
                return err(format!("invalid number '{}'", &text[i..j + next]), line);
            }
            toks.push(tok(Kind::Number, m.as_str(), line, i, j));
            i = j;
            continue;
        }
        let Some(p) = PUNCTS.iter().find(|p| text[i..].starts_with(**p)) else {
            let ch = text[i..].chars().next().unwrap_or('?');
            return err(format!("unexpected character '{ch}'"), line);
        };
        toks.push(tok(Kind::Punct, *p, line, i, i + p.len()));
        i += p.len();
    }
    toks.push(tok(Kind::Eof, "", line, n, n));
    Ok(toks)
}

fn describe(t: &Tok) -> String {
    match t.kind {
        Kind::Eof => "end of file".into(),
        Kind::Str => serde_json::to_string(&t.text).unwrap_or_default(),
        Kind::Doc => "a documentation comment".into(),
        _ if t.escaped => format!("`{}`", t.text),
        _ => format!("'{}'", t.text),
    }
}

// Parser

const PRIMITIVES: [&str; 14] = [
    "bool", "char", "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64", "float32",
    "float64", "string", "bytes",
];
const TYPEDEFS: [&str; 7] = ["struct", "exception", "enum", "bitmask", "union", "alias", "primitive"];
const ACCESS: [&str; 3] = ["public", "protected", "private"];
const KINDS: [&str; 3] = ["class", "abstract", "interface"];
const FLAGS: [&str; 12] = [
    "static",
    "const",
    "mutable",
    "atomic",
    "virtual",
    "pure",
    "override",
    "final",
    "threadSafe",
    "noexcept",
    "nodiscard",
    "explicit",
];
const ATTRIBUTE_MODS: [&str; 7] = ["public", "protected", "private", "static", "const", "mutable", "atomic"];
const METHOD_MODS: [&str; 12] = [
    "public",
    "protected",
    "private",
    "static",
    "const",
    "virtual",
    "pure",
    "override",
    "final",
    "threadSafe",
    "noexcept",
    "nodiscard",
];
const MODULE_MODS: [&str; 4] = ["class", "abstract", "interface", "final"];
const PERF: [&str; 4] = ["realtime", "low", "normal", "bulk"];
const CLAUSES: [&str; 8] = ["ack", "latency", "rate", "remote", "realtime", "low", "normal", "bulk"];

static MODIFIERS: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| ACCESS.iter().chain(KINDS.iter()).chain(FLAGS.iter()).copied().collect());

#[derive(Clone, Copy, PartialEq)]
enum Ctx {
    Top,
    Dependency,
    Module,
    Fields,
    Union,
    Interface,
    StateMachine,
}

struct DocC {
    text: String,
    line: usize,
}
struct Mod {
    word: String,
    line: usize,
}

fn key(path: &[Seg]) -> String {
    path.iter()
        .map(|s| match s {
            Seg::Key(k) => k.clone(),
            Seg::Idx(i) => i.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\u{1}")
}

fn with(path: &[Seg], s: impl Into<Seg>) -> Path {
    let mut p = path.to_vec();
    p.push(s.into());
    p
}

fn s(v: &str) -> Json {
    Json::String(v.into())
}

struct Parser<'t> {
    text: &'t str,
    toks: Vec<Tok>,
    i: usize,
    lines: HashMap<String, usize>,
}

impl<'t> Parser<'t> {
    fn new(text: &'t str) -> Res<Self> {
        Ok(Parser { text, toks: lex(text)?, i: 0, lines: HashMap::new() })
    }

    // Tokens

    fn peek(&self, k: usize) -> &Tok {
        &self.toks[(self.i + k).min(self.toks.len() - 1)]
    }
    fn next(&mut self) -> Tok {
        let t = self.peek(0).clone();
        if t.kind != Kind::Eof {
            self.i += 1;
        }
        t
    }
    fn is_p(&self, p: &str, k: usize) -> bool {
        let t = self.peek(k);
        t.kind == Kind::Punct && t.text == p
    }
    fn is_kw(&self, w: &str, k: usize) -> bool {
        let t = self.peek(k);
        t.kind == Kind::Ident && !t.escaped && t.text == w
    }
    fn is_word_in(&self, words: &[&str]) -> bool {
        let t = self.peek(0);
        t.kind == Kind::Ident && !t.escaped && words.contains(&t.text.as_str())
    }
    fn accept(&mut self, p: &str) -> bool {
        if !self.is_p(p, 0) {
            return false;
        }
        self.next();
        true
    }
    fn expect(&mut self, p: &str) -> Res<()> {
        if self.accept(p) { Ok(()) } else { self.fail(&format!("'{p}'")) }
    }
    fn expect_kw(&mut self, w: &str) -> Res<()> {
        if !self.is_kw(w, 0) {
            return self.fail(&format!("'{w}'"));
        }
        self.next();
        Ok(())
    }
    fn fail<T>(&self, what: &str) -> Res<T> {
        let t = self.peek(0);
        err(format!("expected {what}, found {}", describe(t)), t.line)
    }
    fn ident(&mut self, what: &str) -> Res<String> {
        if self.peek(0).kind != Kind::Ident {
            return self.fail(what);
        }
        Ok(self.next().text)
    }
    fn name(&mut self) -> Res<String> {
        self.ident("a name")
    }
    fn string(&mut self, what: &str) -> Res<Tok> {
        if self.peek(0).kind != Kind::Str {
            return self.fail(what);
        }
        Ok(self.next())
    }
    fn rec(&mut self, path: &[Seg], line: usize) {
        self.lines.entry(key(path)).or_insert(line);
    }
    fn at_end(&self, closer: Option<&str>) -> bool {
        match closer {
            None => self.peek(0).kind == Kind::Eof,
            Some(c) => self.is_p(c, 0),
        }
    }

    fn docs(&mut self) -> Option<DocC> {
        if self.peek(0).kind != Kind::Doc {
            return None;
        }
        let line = self.peek(0).line;
        let mut parts = vec![];
        while self.peek(0).kind == Kind::Doc {
            parts.push(self.next().text);
        }
        Some(DocC { text: parts.join("\n"), line })
    }
    fn no_doc(&self, doc: &Option<DocC>) -> Res<()> {
        match doc {
            Some(d) => err("documentation comment documents nothing", d.line),
            None => Ok(()),
        }
    }
    fn describe(&mut self, o: &mut Obj, path: &[Seg], doc: &Option<DocC>) {
        if let Some(d) = doc {
            o.insert("description".into(), s(&d.text));
            self.rec(&with(path, "description"), d.line);
        }
    }

    // Values

    fn number(&mut self) -> Res<Json> {
        if self.peek(0).kind != Kind::Number {
            return self.fail("a number");
        }
        let t = self.next();
        let v: f64 = t.text.parse().unwrap_or(f64::NAN);
        Ok(if UNSAFE_INT.is_match(&t.text) && !(v.fract() == 0.0 && v.abs() <= 9007199254740991.0) {
            Json::String(t.text)
        } else {
            js_number(v)
        })
    }

    /// `a.b.c`
    fn dotted(&mut self, what: &str) -> Res<String> {
        let mut r = self.ident(what)?;
        while self.is_p(".", 0) && self.peek(1).kind == Kind::Ident {
            self.next();
            r.push('.');
            r.push_str(&self.next().text);
        }
        Ok(r)
    }

    /// `Dependency/A.B.C`
    fn qualified(&mut self, what: &str) -> Res<String> {
        let mut r = self.ident(what)?;
        if self.accept("/") {
            r.push('/');
            r.push_str(&self.ident(what)?);
        }
        while self.accept(".") {
            r.push('.');
            r.push_str(&self.ident(what)?);
        }
        Ok(r)
    }

    fn value(&mut self, path: &[Seg]) -> Res<Json> {
        let t = self.peek(0).clone();
        self.rec(path, t.line);
        if self.accept("{") {
            let mut o = Obj::new();
            while !self.accept("}") {
                let k = self.peek(0).clone();
                let key = match k.kind {
                    Kind::Str | Kind::Number => self.next().text,
                    Kind::Ident => self.dotted("a key")?,
                    _ => return self.fail("a key"),
                };
                self.expect(":")?;
                let p = with(path, key.as_str());
                self.rec(&p, k.line);
                let v = self.value(&p)?;
                o.insert(key, v);
                if !self.accept(",") {
                    self.expect("}")?;
                    break;
                }
            }
            return Ok(Json::Object(o));
        }
        if self.accept("[") {
            let mut a = vec![];
            while !self.accept("]") {
                a.push(self.value(&with(path, a.len()))?);
                if !self.accept(",") {
                    self.expect("]")?;
                    break;
                }
            }
            return Ok(Json::Array(a));
        }
        match t.kind {
            Kind::Str => Ok(Json::String(self.next().text)),
            Kind::Number => self.number(),
            Kind::Ident => {
                if !t.escaped && matches!(t.text.as_str(), "true" | "false" | "null") {
                    self.next();
                    return Ok(match t.text.as_str() {
                        "null" => Json::Null,
                        w => Json::Bool(w == "true"),
                    });
                }
                Ok(Json::String(self.dotted("a value")?))
            }
            _ => self.fail("a value"),
        }
    }

    /// `[key = value, …]`: properties of `o`.
    fn options(&mut self, o: &mut Obj, path: &[Seg]) -> Res<()> {
        if !self.accept("[") {
            return Ok(());
        }
        while !self.accept("]") {
            let line = self.peek(0).line;
            let key = self.ident("a property name")?;
            self.expect("=")?;
            let p = with(path, key.as_str());
            self.rec(&p, line);
            let v = self.value(&p)?;
            o.insert(key, v);
            if !self.accept(",") {
                self.expect("]")?;
                break;
            }
        }
        Ok(())
    }

    fn is_generic(&self) -> bool {
        self.peek(0).kind == Kind::Ident && (self.is_p("=", 1) || self.is_p("+=", 1))
    }

    /// `key = value;` or `key += item;`
    fn generic(&mut self, o: &mut Obj, path: &[Seg]) -> Res<()> {
        let line = self.peek(0).line;
        let key = self.next().text;
        let append = self.next().text == "+=";
        if append {
            let n = self.list(o, &key, path, line)?;
            let v = self.value(&with(&with(path, key.as_str()), n))?;
            push_to(o, &key, v);
        } else {
            let p = with(path, key.as_str());
            self.rec(&p, line);
            let v = self.value(&p)?;
            o.insert(key, v);
        }
        self.expect(";")
    }

    /// Length of the list `key` of `o`, created when absent.
    fn list(&mut self, o: &mut Obj, key: &str, path: &[Seg], line: usize) -> Res<usize> {
        let l = o.entry(key.to_string()).or_insert_with(|| Json::Array(vec![]));
        let Json::Array(a) = l else { return err(format!("'{key}' is not a list"), line) };
        let n = a.len();
        self.rec(&with(path, key), line);
        Ok(n)
    }

    /// Appends the item `make` builds at its path.
    fn push(
        &mut self,
        o: &mut Obj,
        key: &str,
        path: &[Seg],
        make: impl FnOnce(&mut Self, &[Seg]) -> Res<Json>,
    ) -> Res<()> {
        let line = self.peek(0).line;
        let n = self.list(o, key, path, line)?;
        let p = with(&with(path, key), n);
        self.rec(&p, line);
        let v = make(self, &p)?;
        push_to(o, key, v);
        Ok(())
    }

    // Types

    fn typ(&mut self, path: &[Seg]) -> Res<Json> {
        let t = self.peek(0).clone();
        self.rec(path, t.line);
        if t.kind != Kind::Ident {
            return self.fail("a type");
        }
        if !t.escaped && PRIMITIVES.contains(&t.text.as_str()) {
            self.next();
            let mut r = obj([("kind", s("primitive")), ("name", s(&t.text))]);
            if self.accept("(") {
                r.insert("max".into(), self.number()?);
                self.expect(")")?;
            }
            return Ok(Json::Object(r));
        }
        let kind = t.text.as_str();
        if !t.escaped
            && self.is_p("<", 1)
            && matches!(kind, "vector" | "list" | "set" | "array" | "optional" | "map")
        {
            self.next();
            self.next();
            let mut r;
            if kind == "map" {
                let k = self.typ(&with(path, "key"))?;
                self.expect(",")?;
                let v = self.typ(&with(path, "value"))?;
                r = obj([("kind", s(kind)), ("key", k), ("value", v)]);
                if self.accept(",") {
                    r.insert("max".into(), self.number()?);
                }
            } else {
                let of = self.typ(&with(path, "of"))?;
                r = obj([("kind", s(kind)), ("of", of)]);
                if kind == "array" {
                    self.expect(",")?;
                    r.insert("size".into(), self.number()?);
                } else if kind != "optional" && self.accept(",") {
                    r.insert("max".into(), self.number()?);
                }
            }
            self.expect(">")?;
            return Ok(Json::Object(r));
        }
        let mut r = obj([("kind", s("ref")), ("name", s(&self.qualified("a type")?))]);
        if self.accept("<") {
            let mut args = vec![];
            loop {
                args.push(self.typ(&with(&with(path, "args"), args.len()))?);
                if !self.accept(",") {
                    break;
                }
            }
            self.expect(">")?;
            r.insert("args".into(), Json::Array(args));
        }
        Ok(Json::Object(r))
    }

    /// A result type: `void` (none) or a type.
    fn returns(&mut self, path: &[Seg]) -> Res<Json> {
        if self.is_kw("void", 0) {
            let line = self.next().line;
            self.rec(path, line);
            return Ok(Json::Null);
        }
        self.typ(path)
    }

    // Modifiers

    fn mods(&mut self) -> Vec<Mod> {
        let mut out = vec![];
        loop {
            let t = self.peek(0);
            if !(t.kind == Kind::Ident
                && !t.escaped
                && MODIFIERS.contains(t.text.as_str())
                && !self.is_p("=", 1)
                && !self.is_p("+=", 1))
            {
                break;
            }
            let t = self.next();
            out.push(Mod { word: t.text, line: t.line });
        }
        out
    }

    fn apply_mods(&self, o: &mut Obj, mods: &[Mod], allowed: &[&str], what: &str) -> Res<()> {
        for m in mods {
            let w = m.word.as_str();
            if !allowed.contains(&w) {
                return err(format!("'{w}' does not apply to {what}"), m.line);
            }
            if ACCESS.contains(&w) {
                o.insert("access".into(), s(w));
            } else if KINDS.contains(&w) {
                o.insert("kind".into(), s(w));
            } else {
                o.insert(w.into(), Json::Bool(true));
            }
        }
        Ok(())
    }

    // Files

    fn file(&mut self) -> Res<Json> {
        let mut f = Obj::new();
        let line = self.peek(0).line;
        self.rec(&[], line);
        self.body(Ctx::Top, &mut f, &[], None)?;
        for k in ["types", "interfaces", "modules", "links"] {
            f.entry(k).or_insert_with(|| Json::Array(vec![]));
        }
        Ok(Json::Object(f))
    }

    /// Statements of a body, until its closer.
    fn body(&mut self, ctx: Ctx, o: &mut Obj, path: &[Seg], closer: Option<&str>) -> Res<()> {
        while !self.at_end(closer) {
            if self.peek(0).kind == Kind::Eof {
                return self.fail("'}'");
            }
            let doc = self.docs();
            if self.at_end(closer) {
                self.no_doc(&doc)?;
            } else if self.is_generic() {
                self.no_doc(&doc)?;
                if ctx == Ctx::Top && self.is_kw("syntax", 0) {
                    self.syntax(o)?;
                } else {
                    self.generic(o, path)?;
                }
            } else {
                self.statement(ctx, o, path, doc)?;
            }
        }
        if let Some(c) = closer {
            self.expect(c)?;
        }
        Ok(())
    }

    fn syntax(&mut self, f: &mut Obj) -> Res<()> {
        let line = self.next().line;
        self.next();
        let t = self.string("\"scaffold1\"")?;
        let Some(m) = SYNTAX.captures(&t.text) else {
            return err(
                format!("unknown syntax {}", serde_json::to_string(&t.text).unwrap_or_default()),
                t.line,
            );
        };
        self.rec(&[Seg::Key("schemaVersion".into())], line);
        f.insert("schemaVersion".into(), js_number(m[1].parse::<f64>().unwrap_or(f64::NAN)));
        self.expect(";")
    }

    fn statement(&mut self, ctx: Ctx, o: &mut Obj, path: &[Seg], doc: Option<DocC>) -> Res<()> {
        match ctx {
            Ctx::Top => self.top_statement(o, path, doc),
            Ctx::Dependency => self.dependency_statement(o, path, doc),
            Ctx::Module => self.module_statement(o, path, doc),
            Ctx::Fields => self.push(o, "fields", path, |p, ip| p.field(ip, &doc)),
            Ctx::Union => self.push(o, "cases", path, |p, ip| p.union_case(ip, &doc)),
            Ctx::Interface => self.push(o, "messages", path, |p, ip| p.message(ip, &doc, &[], false)),
            Ctx::StateMachine => self.state_statement(o, path, doc),
        }
    }

    fn is_typedef(&self) -> bool {
        self.is_word_in(&TYPEDEFS)
    }

    fn top_statement(&mut self, f: &mut Obj, path: &[Seg], doc: Option<DocC>) -> Res<()> {
        if self.is_kw("project", 0) {
            let line = self.peek(0).line;
            let p = with(path, "project");
            self.rec(&p, line);
            let v = self.project(&p, &doc)?;
            f.insert("project".into(), v);
            Ok(())
        } else if self.is_kw("binary", 0) {
            self.push(f, "binaries", path, |p, ip| p.binary(ip, &doc))
        } else if self.is_kw("const", 0) {
            self.push(f, "constants", path, |p, ip| p.constant(ip, &doc))
        } else if self.is_kw("link", 0) {
            self.push(f, "links", path, |p, ip| p.link(ip, &doc))
        } else if self.is_kw("dependency", 0) {
            self.push(f, "dependencies", path, |p, ip| p.dependency(ip, &doc))
        } else if self.is_typedef() {
            self.push(f, "types", path, |p, ip| p.typedef(ip, &doc, &[]))
        } else if self.is_kw("interface", 0)
            && !self.is_kw("module", 1)
            && !MODIFIERS.contains(self.peek(1).text.as_str())
        {
            self.push(f, "interfaces", path, |p, ip| p.iface(ip, &doc))
        } else {
            let mods = self.mods();
            if !self.is_kw("module", 0) {
                return self.fail("a definition");
            }
            self.push(f, "modules", path, |p, ip| p.module(ip, &doc, &mods))
        }
    }

    fn dependency_statement(&mut self, d: &mut Obj, path: &[Seg], doc: Option<DocC>) -> Res<()> {
        if self.is_kw("const", 0) {
            self.push(d, "constants", path, |p, ip| p.constant(ip, &doc))
        } else if self.is_kw("interface", 0) {
            self.push(d, "interfaces", path, |p, ip| p.iface(ip, &doc))
        } else if self.is_typedef() {
            self.push(d, "types", path, |p, ip| p.typedef(ip, &doc, &[]))
        } else {
            self.fail("a type, an interface, a constant or a property")
        }
    }

    fn project(&mut self, path: &[Seg], doc: &Option<DocC>) -> Res<Json> {
        self.expect_kw("project")?;
        let t = self.string("the project name, as a string")?;
        let mut o = obj([("name", s(&t.text))]);
        self.rec(&with(path, "name"), t.line);
        self.describe(&mut o, path, doc);
        self.options(&mut o, path)?;
        self.expect(";")?;
        Ok(Json::Object(o))
    }

    fn binary(&mut self, path: &[Seg], doc: &Option<DocC>) -> Res<Json> {
        self.expect_kw("binary")?;
        let mut o = obj([("name", s(&self.name()?))]);
        self.describe(&mut o, path, doc);
        self.options(&mut o, path)?;
        self.expect(";")?;
        Ok(Json::Object(o))
    }

    fn constant(&mut self, path: &[Seg], doc: &Option<DocC>) -> Res<Json> {
        self.expect_kw("const")?;
        let t = self.typ(&with(path, "type"))?;
        let mut o = obj([("name", s(&self.name()?))]);
        self.describe(&mut o, path, doc);
        o.insert("type".into(), t);
        self.expect("=")?;
        let v = self.value(&with(path, "value"))?;
        o.insert("value".into(), v);
        self.options(&mut o, path)?;
        self.expect(";")?;
        Ok(Json::Object(o))
    }

    fn dependency(&mut self, path: &[Seg], doc: &Option<DocC>) -> Res<Json> {
        self.expect_kw("dependency")?;
        let mut o = obj([("name", s(&self.name()?))]);
        self.no_doc(doc)?;
        let t = self.string("the file of the dependency, as a string")?;
        o.insert("file".into(), Json::String(t.text));
        self.options(&mut o, path)?;
        if !self.accept(";") {
            self.expect("{")?;
            self.body(Ctx::Dependency, &mut o, path, Some("}"))?;
        }
        for k in ["types", "interfaces"] {
            o.entry(k).or_insert_with(|| Json::Array(vec![]));
        }
        Ok(Json::Object(o))
    }

    fn typedef(&mut self, path: &[Seg], doc: &Option<DocC>, mods: &[Mod]) -> Res<Json> {
        let kind = self.next().text;
        let mut o = obj([("kind", s(&kind))]);
        self.apply_mods(&mut o, mods, &ACCESS, "a type")?;
        o.insert("name".into(), s(&self.name()?));
        self.describe(&mut o, path, doc);
        match kind.as_str() {
            "struct" | "exception" => {
                self.options(&mut o, path)?;
                self.expect("{")?;
                self.body(Ctx::Fields, &mut o, path, Some("}"))?;
                o.entry("fields").or_insert_with(|| Json::Array(vec![]));
            }
            "enum" | "bitmask" => {
                self.expect(":")?;
                o.insert("underlying".into(), s(&self.ident("an integer type")?));
                self.options(&mut o, path)?;
                let key = if kind == "enum" { "values" } else { "flags" };
                let line = self.peek(0).line;
                self.list(&mut o, key, path, line)?;
                self.expect("{")?;
                while !self.accept("}") {
                    let d = self.docs();
                    self.no_doc(&d)?;
                    if self.accept("}") {
                        break;
                    }
                    let is_enum = kind == "enum";
                    self.push(&mut o, key, path, |p, ip| {
                        let mut v = obj([("name", s(&p.name()?))]);
                        p.expect("=")?;
                        let line = p.peek(0).line;
                        p.rec(&with(ip, if is_enum { "value" } else { "bit" }), line);
                        if is_enum {
                            v.insert("value".into(), p.number()?);
                        } else {
                            let one = p.peek(0);
                            if one.kind != Kind::Number || one.text != "1" {
                                return p.fail("'1 << bit'");
                            }
                            p.next();
                            p.expect("<")?;
                            p.expect("<")?;
                            v.insert("bit".into(), p.number()?);
                        }
                        p.expect(";")?;
                        Ok(Json::Object(v))
                    })?;
                }
            }
            "union" => {
                self.expect_kw("switch")?;
                self.expect("(")?;
                let d = self.typ(&with(path, "discriminator"))?;
                o.insert("discriminator".into(), d);
                self.expect(")")?;
                self.options(&mut o, path)?;
                self.expect("{")?;
                self.body(Ctx::Union, &mut o, path, Some("}"))?;
                o.entry("cases").or_insert_with(|| Json::Array(vec![]));
            }
            "alias" => {
                self.expect("=")?;
                let t = self.typ(&with(path, "type"))?;
                o.insert("type".into(), t);
                self.options(&mut o, path)?;
                self.expect(";")?;
            }
            _ => {
                self.options(&mut o, path)?;
                self.expect(";")?;
            }
        }
        Ok(Json::Object(o))
    }

    /// `Type name [= value] [options];`
    fn field_obj(&mut self, path: &[Seg], doc: &Option<DocC>) -> Res<Obj> {
        let t = self.typ(&with(path, "type"))?;
        let mut o = obj([("name", s(&self.name()?))]);
        o.insert("type".into(), t);
        self.describe(&mut o, path, doc);
        if self.accept("=") {
            let v = self.value(&with(path, "default"))?;
            o.insert("default".into(), v);
        }
        self.options(&mut o, path)?;
        self.expect(";")?;
        Ok(o)
    }

    fn field(&mut self, path: &[Seg], doc: &Option<DocC>) -> Res<Json> {
        Ok(Json::Object(self.field_obj(path, doc)?))
    }

    fn union_case(&mut self, path: &[Seg], doc: &Option<DocC>) -> Res<Json> {
        self.expect_kw("case")?;
        let mut labels = vec![];
        let mut is_default = false;
        while !self.is_p(":", 0) {
            if self.is_kw("default", 0) {
                self.next();
                is_default = true;
            } else {
                labels.push(self.value(&with(&with(path, "labels"), labels.len()))?);
            }
            if !self.accept(",") {
                break;
            }
        }
        self.expect(":")?;
        let t = self.typ(&with(path, "type"))?;
        let mut o = obj([("name", s(&self.name()?))]);
        o.insert("type".into(), t);
        self.describe(&mut o, path, doc);
        if !labels.is_empty() {
            o.insert("labels".into(), Json::Array(labels));
        }
        if is_default {
            o.insert("default".into(), Json::Bool(true));
        }
        self.options(&mut o, path)?;
        self.expect(";")?;
        Ok(Json::Object(o))
    }

    fn iface(&mut self, path: &[Seg], doc: &Option<DocC>) -> Res<Json> {
        self.expect_kw("interface")?;
        let mut o = obj([("name", s(&self.name()?))]);
        self.describe(&mut o, path, doc);
        self.options(&mut o, path)?;
        self.expect("{")?;
        self.body(Ctx::Interface, &mut o, path, Some("}"))?;
        o.entry("messages").or_insert_with(|| Json::Array(vec![]));
        Ok(Json::Object(o))
    }

    /// `Ret name(params) [raises (…)] [options];`: a message, or a method (`method`).
    fn message(&mut self, path: &[Seg], doc: &Option<DocC>, mods: &[Mod], method: bool) -> Res<Json> {
        let returns = self.returns(&with(path, "returns"))?;
        let mut o = obj([("name", s(&self.name()?))]);
        self.describe(&mut o, path, doc);
        if method {
            self.apply_mods(&mut o, mods, &METHOD_MODS, "a method")?;
        }
        let ps = self.params(&with(path, "params"))?;
        o.insert("params".into(), ps);
        o.insert("returns".into(), returns);
        if self.is_kw("raises", 0) {
            self.next();
            let line = self.peek(0).line;
            self.rec(&with(path, "raises"), line);
            let mut raises = vec![];
            self.expect("(")?;
            while !self.accept(")") {
                raises.push(Json::String(self.qualified("an exception")?));
                if !self.accept(",") {
                    self.expect(")")?;
                    break;
                }
            }
            o.insert("raises".into(), Json::Array(raises));
        }
        self.options(&mut o, path)?;
        self.expect(";")?;
        Ok(Json::Object(o))
    }

    fn params(&mut self, path: &[Seg]) -> Res<Json> {
        let line = self.peek(0).line;
        self.rec(path, line);
        self.expect("(")?;
        let mut out = vec![];
        while !self.is_p(")", 0) {
            let doc = self.docs();
            let p = with(path, out.len());
            let line = self.peek(0).line;
            self.rec(&p, line);
            let mut direction = None;
            let mut is_const = false;
            while self.peek(0).kind == Kind::Ident && !self.peek(0).escaped {
                match self.peek(0).text.as_str() {
                    w @ ("in" | "out" | "inout") => direction = Some(w.to_string()),
                    "const" => is_const = true,
                    _ => break,
                }
                self.next();
            }
            let t = self.typ(&with(&p, "type"))?;
            let mut o = obj([("name", s(&self.name()?))]);
            o.insert("type".into(), t);
            self.describe(&mut o, &p, &doc);
            if let Some(d) = direction {
                o.insert("direction".into(), Json::String(d));
            }
            if is_const {
                o.insert("const".into(), Json::Bool(true));
            }
            if self.accept("=") {
                let v = self.value(&with(&p, "default"))?;
                o.insert("default".into(), v);
            }
            self.options(&mut o, &p)?;
            out.push(Json::Object(o));
            if !self.accept(",") {
                break;
            }
        }
        self.expect(")")?;
        Ok(Json::Array(out))
    }

    fn module(&mut self, path: &[Seg], doc: &Option<DocC>, mods: &[Mod]) -> Res<Json> {
        self.expect_kw("module")?;
        let mut o = obj([("name", s(&self.name()?))]);
        self.describe(&mut o, path, doc);
        self.apply_mods(&mut o, mods, &MODULE_MODS, "a module")?;
        if self.accept("<") {
            let mut tps = vec![];
            let line = self.peek(0).line;
            self.rec(&with(path, "typeParams"), line);
            loop {
                let p = with(&with(path, "typeParams"), tps.len());
                let line = self.peek(0).line;
                self.rec(&p, line);
                let mut tp = obj([("name", s(&self.name()?))]);
                if self.accept(":") {
                    tp.insert("constraint".into(), s(&self.ident("numeric or integral")?));
                }
                if self.is_kw("extends", 0) {
                    self.next();
                    tp.insert("derivesFrom".into(), s(&self.qualified("a module")?));
                }
                if self.accept("=") {
                    let d = self.typ(&with(&p, "default"))?;
                    tp.insert("default".into(), d);
                }
                tps.push(Json::Object(tp));
                if !self.accept(",") {
                    break;
                }
            }
            self.expect(">")?;
            o.insert("typeParams".into(), Json::Array(tps));
        }
        if self.accept(":") {
            let line = self.peek(0).line;
            self.rec(&with(path, "bases"), line);
            let mut bases = vec![];
            loop {
                bases.push(Json::String(self.base()?));
                if !self.accept(",") {
                    break;
                }
            }
            o.insert("bases".into(), Json::Array(bases));
        }
        if self.is_kw("implements", 0) {
            self.next();
            let line = self.peek(0).line;
            self.rec(&with(path, "implements"), line);
            let mut ifs = vec![];
            loop {
                ifs.push(Json::String(self.ident("an interface")?));
                if !self.accept(",") {
                    break;
                }
            }
            o.insert("implements".into(), Json::Array(ifs));
        }
        self.options(&mut o, path)?;
        self.expect("{")?;
        self.body(Ctx::Module, &mut o, path, Some("}"))?;
        o.entry("ports").or_insert_with(|| Json::Array(vec![]));
        Ok(Json::Object(o))
    }

    /// A base: its path, with its type arguments as written (`Box<int32>`).
    fn base(&mut self) -> Res<String> {
        let name = self.qualified("a module")?;
        if !self.is_p("<", 0) {
            return Ok(name);
        }
        let start = self.peek(0).start;
        let mut depth = 0i32;
        let mut end;
        loop {
            let t = self.next();
            if t.kind == Kind::Eof {
                return self.fail("'>'");
            }
            if t.kind == Kind::Punct && t.text == "<" {
                depth += 1;
            } else if t.kind == Kind::Punct && t.text == ">" {
                depth -= 1;
            }
            end = t.end;
            if depth <= 0 {
                break;
            }
        }
        Ok(name + &self.text[start..end])
    }

    fn module_statement(&mut self, m: &mut Obj, path: &[Seg], doc: Option<DocC>) -> Res<()> {
        if (self.is_kw("in", 0) || self.is_kw("out", 0))
            && (self.peek(1).kind == Kind::Ident || self.is_p("?", 1))
        {
            return self.push(m, "ports", path, |p, ip| {
                let role = p.next().text;
                let iface = if p.accept("?") { Json::Null } else { s(&p.ident("an interface or ?")?) };
                let mut o = obj([("name", s(&p.name()?)), ("role", s(&role)), ("interface", iface)]);
                p.describe(&mut o, ip, &doc);
                p.options(&mut o, ip)?;
                p.expect(";")?;
                Ok(Json::Object(o))
            });
        }
        if self.is_kw("lock", 0) {
            self.no_doc(&doc)?;
            return self.push(m, "locks", path, |p, ip| {
                p.next();
                let mut o = obj([("name", s(&p.name()?))]);
                p.expect(":")?;
                o.insert("kind".into(), s(&p.ident("mutex, shared or recursive")?));
                p.options(&mut o, ip)?;
                p.expect(";")?;
                Ok(Json::Object(o))
            });
        }
        if self.is_kw("invariant", 0) {
            self.no_doc(&doc)?;
            return self.push(m, "invariants", path, |p, _| {
                p.next();
                let t = p.string("a condition, as a string")?;
                p.expect(";")?;
                Ok(Json::String(t.text))
            });
        }
        if self.is_kw("statemachine", 0) {
            self.no_doc(&doc)?;
            let p = with(path, "stateMachine");
            let line = self.next().line;
            self.rec(&p, line);
            let mut sm = Obj::new();
            self.expect("{")?;
            self.body(Ctx::StateMachine, &mut sm, &p, Some("}"))?;
            for k in ["states", "transitions"] {
                sm.entry(k).or_insert_with(|| Json::Array(vec![]));
            }
            m.insert("stateMachine".into(), Json::Object(sm));
            return Ok(());
        }
        let mods = self.mods();
        if self.is_kw("module", 0) {
            return self.push(m, "modules", path, |p, ip| p.module(ip, &doc, &mods));
        }
        if self.is_typedef() {
            return self.push(m, "types", path, |p, ip| p.typedef(ip, &doc, &mods));
        }
        if self.is_kw("constructor", 0) {
            return self.push(m, "constructors", path, |p, ip| {
                p.next();
                let mut o = Obj::new();
                p.describe(&mut o, ip, &doc);
                p.apply_mods(
                    &mut o,
                    &mods,
                    &["public", "protected", "private", "explicit"],
                    "a constructor",
                )?;
                let ps = p.params(&with(ip, "params"))?;
                o.insert("params".into(), ps);
                if p.accept("=") {
                    if p.is_kw("default", 0) {
                        o.insert("defaulted".into(), Json::Bool(true));
                    } else if p.is_kw("delete", 0) {
                        o.insert("deleted".into(), Json::Bool(true));
                    } else {
                        return p.fail("'default' or 'delete'");
                    }
                    p.next();
                }
                p.options(&mut o, ip)?;
                p.expect(";")?;
                Ok(Json::Object(o))
            });
        }
        if self.is_kw("destructor", 0) {
            self.no_doc(&doc)?;
            let p = with(path, "destructor");
            let line = self.next().line;
            self.rec(&p, line);
            let mut o = Obj::new();
            self.apply_mods(&mut o, &mods, &["public", "protected", "private", "virtual"], "a destructor")?;
            self.options(&mut o, &p)?;
            self.expect(";")?;
            m.insert("destructor".into(), Json::Object(o));
            return Ok(());
        }
        // An attribute or a method: type (or void) and name, then `(` for a method.
        let start = self.i;
        let saved = self.lines.clone();
        self.returns(&[])?;
        self.name()?;
        let is_method = self.is_p("(", 0);
        self.i = start;
        self.lines = saved;
        if is_method {
            return self.push(m, "methods", path, |p, ip| p.message(ip, &doc, &mods, true));
        }
        self.push(m, "attributes", path, |p, ip| {
            let mut o = p.field_obj(ip, &doc)?;
            p.apply_mods(&mut o, &mods, &ATTRIBUTE_MODS, "an attribute")?;
            Ok(Json::Object(o))
        })
    }

    fn state_statement(&mut self, sm: &mut Obj, path: &[Seg], doc: Option<DocC>) -> Res<()> {
        if self.peek(0).kind == Kind::Ident && self.is_p("->", 1) {
            self.no_doc(&doc)?;
            return self.push(sm, "transitions", path, |p, ip| {
                let mut o = obj([("from", s(&p.name()?))]);
                p.expect("->")?;
                o.insert("to".into(), s(&p.name()?));
                loop {
                    if p.is_kw("on", 0) {
                        p.next();
                        o.insert("trigger".into(), s(&p.ident("a method")?));
                    } else if p.is_kw("if", 0) {
                        p.next();
                        let t = p.string("a condition, as a string")?;
                        o.insert("guard".into(), Json::String(t.text));
                    } else if p.is_kw("do", 0) {
                        p.next();
                        o.insert("action".into(), s(&p.ident("a method")?));
                    } else {
                        break;
                    }
                }
                p.options(&mut o, ip)?;
                p.expect(";")?;
                Ok(Json::Object(o))
            });
        }
        if self.is_kw("initial", 0) {
            self.no_doc(&doc)?;
            let line = self.next().line;
            self.rec(&with(path, "initial"), line);
            sm.insert("initial".into(), s(&self.name()?));
            return self.expect(";");
        }
        let mut is_final = false;
        if self.is_kw("final", 0) {
            self.next();
            is_final = true;
        }
        if !self.is_kw("state", 0) {
            return self.fail("'state', a transition 'A -> B' or 'initial'");
        }
        self.push(sm, "states", path, |p, ip| {
            p.next();
            let mut o = obj([("name", s(&p.name()?))]);
            p.describe(&mut o, ip, &doc);
            if is_final {
                o.insert("final".into(), Json::Bool(true));
            }
            p.options(&mut o, ip)?;
            p.expect(";")?;
            Ok(Json::Object(o))
        })
    }

    fn endpoint(&mut self, path: &[Seg]) -> Res<Json> {
        let line = self.peek(0).line;
        self.rec(path, line);
        let first = self.ident("a module path")?;
        let mut o = Obj::new();
        let mut segs = vec![];
        if self.accept("/") {
            o.insert("project".into(), Json::String(first));
            segs.push(self.ident("a module path")?);
        } else {
            segs.push(first);
        }
        while self.accept(".") {
            segs.push(self.ident("a module path or a port")?);
        }
        if segs.len() < 2 {
            return self.fail("'.port'");
        }
        let port = segs.pop().unwrap_or_default();
        o.insert("module".into(), Json::String(segs.join(".")));
        o.insert("port".into(), Json::String(port));
        Ok(Json::Object(o))
    }

    fn link(&mut self, path: &[Seg], doc: &Option<DocC>) -> Res<Json> {
        self.expect_kw("link")?;
        let mut o = obj([("name", s(&self.name()?))]);
        self.describe(&mut o, path, doc);
        self.expect(":")?;
        let from = self.endpoint(&with(path, "from"))?;
        o.insert("from".into(), from);
        let direction = if self.accept("->") {
            "unidirectional"
        } else if self.accept("<->") {
            "bidirectional"
        } else {
            return self.fail("'->' or '<->'");
        };
        let to = self.endpoint(&with(path, "to"))?;
        o.insert("to".into(), to);
        let mut ack = obj([("required", Json::Bool(false))]);
        let mut performance = obj([("class", s("normal"))]);
        let mut remote = obj([("enabled", Json::Bool(false))]);
        let line = self.peek(0).line;
        self.rec(&with(path, "constraints"), line);
        while self.is_word_in(&CLAUSES) {
            let w = self.next().text;
            match w.as_str() {
                "ack" => {
                    ack.insert("required".into(), Json::Bool(true));
                    if self.peek(0).kind == Kind::Number {
                        ack.insert("timeoutMs".into(), self.number()?);
                    }
                }
                "latency" => {
                    performance.insert("maxLatencyMs".into(), self.number()?);
                }
                "rate" => {
                    performance.insert("rateHz".into(), self.number()?);
                }
                "remote" => {
                    remote.insert("enabled".into(), Json::Bool(true));
                    let t = self.peek(0).clone();
                    if t.kind == Kind::Str
                        || (t.kind == Kind::Ident && (t.escaped || !CLAUSES.contains(&t.text.as_str())))
                    {
                        self.next();
                        remote.insert("transport".into(), Json::String(t.text));
                    }
                    if self.is_p("{", 0) {
                        let p = with(&with(&with(path, "constraints"), "remote"), "settings");
                        let v = self.value(&p)?;
                        remote.insert("settings".into(), v);
                    }
                }
                _ if PERF.contains(&w.as_str()) => {
                    performance.insert("class".into(), Json::String(w));
                }
                _ => {}
            }
        }
        o.insert(
            "constraints".into(),
            Json::Object(obj([
                ("direction", s(direction)),
                ("ack", Json::Object(ack)),
                ("performance", Json::Object(performance)),
                ("remote", Json::Object(remote)),
            ])),
        );
        self.options(&mut o, path)?;
        self.expect(";")?;
        Ok(Json::Object(o))
    }
}

fn obj<const N: usize>(entries: [(&str, Json); N]) -> Obj {
    entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

fn push_to(o: &mut Obj, key: &str, v: Json) {
    if let Some(Json::Array(a)) = o.get_mut(key) {
        a.push(v);
    }
}

/// Objects with their keys in JavaScript's order (array indexes first).
fn js_order(v: Json) -> Json {
    match v {
        Json::Array(a) => Json::Array(a.into_iter().map(js_order).collect()),
        Json::Object(o) => js_object(o.into_iter().map(|(k, v)| (k, js_order(v))).collect()),
        v => v,
    }
}

/// Lines of the nodes of `v` at `path`, from the lines recorded by data path.
fn lines_of(v: &Json, path: &mut Path, lines: &HashMap<String, usize>) -> Lines {
    let Some(&start) = lines.get(&key(path)) else { return Lines::None };
    match v {
        Json::Object(o) => {
            let mut entries = vec![];
            for (k, x) in o {
                path.push(Seg::Key(k.clone()));
                if let Some(&line) = lines.get(&key(path)) {
                    entries.push((k.clone(), line, lines_of(x, path, lines)));
                }
                path.pop();
            }
            Lines::Map(start, entries)
        }
        Json::Array(a) => {
            let mut items = vec![];
            for (n, x) in a.iter().enumerate() {
                path.push(Seg::Idx(n));
                items.push(lines_of(x, path, lines));
                path.pop();
            }
            Lines::Seq(start, items)
        }
        _ => Lines::Scalar(start),
    }
}

/// Data of a Scaffold text (the file data, before the schema check), with the line of each node.
pub fn parse_dsl(text: &str) -> Result<(Json, Lines), DslError> {
    let mut p = Parser::new(text)?;
    let value = js_order(p.file()?);
    let lines = lines_of(&value, &mut vec![], &p.lines);
    Ok((value, lines))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path;

    const MINIMAL: &str = "syntax = \"scaffold1\";\nproject \"P\";\n";

    fn parse(t: &str) -> Json {
        match parse_dsl(&format!("{MINIMAL}{t}")) {
            Ok((v, _)) => v,
            Err(e) => panic!("line {}: {}", e.line, e.message),
        }
    }
    fn error(t: &str) -> (usize, String) {
        match parse_dsl(&format!("{MINIMAL}{t}")) {
            Ok(_) => panic!("no error"),
            Err(e) => (e.line, e.message),
        }
    }

    #[test]
    fn small_project() {
        let d = parse(
            "enum State : int8 { Off = -1; On = 1; }\n\
             /// One sample\n\
             struct Reading {\n  float64 value = 1.5 [constraints = { min: 0 }];\n  map<string, int32> tags = { a: 1 };\n  optional<string> note = null;\n}\n\
             abstract module Plant : Base, Box<int32> implements Query {\n  in Sink feed;\n  in ? q;\n  static const uint32 count = 0;\n  virtual pure void run();\n  module Store { in Sink `in`; }\n}\n\
             link q: Plant.q <-> Plant.Store.in ack 20 low remote tcp;\n",
        );
        assert_eq!(d["schemaVersion"], 1);
        assert_eq!(d["types"][0]["values"][0], serde_json::json!({"name": "Off", "value": -1}));
        assert_eq!(d["types"][1]["description"], "One sample");
        assert_eq!(d["types"][1]["fields"][0]["default"], 1.5);
        assert_eq!(d["types"][1]["fields"][2]["default"], Json::Null);
        let m = &d["modules"][0];
        assert_eq!(m["kind"], "abstract");
        assert_eq!(m["bases"], serde_json::json!(["Base", "Box<int32>"]));
        assert_eq!(m["ports"][1]["interface"], Json::Null);
        assert_eq!(
            m["attributes"][0],
            serde_json::json!({"name": "count", "type": {"kind": "primitive", "name": "uint32"}, "default": 0, "static": true, "const": true})
        );
        assert_eq!(m["methods"][0]["returns"], Json::Null);
        assert_eq!(m["modules"][0]["ports"][0]["name"], "in");
        assert_eq!(
            d["links"][0]["constraints"],
            serde_json::json!({"direction": "bidirectional", "ack": {"required": true, "timeoutMs": 20}, "performance": {"class": "low"}, "remote": {"enabled": true, "transport": "tcp"}})
        );
    }

    /// tests/dsl: the Scaffold text the editor writes of the examples and fixtures (its
    /// scripts/to-scaffold.ts) reads as the same data as their YAML.
    #[test]
    fn same_data_as_yaml() {
        use crate::model::text::{Format, parse_text};
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x == "scaffold") {
                    out.push(p);
                }
            }
        }
        let mut files = vec![];
        walk(&root.join("tests/dsl"), &mut files);
        assert!(files.len() >= 13);
        for f in files {
            let rel = f.strip_prefix(root.join("tests/dsl")).unwrap().to_string_lossy().replace('\\', "/");
            let yaml = if let Some(r) = rel.strip_prefix("fixtures/") {
                root.join("tests/fixtures").join(r)
            } else {
                root.join(&rel)
            };
            let yaml = yaml.with_extension("scaffold.yaml");
            let dsl = parse_text(&std::fs::read_to_string(&f).unwrap(), Format::Dsl)
                .unwrap_or_else(|e| panic!("{rel}: {}", e.message));
            let expected = parse_text(&std::fs::read_to_string(&yaml).unwrap(), Format::Yaml).ok().unwrap();
            assert_eq!(dsl.value, expected.value, "{rel}");
        }
    }

    #[test]
    fn errors_and_lines() {
        assert_eq!(error("struct A {\n  int32;\n}"), (4, "expected a name, found ';'".into()));
        assert_eq!(error("/// x\n"), (3, "documentation comment documents nothing".into()));
        assert_eq!(error("module M { static module N {} }").1, "'static' does not apply to a module");
        let (_, lines) = parse_dsl(&format!("{MINIMAL}\nmodule M {{\n  in ? p;\n}}\n")).ok().unwrap();
        assert_eq!(lines.of(&path!["modules", 0, "ports", 0, "interface"][..]), Some(5));
        assert_eq!(lines.of(&path!["modules", 0, "name"][..]), Some(4));
    }
}
