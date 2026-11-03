// ANSI colors of the command line's output: on a terminal only, unless NO_COLOR is set
// (https://no-color.org) or FORCE_COLOR / CLICOLOR_FORCE asks for them anyway.
use std::io::IsTerminal;

#[derive(Clone, Copy, Default)]
pub struct Style {
    pub on: bool,
}

fn env_set(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|v| !v.is_empty() && v != "0")
}

impl Style {
    fn detect(terminal: bool) -> Style {
        let on = if env_set("NO_COLOR") {
            false
        } else {
            env_set("FORCE_COLOR") || env_set("CLICOLOR_FORCE") || terminal
        };
        Style { on }
    }
    pub fn stdout() -> Style {
        Style::detect(std::io::stdout().is_terminal())
    }
    pub fn stderr() -> Style {
        Style::detect(std::io::stderr().is_terminal())
    }

    fn paint(self, code: &str, s: &str) -> String {
        if self.on { format!("\x1b[{code}m{s}\x1b[0m") } else { s.to_string() }
    }
    pub fn bold(self, s: &str) -> String {
        self.paint("1", s)
    }
    pub fn dim(self, s: &str) -> String {
        self.paint("2", s)
    }
    pub fn red(self, s: &str) -> String {
        self.paint("1;31", s)
    }
    pub fn green(self, s: &str) -> String {
        self.paint("32", s)
    }
    pub fn yellow(self, s: &str) -> String {
        self.paint("33", s)
    }
    pub fn cyan(self, s: &str) -> String {
        self.paint("36", s)
    }
    /// `^~~~` marks under source lines.
    pub fn caret(self, s: &str) -> String {
        self.paint("1;32", s)
    }
    /// `error:` / `warning:` / `note:` prefixes of diagnostics.
    pub fn error(self) -> String {
        self.red("error:")
    }
    pub fn warning(self) -> String {
        self.paint("1;35", "warning:")
    }
    pub fn note(self) -> String {
        self.paint("1;90", "note:")
    }
}
