#!/usr/bin/env python3
"""Types of the template context for the Jinja LS VS Code extension (noamzaks.jinja-ls).

Infers the shape of every value of the context from `scaffold-gen --dump-context` over the examples and
fixtures, and writes it as `jinjaLS.extraGlobals` (with the custom filters as `jinjaLS.extraFilters`) into
.vscode/settings.json (other settings kept): completion and hover of `modules`, `m.methods`, `t.fields`...
in every template. Recursive shapes (a module's `bases`, a type's `uses`...) are unrolled to MAX_REPEAT / MAX_DEPTH.

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


def type_info(slot, stack, documentation=None):
    """TypeInfo of jinja-ls (resolveType / getTypeInfoFromJS of its server): a builtin type's name, or
    {name, properties, elementType, documentation}, or a Union of them."""
    options = []
    if slot.element is not None:
        element = type_info(slot.element, stack)
        options.append({"name": f"list[{type_name(element)}]", "elementType": element})
    if slot.dict:
        options.append("dict")
    if slot.shape is not None:
        shape = slot.shape
        info = {"name": display(shape.name)}
        if stack.count(shape.name) < MAX_REPEAT and len(stack) < MAX_DEPTH:
            info["properties"] = {k: type_info(v, stack + [shape.name]) for k, v in sorted(shape.fields.items())}
        options.append(info)
    scalars = sorted(slot.scalars)
    options += ["float"] if scalars == ["float", "int"] else scalars
    if not options:
        info = "None"
    elif len(options) == 1:
        info = options[0]
    else:
        info = {"type": "Union", "types": options}
    if documentation:
        info = {"type": info} if isinstance(info, str) else dict(info)
        info["documentation"] = documentation
    return info


def documented_variables():
    """Top-level variables documented in docs/templates.md (its Variables table)."""
    docs = {}
    text = (ROOT / "docs/templates.md").read_text()
    section = text.split("## Variables", 1)[1].split("\n## ", 1)[0]
    for line in section.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 2 and cells[0].startswith("`"):
            for name in re.findall(r"`(\w+)`", cells[0]):
                docs[name] = cells[1]
    return docs


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
    for k in ("allTypes", "allInterfaces"):
        docs.setdefault(k, docs.get("types"))
    globals_ = {k: type_info(slot, [], docs.get(k)) for k, slot in sorted(top.items())}
    globals_["files"] = {"name": "list[str]", "elementType": "str", "documentation": docs.get("files")}
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
