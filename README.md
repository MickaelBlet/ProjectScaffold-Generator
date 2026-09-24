# ProjectScaffold

Desktop editor (Electron) for software architecture: modules, ports, typed interfaces and constrained links.
Exports a language-agnostic YAML/JSON file meant to feed code skeleton generators.

## Commands

```sh
npm install
npm run dev          # run the app with hot reload
npm run build        # typecheck + production build (out/)
npm run preview      # run the production build
npm test             # unit tests (model, serialization, validation)
npm run schema       # regenerate schema/scaffold.schema.json
npm run lint
npm run dist:win:zip # Windows x64 zip (dist/*.zip), buildable from Linux/WSL without wine
npm run dist:win     # Windows installer + portable exe (run on Windows, or Linux with wine)
```

Open a file at startup: `npx electron . path/to/project.scaffold.yaml` (after `npm run build`).
Without an argument, the last opened project is reopened.

## Editor

- Double-click the canvas (or **+ Module**, Ctrl+M) to add a module. Drop a module onto another to nest it.
- Ports: `in` on the left, `out` on the right. Drag from an `out` port to an `in` port to create a link.
- Types (struct / enum / alias) and interfaces (messages with typed parameters and optional return) are edited from the left panel.
- Type fields accept expressions with completion (`map<string, vector<uint16>>`), or the structured editor (⋮).
- The **Problems** panel validates live. Errors block export, warnings do not.
- **Save** writes the project file (export format + `editor` layout section). **Export** writes the file without editor data.
- **Recent ▾** (toolbar) and **File › Open Recent** list the last 10 opened/saved projects (exports excluded). The last one is reopened at startup. Desktop: stored in `recent.json` of the user data directory. Browser: stored in IndexedDB (file handle + last content; reopening asks for file access again when needed).

## File format

Schema: [`schema/scaffold.schema.json`](schema/scaffold.schema.json) (JSON Schema 2020-12). Example: [`examples/robot.scaffold.yaml`](examples/robot.scaffold.yaml).

```yaml
schemaVersion: 1
project: { name, description?, metadata? }
types: [...]        # struct | enum | alias
interfaces: [...]   # named sets of messages
modules: [...]      # recursive (modules[].modules)
links: [...]
editor: { layout }  # editor only, ignored by generators
```

### Types

A type reference is always structured (never a string):

| kind | fields | notes |
| --- | --- | --- |
| `primitive` | `name` | `bool char int8 int16 int32 int64 uint8 uint16 uint32 uint64 float32 float64 string bytes` |
| `array` | `of`, `size` | fixed size |
| `vector` `list` `set` `optional` | `of` | |
| `map` | `key`, `value` | key: primitive or enum |
| `ref` | `name` | user type (struct, enum or alias) |

User types: `struct` (`fields`), `enum` (`underlying` integer primitive, `values`), `alias` (`type`).

### Modules, ports, links

- Module path = dot-separated names (`Core.Sensor`); names unique among siblings.
- Port: `role` `out` (initiates / sends) or `in` (receives / serves), `interface` name.
- Link: `from` (an `out` port) → `to` (an `in` port), same interface, with `constraints`:

```yaml
constraints:
  direction: unidirectional | bidirectional   # messages returning a value need bidirectional
  ack: { required: bool, timeoutMs? }
  performance: { class: realtime | low | normal | bulk, maxLatencyMs?, rateHz? }
  remote: { enabled: bool, transport? }       # e.g. ipc, shm, tcp, udp, grpc, mqtt, can
```

All names are identifiers (`[A-Za-z_][A-Za-z0-9_]*`). Types and interfaces share one namespace.
