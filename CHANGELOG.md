# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Electron desktop editor for software architecture: modules (nestable), `in`/`out` ports and links drawn on a canvas.
- Types (struct / enum / alias) and interfaces (messages with typed parameters and optional return) edited from the sidebar, with type expression completion and a structured type editor.
- Link constraints: direction, acknowledgement, performance class, remote transport.
- Live validation in the Problems panel; errors block export, warnings do not.
- Save to the project file (YAML/JSON with `editor` layout section) and export without editor data for code generators.
- JSON Schema of the file format (`schema/scaffold.schema.json`, `npm run schema`) and example project (`examples/robot.scaffold.yaml`).
- Recent documents (last 10) in the toolbar and File menu; the last one is reopened at startup.
- Undo / redo, keyboard shortcuts (open, save, save as, export, add module).
- Browser build (`npm run build:web`): single self-contained `dist-web/index.html` working from `file://`, using the File System Access API when available.
- Browser: unsaved edits are kept across page reloads and restored at startup.
- Windows packaging (`npm run dist:win`, `npm run dist:win:zip`).
