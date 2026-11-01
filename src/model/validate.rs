// Semantic checks of a loaded project (src/model/validate.ts), errors only: they block generation
// (warnings are the editor's). In the order of the editor's checks, after load.rs: the errors
// loading already rules out are not checked again.
use std::collections::{HashMap, HashSet};

use serde_json::Value as Json;

use super::load::{Index, db, dh, dl, ds, txt};
use super::values::{Resolved, int_range, is_int_primitive, js_str, resolve, to_bigint, value_errors};

fn reserved_type_name(n: &str) -> bool {
    matches!(
        n,
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

/// Strings occurring more than once, in the order they repeat.
fn dups_of(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out: Vec<String> = vec![];
    for s in items {
        if !seen.insert(s.clone()) && !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

fn dups(list: &[Json], k: &str) -> Vec<String> {
    dups_of(list.iter().map(|x| ds(x, k)))
}

/// Text of a type reference (typeExpr.ts printTypeExpr).
pub fn type_expr(t: &Json) -> String {
    let max = if dh(t, "max") { format!(", {}", ds(t, "max")) } else { String::new() };
    match ds(t, "kind").as_str() {
        "primitive" => {
            if dh(t, "max") {
                format!("{}<{}>", ds(t, "name"), ds(t, "max"))
            } else {
                ds(t, "name")
            }
        }
        "ref" => ds(t, "name"),
        "array" => format!("array<{}, {}>", type_expr(&t["of"]), ds(t, "size")),
        "map" => format!("map<{}, {}{max}>", type_expr(&t["key"]), type_expr(&t["value"])),
        "optional" => format!("optional<{}>", type_expr(&t["of"])),
        k => format!("{k}<{}{max}>", type_expr(&t["of"])),
    }
}

fn method_signature(m: &Json) -> String {
    let ps: Vec<String> = dl(m, "params")
        .iter()
        .map(|p| {
            format!(
                "{} {}{}",
                if dh(p, "direction") { ds(p, "direction") } else { "in".into() },
                if db(p, "const") { "const " } else { "" },
                type_expr(&p["type"])
            )
        })
        .collect();
    format!(
        "({}){}{}",
        ps.join(", "),
        if dh(m, "returns") { type_expr(&m["returns"]) } else { String::new() },
        if db(m, "const") { " const" } else { "" }
    )
}

/// File path normalized (sync.ts normalizeFile).
fn normalize_file(f: &str) -> String {
    let mut out: Vec<&str> = vec![];
    for p in f.split(['\\', '/']) {
        if p == "." || (p.is_empty() && !out.is_empty()) {
            continue;
        }
        if p == ".." && out.last().is_some_and(|l| *l != ".." && !l.is_empty()) {
            out.pop();
        } else {
            out.push(p);
        }
    }
    out.join("/")
}

/// Owner of a type reference.
#[derive(Clone, Copy)]
enum Owner {
    Type(usize),
    Const(usize),
    Iface,
    Module(usize),
}

struct TypeRefUse<'a> {
    t: Json,
    where_: String,
    owner: Owner,
    dep: String,
    _p: std::marker::PhantomData<&'a ()>,
}

struct V<'i, 'a> {
    f: &'a Json,
    ix: &'i Index<'a>,
    errors: Vec<String>,
}

/// Errors of a loaded project.
pub fn validate<'a>(f: &'a Json, ix: &Index<'a>) -> Vec<String> {
    let mut v = V { f, ix, errors: vec![] };
    v.run();
    v.errors
}

impl<'i, 'a> V<'i, 'a> {
    fn err(&mut self, m: impl Into<String>) {
        self.errors.push(m.into());
    }

    fn type_def(&self, key: &str) -> Option<&'a Json> {
        self.ix.type_idx.get(key).map(|&i| self.ix.types[i].def)
    }

    /// Kind after aliases ("" for deleted / cyclic), and the reference when not a user type.
    fn resolved_kind(&self, t: &'a Json) -> (String, Option<&'a Json>) {
        match resolve(self.ix, t) {
            Resolved::Def(d) => (ds(d, "kind"), None),
            Resolved::Ref(r) => (ds(r, "kind"), Some(r)),
            Resolved::None => (String::new(), None),
        }
    }

    /// Errors of the nodes of a type reference.
    fn check_typeref(&mut self, t: &'a Json, where_: &str) {
        if !t.is_object() {
            return;
        }
        let k = ds(t, "kind");
        if k == "ref"
            && let Some(def) = self.type_def(&ds(t, "name"))
            && ds(def, "kind") == "exception"
        {
            self.err(format!("{where_}: exception '{}' can only be raised", ds(def, "name")));
        }
        if k == "primitive" && dh(t, "max") && ds(t, "name") != "string" && ds(t, "name") != "bytes" {
            self.err(format!("{where_}: {} cannot be bounded", ds(t, "name")));
        }
        let keyof = match k.as_str() {
            "map" => Some(&t["key"]),
            "set" => Some(&t["of"]),
            _ => None,
        };
        if let Some(key) = keyof {
            let (kk, _) = self.resolved_kind(key);
            if !kk.is_empty() && kk != "primitive" && kk != "enum" && kk != "bitmask" {
                self.err(format!("{where_}: {k} key must be a primitive, an enum or a bitmask"));
            }
        }
        if k == "map" {
            self.check_typeref(&t["key"], where_);
            self.check_typeref(&t["value"], where_);
        } else if k != "primitive" && k != "ref" {
            self.check_typeref(&t["of"], where_);
        }
    }

    fn check_default(&mut self, f: &'a Json, where_: &str) {
        let Some(d) = f.get("default") else { return };
        for e in value_errors(self.ix, d, &f["type"]) {
            self.err(format!("{where_} default: {e}"));
        }
    }

    fn check_message(&mut self, m: &'a Json, where_: &str) {
        let ps = dl(m, "params");
        for d in dups(ps, "name") {
            self.err(format!("{where_}: duplicate parameter '{d}'"));
        }
        for p in ps {
            self.check_typeref(&p["type"], &format!("{where_}({})", ds(p, "name")));
        }
        if dh(m, "returns") {
            self.check_typeref(&m["returns"], &format!("{where_} returns"));
        }
        let rs = dl(m, "raises");
        for r in rs {
            if let Some(def) = self.type_def(&txt(r))
                && ds(def, "kind") != "exception"
            {
                self.err(format!("{where_} raises '{}', which is not an exception", ds(def, "name")));
            }
        }
        for d in dups_of(rs.iter().map(txt)) {
            let n = self.type_def(&d).map(|x| ds(x, "name")).unwrap_or_default();
            self.err(format!("{where_} raises '{n}' more than once"));
        }
    }

    // ------------------------------------------------------------ modules ----

    /// Bases of module i, direct and indirect, nearest first, each once.
    fn ancestors(&self, i: usize) -> Vec<usize> {
        let mut seen = HashSet::from([i]);
        let mut out = vec![];
        let mut level = vec![i];
        while !level.is_empty() {
            let mut next = vec![];
            for &j in &level {
                for b in &self.ix.modules[j].bases {
                    let b = self.ix.module_idx[b];
                    if seen.insert(b) {
                        out.push(b);
                        next.push(b);
                    }
                }
            }
            level = next;
        }
        out
    }

    fn is_ancestor(&self, i: usize, a: usize) -> bool {
        self.ancestors(i).contains(&a)
    }

    /// Pure methods module i inherits and does not implement: (base, name).
    fn unimplemented(&self, i: usize) -> Vec<(usize, String)> {
        let mut out = vec![];
        let mut seen = HashSet::new();
        let defined: HashSet<String> =
            dl(self.ix.modules[i].def, "methods").iter().map(|x| ds(x, "name")).collect();
        self.un_walk(i, &defined, &mut vec![i], &mut seen, &mut out);
        out
    }

    fn un_walk(
        &self,
        cur: usize,
        defined: &HashSet<String>,
        stack: &mut Vec<usize>,
        seen: &mut HashSet<String>,
        out: &mut Vec<(usize, String)>,
    ) {
        for b in &self.ix.modules[cur].bases {
            let b = self.ix.module_idx[b];
            if stack.contains(&b) {
                continue;
            }
            let ms = dl(self.ix.modules[b].def, "methods");
            for x in ms {
                let n = ds(x, "name");
                if db(x, "pure") && !defined.contains(&n) && seen.insert(n.clone()) {
                    out.push((b, n));
                }
            }
            let mut names = defined.clone();
            names.extend(ms.iter().filter(|x| !db(x, "pure")).map(|x| ds(x, "name")));
            stack.push(b);
            self.un_walk(b, &names, stack, seen, out);
            stack.pop();
        }
    }

    /// Binary a module id runs in ("" none; imported modules: none).
    fn binary_of(&self, id: &str) -> String {
        let Some(&mut_i) = self.ix.module_idx.get(id) else { return String::new() };
        let mut i = mut_i;
        while let Some(p) = self.ix.modules[i].parent {
            i = p;
        }
        self.ix.modules[i].binary.clone()
    }

    fn validate_module(&mut self, i: usize) {
        let me = &self.ix.modules[i];
        let m = me.def;
        let path = me.path.clone();
        let kind = match ds(m, "kind").as_str() {
            "class" => String::new(),
            k => k.to_string(),
        };
        if !dl(self.f, "binaries").is_empty() && me.parent.is_none() && me.binary.is_empty() {
            self.err(format!("{path}: runs in no binary (the project has binaries)"));
        }
        // types and constants of the module vs its members and submodules
        let mut members = HashSet::new();
        let attrs = dl(m, "attributes");
        let methods = dl(m, "methods");
        for x in attrs.iter().chain(methods).chain(dl(m, "ports")).chain(dl(m, "modules")) {
            members.insert(ds(x, "name"));
        }
        for t in &self.ix.types {
            if t.module == path && members.contains(&ds(t.def, "name")) {
                self.errors.push(format!(
                    "{path}: '{}' is both a type or constant and a member or submodule",
                    ds(t.def, "name")
                ));
            }
        }
        for c in &self.ix.consts {
            if c.module == path && members.contains(&ds(c.def, "name")) {
                self.errors.push(format!(
                    "{path}: '{}' is both a type or constant and a member or submodule",
                    ds(c.def, "name")
                ));
            }
        }
        for d in dups(attrs, "name") {
            self.err(format!("{path}: duplicate attribute '{d}'"));
        }
        for a in attrs {
            let w = format!("{path}.{}", ds(a, "name"));
            self.check_typeref(&a["type"], &w);
            self.check_default(a, &w);
        }
        for d in dups(methods, "name") {
            self.err(format!("{path}: duplicate method '{d}'"));
        }
        let attr_names: HashSet<String> = attrs.iter().map(|a| ds(a, "name")).collect();
        let anc = self.ancestors(i);
        for x in methods {
            let name = ds(x, "name");
            let where_ = format!("{path}.{name}");
            if db(x, "static") && db(x, "const") {
                self.err(format!("{where_}: a static method cannot be const"));
            }
            if db(x, "static") && db(x, "virtual") {
                self.err(format!("{where_}: a static method cannot be virtual"));
            }
            if (db(x, "pure") || db(x, "override")) && !db(x, "virtual") {
                self.err(format!(
                    "{where_}: a {} method must be virtual",
                    if db(x, "pure") { "pure" } else { "override" }
                ));
            }
            if db(x, "pure") && kind.is_empty() {
                self.err(format!(
                    "{where_}: pure method in a concrete module (make it abstract or an interface)"
                ));
            }
            if kind == "interface" && !db(x, "pure") {
                self.err(format!("{where_}: methods of an interface module must be pure"));
            }
            let inh = anc.iter().find_map(|&a| {
                dl(self.ix.modules[a].def, "methods")
                    .iter()
                    .find(|y| ds(y, "name") == name && db(y, "virtual"))
                    .map(|y| (a, y))
            });
            if db(x, "override") {
                match inh {
                    None => self.err(format!("{where_}: overrides no virtual method of a base")),
                    Some((a, y)) if method_signature(x) != method_signature(y) => {
                        let ap = self.ix.modules[a].path.clone();
                        self.err(format!("{where_}: signature differs from {ap}.{name} it overrides"))
                    }
                    _ => {}
                }
            }
            if attr_names.contains(&name) {
                self.err(format!("{path}: '{name}' is both an attribute and a method"));
            }
            self.check_message(x, &where_);
            for p in dl(x, "params") {
                if db(p, "const") && dh(p, "direction") && ds(p, "direction") != "in" {
                    self.err(format!(
                        "{where_}({}): an {} parameter cannot be const",
                        ds(p, "name"),
                        ds(p, "direction")
                    ));
                }
            }
        }
        if kind == "interface" && !attrs.is_empty() {
            self.err(format!("{path}: an interface module cannot have attributes"));
        }
        let bases = self.ix.modules[i].bases.clone();
        if bases.contains(&path) {
            self.err(format!("{path} derives from itself"));
        } else if bases.iter().any(|b| self.is_ancestor(self.ix.module_idx[b], i)) {
            self.err(format!("{path} derives from itself through its bases"));
        }
        for d in dups_of(bases.iter().cloned()) {
            self.err(format!("{path} derives from {d} more than once"));
        }
        if kind.is_empty() {
            for (b, n) in self.unimplemented(i) {
                let bp = self.ix.modules[b].path.clone();
                self.err(format!(
                    "{path} does not implement pure method {bp}.{n} (implement it or make the module abstract)"
                ));
            }
        }
    }

    // --------------------------------------------------------------- refs ----

    /// Every type reference of the project, in the editor's order.
    fn all_type_refs(&self) -> Vec<TypeRefUse<'a>> {
        let mut out = vec![];
        let mut add = |t: &Json, where_: String, owner: Owner, dep: &str| {
            out.push(TypeRefUse { t: t.clone(), where_, owner, dep: dep.into(), _p: Default::default() })
        };
        for (i, te) in self.ix.types.iter().enumerate() {
            let t = te.def;
            let key = &te.key;
            match ds(t, "kind").as_str() {
                "struct" | "exception" => {
                    for f in dl(t, "fields") {
                        add(&f["type"], format!("{key}.{}", ds(f, "name")), Owner::Type(i), &te.dep);
                    }
                }
                "alias" => add(&t["type"], key.clone(), Owner::Type(i), &te.dep),
                "union" => {
                    add(&t["discriminator"], format!("{key} discriminator"), Owner::Type(i), &te.dep);
                    for c in dl(t, "cases") {
                        add(&c["type"], format!("{key}.{}", ds(c, "name")), Owner::Type(i), &te.dep);
                    }
                }
                _ => {}
            }
        }
        for (i, c) in self.ix.consts.iter().enumerate() {
            add(&c.def["type"], c.key.clone(), Owner::Const(i), &c.dep);
        }
        let message = |add: &mut dyn FnMut(&Json, String, Owner, &str),
                       m: &Json,
                       where_: String,
                       owner: Owner,
                       dep: &str| {
            for p in dl(m, "params") {
                add(&p["type"], format!("{where_}({})", ds(p, "name")), owner, dep);
            }
            if dh(m, "returns") {
                add(&m["returns"], format!("{where_} returns"), owner, dep);
            }
            for r in dl(m, "raises") {
                add(&serde_json::json!({"kind": "ref", "name": r}), format!("{where_} raises"), owner, dep);
            }
        };
        for x in &self.ix.ifaces {
            for m in dl(x.def, "messages") {
                message(
                    &mut add,
                    m,
                    format!("{}.{}", ds(x.def, "name"), ds(m, "name")),
                    Owner::Iface,
                    &x.dep,
                );
            }
        }
        for (i, me) in self.ix.modules.iter().enumerate() {
            for a in dl(me.def, "attributes") {
                add(&a["type"], format!("{}.{}", me.path, ds(a, "name")), Owner::Module(i), "");
            }
            for m in dl(me.def, "methods") {
                message(&mut add, m, format!("{}.{}", me.path, ds(m, "name")), Owner::Module(i), "");
            }
        }
        out
    }

    /// Module whose scope a reference of `owner` is in.
    fn ref_context(&self, owner: Owner) -> Option<usize> {
        match owner {
            Owner::Module(i) => Some(i),
            Owner::Type(i) => self.ix.module_idx.get(&self.ix.types[i].module).copied(),
            Owner::Const(i) => self.ix.module_idx.get(&self.ix.consts[i].module).copied(),
            Owner::Iface => None,
        }
    }

    fn type_access(&self, i: usize) -> String {
        match ds(self.ix.types[i].def, "access").as_str() {
            a @ ("protected" | "private") => a.to_string(),
            _ => String::new(),
        }
    }

    /// Whether modules (context: a module, None outside them) may use type i.
    fn can_use_type(&self, context: Option<usize>, i: usize) -> bool {
        let t = &self.ix.types[i];
        if (t.module.is_empty() && t.modpath.is_empty()) || self.type_access(i).is_empty() {
            return true;
        }
        let Some(c) = context else { return false };
        if t.module.is_empty() {
            return false;
        }
        let owner = self.ix.module_idx[&t.module];
        if owner == c {
            return true;
        }
        self.type_access(i) == "protected" && self.is_ancestor(c, owner)
    }

    /// Dependencies (names) whose entities those of dependency `d` may use.
    fn reach(&self, d: &str, out: &mut HashSet<String>) {
        if !out.insert(d.to_string()) {
            return;
        }
        let x = &dl(self.f, "dependencies")[self.ix.dep_idx[d]];
        for u in dl(x, "uses") {
            let u = txt(u);
            if self.ix.dep_idx.contains_key(&u) {
                self.reach(&u, out);
            }
        }
    }

    // ------------------------------------------------------------- validate ----

    fn run(&mut self) {
        let ix = self.ix;
        // Constants
        for c in &ix.consts {
            let name = ds(c.def, "name");
            if reserved_type_name(&name) {
                self.err(format!("'{name}' is a reserved type name"));
            }
            self.check_typeref(&c.def["type"], &c.key);
            let value = c.def.get("value").unwrap_or(&Json::Null);
            for e in value_errors(ix, value, &c.def["type"]) {
                self.err(format!("Constant '{}': {e}", c.key));
            }
        }
        // Types
        for te in &ix.types {
            let t = te.def;
            let name = ds(t, "name");
            if reserved_type_name(&name) {
                self.err(format!("'{name}' is a reserved type name"));
            }
            match ds(t, "kind").as_str() {
                k @ ("struct" | "exception") => {
                    let fs = dl(t, "fields");
                    let what = if k == "struct" { "Struct" } else { "Exception" };
                    for d in dups(fs, "name") {
                        self.err(format!("{what} '{name}': duplicate field '{d}'"));
                    }
                    for f in fs {
                        let w = format!("{name}.{}", ds(f, "name"));
                        self.check_typeref(&f["type"], &w);
                        self.check_default(f, &w);
                    }
                }
                "enum" => {
                    let vals = dl(t, "values");
                    for d in dups(vals, "name") {
                        self.err(format!("Enum '{name}': duplicate value name '{d}'"));
                    }
                    let u = ds(t, "underlying");
                    if let Some((min, max)) = int_range(&u) {
                        for v in vals {
                            if let Some(x) = to_bigint(&v["value"])
                                && (x < min || x > max)
                            {
                                self.err(format!(
                                    "Enum '{name}': {} = {} does not fit in {u}",
                                    ds(v, "name"),
                                    js_str(&v["value"])
                                ));
                            }
                        }
                    }
                }
                "bitmask" => {
                    let flags = dl(t, "flags");
                    for d in dups(flags, "name") {
                        self.err(format!("Bitmask '{name}': duplicate flag '{d}'"));
                    }
                    for d in dups_of(flags.iter().map(|f| js_str(&f["bit"]))) {
                        self.err(format!("Bitmask '{name}': bit {d} used more than once"));
                    }
                    let u = ds(t, "underlying");
                    let w: f64 = u.get(4..).and_then(|s| s.parse().ok()).unwrap_or(0.0);
                    for f in flags {
                        if f["bit"].as_f64().unwrap_or(0.0) >= w {
                            self.err(format!(
                                "Bitmask '{name}': {} (bit {}) does not fit in {u}",
                                ds(f, "name"),
                                ds(f, "bit")
                            ));
                        }
                    }
                }
                "union" => self.validate_union(t, &name),
                "alias" => {
                    self.check_typeref(&t["type"], &name);
                    let x = &t["type"];
                    if ds(x, "kind") == "ref"
                        && ix.type_idx.contains_key(&ds(x, "name"))
                        && self.alias_cyclic(&te.key, x)
                    {
                        self.err(format!("Alias '{name}' is cyclic"));
                    }
                }
                _ => {}
            }
        }
        self.by_value_cycles();

        // Interfaces
        for x in &ix.ifaces {
            let name = ds(x.def, "name");
            if reserved_type_name(&name) {
                self.err(format!("'{name}' is a reserved type name"));
            }
            let ms = dl(x.def, "messages");
            for d in dups(ms, "name") {
                self.err(format!("Interface '{name}': duplicate message '{d}'"));
            }
            for m in ms {
                self.check_message(m, &format!("{name}.{}", ds(m, "name")));
            }
        }

        // Modules
        for i in 0..ix.modules.len() {
            self.validate_module(i);
        }

        // Dependencies
        let deps = dl(self.f, "dependencies");
        for d in dups_of(deps.iter().map(|d| normalize_file(&ds(d, "file")))) {
            self.err(format!("Dependency file '{d}' listed more than once"));
        }
        for d in deps {
            let mut through = false;
            for u in dl(d, "uses") {
                let u = txt(u);
                if !ix.dep_idx.contains_key(&u) {
                    continue;
                }
                let mut r = HashSet::new();
                self.reach(&u, &mut r);
                if r.contains(&ds(d, "name")) {
                    through = true;
                }
            }
            if through {
                self.err(format!("Dependency '{}' uses itself through other dependencies", ds(d, "name")));
            }
        }

        // Types of modules: public ones anywhere, the others in modules only, as their access allows.
        let refs = self.all_type_refs();
        for r in &refs {
            if !r.dep.is_empty() {
                continue;
            }
            let ctx = self.ref_context(r.owner);
            for key in ref_keys(&r.t) {
                let Some(&used) = ix.type_idx.get(&key) else { continue };
                let t = &ix.types[used];
                if t.module.is_empty() && t.modpath.is_empty() {
                    continue;
                }
                let of = if t.module.is_empty() { &t.modpath } else { &t.module };
                if ctx.is_none() && !self.can_use_type(None, used) {
                    let m = format!(
                        "{}: '{}' is a {} type of module {of}, used by modules only",
                        r.where_,
                        t.key,
                        self.type_access(used)
                    );
                    self.err(m);
                } else if !self.can_use_type(ctx, used) {
                    let a = self.type_access(used);
                    let m = format!(
                        "{}: '{}' is {} in {of}",
                        r.where_,
                        t.key,
                        if a.is_empty() { "public".to_string() } else { a }
                    );
                    self.err(m);
                }
            }
        }
        for r in &refs {
            if matches!(r.owner, Owner::Module(_)) || r.dep.is_empty() {
                continue;
            }
            let mut reach = HashSet::new();
            self.reach(&r.dep, &mut reach);
            let mut shared = HashSet::new();
            for d in deps {
                if reach.contains(&ds(d, "name")) {
                    shared.extend(dl(d, "shared").iter().map(txt));
                }
            }
            for key in ref_keys(&r.t) {
                let Some(&used) = ix.type_idx.get(&key) else { continue };
                let t = &ix.types[used];
                let nm = ds(t.def, "name");
                if (t.dep.is_empty() || !reach.contains(&t.dep)) && !shared.contains(&nm) {
                    self.err(format!(
                        "{}: '{nm}' is not in its dependency or the dependencies it uses",
                        r.where_
                    ));
                }
            }
        }

        self.validate_links();
    }

    fn validate_union(&mut self, t: &'a Json, name: &str) {
        let disc = &t["discriminator"];
        self.check_typeref(disc, &format!("{name} discriminator"));
        let (dk, r) = self.resolved_kind(disc);
        let valid = dk == "enum"
            || (dk == "primitive"
                && r.is_some_and(|r| {
                    let n = ds(r, "name");
                    n == "bool" || n == "char" || is_int_primitive(&n)
                }));
        if !dk.is_empty() && !valid {
            self.err(format!("Union '{name}': discriminator must be an integer, bool, char or enum"));
        }
        let cs = dl(t, "cases");
        for d in dups(cs, "name") {
            self.err(format!("Union '{name}': duplicate case '{d}'"));
        }
        if cs.iter().filter(|c| db(c, "default")).count() > 1 {
            self.err(format!("Union '{name}': more than one default case"));
        }
        for c in cs {
            let cn = ds(c, "name");
            self.check_typeref(&c["type"], &format!("{name}.{cn}"));
            let labels = dl(c, "labels");
            if labels.is_empty() && !db(c, "default") {
                self.err(format!("Union '{name}': case '{cn}' has no label"));
            }
            if valid {
                for l in labels {
                    for e in value_errors(self.ix, l, disc) {
                        self.err(format!("Union '{name}': label of case '{cn}': {e}"));
                    }
                }
            }
        }
        let all = cs.iter().flat_map(|c| dl(c, "labels").iter().map(js_str));
        for d in dups_of(all) {
            self.err(format!("Union '{name}': label {d} used by several cases"));
        }
    }

    /// Whether following the alias at `key` (reference x) comes back to a seen alias or a deleted type.
    fn alias_cyclic(&self, key: &str, mut x: &'a Json) -> bool {
        let mut seen = HashSet::from([key.to_string()]);
        while ds(x, "kind") == "ref" {
            let n = ds(x, "name");
            let Some(def) = self.type_def(&n) else { return true };
            if seen.contains(&n) {
                return true;
            }
            if ds(def, "kind") != "alias" {
                return false;
            }
            seen.insert(n);
            x = &def["type"];
        }
        false
    }

    /// Structs and unions containing themselves by value (through fields, cases, arrays,
    /// optionals, aliases).
    fn by_value(&self, t: &Json, edges: &mut Vec<usize>, seen: &mut HashSet<String>) {
        match ds(t, "kind").as_str() {
            "array" | "optional" => self.by_value(&t["of"], edges, seen),
            "ref" => {
                let key = ds(t, "name");
                let Some(&i) = self.ix.type_idx.get(&key) else { return };
                let def = self.ix.types[i].def;
                match ds(def, "kind").as_str() {
                    "struct" | "union" => {
                        if !edges.contains(&i) {
                            edges.push(i);
                        }
                    }
                    "alias" => {
                        if seen.insert(key) {
                            self.by_value(&def["type"], edges, seen);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    fn by_value_cycles(&mut self) {
        let mut edges: HashMap<usize, Vec<usize>> = HashMap::new();
        for (i, te) in self.ix.types.iter().enumerate() {
            let k = ds(te.def, "kind");
            if k != "struct" && k != "union" {
                continue;
            }
            let mut e = vec![];
            for f in dl(te.def, if k == "struct" { "fields" } else { "cases" }) {
                self.by_value(&f["type"], &mut e, &mut HashSet::new());
            }
            edges.insert(i, e);
        }
        let mut state: HashMap<usize, bool> = HashMap::new(); // false: visiting, true: done
        let mut cyclic: Vec<usize> = vec![];
        fn visit(
            id: usize,
            stack: &mut Vec<usize>,
            edges: &HashMap<usize, Vec<usize>>,
            state: &mut HashMap<usize, bool>,
            cyclic: &mut Vec<usize>,
        ) {
            match state.get(&id) {
                Some(true) => return,
                Some(false) => {
                    let from = stack.iter().position(|&x| x == id).unwrap_or(0);
                    for &x in &stack[from..] {
                        if !cyclic.contains(&x) {
                            cyclic.push(x);
                        }
                    }
                    return;
                }
                None => {}
            }
            state.insert(id, false);
            stack.push(id);
            for &n in edges.get(&id).map(Vec::as_slice).unwrap_or(&[]) {
                visit(n, stack, edges, state, cyclic);
            }
            stack.pop();
            state.insert(id, true);
        }
        for i in 0..self.ix.types.len() {
            if edges.contains_key(&i) {
                visit(i, &mut vec![], &edges, &mut state, &mut cyclic);
            }
        }
        for i in cyclic {
            let def = self.ix.types[i].def;
            let what = if ds(def, "kind") == "union" { "Union" } else { "Struct" };
            self.err(format!(
                "{what} '{}' contains itself by value (use vector, list, map or set to break the cycle)",
                ds(def, "name")
            ));
        }
    }

    // --------------------------------------------------------------- links ----

    fn validate_links(&mut self) {
        let ix = self.ix;
        for d in dups(dl(self.f, "links"), "name") {
            self.err(format!("Duplicate link name '{d}'"));
        }
        for le in &ix.links {
            let l = le.def;
            let ln = ds(l, "name");
            let from = le.from.clone().unwrap_or_default();
            let to = le.to.clone().unwrap_or_default();
            let null = Json::Null;
            let fp = le.from_port.unwrap_or(&null);
            let tp = le.to_port.unwrap_or(&null);
            let (fr, tr) = if in_subtree(&from, &to) {
                ("in", "in")
            } else if in_subtree(&to, &from) {
                ("out", "out")
            } else {
                ("out", "in")
            };
            if ds(fp, "role") != fr {
                self.err(format!("Link '{ln}': source port '{}' must be an '{fr}' port", ds(fp, "name")));
            }
            if ds(tp, "role") != tr {
                self.err(format!("Link '{ln}': target port '{}' must be an '{tr}' port", ds(tp, "name")));
            }
            // Imported ports use this project's interface of the same name.
            let mut foreign = 0;
            for (id, p) in [(&from, fp), (&to, tp)] {
                let nm = ds(p, "interface");
                if id.contains('/') && !nm.is_empty() && !ix.iface_idx.contains_key(&nm) {
                    self.err(format!(
                        "Link '{ln}': {id}:{} uses interface '{nm}', not defined in this project",
                        ds(p, "name")
                    ));
                    foreign += 1;
                }
            }
            if foreign == 0 && ds(fp, "interface") != ds(tp, "interface") {
                self.err(format!("Link '{ln}': ports use different interfaces"));
            }
            if from.contains('/') && to.contains('/') {
                self.err(format!("Link '{ln}' joins two imported modules: one end must be in this project"));
            }
            let c = &l["constraints"];
            let nm = ds(fp, "interface");
            let uni = ds(c, "direction") == "unidirectional";
            if let Some(&ii) = ix.iface_idx.get(&nm)
                && uni
            {
                for m in dl(ix.ifaces[ii].def, "messages") {
                    let outs =
                        dl(m, "params").iter().any(|p| dh(p, "direction") && ds(p, "direction") != "in");
                    if dh(m, "returns") {
                        self.err(format!(
                            "Link '{ln}' is unidirectional but {nm}.{} returns a value",
                            ds(m, "name")
                        ));
                    } else if outs {
                        self.err(format!(
                            "Link '{ln}' is unidirectional but {nm}.{} has out parameters",
                            ds(m, "name")
                        ));
                    }
                }
            }
            if uni && db(&c["ack"], "required") {
                self.err(format!("Link '{ln}' is unidirectional but requires an ack"));
            }
            let bf = self.binary_of(&from);
            let bt = self.binary_of(&to);
            let between = format!("binaries {bf} and {bt}");
            let x = &c["remote"];
            let transport = ds(x, "transport");
            if !bf.is_empty() && !bt.is_empty() && bf != bt && !db(x, "enabled") {
                self.err(format!("Link '{ln}' joins {between}: it must be remote"));
            } else if !bf.is_empty() && !bt.is_empty() && bf != bt && transport.is_empty() {
                self.err(format!("Link '{ln}' joins {between}: it needs a transport"));
            }
            let s = &x["settings"];
            if s.is_object() && db(x, "enabled") {
                let path = ds(s, "path");
                if (transport == "http" || transport == "websocket")
                    && !path.is_empty()
                    && !path.starts_with('/')
                {
                    self.err(format!("Link '{ln}': path '{path}' must start with '/'"));
                }
                if transport == "shm" && s.get("name").is_some() {
                    let nm = ds(s, "name");
                    let body = nm.strip_prefix('/').unwrap_or(&nm);
                    if body.is_empty() || body.contains('/') || nm.len() > 255 {
                        self.err(format!("Link '{ln}': shared memory name '{nm}' is not valid"));
                    }
                }
            }
        }
    }
}

/// Keys of the user types a reference names (pre-order).
fn ref_keys(t: &Json) -> Vec<String> {
    match ds(t, "kind").as_str() {
        "ref" => vec![ds(t, "name")],
        "map" => {
            let mut k = ref_keys(&t["key"]);
            k.extend(ref_keys(&t["value"]));
            k
        }
        "primitive" => vec![],
        _ => ref_keys(&t["of"]),
    }
}

/// Whether module id `inner` is `outer` or inside it (own modules; an imported one only itself).
fn in_subtree(outer: &str, inner: &str) -> bool {
    if outer == inner {
        return true;
    }
    if outer.contains('/') || inner.contains('/') {
        return false;
    }
    inner.starts_with(&format!("{outer}."))
}
