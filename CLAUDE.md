# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ProjectScaffold: browser editor for software architecture (modules, ports, typed interfaces, constrained links) that saves a language-agnostic YAML/JSON project file meant to feed code skeleton generators. One React web build (`dist-web/index.html`, a single self-contained file) runs in the browser, in Electron, in Tauri and in VS Code webviews.

## Commands

```sh
npm run dev                          # Vite dev server
npm run build                        # typecheck (web) + single-file dist-web/index.html
npm run typecheck                    # node + web + vscode tsconfigs
npm test                             # vitest, tests/**/*.test.ts
npx vitest run tests/validate.test.ts          # one file
npx vitest run -t 'part of a test name'        # one test
npm run lint                         # eslint, type-checked rules + react-hooks
npm run schema                       # regenerate schema/scaffold.schema.json from model/schema.ts
npm run generate -- <project file> -d   # generate code (templates/cpp17) with its dependencies
scripts/build_web.sh --check         # lint + test + build
scripts/build_cli.sh                 # standalone generator dist-cli/scaffold-gen (Node SEA) + .cjs bundle
scripts/check_remote.sh [-t <set>]  # calls between binaries: C++ <-> Python over each transport (cmake, python3)
scripts/check_templates.sh [set]...  # generate examples/fixtures with each built-in template set, build them
npm run build && npm run vscode:compile   # VS Code extension dev build (vscode/out, vscode/media)
scripts/build_vscode.sh              # .vsix into dist-vscode/
scripts/build_desktop.sh             # Tauri + Electron in Docker (docker buildx bake)
scripts/build_all.sh [--check] [web|cli|vscode|desktop]...   # all of the above (default: all)
```

- `tests/serialize.test.ts` fails when `schema/scaffold.schema.json` is stale: run `npm run schema` after changing `model/schema.ts`.
- Prettier: no semicolons, single quotes, width 110, no trailing commas.
- `@/` aliases `src/renderer/src/`.

## Architecture

### Model (`src/renderer/src/model/`, pure, no React)

- Two representations: the in-memory `Project` (`types.ts`) references entities by **id**; the file format (`schema.ts`, zod, source of the published JSON Schema) references them by **qualified name** (`Core.Sensor`). `serialize.ts` converts between them and YAML/JSON text; the `editor` section holds layout/view data, stripped on export.
- `validate.ts`: semantic checks; errors block export, warnings do not. `locate.ts` maps problems to text lines, `outline.ts` reads an outline from the raw YAML (both used by the text editor and VS Code).
- `dependencies.ts`: other project files a project uses. Their types/interfaces are copied into the project's `types` / `interfaces` with `dependency` set (snapshot, so files stay self-contained for generators); placed modules of dependencies are "imported modules". `sync.ts` carries renames to dependent projects.
- `reuse.ts`: reloading from text keeps existing entity ids so selection, editors and views survive text edits.
- Tests exercise the model only (`tsconfig.node.json` includes `tests/` and `model/`).

### Code generation (`src/renderer/src/codegen/`, pure, no React; `templates/cpp17/`)

- `context.ts` turns the exported `FileProject` into the template context (every value present: Liquid runs with strict variables; links sorted into wiring per container / `system`). `generate.ts` renders a template set (`templateSet.ts`: `manifest.yaml` + Liquid files) with the context as Liquid globals and only language-neutral helpers (case filters in `filters.ts`, `doc_comment`, the `user` tag): target-language logic belongs in the templates (`templates/cpp17/_*.liquid` partials), so users can edit it. `sections.ts`: the `{% user %}` tag and merging of user sections. `run.ts` writes into an `OutputDir` (merge, conflicts, `.orphans`, `.scaffold-gen.json` record).
- Hosts give the `OutputDir`: `scripts/generate.ts` (CLI, node fs; `scripts/build-cli.ts` bundles it as CommonJS, no top-level await, with the templates embedded in place of `scripts/builtinTemplates.ts`, into a Node single executable), `webApi.ts` (File System Access directory handle), `vscodeApi.ts` (`outputDir` / `outputFile` messages, `vscode/src/session.ts`). `generateCode.ts` bundles `templates/cpp17` into the web build (`import.meta.glob`).
- Check template changes by building the output: `npm run generate -- tests/fixtures/plant.scaffold.yaml -o /tmp/gen/plant` then CMake with `-Wall -Wextra -Werror`.
- Built-in template sets: `templates/<set>/`, one self-contained flat copy each (the web glob and CLI embedding are not recursive), listed in `model/templateSets.ts`; a project picks one with `generation.templates`. A fix to one C++ set usually applies to the others.
- Links between binaries: `wire.hpp` / `transport.cpp` of every C++ set and `py_wire` / `py_transport` (Python peers under `python/<ns>/`, same template set) implement one protocol and must change together; `scripts/check_remote.sh -t <set>` checks them against each other. The `python` set reuses the C++ sets' `py_*` / `_py_*` files (only `py_data`, `py_constants`, `py_init`, `py_wire`'s docstring differ): keep them in step.

### State (`src/renderer/src/store/`)

- `documents.ts`: open tabs; each document has its own zustand project store with a zundo undo history (`projectStore.ts`; edits within 400 ms merge into one undo step).
- Projects are updated immutably (immer); canvas and lists rely on unchanged objects keeping their identity (`canvas/reuseUnchanged.ts`) to avoid re-rendering.
- `store/sync.ts` pushes a document's renames and definitions to the open documents depending on it, each as an undoable edit of its own.

### Commands and UI

- `commands.ts` is the single command registry behind menus (`shell/MenuBar.tsx`), context menus, the command palette and shortcuts; `actions.ts` holds the editing actions on the active document. `shell/controllers.ts` gives commands handles on mounted canvases and dock layouts.
- `canvas/`: React Flow (`@xyflow/react`). `flowGraph.ts` builds nodes/edges from the project; `portSides.ts` / `linkRoute.ts` place ports and route links; layout via ELK (`model/autoLayout.ts`).
- Panels are dockview panels (`panels/`, `shell/DockShell.tsx`).

### Hosts

- `host.ts` detects the host (`IN_VSCODE`, preview, side panel). `main.tsx` installs the file API (`api.d.ts` `Api`) from `webApi.ts` (browser: File System Access API, IndexedDB recents; also used by Electron and Tauri) or `vscodeApi.ts`.
- Preferences go through `storage.ts` (localStorage, or the extension's global state in VS Code), not `localStorage` directly.
- Desktop window controls: `window.desktop` from `electron/preload.cjs`, or `tauriDesktop.ts`; both frameless, drawn by `shell/WindowFrame.tsx`.
- VS Code extension (`vscode/src/`): the `TextDocument` is the source of truth; `session.ts` binds a webview page (full editor, preview beside the text, or side-bar panel) to a document. `protocol.ts` types the messages and is imported by the page too. Commands not available in VS Code are left out of the registry, and menus drop them.

## Conventions

- Update `CHANGELOG.md` `[Unreleased]` (Keep a Changelog) and README for user-visible changes; update `examples/` and the schema when the file format changes.
- Build scripts install with `npm ci` when `node_modules` is older than the lockfile.
- Commit each finished feature or fix with the `commit-gpg` skill (GPG-signed commit, CHANGELOG checked).
