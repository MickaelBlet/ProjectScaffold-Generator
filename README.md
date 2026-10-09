# ProjectScaffold-Generator

Code skeleton generator for ProjectScaffold project files (`*.scaffold.yaml` / `.json`, OMG IDL), written with the [ProjectScaffold editor](https://github.com/MickaelBlet/ProjectScaffold-Viewer): modules, ports, typed interfaces and links become code from editable Liquid templates.

## Features

- **Built-in template sets**: C++ (C++98 to C++20, CMake), Python 3.8+, SCA 2.2.2 over CORBA (omniORB).
- **User sections**: hand-written code kept across generations; conflicts reported, nothing lost (`.orphans`).
- **Links between binaries**: executables calling each other over tcp, udp, http, websocket or shared memory, C++ and Python alike.
- **Dependencies**: projects using other project files generate together (`--deps`).
- **Standalone**: one executable (`scaffold-gen`, Node embedded, templates included), or a single `.cjs` script.

## Quick start

```sh
npm install
npm run generate -- examples/robot.scaffold.yaml -d    # C++17 code into examples/generated/
scripts/build_cli.sh                                   # standalone dist-cli/scaffold-gen
```

[`examples/`](examples) holds sample projects.

## Documentation

| Guide                                      | Content                                                      |
| ------------------------------------------ | ------------------------------------------------------------ |
| [Code generation](docs/code-generation.md) | template sets, user sections, command line, generating again |
| [C++ and Python mapping](docs/mapping.md)  | how each built-in set spells the model                       |
| [Links between binaries](docs/remote.md)   | generated transports, addresses, wire format, Python peers   |
| [SCA mapping](docs/sca.md)                 | SCA 2.2.2 components over CORBA                              |
| [Writing templates](docs/templates.md)     | manifest, user sections, variables, filters, partials        |

The project file format: [ProjectScaffold-Viewer › File format](https://github.com/MickaelBlet/ProjectScaffold-Viewer/blob/master/docs/file-format.md).

## Checks

```sh
npm test                             # unit tests (model, serialization, validation, code generation)
npm run lint
npm run typecheck
npm run schema                       # regenerate schema/*.schema.json from the model
scripts/check_templates.sh [set]...  # generate the examples with each built-in template set and build them
scripts/check_remote.sh [-t <set>]   # calls between binaries: C++ and Python over every transport (cmake, python3)
```

Changes: [`CHANGELOG.md`](CHANGELOG.md).

## License

[MIT](LICENSE)
