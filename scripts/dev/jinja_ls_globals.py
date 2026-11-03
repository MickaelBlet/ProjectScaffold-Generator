#!/usr/bin/env python3
"""Types of the template context for the Jinja LS VS Code extension (noamzaks.jinja-ls).

Infers the shape of every value of the context from `scaffold-gen --dump-context` over the examples and
fixtures, and writes it as `jinjaLS.extraGlobals` (with the custom filters as `jinjaLS.extraFilters`) into
.vscode/settings.json (other settings kept): completion and hover of `modules`, `m.methods`, `t.fields`...
in every template. Recursive shapes (a module's `bases`, a type's `uses`...) are unrolled to MAX_REPEAT / MAX_DEPTH.
Hovers show markdown: each variable's text from the Variables table of docs/templates.md, the explanation of
the fields given there, and on every variable and object its fields with their types.
The names templates give to what they hold (docs/templates.md: `type_reference`, `type_definition`, `module`...,
macro parameters and output items) are globals too, typed as the context value they hold (TEMPLATE_VARIABLES):
jinja-ls looks globals up before local names.

    scripts/dev/jinja_ls_globals.py [--binary target/release/scaffold-gen] [--output .vscode/settings.json]
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TYPE_REF_KINDS = {"primitive", "ref", "optional", "vector", "list", "set", "array", "map"}
# Objects keyed by data, not by a fixed set of names.
DICT_KEYS = {"metadata", "typeByKey"}
MAX_DEPTH = 6
MAX_REPEAT = 2  # times a shape is unrolled inside itself (`t.of.of`, `m.bases[0].bases`)
DOC_DEPTH = 3  # objects nested deeper do not list their fields in their hover (the file would be ~3x larger)
SINGULAR = {"children": "Child", "aliases": "Alias", "uses": "Uses", "raises": "Raise", "bases": "Base"}

FILTERS = {
    "snake": "snake_case",
    "camel": "camelCase",
    "pascal": "PascalCase",
    "kebab": "kebab-case",
    "constant": "CONSTANT_CASE",
    "ucfirst": "First letter upper case",
    "lcfirst": "First letter lower case",
    "uuid": "A UUID made from the text, the same at each generation",
    "as_identifier": "A project name as an identifier: `Plant Demo` -> `Plant_Demo`",
    "json": "A value as JSON (`JSON.stringify`)",
    "escape": "`&`, `<`, `>`, `\"`, `'` as XML entities",
    "inline": "`{% filter inline %}`: the block's text on one line",
}
FILTER_ARGS = {
    "doc_comment": ("Each line of a text after the prefix; no line at all for an empty text", ["prefix"]),
    "replace": ("Jinja's replace, with an optional count", ["old", "new", "count"]),
    "user": ("`{% filter user('id') %}`: a user section kept across generations", ["id"]),
}
# Names of template variables after the schema (docs/templates.md, "Template variables use the words of the
# schema"): context paths of what they hold (`[]`: an item of a list; several: any of them), schema
# definition, documentation.
TEMPLATE_VARIABLES = {
    "type_definition": (["allTypes[]"], "$defs/TypeDef", "A type definition: item of the type outputs"),
    "module_type_definition": (["allModuleTypes[]"], "$defs/ModuleTypeDef", "A type declared in a module"),
    "type_reference": (
        ["constants[].type"],
        "$defs/TypeRef",
        "A type reference: `kind` `primitive` (`name`, `max`), `ref` (a user type: `key`...), `optional` / "
        "`vector` / `list` / `set` (`of`, `max`), `array` (`of`, `size`), `map` (`key`, `value`, `max`); "
        "or none",
    ),
    "discriminator": (["allTypes[].discriminator"], "$defs/TypeRef", "The `discriminator` of a union type"),
    "raised_type": (["allInterfaces[].messages[].raises[]"], "$defs/TypeRef", "An entry of a message's `raises`"),
    "parameters": (
        ["allInterfaces[].messages[].params", "modules[].methods[].params"],
        "$defs/Interface messages[].params",
        "The `params` of a message or a method",
    ),
    "parameter": (
        ["allInterfaces[].messages[].params[]", "modules[].methods[].params[]"],
        "$defs/Interface messages[].params[]",
        "An entry of the `params` of a message or a method",
    ),
    "case": (["allTypes[].cases[]"], "$defs/TypeDef cases[]", "An entry of a union type's `cases`"),
    "value": (["allTypes[].values[]"], "$defs/TypeDef values[]", "An entry of an enum's `values`"),
    "settings": (["remoteLinks[].settings"], "$defs/TransportSettings", "A link's resolved transport settings"),
    "interface": (["allInterfaces[]"], "$defs/Interface", "An interface: item of the interface outputs"),
    "remote_interface": (["remoteInterfaces[]"], "$defs/Interface", "An interface of `remoteInterfaces`"),
    "module": (["modules[]"], "$defs/Module", "A module: item of the module outputs"),
    "system": (["systems[]"], None, "A system: item of the system outputs (and the global `system`)"),
    "message": (["allInterfaces[].messages[]"], "$defs/Interface messages[]", "A message of an interface"),
    "remote_link": (["remoteLinks[]"], None, "An entry of `remoteLinks`: a link between binaries"),
    "link_end": (["modules[].connections[].from"], None, "The `from` or `to` of a connection"),
    "entity": (
        ["allTypes[]", "allInterfaces[]", "modules[]", "systems[]", "constantsFile"],
        None,
        "An entity, by its `entity`: a type, an interface, a module, a system or the constants file",
    ),
}


class Shape:
    """Fields seen on the objects of one kind, with the kinds of their values."""

    def __init__(self, name):
        self.name = name
        self.fields = {}  # name -> Slot


class Slot:
    """Kinds of the values seen at one place: scalars, object shape, list elements."""

    def __init__(self):
        self.scalars = set()
        self.shape = None
        self.element = None
        self.dict = False


class Inferrer:
    def __init__(self):
        self.shapes = {}

    def shape(self, name):
        return self.shapes.setdefault(name, Shape(name))

    def shape_of(self, value, path):
        if "entity" in value:
            return self.shape(value["entity"].capitalize())
        if value.get("kind") in TYPE_REF_KINDS and "entity" not in value:
            return self.shape("TypeRef")
        return self.shape(path)

    def add(self, slot, value, key, owner):
        if isinstance(value, bool):
            slot.scalars.add("bool")
        elif isinstance(value, int):
            slot.scalars.add("int")
        elif isinstance(value, float):
            slot.scalars.add("float")
        elif isinstance(value, str):
            if value != "<cycle>":
                slot.scalars.add("str")
        elif isinstance(value, list):
            slot.element = slot.element or Slot()
            for item in value:
                self.add(slot.element, item, key, owner)
        elif isinstance(value, dict):
            if key in DICT_KEYS:
                slot.dict = True
                return
            shape = self.shape_of(value, f"{owner}.{key}")
            slot.shape = slot.shape or shape
            for k, v in value.items():
                self.add(shape.fields.setdefault(k, Slot()), v, k, shape.name)


def display(name):
    """`Module.methods` -> `Method`."""
    if "." not in name:
        return name
    key = name.rsplit(".", 1)[1]
    if key in SINGULAR:
        return SINGULAR[key]
    key = re.sub(r"ies$", "y", key)
    key = re.sub(r"(?<!s)s$", "", key)
    return key[:1].upper() + key[1:]


def type_name(info):
    return info if isinstance(info, str) else info.get("name") or info.get("type", "Any")


def label(slot):
    """Type of a slot in a hover: `list[Module]`, `str | None`..."""
    options = []
    if slot.element is not None:
        options.append(f"list[{label(slot.element)}]")
    if slot.dict:
        options.append("dict")
    if slot.shape is not None:
        options.append(display(slot.shape.name))
    scalars = sorted(slot.scalars)
    options += ["float"] if scalars == ["float", "int"] else scalars
    return " | ".join(options) or "None"


def object_shape(slot):
    """The object shape of a slot, or of its list elements."""
    while slot is not None and slot.shape is None:
        slot = slot.element
    return slot.shape if slot is not None else None


def fields_markdown(shape, field_docs):
    """Markdown list of the fields of a shape: `- `name` `type`: explanation`."""
    docs = field_docs.get(shape.name, {})
    lines = [f"**{display(shape.name)}**"]
    for k, v in sorted(shape.fields.items()):
        doc = docs.get(k)
        lines.append(f"- `{k}` `{label(v)}`" + (f": {doc}" if doc else ""))
    return "\n".join(lines)


def type_info(slot, stack, field_docs, documentation=None, fields=False):
    """TypeInfo of jinja-ls (resolveType / getTypeInfoFromJS of its server): a builtin type's name, or
    {name, properties, elementType, documentation}, or a Union of them. Documentation is markdown; objects
    (and with `fields` the value itself, a list of objects too) list their fields."""
    options = []
    if slot.element is not None:
        element = type_info(slot.element, stack, field_docs)
        options.append({"name": f"list[{type_name(element)}]", "elementType": element})
    if slot.dict:
        options.append("dict")
    if slot.shape is not None:
        shape = slot.shape
        info = {"name": display(shape.name)}
        if len(stack) < DOC_DEPTH:
            info["documentation"] = fields_markdown(shape, field_docs)
        if stack.count(shape.name) < MAX_REPEAT and len(stack) < MAX_DEPTH:
            docs = field_docs.get(shape.name, {})
            info["properties"] = {
                k: type_info(v, stack + [shape.name], field_docs, docs.get(k)) for k, v in sorted(shape.fields.items())
            }
        options.append(info)
    scalars = sorted(slot.scalars)
    options += ["float"] if scalars == ["float", "int"] else scalars
    if not options:
        info = "None"
    elif len(options) == 1:
        info = options[0]
    else:
        info = {"type": "Union", "types": options}
    shape = object_shape(slot) if fields else None
    parts = [documentation, fields_markdown(shape, field_docs) if shape is not None else None]
    documentation = "\n\n".join(p for p in parts if p)
    if documentation:
        info = {"type": info} if isinstance(info, str) else dict(info)
        info["documentation"] = documentation
    return info


def split_top(text, separators=",;"):
    """Parts of a text split on the separators outside parentheses and backquotes."""
    parts, depth, quoted, start = [], 0, False, 0
    for i, c in enumerate(text):
        if c == "`":
            quoted = not quoted
        elif not quoted and c == "(":
            depth += 1
        elif not quoted and c == ")":
            depth -= 1
        elif not quoted and depth == 0 and c in separators:
            parts.append(text[start:i])
            start = i + 1
    return [p.strip() for p in parts + [text[start:]] if p.strip()]


def described_fields(cell):
    """A Variables cell as its summary and its fields' explanations: `list of ...: `a` (x), `b` and `c` (y)`
    -> ("list of ...", {"a": "x", "b": "y", "c": "y"}). A cell without a field list is all summary."""
    summary, sep, rest = cell.partition(": ")
    if not sep or not rest.startswith("`"):
        return cell, {}
    fields = {}
    for part in split_top(rest):
        match = re.fullmatch(r"(.*?)\s*\((.*)\)", part, re.S)
        names, doc = (match.group(1), match.group(2)) if match else (part, None)
        for name in re.findall(r"`(\w+)`", names):
            if doc:
                fields[name] = doc
    return summary, fields


def documented_variables():
    """Top-level variables documented in docs/templates.md (its Variables table): their cell's text."""
    docs = {}
    text = (ROOT / "docs/templates.md").read_text()
    section = text.split("## Variables", 1)[1].split("\n## ", 1)[0]
    for line in section.splitlines():
        cells = [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", line.strip().strip("|"))]
        if len(cells) == 2 and cells[0].startswith("`"):
            for name in re.findall(r"`(\w+)`", cells[0]):
                docs[name] = cells[1]
    return docs


def slot_at(top, path):
    """The slot of a context path: `modules[].connections[].from`."""
    slot = None
    for i, part in enumerate(path.split(".")):
        name = part.removesuffix("[]")
        slot = top.get(name) if i == 0 else slot.shape.fields.get(name) if slot and slot.shape else None
        if slot is not None and part.endswith("[]"):
            slot = slot.element
        if slot is None:
            raise SystemExit(f"TEMPLATE_VARIABLES: no {path} in the context")
    return slot


def template_variable(top, field_docs, paths, definition, documentation):
    """TypeInfo of a template variable: what it holds, documented with its schema definition."""
    infos = [type_info(slot_at(top, path), [], field_docs, None, True) for path in paths]
    if len({type_name(i) for i in infos}) == 1:  # one shape at several places: the first one
        infos = infos[:1]
    text = documentation + (f" (schema `{definition}`)" if definition else "")
    if len(infos) > 1:
        return {"type": "Union", "types": infos, "documentation": text}
    info = {"type": infos[0]} if isinstance(infos[0], str) else dict(infos[0])
    info["documentation"] = "\n\n".join(p for p in [text, info.get("documentation")] if p)
    return info


def projects():
    files = sorted(ROOT.glob("examples/**/*.scaffold.yaml")) + sorted(ROOT.glob("examples/**/*.idl"))
    return files + sorted(ROOT.glob("tests/fixtures/*.scaffold.yaml"))


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--binary", default=str(ROOT / "target/release/scaffold-gen"))
    parser.add_argument("--output", default=str(ROOT / ".vscode/settings.json"))
    args = parser.parse_args()

    inferrer = Inferrer()
    top = {}
    for project in projects():
        run = subprocess.run([args.binary, str(project), "--dump-context"], capture_output=True, text=True)
        if run.returncode != 0:
            print(f"skipped {project.relative_to(ROOT)}: {run.stderr.strip()}", file=sys.stderr)
            continue
        for k, v in json.loads(run.stdout).items():
            inferrer.add(top.setdefault(k, Slot()), v, k, "")

    docs = documented_variables()
    field_docs = {}  # shape name -> field -> explanation, from the first variable of that shape explaining it
    summaries = {}
    for k, slot in sorted(top.items(), key=lambda item: list(docs).index(item[0]) if item[0] in docs else len(docs)):
        if k not in docs:
            continue
        summaries[k], fields = described_fields(docs[k])
        shape = object_shape(slot)
        if shape is not None:
            for name, doc in fields.items():
                field_docs.setdefault(shape.name, {}).setdefault(name, doc)
        elif fields:
            summaries[k] = docs[k]
    globals_ = {k: type_info(slot, [], field_docs, summaries.get(k), True) for k, slot in sorted(top.items())}
    for k, (paths, definition, doc) in TEMPLATE_VARIABLES.items():
        globals_[k] = template_variable(top, field_docs, paths, definition, doc)
    globals_["files"] = {"name": "list[str]", "elementType": "str", "documentation": docs.get("files")}
    globals_["generator"] = {
        "name": "Generator",
        "properties": {"name": "str", "reserved": {"name": "list[str]", "elementType": "str"}},
        "documentation": docs.get("generator"),
    }
    filters = {k: {"name": k, "signature": {"documentation": d, "return": "str"}} for k, d in FILTERS.items()}
    for k, (d, params) in FILTER_ARGS.items():
        filters[k] = {
            "name": k,
            "signature": {"documentation": d, "arguments": [{"name": p} for p in params], "return": "str"},
        }

    output = Path(args.output)
    settings = json.loads(output.read_text()) if output.exists() else {}
    settings["jinjaLS.extraGlobals"] = globals_
    settings["jinjaLS.extraFilters"] = filters
    output.parent.mkdir(parents=True, exist_ok=True)
    # One line per global / filter: the file stays readable.
    text = json.dumps({k: "\0" + k if k.startswith("jinjaLS.extra") else v for k, v in settings.items()}, indent=2)
    for k in ("jinjaLS.extraGlobals", "jinjaLS.extraFilters"):
        lines = ",\n".join(f"    {json.dumps(n)}: {json.dumps(v)}" for n, v in settings[k].items())
        text = text.replace(json.dumps("\0" + k), "{\n" + lines + "\n  }")
    output.write_text(text + "\n")
    print(f"{output}: {len(globals_)} globals, {len(inferrer.shapes)} shapes, {output.stat().st_size} bytes")


if __name__ == "__main__":
    main()
