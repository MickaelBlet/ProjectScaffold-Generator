# Code generation

The code of a project is generated from [LiquidJS](https://liquidjs.com) templates. Hand-written code goes into user sections, kept when the code is generated again.

- [Built-in template sets](#built-in-template-sets)
- [User sections](#user-sections)
- [Command line](#command-line)
- [Generating again](#generating-again)
- [Choosing templates](#choosing-templates)
- [Checking the templates](#checking-the-templates)
- [Example](#example)

Details: [C++ and Python mapping](mapping.md), [Links between binaries](remote.md), [SCA mapping](sca.md), [Writing templates](templates.md).

## Built-in template sets

One folder each in [`templates/`](../templates). A project picks its set with `generation.templates` (in the [ProjectScaffold editor](https://github.com/MickaelBlet/ProjectScaffold-Viewer): _Inspector › Project › Code generation_); `-t` overrides it.

| Set                                     | Writes                                                              |
| --------------------------------------- | ------------------------------------------------------------------- |
| [`cpp17`](../templates/cpp17) (default) | a C++17 CMake project                                               |
| [`cpp20`](../templates/cpp20)           | the same in C++20                                                   |
| [`cpp14`](../templates/cpp14)           | the same in C++14                                                   |
| [`cpp11`](../templates/cpp11)           | the same in C++11                                                   |
| [`cpp98`](../templates/cpp98)           | the same in C++98                                                   |
| [`python`](../templates/python)         | a Python 3.8+ package (standard library only)                       |
| [`sca-cpp98`](../templates/sca-cpp98)   | SCA 2.2.2 components in C++98 over CORBA (omniORB 4): [SCA](sca.md) |

The C++ and Python sets call each other across binaries. How each set spells the model: [C++ and Python mapping](mapping.md).

## User sections

```cpp
bool Controller::setMode(const ::common::Mode mode)
{
    // <user:method.setMode>
    return mode != ::common::Mode::Fault; // kept across generations
    // </user:method.setMode>
}
```

Write hand-written code between the markers; everything else is rewritten by the generator.

## Command line

```sh
npm run generate -- <project file> [-o <dir>] [-t <template set or dir>] [--deps] [--force] [--prune] [--dry-run]
```

| Option         | Effect                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `-o <dir>`     | output directory (default: `generated/<project>` next to the project file)                                        |
| `-t <name>`    | a built-in set                                                                                                    |
| `-t <dir>`     | a template folder (`./<name>` for a folder named like a built-in set)                                             |
| `--deps`, `-d` | also generate the dependencies, each in a sibling directory (where the generated `CMakeLists.txt` looks for them) |
| `--force`      | overwrite files changed outside their user sections                                                               |
| `--prune`      | delete files no longer generated (their user sections go to `.orphans` files)                                     |
| `--dry-run`    | report without writing                                                                                            |

The exit code is not 0 on errors or conflicts.

### Standalone generator

`scripts/build_cli.sh` (or `npm run cli`) builds the same command:

- `dist-cli/scaffold-gen`: a standalone executable, Node embedded, built-in templates included: `scaffold-gen <project file> [options]`;
- `dist-cli/scaffold-gen.cjs`: a single-file script, run with Node 22+.

An argument names another Node binary of the same version to embed, such as its Windows `node.exe` (→ `scaffold-gen.exe`).

## Generating again

Generating again rewrites only what changed:

- the content of each user section is carried over by id; sections still holding what was generated in them take the new template's content;
- sections with no place left (a renamed method, module or port) are appended to `<file>.orphans`, never lost;
- a file changed **outside** its user sections is left as it is and reported as a conflict (`--force` overwrites it);
- files no longer generated are reported; `--prune` deletes them (their user sections go to `.orphans` files);
- `.scaffold-gen.json` in the output directory records what was generated: keep it with the code.

## Choosing templates

Templates are looked up in this order:

1. the template folder given with `-t <dir>`;
2. a template set in `<output directory>/.scaffold/templates/`;
3. the project's built-in set (`generation.templates`, or `-t <name>`).

Writing a set: [Writing templates](templates.md).

## Checking the templates

```sh
scripts/check_templates.sh [set]...   # generate the examples and fixtures with each built-in set and build them
scripts/check_remote.sh -t <set>      # calls between binaries of a C++ set against its Python peers
```

- `check_templates.sh` builds C++ with CMake and `-Wall -Wextra -Werror`; Python is byte-compiled and imported.
- `check_remote.sh -t python` checks the Python set against cpp17 binaries. See [Links between binaries › Interoperability check](remote.md#interoperability-check).

## Example

[`examples/rover.scaffold.yaml`](../examples/rover.scaffold.yaml) is made of modules with ports only (no attributes nor methods): frames, detections, drive commands, lifecycle and health calls between a camera, a perception container (with its content wired through its ports), a planner, motors, a recorder and a supervisor. It is split into two binaries, `Onboard` (the rover) and `Ground` (the supervisor), linked over TCP.

```sh
npm run generate -- examples/rover.scaffold.yaml   # -> examples/generated/rover
```

It builds the executables `rover_onboard` and `rover_ground`.
