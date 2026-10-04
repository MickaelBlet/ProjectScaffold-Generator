# Code generation

The code of a project is generated from [LiquidJS](https://liquidjs.com) templates. Hand-written code goes into user sections, kept when the code is generated again.

- [Built-in template sets](#built-in-template-sets)
- [User sections](#user-sections)
- [Command line](#command-line)
- [In the editor](#in-the-editor)
- [Generating again](#generating-again)
- [Choosing templates](#choosing-templates)
- [Code generation panel](#code-generation-panel)
- [Checking the templates](#checking-the-templates)
- [Example](#example)

Details: [C++ and Python mapping](mapping.md), [Links between binaries](remote.md), [SCA mapping](sca.md), [Writing templates](templates.md).

## Built-in template sets

One folder each in [`templates/`](../templates). A project picks its set with `generation.templates` (_Inspector › Project › Code generation_, or _File › Code templates…_).

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

## In the editor

| Host                  | Generate                                                                                                                     | Elsewhere                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Browser, desktop apps | _File › Generate code_ (Ctrl+Alt+G): into the directory last used for the document                                           | _Generate code into…_ (Chrome, Edge, the desktop apps; not Firefox / Safari) |
| VS Code               | _ProjectScaffold: Generate Code_: into `generated/<project>` next to the file (setting `projectScaffold.generate.outputDir`) | _Generate Code Into…_, remembered for the file                               |

The project must have no errors, as for export. The Output panel logs each file written.

## Generating again

Generating again rewrites only what changed:

- the content of each user section is carried over by id; sections still holding what was generated in them take the new template's content;
- sections with no place left (a renamed method, module or port) are appended to `<file>.orphans`, never lost;
- a file changed **outside** its user sections is left as it is and reported as a conflict (`--force` overwrites it);
- files no longer generated are reported; `--prune` deletes them (their user sections go to `.orphans` files);
- `.scaffold-gen.json` in the output directory records what was generated: keep it with the code.

## Choosing templates

Templates are looked up in this order:

1. the template folder picked for the document (editor) or given with `-t <dir>` (command line);
2. a template set in `<output directory>/.scaffold/templates/`;
3. the project's built-in set (`generation.templates`, or `-t <name>`).

- _File › Code templates…_ lists the built-in sets (picking one records it in the project) and picks a template folder for the document. The folder is remembered for the document and read again at each generation: edits to the templates apply at once. It is used until a built-in set is picked again.
- _Copy the built-in templates into a folder…_ starts a set of one's own from the project's built-in one.
- VS Code: _ProjectScaffold: Code Templates…_, or the setting `projectScaffold.generate.templates` (folder relative to the project file).

Writing a set: [Writing templates](templates.md).

## Code generation panel

_Window › Code generation_ shows:

- the templates generating the document: its template folder, the output directory's `.scaffold/templates`, else the built-in ones;
- the files generated into its output directory (from `.scaffold-gen.json`, with their `.orphans` files).

Usage:

- _Change templates…_, _Generate_ and _Refresh_ (icon buttons) sit above the file filter, always in view.
- Each section folds (click its header) and moves (drag its header, Alt+↑ / Alt+↓, or right click); the order is kept.
- _Tree_ switches the files between a list and a folder tree; beside it, fold / unfold all the folders.
- Click opens a file in an editor tab (Alt+click: to the side), in the code editor of the project text:
  - Liquid templates are checked as you type (syntax, unknown filters, unclosed `user` sections);
  - in generated files the user sections are shaded, edits elsewhere being conflicts at the next generation.
- Ctrl+S (or _Save_) writes the file of the active tab. A file changed on disk is read again when its tab is shown, or marked when it holds edits.
- The built-in templates are read-only: _Copy them into a folder…_ to edit them.
- In VS Code, files open in VS Code's own editors.

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
