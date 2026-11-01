// Code generation from a project file: scaffold-gen <project file> [options]
mod codegen;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::Parser;

use codegen::builtin::{TEMPLATE_SETS, builtin, is_template_set};
use codegen::run::{FsDir, RunOptions, format_report, generate_into, read_or_none, template_set_for};
use codegen::template_set::{MANIFEST, TemplateSet, load_template_set};

#[derive(Parser)]
#[command(name = "scaffold-gen", version, about = "Generates code skeletons from ProjectScaffold projects")]
struct Args {
    /// Generation context as JSON (scripts/dump-context.ts), in place of a project file.
    #[arg(long, value_name = "FILE")]
    context: PathBuf,
    /// Output directory.
    #[arg(short, long, value_name = "DIR")]
    out: PathBuf,
    /// Template set: a folder (holding a manifest.yaml), or a built-in one: cpp17, cpp20, cpp14,
    /// cpp11, cpp98, python, sca-cpp98 (default: <out>/.scaffold/templates if present).
    #[arg(short, long, value_name = "SET")]
    templates: Option<String>,
    /// Overwrite files changed outside their user sections.
    #[arg(short, long)]
    force: bool,
    /// Delete the files no longer generated (user code kept in .orphans files).
    #[arg(short, long)]
    prune: bool,
    /// Report only, write nothing.
    #[arg(short = 'n', long)]
    dry_run: bool,
}

/// Template set given by -t: a built-in name (`./<name>` for a folder of that name), else a folder.
fn templates_arg(arg: &str) -> Result<TemplateSet, String> {
    if is_template_set(arg) {
        return builtin(arg);
    }
    let dir = Path::new(arg);
    if read_or_none(&dir.join(MANIFEST))?.is_none() {
        return Err(format!(
            "templates '{arg}': neither a built-in set ({}) nor a folder holding a {MANIFEST}",
            TEMPLATE_SETS.join(", ")
        ));
    }
    load_template_set(|p| read_or_none(&dir.join(p)).ok().flatten())
}

fn run(args: &Args) -> Result<bool, String> {
    let text = std::fs::read_to_string(&args.context).map_err(|e| e.to_string())?;
    let ctx: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let dir = FsDir { root: args.out.clone(), label: args.out.display().to_string() };
    let set = match &args.templates {
        Some(t) => templates_arg(t)?,
        None => template_set_for(&dir, || Err("no template set: give one with -t".into()))?,
    };
    let options = RunOptions { force: args.force, prune: args.prune, dry_run: args.dry_run };
    let report = generate_into(&ctx, &set, &dir, &options)?;
    println!("{}", format_report(&report, &format!("{} -> {}", args.context.display(), dir.label), true));
    Ok(report.conflicts.is_empty())
}

fn main() -> ExitCode {
    let args = Args::parse();
    match run(&args) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("{}: error: {e}", args.context.display());
            ExitCode::FAILURE
        }
    }
}
