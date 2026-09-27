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
```

Desktop app (Tauri), built in Docker for Linux amd64 (`.deb`, `.rpm`, `.AppImage`) and Windows amd64 (NSIS installer + portable `.exe`, needs WebView2):

```sh
scripts/build_tauri.sh   # -> dist-tauri/linux/, dist-tauri/windows/
npm run tauri dev        # local dev window (needs Rust + webkit2gtk-4.1)
```

`dist-web/index.html` works from `file://` or any static host. Files are read and written through the File System Access API when available (Chrome, Edge), otherwise through a file input and a download.

## Editor

### Workspace

- **Document tabs**: several projects open at once, each with its own undo history (Alt+N new, Alt+W close, Alt+1…9 / Alt+PageUp/PageDown to switch, middle click to close, drag to reorder). Open documents and their unsaved edits are restored after a page reload.
- **Dockable panels** (Explorer, Outline, Inspector, Problems, Search, Settings): drag a tab to dock it on any side, stack it with others or float it. The layout is kept; _Window › Reset panel layout_ restores the default one.
- **Views**: each document has a _Global_ view plus any number of stored views, opened as tabs and splittable side by side. _Open module in its own view_ (Alt+Enter, or ⤢ on a container) shows one module's content, with stand-ins for the outside modules it is linked to and a breadcrumb back to the parents. Modules can be hidden per view (H, or the eye in the Outline; Shift+H shows them again).
- **Editor tabs**: double-click a type or interface in the Explorer (or ↗ in the Inspector) to edit it in a tab of its own.
- **Command palette**: Ctrl+Shift+P (or F1) runs any command; Ctrl+P goes to a module, type, interface, link or view. `?` lists every shortcut.

### Diagram

- Right click the canvas for its menu, double-click it to zoom in (Shift+double-click to zoom out); **+ Module** (Ctrl+M) adds a module. Drop a module onto another to nest it; drag it out to move it up.
- Ports: `in` on the left, `out` on the right — or `in` on top, `out` at the bottom in vertical orientation. Drag from an `out` port to an `in` port to create a link. Ports follow their links: on a module without submodules, each port (dot and name) moves to the edge facing the modules it is linked to — top / bottom for modules one above the other, left / right otherwise. Containers keep their ports on the default edges and their links leave from the facing side (_View › Auto-orient link ends_).
- **Link shape** (like draw.io): select a link, then drag its line to add a bend, drag a bend to move it (snaps to the grid and in line with its neighbours; Alt: free), double-click a bend to remove it. Drag an end square along its module's border to attach the link there; double-click it to attach at the port again. _Reset shape_ in the link's menu. Bends move with the module holding both ends, and with both ends when they are moved together; _Arrange_ clears them. Saved in `editor.links`.
- Selection: click, Ctrl+click to add, Shift+drag for a box. Arrows move the selection (Shift: further), F fits it, Shift+F fits everything.
- **Copy / cut / paste / duplicate** (Ctrl+C / X / V / D) several items at once: modules with their content and the links between them, notes, types and interfaces — within a document, between document tabs, and between browser windows (system clipboard). Interfaces and types are matched by name when pasted into another project.
- Right click anything for its actions. F2 or double-click a module name to rename it in place.
- **Arrange**: _Auto-arrange_ (Ctrl+Alt+L) lays out the selected container's content, the view's module, or everything, with ELK (layered, port aware, nested modules). _Arrange horizontally_ (Ctrl+Alt+H) and _vertically_ (Ctrl+Alt+V) also set the document's orientation: ports on the sides with links flowing right, or ports and their names on the top / bottom edges with links flowing down (saved in `editor.orientation`). Align, distribute, same size and _Group into a module_ (Ctrl+G) act on the selection. Alignment guides and snap to grid while dragging.
- **Links to another project**: _Insert › Link to another project…_ (or the canvas menu) picks an open document or a project file, then one of its modules. The module is drawn in the global view (dashed, `↗ Project`) and its ports can be linked to like any other. Interfaces it uses that this project lacks are copied, with the types they need; imported ports use this project's interface of the same name. _Refresh linked projects_ reads their ports again from the documents open in other tabs (links to removed ports are dropped). Double-click the module to switch to its project's tab.
- **Import another project** (_Insert_ menu, or right click the canvas / a module): copies the whole content of an open document or a project file into the selected module (or here): its modules with their links, its notes at the top level, and the types and interfaces this project lacks — the others are matched by name. The copy is not linked to that project.
- **Renames stay in sync** between open documents linked this way: renaming a module (or a parent), a port or an interface in one project renames it in the projects importing it, and an interface renamed in an importing project is renamed in the imported one. Each document gets the change as its own undoable edit (and becomes unsaved). Files that are not open catch up on _Refresh linked projects_: a module no longer found by path is matched to the only other module with the same name (moved) or the same ports (renamed), and an interface now named differently is renamed here too; the dialog lists what was renamed.
- Module colors, sticky notes and titled frames (right click the canvas) help organize the diagram. They are editor data only.
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
imports: [...] # other projects that links reach (optional)
links: [...]
editor: { layout, views?, style?, notes?, imports?, orientation?, links? } # editor only, ignored by generators
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

User types: `struct` (`fields`), `enum` (`underlying` integer primitive, `values`), `alias` (`type`).

### Modules, ports, links

- Module path = dot-separated names (`Core.Sensor`); names unique among siblings.
- Port: `role` `out` (initiates / sends) or `in` (receives / serves), `interface` name.
- Link: `from` (an `out` port) → `to` (an `in` port), same interface, with `constraints`:

```yaml
constraints:
  direction: unidirectional | bidirectional # messages returning a value need bidirectional
  ack: { required: bool, timeoutMs? }
  performance: { class: realtime | low | normal | bulk, maxLatencyMs?, rateHz? }
  remote: { enabled: bool, transport? } # e.g. ipc, shm, tcp, udp, grpc, mqtt, can
```

### Links to other projects

A link end may be a module of another project file, declared in `imports` with the ports it had when last read (so the file stays self-contained for generators):

```yaml
imports:
  - name: Robot # referenced by link ends
    file: robot.scaffold.yaml # relative to this file
    modules:
      - module: Core.Sensor
        ports: [{ name: out, role: out, interface: Telemetry }]
links:
  - name: sensor_to_monitor
    from: { import: Robot, module: Core.Sensor, port: out }
    to: { module: Monitor, port: telemetry }
    constraints: { ... }
```

Interfaces are matched by name: the imported port's interface must exist in this project. One end of a link must be in this project.

All names are identifiers (`[A-Za-z_][A-Za-z0-9_]*`). Types and interfaces share one namespace.
