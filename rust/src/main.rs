// Code generation from a project file: scaffold-gen <project file> [options]
mod codegen;
mod model;

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use clap::Parser;
use serde_json::Value as Json;

use codegen::builtin::{DEFAULT_TEMPLATE_SET, TEMPLATE_SETS, builtin, is_template_set};
use codegen::context::{build_context, dependency_name};
use codegen::filters::snake;
use codegen::node;
use codegen::run::{FsDir, RunOptions, format_report, generate_into, read_or_none, template_set_for};
use codegen::template_set::{MANIFEST, TemplateSet, load_template_set};
use model::load::{dl, ds, index_project, read_project};
use model::text::format_from_path;

#[derive(Parser)]
#[command(
    name = "scaffold-gen",
    about = "Generates code skeletons from ProjectScaffold project files",
    disable_version_flag = true
)]
struct Args {
    /// Project file (YAML or JSON).
    file: Option<String>,
    /// Output directory (default: generated/<project> next to the project file).
    #[arg(short, long, value_name = "DIR")]
    out: Option<String>,
    /// Template set: a folder (holding a manifest.yaml), or a built-in one: cpp17, cpp20, cpp14,
    /// cpp11, cpp98, python, sca-cpp98 (default: <out>/.scaffold/templates if present, else the
    /// project's generation.templates, else cpp17).
    #[arg(short, long, value_name = "SET")]
    templates: Option<String>,
    /// Also generate the dependencies, each in a sibling directory of <out>.
    #[arg(short, long)]
    deps: bool,
    /// Overwrite files changed outside their user sections.
    #[arg(short, long)]
    force: bool,
    /// Delete the files no longer generated (user code kept in .orphans files).
    #[arg(short, long)]
    prune: bool,
    /// Report only, write nothing.
    #[arg(short = 'n', long)]
    dry_run: bool,
    /// Print the version.
    #[arg(short = 'v', long)]
    version: bool,
    /// Generation context as JSON (scripts/dump-context.ts) in place of a project file (-o needed).
    #[arg(long, value_name = "FILE", hide = true)]
    context: Option<String>,
    /// Print the generation context of the project file as JSON, generate nothing.
    #[arg(long, hide = true)]
    dump_context: bool,
}

/// `path` lexically normalized (`.` and `..` resolved), absolute.
fn absolute(path: &Path) -> PathBuf {
    let p = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

/// `path` relative to the working directory, as node's path.relative gives it.
fn relative(path: &Path) -> String {
    let cwd = absolute(Path::new("."));
    let to = absolute(path);
    let a: Vec<_> = cwd.components().collect();
    let b: Vec<_> = to.components().collect();
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let mut parts: Vec<String> = vec!["..".into(); a.len() - common];
    parts.extend(b[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    parts.join("/")
}

/// A project file, checked: its data (editor data left in).
fn load_project(file: &Path) -> Result<Json, String> {
    let path = file.to_string_lossy();
    let text = std::fs::read_to_string(file).map_err(|_| "cannot read the file".to_string())?;
    let doc = if path.to_lowercase().ends_with(".idl") {
        // An IDL file stands for a project: its definitions, its includes as dependencies.
        let read = |p: &str| std::fs::read_to_string(p).ok();
        let files = model::idl::read_idl_includes(&path, &text, &read)?;
        let (value, warnings) = model::idl::idl_project(&path, &files)?;
        for w in warnings {
            eprintln!("{}: warning: {w}", relative(file));
        }
        model::text::Doc { value, lines: model::text::Lines::None }
    } else {
        read_project(&text, format_from_path(&path))?
    };
    {
        let index = index_project(&doc.value, &doc.lines)?;
        let errors = model::validate::validate(&doc.value, &index);
        if !errors.is_empty() {
            let n = errors.len();
            return Err(format!(
                "the project has {n} error{}:\n  {}",
                if n > 1 { "s" } else { "" },
                errors.join("\n  ")
            ));
        }
    }
    Ok(doc.value)
}

/// Template set given by -t: a built-in name (`./<name>` for a folder of that name), else a folder.
fn templates_arg(arg: &str) -> Result<TemplateSet, String> {
    if is_template_set(arg) {
        return builtin(arg);
    }
    let dir = absolute(Path::new(arg));
    if read_or_none(&dir.join(MANIFEST))?.is_none() {
        return Err(format!(
            "templates '{arg}': neither a built-in set ({}) nor a folder holding a {MANIFEST}",
            TEMPLATE_SETS.join(", ")
        ));
    }
    load_template_set(|p| read_or_none(&dir.join(p)).ok().flatten())
}

struct Run<'a> {
    args: &'a Args,
    done: HashSet<PathBuf>,
    failed: bool,
}

impl Run<'_> {
    fn fail(&mut self, file: &Path, e: &str) {
        eprintln!("{}: error: {e}", relative(file));
        self.failed = true;
    }

    fn generate(
        &mut self,
        ctx: &minijinja::Value,
        set: &TemplateSet,
        dir: &FsDir,
        label: &str,
    ) -> Result<(), String> {
        let options =
            RunOptions { force: self.args.force, prune: self.args.prune, dry_run: self.args.dry_run };
        let report = generate_into(ctx, set, dir, &options)?;
        println!("{}", format_report(&report, &format!("{label} -> {}", dir.label), true));
        if !report.conflicts.is_empty() {
            self.failed = true;
        }
        Ok(())
    }

    fn run(&mut self, file: PathBuf, out: Option<PathBuf>) {
        if !self.done.insert(file.clone()) {
            return;
        }
        let project = match load_project(&file) {
            Ok(p) => p,
            Err(e) => return self.fail(&file, &e),
        };
        let parent = file.parent().map(Path::to_path_buf).unwrap_or_default();
        let name = ds(&project["project"], "name");
        let out_dir =
            absolute(&out.unwrap_or_else(|| parent.join("generated").join(snake(&dependency_name(&name)))));
        let r = (|| -> Result<(), String> {
            let label = relative(&out_dir);
            let dir =
                FsDir { root: out_dir.clone(), label: if label.is_empty() { ".".into() } else { label } };
            let chosen = ds(&project["generation"], "templates");
            if !chosen.is_empty() && !is_template_set(&chosen) {
                eprintln!(
                    "{}: warning: unknown template set '{chosen}', {DEFAULT_TEMPLATE_SET} used",
                    relative(&file)
                );
            }
            let set = match &self.args.templates {
                Some(t) => templates_arg(t)?,
                None => template_set_for(&dir, || {
                    builtin(if is_template_set(&chosen) { &chosen } else { DEFAULT_TEMPLATE_SET })
                })?,
            };
            let (arena, root) = build_context(&project);
            let ctx = node::value(&Arc::new(arena), root);
            self.generate(&ctx, &set, &dir, &relative(&file))
        })();
        if let Err(e) = r {
            self.fail(&file, &e);
        }
        // Next to the project's directory, where its CMakeLists.txt looks for them.
        if self.args.deps {
            let siblings = out_dir.parent().map(Path::to_path_buf).unwrap_or_default();
            for d in dl(&project, "dependencies") {
                self.run(absolute(&parent.join(ds(d, "file"))), Some(siblings.join(snake(&ds(d, "name")))));
            }
        }
    }
}

fn main() -> ExitCode {
    let args = Args::parse();
    if args.version {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    // Rendering of a context dumped by the TypeScript generator (parity checks).
    if let Some(c) = &args.context {
        let r = (|| -> Result<bool, String> {
            let text = std::fs::read_to_string(c).map_err(|e| e.to_string())?;
            let json: Json = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            let out = args.out.as_deref().ok_or("-o is needed with --context")?;
            let dir = FsDir { root: PathBuf::from(out), label: out.to_string() };
            let set = match &args.templates {
                Some(t) => templates_arg(t)?,
                None => template_set_for(&dir, || Err("no template set: give one with -t".into()))?,
            };
            let mut run = Run { args: &args, done: HashSet::new(), failed: false };
            run.generate(&minijinja::Value::from(minijinja::value::Serde(json)), &set, &dir, c)?;
            Ok(!run.failed)
        })();
        return match r {
            Ok(true) => ExitCode::SUCCESS,
            Ok(false) => ExitCode::FAILURE,
            Err(e) => {
                eprintln!("{c}: error: {e}");
                ExitCode::FAILURE
            }
        };
    }
    let Some(file) = &args.file else {
        eprintln!("Usage: scaffold-gen <project file> [options]   (--help for the options)");
        return ExitCode::from(2);
    };
    if args.dump_context {
        return match load_project(Path::new(file)) {
            Ok(p) => {
                let (arena, root) = build_context(&p);
                println!("{}", serde_json::to_string(&arena.to_json(root)).unwrap_or_default());
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("{file}: error: {e}");
                ExitCode::FAILURE
            }
        };
    }
    let mut run = Run { args: &args, done: HashSet::new(), failed: false };
    run.run(absolute(Path::new(file)), args.out.as_ref().map(|o| absolute(Path::new(o))));
    if run.failed { ExitCode::FAILURE } else { ExitCode::SUCCESS }
}
