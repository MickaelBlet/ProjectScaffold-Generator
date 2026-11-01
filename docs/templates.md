# Writing templates

A template set is plain files, editable at will: everything specific to the target language lives in its templates, and the generator only gives them the project and a few language-neutral helpers. Start one from a built-in set with _File › Code templates… › Copy the built-in templates into a folder…_; using it: [Code generation › Choosing templates](code-generation.md#choosing-templates).

- [Manifest](#manifest)
- [User sections and whitespace](#user-sections-and-whitespace)
- [Variables](#variables)
- [Filters](#filters)
- [Partials of the C++ sets](#partials-of-the-c-sets)
- [From Liquid](#from-liquid)

## Manifest

A template set is a directory with a `manifest.yaml`:

```yaml
name: cpp17
comment: '//' # starts the user section markers
reserved: alignas alignof and … # names of the model among them are warned about (`generator.reserved`)
partials: [_banner.j2, _type.j2] # only imported or included by the others
outputs:
  - template: module.hpp.j2
    each: modules # Jinja expression: one file per item, bound to `item` (`as:` renames it)
    when: item.kind != 'interface' # optional Jinja condition
    path: "{% from '_header.j2' import header as _header %}include/{{ _header(e=item) }}"
  - template: CMakeLists.txt.j2
    path: CMakeLists.txt
    comment: '#'
```

Templates are [Jinja](https://jinja.palletsprojects.com/templates/), rendered by [MiniJinja](https://github.com/mitsuhiko/minijinja) (its [syntax](https://docs.rs/minijinja/latest/minijinja/syntax/)); `path` is a template, `each` and `when` are expressions.

Template and partial paths are relative to the manifest and stay inside its directory (no `..`, no absolute path); generated file paths stay inside the output directory.

## User sections and whitespace

- `{% filter user('id') %}default{% endfilter %}` writes a user section. `id` is any expression, unique in the file; the markers take the indentation of the tag's line.
- A line holding only a tag (`{% if %}`, `{% for %}`, `{% set %}`…) leaves no line: `trim_blocks` and `lstrip_blocks` are on (`{%+ … %}` keeps the line's indentation, `-` trims as usual); `trimTagLines: false` turns them off.
- Runs of blank lines are collapsed; `squeezeBlankLines: false` keeps them.
- `none` prints nothing. An undefined variable or attribute is an error, except in the condition of an `if`.
- Assignments in a loop stay in the loop: carry values out of it with a namespace (`{% set ns = namespace(n=0) %}`, `{% set ns.n = ns.n + 1 %}`). Python string methods work (`s.rstrip()`, `s.split(',')`, `s.rsplit(',', 1)`).

## Variables

Every value is present in every template and partial (imported macros see them as globals). Source: [`codegen/context.rs`](../src/codegen/context.rs).

| Variable                    | Content                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `project`                   | `name`, `ident`, `description`, `metadata`                                                                                                                                                                                                                                                                         |
| `types`, `interfaces`       | the project's own                                                                                                                                                                                                                                                                                                  |
| `allTypes`, `allInterfaces` | with the dependencies'                                                                                                                                                                                                                                                                                             |
| `moduleTypes`               | the types of the project's modules (each module's `types`), with `scope` (its module's path), `module`, `access`                                                                                                                                                                                                   |
| `allModuleTypes`            | with those of the dependencies' modules                                                                                                                                                                                                                                                                            |
| `typeByKey`                 | every type by its `key`: `typeByKey[t.key]` for a type reference `t`                                                                                                                                                                                                                                               |
| `modules`                   | all, depth first: `name`, `path`, `namespace`, `parent`, `depth`, `binary` (of its top-level module, or none), `kind`, `abstract`, `bases`, `isBase`, `types`, `attributes` and `methods` (with their `access`), `ports` with their `interface` and `delegates`, `children`, `instances`, `connections`, `metadata` |
| `systems`                   | one per binary, or the only one: `name`, `binary`, `instances`, `connections`, `external` links to other projects, `proxies` and `stubs` (links calling or called from another binary, with `local`, `interface` and `peer`)                                                                                       |
| `system`                    | the only system; null when the project has binaries                                                                                                                                                                                                                                                                |
| `binaries`                  | `name`, `description`, `color`, `modules`                                                                                                                                                                                                                                                                          |
| `remoteInterfaces`          | interfaces of the links between binaries                                                                                                                                                                                                                                                                           |
| `remoteLinks`               | `index`, `link`, `interface`, `from` and `to` with their `binary`; `proxies` and `stubs` have the same `index`                                                                                                                                                                                                     |
| `remoteTypes`               | the types their calls use, through other types too                                                                                                                                                                                                                                                                 |
| `constants`                 | the project's own: `name`, `type`, `value`, `description`                                                                                                                                                                                                                                                          |
| `constantsFile`             | the constants as one entity, for `_header` / `_includes`                                                                                                                                                                                                                                                           |
| `remoteConstants`           | constants naming only `remoteTypes`                                                                                                                                                                                                                                                                                |
| `links`, `dependencies`     | as in the file                                                                                                                                                                                                                                                                                                     |
| `files`                     | paths generated so far                                                                                                                                                                                                                                                                                             |
| `generator`                 | `name`, `reserved`                                                                                                                                                                                                                                                                                                 |

- Messages and methods have `params`, `inputs` (`in`, `inout`), `outputs` (`out`, `inout`) and `raises` (references to the exceptions).
- Type references carry `typeKind` and `dependency`, and their bound `max` (null when none) on primitives and containers.
- Types and type references have a `key` (`Name`, `Core.Sensor.Filter`, `Robot/Core.Sensor.Filter`: unique), a `scope` (the path of their module, empty for the others) and a `flatName` (`Core_Sensor_Filter`, for flat namespaces).
- Types, interfaces and modules have `uses`: `types` (the user types they name) and `builtins` (the primitives and containers).

## Filters

Besides [MiniJinja's](https://docs.rs/minijinja/latest/minijinja/filters/):

| Filter                                          | Effect                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `snake`, `camel`, `pascal`, `kebab`, `constant` | case conversion                                                             |
| `ucfirst`, `lcfirst`                            | first letter upper / lower case                                             |
| `doc_comment('/// ')`                           | each line of a text after the prefix; no line at all for an empty text      |
| `uuid`                                          | a UUID made from the text, the same at each generation (ids of descriptors) |
| `json`                                          | a value as JSON (`JSON.stringify`)                                          |
| `escape`                                        | `&`, `<`, `>`, `"`, `'` as XML entities                                     |
| `replace(old, new, count)`                      | Jinja's, with an optional count                                             |

## Partials of the C++ sets

In [`templates/cpp17`](../templates/cpp17), the `_*.j2` partials hold one macro each, which spells the C++ of the model; the other templates import and call them: `{% from '_type.j2' import type as _type %}` then `{{ _type(t=field.type) }}`.

| Partials                                                         | Spell                      |
| ---------------------------------------------------------------- | -------------------------- |
| `_type`                                                          | type references            |
| `_value`                                                         | default values as literals |
| `_params`, `_input`, `_scalar`                                   | parameter passing          |
| `_name`, `_id`, `_accessor`, `_member`                           | names                      |
| `_ns`, `_qualified`, `_header`, `_source`                        | namespaces and files       |
| `_includes`, `_endpoint`                                         | wiring expressions         |
| `_address`, `_address_variable`, `_generated_transport`          | links between binaries     |
| `_py_type`, `_py_value`, `_py_zero`, `_py_encode`, `_py_decode`… | the Python peers           |

## From Liquid

Template sets written in Liquid for earlier versions convert with `scripts/dev/liquid2jinja.py <set> <new set>` (python3): same output, whitespace included; partials become macros, `render` becomes a macro call. A variable an included template assigns for the template including it needs a namespace instead (Jinja's `include` does not hand assignments back): fix those by hand. Check the result with `scaffold-gen -t <new set>` on a few projects.
