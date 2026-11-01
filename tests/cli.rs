// The command line over the repository's files: error messages of broken projects
// (tests/errors/*.expected), and every example generated with every built-in template set.
use std::path::PathBuf;
use std::process::Command;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn generator() -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_scaffold-gen"));
    c.current_dir(root());
    c
}

fn files(dir: &str, suffix: &str) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(root().join(dir))
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.ends_with(suffix))
        .map(|n| format!("{dir}/{n}"))
        .collect();
    v.sort();
    v
}

#[test]
fn error_messages() {
    let cases = files("tests/errors", ".scaffold.yaml");
    assert!(!cases.is_empty());
    let mut failed = vec![];
    for f in &cases {
        let out = generator().args(["--dump-context", f]).output().unwrap();
        let expected =
            std::fs::read_to_string(root().join(f.replace(".scaffold.yaml", ".expected"))).unwrap();
        let got = String::from_utf8_lossy(&out.stderr);
        if out.status.success() || got.trim_end() != expected.trim_end() {
            failed.push(format!("{f}:\n  expected: {}\n  got:      {}", expected.trim_end(), got.trim_end()));
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}

#[test]
fn examples_generate_with_every_set() {
    let mut projects = files("examples", ".scaffold.yaml");
    projects.extend(files("examples/fleet", ".scaffold.yaml"));
    projects.extend(files("examples/idl", ".scaffold.yaml"));
    projects.extend(files("examples/idl", ".idl"));
    projects.extend(files("tests/fixtures", ".scaffold.yaml"));
    let work = std::env::temp_dir().join(format!("scaffold-gen-test-{}", std::process::id()));
    let mut failed = vec![];
    for set in ["cpp17", "cpp20", "cpp14", "cpp11", "cpp98", "python", "sca-cpp98"] {
        for p in &projects {
            let out_dir = work.join(set).join(p.replace('/', "_"));
            let first = generator().args([p, "-t", set, "-o"]).arg(&out_dir).output().unwrap();
            if !first.status.success() {
                failed.push(format!("{set} {p}: {}", String::from_utf8_lossy(&first.stderr)));
                continue;
            }
            // Generating again changes nothing.
            let again = generator().args([p, "-t", set, "-o"]).arg(&out_dir).output().unwrap();
            let report = String::from_utf8_lossy(&again.stdout);
            if !again.status.success() || !report.contains(" 0 written, ") {
                failed.push(format!("{set} {p}: generated again: {report}"));
            }
        }
    }
    let _ = std::fs::remove_dir_all(&work);
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}
