// `{% filter inline %}…{% endfilter %}`: the text of the block, in the template, is joined on one
// line. Each line break of the template text, with the spaces around it, is removed from the source
// before parsing (turned into a comment, so that error lines stay right); values are not touched.
// The filter itself returns its input.

/// The source of a template with the line breaks of its `inline` blocks removed.
pub fn inline_blocks(src: &str) -> String {
    if !src.contains("inline") {
        return src.to_string();
    }
    let b = src.as_bytes();
    let mut out = String::with_capacity(src.len());
    // Open filter blocks: true for an `inline` one.
    let mut filters: Vec<bool> = vec![];
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'{' && i + 1 < b.len() && matches!(b[i + 1], b'{' | b'%' | b'#') {
            let end = tag_end(b, i);
            let tag = &src[i..end];
            if b[i + 1] == b'%' {
                let mut words = tag[2..].trim_start_matches(['-', '+']).split_whitespace();
                match words.next() {
                    Some("filter") => filters.push(
                        words.next().is_some_and(|w| w.trim_end_matches(['-', '+', '%', '}']) == "inline"),
                    ),
                    Some("endfilter") => {
                        filters.pop();
                    }
                    _ => {}
                }
            }
            out.push_str(tag);
            i = end;
            continue;
        }
        if filters.contains(&true) && matches!(b[i], b' ' | b'\t' | b'\r' | b'\n') {
            // A run of blanks: removed when it holds a line break, its line breaks kept in comments.
            let start = i;
            while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\r' | b'\n') {
                i += 1;
            }
            let breaks = src[start..i].matches('\n').count();
            if breaks == 0 {
                out.push_str(&src[start..i]);
            } else {
                // A `{` before `{#` would open an expression.
                if out.ends_with('{') {
                    out.pop();
                    out.push_str("{{ '{' }}");
                }
                out.push_str("{#");
                out.push_str(&"\n".repeat(breaks));
                out.push_str("#}");
            }
            continue;
        }
        let ch = src[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// End (exclusive) of the tag, expression or comment starting at `i`; quoted strings skipped.
fn tag_end(b: &[u8], i: usize) -> usize {
    let close = match b[i + 1] {
        b'{' => b'}',
        b'%' => b'%',
        _ => b'#',
    };
    let mut j = i + 2;
    while j + 1 < b.len() {
        match b[j] {
            q @ (b'\'' | b'"') if close != b'#' => {
                j += 1;
                while j < b.len() && b[j] != q {
                    j += if b[j] == b'\\' { 2 } else { 1 };
                }
            }
            c if c == close && b[j + 1] == b'}' => return j + 2,
            _ => {}
        }
        j += 1;
    }
    b.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_text_lines() {
        let src = "a\n{% filter inline %}\n  {% if x %}\n    std::map<\n      int, {{ '}}' }}\n  {% endif %}\n{% endfilter %}\nb\n";
        assert_eq!(
            inline_blocks(src),
            "a\n{% filter inline %}{#\n#}{% if x %}{#\n#}std::map<{#\n#}int, {{ '}}' }}{#\n#}{% endif %}{#\n#}{% endfilter %}\nb\n"
        );
    }

    #[test]
    fn nested_and_braces() {
        let src = "{% filter inline %}\n{\n{% filter user('x') %}\n{% endfilter %}\n}\n{% endfilter %}\n{% filter upper %}\nc\n{% endfilter %}";
        assert_eq!(
            inline_blocks(src),
            "{% filter inline %}{#\n#}{{ '{' }}{#\n#}{% filter user('x') %}{#\n#}{% endfilter %}{#\n#}}{#\n#}{% endfilter %}\n{% filter upper %}\nc\n{% endfilter %}"
        );
    }

    #[test]
    fn renders_on_one_line() {
        let mut env = minijinja::Environment::new();
        env.add_filter("inline", |v: minijinja::Value| v);
        let src = "{% filter inline %}\n  [\n  {% for i in [1, 2] %}\n    {{ i }}{% if not loop.last %}, {% endif %}\n  {% endfor %}\n  ]\n{% endfilter %}\n";
        env.add_template_owned("t", inline_blocks(src)).unwrap();
        assert_eq!(env.get_template("t").unwrap().render(()).unwrap(), "[1, 2]");
    }
}
