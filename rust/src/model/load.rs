// Reading a project file (src/model/serialize.ts loadText / fromFile): structure check against the
// schema, then names: duplicates and unknown references, reported with their line as the editor
// does. Builds the index validation and the generation context use.
use std::collections::{HashMap, HashSet};

use serde_json::Value as Json;

use super::schema::check_file;
use super::text::{DataPath, Doc, Format, Lines, Seg, parse_text};
use crate::path;

// ------------------------------------------------------------ access ----

/// Text of key `k`: "" when absent or null (numbers as JavaScript prints them).
pub fn ds(v: &Json, k: &str) -> String {
    match v.get(k) {
        None | Some(Json::Null) => String::new(),
        Some(Json::String(s)) => s.clone(),
        Some(x) => x.to_string(),
    }
}

/// Text of a value: "" for null.
pub fn txt(v: &Json) -> String {
    match v {
        Json::Null => String::new(),
        Json::String(s) => s.clone(),
        x => x.to_string(),
    }
}

static EMPTY: Vec<Json> = Vec::new();

/// Items of the list at key `k`: none when absent or null.
pub fn dl<'a>(v: &'a Json, k: &str) -> &'a [Json] {
    v.get(k).and_then(Json::as_array).map(Vec::as_slice).unwrap_or(&EMPTY)
}

/// Whether key `k` is present and not null.
pub fn dh(v: &Json, k: &str) -> bool {
    !matches!(v.get(k), None | Some(Json::Null))
}

/// Truth of key `k` as JavaScript's `!!`.
pub fn db(v: &Json, k: &str) -> bool {
    match v.get(k) {
        None | Some(Json::Null) => false,
        Some(Json::Bool(b)) => *b,
        Some(Json::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(Json::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn join(p: &DataPath, s: impl Into<Seg>) -> DataPath {
    let mut q = p.clone();
    q.push(s.into());
    q
}

// ------------------------------------------------------------- index ----

/// A type: own, of an own module, of a dependency or of a dependency's module.
pub struct TypeEntry<'a> {
    /// Name as the project references it: `Name`, `Core.Sensor.Mode`, `Dep/Core.Sensor.Mode`.
    pub key: String,
    pub def: &'a Json,
    /// Dependency it comes from ("": own).
    pub dep: String,
    /// Own module path ("" if none).
    pub module: String,
    /// Module path within a dependency ("" if none).
    pub modpath: String,
    pub path: DataPath,
}

pub struct IfaceEntry<'a> {
    pub def: &'a Json,
    pub dep: String,
}

pub struct ConstEntry<'a> {
    pub key: String,
    pub def: &'a Json,
    pub dep: String,
    pub module: String,
    pub path: DataPath,
}

/// An own module (depth first).
pub struct ModuleEntry<'a> {
    pub path: String,
    pub def: &'a Json,
    /// Index of the parent module.
    pub parent: Option<usize>,
    /// Binary it names (known ones).
    pub binary: String,
    /// Known bases.
    pub bases: Vec<String>,
}

/// A placed module of a dependency.
pub struct PlacedEntry<'a> {
    pub def: &'a Json,
}

pub struct LinkEntry<'a> {
    pub def: &'a Json,
    /// Module ids of its ends: own path, or `dep/path`; None when unknown.
    pub from: Option<String>,
    pub to: Option<String>,
    pub from_port: Option<&'a Json>,
    pub to_port: Option<&'a Json>,
}

#[derive(Default)]
pub struct Index<'a> {
    /// In the order of the editor's model: own, of own modules depth first, then each
    /// dependency's, then its modules'.
    pub types: Vec<TypeEntry<'a>>,
    pub type_idx: HashMap<String, usize>,
    pub ifaces: Vec<IfaceEntry<'a>>,
    pub iface_idx: HashMap<String, usize>,
    pub consts: Vec<ConstEntry<'a>>,
    pub modules: Vec<ModuleEntry<'a>>,
    pub module_idx: HashMap<String, usize>,
    pub placed: Vec<PlacedEntry<'a>>,
    pub placed_idx: HashMap<String, usize>,
    pub links: Vec<LinkEntry<'a>>,
    pub bin_idx: HashMap<String, usize>,
    pub dep_idx: HashMap<String, usize>,
}

/// Problems found while reading, as LoadError lists them.
struct Report<'l> {
    lines: &'l Lines,
    messages: Vec<String>,
}

impl Report<'_> {
    fn at(&mut self, msg: impl Into<String>, path: &DataPath) {
        let msg = msg.into();
        self.messages.push(match self.lines.of(path) {
            Some(l) => format!("Line {l}: {msg}"),
            None => msg,
        });
    }
    fn throw(&mut self) -> Result<(), String> {
        if self.messages.is_empty() { Ok(()) } else { Err(self.messages.join("\n")) }
    }
}

/// Reads a project file text: the file data (checked), its lines.
pub fn read_project(text: &str, format: Format) -> Result<Doc, String> {
    let mut doc = parse_text(text, format).map_err(|e| match e.line {
        Some(l) => format!("Line {l}: {}", e.message),
        None => e.message,
    })?;
    let mut r = Report { lines: &doc.lines, messages: vec![] };
    for i in check_file(&doc.value) {
        r.at(i.message, &i.path);
    }
    r.throw()?;
    deprecated_colors(&mut doc.value);
    Ok(doc)
}

/// The color of a module in the editor's style (deprecated) as its `color`.
fn deprecated_colors(f: &mut Json) {
    let style = f.get("editor").and_then(|e| e.get("style")).cloned();
    let Some(style) = style else { return };
    fn walk(list: &mut Json, parent: &str, style: &Json) {
        let Some(items) = list.as_array_mut() else { return };
        for m in items {
            let path = if parent.is_empty() { ds(m, "name") } else { format!("{parent}.{}", ds(m, "name")) };
            if !dh(m, "color")
                && let Some(c) = style.get(&path).and_then(|s| s.get("color")).filter(|c| !c.is_null())
            {
                m["color"] = c.clone();
            }
            if let Some(sub) = m.get_mut("modules") {
                walk(sub, &path, style);
            }
        }
    }
    if let Some(ms) = f.get_mut("modules") {
        walk(ms, "", &style);
    }
}

/// Names of a read project: duplicates and unknown references (errors), and its index.
pub fn index_project<'a>(f: &'a Json, lines: &Lines) -> Result<Index<'a>, String> {
    let mut b =
        IndexBuilder { ix: Index::default(), r: Report { lines, messages: vec![] }, decl: HashMap::new() };
    b.names(f);
    b.r.throw()?;
    Ok(b.ix)
}

struct IndexBuilder<'a, 'l> {
    ix: Index<'a>,
    r: Report<'l>,
    /// Names declared in the namespace of types and interfaces: what.
    decl: HashMap<String, &'static str>,
}

impl<'a> IndexBuilder<'a, '_> {
    fn names(&mut self, f: &'a Json) {
        for (i, b) in dl(f, "binaries").iter().enumerate() {
            let n = ds(b, "name");
            if self.ix.bin_idx.contains_key(&n) {
                self.r.at(format!("Duplicate binary '{n}'"), &path!["binaries", i, "name"]);
            }
            self.ix.bin_idx.insert(n, i);
        }
        let deps = dl(f, "dependencies");
        for (i, d) in deps.iter().enumerate() {
            let n = ds(d, "name");
            if self.ix.dep_idx.contains_key(&n) {
                self.r.at(format!("Duplicate dependency '{n}'"), &path!["dependencies", i, "name"]);
            }
            self.ix.dep_idx.insert(n, i);
        }
        for (i, d) in deps.iter().enumerate() {
            for (j, u) in dl(d, "uses").iter().enumerate() {
                let u = txt(u);
                if !self.ix.dep_idx.contains_key(&u) {
                    self.r.at(
                        format!("Dependency '{}' uses unknown dependency '{u}'", ds(d, "name")),
                        &path!["dependencies", i, "uses", j],
                    );
                }
            }
        }

        // Types (own, of own modules, of dependencies, of their modules) and interfaces share a namespace.
        for (i, t) in dl(f, "types").iter().enumerate() {
            self.add_type(t, ds(t, "name"), "", "", "", path!["types", i]);
        }
        self.module_types(f, "", path![]);
        for (i, d) in deps.iter().enumerate() {
            let dn = ds(d, "name");
            for (j, t) in dl(d, "types").iter().enumerate() {
                self.add_type(t, ds(t, "name"), &dn, "", "", path!["dependencies", i, "types", j]);
            }
            for (g, mt) in dl(d, "moduleTypes").iter().enumerate() {
                let m = ds(mt, "module");
                for (j, t) in dl(mt, "types").iter().enumerate() {
                    let key = format!("{dn}/{m}.{}", ds(t, "name"));
                    self.add_type(
                        t,
                        key,
                        &dn,
                        "",
                        &m,
                        path!["dependencies", i, "moduleTypes", g, "types", j],
                    );
                }
            }
        }
        for (i, x) in dl(f, "interfaces").iter().enumerate() {
            self.add_iface(x, "", path!["interfaces", i]);
        }
        for (i, d) in deps.iter().enumerate() {
            for (j, x) in dl(d, "interfaces").iter().enumerate() {
                self.add_iface(x, &ds(d, "name"), path!["dependencies", i, "interfaces", j]);
            }
        }

        // Constants share the namespace too (those of modules, their module's).
        for (i, c) in dl(f, "constants").iter().enumerate() {
            self.add_const(c, ds(c, "name"), "", "", path!["constants", i]);
        }
        self.module_consts(f, "", path![]);
        for (i, d) in deps.iter().enumerate() {
            let dn = ds(d, "name");
            for (j, c) in dl(d, "constants").iter().enumerate() {
                self.add_const(c, ds(c, "name"), &dn, "", path!["dependencies", i, "constants", j]);
            }
            for (g, mc) in dl(d, "moduleConstants").iter().enumerate() {
                let m = ds(mc, "module");
                for (j, c) in dl(mc, "constants").iter().enumerate() {
                    let key = format!("{dn}/{m}.{}", ds(c, "name"));
                    self.add_const(
                        c,
                        key,
                        &dn,
                        "",
                        path!["dependencies", i, "moduleConstants", g, "constants", j],
                    );
                }
            }
        }
        let mut const_keys = HashSet::new();
        for c in &self.ix.consts {
            if self.decl.contains_key(&c.key) || const_keys.contains(&c.key) {
                self.r.at(format!("Duplicate constant name '{}'", c.key), &join(&c.path, "name"));
            }
            const_keys.insert(c.key.clone());
        }

        // References of the types, constants and interfaces.
        for i in 0..self.ix.types.len() {
            let (def, p) = (self.ix.types[i].def, self.ix.types[i].path.clone());
            self.type_refs(def, &p);
        }
        for i in 0..self.ix.consts.len() {
            let (def, key, p) =
                (self.ix.consts[i].def, self.ix.consts[i].key.clone(), self.ix.consts[i].path.clone());
            self.type_ref(def.get("type"), &key, &join(&p, "type"));
        }
        for i in 0..self.ix.ifaces.len() {
            let def = self.ix.ifaces[i].def;
            let p = self.iface_path(f, i);
            self.messages(dl(def, "messages"), &ds(def, "name"), &join(&p, "messages"));
        }

        self.modules(dl(f, "modules"), None, "", &path!["modules"]);
        for i in 0..self.ix.modules.len() {
            self.bases(f, i);
        }
        self.placed_modules(deps);

        for (i, x) in dl(f, "links").iter().enumerate() {
            let n = ds(x, "name");
            let p = path!["links", i];
            let (from, from_port) =
                self.endpoint(x.get("from"), &format!("Link '{n}' from"), &join(&p, "from"));
            let (to, to_port) = self.endpoint(x.get("to"), &format!("Link '{n}' to"), &join(&p, "to"));
            self.ix.links.push(LinkEntry { def: x, from, to, from_port, to_port });
        }
    }

    /// Data path of the i-th interface of the index.
    fn iface_path(&self, f: &Json, i: usize) -> DataPath {
        let own = dl(f, "interfaces").len();
        if i < own {
            return path!["interfaces", i];
        }
        let mut k = i - own;
        for (di, d) in dl(f, "dependencies").iter().enumerate() {
            let n = dl(d, "interfaces").len();
            if k < n {
                return path!["dependencies", di, "interfaces", k];
            }
            k -= n;
        }
        path![]
    }

    fn declare(&mut self, key: &str, what: &'static str, p: &DataPath) {
        if self.decl.contains_key(key) {
            self.r.at(format!("Duplicate {what} name '{key}'"), p);
        }
        self.decl.insert(key.to_string(), what);
    }

    fn add_type(&mut self, t: &'a Json, key: String, dep: &str, module: &str, modpath: &str, p: DataPath) {
        self.declare(&key, "type", &join(&p, "name"));
        self.ix.type_idx.insert(key.clone(), self.ix.types.len());
        self.ix.types.push(TypeEntry {
            key,
            def: t,
            dep: dep.into(),
            module: module.into(),
            modpath: modpath.into(),
            path: p,
        });
    }

    fn module_types(&mut self, parent_def: &'a Json, parent: &str, p: DataPath) {
        for (i, m) in dl(parent_def, "modules").iter().enumerate() {
            let path = if parent.is_empty() { ds(m, "name") } else { format!("{parent}.{}", ds(m, "name")) };
            let mp = join(&join(&p, "modules"), i);
            for (j, t) in dl(m, "types").iter().enumerate() {
                let key = format!("{path}.{}", ds(t, "name"));
                self.add_type(t, key, "", &path, "", join(&join(&mp, "types"), j));
            }
            self.module_types(m, &path, mp);
        }
    }

    fn module_consts(&mut self, parent_def: &'a Json, parent: &str, p: DataPath) {
        for (i, m) in dl(parent_def, "modules").iter().enumerate() {
            let path = if parent.is_empty() { ds(m, "name") } else { format!("{parent}.{}", ds(m, "name")) };
            let mp = join(&join(&p, "modules"), i);
            for (j, c) in dl(m, "constants").iter().enumerate() {
                let key = format!("{path}.{}", ds(c, "name"));
                self.add_const(c, key, "", &path, join(&join(&mp, "constants"), j));
            }
            self.module_consts(m, &path, mp);
        }
    }

    fn add_const(&mut self, c: &'a Json, key: String, dep: &str, module: &str, p: DataPath) {
        self.ix.consts.push(ConstEntry { key, def: c, dep: dep.into(), module: module.into(), path: p });
    }

    fn add_iface(&mut self, x: &'a Json, dep: &str, p: DataPath) {
        let n = ds(x, "name");
        self.declare(&n, "interface", &join(&p, "name"));
        self.ix.iface_idx.insert(n, self.ix.ifaces.len());
        self.ix.ifaces.push(IfaceEntry { def: x, dep: dep.into() });
    }

    fn is_type(&self, name: &str) -> bool {
        self.ix.type_idx.contains_key(name) && !self.ix.iface_idx.contains_key(name)
    }

    /// A type reference: every user type it names must be a type (not an interface).
    fn type_ref(&mut self, t: Option<&Json>, where_: &str, p: &DataPath) {
        let Some(t) = t.filter(|t| t.is_object()) else { return };
        match ds(t, "kind").as_str() {
            "ref" => {
                let name = ds(t, "name");
                if !self.is_type(&name) {
                    self.r.at(format!("{where_}: unknown type '{name}'"), p);
                }
            }
            "map" => {
                self.type_ref(t.get("key"), where_, p);
                self.type_ref(t.get("value"), where_, p);
            }
            "primitive" => {}
            _ => self.type_ref(t.get("of"), where_, p),
        }
    }

    fn fields(&mut self, list: &[Json], where_: &str, p: &DataPath) {
        for (i, x) in list.iter().enumerate() {
            self.type_ref(x.get("type"), &format!("{where_}.{}", ds(x, "name")), &join(&join(p, i), "type"));
        }
    }

    fn type_refs(&mut self, t: &Json, p: &DataPath) {
        let name = ds(t, "name");
        match ds(t, "kind").as_str() {
            "struct" | "exception" => self.fields(dl(t, "fields"), &name, &join(p, "fields")),
            "union" => {
                self.type_ref(
                    t.get("discriminator"),
                    &format!("{name} discriminator"),
                    &join(p, "discriminator"),
                );
                self.fields(dl(t, "cases"), &name, &join(p, "cases"));
            }
            "alias" => self.type_ref(t.get("type"), &name, &join(p, "type")),
            _ => {}
        }
    }

    /// Messages of an interface or methods of a module (`owner`).
    fn messages(&mut self, list: &[Json], owner: &str, p: &DataPath) {
        for (i, m) in list.iter().enumerate() {
            let where_ = format!("{owner}.{}", ds(m, "name"));
            let mp = join(p, i);
            for (j, x) in dl(m, "params").iter().enumerate() {
                self.type_ref(
                    x.get("type"),
                    &format!("{where_}.{}", ds(x, "name")),
                    &join(&join(&join(&mp, "params"), j), "type"),
                );
            }
            if dh(m, "returns") {
                self.type_ref(m.get("returns"), &format!("{where_} returns"), &join(&mp, "returns"));
            }
            for (j, r) in dl(m, "raises").iter().enumerate() {
                let r = txt(r);
                if !self.is_type(&r) {
                    self.r.at(
                        format!("{where_} raises: unknown exception '{r}'"),
                        &join(&join(&mp, "raises"), j),
                    );
                }
            }
        }
    }

    fn modules(&mut self, list: &'a [Json], parent: Option<usize>, parent_path: &str, p: &DataPath) {
        let mut seen = HashSet::new();
        for (i, m) in list.iter().enumerate() {
            let name = ds(m, "name");
            let path = if parent_path.is_empty() { name.clone() } else { format!("{parent_path}.{name}") };
            let mp = join(p, i);
            if !seen.insert(name) {
                self.r.at(format!("Duplicate module '{path}'"), &join(&mp, "name"));
            }
            let idx = self.ix.modules.len();
            self.ix.module_idx.insert(path.clone(), idx);
            self.ix.modules.push(ModuleEntry {
                path: path.clone(),
                def: m,
                parent,
                binary: String::new(),
                bases: vec![],
            });
            self.fields(dl(m, "attributes"), &path, &join(&mp, "attributes"));
            self.messages(dl(m, "methods"), &path, &join(&mp, "methods"));
            let mut ports = HashSet::new();
            for (j, pt) in dl(m, "ports").iter().enumerate() {
                let pn = ds(pt, "name");
                let pp = join(&join(&mp, "ports"), j);
                if !ports.insert(pn.clone()) {
                    self.r.at(format!("Duplicate port '{path}:{pn}'"), &join(&pp, "name"));
                }
                let iname = ds(pt, "interface");
                if !iname.is_empty() && !self.ix.iface_idx.contains_key(&iname) {
                    self.r.at(
                        format!("Port '{path}:{pn}': unknown interface '{iname}'"),
                        &join(&pp, "interface"),
                    );
                }
            }
            let b = ds(m, "binary");
            if !b.is_empty() {
                if !parent_path.is_empty() {
                    self.r.at(
                        format!("Module '{path}': only top-level modules name their binary"),
                        &join(&mp, "binary"),
                    );
                } else if !self.ix.bin_idx.contains_key(&b) {
                    self.r.at(format!("Module '{path}': unknown binary '{b}'"), &join(&mp, "binary"));
                } else {
                    self.ix.modules[idx].binary = b;
                }
            }
            self.modules(dl(m, "modules"), Some(idx), &path, &join(&mp, "modules"));
        }
    }

    fn module_data_path(&self, i: usize, f: &Json) -> DataPath {
        // Rebuild the data path of a module from its path.
        let mut p = path![];
        let mut list = dl(f, "modules");
        for part in self.ix.modules[i].path.split('.') {
            let Some(k) = list.iter().position(|m| ds(m, "name") == part) else { break };
            p.push(Seg::Key("modules".into()));
            p.push(Seg::Idx(k));
            list = dl(&list[k], "modules");
        }
        p
    }

    fn bases(&mut self, f: &Json, i: usize) {
        let m = self.ix.modules[i].def;
        let mut known = vec![];
        for (j, b) in dl(m, "bases").iter().enumerate() {
            let b = txt(b);
            if !self.ix.module_idx.contains_key(&b) {
                let p = join(&join(&self.module_data_path(i, f), "bases"), j);
                self.r.at(format!("Module '{}': unknown base '{b}'", self.ix.modules[i].path), &p);
            } else {
                known.push(b);
            }
        }
        self.ix.modules[i].bases = known;
    }

    /// Placed modules of dependencies.
    fn placed_modules(&mut self, deps: &'a [Json]) {
        for (i, d) in deps.iter().enumerate() {
            let dn = ds(d, "name");
            let mut seen = HashSet::new();
            for (j, m) in dl(d, "modules").iter().enumerate() {
                let mp = path!["dependencies", i, "modules", j];
                let mpath = ds(m, "module");
                let where_ = format!("Dependency '{dn}' module '{mpath}'");
                if !seen.insert(mpath.clone()) {
                    self.r.at(format!("{where_}: listed more than once"), &join(&mp, "module"));
                }
                let key = format!("{dn}/{mpath}");
                self.ix.placed_idx.insert(key.clone(), self.ix.placed.len());
                self.ix.placed.push(PlacedEntry { def: m });
                self.fields(dl(m, "attributes"), &key, &join(&mp, "attributes"));
                self.messages(dl(m, "methods"), &key, &join(&mp, "methods"));
                let mut ports = HashSet::new();
                for (k, pt) in dl(m, "ports").iter().enumerate() {
                    let pn = ds(pt, "name");
                    if !ports.insert(pn.clone()) {
                        self.r.at(
                            format!("{where_}: duplicate port '{pn}'"),
                            &path!["dependencies", i, "modules", j, "ports", k, "name"],
                        );
                    }
                }
            }
        }
    }

    /// Module id of a link end (None when unknown), and its port.
    fn endpoint(
        &mut self,
        e: Option<&'a Json>,
        where_: &str,
        p: &DataPath,
    ) -> (Option<String>, Option<&'a Json>) {
        let Some(e) = e else { return (None, None) };
        let module = ds(e, "module");
        let port = ds(e, "port");
        if dh(e, "project") {
            let proj = ds(e, "project");
            let key = format!("{proj}/{module}");
            if !self.ix.dep_idx.contains_key(&proj) {
                self.r.at(format!("{where_}: unknown dependency '{proj}'"), &join(p, "project"));
                return (None, None);
            }
            let Some(&x) = self.ix.placed_idx.get(&key) else {
                self.r.at(
                    format!("{where_}: module '{module}' is not placed from dependency '{proj}'"),
                    &join(p, "module"),
                );
                return (None, None);
            };
            let Some(pt) = port_of(self.ix.placed[x].def, &port) else {
                self.r.at(format!("{where_}: unknown port '{proj}/{module}:{port}'"), &join(p, "port"));
                return (None, None);
            };
            return (Some(key), Some(pt));
        }
        let Some(&x) = self.ix.module_idx.get(&module) else {
            self.r.at(format!("{where_}: unknown module '{module}'"), &join(p, "module"));
            return (None, None);
        };
        let Some(pt) = port_of(self.ix.modules[x].def, &port) else {
            self.r.at(format!("{where_}: unknown port '{module}:{port}'"), &join(p, "port"));
            return (None, None);
        };
        (Some(module), Some(pt))
    }
}

pub fn port_of<'a>(m: &'a Json, name: &str) -> Option<&'a Json> {
    dl(m, "ports").iter().find(|p| ds(p, "name") == name)
}
