// Code generation from a project file: scaffold-gen <project file> [options]
mod codegen;
mod diagnostic;
mod model;
mod style;

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use clap::Parser;
use serde_json::Value as Json;

use codegen::builtin::{DEFAULT_TEMPLATE_SET, EMBEDDED, TEMPLATE_SETS, builtin, is_template_set};
use codegen::context::{build_context, dependency_name};
use codegen::filters::snake;
use codegen::node;
use codegen::run::{
    FsDir, ReportOptions, RunOptions, format_report, generate_into, read_or_none, template_set_for,
};
use codegen::template_set::{MANIFEST, TemplateSet, load_template_set};
use diagnostic::{Diagnostic, Level};
use model::load::{dl, ds, index_project, read_project};
use model::text::format_from_path;
use style::Style;

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
    /// Template set: a folder (holding a manifest.yaml), or, in builds embedding them, a built-in
    /// one: cpp17, cpp20, cpp14, cpp11, cpp98, python, sca-cpp98 (default: <out>/.scaffold/templates
    /// if present, else the project's generation.templates, else cpp17).
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
    /// Show the user sections carried over from the files already there, with their content.
    #[arg(short = 'k', long)]
    show_kept: bool,
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
/// `msg` as a diagnostic on stderr (`lines`: one for each of its lines, as the project's
/// problems are), `Line N: …` ones with that line of `text`.
fn print_diagnostics(path: &str, text: Option<&str>, level: Level, msg: &str, lines: bool) {
    let st = Style::stderr();
    let msgs: Vec<&str> = if lines { msg.lines().collect() } else { vec![msg] };
    for m in msgs {
        eprintln!("{}", Diagnostic::from_message(path, text, level, m).render(st));
    }
}

fn load_project(file: &Path) -> Result<Json, String> {
    let path = file.to_string_lossy();
    let text = std::fs::read_to_string(file).map_err(|_| "cannot read the file".to_string())?;
    let doc = if path.to_lowercase().ends_with(".idl") {
        // An IDL file stands for a project: its definitions, its includes as dependencies.
        let read = |p: &str| std::fs::read_to_string(p).ok();
        let files = model::idl::read_idl_includes(&path, &text, &read)?;
        let (value, warnings) = model::idl::idl_project(&path, &files)?;
        for w in warnings {
            print_diagnostics(&relative(file), Some(&text), Level::Warning, &w, false);
        }
        model::text::Doc { value, lines: model::text::Lines::None }
    } else {
        read_project(&text, format_from_path(&path))?
    };
    {
        let index = index_project(&doc.value, &doc.lines)?;
        let errors = model::validate::validate(&doc.value, &index);
        if !errors.is_empty() {
            return Err(errors.join("\n"));
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
        return Err(if EMBEDDED {
            format!(
                "templates '{arg}': neither a built-in set ({}) nor a folder holding a {MANIFEST}",
                TEMPLATE_SETS.join(", ")
            )
        } else {
            format!("templates '{arg}': not a folder holding a {MANIFEST}")
        });
    }
    load_template_set(|p| read_or_none(&dir.join(p)).ok().flatten())
}

struct Run<'a> {
    args: &'a Args,
    done: HashSet<PathBuf>,
    failed: bool,
}

impl Run<'_> {
    /// `lines`: the project's problems, one per line.
    fn fail(&mut self, file: &Path, e: &str, lines: bool) {
        let text = std::fs::read_to_string(file).ok();
        print_diagnostics(&relative(file), text.as_deref(), Level::Error, e, lines);
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
        println!(
            "{}",
            format_report(
                &report,
                &format!("{label} -> {}", dir.label),
                &dir.label,
                ReportOptions { written: true, kept: self.args.show_kept },
                Style::stdout()
            )
        );
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
            Err(e) => return self.fail(&file, &e, true),
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
            if EMBEDDED && self.args.templates.is_none() && !chosen.is_empty() && !is_template_set(&chosen) {
                let msg = format!("unknown template set '{chosen}', {DEFAULT_TEMPLATE_SET} used");
                eprintln!(
                    "{}",
                    Diagnostic::new(&relative(&file), Level::Warning, &msg).render(Style::stderr())
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
            self.fail(&file, &e, false);
        }
        // Next to the project's directory, where its CMakeLists.txt looks for them.
        if self.args.deps {
            let siblings = out_dir.parent().map(Path::to_path_buf).unwrap_or_default();
            for d in dl(&project, "dependencies") {
                let (name, dep) = (ds(d, "name"), absolute(&parent.join(ds(d, "file"))));
                // `_` has no words: it would be generated into the parent directory.
                let folder = snake(&name);
                if folder.is_empty() {
                    let e = format!(
                        "dependency '{name}': no folder name to generate it in (its name has no letter nor digit)"
                    );
                    self.fail(&file, &e, false);
                    continue;
                }
                self.run(dep, Some(siblings.join(folder)));
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
                print_diagnostics(c, None, Level::Error, &e, false);
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
                let text = std::fs::read_to_string(file).ok();
                print_diagnostics(file, text.as_deref(), Level::Error, &e, true);
                ExitCode::FAILURE
            }
        };
    }
    let mut run = Run { args: &args, done: HashSet::new(), failed: false };
    run.run(absolute(Path::new(file)), args.out.as_ref().map(|o| absolute(Path::new(o))));
    if run.failed { ExitCode::FAILURE } else { ExitCode::SUCCESS }
}
