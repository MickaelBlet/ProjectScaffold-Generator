# Links between binaries

When a project has [binaries](file-format.md#binaries-and-transports) with links between them, the C++ sets also write their transports and, in `python/<ns>/`, Python peers of the binaries speaking the same protocol, to test a binary without the others. The [`python`](mapping.md#python) set writes the same Python side, so its binaries call C++ ones and back.

- [Transports](#transports)
- [Addresses](#addresses)
- [Calls](#calls)
- [Wire format](#wire-format)
- [Python peers](#python-peers)
- [Interoperability check](#interoperability-check)

## Transports

| Transport | Generated | Carries                                                                                                                                                     |
| --------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tcp       | yes       | frames back to back                                                                                                                                         |
| udp       | yes       | a datagram per frame (64 KB at most)                                                                                                                        |
| http      | yes       | `POST <path>` with the frame as body, answered by the reply frame (200) or nothing (204)                                                                    |
| websocket | yes       | `GET <path>`, a binary message per frame                                                                                                                    |
| shm       | yes       | a POSIX shared memory segment holding two rings (calls, replies; 1 MiB each by default) of length-prefixed frames, made by the server (one client per link) |
| others    | no        | a user section, where a `remote::Channel` / `remote::Server` of your own goes                                                                               |

- Code: `include/<ns>/remote/transport.hpp`, `src/remote/transport.cpp` (POSIX, threads).
- The system of the calling binary opens its proxy with `remote::connect(…)`; the other serves its stub with `remote::serve(…)`, and its `main` waits for SIGINT / SIGTERM.
- The calls reach the bound `in` port on the transport's threads (several at once over tcp, http and websocket).

## Addresses

| End    | Taken from, first found                                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------ |
| client | environment variable `<PROJECT>_<LINK>` (e.g. `ROVER_SUPERVISE_CAMERA=10.0.0.2:47000`), else the link's `client` setting |
| server | environment variable `<PROJECT>_<LINK>_LISTEN`, else the link's `server` setting                                         |

- Unset host and port come from `remoteDefaults`: `127.0.0.1:<47000 + index of the link>` by default.
- The client connects again after a failure.
- shm: the name of the segment (`name`, `<project>_<link>` by default), made by the server with rings of `capacity` bytes.
- Settings of transports not generated are listed in their user sections. In templates: `r.link.constraints.remote.settings`; resolved ones, defaults applied, in `r.settings`.

## Calls

- A call waits for its reply when it has a result (return value, `out` / `inout` parameters) or its link has `ack.required`, within `ack.timeoutMs` (default 5000 ms). Otherwise it is sent and forgotten.
- Failures (timeout, transport, an exception in the called binary) throw `remote::Error` / raise `RemoteError`.
- The exceptions a message `raises` come back as such, thrown by the proxy: `catch (const Busy&)` / `except data.Busy`.

## Wire format

`remote/wire.hpp`, `wire.py`. Little-endian.

| Value                   | Encoding                                                       |
| ----------------------- | -------------------------------------------------------------- |
| `bool`, `char`          | 1 byte                                                         |
| integers, floats        | fixed size (1 to 8 bytes; floats: IEEE 754)                    |
| `string`, `bytes`       | u32 length + bytes (UTF-8)                                     |
| `vector`, `list`, `set` | u32 count + items                                              |
| `array`                 | its items                                                      |
| `optional`              | u8 flag + value                                                |
| `map`                   | u32 count + keys and values                                    |
| struct                  | its fields in order                                            |
| enum, bitmask           | its underlying type                                            |
| union                   | the discriminator, then the case it selects (nothing for none) |
| custom primitive        | written by hand in user sections (`codec.hpp`, `data.py`)      |

Bounds (`string<16>`, `vector<T, 8>`) are checked when encoding and decoding: a value over its bound throws `remote::Error` / raises `RemoteError`.

### Frames

A frame is a 16-byte header, then a payload:

| Bytes | Field                                |
| ----- | ------------------------------------ |
| 0–3   | magic `SCF1`                         |
| 4     | u8 kind: 1 call, 2 reply, 3 error    |
| 5     | u8 flags: 1 reply wanted             |
| 6–7   | u16 message (index in the interface) |
| 8–11  | u32 call id                          |
| 12–15 | u32 payload length                   |

| Kind  | Payload                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------- |
| call  | the inputs (`in`, `inout`)                                                                                      |
| reply | the result, then the outputs (`out`, `inout`)                                                                   |
| error | the error text; then, with flag 2, the u16 index of the exception in the `raises` of the message and its fields |

## Python peers

Python 3.8+, standard library only, in `python/<ns>/`:

| File                    | Content                                                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data.py`               | dataclasses, exceptions as dataclasses deriving from `Exception`, unions as dataclasses `(d, value)`, `IntEnum`s, `IntFlag`s                                                                   |
| `constants.py`          | the constants of the types of `data.py`                                                                                                                                                        |
| `remote/<interface>.py` | `<I>Proxy`, whose calls give back their return value then their outputs (a tuple when there are several); `<I>Handler` to override, logging and answering default values by default; `<I>Stub` |
| `links.py`              | the links                                                                                                                                                                                      |
| `peers/<binary>.py`     | one peer per binary, standing in for it: it serves the links the binary receives into handlers, and has a proxy per link it calls                                                              |

```python
from rover.peers.ground import GroundPeer   # from generated/rover/python

with GroundPeer() as ground:                # calls the real rover_onboard
    print(ground.supervise_camera.start(), ground.supervise_perception.health())
```

`python -m rover.peers.onboard` runs a peer of the onboard binary until Ctrl-C (its `main` is a user section).

## Interoperability check

```sh
scripts/check_remote.sh [-t <set>]
```

It generates [`tests/fixtures/relay.scaffold.yaml`](../tests/fixtures/relay.scaffold.yaml) (a link per transport, every kind of type), builds it with [`tests/remote/interop.cpp`](../tests/remote/interop.cpp) and checks every call C++ → Python, Python → C++ and Python → Python over each transport. `-t python` checks the Python set against cpp17 binaries.
