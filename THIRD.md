# Third-party licenses

ProjectScaffold is distributed under the MIT License (see [LICENSE](LICENSE)).
It bundles or is built on the third-party software listed below. Each component
remains under its own license; the copyright notices and license texts are
reproduced here as required.

Development-only tools (TypeScript, Vite, Vitest, ESLint, Prettier, tsx, Ajv,
electron-builder, Tauri CLI, type definitions) are not shipped and are not
listed.

## 1. Web application (`dist-web/`)

These npm packages are bundled into the JavaScript served by every build
(browser, Electron and Tauri).

| Package                                                   | Version | License                     | Copyright                                                      |
| --------------------------------------------------------- | ------- | --------------------------- | -------------------------------------------------------------- |
| [@xyflow/react](https://github.com/xyflow/xyflow)         | 12.11.6 | MIT                         | Copyright (c) 2019-2025 webkid GmbH                            |
| [@xyflow/system](https://github.com/xyflow/xyflow)        | 0.0.82  | MIT                         | Copyright (c) 2019-2025 webkid GmbH                            |
| [classcat](https://github.com/jorgebucaran/classcat)      | 5.0.5   | MIT                         | Copyright © Jorge Bucaran <https://jorgebucaran.com>           |
| [d3-color](https://github.com/d3/d3-color)                | 3.1.0   | ISC                         | Copyright 2010-2022 Mike Bostock                               |
| [d3-dispatch](https://github.com/d3/d3-dispatch)          | 3.0.1   | ISC                         | Copyright 2010-2021 Mike Bostock                               |
| [d3-drag](https://github.com/d3/d3-drag)                  | 3.0.0   | ISC                         | Copyright 2010-2021 Mike Bostock                               |
| [d3-ease](https://github.com/d3/d3-ease)                  | 3.0.1   | BSD-3-Clause                | Copyright 2010-2021 Mike Bostock; Copyright 2001 Robert Penner |
| [d3-interpolate](https://github.com/d3/d3-interpolate)    | 3.0.1   | ISC                         | Copyright 2010-2021 Mike Bostock                               |
| [d3-selection](https://github.com/d3/d3-selection)        | 3.0.0   | ISC                         | Copyright 2010-2021 Mike Bostock                               |
| [d3-timer](https://github.com/d3/d3-timer)                | 3.0.1   | ISC                         | Copyright 2010-2021 Mike Bostock                               |
| [d3-transition](https://github.com/d3/d3-transition)      | 3.0.1   | ISC                         | Copyright 2010-2021 Mike Bostock                               |
| [d3-zoom](https://github.com/d3/d3-zoom)                  | 3.0.0   | ISC                         | Copyright 2010-2021 Mike Bostock                               |
| [dockview](https://github.com/dockview/dockview)          | 8.3.1   | MIT                         | Copyright (c) 2021 mathuo                                      |
| [dockview-core](https://github.com/dockview/dockview)     | 8.3.1   | MIT                         | Copyright (c) 2021 mathuo                                      |
| [dockview-react](https://github.com/dockview/dockview)    | 8.3.1   | MIT                         | Copyright (c) 2021 mathuo                                      |
| [elkjs](https://github.com/kieler/elkjs)                  | 0.12.0  | EPL-2.0 OR GPL-3.0-or-later | Copyright (c) 2017 Kiel University and others                  |
| [html-to-image](https://github.com/bubkoo/html-to-image)  | 1.11.13 | MIT                         | Copyright (c) 2017-2025 W.Y.                                   |
| [immer](https://github.com/immerjs/immer)                 | 11.1.18 | MIT                         | Copyright (c) 2017 Michel Weststrate                           |
| [react](https://github.com/react/react)                   | 19.3.0  | MIT                         | Copyright (c) Meta Platforms, Inc. and affiliates.             |
| [react-dom](https://github.com/react/react)               | 19.3.0  | MIT                         | Copyright (c) Meta Platforms, Inc. and affiliates.             |
| [scheduler](https://github.com/react/react)               | 0.28.0  | MIT                         | Copyright (c) Meta Platforms, Inc. and affiliates.             |
| [use-sync-external-store](https://github.com/react/react) | 1.7.0   | MIT                         | Copyright (c) Meta Platforms, Inc. and affiliates.             |
| [yaml](https://github.com/eemeli/yaml)                    | 2.9.1   | ISC                         | Copyright Eemeli Aro <eemeli@gmail.com>                        |
| [zod](https://github.com/colinhacks/zod)                  | 4.6.5   | MIT                         | Copyright (c) 2025 Colin McDonnell                             |
| [zundo](https://github.com/charkour/zundo)                | 2.3.0   | MIT                         | Copyright (c) 2021 Charles Kornoelje                           |
| [zustand](https://github.com/pmndrs/zustand)              | 4.5.7   | MIT                         | Copyright (c) 2019 Paul Henschel                               |
| [zustand](https://github.com/pmndrs/zustand)              | 5.0.15  | MIT                         | Copyright (c) 2019 Paul Henschel                               |

### Note on elkjs (EPL-2.0)

[elkjs](https://github.com/kieler/elkjs) is dual-licensed `EPL-2.0 OR
GPL-3.0-or-later`; ProjectScaffold uses it under the **Eclipse Public License
2.0**. It is included unmodified. Its source code is available at
<https://github.com/kieler/elkjs> and on npm (`elkjs@0.12.0`). The EPL-2.0
applies to elkjs only, not to ProjectScaffold as a whole.

## 2. Electron desktop build (`dist-electron/`)

| Component                                        | Version               | License                 | Copyright                                                                |
| ------------------------------------------------ | --------------------- | ----------------------- | ------------------------------------------------------------------------ |
| [Electron](https://github.com/electron/electron) | 44.4.5                | MIT                     | Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc. |
| [Chromium](https://www.chromium.org)             | bundled with Electron | BSD-3-Clause and others | Copyright The Chromium Authors                                           |
| [Node.js](https://nodejs.org)                    | bundled with Electron | MIT and others          | Copyright Node.js contributors                                           |

The Electron runtime ships with `LICENSE.electron.txt` and
`LICENSES.chromium.html`, which contain the full license texts of Electron,
Chromium, Node.js and all their dependencies. electron-builder copies both files
next to the executable.

## 3. Tauri desktop build (`dist-tauri/`)

The Tauri binary statically links the Rust crates below (all target platforms,
from `src-tauri/Cargo.lock`). The web view itself is provided by the operating
system (WebView2 on Windows, WebKitGTK on Linux, WKWebView on macOS) and is not
redistributed.

For crates offered under a choice of licenses (`A OR B`), ProjectScaffold
uses them under the MIT License where available, otherwise under the first
permissive option listed.

### MIT OR Apache-2.0 (210)

android_system_properties 0.1.6, anyhow 1.0.104, base64 0.21.7, base64 0.22.1, base64 0.23.1, bitflags 1.3.2, bitflags 2.13.2, block-buffer 0.10.4, bs58 0.5.1, bumpalo 3.20.3, camino 1.2.6, cargo-platform 0.1.9, cc 1.5.1, cfg-expr 0.15.8, cfg-if 1.0.5, chrono 0.4.45, cookie 0.18.2, core-foundation 0.10.1, core-foundation-sys 0.8.7, core-graphics 0.25.0, core-graphics-types 0.2.0, cpufeatures 0.2.17, crc32fast 1.5.2, crossbeam-channel 0.5.17, crossbeam-utils 0.8.23, crypto-common 0.1.7, defmt 1.1.1, defmt-macros 1.1.1, defmt-parser 1.0.0, deranged 0.5.8, digest 0.10.7, dirs 7.0.0, dirs-sys 0.5.0, displaydoc 0.2.7, dtoa 1.0.11, dyn-clone 1.0.20, embed_plist 1.2.2, erased-serde 0.4.10, fdeflate 0.3.7, field-offset 0.3.6, find-msvc-tools 0.1.14, flate2 1.1.10, foreign-types 0.5.0, foreign-types-macros 0.2.4, foreign-types-shared 0.3.1, form_urlencoded 1.2.2, futures-channel 0.3.34, futures-core 0.3.34, futures-executor 0.3.34, futures-io 0.3.34, futures-macro 0.3.34, futures-sink 0.3.34, futures-task 0.3.34, futures-util 0.3.34, getrandom 0.3.4, getrandom 0.4.3, glob 0.3.4, hashbrown 0.12.3, hashbrown 0.17.1, heck 0.4.1, heck 0.5.0, hex 0.4.3, html5ever 0.39.0, http 1.5.0, httparse 1.10.1, iana-time-zone 0.1.65, iana-time-zone-haiku 0.1.2, ident_case 1.0.1, idna 1.1.0, ipnet 2.12.2, itoa 1.0.18, jni 0.21.1, jni-sys 0.3.1, jni-sys 0.4.1, jni-sys-macros 0.4.1, js-sys 0.3.106, json-patch 4.2.0, jsonptr 0.7.1, keyboard-types 0.8.3, libc 0.2.189, lock_api 0.4.14, log 0.4.34, markup5ever 0.39.0, mime 0.3.17, ndk 0.9.0, ndk-context 0.1.1, ndk-sys 0.6.0+11769913, num-conv 0.2.2, num-traits 0.2.19, once_cell 1.21.4, parking_lot 0.12.5, parking_lot_core 0.9.12, percent-encoding 2.3.2, pkg-config 0.3.34, png 0.17.16, png 0.18.1, powerfmt 0.2.0, proc-macro-crate 1.3.1, proc-macro-crate 2.0.2, proc-macro-crate 3.5.0, proc-macro-error 1.0.4, proc-macro-error-attr 1.0.4, proc-macro2 1.0.107, quote 1.0.47, ref-cast 1.0.27, ref-cast-impl 1.0.27, regex 1.13.1, regex-automata 0.4.18, regex-syntax 0.8.11, reqwest 0.13.5, rustc_version 0.4.1, rustversion 1.0.23, scopeguard 1.2.0, semver 1.0.28, serde 1.0.229, serde-untagged 0.1.9, serde_core 1.0.229, serde_derive 1.0.229, serde_derive_internals 0.29.1, serde_json 1.0.151, serde_repr 0.1.21, serde_spanned 0.6.9, serde_spanned 1.1.1, serde_with 3.24.0, serde_with_macros 3.24.0, serialize-to-javascript 0.1.2, serialize-to-javascript-impl 0.1.2, servo_arc 0.4.3, sha2 0.10.9, shlex 2.0.1, siphasher 1.0.4, smallvec 1.16.2, socket2 0.6.5, softbuffer 0.4.8, stable_deref_trait 1.2.1, string_cache 0.9.0, string_cache_codegen 0.6.1, swift-rs 1.0.8, syn 1.0.109, syn 2.0.119, syn 3.0.6, system-deps 6.2.2, tao-macros 0.1.4, tendril 0.5.1, thiserror 1.0.69, thiserror 2.0.21, thiserror-impl 1.0.69, thiserror-impl 2.0.21, time 0.3.55, time-core 0.1.9, time-macros 0.2.32, toml 0.8.2, toml 1.1.6+spec-1.1.0, toml_datetime 0.6.3, toml_datetime 1.1.1+spec-1.1.0, toml_edit 0.19.15, toml_edit 0.20.2, toml_edit 0.25.15+spec-1.1.0, toml_parser 1.1.3+spec-1.1.0, toml_writer 1.1.2+spec-1.1.0, tray-icon 0.25.1, typeid 1.0.3, typenum 1.20.1, unicode-segmentation 1.13.3, url 2.5.8, version_check 0.9.5, wasm-bindgen 0.2.129, wasm-bindgen-futures 0.4.79, wasm-bindgen-macro 0.2.129, wasm-bindgen-macro-support 0.2.129, wasm-bindgen-shared 0.2.129, wasm-streams 0.5.0, web-sys 0.3.106, web-time 1.1.0, web_atoms 0.2.6, winapi 0.3.9, winapi-i686-pc-windows-gnu 0.4.0, winapi-x86_64-pc-windows-gnu 0.4.0, windows 0.62.2, windows-collections 0.3.2, windows-core 0.62.2, windows-future 0.3.2, windows-implement 0.60.2, windows-interface 0.59.3, windows-link 0.2.1, windows-numerics 0.3.1, windows-result 0.4.1, windows-strings 0.5.1, windows-sys 0.45.0, windows-sys 0.59.0, windows-sys 0.61.2, windows-targets 0.42.2, windows-targets 0.52.6, windows-threading 0.2.1, windows-version 0.1.7, windows_aarch64_gnullvm 0.42.2, windows_aarch64_gnullvm 0.52.6, windows_aarch64_msvc 0.42.2, windows_aarch64_msvc 0.52.6, windows_i686_gnu 0.42.2, windows_i686_gnu 0.52.6, windows_i686_gnullvm 0.52.6, windows_i686_msvc 0.42.2, windows_i686_msvc 0.52.6, windows_x86_64_gnu 0.42.2, windows_x86_64_gnu 0.52.6, windows_x86_64_gnullvm 0.42.2, windows_x86_64_gnullvm 0.52.6, windows_x86_64_msvc 0.42.2, windows_x86_64_msvc 0.52.6

### MIT (98)

atk 0.18.2, atk-sys 0.18.2, block2 0.6.2, bytes 1.12.1, cairo-rs 0.18.5, cairo-sys-rs 0.18.2, cargo_metadata 0.19.2, cfb 0.14.0, combine 4.6.8, darling 0.24.1, darling_core 0.24.1, darling_macro 0.24.1, derive_more 2.1.1, derive_more-impl 2.1.1, dlopen2 0.8.2, dlopen2_derive 0.4.3, dom_query 0.28.0, embed-resource 3.0.11, gdk 0.18.2, gdk-pixbuf 0.18.5, gdk-pixbuf-sys 0.18.0, gdk-sys 0.18.2, gdkwayland-sys 0.18.2, gdkx11 0.18.2, gdkx11-sys 0.18.2, generic-array 0.14.7, gio 0.18.4, gio-sys 0.18.1, glib 0.18.5, glib-macros 0.18.5, glib-sys 0.18.1, gobject-sys 0.18.0, gtk 0.18.2, gtk-sys 0.18.2, gtk3-macros 0.18.2, http-body 1.1.0, http-body-util 0.1.5, hyper 1.11.1, hyper-util 0.1.21, ico 0.5.0, infer 0.22.0, javascriptcore-rs 1.1.2, javascriptcore-rs-sys 1.1.1, libredox 0.1.25, memoffset 0.9.1, mio 1.2.3, new_debug_unreachable 1.0.6, objc2 0.6.4, objc2-encode 4.1.0, objc2-foundation 0.3.2, pango 0.18.3, pango-sys 0.18.0, phf 0.13.1, phf_codegen 0.13.1, phf_generator 0.13.1, phf_macros 0.13.1, phf_shared 0.13.1, plist 1.10.1, precomputed-hash 0.1.1, quick-xml 0.42.0, redox_syscall 0.5.18, redox_users 0.5.3, schemars 0.8.22, schemars 0.9.0, schemars 1.2.2, schemars_derive 0.8.22, simd-adler32 0.3.10, slab 0.4.12, soup3 0.5.0, soup3-sys 0.5.0, strsim 0.11.1, synstructure 0.14.0, tauri-winres 0.3.6, tokio 1.53.1, tokio-util 0.7.19, tower 0.5.3, tower-http 0.6.11, tower-layer 0.3.3, tower-service 0.3.3, tracing 0.1.44, tracing-core 0.1.36, try-lock 0.2.5, urlpattern 0.6.0, version-compare 0.2.1, vswhom 0.1.0, vswhom-sys 0.1.3, want 0.3.1, webkit2gtk 2.0.2, webkit2gtk-sys 2.0.2, webview2-com 0.39.1, webview2-com-macros 0.8.1, webview2-com-sys 0.39.1, winnow 0.5.40, winnow 1.0.4, winreg 0.55.0, x11 2.21.0, x11-dl 2.21.0, zmij 1.0.23

### Apache-2.0 OR MIT (33)

atomic-waker 1.1.2, autocfg 1.5.1, bit-set 0.8.0, bit-vec 0.8.0, cargo_toml 1.0.1, cesu8 1.1.0, ctor 1.0.13, dbus 0.9.12, equivalent 1.0.2, fastrand 2.5.0, fnv 1.0.7, idna_adapter 1.2.2, indexmap 1.9.3, indexmap 2.14.2, libappindicator 0.9.0, libappindicator-sys 0.9.0, libdbus-sys 0.2.7, muda 0.20.0, pin-project-lite 0.2.17, portable-atomic 1.15.0, portable-atomic-util 0.2.8, rustc-hash 2.1.3, tauri 2.12.0, tauri-build 2.7.0, tauri-codegen 2.7.0, tauri-macros 2.7.0, tauri-runtime 2.12.0, tauri-runtime-wry 2.12.0, tauri-utils 2.10.0, utf8_iter 1.0.4, uuid 1.26.1, window-vibrancy 0.8.1, wry 0.57.0

### Unicode-3.0 (18)

icu_collections 2.3.0, icu_locale_core 2.3.0, icu_normalizer 2.3.0, icu_normalizer_data 2.3.0, icu_properties 2.3.0, icu_properties_data 2.3.0, icu_provider 2.3.1, litemap 0.8.3, potential_utf 0.1.6, tinystr 0.8.4, writeable 0.6.4, yoke 0.8.3, yoke-derive 0.8.3, zerofrom 0.1.8, zerofrom-derive 0.1.8, zerotrie 0.2.5, zerovec 0.11.8, zerovec-derive 0.11.6

### Zlib OR Apache-2.0 OR MIT (17)

bytemuck 1.25.2, dispatch2 0.3.1, objc2-app-kit 0.3.2, objc2-cloud-kit 0.3.2, objc2-core-data 0.3.2, objc2-core-foundation 0.3.2, objc2-core-graphics 0.3.2, objc2-core-image 0.3.2, objc2-core-location 0.3.2, objc2-core-text 0.3.2, objc2-exception-helper 0.1.1, objc2-io-surface 0.3.2, objc2-quartz-core 0.3.2, objc2-ui-kit 0.3.2, objc2-user-notifications 0.3.2, objc2-web-kit 0.3.2, tinyvec 1.13.3

### Unlicense OR MIT (11)

aho-corasick 1.1.5, byteorder 1.5.0, jiff 0.2.37, jiff-core 0.1.1, jiff-static 0.2.37, jiff-tzdb 0.1.8, jiff-tzdb-platform 0.1.3, memchr 2.8.3, same-file 1.0.6, walkdir 2.5.0, winapi-util 0.1.11

### MPL-2.0 (5)

cssparser 0.37.0, cssparser-macros 0.7.1, dtoa-short 0.3.5, option-ext 0.2.0, selectors 0.38.0

### Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT (3)

wasi 0.11.1+wasi-snapshot-preview1, wasip2 1.0.4+wasi-0.2.12, wit-bindgen 0.57.1

### Apache-2.0 (2)

sync_wrapper 1.0.2, tao 0.37.1

### BSD-3-Clause (2)

alloc-no-stdlib 3.0.0, alloc-stdlib 0.3.0

### BSD-3-Clause OR MIT OR Apache-2.0 (2)

num_enum 0.7.6, num_enum_derive 0.7.6

### MIT OR Apache-2.0 OR LGPL-2.1-or-later (2)

r-efi 5.3.0, r-efi 6.0.0

### MIT OR Zlib OR Apache-2.0 (2)

miniz_oxide 0.8.9, miniz_oxide 0.9.1

### Zlib (2)

foldhash 0.2.0, zlib-rs 0.6.8

### (MIT OR Apache-2.0) AND Unicode-3.0 (1)

unicode-ident 1.0.26

### 0BSD OR MIT OR Apache-2.0 (1)

adler2 2.0.1

### Apache-2.0 AND MIT (1)

dpi 0.1.2

### Apache-2.0 WITH LLVM-exception (1)

target-lexicon 0.12.16

### BSD-3-Clause AND MIT (1)

brotli 9.0.0

### BSD-3-Clause OR MIT (1)

brotli-decompressor 6.0.1

### CC0-1.0 OR MIT-0 OR Apache-2.0 (1)

dunce 1.0.5

### ISC (1)

libloading 0.7.4

### MIT OR Apache-2.0 OR Zlib (1)

raw-window-handle 0.6.2

### Note on MPL-2.0 crates

`cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext` and
`selectors` are licensed under the Mozilla Public License 2.0. They are used
unmodified; their source code is available on <https://crates.io>. The MPL-2.0
applies to those files only.

## 4. License texts

### MIT

```text
MIT License

Copyright (c) <year> <copyright holders>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ISC

```text
Copyright (c) <year> <copyright holders>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### BSD-3-Clause

```text
Copyright (c) <year> <copyright holders>
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the author nor the names of contributors may be used to
  endorse or promote products derived from this software without specific prior
  written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### Other licenses

The full texts of the remaining licenses are available at:

- Apache-2.0: <https://www.apache.org/licenses/LICENSE-2.0>
- EPL-2.0: <https://www.eclipse.org/legal/epl-2.0/>
- MPL-2.0: <https://www.mozilla.org/MPL/2.0/>
- Unicode-3.0: <https://www.unicode.org/license.txt>
- Zlib: <https://opensource.org/license/zlib>
- 0BSD, MIT-0, CC0-1.0, Unlicense, LLVM-exception: <https://spdx.org/licenses/>
