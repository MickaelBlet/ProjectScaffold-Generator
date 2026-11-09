# Code generation

The code of a project is generated from [Jinja](https://jinja.palletsprojects.com/templates/) templates, rendered by [MiniJinja](https://github.com/mitsuhiko/minijinja). Hand-written code goes into user sections, kept when the code is generated again.

- [Built-in template sets](#built-in-template-sets)
- [User sections](#user-sections)
- [Command line](#command-line)
- [Generating again](#generating-again)
- [Choosing templates](#choosing-templates)
- [Checking the templates](#checking-the-templates)
- [Example](#example)

Details: [C++ and Python mapping](mapping.md), [Links between binaries](remote.md), [SCA mapping](sca.md), [Writing templates](templates.md).

## Built-in template sets

One folder each in [`templates/`](../templates). Not embedded in the executable by default: give one with `-t templates/<set>`. A build with the `builtin-templates` feature embeds them; a project then picks its set by name with `generation.templates` (in the [ProjectScaffold editor](https://github.com/MickaelBlet/ProjectScaffold-Viewer): _Inspector › Project › Code generation_), and `-t <name>` overrides it.

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
scaffold-gen <project file> [-o <dir>] [-t <template set or dir>] [--deps] [--force] [--prune] [--dry-run]
```

| Option         | Effect                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `-o <dir>`     | output directory (default: `generated/<project>` next to the project file)                                        |
| `-t <dir>`     | a template folder (holding a `manifest.yaml`)                                                                     |
| `-t <name>`    | a built-in set (builds with `builtin-templates` only; `./<name>` for a folder named like one)                     |
| `--deps`, `-d` | also generate the dependencies, each in a sibling directory (where the generated `CMakeLists.txt` looks for them) |
| `--force`      | overwrite files changed outside their user sections                                                               |
| `--prune`      | delete files no longer generated (their user sections go to `.orphans` files)                                     |
| `--dry-run`    | report without writing                                                                                            |
| `--show-kept`, `-k` | show the user sections carried over from the files already there, with their content                         |

The exit code is not 0 on errors or conflicts. Errors are printed as clang prints them (`file:line:col: error: message`, then the line, marked), so editors can jump to them. The output is colored on a terminal: `NO_COLOR=1` turns colors off, `FORCE_COLOR=1` (or `CLICOLOR_FORCE=1`) forces them.

The project file is a ProjectScaffold file: YAML, JSON or Scaffold text (`*.scaffold`, the compact `.proto`-like syntax of the editor, [grammar](https://github.com/MickaelBlet/ProjectScaffold-Viewer/blob/master/docs/scaffold-text.md)), or an OMG IDL file: its definitions, the files it includes as dependencies. Dependencies may be any of them.

### Building the generator

`scripts/build_cli.sh` builds `dist-cli/scaffold-gen`: one static executable (Rust, nothing to install), without templates (`CARGO_FEATURES=builtin-templates scripts/build_cli.sh` embeds `templates/<set>`). An argument names another Rust target, such as `aarch64-unknown-linux-musl`, `x86_64-pc-windows-msvc` (→ `scaffold-gen.exe`, recommended for Windows: built from Linux with `cargo install cargo-xwin`, which downloads the MSVC runtime and Windows SDK, and `llvm-rc`) or `x86_64-pc-windows-gnu` (with a MinGW linker and `windres`). Windows executables carry version information and a manifest. Unsigned, they may still be flagged by antivirus software: sign them for distribution. From the sources: `cargo run --release -- <project file> [options]`.

## Generating again

Generating again rewrites only what changed:

- the content of each user section is carried over by id; sections still holding what was generated in them take the new template's content;
- sections with no place left (a renamed method, module or port) are appended to `<file>.orphans`, never lost;
- a file changed **outside** its user sections is left as it is and reported as a conflict at each place it differs, with what is generated there (`--force` overwrites it):

  ```
  generated/demo/include/demo/Base.hpp:3:13: error: changed outside its user sections
     3 | #pragma once // edit
       |             ^~~~~~~~
       + #pragma once
  ```

- a file whose user section markers are broken (one removed, one inside another) is a conflict; `--force` generates it anew and saves the whole file to its `.orphans` file;
- files no longer generated are reported; `--prune` deletes them (their user sections go to `.orphans` files);
- `.scaffold-gen.json` in the output directory records what was generated: keep it with the code. Files are never written nor deleted through a symbolic link of the output directory.

## Choosing templates

Templates are looked up in this order:

1. the template folder given with `-t <dir>`;
2. a template set in `<output directory>/.scaffold/templates/`;
3. the project's built-in set (`generation.templates`, or `-t <name>`), in builds with `builtin-templates` only; otherwise an error.

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
scaffold-gen examples/rover.scaffold.yaml   # -> examples/generated/rover
```

It builds the executables `rover_onboard` and `rover_ground`.
