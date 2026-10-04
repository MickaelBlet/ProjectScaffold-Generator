# C++ and Python mapping

How the built-in template sets spell the model. The C++17 set is the reference; the other C++ sets differ from it as listed below. SCA: [SCA mapping](sca.md). Calls between binaries: [Links between binaries](remote.md).

- [C++17](#c17)
- [C++20](#c20)
- [C++14](#c14)
- [C++11](#c11)
- [C++98](#c98)
- [Python](#python)

## C++17

### Project and files

| Model                 | C++                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| project `Robot`       | namespace `robot`, CMake library `robot` (+ executable `robot_app` when there are modules)             |
| user types            | one header each in `include/<ns>/types/`                                                               |
| constants             | `inline constexpr` (numbers, enums, bitmasks) or `inline const` values in `include/<ns>/constants.hpp` |
| interface `Telemetry` | abstract class `ITelemetry` (pure virtual messages) in `include/<ns>/interfaces/`                      |
| module `Core.Sensor`  | class `robot::core::Sensor`, `include/robot/core/Sensor.hpp`, `src/core/Sensor.cpp`                    |
| dependencies          | included from their own generated code (`<common/types/Pose.hpp>`, namespace `common`)                 |

### Types

| Model            | C++                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| struct           | `struct` with default member initializers                                                                                                                                            |
| exception        | `struct` deriving from `std::exception`, `what()` its name; `@throws` in the docs of the messages raising it                                                                         |
| enum             | `enum class X : std::uint8_t`                                                                                                                                                        |
| bitmask          | `enum class` of the flags, with `\|`, `&`, `^`, `~` and `has(value, flags)`                                                                                                          |
| union            | class holding a `std::variant`: `_d()` (discriminator), a getter per case, a setter taking the discriminator (its first label by default), `_default(d)` when no case is the default |
| alias            | `using`                                                                                                                                                                              |
| custom primitive | `using X = …` in a user section                                                                                                                                                      |
| primitives       | `bool`, `char`, `std::int32_t`…, `float`, `double`, `std::string`, `std::vector<std::uint8_t>` (bytes)                                                                               |
| containers       | `std::array`, `std::vector`, `std::list`, `std::set`, `std::optional`, `std::map`                                                                                                    |

### Parameters

- `in`: by value for scalars and enums, else `const T&`.
- `out` / `inout`: `T&`.

### Modules

- `kind`, `bases`, `static` / `const` / `virtual` / `= 0` / `override` as written.
- Attributes are private members `name_` with a getter and a setter (unless `const`, or a method has that name).
- Nested modules are members of their container, with accessors (`core().sensor()`). Abstract ones with ports are `std::unique_ptr`, created in a user section; abstract ones without ports are only base classes.

### Ports

| Model                              | C++                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `out` port `out: Telemetry`        | `OutPort<ITelemetry>& out()` (`include/<ns>/ports.hpp`): `out()->publish(…)` for its single peer, `out().each(…)` for all |
| `in` port `telemetry: Telemetry`   | `ITelemetry& telemetry()`, whose calls land in `onTelemetryPublish(…)`, written in the `.cpp`                             |
| container `in` port linked inside  | the accessor returns the inner port                                                                                       |
| container `out` port linked inside | the inner port forwards to it                                                                                             |

### Links and binaries

- A link is `from.connect(to)` in the constructor of the innermost module holding both ends, or of `robot::System` (the top-level modules, created by `src/main.cpp`).
- Links to other projects: a user section in `System`.
- With binaries `Onboard`, `Ground`: one system per binary, `robot::OnboardSystem`, created by `src/onboard/main.cpp` (CMake executable `robot_onboard`).
- A link between two binaries calls a `remote::TelemetryProxy` (`include/<ns>/remote/`, implements `ITelemetry`) in the calling binary and is received by a `remote::TelemetryStub` bound to the `in` port in the other, both opened on the link's transport by the system: see [Links between binaries](remote.md).

### Names

Names that are C++ keywords get a trailing `_`; a warning tells. The keywords are the manifest's `reserved`.

## C++20

[`cpp20`](../templates/cpp20): the C++17 set in C++20.

- Concepts, `std::bit_cast` / `std::endian` in the wire format.
- Defaulted `operator==` on structs and unions.
- `std::jthread` server threads.

## C++14

[`cpp14`](../templates/cpp14): the C++17 set in C++14.

- `optional` is `scaffold::Optional` (`include/scaffold/optional.hpp`, the same in every project).
- Unions hold one member per case.
- Namespaces are opened one level at a time (`_namespace_open` / `_namespace_close`).
- Constants without `inline`; static attributes are function-local statics (`counter_()`).

## C++11

[`cpp11`](../templates/cpp11): the C++14 set in C++11.

- Structs have a constructor with a defaulted parameter per field (brace initialization: a struct with member initializers is no aggregate before C++14).
- `makeUnique` in place of `std::make_unique`.

## C++98

[`cpp98`](../templates/cpp98): the C++ sets in C++98.

- `include/scaffold/support.hpp` holds `scaffold::Optional`, `scaffold::Array` and `scaffold::Make`: containers are built item by item in place of braced lists, `Make<std::vector<int> >()(1)(2)`.
- Enums and bitmasks are structs keeping `Mode::Run`; `raw()` / `fromRaw()` give the underlying value.
- Union values come from a factory per case: `Command::makeSpeed(2.5)`.
- Modules initialize their members in their constructor and own abstract children through plain pointers.
- Transports run on pthreads: `remote::connect()` / `remote::serve()` return objects to delete; the stubs are the `remote::Handler` of their server.

## Python

[`python`](../templates/python) writes a Python 3.8+ package (standard library only, `pyproject.toml`). [`examples/station.scaffold.yaml`](../examples/station.scaffold.yaml) uses it.

| File                                           | Content                                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `data.py`                                      | dataclasses, `IntEnum` / `IntFlag`, unions, with their encoding                                                                          |
| `constants.py`                                 | the constants                                                                                                                            |
| `interfaces.py`                                | ABCs: a call takes the inputs and gives back the return value then the out / inout values, as a tuple when there are several             |
| `ports.py`                                     | `OutPort`: `port.method()` calls the only peer                                                                                           |
| `modules/`                                     | one Python module per module (a module with children is a package); calls received by an in port go to its `on_<port>_<message>` methods |
| `systems/`                                     | one per binary, run with `python -m <project>`                                                                                           |
| `wire.py`, `transport.py`, `remote/`, `peers/` | links between binaries, the same as the Python peers of the C++ sets: its binaries call C++ ones and back                                |
