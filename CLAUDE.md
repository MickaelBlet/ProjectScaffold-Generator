# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ProjectScaffold-Generator: generates code skeletons from ProjectScaffold project files (YAML/JSON, or OMG IDL) through Jinja template sets (MiniJinja). Command line only, in Rust: `scaffold-gen`, one static executable; template sets given with `-t <folder>` (embedded only with the `builtin-templates` feature). The editor lives in ProjectScaffold-Viewer (separate repository, TypeScript, its own copy of the model).

## Commands

```sh
cargo test                            # (--features builtin-templates too) unit tests (src/) and tests/cli.rs (tests/errors, every example with every set)
cargo test -- error_messages          # one test
cargo clippy --all-targets
cargo fmt                             # rustfmt.toml: width 110
cargo run --release -- <project file> -d   # generate code (default set cpp17) with its dependencies
scripts/build_cli.sh [target]         # static dist-cli/scaffold-gen (musl by default; x86_64-pc-windows-msvc via cargo-xwin)
scripts/check_remote.sh [-t <set>]    # calls between binaries: C++ <-> Python over each transport (cmake, python3)
scripts/check_templates.sh [set]...   # generate examples/fixtures with each built-in template set, build them
```

- `SCAFFOLD_GEN_DEBUG=1` prints template errors with their source and variables.
- In this environment a shell wrapper filters `cargo`, `diff`, `grep` output (and `diff`'s exit code): use `command diff`, `command cmp`, `/usr/bin/grep`, `~/.cargo/bin/cargo` when the exact output matters.

## Architecture

### Model (`src/model/`)

- Port of the editor's model, kept to what generation needs, working on the file format (qualified names, no ids): file format changes (schema, validation, IDL...) must be made in both repositories.
- `text.rs`: YAML 1.2 core schema / JSON read into `serde_json::Value` with the line of each node (`Lines::of(data path)`, as the editor's `lineOfPath`); numbers and object key order as JavaScript has them.
- `schema.rs`: structure check against `viewer/schema/scaffold.schema.json` (embedded) with zod's messages. `viewer/` is the ProjectScaffold-Viewer submodule, which generates the schema (zod, `npm run schema` there): bump the submodule when the format changes (`git submodule update --remote viewer`).
- `load.rs`: names, duplicates, unknown references (errors with lines) and the `Index` of types, interfaces, constants, modules, placed modules, links. `values.rs`: default values / constants against their type, YAML flow formatting. `validate.rs`: semantic errors, in the editor's order. `idl.rs`: OMG IDL files read as projects (self-contained).
- Error messages are those of the editor (`Line N: …`), printed clang-style by `src/diagnostic.rs` (`file:N:col: error: …` + excerpt): `tests/errors/<case>.expected` (cases written by `scripts/dev/make_error_cases.py`).

### Code generation (`src/codegen/`, `templates/`)

- `context.rs` builds the template context (every value present; links sorted into wiring per container / `system`) over the arena of `node.rs`: entities are shared and filled after creation, recursive types make cycles; minijinja reads nodes lazily (`Object`), compared by identity.
- `generate.rs` renders a template set (`template_set.rs`: `manifest.yaml` + Jinja files) with the context as globals and only language-neutral helpers (`filters.rs`: case filters, `doc_comment`, `uuid`, `json`, Liquid-like `escape` and `replace`; `sections.rs`: the `user` filter and merging of user sections; `inline.rs`: `{% filter inline %}` blocks joined on one line in the template source): target-language logic belongs in the templates (`templates/cpp17/_*.j2` macros), so users can edit it. `run.rs` writes into an `OutputDir` (merge, conflicts, `.orphans`, `.scaffold-gen.json` record). `builtin.rs`: the sets embedded with `include_dir` (feature `builtin-templates`, off by default).
- Jinja environment: `trim_blocks` + `lstrip_blocks` (manifest `trimTagLines`), undefined values are errors except in `if` (SemiStrict), `none` prints nothing; partials are macros (`{% from '_x.j2' import x as _x %}`), inline fragments in `{% filter inline %}` (plain text, no `{{- '…' -}}`), sections `{% filter user('id') %}…{% endfilter %}`, Python string methods (pycompat, `rsplit`).
- `src/main.rs`: the command line (`-o -t -d -f -p -n -k -v`; hidden `--dump-context`, `--context <json>`).
- Check template changes by building the output: `cargo run --release -- tests/fixtures/plant.scaffold.yaml -o /tmp/gen/plant` then CMake with `-Wall -Wextra -Werror`, or `scripts/check_templates.sh <set>`.
- Built-in template sets: `templates/<set>/`, one self-contained flat copy each, listed in `src/codegen/builtin.rs`; a project picks one with `generation.templates`. A fix to one C++ set usually applies to the others.
- `templates/sca-cpp98`: SCA 2.2.2 over CORBA (omniORB), not derived from the C++ sets (CORBA C++ mapping in `_cx_*`, IDL in `_idl_*`); building it needs omniidl (`scripts/check_templates.sh sca-cpp98`, `OMNIORB_ROOT` for an omniORB elsewhere).
- Links between binaries: `wire.hpp` / `transport.cpp` of every C++ set and `wire.py` / `transport.py` (Python peers under `python/<ns>/`, same template set) implement one protocol and must change together; `scripts/check_remote.sh -t <set>` checks them against each other. The `python` set reuses the C++ sets' `*.py.j2` / `_py_*` files (only `data.py`, `constants.py`, `init.py`, `wire.py`'s docstring differ): keep them in step.
- `scripts/dev/liquid2jinja.py`: converts users' Liquid template sets (of earlier versions) to Jinja.

## Conventions

- Update `CHANGELOG.md` `[Unreleased]` (Keep a Changelog) and the user documentation (`README.md`, `docs/*.md`) for user-visible changes; update `examples/` and the schema when the file format changes. A release removes the `[Unreleased]` heading: add it back above the latest version (its compare link at the bottom stays).
- Update `THIRD.md` when the shipped crates change (`cargo tree -e normal`).
- Commit each finished feature or fix with the `commit-gpg` skill (GPG-signed commit, CHANGELOG checked).
