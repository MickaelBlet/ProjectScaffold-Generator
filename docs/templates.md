# Writing templates

A template set is plain files, editable at will: everything specific to the target language lives in its templates, and the generator only gives them the project and a few language-neutral helpers. Start one from a built-in set with _File › Code templates… › Copy the built-in templates into a folder…_; using it: [Code generation › Choosing templates](code-generation.md#choosing-templates).

- [Manifest](#manifest)
- [User sections and whitespace](#user-sections-and-whitespace)
- [Variables](#variables)
- [Filters](#filters)
- [Partials of the C++ sets](#partials-of-the-c-sets)

## Manifest

A template set is a directory with a `manifest.yaml`:

```yaml
name: cpp17
comment: '//' # starts the user section markers
reserved: alignas alignof and … # names of the model among them are warned about (`generator.reserved`)
partials: [_banner.liquid, _type.liquid] # used by {% render %} / {% include %} only, named without `.liquid`
outputs:
  - template: module.hpp.liquid
    each: modules # one file per item, bound to `item` (`as:` renames it)
    when: item.kind != 'interface' # optional condition
    path: "include/{% render '_header', e: item %}"
  - template: CMakeLists.txt.liquid
    path: CMakeLists.txt
    comment: '#'
```

Template and partial paths are relative to the manifest and stay inside its directory (no `..`, no absolute path); generated file paths stay inside the output directory.

## User sections and whitespace

- `{% user 'id' %}default{% enduser %}` writes a user section. `id` is any Liquid expression, unique in the file; the markers take the indentation of the tag's line.
- A line holding only a tag (`{% if %}`, `{% for %}`, `{% render %}`…) leaves no line; `trimTagLines: false` keeps them.
- Runs of blank lines are collapsed; `squeezeBlankLines: false` keeps them.
- Logic reads best in a `{%- liquid … -%}` block: one tag per line, `echo` to write.

## Variables

Every value is present in every template and partial: templates run with strict variables. Source: [`codegen/context.ts`](../src/renderer/src/codegen/context.ts).

| Variable                    | Content                                                                                                                                                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`                   | `name`, `ident`, `description`, `metadata`                                                                                                                                                                                                                                       |
| `types`, `interfaces`       | the project's own                                                                                                                                                                                                                                                                |
| `allTypes`, `allInterfaces` | with the dependencies'                                                                                                                                                                                                                                                           |
| `modules`                   | all, depth first: `name`, `path`, `namespace`, `parent`, `depth`, `binary` (of its top-level module, or nil), `kind`, `abstract`, `bases`, `isBase`, `attributes`, `methods`, `ports` with their `interface` and `delegates`, `children`, `instances`, `connections`, `metadata` |
| `systems`                   | one per binary, or the only one: `name`, `binary`, `instances`, `connections`, `external` links to other projects, `proxies` and `stubs` (links calling or called from another binary, with `local`, `interface` and `peer`)                                                     |
| `system`                    | the only system; null when the project has binaries                                                                                                                                                                                                                              |
| `binaries`                  | `name`, `description`, `color`, `modules`                                                                                                                                                                                                                                        |
| `remoteInterfaces`          | interfaces of the links between binaries                                                                                                                                                                                                                                         |
| `remoteLinks`               | `index`, `link`, `interface`, `from` and `to` with their `binary`; `proxies` and `stubs` have the same `index`                                                                                                                                                                   |
| `remoteTypes`               | the types their calls use, through other types too                                                                                                                                                                                                                               |
| `constants`                 | the project's own: `name`, `type`, `value`, `description`                                                                                                                                                                                                                        |
| `constantsFile`             | the constants as one entity, for `_header` / `_includes`                                                                                                                                                                                                                         |
| `remoteConstants`           | constants naming only `remoteTypes`                                                                                                                                                                                                                                              |
| `links`, `dependencies`     | as in the file                                                                                                                                                                                                                                                                   |
| `files`                     | paths generated so far                                                                                                                                                                                                                                                           |
| `generator`                 | `name`, `reserved`                                                                                                                                                                                                                                                               |

- Messages and methods have `params`, `inputs` (`in`, `inout`), `outputs` (`out`, `inout`) and `raises` (references to the exceptions).
- Type references carry `typeKind` and `dependency`, and their bound `max` (null when none) on primitives and containers.
- Types, interfaces and modules have `uses`: `types` (the user types they name) and `builtins` (the primitives and containers).

## Filters

Besides Liquid's:

| Filter                                          | Effect                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `snake`, `camel`, `pascal`, `kebab`, `constant` | case conversion                                                             |
| `ucfirst`, `lcfirst`                            | first letter upper / lower case                                             |
| `doc_comment: '/// '`                           | each line of a text after the prefix; no line at all for an empty text      |
| `uuid`                                          | a UUID made from the text, the same at each generation (ids of descriptors) |

## Partials of the C++ sets

In [`templates/cpp17`](../templates/cpp17), the `_*.liquid` partials spell the C++ of the model; the other templates use them with `{% render '_type', t: field.type %}`.

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
