# Embedded WebAssembly build assets

The CLI embeds the unmodified StarlingMonkey engine from ComponentizeJS 0.19.3
and the WASI Preview 1 reactor adapter from Jco 1.17.9. Their hashes and exact
npm archive integrity are pinned in native/build.rs. These are data assets;
no Jco or ComponentizeJS JavaScript program runs on the user's computer.

ComponentizeJS source: https://github.com/bytecodealliance/ComponentizeJS/tree/ab6483f82ee47df4b0eab74a2533e24075fdbb83
StarlingMonkey source: https://github.com/bytecodealliance/StarlingMonkey/tree/6cdcc0e8ba3cc8a80e026af3c0867a1f63e57d2a
SpiderMonkey corresponding MPL source: https://github.com/bytecodealliance/firefox/tree/FIREFOX_140_0_4_RELEASE_STARLING
Jco source: https://github.com/bytecodealliance/jco/tree/1.17.9
WASI adapter project: https://github.com/bytecodealliance/wasmtime/tree/main/crates/wasi-preview1-component-adapter (binary distributed by the pinned Jco release above)

SpiderMonkey is covered by MPL 2.0 and the additional notices in
spidermonkey-about-license.html. Its source is available at the link above.
StarlingMonkey includes OpenSSL, PicoSHA2, Rust support libraries, and WASI/LLVM
runtime support. Their notices accompany this file. The CLI's Rust library
notices are in THIRD_PARTY_LICENSES.txt. Keep these notices with redistributed
binaries and generated Wasm applications that embed this JavaScript runtime.
