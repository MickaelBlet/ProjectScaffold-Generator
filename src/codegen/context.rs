// Generation context (src/codegen/context.ts): the project file, resolved for templates. Language
// neutral: names only, every optional value present (templates run with strict variables), modules
// flattened with their links sorted into wiring at the right level.
use std::collections::{BTreeMap, HashMap};

use serde_json::Value as Json;

use super::filters::snake;
use super::node::{Arena, Id};
use crate::model::load::{db, dh, dl, ds};

/// Identifier made from a project name, as dependencies name the project (dependencies.ts).
pub fn dependency_name(name: &str) -> String {
    let mut id = String::new();
    let mut in_run = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            id.push(c);
            in_run = false;
        } else if !in_run {
            id.push('_');
            in_run = true;
        }
    }
    let id = id.trim_matches('_');
    if id.is_empty() {
        return "Other".into();
    }
    if id.starts_with(|c: char| c.is_ascii_digit()) { format!("_{id}") } else { id.to_string() }
}

fn null() -> Json {
    Json::Null
}

/// Value of key `k`, null when absent.
fn dn(v: &Json, k: &str) -> Json {
    v.get(k).cloned().unwrap_or_else(null)
}

struct Placed<'a> {
    kind: String,
    dep: String,
    module: String,
    def: &'a Json,
}

struct Ctx<'a> {
    a: Arena,
    /// Type definitions by key, the first winning.
    to: HashMap<String, Placed<'a>>,
    /// Context types by key, the first winning.
    type_by_key: HashMap<String, Id>,
    iface_by_name: HashMap<String, Id>,
    by_path: HashMap<String, Id>,
    bases_of: Vec<(Id, Vec<String>)>,
    modules: Vec<Id>,
    module_types: Vec<Id>,
}

/// The generation context of a project file (checked): its arena and root.
pub fn build_context(file: &Json) -> (Arena, Id) {
    let mut c = Ctx {
        a: Arena::default(),
        to: HashMap::new(),
        type_by_key: HashMap::new(),
        iface_by_name: HashMap::new(),
        by_path: HashMap::new(),
        bases_of: vec![],
        modules: vec![],
        module_types: vec![],
    };
    let root = c.build(file);
    (c.a, root)
}

/// Fields of the settings of a built-in transport (transports.ts).
fn transport_fields(t: &str) -> &'static [&'static str] {
    match t {
        "ipc" => &["socket"],
        "shm" => &["name", "capacity"],
        "mq" => &["name", "maxMessages", "messageSize"],
        "tcp" | "udp" | "grpc" => &["client", "server"],
        "http" | "websocket" => &["client", "server", "path"],
        "mqtt" => &["broker", "topic"],
        "can" => &["interface", "id"],
        "serial" => &["device", "baud"],
        _ => &[],
    }
}

/// Children to go through from the module at `scope` ("": the system) to the module at `path`.
fn via(scope: &str, path: &str) -> Vec<String> {
    let s = if scope.is_empty() { 0 } else { scope.split('.').count() };
    path.split('.').skip(s).map(String::from).collect()
}

/// Types, interfaces and constants of a project and of its dependencies (context ids).
struct Entities {
    types: Vec<Id>,
    interfaces: Vec<Id>,
    constants: Vec<Id>,
    dep_nodes: Vec<Id>,
    all_types: Vec<Id>,
    all_ifaces: Vec<Id>,
    /// Module types of the dependencies.
    dep_mtypes: Vec<Id>,
}

/// The binaries and their systems (one for the whole project without binaries).
struct Systems {
    binaries: Vec<Id>,
    systems: Vec<Id>,
    /// Binary (index) of each top-level module, by name.
    bin_of_top: HashMap<String, usize>,
}

impl Systems {
    /// The system holding module `path`.
    fn at(&self, path: &str) -> Option<Id> {
        if self.binaries.is_empty() {
            return Some(self.systems[0]);
        }
        let t = path.split('.').next().unwrap_or("");
        self.bin_of_top.get(t).map(|&j| self.systems[j])
    }
}

/// `remoteDefaults` of a project, defaults applied.
struct RemoteDefaults {
    client_host: String,
    server_host: String,
    base_port: i64,
}

impl RemoteDefaults {
    fn of(file: &Json) -> RemoteDefaults {
        let rd = &file["remoteDefaults"];
        let host = |end: &str| if dh(&rd[end], "host") { ds(&rd[end], "host") } else { "127.0.0.1".into() };
        RemoteDefaults {
            client_host: host("client"),
            server_host: host("server"),
            base_port: if dh(rd, "basePort") { rd["basePort"].as_i64().unwrap_or(47000) } else { 47000 },
        }
    }
}

/// The links of a project and those between binaries.
struct Remote {
    links: Vec<Id>,
    /// Interfaces of the links between binaries, the last of each name winning.
    interfaces: Vec<Id>,
    interface_index: HashMap<String, usize>,
    links_between: Vec<Id>,
}

/// Both ends of a link between binaries: systems, endpoints, modules and ports.
struct Ends {
    at: Id,
    peer: Id,
    cf: Id,
    ct: Id,
    fm: String,
    fport: String,
    tm: String,
    tport: String,
}

impl<'a> Ctx<'a> {
    fn place(&mut self, key: String, t: &'a Json, dep: &str, module: &str) {
        self.to.entry(key).or_insert(Placed {
            kind: ds(t, "kind"),
            dep: dep.into(),
            module: module.into(),
            def: t,
        });
    }

    fn place_modules(&mut self, list: &'a [Json], parent: &str) {
        for m in list {
            let path = if parent.is_empty() { ds(m, "name") } else { format!("{parent}.{}", ds(m, "name")) };
            for t in dl(m, "types") {
                self.place(format!("{path}.{}", ds(t, "name")), t, "", &path);
            }
            self.place_modules(dl(m, "modules"), &path);
        }
    }

    fn strs(&mut self, items: &[String]) -> Id {
        let ids = items.iter().map(|s| self.a.str(s.clone())).collect();
        self.a.list(ids)
    }

    /// Sets scope (list) and flatName of `d`, a type or reference named `name` in `module`.
    fn scoped(&mut self, d: Id, name: &str, module: &str) {
        let parts: Vec<String> =
            if module.is_empty() { vec![] } else { module.split('.').map(String::from).collect() };
        let flat: String = parts.iter().map(|p| format!("{p}_")).collect();
        let scope = self.strs(&parts);
        self.a.set(d, "scope", scope);
        let f = self.a.str(format!("{flat}{name}"));
        self.a.set(d, "flatName", f);
    }

    fn put(&mut self, m: Id, k: &str, v: Json) {
        let x = self.a.json(v);
        self.a.set(m, k, x);
    }

    fn put_str(&mut self, m: Id, k: &str, s: impl Into<String>) {
        let x = self.a.str(s);
        self.a.set(m, k, x);
    }

    fn put_null_or(&mut self, m: Id, k: &str, s: &str) {
        let x = self.a.null_or(s);
        self.a.set(m, k, x);
    }

    fn put_bool(&mut self, m: Id, k: &str, b: bool) {
        let x = self.a.bool(b);
        self.a.set(m, k, x);
    }

    /// An active module's settings, defaults applied (`active: true` takes them all); null when not active.
    fn active(&mut self, m: &Json) -> Id {
        let a = &m["active"];
        if !(a.as_bool() == Some(true) || a.is_object()) {
            return self.a.null();
        }
        let int = |k: &str, d: i64| if dh(a, k) { a[k].as_i64().unwrap_or(d) } else { d };
        let overflow = if dh(a, "overflow") { ds(a, "overflow") } else { "block".into() };
        self.json_map(serde_json::json!({
            "queue": int("queue", 64),
            "timeoutMs": int("timeoutMs", 5000),
            "overflow": overflow,
        }))
    }

    fn empty_list(&mut self) -> Id {
        self.a.list(vec![])
    }

    /// Resolved type reference: refs with their kind and owner, every bound present (null when none).
    fn type_ref(&mut self, t: &Json) -> Id {
        let k = ds(t, "kind");
        let r = self.a.map();
        self.put_str(r, "kind", k.clone());
        match k.as_str() {
            "primitive" => {
                self.put(r, "name", dn(t, "name"));
                self.put(r, "max", dn(t, "max"));
            }
            "ref" => {
                let key = ds(t, "name");
                let name = key.rsplit('.').next().unwrap_or("").to_string();
                let (kind, dep, module) = match self.to.get(&key) {
                    Some(p) => (p.kind.clone(), p.dep.clone(), p.module.clone()),
                    None => ("primitive".into(), String::new(), String::new()),
                };
                self.put_str(r, "name", name.clone());
                self.put_str(r, "typeKind", kind);
                self.put_null_or(r, "dependency", &dep);
                self.put_str(r, "key", key);
                self.scoped(r, &name, &module);
            }
            "array" => {
                let of = self.type_ref(&t["of"]);
                self.a.set(r, "of", of);
                self.put(r, "size", dn(t, "size"));
            }
            "optional" => {
                let of = self.type_ref(&t["of"]);
                self.a.set(r, "of", of);
            }
            "map" => {
                let key = self.type_ref(&t["key"]);
                self.a.set(r, "key", key);
                let value = self.type_ref(&t["value"]);
                self.a.set(r, "value", value);
                self.put(r, "max", dn(t, "max"));
            }
            _ => {
                let of = self.type_ref(&t["of"]);
                self.a.set(r, "of", of);
                self.put(r, "max", dn(t, "max"));
            }
        }
        r
    }

    /// A discriminator value no label is: for the default case of a union; null when none.
    fn unused_label(&self, t: &Json, used: &std::collections::HashSet<String>, depth: usize) -> Json {
        match ds(t, "kind").as_str() {
            "ref" => {
                let Some(p) = self.to.get(&ds(t, "name")) else { return Json::Null };
                let def = p.def;
                match ds(def, "kind").as_str() {
                    "alias" if depth < 32 => self.unused_label(&def["type"], used, depth + 1),
                    "enum" => dl(def, "values")
                        .iter()
                        .map(|v| ds(v, "name"))
                        .find(|n| !used.contains(n))
                        .map(Json::String)
                        .unwrap_or(Json::Null),
                    _ => Json::Null,
                }
            }
            "primitive" => match ds(t, "name").as_str() {
                "bool" => {
                    if !used.contains("true") {
                        Json::Bool(true)
                    } else if !used.contains("false") {
                        Json::Bool(false)
                    } else {
                        Json::Null
                    }
                }
                "char" => (32u8..127)
                    .map(|c| (c as char).to_string())
                    .find(|c| !used.contains(c))
                    .map(Json::String)
                    .unwrap_or(Json::Null),
                _ => (0i64..).find(|n| !used.contains(&n.to_string())).map(Json::from).unwrap_or(Json::Null),
            },
            _ => Json::Null,
        }
    }

    fn field(&mut self, f: &Json) -> Id {
        let g = self.a.map();
        self.put(g, "name", dn(f, "name"));
        let t = self.type_ref(&f["type"]);
        self.a.set(g, "type", t);
        self.put_str(g, "description", ds(f, "description"));
        self.put_bool(g, "hasDefault", f.get("default").is_some());
        self.put(g, "default", dn(f, "default"));
        g
    }

    fn fields(&mut self, list: &[Json]) -> Id {
        let ids = list.iter().map(|f| self.field(f)).collect();
        self.a.list(ids)
    }

    fn no_uses(&mut self) -> Id {
        let u = self.a.map();
        let t = self.empty_list();
        self.a.set(u, "types", t);
        let b = self.empty_list();
        self.a.set(u, "builtins", b);
        u
    }

    /// Type of the file, of `dependency` ("" for the project's), of the module at `module` ("" none).
    fn type_def(&mut self, t: &Json, dependency: &str, module: &str) -> Id {
        let name = ds(t, "name");
        let k = ds(t, "kind");
        let g = self.a.map();
        self.put_str(g, "entity", "type");
        self.put_str(g, "name", name.clone());
        self.put_str(g, "description", ds(t, "description"));
        self.put_null_or(g, "dependency", dependency);
        let u = self.no_uses();
        self.a.set(g, "uses", u);
        let key = if module.is_empty() {
            name.clone()
        } else if dependency.is_empty() {
            format!("{module}.{name}")
        } else {
            format!("{dependency}/{module}.{name}")
        };
        self.put_str(g, "key", key);
        self.put_null_or(g, "module", module);
        let access = ds(t, "access");
        self.put_str(g, "access", if access.is_empty() { "public".to_string() } else { access });
        self.scoped(g, &name, module);
        self.put_str(g, "kind", k.clone());
        match k.as_str() {
            "struct" | "exception" => {
                let fs = self.fields(dl(t, "fields"));
                self.a.set(g, "fields", fs);
            }
            "enum" => {
                self.put(g, "underlying", dn(t, "underlying"));
                let vals: Vec<Json> = dl(t, "values")
                    .iter()
                    .map(|v| serde_json::json!({"name": dn(v, "name"), "value": dn(v, "value")}))
                    .collect();
                let ids = vals.into_iter().map(|v| self.json_map(v)).collect();
                let l = self.a.list(ids);
                self.a.set(g, "values", l);
            }
            "bitmask" => {
                self.put(g, "underlying", dn(t, "underlying"));
                let flags: Vec<Json> = dl(t, "flags")
                    .iter()
                    .map(|v| {
                        let bit = v["bit"].as_u64().unwrap_or(0);
                        let value = if bit < 128 { (1u128 << bit).to_string() } else { String::new() };
                        serde_json::json!({"name": dn(v, "name"), "bit": dn(v, "bit"), "value": value})
                    })
                    .collect();
                let ids = flags.into_iter().map(|v| self.json_map(v)).collect();
                let l = self.a.list(ids);
                self.a.set(g, "flags", l);
            }
            "union" => {
                let cases = dl(t, "cases");
                let mut used = std::collections::HashSet::new();
                for c in cases {
                    for l in dl(c, "labels") {
                        used.insert(match l {
                            Json::Bool(b) => b.to_string(),
                            Json::Null => "null".into(),
                            Json::String(s) => s.clone(),
                            x => x.to_string(),
                        });
                    }
                }
                let d = self.type_ref(&t["discriminator"]);
                self.a.set(g, "discriminator", d);
                let mut has_default = false;
                let mut ids = vec![];
                for (i, c) in cases.iter().enumerate() {
                    if db(c, "default") {
                        has_default = true;
                    }
                    let x = self.a.map();
                    self.put(x, "name", dn(c, "name"));
                    let ct = self.type_ref(&c["type"]);
                    self.a.set(x, "type", ct);
                    self.put_str(x, "description", ds(c, "description"));
                    let labels = dl(c, "labels");
                    self.put(x, "labels", Json::Array(labels.to_vec()));
                    self.put_bool(x, "isDefault", db(c, "default"));
                    let lab = if let Some(l) = labels.first() {
                        l.clone()
                    } else if db(c, "default") {
                        self.unused_label(&t["discriminator"], &used, 0)
                    } else {
                        Json::Null
                    };
                    self.put(x, "label", lab);
                    self.put(x, "index", Json::from(i + 1));
                    ids.push(x);
                }
                self.put_bool(g, "hasDefault", has_default);
                let l = self.a.list(ids);
                self.a.set(g, "cases", l);
            }
            "alias" => {
                let r = self.type_ref(&t["type"]);
                self.a.set(g, "type", r);
            }
            _ => {}
        }
        g
    }

    /// A JSON object as a map node (its values kept as JSON).
    fn json_map(&mut self, v: Json) -> Id {
        let m = self.a.map();
        if let Json::Object(o) = v {
            for (k, x) in o {
                self.put(m, &k, x);
            }
        }
        m
    }

    fn message(&mut self, m: &Json) -> Id {
        let mut params = vec![];
        let mut ins = vec![];
        let mut outs = vec![];
        for p in dl(m, "params") {
            let x = self.a.map();
            self.put(x, "name", dn(p, "name"));
            let t = self.type_ref(&p["type"]);
            self.a.set(x, "type", t);
            self.put_str(x, "description", ds(p, "description"));
            let dir = if dh(p, "direction") { ds(p, "direction") } else { "in".into() };
            self.put_str(x, "direction", dir.clone());
            self.put_bool(x, "const", db(p, "const"));
            params.push(x);
            if dir != "out" {
                ins.push(x);
            }
            if dir != "in" {
                outs.push(x);
            }
        }
        let g = self.a.map();
        self.put(g, "name", dn(m, "name"));
        self.put_str(g, "description", ds(m, "description"));
        let l = self.a.list(params);
        self.a.set(g, "params", l);
        let l = self.a.list(ins);
        self.a.set(g, "inputs", l);
        let l = self.a.list(outs);
        self.a.set(g, "outputs", l);
        let r = if dh(m, "returns") { self.type_ref(&m["returns"]) } else { self.a.null() };
        self.a.set(g, "returns", r);
        let raises = dl(m, "raises")
            .iter()
            .map(|r| self.type_ref(&serde_json::json!({"kind": "ref", "name": r})))
            .collect();
        let l = self.a.list(raises);
        self.a.set(g, "raises", l);
        g
    }

    fn iface(&mut self, i: &Json, dependency: &str) -> Id {
        let g = self.a.map();
        self.put_str(g, "entity", "interface");
        self.put(g, "name", dn(i, "name"));
        self.put_str(g, "description", ds(i, "description"));
        self.put_null_or(g, "dependency", dependency);
        let ms = dl(i, "messages").iter().map(|m| self.message(m)).collect();
        let l = self.a.list(ms);
        self.a.set(g, "messages", l);
        let u = self.no_uses();
        self.a.set(g, "uses", u);
        g
    }

    fn constant(&mut self, c: &Json, dependency: &str) -> Id {
        let g = self.a.map();
        self.put_str(g, "entity", "constant");
        self.put(g, "name", dn(c, "name"));
        self.put_str(g, "description", ds(c, "description"));
        self.put_null_or(g, "dependency", dependency);
        let t = self.type_ref(&c["type"]);
        self.a.set(g, "type", t);
        self.put(g, "value", dn(c, "value"));
        g
    }

    // ---------------------------------------------------------------- uses ----

    /// Adds the user types (by key) and builtins a reference uses.
    fn walk(
        &self,
        r: Id,
        types: &mut BTreeMap<String, Id>,
        builtins: &mut std::collections::BTreeSet<String>,
    ) {
        let k = self.a.s(r, "kind");
        if k == "ref" {
            let key = self.a.s(r, "key");
            if let Some(&t) = self.type_by_key.get(&key) {
                types.insert(key, t);
            }
            return;
        }
        builtins.insert(if k == "primitive" { self.a.s(r, "name") } else { k.clone() });
        if k == "map" {
            if let Some(x) = self.a.get(r, "key") {
                self.walk(x, types, builtins);
            }
            if let Some(x) = self.a.get(r, "value") {
                self.walk(x, types, builtins);
            }
        } else if k != "primitive"
            && let Some(x) = self.a.get(r, "of")
        {
            self.walk(x, types, builtins);
        }
    }

    /// Uses of references: {types (by name then key), builtins (sorted)}.
    fn uses(&mut self, refs: &[Id], builtins: &[&str]) -> Id {
        let mut types = BTreeMap::new();
        let mut b: std::collections::BTreeSet<String> = builtins.iter().map(|s| s.to_string()).collect();
        for &r in refs {
            self.walk(r, &mut types, &mut b);
        }
        let mut ts: Vec<(String, Id)> =
            types.into_iter().map(|(k, t)| (format!("{}\u{1}{k}", self.a.s(t, "name")), t)).collect();
        ts.sort_by(|x, y| x.0.as_bytes().cmp(y.0.as_bytes()));
        let u = self.a.map();
        let tl = self.a.list(ts.into_iter().map(|x| x.1).collect());
        self.a.set(u, "types", tl);
        let bs: Vec<String> = b.into_iter().collect();
        let bl = self.strs(&bs);
        self.a.set(u, "builtins", bl);
        u
    }

    fn message_refs(&self, m: Id, refs: &mut Vec<Id>) {
        if let Some(ps) = self.a.get(m, "params") {
            for p in self.a.items(ps) {
                if let Some(t) = self.a.get(p, "type") {
                    refs.push(t);
                }
            }
        }
        if let Some(r) = self.a.get(m, "returns")
            && !self.a.is_null(r)
        {
            refs.push(r);
        }
        if let Some(rs) = self.a.get(m, "raises") {
            refs.extend(self.a.items(rs));
        }
    }

    fn type_uses(&mut self, t: Id) {
        let k = self.a.s(t, "kind");
        let mut refs = vec![];
        let item_types = |a: &Arena, list: Option<Id>, refs: &mut Vec<Id>| {
            for x in list.map(|l| a.items(l)).unwrap_or_default() {
                if let Some(y) = a.get(x, "type") {
                    refs.push(y);
                }
            }
        };
        let builtins: Vec<String> = match k.as_str() {
            "struct" | "exception" => {
                item_types(&self.a, self.a.get(t, "fields"), &mut refs);
                if k == "exception" { vec!["exception".into()] } else { vec![] }
            }
            "alias" => {
                refs.extend(self.a.get(t, "type"));
                vec![]
            }
            "union" => {
                let cases = self.a.get(t, "cases");
                let n = cases.map(|c| self.a.items(c).len()).unwrap_or(0);
                refs.extend(self.a.get(t, "discriminator"));
                item_types(&self.a, cases, &mut refs);
                if n > 0 { vec!["variant".into()] } else { vec![] }
            }
            "enum" | "bitmask" => vec![self.a.s(t, "underlying")],
            _ => vec![],
        };
        let b: Vec<&str> = builtins.iter().map(String::as_str).filter(|s| !s.is_empty()).collect();
        let u = self.uses(&refs, &b);
        self.a.set(t, "uses", u);
    }

    // ------------------------------------------------------------- modules ----

    fn instantiated(&self, m: Id) -> bool {
        let abs = self.a.get(m, "abstract").is_some_and(|x| self.a.text(x) == "true");
        !abs || self.a.get(m, "ports").is_some_and(|p| !self.a.items(p).is_empty())
    }

    fn instances(&mut self, children: &[Id]) -> Id {
        let l: Vec<Id> = children.iter().copied().filter(|&c| self.instantiated(c)).collect();
        self.a.list(l)
    }

    fn walk_module(&mut self, m: &'a Json, namespace: &[String], binary: &str) -> Id {
        let name = ds(m, "name");
        let path =
            if namespace.is_empty() { name.clone() } else { format!("{}.{name}", namespace.join(".")) };
        let kind = ds(m, "kind");
        let g = self.a.map();
        self.put_str(g, "entity", "module");
        self.put(g, "name", dn(m, "name"));
        self.put_str(g, "path", path.clone());
        let ns = self.strs(namespace);
        self.a.set(g, "namespace", ns);
        if namespace.is_empty() {
            let x = self.a.null();
            self.a.set(g, "parent", x);
        } else {
            self.put_str(g, "parent", namespace.join("."));
        }
        let d = self.a.int(namespace.len() as i64);
        self.a.set(g, "depth", d);
        self.put_null_or(g, "binary", binary);
        self.put_str(g, "description", ds(m, "description"));
        self.put_str(g, "kind", if kind.is_empty() { "class".to_string() } else { kind.clone() });
        self.put_bool(g, "abstract", !kind.is_empty() && kind != "class");
        let active = self.active(m);
        self.a.set(g, "active", active);
        let b = self.empty_list();
        self.a.set(g, "bases", b);
        self.put_bool(g, "isBase", false);
        self.put(
            g,
            "metadata",
            if dh(m, "metadata") { m["metadata"].clone() } else { Json::Object(Default::default()) },
        );
        self.put(g, "color", dn(m, "color"));
        let types: Vec<Id> = dl(m, "types").iter().map(|t| self.type_def(t, "", &path)).collect();
        let tl = self.a.list(types.clone());
        self.a.set(g, "types", tl);
        let mut attrs = vec![];
        for a in dl(m, "attributes") {
            let x = self.field(a);
            let access = if dh(a, "access") { ds(a, "access") } else { "public".into() };
            self.put_str(x, "access", access);
            self.put_bool(x, "static", db(a, "static"));
            self.put_bool(x, "const", db(a, "const"));
            attrs.push(x);
        }
        let l = self.a.list(attrs);
        self.a.set(g, "attributes", l);
        let u = self.no_uses();
        self.a.set(g, "uses", u);
        let mut methods = vec![];
        for a in dl(m, "methods") {
            let x = self.message(a);
            let access = if dh(a, "access") { ds(a, "access") } else { "public".into() };
            self.put_str(x, "access", access);
            for k in ["static", "const", "virtual", "pure", "override"] {
                self.put_bool(x, k, db(a, k));
            }
            methods.push(x);
        }
        let l = self.a.list(methods);
        self.a.set(g, "methods", l);
        let mut ports = vec![];
        for p in dl(m, "ports") {
            let x = self.a.map();
            self.put(x, "name", dn(p, "name"));
            self.put(x, "role", dn(p, "role"));
            self.put_str(x, "description", ds(p, "description"));
            let iname = ds(p, "interface");
            let i = match self.iface_by_name.get(&iname) {
                Some(&i) if !iname.is_empty() => i,
                _ => self.a.null(),
            };
            self.a.set(x, "interface", i);
            let dl_ = self.empty_list();
            self.a.set(x, "delegates", dl_);
            self.put_bool(x, "ackRequired", false);
            ports.push(x);
        }
        let l = self.a.list(ports);
        self.a.set(g, "ports", l);
        for k in ["children", "instances", "connections"] {
            let l = self.empty_list();
            self.a.set(g, k, l);
        }
        self.modules.push(g);
        self.module_types.extend(types);
        self.by_path.insert(path, g);
        self.bases_of.push((g, dl(m, "bases").iter().map(crate::model::load::txt).collect()));
        let mut ns2 = namespace.to_vec();
        ns2.push(name);
        let children: Vec<Id> = dl(m, "modules").iter().map(|c| self.walk_module(c, &ns2, binary)).collect();
        let cl = self.a.list(children.clone());
        self.a.set(g, "children", cl);
        let il = self.instances(&children);
        self.a.set(g, "instances", il);
        g
    }

    // --------------------------------------------------------------- links ----

    fn host_port(&mut self, h: &Json) -> Id {
        let g = self.a.map();
        self.put(g, "host", dn(h, "host"));
        self.put(g, "port", dn(h, "port"));
        g
    }

    fn settings(&mut self, s: &Json) -> Id {
        let g = self.a.map();
        let x = self.host_port(&dn(s, "client"));
        self.a.set(g, "client", x);
        let x = self.host_port(&dn(s, "server"));
        self.a.set(g, "server", x);
        for k in ["path", "name", "capacity", "maxMessages", "messageSize", "socket"] {
            self.put(g, k, dn(s, k));
        }
        let x = self.host_port(&dn(s, "broker"));
        self.a.set(g, "broker", x);
        for k in ["topic", "interface", "id", "device", "baud"] {
            self.put(g, k, dn(s, k));
        }
        let mut opts = vec![];
        if let Some(o) = s.get("options").and_then(Json::as_object) {
            for (k, v) in o {
                opts.push(self.json_map(serde_json::json!({"name": k, "value": v})));
            }
        }
        let l = self.a.list(opts);
        self.a.set(g, "options", l);
        g
    }

    fn end(&mut self, e: &Json) -> Id {
        self.json_map(serde_json::json!({"project": dn(e, "project"), "module": dn(e, "module"), "port": dn(e, "port")}))
    }

    fn link(&mut self, l: &Json) -> Id {
        let c = &l["constraints"];
        let g = self.a.map();
        self.put(g, "name", dn(l, "name"));
        self.put_str(g, "description", ds(l, "description"));
        let f = self.end(&l["from"]);
        self.a.set(g, "from", f);
        let t = self.end(&l["to"]);
        self.a.set(g, "to", t);
        let x = self.a.map();
        self.put(x, "direction", dn(c, "direction"));
        let ack = self.json_map(serde_json::json!({"required": dn(&c["ack"], "required"), "timeoutMs": dn(&c["ack"], "timeoutMs")}));
        self.a.set(x, "ack", ack);
        let p = &c["performance"];
        let perf = self.json_map(serde_json::json!({"class": dn(p, "class"), "maxLatencyMs": dn(p, "maxLatencyMs"), "rateHz": dn(p, "rateHz")}));
        self.a.set(x, "performance", perf);
        let r = &c["remote"];
        let y = self.a.map();
        self.put(y, "enabled", dn(r, "enabled"));
        self.put(y, "transport", dn(r, "transport"));
        let s = self.settings(&dn(r, "settings"));
        self.a.set(y, "settings", s);
        self.a.set(x, "remote", y);
        self.a.set(g, "constraints", x);
        g
    }

    fn endpoint(&mut self, via_: Vec<String>, module: &str, port: &str) -> Id {
        let g = self.a.map();
        let v = self.strs(&via_);
        self.a.set(g, "via", v);
        self.put_str(g, "module", module);
        self.put_str(g, "port", port);
        g
    }

    fn port_of(&self, path: &str, name: &str) -> Option<Id> {
        let m = *self.by_path.get(path)?;
        let ps = self.a.get(m, "ports")?;
        self.a.items(ps).into_iter().find(|&p| self.a.s(p, "name") == name)
    }

    fn system(&mut self, binary: Option<Id>, children: Vec<Id>) -> Id {
        let g = self.a.map();
        self.put_str(g, "entity", "system");
        let name = match binary {
            Some(b) => format!("{}System", self.a.s(b, "name")),
            None => "System".into(),
        };
        self.put_str(g, "name", name);
        let b = binary.unwrap_or_else(|| self.a.null());
        self.a.set(g, "binary", b);
        let cl = self.a.list(children.clone());
        self.a.set(g, "children", cl);
        let il = self.instances(&children);
        self.a.set(g, "instances", il);
        for k in ["connections", "external", "proxies", "stubs"] {
            let l = self.empty_list();
            self.a.set(g, k, l);
        }
        let u = self.no_uses();
        self.a.set(g, "uses", u);
        g
    }

    fn where_(&mut self, binary: &str, module: &str, port: &str) -> Id {
        self.json_map(serde_json::json!({"binary": binary, "module": module, "port": port}))
    }

    fn list_at(&self, m: Id, k: &str) -> Id {
        self.a.get(m, k).expect("list")
    }

    // ---------------------------------------------------------------- build ----

    fn build(&mut self, file: &'a Json) -> Id {
        let mut warnings: Vec<String> = vec![];
        self.place_all(file);
        let e = self.entities(file);
        let top = self.walk_modules(file);
        let all_mtypes = self.entity_uses(&e);
        let constants_file = self.constants_file(&e.constants);
        self.module_uses();
        let s = self.systems(file, &top, &mut warnings);
        let defaults = RemoteDefaults::of(file);
        let ident = dependency_name(&ds(&file["project"], "name"));
        let r = self.wire_links(file, &s, &ident, &defaults, &mut warnings);
        let rt = self.remote_types(&r.interfaces);
        let rc = self.remote_constants(&e.constants, &rt);
        self.delegate_warnings(&mut warnings);
        self.root(file, &ident, &defaults, e, all_mtypes, constants_file, s, r, rt, rc, &warnings)
    }

    /// Type definitions by key, the first winning (the project's, its modules', its dependencies').
    fn place_all(&mut self, file: &'a Json) {
        for t in dl(file, "types") {
            self.place(ds(t, "name"), t, "", "");
        }
        self.place_modules(dl(file, "modules"), "");
        for d in dl(file, "dependencies") {
            let dn_ = ds(d, "name");
            for t in dl(d, "types") {
                self.place(ds(t, "name"), t, &dn_, "");
            }
            for g in dl(d, "moduleTypes") {
                let m = ds(g, "module");
                for t in dl(g, "types") {
                    self.place(format!("{dn_}/{m}.{}", ds(t, "name")), t, &dn_, &m);
                }
            }
        }
    }

    /// Types, interfaces and constants of the project and of its dependencies.
    fn entities(&mut self, file: &'a Json) -> Entities {
        let types: Vec<Id> = dl(file, "types").iter().map(|t| self.type_def(t, "", "")).collect();
        let interfaces: Vec<Id> = dl(file, "interfaces").iter().map(|i| self.iface(i, "")).collect();
        let constants: Vec<Id> = dl(file, "constants").iter().map(|c| self.constant(c, "")).collect();
        let mut e = Entities {
            all_types: types.clone(),
            all_ifaces: interfaces.clone(),
            types,
            interfaces,
            constants,
            dep_nodes: vec![],
            dep_mtypes: vec![],
        };
        for d in dl(file, "dependencies") {
            let dn_ = ds(d, "name");
            let g = self.a.map();
            self.put(g, "name", dn(d, "name"));
            self.put(g, "file", dn(d, "file"));
            self.put_bool(g, "indirect", db(d, "indirect"));
            let ts: Vec<Id> = dl(d, "types").iter().map(|t| self.type_def(t, &dn_, "")).collect();
            let mut mts = vec![];
            for x in dl(d, "moduleTypes") {
                let m = ds(x, "module");
                for t in dl(x, "types") {
                    mts.push(self.type_def(t, &dn_, &m));
                }
            }
            let is: Vec<Id> = dl(d, "interfaces").iter().map(|i| self.iface(i, &dn_)).collect();
            let cs: Vec<Id> = dl(d, "constants").iter().map(|c| self.constant(c, &dn_)).collect();
            e.all_types.extend(&ts);
            e.all_ifaces.extend(&is);
            e.dep_mtypes.extend(&mts);
            for (k, v) in [("types", ts), ("moduleTypes", mts), ("interfaces", is), ("constants", cs)] {
                let l = self.a.list(v);
                self.a.set(g, k, l);
            }
            e.dep_nodes.push(g);
        }
        for &x in &e.all_ifaces {
            let n = self.a.s(x, "name");
            self.iface_by_name.entry(n).or_insert(x);
        }
        e
    }

    /// The top-level modules, walked depth first; then the bases of each module.
    fn walk_modules(&mut self, file: &'a Json) -> Vec<Id> {
        let bin_names: Vec<String> = dl(file, "binaries").iter().map(|b| ds(b, "name")).collect();
        let mut top = vec![];
        for fm in dl(file, "modules") {
            let b = ds(fm, "binary");
            let b = if !b.is_empty() && bin_names.contains(&b) { b } else { String::new() };
            top.push(self.walk_module(fm, &[], &b));
        }
        for (g, bases) in std::mem::take(&mut self.bases_of) {
            let mut b = vec![];
            for x in bases {
                if let Some(&m) = self.by_path.get(&x) {
                    let t = self.a.bool(true);
                    self.a.set(m, "isBase", t);
                    b.push(m);
                }
            }
            let l = self.a.list(b);
            self.a.set(g, "bases", l);
        }
        top
    }

    /// What each type and interface uses, now that every type exists; the module types of the
    /// project and of its dependencies.
    fn entity_uses(&mut self, e: &Entities) -> Vec<Id> {
        let mut all_mtypes = self.module_types.clone();
        all_mtypes.extend(&e.dep_mtypes);
        let every: Vec<Id> = e.all_types.iter().chain(&all_mtypes).copied().collect();
        for &x in &every {
            let k = self.a.s(x, "key");
            self.type_by_key.entry(k).or_insert(x);
        }
        for &x in &every {
            self.type_uses(x);
        }
        for &g in &e.all_ifaces {
            let mut refs = vec![];
            for m in self.a.items(self.list_at(g, "messages")) {
                self.message_refs(m, &mut refs);
            }
            let u = self.uses(&refs, &[]);
            self.a.set(g, "uses", u);
        }
        all_mtypes
    }

    /// The file of the project's constants, with what they use.
    fn constants_file(&mut self, constants: &[Id]) -> Id {
        let constants_file = self.a.map();
        self.put_str(constants_file, "entity", "constants");
        self.put_str(constants_file, "name", "constants");
        let n = self.a.null();
        self.a.set(constants_file, "dependency", n);
        let refs: Vec<Id> = constants.iter().filter_map(|&c| self.a.get(c, "type")).collect();
        let u = self.uses(&refs, &[]);
        self.a.set(constants_file, "uses", u);
        constants_file
    }

    /// What each module uses: its types (declared in its class with `using`), attributes and methods.
    fn module_uses(&mut self) {
        for g in self.modules.clone() {
            let mut refs = vec![];
            for x in self.a.items(self.list_at(g, "types")) {
                let rd = self.a.map();
                self.put_str(rd, "kind", "ref");
                for (k, from) in [
                    ("name", "name"),
                    ("typeKind", "kind"),
                    ("dependency", "dependency"),
                    ("key", "key"),
                    ("scope", "scope"),
                    ("flatName", "flatName"),
                ] {
                    if let Some(v) = self.a.get(x, from) {
                        self.a.set(rd, k, v);
                    }
                }
                refs.push(rd);
            }
            for x in self.a.items(self.list_at(g, "attributes")) {
                refs.extend(self.a.get(x, "type"));
            }
            for m in self.a.items(self.list_at(g, "methods")) {
                self.message_refs(m, &mut refs);
            }
            let u = self.uses(&refs, &[]);
            self.a.set(g, "uses", u);
        }
    }

    /// One system per binary, holding its top-level modules, or one for the whole project.
    fn systems(&mut self, file: &'a Json, top: &[Id], warnings: &mut Vec<String>) -> Systems {
        let mut binaries = vec![];
        for b in dl(file, "binaries") {
            let g = self.a.map();
            self.put(g, "name", dn(b, "name"));
            self.put_str(g, "description", ds(b, "description"));
            self.put(g, "color", dn(b, "color"));
            let l = self.empty_list();
            self.a.set(g, "modules", l);
            binaries.push(g);
        }
        let nbin = binaries.len();
        let mut bin_of_top: HashMap<String, usize> = HashMap::new();
        for (i, fm) in dl(file, "modules").iter().enumerate() {
            let pos =
                binaries.iter().position(|&b| dh(fm, "binary") && self.a.s(b, "name") == ds(fm, "binary"));
            if let Some(j) = pos {
                let l = self.list_at(binaries[j], "modules");
                self.a.push(l, top[i]);
                bin_of_top.insert(ds(fm, "name"), j);
            } else if nbin > 0 {
                warnings.push(format!("Module '{}' runs in no binary: left out", ds(fm, "name")));
            }
        }
        let systems: Vec<Id> = if nbin > 0 {
            binaries
                .clone()
                .into_iter()
                .map(|b| {
                    let ms = self.a.items(self.list_at(b, "modules"));
                    self.system(Some(b), ms)
                })
                .collect()
        } else {
            vec![self.system(None, top.to_vec())]
        };
        Systems { binaries, systems, bin_of_top }
    }

    /// The links: wired in their module or system, between binaries (proxies and stubs), or to
    /// other projects.
    fn wire_links(
        &mut self,
        file: &'a Json,
        s: &Systems,
        ident: &str,
        defaults: &RemoteDefaults,
        warnings: &mut Vec<String>,
    ) -> Remote {
        let mut r = Remote {
            links: vec![],
            interfaces: vec![],
            interface_index: HashMap::new(),
            links_between: vec![],
        };
        let flinks = dl(file, "links");
        r.links = flinks.iter().map(|l| self.link(l)).collect();
        for (i, &l) in r.links.clone().iter().enumerate() {
            let fl = &flinks[i];
            let (from, to) = (&fl["from"], &fl["to"]);
            if dh(from, "project") || dh(to, "project") {
                self.external_link(l, from, to, s);
                continue;
            }
            let lname = ds(fl, "name");
            let fm = ds(from, "module");
            let tm = ds(to, "module");
            let (fport, tport) = (ds(from, "port"), ds(to, "port"));
            if !self.by_path.contains_key(&fm) || !self.by_path.contains_key(&tm) {
                warnings.push(format!("Link '{lname}' has a missing endpoint"));
                continue;
            }
            // The calls reaching an `in` port through a link requiring an acknowledgement wait for it.
            if db(&fl["constraints"]["ack"], "required")
                && let Some(p) = self.port_of(&tm, &tport)
            {
                self.put_bool(p, "ackRequired", true);
            }
            if tm.starts_with(&format!("{fm}.")) {
                // A container's `in` port handing its calls to an inner `in` port.
                self.delegate(&fm, &fport, &tm, &tport);
                continue;
            }
            if fm.starts_with(&format!("{tm}.")) {
                // An inner `out` port going out through the container's `out` port.
                self.delegate(&tm, &tport, &fm, &fport);
                continue;
            }
            // Wired by the innermost module holding both ends.
            let a: Vec<&str> = fm.split('.').collect();
            let b: Vec<&str> = tm.split('.').collect();
            let mut n = 0;
            while n < a.len() - 1 && n < b.len() - 1 && a[n] == b[n] {
                n += 1;
            }
            let scope = a[..n].join(".");
            let conn = self.a.map();
            self.a.set(conn, "link", l);
            let cf = self.endpoint(via(&scope, &fm), &fm, &fport);
            self.a.set(conn, "from", cf);
            let ct = self.endpoint(via(&scope, &tm), &tm, &tport);
            self.a.set(conn, "to", ct);
            if !scope.is_empty() {
                let c = self.list_at(self.by_path[&scope], "connections");
                self.a.push(c, conn);
                continue;
            }
            let (Some(at), Some(peer)) = (s.at(&fm), s.at(&tm)) else { continue };
            if at == peer {
                let c = self.list_at(at, "connections");
                self.a.push(c, conn);
                continue;
            }
            // Between binaries: a proxy sends the calls of the `from` end, a stub hands them to the `to` end.
            let face = self
                .port_of(&fm, &fport)
                .and_then(|p| self.a.get(p, "interface"))
                .filter(|&f| !self.a.is_null(f));
            let Some(face) = face else {
                warnings.push(format!("Link '{lname}' between binaries has no interface: left out"));
                continue;
            };
            let ends = Ends { at, peer, cf, ct, fm, fport, tm, tport };
            self.remote_link(l, fl, face, ends, ident, defaults, &mut r);
        }
        r
    }

    /// A link to another project: an external end of the system of its local module.
    fn external_link(&mut self, l: Id, from: &Json, to: &Json, s: &Systems) {
        let (local, remote) = if dh(from, "project") { (to, from) } else { (from, to) };
        if dh(local, "project") {
            return;
        }
        let Some(sys) = s.at(&ds(local, "module")) else { return };
        let g = self.a.map();
        self.a.set(g, "link", l);
        let lm = ds(local, "module");
        let e = self.endpoint(via("", &lm), &lm, &ds(local, "port"));
        self.a.set(g, "local", e);
        self.put_str(g, "side", if dh(from, "project") { "to" } else { "from" });
        let r = self.json_map(serde_json::json!({"project": dn(remote, "project"), "module": dn(remote, "module"), "port": dn(remote, "port")}));
        self.a.set(g, "remote", r);
        let ext = self.list_at(sys, "external");
        self.a.push(ext, g);
    }

    /// Port `port` of container `outer` handing its calls to (or through) port `inner_port` of `inner`.
    fn delegate(&mut self, outer: &str, port: &str, inner: &str, inner_port: &str) {
        if let Some(p) = self.port_of(outer, port) {
            let e = self.endpoint(via(outer, inner), inner, inner_port);
            let d = self.list_at(p, "delegates");
            self.a.push(d, e);
        }
    }

    /// A link between binaries: its proxy in the system of the `from` end, its stub in that of the `to` end.
    #[allow(clippy::too_many_arguments)]
    fn remote_link(
        &mut self,
        l: Id,
        fl: &Json,
        face: Id,
        e: Ends,
        ident: &str,
        defaults: &RemoteDefaults,
        r: &mut Remote,
    ) {
        let fname = self.a.s(face, "name");
        match r.interface_index.get(&fname) {
            Some(&k) => r.interfaces[k] = face,
            None => {
                r.interface_index.insert(fname, r.interfaces.len());
                r.interfaces.push(face);
            }
        }
        let idx = r.links_between.len();
        let settings = self.resolve_settings(
            fl,
            idx,
            ident,
            &defaults.client_host,
            &defaults.server_host,
            defaults.base_port,
        );
        let at_bin = self.a.get(e.at, "binary").map(|b| self.a.s(b, "name")).unwrap_or_default();
        let peer_bin = self.a.get(e.peer, "binary").map(|b| self.a.s(b, "name")).unwrap_or_default();
        let rl = self.a.map();
        let ix = self.a.int(idx as i64);
        self.a.set(rl, "index", ix);
        self.a.set(rl, "link", l);
        self.a.set(rl, "interface", face);
        let w = self.where_(&at_bin, &e.fm, &e.fport);
        self.a.set(rl, "from", w);
        let w = self.where_(&peer_bin, &e.tm, &e.tport);
        self.a.set(rl, "to", w);
        self.a.set(rl, "settings", settings);
        r.links_between.push(rl);
        for (sys, local, peer_where, list) in [
            (e.at, e.cf, (&peer_bin, &e.tm, &e.tport), "proxies"),
            (e.peer, e.ct, (&at_bin, &e.fm, &e.fport), "stubs"),
        ] {
            let g = self.a.map();
            let ix = self.a.int(idx as i64);
            self.a.set(g, "index", ix);
            self.a.set(g, "link", l);
            self.a.set(g, "local", local);
            self.a.set(g, "interface", face);
            let w = self.where_(peer_where.0, peer_where.1, peer_where.2);
            self.a.set(g, "peer", w);
            self.a.set(g, "settings", settings);
            let ls = self.list_at(sys, list);
            self.a.push(ls, g);
        }
    }

    /// Types the remote interfaces reach, by name (sorted by their bytes).
    fn remote_types(&self, interfaces: &[Id]) -> Vec<(String, Id)> {
        fn reach(a: &Arena, t: Id, out: &mut BTreeMap<String, Id>) {
            let n = a.s(t, "name");
            if out.contains_key(&n) {
                return;
            }
            out.insert(n, t);
            if let Some(u) = a.get(t, "uses").and_then(|u| a.get(u, "types")) {
                for x in a.items(u) {
                    reach(a, x, out);
                }
            }
        }
        let mut remote_types: BTreeMap<String, Id> = BTreeMap::new();
        for &f in interfaces {
            if let Some(u) = self.a.get(f, "uses").and_then(|u| self.a.get(u, "types")) {
                for x in self.a.items(u) {
                    reach(&self.a, x, &mut remote_types);
                }
            }
        }
        let mut rt: Vec<(String, Id)> = remote_types.into_iter().collect();
        rt.sort_by(|x, y| x.0.as_bytes().cmp(y.0.as_bytes()));
        rt
    }

    /// Constants whose types are all among the remote types.
    fn remote_constants(&mut self, constants: &[Id], remote_types: &[(String, Id)]) -> Vec<Id> {
        let names: std::collections::HashSet<&str> = remote_types.iter().map(|x| x.0.as_str()).collect();
        let mut rc = vec![];
        for &c in constants {
            let t: Vec<Id> = self.a.get(c, "type").into_iter().collect();
            let u = self.uses(&t, &[]);
            let ok = self
                .a
                .items(self.list_at(u, "types"))
                .iter()
                .all(|&x| names.contains(self.a.s(x, "name").as_str()));
            if ok {
                rc.push(c);
            }
        }
        rc
    }

    /// `in` ports handing their calls to several inner ports: only the first is wired.
    fn delegate_warnings(&self, warnings: &mut Vec<String>) {
        for &g in &self.modules {
            for p in self.a.items(self.list_at(g, "ports")) {
                let ds_ = self.a.items(self.list_at(p, "delegates"));
                if self.a.s(p, "role") == "in" && ds_.len() > 1 {
                    warnings.push(format!(
                        "{}:{} hands its calls to {} inner ports: only {}:{} is wired",
                        self.a.s(g, "path"),
                        self.a.s(p, "name"),
                        ds_.len(),
                        self.a.s(ds_[0], "module"),
                        self.a.s(ds_[0], "port")
                    ));
                }
            }
        }
    }

    /// The root of the context.
    #[allow(clippy::too_many_arguments)]
    fn root(
        &mut self,
        file: &'a Json,
        ident: &str,
        defaults: &RemoteDefaults,
        e: Entities,
        all_mtypes: Vec<Id>,
        constants_file: Id,
        s: Systems,
        r: Remote,
        rt: Vec<(String, Id)>,
        rc: Vec<Id>,
        warnings: &[String],
    ) -> Id {
        let project = &file["project"];
        let ctx = self.a.map();
        let pr = self.a.map();
        self.put(pr, "name", dn(project, "name"));
        self.put_str(pr, "ident", ident);
        self.put_str(pr, "description", ds(project, "description"));
        self.put(
            pr,
            "metadata",
            if dh(project, "metadata") {
                project["metadata"].clone()
            } else {
                Json::Object(Default::default())
            },
        );
        self.a.set(ctx, "project", pr);
        self.put(
            ctx,
            "transports",
            if dh(file, "transports") { file["transports"].clone() } else { Json::Array(vec![]) },
        );
        self.put(
            ctx,
            "remoteDefaults",
            serde_json::json!({"client": {"host": defaults.client_host}, "server": {"host": defaults.server_host}, "basePort": defaults.base_port}),
        );
        let set_list = |c: &mut Self, k: &str, v: Vec<Id>| {
            let l = c.a.list(v);
            c.a.set(ctx, k, l);
        };
        set_list(self, "types", e.types);
        let mts = self.module_types.clone();
        set_list(self, "moduleTypes", mts);
        set_list(self, "interfaces", e.interfaces);
        let ms = self.modules.clone();
        let any_active = ms.iter().any(|&m| self.a.get(m, "active").is_some_and(|x| !self.a.is_null(x)));
        set_list(self, "modules", ms);
        self.put_bool(ctx, "anyActive", any_active);
        let nbin = s.binaries.len();
        set_list(self, "binaries", s.binaries);
        set_list(self, "systems", s.systems.clone());
        let sys = if nbin > 0 { self.a.null() } else { s.systems[0] };
        self.a.set(ctx, "system", sys);
        set_list(self, "remoteInterfaces", r.interfaces);
        set_list(self, "remoteLinks", r.links_between);
        set_list(self, "remoteTypes", rt.into_iter().map(|x| x.1).collect());
        set_list(self, "constants", e.constants);
        self.a.set(ctx, "constantsFile", constants_file);
        set_list(self, "remoteConstants", rc);
        set_list(self, "links", r.links);
        set_list(self, "dependencies", e.dep_nodes);
        set_list(self, "allTypes", e.all_types.clone());
        set_list(self, "allModuleTypes", all_mtypes.clone());
        let tbk = self.a.map();
        for &x in e.all_types.iter().chain(&all_mtypes) {
            let k = self.a.s(x, "key");
            if self.a.get(tbk, &k).is_none() {
                self.a.set(tbk, &k, x);
            }
        }
        self.a.set(ctx, "typeByKey", tbk);
        set_list(self, "allInterfaces", e.all_ifaces);
        let w = self.strs(warnings);
        self.a.set(ctx, "warnings", w);
        ctx
    }

    /// Settings of link `l` (of the file), the `idx`th between binaries, with the defaults of its transport.
    fn resolve_settings(
        &mut self,
        l: &Json,
        idx: usize,
        ident: &str,
        client: &str,
        server: &str,
        base: i64,
    ) -> Id {
        let remote = &l["constraints"]["remote"];
        let s = &remote["settings"];
        let fields = transport_fields(&ds(remote, "transport"));
        let port = base + idx as i64;
        let mut r = s.as_object().cloned().unwrap_or_default();
        // { host, port, ...given } as JavaScript spreads it: given keys (even null) win.
        let default_host = |given: &Json, host: &str| {
            let mut h = serde_json::Map::new();
            h.insert("host".into(), Json::from(host));
            h.insert("port".into(), Json::from(port));
            if let Some(g) = given.as_object() {
                for (k, v) in g {
                    h.insert(k.clone(), v.clone());
                }
            }
            Json::Object(h)
        };
        let has = |f: &str| fields.contains(&f);
        if has("client") {
            r.insert("client".into(), default_host(&dn(s, "client"), client));
        }
        if has("server") {
            r.insert("server".into(), default_host(&dn(s, "server"), server));
        }
        if has("path") {
            r.insert(
                "path".into(),
                if dh(s, "path") { s["path"].clone() } else { Json::from(format!("/{}", ds(l, "name"))) },
            );
        }
        if has("name") {
            let v = if dh(s, "name") {
                s["name"].clone()
            } else {
                Json::from(snake(&format!("{ident}_{}", ds(l, "name"))))
            };
            r.insert("name".into(), v);
        }
        for (k, d) in [("capacity", 1048576), ("maxMessages", 10), ("messageSize", 8192)] {
            if has(k) {
                r.insert(k.into(), if dh(s, k) { s[k].clone() } else { Json::from(d) });
            }
        }
        self.settings(&Json::Object(r))
    }
}
