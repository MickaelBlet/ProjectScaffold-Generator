# ProjectScaffold

Browser editor for software architecture: modules, ports, typed interfaces and constrained links.
Exports a language-agnostic YAML/JSON file meant to feed code skeleton generators.

![ProjectScaffold editor with the robot example](docs/demo.png)

## Commands

```sh
npm install
npm run dev          # dev server with hot reload
npm run build        # typecheck + single self-contained dist-web/index.html
npm run preview      # serve the production build
npm test             # unit tests (model, serialization, validation)
npm run schema       # regenerate schema/scaffold.schema.json
npm run lint
npm run generate -- examples/robot.scaffold.yaml -d   # C++17 code, see Code generation
```

Desktop app (Tauri), built in Docker for Linux amd64 (`.deb`, `.rpm`, `.AppImage`) and Windows amd64 (NSIS installer + portable `.exe`, needs WebView2):

```sh
scripts/build_tauri.sh   # -> dist-tauri/linux/, dist-tauri/windows/
npm run tauri dev        # local dev window (needs Rust + webkit2gtk-4.1)
```

Portable desktop app (Electron, bundles Chromium: no WebView2 needed), built in Docker for Linux x64 (`.AppImage`, `.tar.gz`) and Windows x64 (portable `.exe`, `.zip`):

```sh
scripts/build_electron.sh   # -> dist-electron/linux/, dist-electron/windows/
npm run electron            # local window from the web build
```

Both desktop apps at once (parallel, shared web build): `scripts/build_desktop.sh` (`docker buildx bake`).

VS Code extension: `*.scaffold.yaml` / `.yml` / `.json` files open as text, with an editable diagram preview beside them (_Open Preview_ in the editor title, or Ctrl+K V), like the Markdown preview: on the left of the text by default, and the _ProjectScaffold_ side bar opens with it (settings `projectScaffold.preview.position`, `projectScaffold.preview.showSideBar`); the full-window diagram is under _Reopen Editor With… › ProjectScaffold_ (or _Open in Full Diagram Editor_ from the explorer menu for any YAML/JSON project file). The file stays a VS Code text document (dirty state, save, hot exit, git diff). The text cursor and the diagram selection follow each other (setting `projectScaffold.syncSelection`). Undo in the preview undoes the diagram's changes; undo in the text, the text's. The app's Explorer, Modules, Links and Settings are in the _ProjectScaffold_ side bar (activity bar), for the project file being edited: selecting there shows it in the diagram and the text. Problems go to the VS Code Problems panel on the line of their entity; the outline to the Outline view and breadcrumbs of the text. Dependencies are refreshed from the files next to the document. With the theme setting _VS Code_ (the default), the colors are those of the VS Code color theme. While a diagram has the focus, its shortcuts win over VS Code's.

```sh
scripts/build_vscode.sh     # -> dist-vscode/project-scaffold-<version>.vsix (or: docker buildx bake vscode)
code --install-extension dist-vscode/project-scaffold-*.vsix
```

Development: `npm run build && npm run vscode:compile`, then `code --extensionDevelopmentPath="$PWD/vscode" examples` opens an Extension Development Host.

`dist-web/index.html` works from `file://` or any static host. Files are read and written through the File System Access API when available (Chrome, Edge), otherwise through a file input and a download.

## Editor

### Workspace

- **Document tabs**: several projects open at once, each with its own undo history (Alt+N new, Alt+W close, Alt+1…9 / Alt+PageUp/PageDown to switch, middle click to close, drag to reorder). Open documents and their unsaved edits are restored after a page reload.
- **Dockable panels** (Explorer, Modules, Inspector, Problems, Search, Settings): drag a tab to dock it on any side, stack it with others or float it. The layout is kept; _Window › Reset panel layout_ restores the default one.
- **Views**: each document has a _Global_ view plus any number of stored views, opened as tabs and splittable side by side. _Open module in its own view_ (Alt+Enter, or ⤢ on a container) shows one module's content, with stand-ins for the outside modules it is linked to and a breadcrumb back to the parents. Modules can be hidden per view (H, or the eye in the Modules panel; Shift+H shows them again).
- **Editor tabs**: double-click a type or interface in the Explorer (or ↗ in the Inspector) to edit it in a tab of its own.
- **Command palette**: Ctrl+Shift+P (or F1) runs any command; Ctrl+P goes to a module, type, interface, link or view. `?` lists every shortcut.

### Diagram

- Right click the canvas for its menu, double-click it to zoom in (Shift+double-click to zoom out); **+ Module** (Ctrl+M) adds a module. Drop a module onto another to nest it; drag it out to move it up.
- Ports: `in` on the left, `out` on the right — or `in` on top, `out` at the bottom in vertical orientation. Drag between an `out` port and an `in` port to create a link; a container's `in` port links to an `in` port inside it, an `out` port inside to the container's `out` port. Or link modules directly: drag the → in a module's header onto another module (or one of its `in` ports), or drag a port onto a module; the missing `out` / `in` ports are added, typed with the other end's interface. Ports follow their links: on a module without submodules, each port (dot and name) moves to the edge facing the modules it is linked to — top / bottom for modules one above the other, left / right otherwise. Containers keep their ports on the default edges and their links leave from the facing side (_View › Auto-orient link ends_).
- **Link shape** (like draw.io): select a link, then drag its line to add a bend, drag a bend to move it (snaps to the grid and in line with its neighbours; Alt: free), double-click a bend to remove it. Drag an end square along its module's border to attach the link there; double-click it to attach at the port again. _Reset shape_ in the link's menu. Bends move with the module holding both ends, and with both ends when they are moved together; _Arrange_ clears them. Saved in `editor.links`.
- Selection: click, Ctrl+click to add, Shift+drag for a box. Arrows move the selection (Shift: further), F fits it, Shift+F fits everything.
- **Copy / cut / paste / duplicate** (Ctrl+C / X / V / D) several items at once: modules with their content and the links between them, notes, types and interfaces — within a document, between document tabs, and between browser windows (system clipboard). Interfaces and types are matched by name when pasted into another project.
- Attributes: listed as `name: type = default` in a compartment below the module's header, apart from the ports on its border where links attach. Edit them in the module's inspector, with their default value: a choice for `bool` and enums, a YAML flow literal checked against the type otherwise (the placeholder shows the expected shape).
- Methods: prototypes listed as `static name(const a: T, out b: U): R const` in a compartment below the attributes. Edit them in the module's inspector like interface messages — parameters with their direction, an optional return type — with their `static` and `const` qualifiers, and `const` on `in` parameters.
- Attributes and methods can be `static` and `const` (checkboxes in the inspector), shown before their name on the canvas.
- C++-like classes: a module's _Kind_ is `class` (concrete, default), `abstract` or `interface` (only pure methods, no attributes), shown as `«interface» Name` in italics; its _Bases_ are modules it derives from, shown as `Name : Base` and as UML arrows from the module to each base (hollow triangle, dashed to an interface; click selects the module, right click goes to or removes the base; _View › Inheritance arrows_ hides them). Methods can be `virtual`, `pure` (`= 0`) and `override`, shown as `virtual name(): R const override = 0`. _Implement_ in the Methods section adds the pure methods a module inherits and lacks, as overrides.
- Right click anything for its actions. F2 or double-click a module name to rename it in place.
- **Arrange**: _Auto-arrange_ (Ctrl+Alt+L) lays out the selected container's content, the view's module, or everything, with ELK (layered, port aware, nested modules). _Arrange horizontally_ (Ctrl+Alt+H) and _vertically_ (Ctrl+Alt+V) also set the document's orientation: ports on the sides with links flowing right, or ports and their names on the top / bottom edges with links flowing down (saved in `editor.orientation`). Align, distribute, same size and _Group into a module_ (Ctrl+G) act on the selection. Alignment guides and snap to grid while dragging.
- **Dependencies** (another project file used by this one): _Insert › Add dependency…_ (or + in the Explorer's _Dependencies_) picks an open document or a project file whose types and interfaces this project then uses, read-only, like its own ones (one namespace). Its modules can be linked to: _Insert › Link to another project…_ (or the canvas menu) picks a dependency or another project, then one of its modules, which is drawn in the global view (dashed, `↗ Project`, resizable) with ports linked to like any other; the project becomes a dependency if it was not one, so the interfaces of its ports are used here, not copied. The dependencies of a dependency come with it (`indirect`). A name defined both here and in a dependency is taken only when both definitions are the same (the entity becomes the dependency's); two dependencies defining a name the same way share it; a different definition is left out, with a warning. See [`examples/common.scaffold.yaml`](examples/common.scaffold.yaml) (types and interfaces only), used by [`examples/robot.scaffold.yaml`](examples/robot.scaffold.yaml), both used by [`examples/station.scaffold.yaml`](examples/station.scaffold.yaml), which links to a module of the robot. Edits made in a dependency's open tab reach the documents using it at once; files that are not open catch up on _Refresh dependencies_ (types and interfaces no longer there but still used here stay, as own ones; links to removed ports are dropped). In the Explorer and the _Dependencies_ panel, a dependency opens, refreshes, places a module on the canvas, is removed (when nothing here uses it) or _detached_ (its types and interfaces become this project's own). Double-click a placed module to switch to its project's tab.
- **Import another project** (_Insert_ menu, or right click the canvas / a module): copies the whole content of an open document or a project file into the selected module (or here): its modules with their links, its notes at the top level, and the types and interfaces this project lacks — the others are matched by name. The copy is not linked to that project, but its dependencies become this project's.
- **Renames stay in sync** with dependencies: renaming a module (or a parent), a port, a type or an interface in one project renames it in the open projects depending on it. Each document gets the change as its own undoable edit (and becomes unsaved). Files that are not open catch up on _Refresh dependencies_: a placed module no longer found by path is matched to the only other module with the same name (moved) or the same ports (renamed); the dialog lists what was renamed.
- Module colors, sticky notes and titled frames (right click the canvas) help organize the diagram; dragging a frame moves what lies fully inside it. They are editor data only.
- **Export diagram** as PNG or SVG (_File_ menu).

### Model

- Types (struct / enum / alias) and interfaces (messages with typed `in` / `out` / `inout` parameters and optional return) are listed in the Explorer. Type fields accept expressions with completion (`map<string, vector<uint16>>`), or the structured editor (⋮). Inspectors list where a type or interface is used.
- The **Problems** panel validates live (filter by severity or text). Errors block export, warnings do not.
- **Save** writes the project file (export format + `editor` section). **Export** writes the file without editor data.
- **Recent ▾** (toolbar) lists the last 10 opened/saved projects (exports excluded). Stored in IndexedDB (file handle + last content; reopening asks for file access again when needed).
- Settings (theme, link style and badges, port style (dots, arrows, hollow, shapes) to tell `in` from `out`, grid, guides, minimap, arrange on open) are kept per browser.

## File format

Schema: [`schema/scaffold.schema.json`](schema/scaffold.schema.json) (JSON Schema 2020-12). Example: [`examples/robot.scaffold.yaml`](examples/robot.scaffold.yaml).

```yaml
schemaVersion: 1
project: { name, description?, metadata? }
types: [...] # struct | enum | alias
interfaces: [...] # named sets of messages
modules: [...] # recursive (modules[].modules)
links: [...]
dependencies: [...] # other project files whose types, interfaces and modules this one uses (optional)
editor: { layout, views?, style?, notes?, dependencies?, orientation?, links? } # editor only, ignored by generators
```

### Types

A type reference is always structured (never a string):

| kind                             | fields         | notes                                                                                      |
| -------------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `primitive`                      | `name`         | `bool char int8 int16 int32 int64 uint8 uint16 uint32 uint64 float32 float64 string bytes` |
| `array`                          | `of`, `size`   | fixed size                                                                                 |
| `vector` `list` `set` `optional` | `of`           |                                                                                            |
| `map`                            | `key`, `value` | key: primitive or enum                                                                     |
| `ref`                            | `name`         | user type (struct, enum or alias)                                                          |

User types: `struct` (`fields`, each with an optional `default`, as for attributes below), `enum` (`underlying` integer primitive, `values`), `alias` (`type`).

### Modules, ports, links

- Module path = dot-separated names (`Core.Sensor`); names unique among siblings.
- Attributes (optional): typed properties of a module, `{ name, static?, const?, type, description?, default? }` like struct fields. `static`: shared by all instances of the module; `const`: not changed after initialization.
- Methods (optional): method prototypes of a module, `{ name, description?, static?, const?, virtual?, pure?, override?, params, returns }` like interface messages; names unique among the module's methods and attributes. `static`: called without a module instance; `const`: leaves the module's state unchanged (not both). `virtual`: can be overridden by derived modules (not `static`); `pure`: pure virtual, `= 0`; `override`: overrides a virtual method of a base, same parameters (types, directions, `const`), return type and `const`. `pure` and `override` require `virtual`. Parameters take `const: true` too, `in` parameters only.
- Kind (optional): `class` (default, left out), `abstract` or `interface`. A `class` has no pure methods and implements every pure method it inherits; an `interface` has only pure methods and no attributes.
- Bases (optional): `bases: [IShape, Core.Base]`, paths of modules of this project it derives from, in order; no cycles, no repeats. A method redefining a virtual one of a base without `override` is a warning.
- Default values (`default`, attributes and struct fields): a YAML value checked against the type, aliases followed — `true` / `false`, an integer in range, a number, one `char`, text for `string` / `bytes` (quoted when it reads as something else: `"5"`), an enum value name, a list for `array` (exactly its size), `vector`, `list` and `set` (no duplicates), a mapping for `map` (keys read as the key type) and structs, `null` for an empty `optional`. A struct value names its fields: unknown and missing fields are errors, except fields with their own default, `optional` fields and structs whose fields all have one. Values of custom primitives are opaque, passed as is to generators. In the editor, write them as one-line flow literals: `{ position: { x: 1, y: 2 }, samples: [ 1, 2, 3 ] }`.
- Port: `role` `out` (initiates / sends) or `in` (receives / serves), `interface` name.
- Link: `from` (an `out` port) → `to` (an `in` port), same interface — or, between a module and its content, `in` → `in` into it and `out` → `out` out of it — with `constraints`:

```yaml
constraints:
  direction: unidirectional | bidirectional # messages returning a value need bidirectional
  ack: { required: bool, timeoutMs? }
  performance: { class: realtime | low | normal | bulk, maxLatencyMs?, rateHz? }
  remote: { enabled: bool, transport? } # e.g. ipc, shm, tcp, udp, grpc, mqtt, can
```

### Dependencies

Other project files whose types and interfaces are used here by name as if they were this project's (one namespace), and whose modules links may reach. Each keeps a copy of what is used as last read (so the file stays self-contained for generators):

```yaml
dependencies:
  - name: Robot # referenced by `uses` and link ends
    file: robot.scaffold.yaml # relative to this file
    uses: [Common] # dependencies of this list that its types and interfaces use (optional)
    types: [...] # its own types, as in `types`
    interfaces: [...] # its own interfaces, as in `interfaces`
    modules: # its modules placed on this canvas, with their ports (optional)
      - module: Core.Sensor
        ports: [{ name: out, role: out, interface: Telemetry }]
  - name: Common
    file: common.scaffold.yaml
    indirect: true # only here because another dependency uses it (optional)
    shared: [Vec3] # defined the same way by another dependency of this list, listed there (optional)
    types: [...]
    interfaces: [...]
links:
  - name: sensor_to_monitor
    from: { project: Robot, module: Core.Sensor, port: out }
    to: { module: Monitor, port: telemetry }
    constraints: { ... }
```

Generators read the project's `types` and `interfaces` plus those of every dependency. A dependency's types and interfaces only reference their own dependency's and those of the dependencies it `uses`. A placed port's interface is matched by name with those of this project and its dependencies. One end of a link must be in this project.

All names are identifiers (`[A-Za-z_][A-Za-z0-9_]*`). Types and interfaces share one namespace.

## Code generation

The code of a project is generated from [LiquidJS](https://liquidjs.com) templates. The built-in set, [`templates/cpp17`](templates/cpp17), writes a C++17 CMake project. Hand-written code goes into **user sections**, kept when the code is generated again:

```cpp
bool Controller::setMode(const ::common::Mode mode)
{
    // <user:method.setMode>
    return mode != ::common::Mode::Fault; // kept across generations
    // </user:method.setMode>
}
```

- Command line: `npm run generate -- <project file> [-o <dir>] [-t <template dir>] [--deps] [--force] [--prune] [--dry-run]`. The default output directory is `generated/<project>` next to the project file; `--deps` also generates the dependencies, each in a sibling directory (where the generated `CMakeLists.txt` looks for them). The exit code is not 0 on errors or conflicts.
- Editor: _File › Generate code_ (Ctrl+Alt+G) writes into the directory last used for the document, _Generate code into…_ picks another one (Chrome, Edge, the desktop apps; not Firefox / Safari). VS Code: _ProjectScaffold: Generate Code_ writes into `generated/<project>` next to the file (setting `projectScaffold.generate.outputDir`), _Generate Code Into…_ picks another directory, remembered for the file.
- The project must have no errors (like export). Generating again rewrites only what changed:
  - the content of each user section is carried over by id; sections still holding what was generated in them take the new template's content;
  - sections with no place left (a renamed method, module or port) are appended to `<file>.orphans`, never lost;
  - a file changed **outside** its user sections is left as it is and reported as a conflict (`--force` overwrites it);
  - files no longer generated are reported; `--prune` deletes them (their user sections go to `.orphans` files).
  - `.scaffold-gen.json` in the output directory records what was generated (keep it with the code).
- A template set in `<output directory>/.scaffold/templates/` is used instead of the built-in one (or `-t <dir>`).
- [`examples/rover.scaffold.yaml`](examples/rover.scaffold.yaml) is made of modules with ports only (no attributes nor methods): frames, detections, drive commands, lifecycle and health calls between a camera, a perception container (with its content wired through its ports), a planner, motors, a recorder and a supervisor. `npm run generate -- examples/rover.scaffold.yaml` writes it into `examples/generated/rover`.

### C++17 mapping

| Model                                    | C++                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| project `Robot`                          | namespace `robot`, CMake library `robot` (+ executable `robot_app` when there are modules)                                                                                                                                                                                           |
| struct / enum / alias / custom primitive | `struct` with default member initializers / `enum class X : std::uint8_t` / `using` / `using X = …` in a user section, one header each in `include/<ns>/types/`                                                                                                                      |
| primitives, containers                   | `std::int32_t`, `float`, `double`, `std::string`, `std::vector<std::uint8_t>` (bytes), `std::array`, `std::vector`, `std::list`, `std::set`, `std::optional`, `std::map`                                                                                                             |
| interface `Telemetry`                    | abstract class `ITelemetry` (pure virtual messages) in `include/<ns>/interfaces/`                                                                                                                                                                                                    |
| parameters                               | `in`: by value for scalars and enums, else `const T&`; `out` / `inout`: `T&`                                                                                                                                                                                                         |
| module `Core.Sensor`                     | class `robot::core::Sensor` (`include/robot/core/Sensor.hpp`, `src/core/Sensor.cpp`); `kind`, `bases`, `static` / `const` / `virtual` / `= 0` / `override` as written; attributes are private members `name_` with a getter and a setter (unless `const`, or a method has that name) |
| `out` port `out: Telemetry`              | `OutPort<ITelemetry>& out()` (`include/<ns>/ports.hpp`): `out()->publish(…)` for its single peer, `out().each(…)` for all                                                                                                                                                            |
| `in` port `telemetry: Telemetry`         | `ITelemetry& telemetry()`, whose calls land in `onTelemetryPublish(…)`, written in the `.cpp`                                                                                                                                                                                        |
| nested modules                           | members of their container, with accessors (`core().sensor()`); abstract ones with ports are `std::unique_ptr`, created in a user section; abstract ones without ports are only base classes                                                                                         |
| links                                    | `from.connect(to)` in the constructor of the innermost module holding both ends, or of `robot::System` (the top-level modules, created by `src/main.cpp`); remote links in a user section, to replace by a transport; links to other projects: a user section in `System`            |
| container port linked inside             | `in`: the accessor returns the inner port; `out`: the inner port forwards to it                                                                                                                                                                                                      |

Names that are C++ keywords get a trailing `_` (a warning tells). The types and interfaces of dependencies are included from their own generated code (`<common/types/Pose.hpp>`, namespace `common`).

### Writing templates

A template set is a directory with a `manifest.yaml`:

```yaml
name: cpp17
language: cpp # warns about names that are C++ keywords
comment: '//' # starts the user section markers
partials: [_banner.liquid] # used by {% include %} only
outputs:
  - template: module.hpp.liquid
    each: modules # one file per item, bound to `item` (`as:` renames it)
    when: item.kind != 'interface' # optional condition
    path: include/{{ item | cpp_header }}
  - template: CMakeLists.txt.liquid
    path: CMakeLists.txt
    comment: '#'
```

- `{% user 'id' %}default{% enduser %}` writes a user section (`id`: any Liquid expression, unique in the file); its markers take the indentation of the tag's line. A line holding only a tag (`{% if %}`, `{% for %}`…) leaves no line (`trimTagLines: false` keeps them); runs of blank lines are collapsed (`squeezeBlankLines: false`).
- Variables (every value is present: templates run with strict variables): `project` (`name`, `ident`, `description`, `metadata`), `types` and `interfaces` (the project's own), `allTypes`, `allInterfaces` (with the dependencies'), `modules` (all, depth first: `name`, `path`, `namespace`, `parent`, `kind`, `abstract`, `bases`, `isBase`, `attributes`, `methods`, `ports` with their `interface` and `delegates`, `children`, `instances`, `connections`, `metadata`), `system` (`instances`, `connections`, `external` links to other projects), `links`, `dependencies`, `files` (paths generated so far) and `generator`. Type references carry `typeKind` and `dependency`. See [`codegen/context.ts`](src/renderer/src/codegen/context.ts).
- Filters: `snake`, `camel`, `pascal`, `kebab`, `constant`, `ucfirst`, `lcfirst`, `doc_comment: '/// '` (no line for an empty text), and for C++ `cpp_type`, `cpp_value: type` (literal of a default value), `cpp_param(s)`, `cpp_args`, `cpp_input`, `cpp_name`, `cpp_id`, `cpp_namespace`, `cpp_qualified`, `cpp_header`, `cpp_source`, `cpp_includes`, `cpp_endpoint`, `cpp_accessor`, `cpp_member`, `cpp_primitive` ([`codegen/cpp.ts`](src/renderer/src/codegen/cpp.ts)).
