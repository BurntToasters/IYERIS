//! End-to-end harness for iyeris-core on a real filesystem.
//!
//! Run with `cargo run --locked -p iyeris-e2e`. It writes
//! `target/e2e/core-artifact.json` first, then exits 0 only if every step passed.

mod artifact;
mod fixture;
mod steps;

use artifact::Step;
use steps::Ctx;

/// Runs every step inside a fresh temp directory. The directory is deleted when
/// this returns, which is before the artifact is written and the process exits.
async fn run(steps: &mut Vec<Step>) -> Vec<fixture::Entry> {
    let temp = match tempfile::Builder::new().prefix("iyeris-e2e-").tempdir() {
        Ok(temp) => temp,
        Err(error) => {
            steps.push(Step::new(
                "create-temp-dir",
                Err(error.to_string()),
                std::path::Path::new(""),
            ));
            return Vec::new();
        }
    };
    let root = match temp.path().canonicalize() {
        Ok(root) => root,
        Err(error) => {
            steps.push(Step::new(
                "create-temp-dir",
                Err(error.to_string()),
                std::path::Path::new(""),
            ));
            return Vec::new();
        }
    };
    let ctx = Ctx::new(root);
    steps::run_all(&ctx, steps).await;
    match steps::tree(&ctx) {
        Ok(entries) => entries,
        Err(message) => {
            steps.push(Step::new("collect-tree", Err(message), &ctx.root));
            Vec::new()
        }
    }
}

#[tokio::main]
async fn main() {
    let mut steps = Vec::new();
    let tree = run(&mut steps).await;

    let path = artifact::artifact_path();
    let mut failed: Vec<&str> = steps
        .iter()
        .filter(|step| !step.ok)
        .map(|step| step.name)
        .collect();
    if let Err(message) = artifact::write(&path, &steps, &tree) {
        eprintln!("failed to write E2E artifact: {message}");
        failed.push("write-artifact");
    }

    if failed.is_empty() {
        println!(
            "iyeris-e2e: {} steps passed; artifact at {}",
            steps.len(),
            path.display()
        );
        return;
    }
    eprintln!("iyeris-e2e failed steps: {}", failed.join(", "));
    std::process::exit(1);
}
