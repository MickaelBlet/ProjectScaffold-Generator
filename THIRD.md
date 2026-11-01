# Third-party licenses

ProjectScaffold-Generator is distributed under the MIT License (see [LICENSE](LICENSE)).
It bundles the third-party software listed below. Each component remains under
its own license; the copyright notices and license texts are reproduced here as
required.

Build-time crates (procedural macros and their dependencies) are not shipped and are not
listed.

## 1. Command-line generator (`dist-cli/scaffold-gen`)

These Rust crates are compiled into the `scaffold-gen` executable.

| Crate | Version | License | Copyright |
| --- | --- | --- | --- |
| [aho-corasick](https://github.com/BurntSushi/aho-corasick) | 1.1.5 | Unlicense OR MIT | Copyright Andrew Gallant |
| [anstream](https://github.com/rust-cli/anstyle) | 1.0.0 | MIT OR Apache-2.0 | Copyright the anstyle authors |
| [anstyle](https://github.com/rust-cli/anstyle) | 1.0.14 | MIT OR Apache-2.0 | Copyright the anstyle authors |
| [anstyle-parse](https://github.com/rust-cli/anstyle) | 1.0.0 | MIT OR Apache-2.0 | Copyright the anstyle authors |
| [anstyle-query](https://github.com/rust-cli/anstyle) | 1.1.5 | MIT OR Apache-2.0 | Copyright the anstyle authors |
| [arraydeque](https://github.com/andylokandy/arraydeque) | 0.5.1 | MIT OR Apache-2.0 | Copyright andylokandy |
| [cfg-if](https://github.com/rust-lang/cfg-if) | 1.0.5 | MIT OR Apache-2.0 | Copyright Alex Crichton |
| [clap](https://github.com/clap-rs/clap) | 4.6.7 | MIT OR Apache-2.0 | Copyright the clap authors |
| [clap_builder](https://github.com/clap-rs/clap) | 4.6.7 | MIT OR Apache-2.0 | Copyright the clap authors |
| [clap_lex](https://github.com/clap-rs/clap) | 1.1.1 | MIT OR Apache-2.0 | Copyright the clap authors |
| [colorchoice](https://github.com/rust-cli/anstyle) | 1.0.5 | MIT OR Apache-2.0 | Copyright the anstyle authors |
| [encoding_rs](https://github.com/hsivonen/encoding_rs) | 0.8.35 | (Apache-2.0 OR MIT) AND BSD-3-Clause | Copyright Henri Sivonen |
| [equivalent](https://github.com/indexmap-rs/equivalent) | 1.0.3 | Apache-2.0 OR MIT | Copyright the indexmap authors |
| [foldhash](https://github.com/orlp/foldhash) | 0.2.0 | Zlib | Copyright Orson Peters |
| [hashbrown](https://github.com/rust-lang/hashbrown) | 0.17.1 | MIT OR Apache-2.0 | Copyright the hashbrown authors |
| [hashlink](https://github.com/djc/hashlink) | 0.12.2 | MIT OR Apache-2.0 | Copyright the hashlink authors |
| [include_dir](https://github.com/Michael-F-Bryan/include_dir) | 0.7.4 | MIT | Copyright Michael Bryan |
| [indexmap](https://github.com/indexmap-rs/indexmap) | 2.14.2 | Apache-2.0 OR MIT | Copyright the indexmap authors |
| [is_terminal_polyfill](https://github.com/polyfill-rs/is_terminal_polyfill) | 1.70.2 | MIT OR Apache-2.0 | Copyright the polyfill-rs authors |
| [itoa](https://github.com/dtolnay/itoa) | 1.0.18 | MIT OR Apache-2.0 | Copyright David Tolnay |
| [memchr](https://github.com/BurntSushi/memchr) | 2.8.3 | Unlicense OR MIT | Copyright Andrew Gallant, bluss |
| [minijinja](https://github.com/mitsuhiko/minijinja) | 3.0.5 | Apache-2.0 | Copyright Armin Ronacher |
| [minijinja-contrib](https://github.com/mitsuhiko/minijinja) | 3.0.5 | Apache-2.0 | Copyright Armin Ronacher |
| [regex](https://github.com/rust-lang/regex) | 1.13.1 | MIT OR Apache-2.0 | Copyright The Rust Project Developers, Andrew Gallant |
| [regex-automata](https://github.com/rust-lang/regex) | 0.4.18 | MIT OR Apache-2.0 | Copyright The Rust Project Developers, Andrew Gallant |
| [regex-syntax](https://github.com/rust-lang/regex) | 0.8.11 | MIT OR Apache-2.0 | Copyright The Rust Project Developers, Andrew Gallant |
| [ryu](https://github.com/dtolnay/ryu) | 1.0.23 | Apache-2.0 OR BSL-1.0 | Copyright David Tolnay |
| [serde](https://github.com/serde-rs/serde) | 1.0.229 | MIT OR Apache-2.0 | Copyright Erick Tryzelaar, David Tolnay |
| [serde_core](https://github.com/serde-rs/serde) | 1.0.229 | MIT OR Apache-2.0 | Copyright Erick Tryzelaar, David Tolnay |
| [serde_json](https://github.com/serde-rs/json) | 1.0.154 | MIT OR Apache-2.0 | Copyright Erick Tryzelaar, David Tolnay |
| [serde_yaml_ng](https://github.com/acatton/serde-yaml-ng) | 0.10.0 | MIT | Copyright Antoine Catton, David Tolnay |
| [strsim](https://github.com/rapidfuzz/strsim-rs) | 0.11.1 | MIT | Copyright Danny Guo, maxbachmann |
| [unsafe-libyaml](https://github.com/dtolnay/unsafe-libyaml) | 0.2.11 | MIT | Copyright David Tolnay, Kirill Simonov |
| [utf8parse](https://github.com/alacritty/vte) | 0.2.2 | Apache-2.0 OR MIT | Copyright Joe Wilm, Christian Duerr |
| [v_htmlescape](https://github.com/botika/v_escape) | 0.15.8 | MIT OR Apache-2.0 | Copyright Juan Aguilar Santillana |
| [yaml-rust2](https://github.com/Ethiraric/yaml-rust2) | 0.13.0 | MIT OR Apache-2.0 | Copyright Yuheng Chen, Ethiraric, David Aguilar |
| [zmij](https://github.com/dtolnay/zmij) | 1.0.23 | MIT | Copyright David Tolnay |

## 2. License texts

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

### Other licenses

The full texts of the remaining licenses (Apache-2.0, BSD-3-Clause, BSL-1.0, Unicode-3.0,
Unlicense, Zlib) are available at <https://spdx.org/licenses/>.
