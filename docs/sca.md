# SCA mapping

The [`sca-cpp98`](../templates/sca-cpp98) template set makes a waveform of the project for the Software Communications Architecture 2.2.2, in C++98 over CORBA, built with omniORB 4.

- Needs `omniidl` and `libomniorb4-dev`. CMake finds them on the system, or with `-DCMAKE_PREFIX_PATH=<prefix> -DOMNIIDL=<omniidl>`.
- Check: `scripts/check_templates.sh sca-cpp98` (`OMNIORB_ROOT` for an omniORB elsewhere).

- [IDL](#idl)
- [Components](#components)
- [Descriptors](#descriptors)
- [Executables](#executables)

## IDL

`idl/<ns>.idl`, IDL module `<ns>`:

| Model                      | IDL                                                                       |
| -------------------------- | ------------------------------------------------------------------------- |
| enum values, bitmask flags | prefixed with their type, `State_On` (IDL puts them in the module)        |
| structs and unions         | declared first when they name themselves                                  |
| constants                  | those IDL can write                                                       |
| interfaces                 | interfaces                                                                |
| `vector<Reading>`          | typedef `ReadingSeq`                                                      |
| `map<string, int32>`       | `StringInt32Map`, a sequence of `StringInt32MapEntry` key / value structs |
| `optional`, `array`        | sequences bounded to 1 and to their size                                  |
| `bytes`                    | `CF::OctetSequence`                                                       |
| `int8`                     | `octet`                                                                   |
| custom primitives          | `any`, in a user section                                                  |

- `idl/CF.idl` holds the Core Framework interfaces a component needs (`CF::Resource`, `CF::Port`…, with their standard repository ids): replace it with a Core Framework's own.
- omniidl writes their C++ (the CORBA C++ mapping: `char*` strings, `T*` / `T_out` for variable-length types) into the build directory.

## Components

A component per concrete top-level module: `class Plant : public ::sca::Resource`. Abstract and interface modules, and modules inside others, are plain C++ classes held by their component. `include/sca/support.hpp` (the same in every project) implements `CF::Resource`.

### Ports

- `in` ports are **provides** ports: servants of their interface, whose calls go to the component's `on<Port><Message>` handlers (user sections).
- `out` ports are **uses** ports, `sca::UsesPort<Interface>` (a `CF::Port`: `connectPort` / `disconnectPort`), called with `out()->push(frame)` (the only connection) or `out().each(f)`.
- `getPort` gives both, and the ports of inner modules that links of the waveform reach, by their path in the component (`Store.query`).
- Inside a component, modules are wired as in the other C++ sets: `sensor().out().connect(store().in())`.

### Properties and life cycle

- Instance attributes are **properties**: `configure` / `query` read and write them as anys of their IDL type (const attributes are read only), set to their defaults by the constructor.
- Life cycle hooks `onInitialize`, `onStart`, `onStop`, `onRelease`, `onConfigured(id)` are user sections.

## Descriptors

In `dom/`, the layout of an SDR root, where `cmake --install` puts them with the executables (`dom/bin`).

| File                                   | Content                                                                                                                                                                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dom/components/<Name>/<Name>.spd.xml` | software package, its code the executable of its binary (`/bin/<ns>_<binary>`, or `<ns>_app`)                                                                                                                                                        |
| `dom/components/<Name>/<Name>.scd.xml` | its provides / uses ports with their repository ids                                                                                                                                                                                                  |
| `dom/components/<Name>/<Name>.prf.xml` | attributes of primitive types as `simple`, vectors of them as `simplesequence`; others listed in comments                                                                                                                                            |
| `dom/waveforms/<ns>/<ns>.sad.xml`      | a placement per component (found in the naming service as `<Name>_1`), the binaries as host collocations, the first component as assembly controller, a connection per link between components, the ports linked to other projects as external ports |

Ids are UUIDs made from the names, stable across generations.

## Executables

- One per binary, `<ns>_<binary>` (`src/main/<binary>_main.cpp`), serving its components in one process; `<ns>_app` (`src/main/main.cpp`) serves the components of no binary (all of them when the project has none). Each component is bound by its usage name (`<Name>_1`), where the SAD finds it, in the naming context of the SCA execute parameters (`NAMING_CONTEXT_IOR`; with one component, `NAME_BINDING` and `COMPONENT_IDENTIFIER` apply), else in the `NameService` (`-ORBInitRef NameService=...`), else their IORs are printed. Served until SIGINT / SIGTERM or the release of every component.
- `<ns>_waveform`: the whole waveform in one process without a Core Framework. Its components are activated, connected as the SAD connects them, initialized and started until SIGINT / SIGTERM.
