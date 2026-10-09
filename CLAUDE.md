# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ProjectScaffold-Generator: generates code skeletons from ProjectScaffold project files (YAML/JSON, or OMG IDL) through Liquid template sets. Command line only: `scripts/generate.ts`, bundled into a standalone executable. The editor lives in ProjectScaffold-Viewer (separate repository, its own copy of the model).

## Commands

```sh
npm test                             # vitest, tests/**/*.test.ts
npx vitest run tests/codegen.test.ts           # one file
npx vitest run -t 'part of a test name'        # one test
npm run typecheck
npm run lint                         # eslint, type-checked rules
npm run schema                       # regenerate schema/*.schema.json from src/model/schema.ts
npm run generate -- <project file> -d   # generate code (default set cpp17) with its dependencies
scripts/build_cli.sh                 # standalone dist-cli/scaffold-gen (Node SEA) + .cjs bundle
scripts/check_remote.sh [-t <set>]  # calls between binaries: C++ <-> Python over each transport (cmake, python3)
scripts/check_templates.sh [set]...  # generate examples/fixtures with each built-in template set, build them
```

- `tests/serialize.test.ts` fails when `schema/scaffold.schema.json` is stale: run `npm run schema` after changing `src/model/schema.ts`.
- Prettier: no semicolons, single quotes, width 110, no trailing commas.

## Architecture

### Model (`src/model/`, pure)

- Copy of the editor's model (ProjectScaffold-Viewer `src/renderer/src/model/`), kept to what generation needs: file format changes (`schema.ts`, `serialize.ts`, `validate.ts`, `dependencies.ts`, `idl.ts`...) must be made in both repositories.
- Two representations: the in-memory `Project` (`types.ts`) references entities by **id**; the file format (`schema.ts`, zod, source of the published JSON Schema) references them by **qualified name** (`Core.Sensor`). `serialize.ts` converts between them and YAML/JSON text; the `editor` section holds layout/view data, stripped on export.
- `validate.ts`: semantic checks; errors block generation, warnings do not.
- `dependencies.ts`: other project files a project uses; their types/interfaces are copied into the project with `dependency` set. `idl.ts`: OMG IDL files read as projects.

### Code generation (`src/codegen/`, pure; `templates/`)

- `context.ts` turns the exported `FileProject` into the template context (every value present: Liquid runs with strict variables; links sorted into wiring per container / `system`). `generate.ts` renders a template set (`templateSet.ts`: `manifest.yaml` + Liquid files) with the context as Liquid globals and only language-neutral helpers (case filters in `filters.ts`, `doc_comment`, the `user` tag): target-language logic belongs in the templates (`templates/cpp17/_*.liquid` partials), so users can edit it. `sections.ts`: the `{% user %}` tag and merging of user sections. `run.ts` writes into an `OutputDir` (merge, conflicts, `.orphans`, `.scaffold-gen.json` record).
- `scripts/generate.ts`: the command line (node fs `OutputDir`); `scripts/build-cli.ts` bundles it as CommonJS, no top-level await, with the templates embedded in place of `scripts/builtinTemplates.ts`, into a Node single executable.
- Check template changes by building the output: `npm run generate -- tests/fixtures/plant.scaffold.yaml -o /tmp/gen/plant` then CMake with `-Wall -Wextra -Werror`.
- Built-in template sets: `templates/<set>/`, one self-contained flat copy each (the CLI embedding is not recursive), listed in `src/model/templateSets.ts`; a project picks one with `generation.templates`. A fix to one C++ set usually applies to the others.
- `templates/sca-cpp98`: SCA 2.2.2 over CORBA (omniORB), not derived from the C++ sets (CORBA C++ mapping in `_cx_*`, IDL in `_idl_*`); building it needs omniidl (`scripts/check_templates.sh sca-cpp98`, `OMNIORB_ROOT` for an omniORB elsewhere).
- Links between binaries: `wire.hpp` / `transport.cpp` of every C++ set and `wire.py` / `transport.py` (Python peers under `python/<ns>/`, same template set) implement one protocol and must change together; `scripts/check_remote.sh -t <set>` checks them against each other. The `python` set reuses the C++ sets' `*.py.liquid` / `_py_*` files (only `data.py`, `constants.py`, `init.py`, `wire.py`'s docstring differ): keep them in step.

## Conventions

- Update `CHANGELOG.md` `[Unreleased]` (Keep a Changelog) and the user documentation (`README.md`, `docs/*.md`) for user-visible changes; update `examples/` and the schema when the file format changes. A release removes the `[Unreleased]` heading: add it back above the latest version (its compare link at the bottom stays).
- Build scripts install with `npm ci` when `node_modules` is older than the lockfile.
- Commit each finished feature or fix with the `commit-gpg` skill (GPG-signed commit, CHANGELOG checked).
