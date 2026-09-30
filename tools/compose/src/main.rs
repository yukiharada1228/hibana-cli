use anyhow::{Context, Result};
use wac_graph::{types::Package, CompositionGraph, EncodeOptions};

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let output = args.next().context("Missing output path")?;
    let input = args.next().context("Missing application component")?;
    let mut graph = CompositionGraph::new();
    let package = Package::from_file("hibana:application", None, input, graph.types_mut())?;
    let socket = graph.register_package(package)?;
    let mut plugs = Vec::new();
    for (index, path) in args.enumerate() {
        let package = Package::from_file(
            &format!("hibana:extension-{index}"), None, path, graph.types_mut(),
        )?;
        plugs.push(graph.register_package(package)?);
    }
    wac_graph::plug(&mut graph, plugs, socket)?;
    std::fs::write(output, graph.encode(EncodeOptions::default())?)?;
    Ok(())
}
