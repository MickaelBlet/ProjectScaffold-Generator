# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Built-in template sets chosen per project: the file format's `generation.templates` names the one generating its code (default `cpp17`), set in _Inspector › Project › Code generation_ or _File › Code templates…_, which lists the built-in sets. Command line: `-t <name>` takes a built-in set as well as a folder.
- Built-in `cpp20` template set: the C++17 one in C++20 (concepts in the wire format, `std::bit_cast` / `std::endian`, defaulted `operator==` on structs and unions, `std::jthread` server threads).
- Built-in `cpp14` template set: `optional` as `scaffold::Optional` (`include/scaffold/optional.hpp`), unions holding one member per case, namespaces opened one level at a time, constants without `inline`, static attributes as function-local statics. The calls between binaries are the same as the C++17 ones.
- Built-in `cpp11` template set: the `cpp14` one in C++11, structs with a constructor taking every field (defaulted), `makeUnique` in place of `std::make_unique`.
- `scripts/check_templates.sh`: generates the examples and fixtures with each built-in template set and builds them; `scripts/check_remote.sh -t <set>` checks another C++ set, its interop program built in the set's standard.
- Code generation panel (_Window › Code generation_): the templates generating the active document (template folder, the output directory's `.scaffold/templates`, or built-in) and the files generated into its output directory, with their `.orphans` files. Each opens in an editor tab with the code editor: Liquid templates checked as they are typed, user sections of generated files shaded, Ctrl+S / _Save_ writes the file, changes on disk taken when the tab is shown again. Built-in templates open read-only. In VS Code, the files open in VS Code's editors.
- Global view: a _YAML_ button at its top right opens the project text (_Edit as text_).
- _File › Open IDL file as text…_: IDL files edited in a tab of the code editor, with their errors and warnings on their lines, saved with Ctrl+S.
- Output panel (_Window › Output_, Ctrl+Shift+U): a timestamped log of code generation (each file written, unchanged, removed, in conflict, with orphan sections or no longer generated, and the template warnings; a file opens from its line) and of every status message and dialog of the app, filtered by source, level or text; _Window › Clear output_. Shown, without the focus, when a generation reports problems or fails. In VS Code, the lines also go to the _ProjectScaffold_ output channel.

### Changed

- Project text (_Edit as text_, Alt+U): a real code editor (CodeMirror) in place of the plain text field: folding, search and replace (Ctrl+F), multiple cursors, bracket matching, completion in a popup that follows the text, problems underlined and marked in the gutter. Undo in the text undoes typing; the app's global shortcuts (save, palette…) still work from it.
- Project text: selecting an element in the diagram or a list moves the cursor to it in the YAML, scrolled into view; _Follow cursor_ becomes _Sync selection_ and covers both directions. The header options (_Editor data_, _Whitespace_, _Sync selection_) are pill toggles in place of checkboxes.
- YAML highlighting: values colored by type (strings, numbers, booleans, null), anchors and aliases colored, top-level keys in bold.
- Inspector: entries of every list (fields, parameters, attributes, ports, enum values, flags, transports, metadata, binaries, references) are rounded blocks, every other one shaded. Columns of buttons and numbers in tables take the width of their content.
- Explorer: the buttons of a section header stay on the right of its title, wrapping onto more lines there when the panel is narrow; the title stays whole.
- Toolbar: ← / → buttons go to the previous / next selection (Alt+← / Alt+→); the shortcut of _Go to…_ sits on the right of its button.

### Fixed

- Tauri (Windows): files and folders picked once (recent documents, workspace, output and template folders) are read and written again without asking for permission at every launch.
- Explorer: the selected link is highlighted in _Links_.
- Going to a link (Explorer, Links, problems, text cursor) centers the diagram on the link itself, not on the modules it joins; _Fit selection_ (F) zooms to a selected link.

### Removed

- Definitions view (_View › Open definitions view_, Alt+T, _Definitions_ in the Explorer's _Views_, VS Code _Open Definitions View_): the Explorer lists the same entities and the inspector edits them.
- _Export YAML_ / _Export JSON_ buttons of the toolbar: still in _File_, the command palette and their shortcuts (Ctrl+E, Ctrl+Shift+E).

## [0.2.0] - 2026-10-01

### Added

- VS Code: the Explorer, Modules, Links, Dependencies and Settings views are all in the ProjectScaffold side bar (activity bar), opened when a project file is first opened (`projectScaffold.views.revealOnOpen`). _Generate Code_ also runs from the text editor of a project file, the files' explorer menu, the palette and the title of the Explorer view (with _Generate Code Into…_, _Code Templates…_) and a button of the diagram's title: the file's diagram generates, or a preview opened for it. _Open Definitions View_ (button in the same places, palette) opens the Definitions view of the file's diagram; Alt+T goes to the diagram while it has the focus.
- Explorer: sections reordered by dragging their header (or Alt+Up / Alt+Down on it) and hidden; the right-click menu of a header moves (up, down, top, bottom), hides, shows the hidden ones again and resets them. A line below the sections lists the hidden ones. Kept with the settings.
- Definitions view (_View › Open definitions view_, Alt+T; listed below _Global_ in the Explorer's _Views_, neither renamed nor deleted): a tab listing everything the Explorer lists but the views (binaries, dependencies, constants, types, interfaces, modules, links; filter, kinds, with the dependencies' definitions on demand, how many places use each, problem markers) beside the editor of the chosen one, the list resized by dragging its edge (arrow keys on it, double-click resets; remembered); _New_ creates any kind. Constants and binaries get an editor of their own there.
- _File › Code templates…_ (VS Code: _ProjectScaffold: Code Templates…_): generate a document's code with the templates of a folder of one's own, picked at any time and remembered for the document, or back to the default ones; _Copy the built-in templates into a folder…_ to start from the C++17 set. VS Code setting `projectScaffold.generate.templates`. The generation summary names the templates used.
- Transport settings of remote links (`constraints.remote.settings`), edited in the link inspector under _Transport settings_: client and server host and port (tcp, udp, http, websocket, grpc), request path (http, websocket), shared memory segment and ring capacity (shm), socket (ipc), broker and topic (mqtt), interface and frame id (can), device and baud rate (serial), and free `options` for any transport, custom ones included. Checked: fields not applying to the transport, http paths, shared memory names, two links listening on the same port or sharing a segment. C++17 generation uses them for the generated transports and lists them in the user sections of the others; template context: `r.settings` (defaults applied) and `link.constraints.remote.settings`.
- Remote defaults (`remoteDefaults` in the project file, project inspector): client and server host and first port of the links between binaries.
- _Insert › Import projects or IDL files…_ also reads OMG IDL files (IDL 4.2: CORBA, CCM, DDS / XTypes) and adds their interfaces and components (one picked, or all) with the types they use. A preprocessor handles `#include` / `import` (files read next to the IDL file in VS Code, else picked along with it), `#define` (function-like too), `#if` / `#ifdef` / `#elif`. Every construct is read: modules (template modules instantiated), interfaces (attributes, inheritance, `raises`, `getraises`, `setraises`), structs, unions, exceptions, enums, bitmasks, bitsets, typedefs, constants, valuetypes and eventtypes, components, connectors and porttypes (as modules with ports), annotations (`@optional`, `@default`, `@value`, `@position`, `@bit_bound`, `@unit`, `@range`). Scoped names are resolved; names several modules share are qualified. Object references and names defined nowhere become custom primitives. Examples in `examples/idl/`.
- Exceptions (`kind: exception`, struct-like `fields`) and the `raises` of messages and methods (`raises: [Busy]`): Explorer _New exception_, raised exceptions picked under each message or method, `throws` on the diagram. Checked: only exceptions are raised, once each, and they are never used as types. C++17: `struct Busy : std::exception` (`what()`: its name), `@throws` in the docs; Python: dataclass deriving from `Exception`. Links between binaries send them back typed (error frame flag 2: index in `raises`, then the fields) and proxies throw / raise them as such, other failures staying `remote::Error` / `RemoteError`. Template context: `raises` of messages. The IDL import reads exceptions and the `raises`, `getraises`, `setraises` of operations and attributes; exceptions defined nowhere become exceptions without fields.
- Constants (`constants` in the project file, and in dependencies): named values of a type (`name`, `type`, `value`, `description`), in the namespace of the types and interfaces, their value checked against their type. Explorer section _Constants_, edited in the project inspector; dependencies bring theirs along and dependents follow their renames. C++17: `include/<ns>/constants.hpp` (`inline constexpr` numbers, enums and bitmasks, `inline const` others); Python peers: `constants.py`. Template context: `constants`, `constantsFile`, `remoteConstants`. The IDL import adds the constants of the whole file.
- Union types (`kind: union`): a `discriminator` (integer primitive, bool, char or enum) and `cases`, each held for its `labels` or as the `default` case; default values are one-entry mappings (`{ radius: 2.5 }`). Checked: discriminator type, labels against it and unique across cases, one default case at most, unions containing themselves by value. Explorer _New union_, discriminator and cases (labels, default) in the type inspector. C++17: a class holding a `std::variant`, with `_d()`, a getter and a setter per case, `_default(d)`; Python: dataclass `(d, value)`; on the wire the discriminator then the selected case. The IDL import reads unions as such (case labels, `default`, `Enum::VALUE` labels) instead of structs.
- Bitmask types (`kind: bitmask`, `underlying` unsigned primitive, `flags` with their `bit`): Explorer _New bitmask_, flags edited in the type inspector, default values as lists of flag names picked from a menu. C++17: `enum class` with `|`, `&`, `^`, `~`, `|=`, `&=`, `^=` and `has(value, flags)`; Python: `IntFlag`; on the wire as their underlying type. The IDL import reads bitmasks as such (`@bit_bound`, `@position`, up to bit 63) instead of enums.
- Bounded strings, bytes and containers: optional `max` on `string` / `bytes` (most UTF-8 bytes) and on `vector`, `list`, `set`, `map` (most items), written `string<16>`, `vector<T, 8>`, `map<K, V, 8>` in type expressions and set in the structured type editor. Default values are checked against them; the IDL import keeps the bounds of `string<N>`, `sequence<T, N>`, `map<K, V, N>`. C++17 / Python links between binaries check them when encoding and decoding (`remote::checkBound`, `bound` arguments of `wire.py`); template context: `max` on type references (null when none).

- Setting _Select before moving_ (on by default): only selected modules, notes and frames move when dragged; dragging an unselected one pans the view, so a click selects it first.
- Several files at once: _Add dependency…_, _Import projects or IDL files…_ and _Link to another project…_ pick several project files and IDL files in one go (_Open files…_; VS Code: the workspace's project and IDL files, multi-select). The dependencies of the picked projects are read from their own files when they can be (open tab, or next to the document in VS Code), at any depth, else taken as the picked projects last read them; a picked project another one depends on is used as such. Imported projects are pasted one below the other, those the others depend on first: their content stands for that dependency.
- IDL files as dependencies: an IDL file depended on stands for a project named after it (its types, interfaces, constants, and its components as modules to place and link to); the files it includes become its dependencies (`indirect` when included through another), refreshed from the files. `scaffold-gen -d` generates them like project files (also accepted as the main file).

### Changed

- Inspectors: lists of fields, parameters, attributes, constants and union cases size their columns by their content and the room left instead of fixed percentages, and wrap a long entry onto several lines when the inspector is narrow (the default value, then the type, below the name), separated by a line; narrow inspectors put labels above their value. The Definitions view and editor tabs use their full width.
- Explorer: sections in the order views, binaries, dependencies, constants, types, interfaces, modules, links by default (_Reset sections_ applies it to a saved order); the Definitions view follows it.
- VS Code: project files (`*.scaffold.{yaml,yml,json}`) open in the full diagram editor by default; the text, with its preview, through _Show Source_ or _Reopen Editor With… › Text Editor_.
- Workspaces (browser and desktop apps): the folders picked to read a workspace are remembered, and a workspace file inside one of them (at any depth) opens without picking its folder again; picking a folder above the workspace file is accepted.
- _Open module in its own view_ (Alt+Enter, ⤢ on a container) opens a temporary view: italic tab, not saved in the file and gone once closed. _Keep view_ (double-click the tab, its right-click menu, the breadcrumb, _View › Keep view_) stores it with the document; hiding a module in it keeps it too.
- C++17 generation: the server side of a link between binaries reads its address from `<PROJECT>_<LINK>_LISTEN` (the client keeps `<PROJECT>_<LINK>`). `remote::connect(transport, address, path)` and `remote::serve(transport, address, handler, capacity)` (Python `connect` / `serve` alike) take the http / websocket path and the shm capacity in place of the link name; Python `Link` has `client_address` / `server_address` in place of `address`.

### Fixed

- VS Code: opening a view, an editor or the Definitions view from a side view (Explorer, Modules, Links) when no diagram shows the document opens a preview and then does it, instead of only opening the preview.
- Editor tabs: the icons of view tabs (view, module view, Definitions) and the kind letter of editor tabs (T, I, M, L) are shown, and temporary views in italics; the tabs' own classes were dropped by dockview.
- Explorer: the _New_ buttons of a section (Types) no longer cover its title in a narrow panel; they wrap below it.
- Electron portable `.exe` (Windows): unpacks into a folder next to itself (removed on exit) instead of `%TEMP%`, where policies or antivirus may block running it; `%TEMP%` stays the fallback when its folder is read-only.
- Code generation: the text filters (case filters, `doc_comment`) given an object or a list read it as JSON instead of `[object Object]`.
- C++17 transports: bracketed IPv6 hosts (`[::1]:47000`) resolve, as in Python.
- Inspectors: selects as tall as inputs and buttons; no separator above the first section.
- Source panel: the text field fits the panel, so its scrollbars can be dragged and the horizontal one matches the visible width.

## [0.1.0] - 2026-09-30

### Added

- Workspace files (`*.scaffold-workspace.yaml`, schema `schema/scaffold-workspace.schema.json`): the project files of a large architecture, relative to the workspace file, opened together in tabs by _File › Open…_ (in the browser and desktop apps, the workspace's folder is asked for once to read them; its documents come back after a reload). _File › Save workspace_ / _Save workspace as…_ lists the open project files. Example `examples/fleet/fleet.scaffold-workspace.yaml`.
- Code generation from LiquidJS templates, with a built-in C++17 template set (`templates/cpp17`): types, interfaces as abstract classes, modules as classes wired through their ports (`OutPort`, in-port adapters, delegation through containers, a `System` of the top-level modules), and a CMake project using the generated dependencies. Hand-written code lives in user sections (`// <user:id>` … `// </user:id>`, written by `{% user 'id' %}` in templates), carried over when generating again; sections with no place left go to `.orphans` files, files changed outside their sections are reported as conflicts and left alone, files no longer generated are reported (or pruned). From the command line (`npm run generate -- <project file>`), the editor (_File › Generate code_, Ctrl+Alt+G, and _Generate code into…_) and VS Code (_Generate Code_, setting `projectScaffold.generate.outputDir`). A template set in `<output>/.scaffold/templates` replaces the built-in one; everything C++ lives in its Liquid files (`_type`, `_value`, `_params`, `_includes`… partials), the generator only gives the project (with what each entity `uses`) and language-neutral filters, so templates can be edited freely.
- Standalone code generator executable (`scripts/build_cli.sh` or `npm run cli` → `dist-cli/scaffold-gen`, Node embedded, built-in templates included; `dist-cli/scaffold-gen.cjs` for Node): the options of `npm run generate`, plus `--version`.
- `scripts/build_all.sh [--check] [web|cli|vscode|desktop]...`: builds every distributable (default: all).
- Binaries (`binaries` in the project file, `binary` on top-level modules): executables a project is split into, edited in the Explorer, the project inspector and a module's inspector or menu, shown in module headers. A link between two binaries must be remote with a transport (errors), and is made remote when modules change binary. C++17 generation: one system, `main` and CMake executable per binary, with proxy and stub classes (`include/<ns>/remote/`) for the links between them.
- Calls between binaries generated end to end (C++17 template set): a binary wire format (`remote/wire.hpp`, `codec.hpp`), transports tcp, udp, http, websocket and shared memory (`remote/transport.hpp`, `src/remote/transport.cpp`, POSIX), proxies encoding each call and waiting for its reply when it has a result or the link acknowledges calls (`ack.timeoutMs`), stubs decoding them onto the bound port, opened by the systems at an address from `<PROJECT>_<LINK>` or `127.0.0.1:<47000 + index>`. Python peers of the binaries (`python/<ns>/`, standard library only): data classes, proxies, handlers and stubs per interface, and a peer per binary standing in for it, to test the others (`python -m <ns>.peers.<binary>`). `scripts/check_remote.sh` checks C++ ↔ Python over every transport (`tests/fixtures/relay.scaffold.yaml`, `tests/remote/`). Context: `remoteLinks`, `remoteTypes`, `index` of `proxies` / `stubs`, `inputs` / `outputs` of messages. The `send.<message>` user sections of proxies are gone (their code goes to `.orphans` files).
- Example `examples/rover.scaffold.yaml`: modules talking only through ports typed by interfaces (fan-out, delegation through a container), for code generation, split into an onboard and a ground binary linked over TCP.

- C++-like classes for modules: `kind` (`class`, `abstract`, `interface`), `bases` (modules derived from) and `virtual`, `pure` (`= 0`) and `override` method qualifiers, edited in the module inspector (_Implement_ adds missing overrides of inherited pure methods), shown on the canvas as `«interface» Name : Base`, with UML inheritance arrows to the bases (dashed to interfaces; _View › Inheritance arrows_), and `virtual f(): R override = 0`, and checked: pure methods only in abstract modules and interfaces, all of them in interfaces, overrides matching a virtual base method, inherited pure methods implemented by concrete modules, no inheritance cycles.
- Dependencies (`dependencies` in the project file; _Insert › Add dependency…_): another project file whose types and interfaces a project uses by reference, read-only, in the same namespace as its own, and whose modules it can place on the canvas to link to (_Insert › Link to another project…_), resizable like the project's own. A snapshot is kept in the file for generators; the dependencies of a dependency come with it (`indirect`). Same definitions are merged: an own one becomes the dependency's, two dependencies share it (`shared`); a different one is left out with a warning. Refreshed from the files (_Refresh dependencies_) and live from an open tab; renames of modules, ports, types and interfaces follow; entities removed from a dependency but still used are kept as own ones. Listed in the Explorer and the _Dependencies_ panel (open, refresh, place a module, detach, remove). Importing a project also brings its dependencies. See `examples/common.scaffold.yaml`, `robot.scaffold.yaml` and `station.scaffold.yaml`.
- Module methods (`methods` in modules): prototypes like interface messages — parameters with their direction, optional return type, `static` and `const` qualifiers, `const` parameters — edited in the module inspector and listed as `name(a: T): R` in a compartment below the attributes; in the Modules panel, search and type usages.
- Module attributes (`attributes` in modules), optionally `static` and `const`: typed properties edited in the module inspector, listed as `name: type` in a compartment below the module's header, apart from the ports where links attach; containers keep their content below them.
- Default values (`default`) of module attributes and struct fields: YAML values (one-line flow literals in the inspector, a choice for `bool` and enums) checked against the type — struct fields missing or unknown, list sizes, set duplicates, map keys, integer ranges — opaque for custom primitives, and shown as `= value`.
- VS Code extension `mblet.project-scaffold-vscode` (`scripts/build_vscode.sh` or `docker buildx bake vscode` → `dist-vscode/project-scaffold-vscode-<version>.vsix`): project files open as text with an editable diagram preview beside them (Ctrl+K V), or in a full diagram editor; text cursor and diagram selection follow each other; Explorer, Modules, Links, Dependencies and Settings in a ProjectScaffold side bar following the active project file; problems in the Problems panel, outline in the Outline view / breadcrumbs; theme and colors follow the VS Code color theme (theme setting _VS Code_); exports and dependency refresh go through the files next to the document.
- Example fleet of projects (`examples/fleet/`): shared units, weather, drone and ground station projects built on dependencies.
- Custom primitive types (`kind: primitive` in `types`): opaque types that generators map to a native type, added from the Explorer (+P).
- Custom transports (`transports` in the project file), managed in the project inspector or added from a remote link (Transport > New transport…); an undeclared transport is a warning, declared from the link.
- Module inspector: a port's interface opens from its row.
- Help > About ProjectScaffold: version, license and repository link.
- Edit as text (_View › Edit as text (YAML)_, Alt+U): the project file edited in a tab, with syntax coloring, completion from the file schema and the project's names (Ctrl+Space), visible whitespace, the editor data shown or hidden, and errors located at their line. Valid edits apply as one undo step each; the element under the caret is selected and zoomed to.
- Files changed by another program are reloaded (checked every 2 s and on focus), asking first when the document has unsaved changes.
- Reloading a project from its text keeps the ids and editor data of its entities, renamed ones included, so the selection, open editors and views survive.
- Keyboard navigation of the Explorer, Modules, Links, Search and Problems lists (arrows, Home / End, Enter / Space; Left / Right collapse and expand in Modules) and of the document tabs.
- Dialogs, the command palette and the document tabs carry ARIA roles and labels.
- Selection history: Alt+Left / Alt+Right go back to the previous selection and forward again, bringing it into view.
- Links drawn straight between modules: drag the → in a module's header onto another module (or an `in` port), or a port onto a module; the missing `out` / `in` ports are added, with the interface of the other end.
- Links between a module and its content (delegation): a container's `in` port to an `in` port inside it, an `out` port inside to the container's `out` port. Ports are linked by dragging either way.
- Link shapes set by hand, as in draw.io: bends added by dragging the selected link, moved and removed; link ends attached anywhere on their module's border. Saved in `editor.links`.
- Port names dragged to any side of their port (double-click resets them). Saved in `editor.style` (and `editor.dependencies` for placed modules of dependencies).
- Dragging a frame moves the modules, notes and imported modules lying fully inside it (locked items stay); the inspector of a frame lists them.
- Snap to grid applies to every move and resize of modules, notes and imported modules (drag, multi-selection, resize from any edge, nudge by grid cell, paste, align, auto layout); parents grow on the grid and alignment guides no longer pull items off it.
- Desktop app with Tauri: Docker build for Linux amd64 (deb, rpm, AppImage) and Windows amd64 (NSIS installer, portable exe).
- Portable desktop app with Electron: Docker build for Linux x64 (AppImage, tar.gz) and Windows x64 (portable exe, zip). Frameless window: the toolbar moves it, with its own resize edges and minimize, maximize and close buttons.
- Favicon for the browser tab and the single-file build.
- MIT license (`LICENSE`) and third-party license notices (`THIRD.md`).
- Import another project: copy the content of a project file or open document into a module (types and interfaces matched by name).
- Browser editor for software architecture: modules (nestable), `in`/`out` ports and links drawn on a canvas.
- Types (struct / enum / alias) and interfaces (messages with typed parameters and optional return) edited from the Explorer, with type expression completion and a structured type editor.
- Link constraints: direction, acknowledgement, performance class, remote transport.
- Live validation in the Problems panel; errors block export, warnings do not.
- Save to the project file (YAML/JSON with `editor` layout section) and export without editor data for code generators.
- JSON Schema of the file format (`schema/scaffold.schema.json`, `npm run schema`) and example project (`examples/robot.scaffold.yaml`).
- Recent documents (last 10) in the toolbar; the last one is reopened at startup.
- Undo / redo, keyboard shortcuts (open, save, save as, export, add module).
- Build (`npm run build`, `scripts/build_web.sh [--check]`): single self-contained `dist-web/index.html` working from `file://`, using the File System Access API when available.
- Unsaved edits are kept across page reloads and restored at startup.
- Document tabs: several projects open at once, each with its own undo history; the open documents are restored after a reload.
- Dockable, stackable and floating panels (Explorer, Modules, Links, Inspector, Problems, Search, Settings) with a persistent layout.
- Diagram views as tabs, splittable side by side: global view, module drill-down views (outside modules shown as stand-ins, breadcrumbs), modules hidden per view. Stored in `editor.views`.
- Type, interface, module and link editors in tabs.
- Multi-selection (Ctrl+click, Shift+drag), with align, distribute, same size, group into a module, color and delete.
- Copy / cut / paste / duplicate of several modules (with content and internal links), notes, types and interfaces, through the system clipboard: between documents and browser windows.
- Auto-arrange with ELK (layered, hierarchical, port aware) for the whole project, a view or a container; files without layout are arranged when opened.
- Vertical orientation (Ctrl+Alt+V, back with Ctrl+Alt+H): `in` ports and their names on the top edge, `out` ports at the bottom, links flowing down; saved per document in `editor.orientation`.
- Ports follow their links: on modules without submodules, each port and its name moves to the edge facing its linked modules (top / bottom for stacked modules, left / right otherwise), ordered so parallel links do not cross; container links leave from the facing side.
- README screenshot of the editor (`docs/demo.png`).
- Context menus (right click), double-click the canvas to zoom, inline rename (F2), keyboard nudging, alignment guides, snap to grid.
- Command palette (Ctrl+Shift+P), go to anything (Ctrl+P), keyboard shortcuts sheet (`?`), menu bar.
- Modules panel (module tree: reveal, hide in view, drag to re-parent), full-text Search panel, filters in Problems, "used by" lists for types.
- Module colors (module `color`), sticky notes and frames (`editor.notes`); modules locked in `editor.style`.
- Diagram export as PNG / SVG.
- Settings: light / dark / system theme, link style and badges, port style (dots, arrows, hollow, shapes), grid, guides, minimap.
- Message parameter direction `in` (default) / `out` / `inout`, stored as `direction` in the file; `out` and `inout` parameters require a bidirectional link.
- Link inspector: pick the link's interface (set on both ports), also when the link was created without one.
- Lock position and size of modules and notes (Ctrl+L, module inspector), saved as `locked` in `editor.style` / `editor.notes`; pasted copies start unlocked.
- Selected links get a halo and dashes flowing in their direction; _Force animations_ keeps them when the system asks for reduced motion.
- Opening or closing a panel takes or gives space from the editor area instead of resizing the other panels; a reopened panel takes back its former size.

### Changed

- Module and note backgrounds are slightly translucent, so links passing behind them stay visible.
- The Tauri window is frameless like the Electron one: minimize, maximize and close buttons in the toolbar, which moves the window (`src-tauri/capabilities/default.json`).
- _File › Open…_ accepts several files at once, each opened in its own tab (one at a time in VS Code).
- Recent projects moved from a separate button into _File › Open Recent_.
- Buttons, menus and panels use a shared set of SVG icons.
- Module colors are saved on the module (`color`), no longer in `editor.style`, which still reads them.
- Ports of linked modules from other projects follow their links like local ones; drill-down stand-ins sit on the top / bottom in vertical orientation and follow the ports they link to.
- Explorer: compact rows, and modules nested under their parent as in the Modules panel (chevron or Left / Right to fold, port count).
- The structured type editor of a field opens on a full-width row below it.
- Linting checks types (`typescript-eslint` type-checked rules) and React rules (`eslint-plugin-react-hooks` recommended); `npm run lint` passes, including the Electron files.
- Canvas code split: graph building in `canvas/flowGraph.ts`, shared constants in `canvas/constants.ts`, port placement of module nodes in `usePortLayout`.
- Text fields follow changes of their value while rendering (`useDraft`) instead of in an effect.
- Problems are validated once per edit, shared by the status bar and the Problems panel.
- The Electron window never navigates away from the app.
- Default port style is _hollow_ instead of _arrows_.
- Edits render again only the canvas nodes and links that changed; lists, the status bar and the Problems counts no longer render on every edit, and module paths are computed once per project.
- Example project: module colors and a custom primitive type.
- Desktop builds merged into one `Dockerfile` with a shared web build and one stage per app and OS, run in parallel by `docker buildx bake` (`docker-bake.hcl`, `scripts/build_desktop.sh`); `Dockerfile.electron` removed, `build_tauri.sh` / `build_electron.sh` call `build_desktop.sh`.

### Removed

- `imports` in the project file and `import` link ends, replaced by `dependencies` and `project` link ends; _Refresh linked projects_ became _Refresh dependencies_.

### Fixed

- C++17 generation: `bytes` defaults are written as their characters (`{'F', 'L', 'S', 'H'}`) instead of the raw text.
- Fleet examples: the drone project no longer depends on the ground station (a cycle leaving its snapshots invalid), a custom primitive default is a C++ expression, and the ground station has no reserved-word port names nor an `in` port handing its calls to two inner ports; all examples generate and build.
- Port names of containers are drawn above the links crossing them.
- _Swap ends_ in the link inspector also swaps the link's attachments and reverses its bends, like _Reverse direction_.
- Hints no longer tell to double-click the canvas to add a module (right-click it).

[Unreleased]: https://github.com/MickaelBlet/ProjectScaffold/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/MickaelBlet/ProjectScaffold/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MickaelBlet/ProjectScaffold/releases/tag/v0.1.0
