# Embedded WebAssembly build assets

The TypeScript CLI uses ComponentizeJS 0.19.3 and Jco 1.17.9 as npm dependencies.
The bundled StarlingMonkey engine includes Hibana async-context glue. Its hashes
and exact upstream revisions are pinned in assets/engine.json; the additional
source files and build recipe are public at:
https://github.com/yukiharada1228/hibana-cli/tree/main/tools/engine

The Node compatibility archive contains JavaScript adapters and WebAssembly
primitives. tools/compose contains the source of the bundled WASI composition
helper. Compiler programs run in child processes with application credentials
removed from their environment.

ComponentizeJS source: https://github.com/bytecodealliance/ComponentizeJS/tree/ab6483f82ee47df4b0eab74a2533e24075fdbb83
StarlingMonkey source: https://github.com/bytecodealliance/StarlingMonkey/tree/6cdcc0e8ba3cc8a80e026af3c0867a1f63e57d2a
SpiderMonkey corresponding MPL source: https://github.com/bytecodealliance/firefox/tree/FIREFOX_140_0_4_RELEASE_STARLING
Jco source: https://github.com/bytecodealliance/jco/tree/1.17.9
WASI adapter project: https://github.com/bytecodealliance/wasmtime/tree/main/crates/wasi-preview1-component-adapter (binary distributed by the pinned Jco release above)

SpiderMonkey is covered by MPL 2.0 and the additional notices in
spidermonkey-about-license.html. Its source is available at the link above.
StarlingMonkey includes OpenSSL, PicoSHA2, Rust support libraries, and WASI/LLVM
runtime support. Their notices accompany this file. The bundled Wasm helper/library
notices are in THIRD_PARTY_LICENSES.txt. Keep these notices with redistributed
binaries and generated Wasm applications that embed this JavaScript runtime.
