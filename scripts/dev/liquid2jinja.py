#!/usr/bin/env python3
"""Converts a Liquid template set of the TypeScript generator to Jinja (minijinja), output identical.

    scripts/dev/liquid2jinja.py templates/cpp17 build/j2/cpp17

Partials (`_x.liquid`, rendered with `render '_x', a: v`) become macros `x` in `_x.j2`, imported
as `_x` and called `{{ _x(a=v) }}`. Variables assigned inside loops and used outside go through a
namespace (`ns.var`): Jinja's loops do not leak their assignments. Liquid's line trimming
(trimTagLines) is Jinja's trim_blocks + lstrip_blocks, with `+` where they differ.
Bare conditions on values Liquid finds true and Jinja false ('' / 0 / []) are reported.
"""
import os
import re
import sys

RENAME = {'self': 'self_', 'loop': 'loop_', 'caller': 'caller_', 'super': 'super_', 'range': 'range_',
          'namespace': 'namespace_', 'dict': 'dict_', 'kwargs': 'kwargs_', 'varargs': 'varargs_',
          'ns': 'ns_', 'true': 'true', 'false': 'false'}
# Jinja finds the methods of dicts before their keys: `x.values` is read as `x['values']`
DICT_METHODS = {'clear', 'copy', 'fromkeys', 'get', 'items', 'keys', 'pop', 'popitem', 'setdefault', 'update', 'values'}
CASE_FILTERS = {'snake', 'kebab', 'constant', 'pascal', 'camel', 'ucfirst', 'lcfirst', 'uuid'}

warnings = []


def warn(where, msg):
    warnings.append(f'{where}: {msg}')


# ---------------------------------------------------------------- expressions ----

TOK = re.compile(r"""\s*(?:
    (?P<str>'[^']*'|"[^"]*")
  | (?P<num>-?\d+(?:\.\d+)?)
  | (?P<range>\.\.)
  | (?P<op>==|!=|<=|>=|<|>)
  | (?P<punct>[|:,()\[\].])
  | (?P<name>[A-Za-z_][\w-]*\??)
)""", re.X)


def tokenize(s):
    toks, i = [], 0
    s = s.strip()
    while i < len(s):
        m = TOK.match(s, i)
        if not m or m.end() == i:
            raise ValueError(f'cannot read expression {s!r} at {s[i:]!r}')
        kind = m.lastgroup
        toks.append((kind, m.group(kind)))
        i = m.end()
        while i < len(s) and s[i].isspace():
            i += 1
    return toks


class Expr:
    """Liquid expression parser producing Jinja text."""

    def __init__(self, text, ctx):
        self.t = tokenize(text)
        self.i = 0
        self.ctx = ctx

    def peek(self, k=0):
        return self.t[self.i + k] if self.i + k < len(self.t) else (None, None)

    def take(self, value=None):
        tok = self.peek()
        if value is not None and tok[1] != value:
            raise ValueError(f'expected {value!r}, got {tok!r} in {self.t}')
        self.i += 1
        return tok

    def at_end(self):
        return self.i >= len(self.t)

    # value with filters
    def filtered(self):
        e = self.primary()
        while self.peek()[1] == '|':
            self.take('|')
            name = self.take()[1]
            args = []
            if self.peek()[1] == ':':
                self.take(':')
                args.append(self.primary_with_kw())
                while self.peek()[1] == ',':
                    self.take(',')
                    args.append(self.primary_with_kw())
            e = self.filter(e, name, args)
        return e

    def primary_with_kw(self):
        # `key: value` arguments are not used by the templates
        return self.primary()

    def primary(self):
        kind, v = self.peek()
        if kind == 'str':
            self.take()
            return v
        if kind == 'num':
            self.take()
            return v
        if v == '(':
            self.take('(')
            a = self.primary()
            self.take('..')
            b = self.primary()
            self.take(')')
            return f'range({a}, {b} + 1)'
        if kind == 'name':
            if v == 'nil':
                self.take()
                return 'none'
            if v in ('true', 'false'):
                self.take()
                return v
            if v in ('empty', 'blank'):
                self.take()
                return '__EMPTY__'
            return self.path()
        raise ValueError(f'unexpected {v!r} in {self.t}')

    def path(self):
        name = self.take()[1]
        if name == 'forloop':
            name = 'loop'
        else:
            name = self.ctx.var(name)
        e = name
        while True:
            if self.peek()[1] == '.' and self.peek(1)[0] == 'name':
                self.take('.')
                attr = self.take()[1]
                if attr == 'size' and not (e == 't' or e.endswith('.t')):
                    e = f'{e}|length'
                elif attr == 'first' and name != 'loop':
                    e = f'{e}|first'
                elif attr == 'last' and name != 'loop':
                    e = f'{e}|last'
                elif attr in DICT_METHODS:
                    e = f"{e}['{attr}']"
                else:
                    e = f'{e}.{attr}'
            elif self.peek()[1] == '[':
                self.take('[')
                inner = self.filtered()
                self.take(']')
                e = f'{e}[{inner}]'
            else:
                return e

    def filter(self, e, name, args):
        a = args
        if name == 'append':
            return f'{e} ~ {par(a[0])}'
        if name == 'prepend':
            return f'{par(a[0])} ~ {e}'
        if name in CASE_FILTERS:
            return f'{par(e)}|{name}'
        if name == 'doc_comment':
            return f'{par(e)}|doc_comment({a[0]})' if a else f'{par(e)}|doc_comment'
        if name == 'replace':
            return f'{par(e)}|replace({a[0]}, {a[1]})'
        if name == 'remove_first':
            return f"{par(e)}|replace({a[0]}, '', 1)"
        if name == 'remove_last':
            return f"{par(e)}.rsplit({a[0]}, 1)|join('')"
        if name == 'split':
            return f'{par(e)}|split({a[0]})'
        if name == 'where':
            if len(a) == 1:
                return f'{par(e)}|selectattr({a[0]})'
            if a[1] == 'none':
                return f"{par(e)}|selectattr({a[0]}, 'none')"
            return f"{par(e)}|selectattr({a[0]}, 'equalto', {a[1]})"
        if name == 'default':
            return f'{par(e)}|default({a[0]}, true)'
        if name == 'first':
            return f'{par(e)}|first'
        if name == 'last':
            return f'{par(e)}|last'
        if name == 'size':
            return f'{par(e)}|length'
        if name == 'plus':
            return f'({e} + {a[0]})'
        if name == 'minus':
            return f'({e} - {a[0]})'
        if name == 'times':
            return f'({e} * {a[0]})'
        if name == 'divided_by':
            # JS numbers print without '.0': 5000 / 1000.0 -> 5
            return f"'%.12g'|format({e} / {a[0]})" if '.' in a[0] else f'({e} // {a[0]})'
        if name == 'modulo':
            return f'({e} % {a[0]})'
        if name == 'map':
            return f'{par(e)}|map(attribute={a[0]})'
        if name == 'uniq':
            return f'{par(e)}|unique|list'
        if name == 'sort':
            return f'{par(e)}|sort'
        if name == 'concat':
            return f'({e} + {a[0]})'
        if name == 'escape':
            return f'{par(e)}|escape|string'
        if name == 'rstrip':
            return f'{par(e)}.rstrip()'
        if name == 'strip':
            return f'{par(e)}|trim'
        if name == 'downcase':
            return f'{par(e)}|lower'
        if name == 'upcase':
            return f'{par(e)}|upper'
        if name == 'join':
            return f'{par(e)}|join({a[0]})'
        if name == 'slice':
            start = a[0]
            n = a[1] if len(a) > 1 else '1'
            return f'{par(e)}[{start}:{start} + {n}]'
        raise ValueError(f'unknown filter {name}')

    # conditions: comparisons joined by and / or, evaluated right to left as Liquid does
    def condition(self):
        left = self.comparison()
        if self.peek()[1] in ('and', 'or'):
            op = self.take()[1]
            right = self.condition()
            return f'{left} {op} {par_cond(right)}'
        return left

    def comparison(self):
        a = self.filtered()
        kind, v = self.peek()
        if kind == 'op':
            self.take()
            b = self.filtered()
            if b == '__EMPTY__':
                return f'{par(a)}|length {v} 0' if v in ('==', '!=') else a
            return f'{a} {v} {b}'
        if v == 'contains':
            self.take()
            b = self.filtered()
            return f'{b} in {par(a)}'
        self.ctx.bare(a)
        return a


def top_level_space(e):
    """Whether e holds a space outside quotes, parentheses and brackets."""
    depth, q = 0, None
    for ch in e:
        if q:
            if ch == q:
                q = None
        elif ch in '\'"':
            q = ch
        elif ch in '([':
            depth += 1
        elif ch in ')]':
            depth -= 1
        elif ch == ' ' and depth == 0:
            return True
    return False


def par(e):
    """Parenthesized when not a single operand (a filter chain on a value is one)."""
    return f'({e})' if top_level_space(e) else e


def par_cond(e):
    return f'({e})' if re.search(r'\s(and|or)\s', e) else e


def expr(text, ctx):
    p = Expr(text, ctx)
    e = p.filtered()
    if not p.at_end():
        raise ValueError(f'trailing tokens in {text!r}: {p.t[p.i:]}')
    return e


def cond(text, ctx):
    p = Expr(text, ctx)
    e = p.condition()
    if not p.at_end():
        raise ValueError(f'trailing tokens in {text!r}: {p.t[p.i:]}')
    return e


# ------------------------------------------------------------------- context ----

class Ctx:
    def __init__(self, where, partials, params, ns_vars):
        self.where = where
        self.partials = partials
        self.params = params
        self.ns_vars = ns_vars
        self.used = set()

    def var(self, name):
        name = RENAME.get(name, name)
        if name in self.ns_vars:
            return f'ns.{name}'
        return name

    def bare(self, e):
        # values Liquid finds true and Jinja false: text, numbers, lists
        if e.startswith('loop.') or e in ('true', 'false', 'none'):
            return
        last = e.split('.')[-1].split('|')[0]
        if last in ('description', 'name', 'value', 'default', 'label', 'labels', 'params', 'inputs',
                    'outputs', 'ports', 'fields', 'cases', 'values', 'flags', 'messages', 'children',
                    'instances', 'connections', 'delegates', 'types', 'methods', 'attributes', 'bases',
                    'proxies', 'stubs', 'external', 'options', 'via', 'scope', 'namespace', 'host', 'port',
                    'path', 'topic', 'socket', 'device', 'raises', 'builtins', 'files', 'max', 'size', 'id',
                    'index', 'bit', 'capacity', 'baud', 'transport', 'metadata', 'color'):
            warn(self.where, f'bare condition on {e!r}: Liquid holds it true for empty text, 0 and empty lists')


# ------------------------------------------------------------------- templates ----

TAG = re.compile(r'(\{%-?\s*comment\s*-?%\}.*?\{%-?\s*endcomment\s*-?%\}|\{%-?.*?-?%\}|\{\{-?.*?-?\}\})', re.S)


def split_tag(tok):
    open_, close = tok[:2], tok[-2:]
    body = tok[2:-2]
    lm = rm = ''
    if body.startswith('-'):
        lm, body = '-', body[1:]
    if body.endswith('-'):
        rm, body = '-', body[:-1]
    return open_, lm, body.strip(), rm, close


def render_args(text, ctx):
    """`'_x', a: v, b: w` -> ('_x', [(a, v), ...])"""
    m = re.match(r"\s*'([^']+)'\s*,?\s*(.*)$", text, re.S)
    if not m:
        raise ValueError(f'render without a name: {text!r}')
    name, rest = m.group(1), m.group(2)
    args = []
    for part in split_top(rest, ','):
        part = part.strip()
        if not part:
            continue
        k, _, v = part.partition(':')
        args.append((k.strip(), expr(v, ctx)))
    return name, args


def split_top(s, sep):
    out, depth, cur, q = [], 0, '', None
    for ch in s:
        if q:
            cur += ch
            if ch == q:
                q = None
            continue
        if ch in '\'"':
            q = ch
        elif ch in '([':
            depth += 1
        elif ch in ')]':
            depth -= 1
        if ch == sep and depth == 0:
            out.append(cur)
            cur = ''
        else:
            cur += ch
    out.append(cur)
    return out


def call_text(name, args, self_name):
    mac = name.lstrip('_')
    target = mac if name == self_name else name
    return f"{target}({', '.join(f'{k}={v}' for k, v in args)})"


class Converter:
    def __init__(self, files, params, trim):
        self.files = files
        self.params = params
        self.trim = trim

    def statement(self, word, rest, ctx, self_name):
        """A Liquid statement -> ('block', text) / ('value', expr) / ('skip', None)."""
        if word == 'if':
            return 'block', f'if {cond(rest, ctx)}'
        if word == 'elsif':
            return 'block', f'elif {cond(rest, ctx)}'
        if word == 'unless':
            c = cond(rest, ctx)
            return 'block', f'if not {par_cond_not(c)}'
        if word in ('else', 'endif', 'endfor', 'break', 'continue'):
            return 'block', word
        if word == 'endunless':
            return 'block', 'endif'
        if word == 'case':
            ctx.case.append(expr(rest, ctx))
            ctx.case_first.append(True)
            return 'skip', None
        if word == 'when':
            subject = ctx.case[-1]
            values = [expr(v, ctx) for v in re.split(r'\s*,\s*|\s+or\s+', rest.strip())]
            test = ' or '.join(f'{subject} == {v}' for v in values)
            first = ctx.case_first[-1]
            ctx.case_first[-1] = False
            return 'block', ('if ' if first else 'elif ') + test
        if word == 'endcase':
            ctx.case.pop()
            first = ctx.case_first.pop()
            return ('skip', None) if first else ('block', 'endif')
        if word == 'for':
            m = re.match(r'(\w+)\s+in\s+(.*?)(?:\s+(limit|offset):\s*(\S+))?(?:\s+(limit|offset):\s*(\S+))?\s*$', rest)
            var, src = m.group(1), m.group(2)
            opts = {}
            for k, v in ((m.group(3), m.group(4)), (m.group(5), m.group(6))):
                if k:
                    opts[k] = expr(v, ctx)
            src = expr(src, ctx)
            if var in ctx.pair_vars:
                # Liquid iterates a hash as [key, value] pairs
                src = f'{par(src)}.items()'
            if opts:
                off = opts.get('offset', '0')
                end = f"{off} + {opts['limit']}" if 'limit' in opts else ''
                src = f'{par(src)}[{off if off != "0" else ""}:{end}]'
            ctx.loop_vars.append(var)
            return 'block', f'for {ctx.var(var)} in {src}'
        if word == 'assign':
            name, _, value = rest.partition('=')
            return 'block', f'set {ctx.var(name.strip())} = {expr(value, ctx)}'
        if word == 'capture':
            name = rest.strip()
            target = ctx.var(name)
            if target.startswith('ns.'):
                ctx.captures.append(target)
                return 'block', f'set __capture'
            ctx.captures.append(None)
            return 'block', f'set {target}'
        if word == 'endcapture':
            target = ctx.captures.pop()
            if target:
                return 'block', f'endset %}}{{% set {target} = __capture'
            return 'block', 'endset'
        if word == 'echo':
            return 'value', expr(rest, ctx)
        if word == 'render':
            name, args = render_args(rest, ctx)
            ctx.used.add(name)
            return 'value', call_text(name, args, self_name)
        if word == 'include':
            name, args = render_args(rest, ctx)
            if args:
                sets = ', '.join(f'{k} = {v}' for k, v in args)
                return 'block', f"with {sets} %}}{{% include '{name}.j2' %}}{{% endwith"
            return 'block', f"include '{name}.j2'"
        if word == 'user':
            return 'block', f'filter user({expr(rest, ctx)})'
        if word == 'enduser':
            return 'block', 'endfilter'
        raise ValueError(f'unknown tag {word!r}')

    def convert(self, name, src, self_name=None, ns_vars=()):
        """Jinja text of a Liquid template whose output is the same, whitespace included."""
        ctx = Ctx(name, None, None, set(ns_vars))
        ctx.case, ctx.case_first, ctx.captures, ctx.loop_vars = [], [], [], []
        ctx.pair_vars = {v for v in re.findall(r'\bfor\s+(\w+)\s+in\b', src) if re.search(r'\b' + v + r'\[[01]\]', src)}
        trim = self.trim
        # Lines TS's trimTagLines empties: a single-line `{% %}` tag alone on its line (user tags excepted).
        standalone = set()
        if trim:
            for m in re.finditer(r'^[ \t]*(\{%-?(?![ \t]*(?:user|enduser)\b)(?:(?!%\})[^\n])*%\})[ \t]*\r?\n', src, re.M):
                standalone.add(m.start(1))
        # tokens: ('text', s) / ('tag', dict)
        toks = []
        pos = 0
        for m in TAG.finditer(src):
            toks.append(('text', src[pos:m.start()]))
            pos = m.end()
            tok = m.group(0)
            t = {'start': m.start(), 'end': m.end()}
            if tok.startswith('{%') and re.match(r'\{%-?\s*comment\b', tok):
                close = re.search(r'\{%-?\s*endcomment\s*-?%\}$', tok)
                t['liquid_left'] = (m.start() in standalone, tok[2] == '-')
                t['liquid_right'] = (m.start() + close.start() in standalone, tok.endswith('-%}'))
                inner = tok[re.match(r'\{%-?\s*comment\s*-?%\}', tok).end():close.start()]
                t['jinja'] = [('comment', inner.replace('#}', '# }'))]
                toks.append(('tag', t))
                continue
            open_, lm, body, rm, close = split_tag(tok)
            t['liquid_left'] = (m.start() in standalone, lm == '-')
            t['liquid_right'] = (m.start() in standalone, rm == '-')
            if open_ == '{{':
                x = expr(body, ctx)
                if re.search(r'\.(required)$', x):  # booleans print as JS does: true / false
                    x += '|lower'
                t['jinja'] = [('expr', x)]
                toks.append(('tag', t))
                continue
            word = body.split(None, 1)[0] if body else ''
            rest = body.split(None, 1)[1] if len(body.split(None, 1)) > 1 else ''
            if word.startswith('#'):
                t['jinja'] = [('comment', ' ' + body[1:].strip() + ' ')]
            elif word == 'liquid':
                items = []
                for line in body[len('liquid'):].split('\n'):
                    stripped = line.strip()
                    if not stripped:
                        continue
                    indent = re.match(r'[ \t]*', line).group(0)
                    if stripped.startswith('#'):
                        items.append(('comment', ' ' + stripped[1:].strip() + ' ', indent))
                        continue
                    w = stripped.split(None, 1)[0]
                    r = stripped.split(None, 1)[1] if len(stripped.split(None, 1)) > 1 else ''
                    kind, text = self.statement(w, r, ctx, self_name)
                    if kind != 'skip':
                        items.append(('expr' if kind == 'value' else 'block', text, indent))
                base = min((len(x[2]) for x in items), default=0)
                t['jinja'] = [(k, x, ind[base:]) for k, x, ind in items]
                t['multiline'] = True
            else:
                kind, text = self.statement(word, rest, ctx, self_name)
                if kind == 'skip':
                    t['jinja'] = []
                else:
                    t['jinja'] = [('expr' if kind == 'value' else 'block', text)]
            toks.append(('tag', t))
        toks.append(('text', src[pos:]))

        # Liquid's output of each text: TS's trimTagLines, then liquidjs' non-greedy trimming.
        def liquid_text(i):
            x = toks[i][1]
            if i > 0:
                st, dash = toks[i - 1][1]['liquid_right']
                if st:
                    x = re.sub(r'^[ \t]*\r?\n', '', x, count=1)
                if dash:
                    x = re.sub(r'^[ \t]*', '', x, count=1)
                    if x.startswith('\n'):
                        x = x[1:]
            if i < len(toks) - 1:
                st, dash = toks[i + 1][1]['liquid_left']
                if st:
                    x = re.sub(r'[ \t]*$', '', x, count=1)
                if dash:
                    x = re.sub(r'[ \t]*$', '', x, count=1)
            return x

        # An empty tag (case) vanishes: its texts join.
        merged = []
        for kind, v in toks:
            if kind == 'tag' and not v['jinja']:
                merged.append(('empty', v))
            else:
                merged.append((kind, v))
        # Liquid texts computed on the original token list
        ltext = {i: liquid_text(i) for i, (k, _) in enumerate(toks) if k == 'text'}
        # rebuild: text / tag / text ..., joining the texts around empty tags
        seq = []
        for i, (kind, v) in enumerate(merged):
            if kind == 'text':
                if seq and seq[-1][0] == 'text':
                    seq[-1] = ('text', seq[-1][1] + v, seq[-1][2] + ltext[i])
                else:
                    seq.append(('text', v, ltext[i]))
            elif kind == 'empty':
                continue
            else:
                seq.append(('tag', v))

        # Jinja side kinds of each tag: block / expr (comments are blocks for trimming)
        def side(t, which):
            items = t['jinja']
            k = items[0][0] if which == 'left' else items[-1][0]
            return 'expr' if k == 'expr' else 'block'

        def jinja_text(x, right_of, left_of, at_start):
            """Output of the source text x between a tag side (right_of: kind, marker) and
            (left_of: kind, marker): each trims its end of the source text."""
            head = 0
            if right_of:
                k, mk = right_of
                if mk == '-':
                    head = len(x) - len(x.lstrip(' \t\n\r'))
                elif k == 'block' and mk == '' and trim and x.startswith('\n'):
                    head = 1
            tail = 0
            if left_of:
                k, mk = left_of
                if mk == '-':
                    tail = len(x) - len(x.rstrip(' \t\n\r'))
                elif k == 'block' and mk == '' and trim:
                    line = x.rsplit('\n', 1)
                    if (len(line) == 2 or at_start) and re.fullmatch(r'[ \t]*', line[-1]):
                        tail = len(line[-1])
            return x[head:max(head, len(x) - tail)]

        RIGHT = {'block': ['', '-', '+'], 'expr': ['', '-', 'c']}
        LEFT = {'block': ['', '-', '+'], 'expr': ['', '-', 'c']}
        cost = {'': 0, '-': 1, '+': 1, 'c': 2}
        marks = {}  # (tag index, 'left'/'right') -> marker
        for i, item in enumerate(seq):
            if item[0] != 'text':
                continue
            x, target = item[1], item[2]
            prev = seq[i - 1][1] if i > 0 else None
            nxt = seq[i + 1][1] if i + 1 < len(seq) else None
            at_start = i == 0
            rk = side(prev, 'right') if prev else None
            lk = side(nxt, 'left') if nxt else None
            best = None
            for candidate in (x, target):
                for rm in (RIGHT[rk] if rk else [None]):
                    for lm in (LEFT[lk] if lk else [None]):
                        r_of = None if rk is None else (('block' if rm == 'c' else rk), '' if rm == 'c' else rm)
                        l_of = None if lk is None else (('block' if lm == 'c' else lk), '' if lm == 'c' else lm)
                        if jinja_text(candidate, r_of, l_of, at_start) == target:
                            c = (candidate is not x) * 10 + cost.get(rm, 0) + cost.get(lm, 0)
                            if best is None or c < best[0]:
                                best = (c, candidate, rm, lm)
                if best:
                    break
            if best is None:
                raise ValueError(f'{name}: no Jinja form for text {x!r} -> {target!r}')
            _, chosen, rm, lm = best
            seq[i] = ('text', chosen, target)
            if prev:
                marks[(i - 1, 'right')] = rm
            if nxt:
                marks[(i + 1, 'left')] = lm

        # assemble
        out = []
        for i, item in enumerate(seq):
            if item[0] == 'text':
                out.append(item[1])
                continue
            t = item[1]
            lmark = marks.get((i, 'left'), '')
            rmark = marks.get((i, 'right'), '')
            items = t['jinja']
            parts = []
            for k, it in enumerate(items):
                kind, text = it[0], it[1]
                pad = it[2] if len(it) > 2 and k > 0 else ''
                l = lmark if k == 0 else '-'
                r = rmark if k == len(items) - 1 else '-'
                pre = post = ''
                if kind == 'expr':
                    if l == 'c':
                        pre, l = '{##}', ''
                    if r == 'c':
                        post, r = '{##}', ''
                    parts.append(pad + pre + '{{' + l + ' ' + text + ' ' + r + '}}' + post)
                elif kind == 'comment':
                    parts.append(pad + '{#' + l + text + r + '#}')
                else:
                    parts.append(pad + '{%' + l + ' ' + text + ' ' + r + '%}')
            out.append(('\n' if t.get('multiline') else '').join(parts))
        return ''.join(out), ctx.used


def par_cond_not(c):
    return f'({c})' if re.search(r'\s(and|or|==|!=|<|>|in)\s', c) else c


def statements_of(src):
    """Liquid statements of a template, in order: (word, rest) - tags and lines of liquid blocks."""
    for m in TAG.finditer(src):
        tok = m.group(0)
        if tok.startswith('{{'):
            yield 'output', tok[2:-2].strip('-')
            continue
        body = tok[2:-2].strip('-').strip()
        word = body.split(None, 1)[0] if body else ''
        if word == 'comment':
            continue
        if word == 'liquid':
            for line in body[len('liquid'):].split('\n'):
                line = line.strip()
                if line and not line.startswith('#'):
                    yield line.split(None, 1)[0], (line.split(None, 1) + [''])[1]
        else:
            yield word, (body.split(None, 1) + [''])[1]


NAME_RE = re.compile(r'(?<![\w.\'"])([A-Za-z_]\w*)')


def names_in(text):
    return set(NAME_RE.findall(re.sub(r"'[^']*'|\"[^\"]*\"", '', text)))


def ns_vars_of(src):
    """Variables assigned inside a for loop and also assigned or read outside that loop (Jinja's
    loops keep their assignments): they go through a namespace."""
    stack = []          # ids of the open loops
    next_id = 0
    assigned = {}       # name -> set of innermost loop ids (None: outside loops)
    reads = []          # (name, tuple of open loop ids)
    loop_vars = set()
    for word, rest in statements_of(src):
        if word == 'for':
            var, _, source = rest.partition(' in ')
            loop_vars.add(var.strip())
            for n in names_in(source):
                reads.append((n, tuple(stack)))
            next_id += 1
            stack.append(next_id)
            continue
        if word == 'endfor':
            stack.pop()
            continue
        if word in ('assign', 'capture'):
            name, _, value = rest.strip().partition('=')
            name = re.split(r'\s', name.strip(), 1)[0]
            assigned.setdefault(name, set()).add(stack[-1] if stack else None)
            for n in names_in(value):
                reads.append((n, tuple(stack)))
            continue
        for n in names_in(rest):
            reads.append((n, tuple(stack)))
    out = set()
    for name, loops in assigned.items():
        inner = {l for l in loops if l is not None}
        if not inner or name in loop_vars:
            continue
        # assigned elsewhere than in one loop, or read outside a loop it is assigned in
        if len(loops) > 1 or any(not set(inner) <= set(at) for n, at in reads if n == name):
            out.add(name)
    return {RENAME.get(n, n) for n in out}


def prelude(tags, body):
    """Tags (imports...) before a body, outputting nothing: one per line, the newline after each
    trimmed; on one line when the body starts with a newline (the last tag keeps it)."""
    if body.startswith('\n'):
        return ''.join(tags[:-1]) + tags[-1][:-2] + '+%}' + body
    return '\n'.join(tags) + '\n' + body


def main():
    src_dir, dst_dir = sys.argv[1], sys.argv[2]
    os.makedirs(dst_dir, exist_ok=True)
    files = {f: open(os.path.join(src_dir, f)).read() for f in os.listdir(src_dir) if f.endswith('.liquid')}
    manifest = open(os.path.join(src_dir, 'manifest.yaml')).read()
    trim = not re.search(r'^trimTagLines:\s*false', manifest, re.M)
    # macro parameters: the names passed by every render of each partial
    params = {}
    for s in list(files.values()) + [manifest]:
        for m in re.finditer(r"render\s+'(_[\w]+)'\s*,?([^%\n]*)", s):
            names = params.setdefault(m.group(1), [])
            for part in split_top(m.group(2), ','):
                k = part.split(':')[0].strip()
                if k and k not in names and re.fullmatch(r'\w+', k):
                    names.append(k)
    conv = Converter(files, params, trim)
    partial_names = {f[:-7] for f in files if f.startswith('_')}
    for f, s in sorted(files.items()):
        base = f[:-7]
        ns = ns_vars_of(s)
        try:
            if base in params:
                # a rendered partial: a macro, importing what it uses when called (partials may
                # use each other: imports at the top would be circular)
                body, used = conv.convert(f, s, self_name=base, ns_vars=ns)
                mac = base.lstrip('_')
                sig = ', '.join(f'{p}=none' for p in params[base])
                tags = [f"{{% from '{u}.j2' import {u.lstrip('_')} as {u} %}}" for u in sorted(used) if u != base]
                if ns:
                    tags.append('{% set ns = namespace() %}')
                text = prelude([f'{{% macro {mac}({sig}) %}}'] + tags, body)
                text += ('{%+ endmacro %}' if re.search(r'\s$', body) else '\n{%- endmacro %}') + '\n'
            else:
                body, used = conv.convert(f, s, ns_vars=ns)
                tags = [f"{{% from '{u}.j2' import {u.lstrip('_')} as {u} %}}" for u in sorted(used)]
                if ns:
                    tags.append('{% set ns = namespace() %}')
                text = prelude(tags, body) if tags else body
        except Exception as e:  # noqa: BLE001
            print(f'{f}: {e}', file=sys.stderr)
            raise
        with open(os.path.join(dst_dir, base + '.j2'), 'w') as out:
            out.write(text)
    # manifest
    def m_tpl(m):
        return m.group(1) + m.group(2)[:-len('.liquid')] + '.j2'
    manifest = re.sub(r'^(\s*(?:-\s+)?(?:template:\s*)?)(\S+\.liquid)\s*$', m_tpl, manifest, flags=re.M)

    def m_field(m):
        key, q, val = m.group(1), m.group(2), m.group(3)
        if key == 'path':
            body, used = conv.convert('manifest path', val)
            imports = ''.join(f"{{% from '{u}.j2' import {u.lstrip('_')} as {u} %}}" for u in sorted(used))
            val = imports + body
        elif key == 'when':
            val = cond(val, Ctx('manifest when', None, None, set()))
        elif key == 'each':
            val = expr(val, Ctx('manifest each', None, None, set()))
        if key == 'path':
            q = '"'
            val = val.replace('\\', '\\\\').replace('"', '\\"')
        return f'{m.group(0)[:m.start(2) - m.start(0)]}{q}{val}{q}'
    manifest = re.sub(r'^\s*-?\s*(path|when|each):\s*(["\']?)(.*?)\2\s*$', m_field, manifest, flags=re.M)
    with open(os.path.join(dst_dir, 'manifest.yaml'), 'w') as out:
        out.write(manifest)
    for w in warnings:
        print('warning:', w, file=sys.stderr)


if __name__ == '__main__':
    main()
