# Embedded engine source inputs

`assets/engine.json` pins the ComponentizeJS and StarlingMonkey revisions and the
uncompressed engine digest. The engine includes Hibana's async-context glue in
`async-context.h` and `async-context.cpp`; it is not an unmodified upstream binary.
SpiderMonkey itself comes from the upstream source revision linked in
`licenses/NOTICE.md`.

`build-reference.rs` is the exact publisher build recipe used for this asset,
retained here for provenance. It is a reference, not an independent Cargo crate.
The source digest in `engine.json` hashes the three files with their original
paths: `sdk/engine/async-context.h`, `sdk/engine/async-context.cpp`, and
`xtask/src/engine.rs`. The backend service sources are not needed to inspect these
changes.

To rebuild, obtain ComponentizeJS and StarlingMonkey at the pinned revisions,
apply the four exact text patches in `build-reference.rs`, and build the CMake
`starlingmonkey_embedding` target with `STARLINGMONKEY_SRC` pointing to the
StarlingMonkey checkout and `HIBANA_ENGINE_SRC` to this directory. Install the
upstream CMake/WASI SDK prerequisites documented by ComponentizeJS. This is a
publisher operation; normal CLI installation uses the checked bundled artifact.
