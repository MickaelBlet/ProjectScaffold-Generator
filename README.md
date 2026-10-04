# ProjectScaffold

Browser editor for software architecture: modules, ports, typed interfaces and constrained links.
Exports a language-agnostic YAML/JSON file meant to feed code skeleton generators.

![ProjectScaffold editor with the fleet drone example](docs/demo.png)

## Features

- **Diagram editor**: nested modules with ports, attributes and methods, C++-like classes and inheritance, links with constraints (direction, acknowledgement, performance, transport), ELK auto-layout, views per module.
- **Text and diagram together**: the YAML/JSON file is editable as text beside the diagram, with completion and live validation.
- **Multi-project architectures**: projects depend on each other's types, interfaces and modules; renames follow; workspace files open them all at once.
- **IDL import**: OMG IDL 4.2 files (CORBA, CCM, DDS / XTypes) as imports or dependencies.
- **Code generation** from editable Liquid templates: C++ (C++98 to C++20), Python, SCA 2.2.2 over CORBA. Hand-written code kept across generations; executables calling each other over tcp, udp, http, websocket or shared memory.
- **Everywhere**: one self-contained `index.html` for the browser, desktop apps (Tauri, Electron), a VS Code extension, and a standalone command-line generator.

## Quick start

```sh
npm install
npm run dev                                            # open the editor, then File › Open… examples/robot.scaffold.yaml
npm run generate -- examples/robot.scaffold.yaml -d    # C++17 code into examples/generated/
```

[`examples/`](examples) holds sample projects; [`examples/fleet/fleet.scaffold-workspace.yaml`](examples/fleet/fleet.scaffold-workspace.yaml) opens a multi-project one.

## Documentation

| Guide                                      | Content                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| [Building and running](docs/building.md)   | web, desktop, VS Code, command line, checks                               |
| [Editor](docs/editor.md)                   | documents, panels, views, text editor, diagram, binaries, settings        |
| [Keyboard shortcuts](docs/shortcuts.md)    | every shortcut, by menu                                                   |
| [VS Code](docs/vscode.md)                  | text and preview side by side, side bar, layouts                          |
| [File format](docs/file-format.md)         | types, constants, interfaces, modules, ports, links, binaries, transports |
| [Dependencies](docs/dependencies.md)       | projects using other project files, importing projects, workspace files   |
| [IDL files](docs/idl.md)                   | importing OMG IDL and how it maps to the model                            |
| [Code generation](docs/code-generation.md) | template sets, user sections, command line, generating again              |
| [C++ and Python mapping](docs/mapping.md)  | how each built-in set spells the model                                    |
| [Links between binaries](docs/remote.md)   | generated transports, addresses, wire format, Python peers                |
| [SCA mapping](docs/sca.md)                 | SCA 2.2.2 components over CORBA                                           |
| [Writing templates](docs/templates.md)     | manifest, user sections, variables, filters, partials                     |

Changes: [`CHANGELOG.md`](CHANGELOG.md).

## License

[MIT](LICENSE)
