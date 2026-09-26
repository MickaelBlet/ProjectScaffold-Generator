# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
- Context menus (double-click or right click the canvas), inline rename (F2), keyboard nudging, alignment guides, snap to grid.
- Command palette (Ctrl+Shift+P), go to anything (Ctrl+P), keyboard shortcuts sheet (`?`), menu bar.
- Outline panel (module tree: reveal, hide in view, drag to re-parent), full-text Search panel, filters in Problems, "used by" lists for types.
- Module colors, sticky notes and frames (`editor.style`, `editor.notes`).
- Diagram export as PNG / SVG.
- Settings: light / dark / system theme, link style and badges, port style (dots, arrows, hollow, shapes), grid, guides, minimap.
- Message parameter direction `in` (default) / `out` / `inout`, stored as `direction` in the file; `out` and `inout` parameters require a bidirectional link.
- Links to another project: place a module of another open document or project file on the canvas and link to its ports (_Insert › Link to another project…_). Stored in `imports` with the ports last read, link ends with `import`; missing interfaces and their types are copied; _Refresh linked projects_ re-reads them from open tabs.
- Linked projects stay in sync: module, port and interface renames are carried to the open documents linked to the renamed one (each as an undoable edit); _Refresh linked projects_ detects renames made while a file was closed.
- Link inspector: pick the link's interface (set on both ports), also when the link was created without one.
- Lock position and size of modules and notes (Ctrl+L, module inspector), saved as `locked` in `editor.style` / `editor.notes`; pasted copies start unlocked.
- Selected links get a halo and dashes flowing in their direction; _Force animations_ keeps them when the system asks for reduced motion.
- Opening or closing a panel takes or gives space from the editor area instead of resizing the other panels; a reopened panel takes back its former size.
