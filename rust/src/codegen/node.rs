// Generation context as a graph: entities shared by several lists (a type in `types`, `typeByKey`
// and the `uses` of others), filled after their creation, and cyclic for recursive types. Nodes
// live in an arena; templates read them through minijinja objects, compared by identity as the
// TypeScript objects are.
use std::cmp::Ordering;
use std::collections::HashSet;
use std::sync::Arc;

use indexmap::IndexMap;
use minijinja::Value;
use minijinja::value::{DynObject, Enumerator, Object, ObjectRepr};
use serde_json::Value as Json;

pub type Id = usize;

#[derive(Debug, Clone)]
pub enum Node {
    Json(Json),
    List(Vec<Id>),
    Map(IndexMap<String, Id>),
}

#[derive(Debug, Default)]
pub struct Arena {
    pub nodes: Vec<Node>,
}

impl Arena {
    fn add(&mut self, n: Node) -> Id {
        self.nodes.push(n);
        self.nodes.len() - 1
    }
    /// A scalar (or a JSON value kept as is: read only by templates).
    pub fn json(&mut self, v: Json) -> Id {
        self.add(Node::Json(v))
    }
    pub fn str(&mut self, s: impl Into<String>) -> Id {
        self.json(Json::String(s.into()))
    }
    pub fn null(&mut self) -> Id {
        self.json(Json::Null)
    }
    pub fn bool(&mut self, b: bool) -> Id {
        self.json(Json::Bool(b))
    }
    pub fn int(&mut self, i: i64) -> Id {
        self.json(Json::from(i))
    }
    /// `s` or null when empty.
    pub fn null_or(&mut self, s: &str) -> Id {
        if s.is_empty() { self.null() } else { self.str(s) }
    }
    pub fn list(&mut self, items: Vec<Id>) -> Id {
        self.add(Node::List(items))
    }
    pub fn map(&mut self) -> Id {
        self.add(Node::Map(IndexMap::new()))
    }
    pub fn set(&mut self, m: Id, k: &str, v: Id) {
        if let Node::Map(x) = &mut self.nodes[m] {
            x.insert(k.to_string(), v);
        }
    }
    pub fn get(&self, m: Id, k: &str) -> Option<Id> {
        match &self.nodes[m] {
            Node::Map(x) => x.get(k).copied(),
            _ => None,
        }
    }
    pub fn push(&mut self, l: Id, x: Id) {
        if let Node::List(v) = &mut self.nodes[l] {
            v.push(x);
        }
    }
    pub fn items(&self, l: Id) -> Vec<Id> {
        match &self.nodes[l] {
            Node::List(v) => v.clone(),
            _ => vec![],
        }
    }
    /// Text of a scalar ("" for null, a list or a mapping).
    pub fn text(&self, id: Id) -> String {
        match &self.nodes[id] {
            Node::Json(Json::String(s)) => s.clone(),
            Node::Json(Json::Null) | Node::List(_) | Node::Map(_) => String::new(),
            Node::Json(v) => v.to_string(),
        }
    }
    /// Text of key `k` of map `m`.
    pub fn s(&self, m: Id, k: &str) -> String {
        self.get(m, k).map(|v| self.text(v)).unwrap_or_default()
    }
    pub fn is_null(&self, id: Id) -> bool {
        matches!(self.nodes[id], Node::Json(Json::Null))
    }

    /// JSON of a node; a node inside itself as `"<cycle>"` (as scripts/dump-context.ts prints it).
    pub fn to_json(&self, id: Id) -> Json {
        let mut stack = HashSet::new();
        self.to_json_in(id, &mut stack)
    }
    fn to_json_in(&self, id: Id, stack: &mut HashSet<Id>) -> Json {
        match &self.nodes[id] {
            Node::Json(v) => v.clone(),
            n => {
                if !stack.insert(id) {
                    return Json::String("<cycle>".into());
                }
                let r = match n {
                    Node::List(v) => Json::Array(v.iter().map(|&x| self.to_json_in(x, stack)).collect()),
                    Node::Map(m) => {
                        Json::Object(m.iter().map(|(k, &x)| (k.clone(), self.to_json_in(x, stack))).collect())
                    }
                    Node::Json(_) => unreachable!(),
                };
                stack.remove(&id);
                r
            }
        }
    }
}

/// A list or mapping node, for templates.
#[derive(Debug)]
pub struct NodeRef {
    arena: Arc<Arena>,
    id: Id,
}

/// The template value of a node.
pub fn value(arena: &Arc<Arena>, id: Id) -> Value {
    match &arena.nodes[id] {
        Node::Json(v) => Value::from(minijinja::value::Serde(v)),
        _ => Value::from_object(NodeRef { arena: arena.clone(), id }),
    }
}

impl Object for NodeRef {
    fn repr(self: &Arc<Self>) -> ObjectRepr {
        match self.arena.nodes[self.id] {
            Node::List(_) => ObjectRepr::Seq,
            _ => ObjectRepr::Map,
        }
    }

    fn get_value(self: &Arc<Self>, key: &Value) -> Option<Value> {
        match &self.arena.nodes[self.id] {
            Node::List(v) => {
                let i = key.as_i64()?;
                let i = if i < 0 { v.len() as i64 + i } else { i };
                v.get(usize::try_from(i).ok()?).map(|&x| value(&self.arena, x))
            }
            Node::Map(m) => m.get(key.as_str()?).map(|&x| value(&self.arena, x)),
            Node::Json(_) => None,
        }
    }

    fn enumerate(self: &Arc<Self>) -> Enumerator {
        match &self.arena.nodes[self.id] {
            Node::List(v) => {
                let a = self.arena.clone();
                let items: Vec<Value> = v.iter().map(|&x| value(&a, x)).collect();
                Enumerator::Values(items)
            }
            Node::Map(m) => Enumerator::Values(m.keys().map(|k| Value::from(k.as_str())).collect()),
            Node::Json(_) => Enumerator::Empty,
        }
    }

    fn enumerator_len(self: &Arc<Self>) -> Option<usize> {
        match &self.arena.nodes[self.id] {
            Node::List(v) => Some(v.len()),
            Node::Map(m) => Some(m.len()),
            Node::Json(_) => Some(0),
        }
    }

    /// By identity, as JavaScript compares objects.
    fn custom_cmp(self: &Arc<Self>, other: &DynObject) -> Option<Ordering> {
        let o = other.downcast_ref::<NodeRef>()?;
        Some(self.id.cmp(&o.id))
    }

    fn render(self: &Arc<Self>, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", serde_json::to_string(&self.arena.to_json(self.id)).unwrap_or_default())
    }
}
