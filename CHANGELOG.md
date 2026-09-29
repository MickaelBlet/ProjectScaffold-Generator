# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Code generation from LiquidJS templates, with a built-in C++17 template set (`templates/cpp17`): types, interfaces as abstract classes, modules as classes wired through their ports (`OutPort`, in-port adapters, delegation through containers, a `System` of the top-level modules), and a CMake project using the generated dependencies. Hand-written code lives in user sections (`// <user:id>` … `// </user:id>`, written by `{% user 'id' %}` in templates), carried over when generating again; sections with no place left go to `.orphans` files, files changed outside their sections are reported as conflicts and left alone, files no longer generated are reported (or pruned). From the command line (`npm run generate -- <project file>`), the editor (_File › Generate code_, Ctrl+Alt+G, and _Generate code into…_) and VS Code (_Generate Code_, setting `projectScaffold.generate.outputDir`). A template set in `<output>/.scaffold/templates` replaces the built-in one.

- C++-like classes for modules: `kind` (`class`, `abstract`, `interface`), `bases` (modules derived from) and `virtual`, `pure` (`= 0`) and `override` method qualifiers, edited in the module inspector (_Implement_ adds missing overrides of inherited pure methods), shown on the canvas as `«interface» Name : Base`, with UML inheritance arrows to the bases (dashed to interfaces; _View › Inheritance arrows_), and `virtual f(): R override = 0`, and checked: pure methods only in abstract modules and interfaces, all of them in interfaces, overrides matching a virtual base method, inherited pure methods implemented by concrete modules, no inheritance cycles.
- Dependencies (`dependencies` in the project file; _Insert › Add dependency…_): another project file whose types and interfaces a project uses by reference, read-only, in the same namespace as its own, and whose modules it can place on the canvas to link to (_Insert › Link to another project…_), resizable like the project's own. A snapshot is kept in the file for generators; the dependencies of a dependency come with it (`indirect`). Same definitions are merged: an own one becomes the dependency's, two dependencies share it (`shared`); a different one is left out with a warning. Refreshed from the files (_Refresh dependencies_) and live from an open tab; renames of modules, ports, types and interfaces follow; entities removed from a dependency but still used are kept as own ones. Listed in the Explorer and the _Dependencies_ panel (open, refresh, place a module, detach, remove). Importing a project also brings its dependencies. See `examples/common.scaffold.yaml`, `robot.scaffold.yaml` and `station.scaffold.yaml`.
- Module methods (`methods` in modules): prototypes like interface messages — parameters with their direction, optional return type, `static` and `const` qualifiers, `const` parameters — edited in the module inspector and listed as `name(a: T): R` in a compartment below the attributes; in the Modules panel, search and type usages.
- Module attributes (`attributes` in modules), optionally `static` and `const`: typed properties edited in the module inspector, listed as `name: type` in a compartment below the module's header, apart from the ports where links attach; containers keep their content below them.
- Default values (`default`) of module attributes and struct fields: YAML values (one-line flow literals in the inspector, a choice for `bool` and enums) checked against the type — struct fields missing or unknown, list sizes, set duplicates, map keys, integer ranges — opaque for custom primitives, and shown as `= value`.
- VS Code extension (`scripts/build_vscode.sh` or `docker buildx bake vscode` → `.vsix`): project files open as text with an editable diagram preview beside them (Ctrl+K V), or in a full diagram editor; text cursor and diagram selection follow each other; Explorer, Modules, Links and Settings in a ProjectScaffold side bar following the active project file; problems in the Problems panel, outline in the Outline view / breadcrumbs; theme and colors follow the VS Code color theme (theme setting _VS Code_); exports and dependency refresh go through the files next to the document.
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

- Port names of containers are drawn above the links crossing them.
- _Swap ends_ in the link inspector also swaps the link's attachments and reverses its bends, like _Reverse direction_.
- Hints no longer tell to double-click the canvas to add a module (right-click it).
