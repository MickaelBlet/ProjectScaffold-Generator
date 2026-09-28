# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Custom primitive types (`kind: primitive` in `types`): opaque types that generators map to a native type, added from the Explorer (+P).
- Custom transports (`transports` in the project file), managed in the project inspector or added from a remote link (Transport > New transport…); an undeclared transport is a warning, declared from the link.
- Module inspector: a port's interface opens from its row.
- Help > About ProjectScaffold: version, license and repository link.
- Edit as text (_View › Edit as text (YAML)_, Alt+U): the project file edited in a tab, with syntax coloring, completion from the file schema and the project's names (Ctrl+Space), visible whitespace, the editor data shown or hidden, and errors located at their line. Valid edits apply as one undo step each; the element under the caret is selected and zoomed to.
- Files changed by another program are reloaded (checked every 2 s and on focus), asking first when the document has unsaved changes.
- Reloading a project from its text keeps the ids and editor data of its entities, renamed ones included, so the selection, open editors and views survive.
- Keyboard navigation of the Explorer, Outline, Links, Search and Problems lists (arrows, Home / End, Enter / Space; Left / Right collapse and expand in the Outline) and of the document tabs.
- Dialogs, the command palette and the document tabs carry ARIA roles and labels.
- Selection history: Alt+Left / Alt+Right go back to the previous selection and forward again, bringing it into view.
- Links drawn straight between modules: drag the → in a module's header onto another module (or an `in` port), or a port onto a module; the missing `out` / `in` ports are added, with the interface of the other end.
- Links between a module and its content (delegation): a container's `in` port to an `in` port inside it, an `out` port inside to the container's `out` port. Ports are linked by dragging either way.
- Link shapes set by hand, as in draw.io: bends added by dragging the selected link, moved and removed; link ends attached anywhere on their module's border. Saved in `editor.links`.
- Port names dragged to any side of their port (double-click resets them). Saved in `editor.style` (and `editor.imports` for imported modules).
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
- Dockable, stackable and floating panels (Explorer, Outline, Links, Inspector, Problems, Search, Settings) with a persistent layout.
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
- Outline panel (module tree: reveal, hide in view, drag to re-parent), full-text Search panel, filters in Problems, "used by" lists for types.
- Module colors (module `color`), sticky notes and frames (`editor.notes`); modules locked in `editor.style`.
- Diagram export as PNG / SVG.
- Settings: light / dark / system theme, link style and badges, port style (dots, arrows, hollow, shapes), grid, guides, minimap.
- Message parameter direction `in` (default) / `out` / `inout`, stored as `direction` in the file; `out` and `inout` parameters require a bidirectional link.
- Links to another project: place a module of another open document or project file on the canvas and link to its ports (_Insert › Link to another project…_). Stored in `imports` with the ports last read, link ends with `import`; missing interfaces and their types are copied; _Refresh linked projects_ re-reads them from open tabs.
- Linked projects stay in sync: module, port and interface renames are carried to the open documents linked to the renamed one (each as an undoable edit); _Refresh linked projects_ detects renames made while a file was closed.
- Link inspector: pick the link's interface (set on both ports), also when the link was created without one.
- Lock position and size of modules and notes (Ctrl+L, module inspector), saved as `locked` in `editor.style` / `editor.notes`; pasted copies start unlocked.
- Selected links get a halo and dashes flowing in their direction; _Force animations_ keeps them when the system asks for reduced motion.
- Opening or closing a panel takes or gives space from the editor area instead of resizing the other panels; a reopened panel takes back its former size.

### Changed

- Recent projects moved from a separate button into _File › Open Recent_.
- Buttons, menus and panels use a shared set of SVG icons.
- Module colors are saved on the module (`color`), no longer in `editor.style`, which still reads them.
- Ports of linked modules from other projects follow their links like local ones; drill-down stand-ins sit on the top / bottom in vertical orientation and follow the ports they link to.
- The structured type editor of a field opens on a full-width row below it.
- Linting checks types (`typescript-eslint` type-checked rules) and React rules (`eslint-plugin-react-hooks` recommended); `npm run lint` passes, including the Electron files.
- Canvas code split: graph building in `canvas/flowGraph.ts`, shared constants in `canvas/constants.ts`, port placement of module nodes in `usePortLayout`.
- Text fields follow changes of their value while rendering (`useDraft`) instead of in an effect.
- Problems are validated once per edit, shared by the status bar and the Problems panel.
- The Electron window never navigates away from the app.
- Default port style is _hollow_ instead of _arrows_.
- Edits render again only the canvas nodes and links that changed; lists, the status bar and the Problems counts no longer render on every edit, and module paths are computed once per project.
- Example project: module colors and a custom primitive type.

### Fixed

- _Swap ends_ in the link inspector also swaps the link's attachments and reverses its bends, like _Reverse direction_.
- Hints no longer tell to double-click the canvas to add a module (right-click it).
