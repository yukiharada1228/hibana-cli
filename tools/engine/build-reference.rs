//! Publisher-only build of the pinned ComponentizeJS engine plus async-context glue.
use crate::{json, process, root, write_json};
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
const COMPONENTIZE: &str = "ab6483f82ee47df4b0eab74a2533e24075fdbb83";
const STARLING: &str = "6cdcc0e8ba3cc8a80e026af3c0867a1f63e57d2a";
fn digest() -> Result<String> {
    let mut hash = Sha256::new();
    for name in [
        "sdk/engine/async-context.h",
        "sdk/engine/async-context.cpp",
        "xtask/src/engine.rs",
    ] {
        let bytes = fs::read(root().join(name))?;
        hash.update(name.as_bytes());
        hash.update([0]);
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn check() -> Result<()> {
    let manifest = json(root().join("sdk/engine/manifest.json"))?;
    ensure!(
        manifest["source_sha256"] == digest()?
            && manifest["componentize_js"] == COMPONENTIZE
            && manifest["starlingmonkey"] == STARLING,
        "Engine sources changed; regenerate with xtask engine"
    );
    let compressed = fs::read(root().join("sdk/native/assets/starlingmonkey_embedding.wasm.gz"))?;
    let mut bytes = Vec::new();
    flate2::read::GzDecoder::new(compressed.as_slice())
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 64 * 1024 * 1024
            && manifest["sha256"] == format!("{:x}", Sha256::digest(&bytes)),
        "Engine asset checksum mismatch"
    );
    println!("PASS: embedded Wasm engine matches its source inputs");
    Ok(())
}
fn source(directory: &Path, repository: &str, revision: &str) -> Result<()> {
    if !directory.exists() {
        process::visible(
            Command::new("git")
                .args(["clone", "--no-checkout", "--filter=blob:none", repository])
                .arg(directory),
            Duration::from_secs(300),
        )?;
    }
    process::visible(
        Command::new("git")
            .arg("-C")
            .arg(directory)
            .args(["fetch", "--depth", "1", "origin", revision]),
        Duration::from_secs(300),
    )?;
    // Never reset an existing source checkout: its patch must be exactly ours.
    let head = process::output(
        Command::new("git")
            .arg("-C")
            .arg(directory)
            .args(["rev-parse", "HEAD"]),
        Duration::from_secs(10),
    )?;
    if head.trim() != revision {
        let changes = process::output(
            Command::new("git")
                .arg("-C")
                .arg(directory)
                .args(["status", "--porcelain"]),
            Duration::from_secs(10),
        )?;
        ensure!(
            changes.trim().is_empty(),
            "Engine source {} has local changes",
            directory.display()
        );
        process::visible(
            Command::new("git")
                .arg("-C")
                .arg(directory)
                .args(["checkout", "--detach", revision]),
            Duration::from_secs(30),
        )?;
    }
    Ok(())
}
fn patch(path: &Path, before: &str, after: &str) -> Result<()> {
    let text = fs::read_to_string(path)?;
    if text.contains(after) {
        return Ok(());
    }
    ensure!(
        text.matches(before).count() == 1,
        "Engine patch drift in {}",
        path.display()
    );
    fs::write(path, text.replacen(before, after, 1))?;
    Ok(())
}
pub fn run(args: &[String]) -> Result<()> {
    if args.first().map(String::as_str) == Some("package") && args.len() == 2 {
        return package(Path::new(&args[1]));
    }
    ensure!(
        args.is_empty(),
        "Usage: xtask engine [package <built embedding.wasm>]"
    );
    let directory = std::env::var_os("HIBANA_ENGINE_BUILD_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| root().join(".local/engine"));
    fs::create_dir_all(&directory)?;
    let componentize = directory.join("ComponentizeJS");
    let starling = directory.join("StarlingMonkey");
    source(
        &componentize,
        "https://github.com/bytecodealliance/ComponentizeJS.git",
        COMPONENTIZE,
    )?;
    source(
        &starling,
        "https://github.com/bytecodealliance/StarlingMonkey.git",
        STARLING,
    )?;
    patch(
        &starling.join("runtime/event_loop.cpp"),
        "#include \"event_loop.h\"",
        "#include \"event_loop.h\"\n#include \"async-context.h\"",
    )?;
    patch(
        &starling.join("runtime/event_loop.cpp"),
        "js::RunJobs(cx);",
        "hibana::async_context::run_jobs(cx);",
    )?;
    patch(
        &componentize.join("CMakeLists.txt"),
        "add_builtin(componentize::embedding SRC embedding/embedding.cpp)",
        "add_builtin(componentize::embedding SRC embedding/embedding.cpp)\nadd_builtin(hibana::async_context SRC \"$ENV{HIBANA_ENGINE_SRC}/async-context.cpp\" INCLUDE_DIRS \"$ENV{HIBANA_ENGINE_SRC}\")\ntarget_include_directories(starling-raw.wasm PRIVATE \"$ENV{HIBANA_ENGINE_SRC}\")",
    )?;
    patch(
        &componentize.join("CMakeLists.txt"),
        "include_directories(\"StarlingMonkey\")",
        "include_directories(\"${STARLINGMONKEY_SRC}\")",
    )?;
    let build = componentize.join("build-release");
    for mut command in [
        {
            let mut c = Command::new("cmake");
            c.arg("-S")
                .arg(&componentize)
                .arg("-B")
                .arg(&build)
                .arg("-DCMAKE_BUILD_TYPE=Release");
            c
        },
        {
            let mut c = Command::new("cmake");
            c.arg("--build")
                .arg(&build)
                .args(["--target", "starlingmonkey_embedding", "-j", "4"]);
            c
        },
    ] {
        command
            .env("STARLINGMONKEY_SRC", starling.canonicalize()?)
            .env("HIBANA_ENGINE_SRC", root().join("sdk/engine"));
        process::visible(&mut command, Duration::from_secs(1800))?;
    }
    package(&componentize.join("lib/starlingmonkey_embedding.wasm"))
}
fn package(path: &Path) -> Result<()> {
    let bytes = fs::read(path).with_context(|| format!("Built engine {}", path.display()))?;
    ensure!(
        bytes.starts_with(b"\0asm") && bytes.len() < 64 * 1024 * 1024,
        "Invalid engine artifact"
    );
    let mut encoder = flate2::GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), flate2::Compression::best());
    encoder.write_all(&bytes)?;
    fs::write(
        root().join("sdk/native/assets/starlingmonkey_embedding.wasm.gz"),
        encoder.finish()?,
    )?;
    write_json(
        root().join("sdk/engine/manifest.json"),
        &serde_json::json!({"componentize_js":COMPONENTIZE,"starlingmonkey":STARLING,"source_sha256":digest()?,"sha256":format!("{:x}",Sha256::digest(&bytes))}),
    )?;
    check()
}
