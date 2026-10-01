// Import of OMG IDL files (IDL 4.2: CORBA, CCM, DDS / XTypes). A C-like preprocessor runs first
// (#include, #define, #if...; `import "file";` includes like #include), then the whole grammar is
// read: modules (template modules too), interfaces, valuetypes, eventtypes, components, connectors,
// porttypes, homes, structs, unions, enums, bitmasks, bitsets, exceptions, typedefs, constants and
// annotations. Modules are flattened: entities keep their simple name, qualified with their modules
// when two share it. Components and connectors become modules with ports. What the model cannot
// express is approximated or left out, and reported.
import { isReservedTypeName, mapTypeRef, walkTypeRef } from './typeExpr'
import { defaultSize, newId } from './project'
import { CLIP_FORMAT, type Clip } from './clipboard'
import type { FileInterface, FileMessage, FileTypeDef, FileTypeRef } from './schema'
import {
  INT_RANGES,
  type Field,
  type Id,
  type Interface,
  type IntPrimitive,
  type Message,
  type Module,
  type PortRole,
  type Project,
  type TypeDef,
  type TypeRef,
  type Value
} from './types'

export class IdlError extends Error {}

/** Port of a component, connector or porttype. */
export interface IdlPort {
  name: string
  role: PortRole
  /** Interface name; null when unknown. */
  interface: string | null
  description: string
}

export interface IdlAttribute {
  name: string
  type: FileTypeRef
  description: string
  readonly: boolean
}

/** CCM component or connector: a module with ports. */
export interface IdlComponent {
  name: string
  description: string
  /** Component it derives from. */
  bases: string[]
  attributes: IdlAttribute[]
  /** Operations of the interfaces it supports. */
  methods: FileMessage[]
  ports: IdlPort[]
  /** Types and interfaces it needs besides those its members reference. */
  needs: string[]
}

export interface IdlFile {
  types: FileTypeDef[]
  interfaces: FileInterface[]
  components: IdlComponent[]
  /**
   * Names each type or interface needs besides the types it references: raised exceptions,
   * interfaces of object references.
   */
  needs: Record<string, string[]>
  /** Included files found nowhere. */
  missing: string[]
  /** What was left out or approximated. */
  warnings: string[]
}

// Paths

/** `/`-separated path without `.` and `..` steps. */
function normalizePath(path: string): string {
  const out: string[] = []
  const parts = path.replace(/\\/g, '/').split('/')
  for (const [i, part] of parts.entries()) {
    if (part === '.' || (part === '' && i > 0)) continue
    if (part === '..' && out.length && out[out.length - 1] !== '..' && out[out.length - 1] !== '') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1)
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Where an include of `name` from file `from` may be: next to it, then in its ancestor folders. */
function includeCandidates(name: string, from: string): string[] {
  const n = normalizePath(name)
  if (n.startsWith('/') || /^[A-Za-z]:\//.test(n)) return [n]
  const dirs: string[] = []
  for (let dir = dirOf(from); dir; dir = dirOf(dir.slice(0, -1))) dirs.push(dir)
  return [...new Set([...dirs.map((d) => normalizePath(d + n)), n])]
}

/** The file of `files` an include names: a candidate path, else any with that path suffix or name. */
function findInclude(name: string, from: string, files: ReadonlyMap<string, string>): string | undefined {
  for (const c of includeCandidates(name, from)) if (files.has(c)) return c
  const n = normalizePath(name)
  const keys = [...files.keys()]
  return keys.find((k) => k.endsWith(`/${n}`)) ?? keys.find((k) => baseName(k) === baseName(n))
}

const INCLUDE_RE = /^[ \t]*#[ \t]*(?:include|import)[ \t]*[<"]([^>"\n]+)[>"]|\bimport\s+"([^"\n]+)"/gm

const normalizeFiles = (files: ReadonlyMap<string, string>): Map<string, string> =>
  new Map([...files].map(([k, v]) => [normalizePath(k), v]))

/**
 * `files` (by path) with the files they include, transitively, that `read` can read. Includes
 * found nowhere are reported by the parser.
 */
export async function readIdlIncludes(
  files: ReadonlyMap<string, string>,
  read: (path: string) => Promise<string | null>
): Promise<Map<string, string>> {
  const all = normalizeFiles(files)
  const queue = [...all.keys()]
  const tried = new Set<string>()
  while (queue.length) {
    const from = queue.shift()!
    for (const m of all.get(from)!.matchAll(INCLUDE_RE)) {
      const name = m[1] ?? m[2]!
      if (findInclude(name, from, all)) continue
      for (const c of includeCandidates(name, from)) {
        if (tried.has(c)) continue
        tried.add(c)
        const text = await read(c)
        if (text === null) continue
        all.set(c, text)
        queue.push(c)
        break
      }
    }
  }
  return all
}

// Tokens

type TokenKind = 'ident' | 'int' | 'float' | 'string' | 'char' | 'punct' | 'directive'

interface Token {
  kind: TokenKind
  text: string
  file: string
  line: number
  /** Comment block right above the token. */
  doc: string
  /** Comment following the token on its line. */
  trail: string
}

/** Where a token is, for messages: its line, and its file when not the main one. */
function at(t: Pick<Token, 'file' | 'line'>, main: string): string {
  return t.file && t.file !== main ? `Line ${t.line} of ${baseName(t.file)}` : `Line ${t.line}`
}

function cleanComment(raw: string): string {
  const body = raw.startsWith('//') ? raw.replace(/^\/\/[/!]?<?/, '') : raw.replace(/^\/\*[*!]?<?|\*\/$/g, '')
  return body
    .split('\n')
    .map((l) => l.replace(/^\s*\*?\s?/, '').trimEnd())
    .join('\n')
    .trim()
}

const TOKEN_RE =
  /(\s+)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(L?"(?:[^"\\\n]|\\.)*")|(L?'(?:[^'\\\n]|\\.)*')|([A-Za-z_][A-Za-z0-9_]*)|(0[xX][0-9a-fA-F]+[uUlL]*|(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?[fFdDlL]?|\d+[eE][+-]?\d+[fFdDlL]?|\d+[dD]|\d+[uUlL]*)|(::|<<|&&|\|\||==|!=|<=|>=|##|\.\.\.|\S)/y
const DIRECTIVE_RE = /#(?:[^\n\\]|\\[\s\S])*/y

/** Tokens of a file; `#` lines are directive tokens unless `directives` is false (macro bodies). */
function tokenize(src: string, file: string, firstLine = 1, directives = true): Token[] {
  const text = src.replace(/\r\n?/g, '\n')
  const tokens: Token[] = []
  let line = firstLine
  let doc: string[] = []
  // Comments after the last token on its line are its trailing comment.
  let sameLine = false
  let lineStart = true
  let pos = 0
  while (pos < text.length) {
    if (directives && lineStart && text[pos] === '#') {
      DIRECTIVE_RE.lastIndex = pos
      const d = DIRECTIVE_RE.exec(text)![0]
      tokens.push({ kind: 'directive', text: d, file, line, doc: '', trail: '' })
      doc = []
      line += d.split('\n').length - 1
      pos += d.length
      lineStart = false
      sameLine = false
      continue
    }
    TOKEN_RE.lastIndex = pos
    const m = TOKEN_RE.exec(text)!
    const s = m[0]
    pos += s.length
    const newlines = s.split('\n').length - 1
    if (m[1] !== undefined) {
      if (newlines) {
        sameLine = false
        lineStart = true
      }
      // A blank line detaches a comment from what follows.
      if (newlines > 1) doc = []
    } else if (m[2] !== undefined) {
      const comment = cleanComment(s)
      const last = tokens[tokens.length - 1]
      if (sameLine && last && last.kind !== 'directive')
        last.trail = last.trail ? `${last.trail}\n${comment}` : comment
      else if (comment) doc.push(comment)
    } else {
      const kind: TokenKind =
        m[3] !== undefined
          ? 'string'
          : m[4] !== undefined
            ? 'char'
            : m[5] !== undefined
              ? 'ident'
              : m[6] !== undefined
                ? /^0[xX]|^\d+[uUlL]*$/.test(s)
                  ? 'int'
                  : 'float'
                : 'punct'
      tokens.push({ kind, text: s, file, line, doc: doc.join('\n'), trail: '' })
      doc = []
      sameLine = true
      lineStart = false
    }
    line += newlines
  }
  return tokens
}

// Constant expressions (preprocessor conditions, array sizes and bounds, annotation values)

type ConstValue = bigint | number | string | boolean

function unescape(literal: string): string {
  return literal
    .replace(/^L/, '')
    .slice(1, -1)
    .replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|[0-7]{1,3}|.)/g, (_, e: string) => {
      if (e[0] === 'x' || e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16))
      if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8))
      const named: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        v: '\v',
        b: '\b',
        f: '\f',
        a: '\x07'
      }
      return named[e] ?? e
    })
}

function literal(t: Token): ConstValue | undefined {
  switch (t.kind) {
    case 'int': {
      const s = t.text.replace(/[uUlL]+$/, '')
      return BigInt(/^0[0-7]+$/.test(s) ? `0o${s.slice(1)}` : s)
    }
    case 'float':
      return Number(t.text.replace(/[fFdDlL]$/, ''))
    case 'string':
    case 'char':
      return unescape(t.text)
  }
}

const truthy = (v: ConstValue): boolean => !(v === 0n || v === 0 || v === false || v === '')

const BINARY_LEVELS = [
  ['||'],
  ['&&'],
  ['|'],
  ['^'],
  ['&'],
  ['==', '!='],
  ['<', '>', '<=', '>='],
  ['<<', '>>'],
  ['+', '-'],
  ['*', '/', '%']
]

/** Value of a C-like constant expression; `lookup` gives the value of a (scoped) name. */
function evaluate(raw: Token[], lookup: (name: string) => ConstValue | undefined, main: string): ConstValue {
  // `>>` comes as two tokens: it also closes nested templates.
  const tokens: Token[] = []
  for (const t of raw) {
    const last = tokens[tokens.length - 1]
    if (last?.text === '>' && t.text === '>') last.text = '>>'
    else tokens.push({ ...t })
  }
  let i = 0
  const fail = (t: Token | undefined, msg: string): never => {
    const near = t ?? raw[raw.length - 1]
    throw new IdlError(near ? `${at(near, main)}: ${msg}` : msg)
  }
  const int = (v: ConstValue, t: Token): bigint => {
    if (typeof v === 'bigint') return v
    if (typeof v === 'boolean') return v ? 1n : 0n
    if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v)
    if (typeof v === 'string' && v.length === 1) return BigInt(v.charCodeAt(0))
    return fail(t, `${JSON.stringify(v)} is not an integer`)
  }
  const num = (v: ConstValue, t: Token): number | bigint => (typeof v === 'number' ? v : int(v, t))
  const compare = (a: ConstValue, b: ConstValue, t: Token): number => {
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
    const x = num(a, t)
    const y = num(b, t)
    const [p, q] = typeof x === 'bigint' && typeof y === 'bigint' ? [x, y] : [Number(x), Number(y)]
    return p < q ? -1 : p > q ? 1 : 0
  }
  const binary = (op: string, a: ConstValue, b: ConstValue, t: Token): ConstValue => {
    const bool = (c: boolean): bigint => (c ? 1n : 0n)
    switch (op) {
      case '||':
        return bool(truthy(a) || truthy(b))
      case '&&':
        return bool(truthy(a) && truthy(b))
      case '|':
        return int(a, t) | int(b, t)
      case '^':
        return int(a, t) ^ int(b, t)
      case '&':
        return int(a, t) & int(b, t)
      case '==':
        return bool(compare(a, b, t) === 0)
      case '!=':
        return bool(compare(a, b, t) !== 0)
      case '<':
        return bool(compare(a, b, t) < 0)
      case '>':
        return bool(compare(a, b, t) > 0)
      case '<=':
        return bool(compare(a, b, t) <= 0)
      case '>=':
        return bool(compare(a, b, t) >= 0)
      case '<<':
        return int(a, t) << int(b, t)
      case '>>':
        return int(a, t) >> int(b, t)
    }
    const x = num(a, t)
    const y = num(b, t)
    if (typeof x === 'bigint' && typeof y === 'bigint') {
      if ((op === '/' || op === '%') && y === 0n) fail(t, 'division by zero')
      return op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : op === '/' ? x / y : x % y
    }
    if (op === '%') fail(t, '% of a floating-point value')
    const [p, q] = [Number(x), Number(y)]
    return op === '+' ? p + q : op === '-' ? p - q : op === '*' ? p * q : p / q
  }
  const level = (n: number): ConstValue => {
    if (n === BINARY_LEVELS.length) return unary()
    let a = level(n + 1)
    while (tokens[i]?.kind === 'punct' && BINARY_LEVELS[n]!.includes(tokens[i]!.text)) {
      const t = tokens[i++]!
      a = binary(t.text, a, level(n + 1), t)
    }
    return a
  }
  const ternary = (): ConstValue => {
    const c = level(0)
    if (tokens[i]?.text !== '?') return c
    i++
    const a = ternary()
    if (tokens[i]?.text !== ':') fail(tokens[i], "expected ':'")
    i++
    const b = ternary()
    return truthy(c) ? a : b
  }
  const unary = (): ConstValue => {
    const t = tokens[i++]
    if (!t) return fail(undefined, 'expected a constant')
    switch (t.text) {
      case '-': {
        const v = unary()
        return typeof v === 'number' ? -v : -int(v, t)
      }
      case '+':
        return unary()
      case '~':
        return ~int(unary(), t)
      case '!':
        return truthy(unary()) ? 0n : 1n
      case '(': {
        const v = ternary()
        if (tokens[i++]?.text !== ')') fail(tokens[i - 1], "expected ')'")
        return v
      }
    }
    const value = literal(t)
    if (value !== undefined) return value
    if (t.kind === 'ident' || t.text === '::') {
      let name = t.text
      while (tokens[i]?.text === '::' || (name.endsWith('::') && tokens[i]?.kind === 'ident'))
        name += tokens[i++]!.text
      const v = lookup(name)
      if (v !== undefined) return v
    }
    return fail(t, `'${t.text}' is not a constant`)
  }
  const v = ternary()
  if (i < tokens.length) fail(tokens[i], `unexpected '${tokens[i]!.text}'`)
  return v
}

// Preprocessor

interface Macro {
  /** Absent for an object-like macro. */
  params?: string[]
  variadic?: boolean
  body: Token[]
}

interface Condition {
  /** The current branch is read. */
  on: boolean
  /** A branch was read already. */
  done: boolean
  /** The enclosing branch is read. */
  outer: boolean
}

class Preprocessor {
  readonly out: Token[] = []
  readonly warnings: string[] = []
  readonly missing: string[] = []
  private readonly macros = new Map<string, Macro>()
  /** Files read already: each is read once. */
  private readonly done = new Set<string>()

  constructor(
    private readonly files: ReadonlyMap<string, string>,
    private readonly main: string
  ) {}

  include(path: string, text: string): void {
    if (this.done.has(path)) return
    this.done.add(path)
    const tokens = tokenize(text, path)
    const conditions: Condition[] = []
    let active = true
    let run: Token[] = []
    const flush = (): void => {
      if (run.length) this.out.push(...this.expand(run, new Set()))
      run = []
    }
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!
      if (t.kind !== 'directive') {
        if (!active) continue
        // IDL 4 `import "file";` reads the file like #include.
        if (t.text === 'import' && tokens[i + 1]?.kind === 'string' && tokens[i + 2]?.text === ';') {
          flush()
          this.includeFile(unescape(tokens[i + 1]!.text), t)
          i += 2
          continue
        }
        run.push(t)
        continue
      }
      flush()
      const body = t.text
        .replace(/\\\n/g, ' ')
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ' ')
        .slice(1)
      const [, name = '', rest = ''] = /^\s*([A-Za-z_]\w*)?\s*([\s\S]*)$/.exec(body) ?? []
      const condition = (): boolean => this.condition(rest, t)
      switch (name) {
        case 'if':
        case 'ifdef':
        case 'ifndef': {
          const on: boolean =
            active &&
            (name === 'if'
              ? condition()
              : this.macros.has(rest.trim().split(/\s/)[0] ?? '') === (name === 'ifdef'))
          conditions.push({ on, done: on, outer: active })
          active = on
          continue
        }
        case 'elif':
        case 'else': {
          const c = conditions[conditions.length - 1]
          if (!c) throw new IdlError(`${at(t, this.main)}: #${name} without #if`)
          c.on = c.outer && !c.done && (name === 'else' || condition())
          c.done ||= c.on
          active = c.on
          continue
        }
        case 'endif': {
          const c = conditions.pop()
          if (!c) throw new IdlError(`${at(t, this.main)}: #endif without #if`)
          active = c.outer
          continue
        }
      }
      if (!active) continue
      switch (name) {
        case 'define':
          this.define(rest, t)
          break
        case 'undef':
          this.macros.delete(rest.trim())
          break
        case 'include':
        case 'import': {
          let spec = rest.trim()
          if (!/^["<]/.test(spec))
            spec = this.expand(tokenize(spec, path, t.line, false), new Set())
              .map((x) => x.text)
              .join('')
          const m = /^"([^"]*)"|^<([^>]*)>/.exec(spec)
          if (!m) throw new IdlError(`${at(t, this.main)}: #include expects "file" or <file>`)
          this.includeFile(m[1] ?? m[2]!, t)
          break
        }
        case 'error':
          throw new IdlError(`${at(t, this.main)}: #error ${rest.trim()}`)
        case 'warning':
          this.warnings.push(`${at(t, this.main)}: ${rest.trim()}`)
          break
        case '':
        case 'pragma':
        case 'line':
        case 'ident':
        case 'sccs':
          break
        default:
          this.warnings.push(`${at(t, this.main)}: #${name} ignored`)
      }
    }
    flush()
    if (conditions.length) throw new IdlError(`${baseName(path) || 'IDL'}: missing #endif`)
  }

  private includeFile(name: string, t: Token): void {
    const found = findInclude(name, t.file, this.files)
    if (found === undefined) {
      if (!this.missing.includes(name)) {
        this.missing.push(name)
        this.warnings.push(`${at(t, this.main)}: ${name} not found`)
      }
      return
    }
    this.include(found, this.files.get(found)!)
  }

  private define(rest: string, t: Token): void {
    const m = /^([A-Za-z_]\w*)(\(([^)]*)\))?/.exec(rest.trim())
    if (!m) throw new IdlError(`${at(t, this.main)}: #define expects a name`)
    const body = tokenize(rest.trim().slice(m[0].length), t.file, t.line, false)
    if (m[2] === undefined) {
      this.macros.set(m[1]!, { body })
      return
    }
    const params = m[3]!
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    const variadic = params[params.length - 1] === '...'
    if (variadic) params[params.length - 1] = '__VA_ARGS__'
    this.macros.set(m[1]!, { params, variadic, body })
  }

  /** `#if` / `#elif` condition. */
  private condition(rest: string, t: Token): boolean {
    const raw = tokenize(rest, t.file, t.line, false)
    const tokens: Token[] = []
    for (let i = 0; i < raw.length; i++) {
      const x = raw[i]!
      if (x.text !== 'defined') {
        tokens.push(x)
        continue
      }
      const paren = raw[i + 1]?.text === '('
      const name = raw[i + (paren ? 2 : 1)]?.text ?? ''
      i += paren ? 3 : 1
      tokens.push({ ...x, kind: 'int', text: this.macros.has(name) ? '1' : '0' })
    }
    // Names left after expansion are 0, `true` is 1 (C++).
    const expanded = this.expand(tokens, new Set()).map((x) =>
      x.kind === 'ident' ? { ...x, kind: 'int' as const, text: x.text === 'true' ? '1' : '0' } : x
    )
    return truthy(evaluate(expanded, () => undefined, this.main))
  }

  /** Macro expansion; `hidden` macros are being expanded (no recursion). */
  private expand(tokens: Token[], hidden: ReadonlySet<string>): Token[] {
    const out: Token[] = []
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!
      if (t.kind === 'ident' && t.text === '__LINE__') {
        out.push({ ...t, kind: 'int', text: String(t.line) })
        continue
      }
      if (t.kind === 'ident' && t.text === '__FILE__') {
        out.push({ ...t, kind: 'string', text: JSON.stringify(baseName(t.file)) })
        continue
      }
      const m = t.kind === 'ident' && !hidden.has(t.text) ? this.macros.get(t.text) : undefined
      if (!m || (m.params && tokens[i + 1]?.text !== '(')) {
        out.push(t)
        continue
      }
      let body = m.body
      if (m.params) {
        const args: Token[][] = [[]]
        let depth = 0
        let j = i + 2
        for (; j < tokens.length; j++) {
          const a = tokens[j]!
          if (a.text === ')' && !depth) break
          if (a.text === '(') depth++
          else if (a.text === ')') depth--
          else if (a.text === ',' && !depth && !(m.variadic && args.length >= m.params.length)) {
            args.push([])
            continue
          }
          args[args.length - 1]!.push(a)
        }
        if (j === tokens.length)
          throw new IdlError(`${at(t, this.main)}: unterminated use of macro ${t.text}`)
        i = j
        body = this.substitute(m, args, hidden)
      }
      const placed = body.map((b, k) => ({
        ...b,
        file: t.file,
        line: t.line,
        doc: k ? '' : t.doc,
        trail: ''
      }))
      out.push(...this.expand(placed, new Set(hidden).add(t.text)))
    }
    return out
  }

  /** Body of a function-like macro with its arguments: `#` makes a string, `##` pastes tokens. */
  private substitute(m: Macro, args: Token[][], hidden: ReadonlySet<string>): Token[] {
    const params = m.params!
    const arg = (name: string): Token[] | undefined => {
      const k = params.indexOf(name)
      return k < 0 ? undefined : (args[k] ?? [])
    }
    const out: Token[] = []
    let paste = false
    for (let i = 0; i < m.body.length; i++) {
      const b = m.body[i]!
      if (b.text === '##') {
        paste = true
        continue
      }
      let part: Token[]
      if (b.text === '#' && arg(m.body[i + 1]?.text ?? '')) {
        const text = arg(m.body[++i]!.text)!
          .map((x) => x.text)
          .join(' ')
        part = [{ ...b, kind: 'string', text: JSON.stringify(text) }]
      } else {
        const a = arg(b.text)
        // Operands of `##` are not expanded.
        part = a ? (paste || m.body[i + 1]?.text === '##' ? a : this.expand(a, hidden)) : [b]
      }
      const last = out[out.length - 1]
      if (paste && last && part.length) {
        const joined = tokenize(last.text + part[0]!.text, b.file, b.line, false)
        out.splice(out.length - 1, 1, ...joined, ...part.slice(1))
      } else out.push(...part)
      paste = false
    }
    return out
  }
}

// Parser

const INT_TYPES: Record<string, IntPrimitive> = {
  short: 'int16',
  long: 'int32',
  int8: 'int8',
  int16: 'int16',
  int32: 'int32',
  int64: 'int64',
  uint8: 'uint8',
  uint16: 'uint16',
  uint32: 'uint32',
  uint64: 'uint64',
  octet: 'uint8'
}

/** Words that start a definition inside interfaces, valuetypes, components and porttypes too. */
const DEFINITION_WORDS = new Set([
  'struct',
  'union',
  'enum',
  'bitmask',
  'bitset',
  'typedef',
  'const',
  'native',
  'exception',
  'typeid',
  'typeprefix'
])
const CONSTRUCTED = new Set(['struct', 'union', 'enum', 'bitmask', 'bitset'])
const PORT_WORDS = new Set(['provides', 'uses', 'emits', 'publishes', 'consumes', 'port', 'mirrorport'])
/** Words that cannot name a type. */
const NOT_TYPES = new Set(['void', 'struct', 'union', 'enum', 'interface', 'module', 'in', 'out', 'inout'])

type DeclKind =
  'module' | 'type' | 'interface' | 'component' | 'porttype' | 'home' | 'const' | 'enumerator' | 'template'

type Entity = {
  /** Qualified IDL name. */
  q: string
  /** Preferred name in the project. */
  simple: string
  /** Name when `simple` is taken; else from `q`. */
  alt?: string
  /** Made by the import, not defined in the file. */
  synthetic?: boolean
  /** References to what it needs besides its types (see `IdlFile.needs`). */
  needs: string[]
} & (
  | { kind: 'type'; def: FileTypeDef }
  | { kind: 'interface'; def: FileInterface }
  | { kind: 'component'; def: IdlComponent }
)

type FileField = Extract<FileTypeDef, { kind: 'struct' }>['fields'][number]
type Annotation = { name: string; args: Token[] }

// References are kept as `<scope>\0<written name>` until the end, where they are resolved.
const SEP = '\u0000'
const BUILTIN = '\u0001'
const BUILTINS: Record<string, [string, string]> = {
  any: ['Any', 'Value of any IDL type'],
  Object: ['Object', 'Reference to any CORBA object'],
  ValueBase: ['ValueBase', 'Any value type']
}

/** IDL escapes (`_name`) removed. */
const unescapeName = (name: string): string => (name.startsWith('_') ? name.slice(1) : name)
const lastSegment = (q: string): string => q.slice(q.lastIndexOf('::') + 2 || 0)
const joinLines = (...lines: (string | false | undefined)[]): string => lines.filter(Boolean).join('\n')
const flip = (role: PortRole): PortRole => (role === 'in' ? 'out' : 'in')

/** Unsigned type of a bitfield of `bits` bits. */
function bitfieldType(bits: number): FileTypeRef {
  const name =
    bits <= 1 ? 'bool' : bits <= 8 ? 'uint8' : bits <= 16 ? 'uint16' : bits <= 32 ? 'uint32' : 'uint64'
  return { kind: 'primitive', name }
}

/** Smallest integer type of at least `bits` bits holding `values`. */
function intType(values: number[], bits: number, signedDefault: boolean): IntPrimitive {
  const signed = signedDefault || values.some((v) => v < 0)
  for (const width of [8, 16, 32, 64]) {
    if (width < bits) continue
    const t = `${signed ? 'int' : 'uint'}${width}` as IntPrimitive
    const [min, max] = INT_RANGES[t]
    if (values.every((v) => BigInt(v) >= min && BigInt(v) <= max)) return t
  }
  return signed ? 'int64' : 'uint64'
}

class Parser {
  private i = 0
  private scope: string[] = []
  private readonly decls = new Map<string, DeclKind>()
  private readonly entities = new Map<string, Entity>()
  /** Interfaces and valuetypes (qualified) by scope: their names are visible in derived ones. */
  private readonly inherited = new Map<string, string[]>()
  private readonly consts = new Map<string, ConstValue>()
  private readonly templates = new Map<string, { params: string[]; body: Token[] }>()
  private readonly porttypes = new Map<string, { ports: IdlPort[]; attributes: IdlAttribute[] }>()
  private instances = 0

  constructor(
    private readonly tokens: Token[],
    private readonly main: string,
    private readonly warnings: string[]
  ) {}

  parse(missing: string[]): IdlFile {
    while (this.peek()) this.definition()
    return this.finish(missing)
  }

  // Tokens

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset]
  }

  private next(): Token {
    const t = this.tokens[this.i++]
    if (!t) throw new IdlError('Unexpected end of file')
    return t
  }

  private fail(t: Token | undefined, expected: string): never {
    if (!t) throw new IdlError(`Unexpected end of file, expected ${expected}`)
    throw new IdlError(`${at(t, this.main)}: expected ${expected} but found '${t.text}'`)
  }

  private warn(t: Token, message: string): void {
    this.warnings.push(`${at(t, this.main)}: ${message}`)
  }

  private is(text: string, offset = 0): boolean {
    const t = this.peek(offset)
    return t?.text === text && t.kind !== 'string' && t.kind !== 'char'
  }

  private accept(text: string): Token | undefined {
    return this.is(text) ? this.next() : undefined
  }

  private expect(text: string): Token {
    return this.accept(text) ?? this.fail(this.peek(), `'${text}'`)
  }

  /** A simple name, IDL escape removed. */
  private name(): string {
    const t = this.peek()
    if (t?.kind !== 'ident') this.fail(t, 'an identifier')
    return unescapeName(this.next().text)
  }

  /** A scoped name (`A::B`, `::A::B`), IDL escapes removed. */
  private scoped(): string {
    let name = this.accept('::') ? '::' : ''
    name += this.name()
    while (this.is('::') && this.peek(1)?.kind === 'ident') {
      this.next()
      name += `::${this.name()}`
    }
    return name
  }

  private scopedList(): string[] {
    const list: string[] = []
    do list.push(this.scoped())
    while (this.accept(','))
    return list
  }

  /** Skips up to the `;` ending the current definition, over nested braces. */
  private skipDefinition(): void {
    let depth = 0
    for (;;) {
      const t = this.next()
      if (t.text === '{' || t.text === '(') depth++
      else if (t.text === '}' || t.text === ')') depth--
      else if (t.text === ';' && depth <= 0) return
    }
  }

  /** Tokens between `open` and its matching `close`, both consumed. */
  private balanced(open: string, close: string): Token[] {
    this.expect(open)
    const start = this.i
    let depth = 1
    for (;;) {
      const t = this.next()
      if (t.text === open) depth++
      else if (t.text === close && !--depth) return this.tokens.slice(start, this.i - 1)
    }
  }

  /** Tokens up to one of `ends` (or `,`) outside parentheses, not consumed. */
  private until(...ends: string[]): Token[] {
    const start = this.i
    let depth = 0
    while (this.peek() && !(depth === 0 && (ends.some((e) => this.is(e)) || this.is(',')))) {
      const t = this.next()
      if (t.text === '(') depth++
      else if (t.text === ')') depth--
    }
    return this.tokens.slice(start, this.i)
  }

  /** Trailing comment of the `;` ending the current definition. */
  private endTrail(): string {
    const t = this.peek()
    return t?.text === ';' ? t.trail : ''
  }

  // Names and references

  private qualified(name: string): string {
    return [...this.scope, name].join('::')
  }

  /** Qualified name a written name refers to from `scope`, among declarations `ok` accepts. */
  private lookup(
    written: string,
    scope: readonly string[] = this.scope,
    ok: (k: DeclKind) => boolean = () => true
  ): string | undefined {
    const has = (q: string): boolean => {
      const k = this.decls.get(q)
      return k !== undefined && ok(k)
    }
    if (written.startsWith('::')) return has(written.slice(2)) ? written.slice(2) : undefined
    const inScope = (prefix: string, seen: Set<string>): string | undefined => {
      const q = prefix ? `${prefix}::${written}` : written
      if (has(q)) return q
      if (seen.has(prefix)) return undefined
      seen.add(prefix)
      for (const base of this.inherited.get(prefix) ?? []) {
        const found = inScope(base, seen)
        if (found) return found
      }
      return undefined
    }
    for (let k = scope.length; k >= 0; k--) {
      const found = inScope(scope.slice(0, k).join('::'), new Set())
      if (found) return found
    }
    return undefined
  }

  private entity(written: string, kind: Entity['kind']): Entity | undefined {
    const q = this.lookup(written, this.scope, (k) => k === kind)
    const e = q ? this.entities.get(q) : undefined
    return e?.kind === kind ? e : undefined
  }

  /** Reference to a written name, resolved at the end. */
  private encode(written: string): string {
    return `${this.scope.join('::')}${SEP}${written}`
  }

  private ref(written: string): FileTypeRef {
    return { kind: 'ref', name: this.encode(written) }
  }

  private add(e: Entity): void {
    // Read twice (a file included without guards, a reopened module): the first one stays.
    if (this.entities.has(e.q)) return
    this.entities.set(e.q, e)
    this.decls.set(e.q, e.kind)
  }

  private forward(q: string, kind: DeclKind): void {
    if (!this.decls.has(q)) this.decls.set(q, kind)
  }

  private constValue(name: string): ConstValue | undefined {
    if (name === 'TRUE') return true
    if (name === 'FALSE') return false
    const constant = (k: DeclKind): boolean => k === 'const' || k === 'enumerator'
    // Enumerators are in the scope of their enum's, also written `Enum::VALUE`.
    const parts = name.split('::')
    const q =
      this.lookup(name, this.scope, constant) ??
      (parts.length > 1
        ? this.lookup([...parts.slice(0, -2), parts.at(-1)].join('::'), this.scope, constant)
        : undefined)
    return q === undefined ? undefined : this.consts.get(q)
  }

  private evaluate(tokens: Token[]): ConstValue {
    if (!tokens.length) this.fail(this.peek(), 'a constant')
    return evaluate(tokens, (n) => this.constValue(n), this.main)
  }

  /** A positive integer constant expression, up to one of `ends`. */
  private count(...ends: string[]): number {
    const tokens = this.until(...ends)
    const v = this.evaluate(tokens)
    const n = typeof v === 'bigint' ? Number(v) : v
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
      throw new IdlError(`${at(tokens[0]!, this.main)}: expected a positive integer`)
    return n
  }

  /** Bound of a string, sequence or map, up to `>`; none when 0. */
  private bound(): { max?: number } {
    const n = this.count('>')
    return n > 0 ? { max: n } : {}
  }

  // Annotations

  private annotations(): Annotation[] {
    const list: Annotation[] = []
    while (this.is('@') && !this.is('annotation', 1)) {
      this.next()
      const name = this.scoped()
      list.push({ name: lastSegment(`::${name}`), args: this.is('(') ? this.balanced('(', ')') : [] })
    }
    return list
  }

  /** Value of an annotation parameter: `key = value`, else the single value. */
  private annotationValue(a: Annotation | undefined, key = 'value'): ConstValue | undefined {
    if (!a?.args.length) return undefined
    let tokens = a.args
    if (a.args[1]?.text === '=') {
      const start = a.args.findIndex((t, k) => t.text === key && a.args[k + 1]?.text === '=')
      if (start < 0) return undefined
      const end = a.args.findIndex((t, k) => k > start && t.text === ',' && a.args[k + 2]?.text === '=')
      tokens = a.args.slice(start + 2, end < 0 ? undefined : end)
    }
    try {
      return this.evaluate(tokens)
    } catch {
      return undefined
    }
  }

  /** Description of a member: its comment, then what annotations tell about it. */
  private describe(text: string, anns: Annotation[]): string {
    const find = (n: string): Annotation | undefined => anns.find((a) => a.name === n)
    const show = (v: ConstValue | undefined): string | undefined => (v === undefined ? undefined : String(v))
    const range = find('range')
    const min = show(this.annotationValue(range, 'min') ?? this.annotationValue(find('min')))
    const max = show(this.annotationValue(range, 'max') ?? this.annotationValue(find('max')))
    const unit = show(this.annotationValue(find('unit')))
    return joinLines(
      text,
      unit && `Unit: ${unit}.`,
      min !== undefined && max !== undefined
        ? `Range: ${min} to ${max}.`
        : min !== undefined
          ? `Minimum: ${min}.`
          : max !== undefined && `Maximum: ${max}.`
    )
  }

  /** `@default` value of a member, as a field default. */
  private defaultValue(anns: Annotation[]): { default?: Value } {
    const v = this.annotationValue(anns.find((a) => a.name === 'default'))
    if (v === undefined) return {}
    if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? { default: Number(v) } : {}
    return { default: v }
  }

  // Definitions

  private definition(): void {
    const first = this.peek()!
    if (this.is('@') && this.is('annotation', 1)) {
      // Annotation declaration.
      this.next()
      this.next()
      this.name()
      this.balanced('{', '}')
      this.expect(';')
      return
    }
    this.declaration(first, this.annotations())
  }

  private declaration(first: Token, anns: Annotation[]): void {
    const t = this.peek()
    if (!t) return
    switch (t.text) {
      case ';':
        this.next()
        return
      case 'module':
        return this.module()
      case 'abstract':
      case 'local':
      case 'custom': {
        this.next()
        if (this.is('interface')) return this.interface(first)
        if (this.is('custom')) this.next()
        if (this.is('valuetype') || this.is('eventtype')) return this.valuetype(first, t.text === 'abstract')
        return this.fail(this.peek(), 'interface, valuetype or eventtype')
      }
      case 'interface':
        return this.interface(first)
      case 'typedef':
        return this.typedef(first)
      case 'const':
        return this.constant()
      case 'native': {
        this.next()
        const name = this.name()
        const description = first.doc || this.endTrail() || first.trail
        this.expect(';')
        const q = this.qualified(name)
        this.add({ q, simple: name, kind: 'type', def: { kind: 'primitive', name, description }, needs: [] })
        return
      }
      case 'exception':
        return this.exception(first)
      case 'valuetype':
      case 'eventtype':
        return this.valuetype(first, false)
      case 'component':
      case 'connector':
        return this.component(first)
      case 'porttype':
        return this.porttype()
      case 'home': {
        this.next()
        const name = this.name()
        this.decls.set(this.qualified(name), 'home')
        this.warn(t, `home ${this.qualified(name)} left out`)
        this.skipDefinition()
        return
      }
      case 'alias':
        // Template module referenced in a template module.
        return this.module()
      case 'typeid':
      case 'typeprefix':
      case 'import':
        this.skipDefinition()
        return
    }
    if (CONSTRUCTED.has(t.text)) {
      this.constructed(first, anns)
      this.expect(';')
      return
    }
    this.fail(t, 'a definition')
  }

  private module(): void {
    const keyword = this.next()
    const written = this.scoped()
    if (this.is('<')) {
      const args = this.templateArgs()
      if (keyword.text === 'module' && this.is('{')) {
        // Template module: read where instantiated.
        const q = this.qualified(unescapeName(written))
        this.templates.set(q, {
          params: args.map((a) => a[a.length - 1]?.text ?? ''),
          body: this.balanced('{', '}')
        })
        this.decls.set(q, 'template')
        this.expect(';')
        return
      }
      const name = this.name()
      this.expect(';')
      return this.instantiate(written, args, name, keyword)
    }
    if (keyword.text !== 'module') this.fail(this.peek(), "'<'")
    const name = unescapeName(written)
    this.forward(this.qualified(name), 'module')
    this.expect('{')
    this.scope.push(name)
    while (!this.is('}')) {
      if (!this.peek()) this.fail(undefined, "'}'")
      this.definition()
    }
    this.scope.pop()
    this.expect('}')
    this.expect(';')
  }

  /** `<a, b, ...>` of a template module: the tokens of each parameter or argument. */
  private templateArgs(): Token[][] {
    this.expect('<')
    const args: Token[][] = [[]]
    let depth = 0
    for (;;) {
      const t = this.next()
      if (t.text === '>' && !depth) return args
      if (t.text === '<' || t.text === '(') depth++
      else if (t.text === '>' || t.text === ')') depth--
      else if (t.text === ',' && !depth) {
        args.push([])
        continue
      }
      args[args.length - 1]!.push(t)
    }
  }

  /** Reads an instance of a template module as a module `name` holding its definitions. */
  private instantiate(written: string, args: Token[][], name: string, from: Token): void {
    const q = this.lookup(written, this.scope, (k) => k === 'template')
    const template = q ? this.templates.get(q) : undefined
    if (!template) return this.warn(from, `template module ${written} not found, ${name} left out`)
    if (template.params.length !== args.length)
      throw new IdlError(
        `${at(from, this.main)}: ${written} takes ${template.params.length} parameters, not ${args.length}`
      )
    if (++this.instances > 1000) throw new IdlError(`${at(from, this.main)}: too many template instances`)
    const actual = new Map(template.params.map((p, k) => [p, args[k]!]))
    const body = template.body.flatMap((t) => (t.kind === 'ident' && actual.get(t.text)) || [t])
    const token = (text: string, kind: TokenKind = 'punct'): Token => ({
      ...from,
      kind,
      text,
      doc: '',
      trail: ''
    })
    this.tokens.splice(
      this.i,
      0,
      token('module', 'ident'),
      token(name, 'ident'),
      token('{'),
      ...body,
      token('}'),
      token(';')
    )
  }

  private interface(first: Token): void {
    this.expect('interface')
    const name = this.name()
    const q = this.qualified(name)
    if (this.accept(';')) return this.forward(q, 'interface')
    const messages: FileMessage[] = []
    const needs: string[] = []
    const bases: string[] = []
    if (this.accept(':'))
      for (const b of this.scopedList()) {
        const base = this.entity(b, 'interface')
        if (base?.kind !== 'interface') {
          this.warn(first, `${q}: base interface ${b} not found`)
          continue
        }
        bases.push(base.q)
        for (const m of base.def.messages)
          if (!messages.some((x) => x.name === m.name)) messages.push(structuredClone(m))
        needs.push(...base.needs)
      }
    this.expect('{')
    this.forward(q, 'interface')
    this.inherited.set(q, bases)
    this.scope.push(name)
    while (!this.accept('}')) {
      const f = this.peek()
      if (!f) this.fail(undefined, "'}'")
      const anns = this.annotations()
      const t = this.peek()
      if (t && DEFINITION_WORDS.has(t.text)) this.declaration(f, anns)
      else if (this.is('attribute') || this.is('readonly')) this.attribute(f, messages, needs)
      else {
        const { message, raises } = this.operation(f)
        messages.push(message)
        needs.push(...raises)
      }
    }
    this.scope.pop()
    const description = first.doc || this.endTrail() || first.trail
    this.expect(';')
    this.add({ q, simple: name, kind: 'interface', def: { name, description, messages }, needs })
  }

  /** `raises (A, B)`: references to the exceptions, and their names for descriptions. */
  private raises(): { refs: string[]; text: string } {
    this.expect('(')
    const names = this.scopedList()
    this.expect(')')
    return {
      refs: names.map((n) => this.encode(n)),
      text: names.map((n) => lastSegment(`::${n}`)).join(', ')
    }
  }

  /** Attribute declaration, as messages: `get_x`, and `set_x` unless read-only. */
  private attribute(first: Token, messages: FileMessage[], needs: string[]): void {
    const a = this.attributeDecl(first)
    for (const n of a.names) {
      messages.push({
        name: `get_${n}`,
        description: joinLines(a.description, a.get),
        params: [],
        returns: a.type
      })
      if (!a.readonly)
        messages.push({
          name: `set_${n}`,
          description: joinLines(a.description, a.set),
          params: [{ name: n, type: a.type, direction: 'in' }],
          returns: null
        })
    }
    needs.push(...a.refs)
  }

  private attributeDecl(first: Token): {
    names: string[]
    type: FileTypeRef
    readonly: boolean
    description: string
    get: string
    set: string
    refs: string[]
  } {
    const readonly = !!this.accept('readonly')
    this.expect('attribute')
    const type = this.typeSpec()
    const names: string[] = []
    do names.push(this.name())
    while (this.accept(','))
    let get = ''
    let set = ''
    const refs: string[] = []
    while (this.is('raises') || this.is('getraises') || this.is('setraises')) {
      const which = this.next().text
      const r = this.raises()
      refs.push(...r.refs)
      if (which === 'setraises') set = `Raises ${r.text}.`
      else get = `Raises ${r.text}.`
    }
    const end = this.expect(';')
    return { names, type, readonly, description: first.doc || end.trail || first.trail, get, set, refs }
  }

  private operation(first: Token): { message: FileMessage; raises: string[] } {
    this.accept('oneway')
    const returns = this.accept('void') ? null : this.typeSpec()
    const name = this.name()
    this.expect('(')
    const params: FileMessage['params'] = []
    if (!this.is(')'))
      do {
        const param = this.peek()!
        this.annotations()
        const dir = this.is('in') || this.is('out') || this.is('inout') ? this.next().text : 'in'
        const type = this.typeSpec()
        const pname = this.name()
        params.push({
          name: pname,
          type,
          direction: dir as 'in' | 'out' | 'inout',
          ...(param.doc ? { description: param.doc } : {})
        })
      } while (this.accept(','))
    this.expect(')')
    const raised = this.accept('raises') ? this.raises() : undefined
    if (this.accept('context')) this.balanced('(', ')')
    const end = this.expect(';')
    const description = joinLines(first.doc || end.trail || first.trail, raised && `Raises ${raised.text}.`)
    return { message: { name, description, params, returns }, raises: raised?.refs ?? [] }
  }

  /** Struct, union, enum, bitmask or bitset definition (or forward declaration): its qualified name. */
  private constructed(first: Token, anns: Annotation[]): string {
    switch (this.peek()?.text) {
      case 'struct':
        return this.struct(first)
      case 'union':
        return this.union(first)
      case 'enum':
        return this.enum(first, anns)
      case 'bitmask':
        return this.bitmask(first, anns)
      default:
        return this.bitset(first)
    }
  }

  /** Struct members up to `}`. */
  private members(fields: FileField[]): void {
    while (!this.accept('}')) {
      const member = this.peek()
      if (!member) this.fail(undefined, "'}'")
      const anns = this.annotations()
      if (this.is('}')) continue
      const optional = anns.some((a) => a.name === 'optional')
      const base = this.typeSpec()
      const declarators = this.declarators(base)
      const end = this.expect(';')
      const description = this.describe(member.doc || end.trail || member.trail, anns)
      for (const d of declarators)
        fields.push({
          name: d.name,
          type: optional ? { kind: 'optional', of: d.type } : d.type,
          ...(description ? { description } : {}),
          ...this.defaultValue(anns)
        })
    }
  }

  /** Fields of a base struct, valuetype or bitset. */
  private baseFields(written: string, what: string, first: Token, q: string): FileField[] {
    const base = this.entity(written, 'type')
    if (base?.kind === 'type' && base.def.kind === 'struct') return structuredClone(base.def.fields)
    this.warn(first, `${q}: base ${what} ${written} not found`)
    return []
  }

  private struct(first: Token): string {
    this.expect('struct')
    const name = this.name()
    const q = this.qualified(name)
    if (!this.is('{') && !this.is(':')) {
      this.forward(q, 'type')
      return q
    }
    const fields = this.accept(':') ? this.baseFields(this.scoped(), 'struct', first, q) : []
    this.expect('{')
    this.forward(q, 'type')
    this.scope.push(name)
    this.members(fields)
    this.scope.pop()
    const description = first.doc || this.endTrail() || first.trail
    this.add({ q, simple: name, kind: 'type', def: { kind: 'struct', name, description, fields }, needs: [] })
    return q
  }

  private exception(first: Token): void {
    this.expect('exception')
    const name = this.name()
    const q = this.qualified(name)
    this.expect('{')
    this.forward(q, 'type')
    this.scope.push(name)
    const fields: FileField[] = []
    this.members(fields)
    this.scope.pop()
    const description = first.doc || this.endTrail() || first.trail
    this.expect(';')
    this.add({ q, simple: name, kind: 'type', def: { kind: 'struct', name, description, fields }, needs: [] })
  }

  /** Union: its discriminator and cases, with their labels. */
  private union(first: Token): string {
    this.expect('union')
    const name = this.name()
    const q = this.qualified(name)
    if (!this.is('switch')) {
      this.forward(q, 'type')
      return q
    }
    this.expect('switch')
    this.expect('(')
    this.annotations()
    const discriminator = this.typeSpec()
    this.expect(')')
    this.expect('{')
    this.forward(q, 'type')
    this.scope.push(name)
    const cases: Extract<FileTypeDef, { kind: 'union' }>['cases'] = []
    while (!this.accept('}')) {
      const labels: (number | string | boolean)[] = []
      let isDefault = false
      while (this.is('case') || this.is('default')) {
        if (this.accept('default')) isDefault = true
        else {
          this.next()
          const v = this.evaluate(this.until(':'))
          labels.push(typeof v === 'bigint' ? (Number.isSafeInteger(Number(v)) ? Number(v) : String(v)) : v)
        }
        this.expect(':')
      }
      if (!labels.length && !isDefault) this.fail(this.peek(), "'case' or 'default'")
      const member = this.peek()!
      const anns = this.annotations()
      const type = this.typeSpec()
      const [d] = this.declarators(type, false)
      const end = this.expect(';')
      cases.push({
        name: d!.name,
        type: d!.type,
        description: this.describe(member.doc || end.trail || member.trail, anns),
        ...(labels.length ? { labels } : {}),
        ...(isDefault ? { default: true } : {})
      })
    }
    this.scope.pop()
    const description = first.doc || this.endTrail() || first.trail
    this.add({
      q,
      simple: name,
      kind: 'type',
      def: { kind: 'union', name, description, discriminator, cases },
      needs: []
    })
    return q
  }

  private enum(first: Token, anns: Annotation[]): string {
    this.expect('enum')
    const name = this.name()
    const q = this.qualified(name)
    this.expect('{')
    const values: { name: string; value: number }[] = []
    let value = 0
    do {
      if (this.is('}')) break
      const explicit = this.annotationValue(this.annotations().find((a) => a.name === 'value'))
      if (explicit !== undefined) value = Number(explicit)
      const v = this.name()
      values.push({ name: v, value: value++ })
      // Enumerators belong to the enclosing scope.
      const vq = this.qualified(v)
      this.decls.set(vq, 'enumerator')
      this.consts.set(vq, v)
    } while (this.accept(','))
    this.expect('}')
    const bits = this.annotationValue(anns.find((a) => a.name === 'bit_bound'))
    const nums = values.map((v) => v.value)
    const underlying =
      bits === undefined
        ? nums.every((v) => v <= 2 ** 31 - 1)
          ? 'int32'
          : intType(nums, 32, false)
        : intType(nums, Number(bits), false)
    const description = first.doc || this.endTrail() || first.trail
    this.add({
      q,
      simple: name,
      kind: 'type',
      def: { kind: 'enum', name, description, underlying, values },
      needs: []
    })
    return q
  }

  /** Bitmask: an enum of its flags. */
  private bitmask(first: Token, anns: Annotation[]): string {
    this.expect('bitmask')
    const name = this.name()
    const q = this.qualified(name)
    this.expect('{')
    const flags: { name: string; bit: number }[] = []
    let bit = 0
    do {
      if (this.is('}')) break
      const position = this.annotationValue(this.annotations().find((a) => a.name === 'position'))
      if (position !== undefined) bit = Number(position)
      const flag = this.name()
      this.decls.set(this.qualified(flag), 'enumerator')
      this.consts.set(this.qualified(flag), flag)
      if (bit < 64) flags.push({ name: flag, bit })
      else this.warn(first, `bitmask ${q}: flag ${flag} above bit 63 left out`)
      bit++
    } while (this.accept(','))
    this.expect('}')
    const bound = Number(this.annotationValue(anns.find((a) => a.name === 'bit_bound')) ?? 32)
    const bits = Math.max(bound, ...flags.map((f) => f.bit + 1))
    const description = first.doc || this.endTrail() || first.trail
    this.add({
      q,
      simple: name,
      kind: 'type',
      def: {
        kind: 'bitmask',
        name,
        description,
        underlying: bits <= 8 ? 'uint8' : bits <= 16 ? 'uint16' : bits <= 32 ? 'uint32' : 'uint64',
        flags
      },
      needs: []
    })
    return q
  }

  /** Bitset: a struct of its bitfields. */
  private bitset(first: Token): string {
    this.expect('bitset')
    const name = this.name()
    const q = this.qualified(name)
    if (!this.is('{') && !this.is(':')) {
      this.forward(q, 'type')
      return q
    }
    const fields = this.accept(':') ? this.baseFields(this.scoped(), 'bitset', first, q) : []
    this.expect('{')
    while (!this.accept('}')) {
      const member = this.peek()
      const anns = this.annotations()
      this.expect('bitfield')
      this.expect('<')
      const bits = this.count('>')
      const type = this.accept(',') ? this.typeSpec() : bitfieldType(bits)
      this.expect('>')
      const names: string[] = []
      if (!this.is(';'))
        do names.push(this.name())
        while (this.accept(','))
      const end = this.expect(';')
      const description = joinLines(this.describe(member?.doc || end.trail, anns), `${bits} bits.`)
      for (const n of names) fields.push({ name: n, type, description })
    }
    this.warn(first, `bitset ${q} imported as a struct of its bitfields`)
    const description = first.doc || this.endTrail() || first.trail
    this.add({ q, simple: name, kind: 'type', def: { kind: 'struct', name, description, fields }, needs: [] })
    return q
  }

  private typedef(first: Token): void {
    this.expect('typedef')
    this.annotations()
    const base = this.typeSpec()
    const declarators = this.declarators(base)
    const end = this.expect(';')
    const description = first.doc || end.trail || first.trail
    for (const d of declarators)
      this.add({
        q: this.qualified(d.name),
        simple: d.name,
        kind: 'type',
        def: { kind: 'alias', name: d.name, description, type: d.type },
        needs: []
      })
  }

  private constant(): void {
    this.expect('const')
    const warnings = this.warnings.length
    this.typeSpec()
    this.warnings.length = warnings
    const name = this.name()
    this.expect('=')
    const tokens = this.until(';')
    this.expect(';')
    const q = this.qualified(name)
    this.decls.set(q, 'const')
    try {
      this.consts.set(q, this.evaluate(tokens))
    } catch {
      // Unknown value: uses of the constant tell.
    }
  }

  /**
   * Valuetype or eventtype: a struct of its state members; an abstract one, an interface of its
   * operations. A value box is an alias of an optional value.
   */
  private valuetype(first: Token, abstract: boolean): void {
    const keyword = this.next().text
    const name = this.name()
    const q = this.qualified(name)
    if (this.accept(';')) return this.forward(q, abstract ? 'interface' : 'type')
    if (!this.is(':') && !this.is('supports') && !this.is('{')) {
      const type = this.typeSpec()
      const description = first.doc || this.endTrail() || first.trail
      this.expect(';')
      this.add({
        q,
        simple: name,
        kind: 'type',
        def: { kind: 'alias', name, description, type: { kind: 'optional', of: type } },
        needs: []
      })
      return
    }
    const fields: FileField[] = []
    const messages: FileMessage[] = []
    const needs: string[] = []
    const bases: string[] = []
    const inherit = (written: string): void => {
      const lookedUp = this.lookup(written, this.scope, (k) => k === 'type' || k === 'interface')
      const base = lookedUp ? this.entities.get(lookedUp) : undefined
      if (base?.kind === 'type' && base.def.kind === 'struct')
        fields.push(...structuredClone(base.def.fields))
      else if (base?.kind === 'interface') {
        for (const m of base.def.messages)
          if (!messages.some((x) => x.name === m.name)) messages.push(structuredClone(m))
        needs.push(...base.needs)
      } else return this.warn(first, `${q}: base ${written} not found`)
      bases.push(base.q)
    }
    if (this.accept(':')) {
      this.accept('truncatable')
      this.scopedList().forEach(inherit)
    }
    if (this.accept('supports')) this.scopedList().forEach(inherit)
    this.expect('{')
    this.forward(q, abstract ? 'interface' : 'type')
    this.inherited.set(q, bases)
    this.scope.push(name)
    let left = 0
    while (!this.accept('}')) {
      const f = this.peek()
      if (!f) this.fail(undefined, "'}'")
      const anns = this.annotations()
      const t = this.peek()!
      if (t.text === 'public' || t.text === 'private') {
        this.next()
        const type = this.typeSpec()
        const declarators = this.declarators(type)
        const end = this.expect(';')
        const description = this.describe(f.doc || end.trail || f.trail, anns)
        for (const d of declarators)
          fields.push({ name: d.name, type: d.type, ...(description ? { description } : {}) })
      } else if (t.text === 'factory' || t.text === 'init') {
        this.skipDefinition()
        left++
      } else if (DEFINITION_WORDS.has(t.text)) this.declaration(f, anns)
      else if (t.text === 'attribute' || t.text === 'readonly') {
        const before = messages.length
        this.attribute(f, messages, needs)
        if (!abstract) left += messages.splice(before).length
      } else {
        const { message, raises } = this.operation(f)
        if (abstract) {
          messages.push(message)
          needs.push(...raises)
        } else left++
      }
    }
    this.scope.pop()
    const description = first.doc || this.endTrail() || first.trail
    this.expect(';')
    if (abstract) {
      this.add({ q, simple: name, kind: 'interface', def: { name, description, messages }, needs })
      return
    }
    if (left) this.warn(first, `${keyword} ${q}: ${left} operations, factories or attributes left out`)
    this.add({ q, simple: name, kind: 'type', def: { kind: 'struct', name, description, fields }, needs: [] })
  }

  /** Component or connector: a module with ports and attributes. */
  private component(first: Token): void {
    const keyword = this.next().text
    const name = this.name()
    const q = this.qualified(name)
    if (this.accept(';')) return this.forward(q, 'component')
    const def: IdlComponent = {
      name,
      description: '',
      bases: [],
      attributes: [],
      methods: [],
      ports: [],
      needs: []
    }
    const needs: string[] = []
    if (this.accept(':')) {
      const b = this.scoped()
      const base = this.entity(b, 'component')
      if (base) def.bases.push(`${SEP}::${base.q}`)
      else this.warn(first, `${q}: base ${keyword} ${b} not found`)
    }
    if (this.accept('supports'))
      for (const s of this.scopedList()) {
        const iface = this.entity(s, 'interface')
        if (iface?.kind !== 'interface') {
          this.warn(first, `${q}: supported interface ${s} not found`)
          continue
        }
        def.methods.push(...structuredClone(iface.def.messages))
        needs.push(...iface.needs)
      }
    this.expect('{')
    this.forward(q, 'component')
    this.scope.push(name)
    while (!this.accept('}')) {
      const f = this.peek()
      if (!f) this.fail(undefined, "'}'")
      const anns = this.annotations()
      const t = this.peek()!
      if (t.text === 'attribute' || t.text === 'readonly') {
        const a = this.attributeDecl(f)
        for (const n of a.names)
          def.attributes.push({ name: n, type: a.type, description: a.description, readonly: a.readonly })
        needs.push(...a.refs)
      } else if (PORT_WORDS.has(t.text)) this.port(def.ports, def.attributes, f)
      else if (DEFINITION_WORDS.has(t.text)) this.declaration(f, anns)
      else this.fail(t, 'a port or an attribute')
    }
    this.scope.pop()
    def.description = first.doc || this.endTrail() || first.trail
    this.expect(';')
    this.add({ q, simple: name, kind: 'component', def, needs })
  }

  private porttype(): void {
    this.expect('porttype')
    const name = this.name()
    const q = this.qualified(name)
    if (this.accept(';')) return this.forward(q, 'porttype')
    const def = { ports: [] as IdlPort[], attributes: [] as IdlAttribute[] }
    this.expect('{')
    this.decls.set(q, 'porttype')
    this.scope.push(name)
    while (!this.accept('}')) {
      const f = this.peek()
      if (!f) this.fail(undefined, "'}'")
      const anns = this.annotations()
      const t = this.peek()!
      if (t.text === 'attribute' || t.text === 'readonly') {
        const a = this.attributeDecl(f)
        for (const n of a.names)
          def.attributes.push({ name: n, type: a.type, description: a.description, readonly: a.readonly })
      } else if (PORT_WORDS.has(t.text)) this.port(def.ports, def.attributes, f)
      else if (DEFINITION_WORDS.has(t.text)) this.declaration(f, anns)
      else this.fail(t, 'a port or an attribute')
    }
    this.scope.pop()
    this.expect(';')
    this.porttypes.set(q, def)
  }

  /** Port declaration: `provides` and `consumes` are `in` ports, the others `out` ports. */
  private port(ports: IdlPort[], attributes: IdlAttribute[], first: Token): void {
    const keyword = this.next().text
    const multiple = keyword === 'uses' && !!this.accept('multiple')
    const written = this.is('Object') ? this.next().text : this.scoped()
    const name = this.name()
    const end = this.expect(';')
    const description = joinLines(first.doc || end.trail || first.trail, multiple && 'Multiple connections.')
    switch (keyword) {
      case 'provides':
      case 'uses':
        ports.push({
          name,
          role: keyword === 'provides' ? 'in' : 'out',
          interface: this.encode(written),
          description
        })
        return
      case 'emits':
      case 'publishes':
      case 'consumes':
        ports.push({
          name,
          role: keyword === 'consumes' ? 'in' : 'out',
          interface: this.eventConsumer(written, first),
          description: joinLines(
            description,
            keyword === 'publishes' && 'Publishes to any number of consumers.'
          )
        })
        return
    }
    const q = this.lookup(written, this.scope, (k) => k === 'porttype')
    const type = q ? this.porttypes.get(q) : undefined
    if (!type) return this.warn(first, `porttype ${written} not found, port ${name} left out`)
    for (const p of type.ports)
      ports.push({ ...p, name: `${name}_${p.name}`, role: keyword === 'mirrorport' ? flip(p.role) : p.role })
    for (const a of type.attributes) attributes.push({ ...structuredClone(a), name: `${name}_${a.name}` })
  }

  /** Interface receiving events of an eventtype (CCM's `<Event>Consumer`): its reference. */
  private eventConsumer(written: string, first: Token): string {
    const event = this.lookup(written, this.scope, (k) => k === 'type')
    if (!event) this.warn(first, `eventtype ${written} not found`)
    const simple = lastSegment(`::${written}`)
    const q = `${event ?? simple}Consumer`
    if (!this.entities.has(q))
      this.add({
        q,
        simple: `${simple}Consumer`,
        synthetic: true,
        kind: 'interface',
        def: {
          name: '',
          description: `Receives ${simple} events.`,
          messages: [
            {
              name: 'push',
              description: '',
              params: [{ name: 'event', type: this.ref(event ? `::${event}` : written), direction: 'in' }],
              returns: null
            }
          ]
        },
        needs: []
      })
    return `${SEP}::${q}`
  }

  // Types

  private declarators(base: FileTypeRef, several = true): { name: string; type: FileTypeRef }[] {
    const list: { name: string; type: FileTypeRef }[] = []
    do {
      const name = this.name()
      const sizes: number[] = []
      while (this.accept('[')) {
        sizes.push(this.count(']'))
        this.expect(']')
      }
      // `T x[2][3]`: two arrays of three.
      let type = base
      for (const size of sizes.reverse()) type = { kind: 'array', of: type, size }
      list.push({ name, type })
    } while (several && this.accept(','))
    return list
  }

  private typeSpec(): FileTypeRef {
    const t = this.peek()
    if (t?.text === '::') return this.ref(this.scoped())
    if (t?.kind !== 'ident') return this.fail(t, 'a type')
    const word = t.text
    const prim = (name: Extract<FileTypeRef, { kind: 'primitive' }>['name']): FileTypeRef => ({
      kind: 'primitive',
      name
    })
    if (
      CONSTRUCTED.has(word) &&
      this.peek(1)?.kind === 'ident' &&
      ['{', ':', 'switch'].includes(this.peek(2)?.text ?? '')
    )
      return { kind: 'ref', name: `${SEP}::${this.constructed(t, [])}` }
    const template = this.is('<', 1)
    switch (word) {
      case 'unsigned': {
        this.next()
        const rest = this.next().text
        const full = rest === 'long' && this.accept('long') ? 'long long' : rest
        const int = { short: 'uint16', long: 'uint32', 'long long': 'uint64' }[full] as
          IntPrimitive | undefined
        if (!int) this.fail(t, 'an unsigned integer type')
        return prim(int)
      }
      case 'long':
        this.next()
        if (this.accept('long')) return prim('int64')
        if (this.accept('double')) {
          this.warn(t, 'long double imported as float64')
          return prim('float64')
        }
        return prim('int32')
      case 'float':
        this.next()
        return prim('float32')
      case 'double':
        this.next()
        return prim('float64')
      case 'boolean':
        this.next()
        return prim('bool')
      case 'char':
      case 'wchar':
        this.next()
        return prim('char')
      case 'string':
      case 'wstring': {
        this.next()
        if (!this.accept('<')) return prim('string')
        const max = this.bound()
        this.expect('>')
        return { ...prim('string'), ...max }
      }
      case 'sequence': {
        if (!template) break
        this.next()
        this.expect('<')
        const of = this.typeSpec()
        const max = this.accept(',') ? this.bound() : {}
        this.expect('>')
        return of.kind === 'primitive' && of.name === 'uint8'
          ? { ...prim('bytes'), ...max }
          : { kind: 'vector', of, ...max }
      }
      case 'map': {
        if (!template) break
        this.next()
        this.expect('<')
        const key = this.typeSpec()
        this.expect(',')
        const value = this.typeSpec()
        const max = this.accept(',') ? this.bound() : {}
        this.expect('>')
        return { kind: 'map', key, value, ...max }
      }
      case 'fixed':
        this.next()
        if (this.is('<')) this.balanced('<', '>')
        this.warn(t, 'fixed imported as float64')
        return prim('float64')
      case 'any':
      case 'Object':
      case 'ValueBase':
        this.next()
        return { kind: 'ref', name: `${BUILTIN}${word}` }
    }
    const int = INT_TYPES[word]
    if (int) {
      this.next()
      return prim(int)
    }
    if (NOT_TYPES.has(word)) this.fail(t, 'a type')
    return this.ref(this.scoped())
  }

  // Result

  /** Custom primitive standing for references to an interface or component. */
  private objectRef(e: Entity): string {
    const q = `${e.q}${BUILTIN}Ref`
    if (!this.entities.has(q))
      this.add({
        q,
        simple: `${e.simple}Ref`,
        alt: `${e.q.split('::').join('_')}Ref`,
        synthetic: true,
        kind: 'type',
        def: { kind: 'primitive', name: '', description: `Reference to a ${e.simple} object` },
        needs: e.kind === 'interface' ? [e.q] : []
      })
    return q
  }

  private builtin(word: string): string {
    const q = `${BUILTIN}${word}`
    const [simple, description] = BUILTINS[word]!
    if (!this.entities.has(q))
      this.add({
        q,
        simple,
        synthetic: true,
        kind: 'type',
        def: { kind: 'primitive', name: '', description },
        needs: []
      })
    return q
  }

  /** Rewrites every reference of the entities with `type` (type references) and `other`. */
  private rewrite(entities: Entity[], type: (n: string) => string, other: (n: string) => string): void {
    const ref = (t: FileTypeRef): FileTypeRef => mapTypeRef(t, (r) => ({ kind: 'ref', name: type(r.name) }))
    const message = (m: FileMessage): void => {
      for (const p of m.params) p.type = ref(p.type)
      if (m.returns) m.returns = ref(m.returns)
    }
    for (const e of entities) {
      e.needs = e.needs.map(other)
      if (e.kind === 'interface') e.def.messages.forEach(message)
      else if (e.kind === 'component') {
        for (const a of e.def.attributes) a.type = ref(a.type)
        e.def.methods.forEach(message)
        for (const p of e.def.ports) p.interface = p.interface && other(p.interface)
        e.def.bases = e.def.bases.map(other)
      } else if (e.def.kind === 'struct') for (const f of e.def.fields) f.type = ref(f.type)
      else if (e.def.kind === 'union') {
        e.def.discriminator = ref(e.def.discriminator)
        for (const c of e.def.cases) c.type = ref(c.type)
      } else if (e.def.kind === 'alias') e.def.type = ref(e.def.type)
    }
  }

  private finish(missing: string[]): IdlFile {
    // References to qualified names; `?name` when defined nowhere.
    const defined = [...this.entities.values()]
    const isEntity = (k: DeclKind): boolean => k === 'type' || k === 'interface' || k === 'component'
    const target = (encoded: string): string => {
      if (encoded.startsWith(BUILTIN)) return this.builtin(encoded.slice(1))
      const sep = encoded.indexOf(SEP)
      const scope = encoded.slice(0, sep)
      const written = encoded.slice(sep + 1)
      let q = this.lookup(written, scope ? scope.split('::') : [], isEntity)
      if (q !== undefined && !this.entities.has(q)) q = undefined
      if (q === undefined) {
        // Not visible from there: a single definition of that name anywhere.
        const simple = lastSegment(`::${written}`)
        const same = defined.filter((e) => !e.synthetic && lastSegment(`::${e.q}`) === simple)
        if (same.length === 1) q = same[0]!.q
      }
      return q ?? `?${lastSegment(`::${written}`)}`
    }
    const typeTarget = (encoded: string): string => {
      const q = target(encoded)
      const e = this.entities.get(q)
      return e && e.kind !== 'type' ? this.objectRef(e) : q
    }
    this.rewrite(defined, typeTarget, target)

    // Project names: simple names, qualified ones for those several entities share.
    const all = [...this.entities.values()]
    const names = new Map<string, string>()
    const assign = (list: Entity[], reserved: (n: string) => boolean): void => {
      const count = new Map<string, number>()
      for (const e of list) count.set(e.simple, (count.get(e.simple) ?? 0) + 1)
      const taken = new Set<string>()
      for (const e of list) {
        let n = e.simple
        if (count.get(n)! > 1 || reserved(n)) n = e.alt ?? e.q.split('::').join('_')
        while (taken.has(n) || reserved(n)) n += '_'
        taken.add(n)
        names.set(e.q, n)
        if (n !== e.simple && !e.synthetic) this.warnings.push(`${e.q} imported as ${n}`)
      }
    }
    assign(
      all.filter((e) => e.kind !== 'component'),
      isReservedTypeName
    )
    assign(
      all.filter((e) => e.kind === 'component'),
      () => false
    )
    const name = (n: string): string => (n.startsWith('?') ? n.slice(1) : (names.get(n) ?? n))
    this.rewrite(all, name, name)
    for (const e of all) e.def.name = names.get(e.q)!

    const pick = <K extends Entity['kind']>(kind: K) =>
      all.filter((e): e is Extract<Entity, { kind: K }> => e.kind === kind)
    return {
      types: pick('type').map((e) => e.def),
      interfaces: pick('interface').map((e) => e.def),
      components: pick('component').map((e) => ({ ...e.def, needs: [...new Set(e.needs)] })),
      needs: Object.fromEntries(
        all
          .filter((e) => e.kind !== 'component' && e.needs.length)
          .map((e) => [e.def.name, [...new Set(e.needs)]])
      ),
      missing,
      warnings: this.warnings
    }
  }
}

export interface IdlOptions {
  /** Path of the text: includes are looked up next to it. */
  file?: string
  /** Files includes may name, by path. */
  files?: ReadonlyMap<string, string>
}

/** Reads the definitions of an IDL text and the files it includes. */
export function parseIdl(text: string, options: IdlOptions = {}): IdlFile {
  const file = normalizePath(options.file ?? '')
  const pre = new Preprocessor(normalizeFiles(options.files ?? new Map()), file)
  pre.include(file, text)
  return new Parser(pre.out, file, pre.warnings).parse(pre.missing)
}

/** Reads several IDL files (by path) as one: each in turn, but those another one includes. */
export function parseIdlFiles(files: ReadonlyMap<string, string>): IdlFile {
  const all = normalizeFiles(files)
  const included = new Set<string>()
  for (const [path, text] of all)
    for (const m of text.matchAll(INCLUDE_RE)) {
      const found = findInclude(m[1] ?? m[2]!, path, all)
      if (found && found !== path) included.add(found)
    }
  const roots = [...all.keys()].filter((p) => !included.has(p))
  if (!roots.length) roots.push(...all.keys())
  const pre = new Preprocessor(all, roots.length === 1 ? roots[0]! : '')
  for (const r of roots) pre.include(r, all.get(r)!)
  return new Parser(pre.out, roots.length === 1 ? roots[0]! : '', pre.warnings).parse(pre.missing)
}

// Import into a project

function refNames(t: FileTypeRef, into: string[]): void {
  walkTypeRef(t, (n) => {
    if (n.kind === 'ref') into.push(n.name)
  })
}

function messageNames(messages: FileMessage[], into: string[]): void {
  for (const m of messages) {
    for (const p of m.params) refNames(p.type, into)
    if (m.returns) refNames(m.returns, into)
  }
}

function usedNames(e: FileTypeDef | FileInterface, needs: string[] = []): string[] {
  const names = [...needs]
  if ('messages' in e) messageNames(e.messages, names)
  else if (e.kind === 'struct') for (const f of e.fields) refNames(f.type, names)
  else if (e.kind === 'union')
    for (const t of [e.discriminator, ...e.cases.map((c) => c.type)]) refNames(t, names)
  else if (e.kind === 'alias') refNames(e.type, names)
  return names
}

export interface IdlImport {
  /** Types, interfaces and modules to paste; null when the project has them all. */
  clip: Clip | null
  /** Names of the entities already in the project (by name), left as they are. */
  existing: string[]
  /** Names used but defined nowhere, added as custom primitives (empty interfaces for ports). */
  unresolved: string[]
}

const MODULE_GAP = 60
const MODULES_PER_ROW = 4

/**
 * The entities of an IDL file to add to `target`: the interfaces and components named in `only`
 * (all when absent) with the types and interfaces they use, or every type when the file has no
 * interfaces nor components. Components become modules. Types and interfaces `target` has by name
 * are used in place of the file's; names defined nowhere become custom primitives.
 */
export function idlImport(idl: IdlFile, target: Project, only?: string[]): IdlImport {
  const byName = new Map<string, FileTypeDef | FileInterface>(
    [...idl.types, ...idl.interfaces].map((e) => [e.name, e])
  )
  const components = new Map(idl.components.map((c) => [c.name, c]))
  const have = new Map<string, Id>([...target.types, ...target.interfaces].map((e) => [e.name, e.id]))
  const withBehavior = idl.interfaces.length + idl.components.length > 0
  const queue = only
    ? only.filter((n) => !components.has(n) || byName.has(n))
    : (withBehavior ? idl.interfaces : idl.types).map((e) => e.name)
  const componentQueue = only
    ? only.filter((n) => components.has(n))
    : withBehavior
      ? [...components.keys()]
      : []

  // Components reached from the roots, through their bases.
  const pickedComponents = new Set<string>()
  while (componentQueue.length) {
    const name = componentQueue.shift()!
    if (pickedComponents.has(name)) continue
    pickedComponents.add(name)
    const c = components.get(name)!
    componentQueue.push(...c.bases.filter((b) => components.has(b)))
    for (const a of c.attributes) refNames(a.type, queue)
    messageNames(c.methods, queue)
    queue.push(...c.needs)
  }
  const portInterfaces = new Set<string>()
  for (const name of pickedComponents)
    for (const p of components.get(name)!.ports)
      if (p.interface) {
        portInterfaces.add(p.interface)
        queue.push(p.interface)
      }

  // Entities reached from the roots; the project's own ones stop the walk.
  const picked = new Set<string>()
  const existing = new Set<string>()
  const unresolved = new Set<string>()
  while (queue.length) {
    const name = queue.shift()!
    if (picked.has(name) || existing.has(name) || unresolved.has(name)) continue
    if (have.has(name)) existing.add(name)
    else if (byName.has(name)) {
      picked.add(name)
      queue.push(...usedNames(byName.get(name)!, idl.needs[name]))
    } else unresolved.add(name)
  }
  // Undefined names used as types become custom primitives; those only ports use, empty interfaces.
  const usedAsType = new Set<string>()
  for (const name of picked) for (const n of usedNames(byName.get(name)!)) usedAsType.add(n)
  const typeNames: string[] = []
  for (const name of pickedComponents) {
    const c = components.get(name)!
    for (const a of c.attributes) refNames(a.type, typeNames)
    messageNames(c.methods, typeNames)
  }
  for (const n of typeNames) usedAsType.add(n)
  const emptyInterfaces = new Set([...unresolved].filter((n) => portInterfaces.has(n) && !usedAsType.has(n)))

  const ids = new Map<string, Id>([...picked, ...unresolved].map((n) => [n, newId()]))
  const ref = (t: FileTypeRef): TypeRef =>
    mapTypeRef(t, (r) => ({ kind: 'ref', id: ids.get(r.name) ?? have.get(r.name)! }))
  const field = (f: { name: string; type: FileTypeRef; description?: string }): Field => ({
    id: newId(),
    name: f.name,
    type: ref(f.type),
    description: f.description ?? ''
  })
  const message = (m: FileMessage): Message => ({
    id: newId(),
    name: m.name,
    description: m.description ?? '',
    params: m.params.map((p) => ({ ...field(p), direction: p.direction ?? 'in' })),
    returns: m.returns ? ref(m.returns) : null
  })

  const types: TypeDef[] = []
  const interfaces: Interface[] = []
  for (const e of [...idl.types, ...idl.interfaces]) {
    if (!picked.has(e.name)) continue
    const base = { id: ids.get(e.name)!, name: e.name, description: e.description ?? '' }
    if ('messages' in e) interfaces.push({ ...base, messages: e.messages.map(message) })
    else if (e.kind === 'struct')
      types.push({
        ...base,
        kind: 'struct',
        fields: e.fields.map((f) => ({
          ...field(f),
          ...(f.default !== undefined ? { default: f.default } : {})
        }))
      })
    else if (e.kind === 'enum')
      types.push({
        ...base,
        kind: 'enum',
        underlying: e.underlying,
        values: e.values.map((v) => ({ ...v, id: newId() }))
      })
    else if (e.kind === 'union')
      types.push({
        ...base,
        kind: 'union',
        discriminator: ref(e.discriminator),
        cases: e.cases.map((c) => ({ ...field(c), labels: c.labels ?? [], isDefault: c.default ?? false }))
      })
    else if (e.kind === 'bitmask')
      types.push({
        ...base,
        kind: 'bitmask',
        underlying: e.underlying,
        flags: e.flags.map((v) => ({ ...v, id: newId() }))
      })
    else if (e.kind === 'alias') types.push({ ...base, kind: 'alias', type: ref(e.type) })
    else types.push({ ...base, kind: 'primitive' })
  }
  for (const name of unresolved) {
    const base = { id: ids.get(name)!, name, description: 'Not defined in the IDL files' }
    if (emptyInterfaces.has(name)) interfaces.push({ ...base, messages: [] })
    else types.push({ ...base, kind: 'primitive' })
  }

  // Components side by side, in rows.
  const moduleIds = new Map([...pickedComponents].map((n) => [n, newId()]))
  const modules: Module[] = []
  let x = 0
  let y = 0
  let rowHeight = 0
  for (const c of idl.components) {
    if (!pickedComponents.has(c.name)) continue
    const m: Module = {
      id: moduleIds.get(c.name)!,
      name: c.name,
      description: c.description,
      parentId: null,
      metadata: {},
      attributes: c.attributes.map((a) => ({
        ...field(a),
        ...(a.readonly ? { const: true } : {})
      })),
      methods: c.methods.map(message),
      ports: c.ports.map((p) => ({
        id: newId(),
        name: p.name,
        role: p.role,
        interfaceId: (p.interface && (ids.get(p.interface) ?? have.get(p.interface))) || null,
        description: p.description
      })),
      layout: { x: 0, y: 0, width: 0, height: 0 }
    }
    const bases = c.bases.flatMap((b) => moduleIds.get(b) ?? [])
    if (bases.length) m.bases = bases
    if (modules.length && modules.length % MODULES_PER_ROW === 0) {
      x = 0
      y += rowHeight + MODULE_GAP
      rowHeight = 0
    }
    m.layout = { x, y, ...defaultSize(m, target.orientation) }
    x += m.layout.width + MODULE_GAP
    rowHeight = Math.max(rowHeight, m.layout.height)
    modules.push(m)
  }

  const empty = !types.length && !interfaces.length && !modules.length
  return {
    clip: empty
      ? null
      : {
          format: CLIP_FORMAT,
          modules,
          rootParents: Object.fromEntries(modules.map((m) => [m.id, null])),
          links: [],
          notes: [],
          types,
          interfaces,
          names: {}
        },
    existing: [...existing],
    unresolved: [...unresolved]
  }
}
