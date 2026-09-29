// C++17 filters: names, files and namespaces of generated entities, type spellings, literals of
// default values, parameter passing and includes.
import { snake } from './filters'
import type {
  GenContext,
  GenEndpoint,
  GenInterface,
  GenModule,
  GenParam,
  GenSystem,
  GenType,
  GenTypeRef
} from './context'
import { walkTypeRef } from '../model/typeExpr'
import type { Value } from '../model/types'

type Entity = GenType | GenInterface | GenModule | GenSystem

const PRIMITIVES: Record<string, string> = {
  bool: 'bool',
  char: 'char',
  int8: 'std::int8_t',
  int16: 'std::int16_t',
  int32: 'std::int32_t',
  int64: 'std::int64_t',
  uint8: 'std::uint8_t',
  uint16: 'std::uint16_t',
  uint32: 'std::uint32_t',
  uint64: 'std::uint64_t',
  float32: 'float',
  float64: 'double',
  string: 'std::string',
  bytes: 'std::vector<std::uint8_t>'
}

const STD_HEADERS: Record<string, string[]> = {
  string: ['<string>'],
  bytes: ['<cstdint>', '<vector>'],
  array: ['<array>'],
  vector: ['<vector>'],
  list: ['<list>'],
  set: ['<set>'],
  optional: ['<optional>'],
  map: ['<map>']
}

const KEYWORDS = new Set(
  (
    'alignas alignof and and_eq asm auto bitand bitor bool break case catch char char16_t char32_t class ' +
    'compl const constexpr const_cast continue decltype default delete do double dynamic_cast else enum ' +
    'explicit export extern false float for friend goto if inline int long mutable namespace new noexcept ' +
    'not not_eq nullptr operator or or_eq private protected public register reinterpret_cast return short ' +
    'signed sizeof static static_assert static_cast struct switch template this thread_local throw true try ' +
    'typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq'
  ).split(' ')
)

export function cppFilters(ctx: GenContext): Record<string, (...args: never[]) => unknown> {
  const root = snake(ctx.project.ident)
  const depNs = (dependency: string | null): string => (dependency ? snake(dependency) : root)
  const typeByName = new Map<string, GenType>()
  for (const t of ctx.allTypes) if (!typeByName.has(t.name)) typeByName.set(t.name, t)

  const name = (e: Entity): string => (e.entity === 'interface' ? `I${e.name}` : cppId(e.name))

  const namespace = (e: Entity): string => {
    switch (e.entity) {
      case 'type':
      case 'interface':
        return depNs(e.dependency)
      case 'module':
        return [root, ...e.namespace.map(snake)].join('::')
      case 'system':
        return root
    }
  }

  const qualified = (e: Entity): string => `::${namespace(e)}::${name(e)}`

  const header = (e: Entity): string => {
    switch (e.entity) {
      case 'type':
        return `${depNs(e.dependency)}/types/${e.name}.hpp`
      case 'interface':
        return `${depNs(e.dependency)}/interfaces/${name(e)}.hpp`
      case 'module':
        return [root, ...e.namespace.map(snake), `${e.name}.hpp`].join('/')
      case 'system':
        return `${root}/${e.name}.hpp`
    }
  }

  const source = (e: GenModule | GenSystem): string =>
    e.entity === 'module' ? [...e.namespace.map(snake), `${e.name}.cpp`].join('/') : `${e.name}.cpp`

  const refType = (name: string, dependency: string | null): string => `::${depNs(dependency)}::${name}`

  const type = (t: GenTypeRef): string => {
    switch (t.kind) {
      case 'primitive':
        return PRIMITIVES[t.name] ?? t.name
      case 'ref':
        return refType(t.name, t.dependency)
      case 'array':
        return `std::array<${type(t.of)}, ${t.size}>`
      case 'map':
        return `std::map<${type(t.key)}, ${type(t.value)}>`
      default:
        return `std::${t.kind}<${type(t.of)}>`
    }
  }

  /** Cheap to copy: passed and returned by value. */
  const scalar = (t: GenTypeRef, seen = new Set<string>()): boolean => {
    if (t.kind === 'primitive') return t.name !== 'string' && t.name !== 'bytes'
    if (t.kind !== 'ref') return false
    const def = typeByName.get(t.name)
    if (!def || seen.has(t.name)) return false
    seen.add(t.name)
    return def.kind === 'enum' || (def.kind === 'alias' && scalar(def.type, seen))
  }

  /** Type of an input: `T` for scalars, `const T&` otherwise. */
  const input = (t: GenTypeRef): string => (scalar(t) ? type(t) : `const ${type(t)}&`)

  const param = (p: GenParam): string => {
    const n = cppId(p.name)
    if (p.direction !== 'in') return `${type(p.type)}& ${n}`
    return scalar(p.type) ? `${p.const ? 'const ' : ''}${type(p.type)} ${n}` : `const ${type(p.type)}& ${n}`
  }

  const value = (v: Value, t: GenTypeRef): string => {
    switch (t.kind) {
      case 'primitive':
        return primitive(v, t.name)
      case 'optional':
        return v === null ? 'std::nullopt' : value(v, t.of)
      case 'array':
      case 'vector':
      case 'list':
      case 'set':
        return Array.isArray(v) ? `{${v.map((x) => value(x, t.of)).join(', ')}}` : '{}'
      case 'map':
        return v && typeof v === 'object' && !Array.isArray(v)
          ? `{${Object.entries(v)
              .map(([k, x]) => `{${value(mapKey(k, t.key), t.key)}, ${value(x, t.value)}}`)
              .join(', ')}}`
          : '{}'
      case 'ref': {
        const def = typeByName.get(t.name)
        const q = refType(t.name, t.dependency)
        if (!def) return '{}'
        switch (def.kind) {
          case 'enum':
            return typeof v === 'string' ? `${q}::${cppId(v)}` : `static_cast<${q}>(${text(v)})`
          case 'alias':
            return value(v, def.type)
          case 'struct': {
            if (!v || typeof v !== 'object' || Array.isArray(v)) return `${q}{}`
            const fields = def.fields.map((f) =>
              f.name in v ? value(v[f.name]!, f.type) : f.hasDefault ? value(f.default, f.type) : '{}'
            )
            return `${q}{${fields.join(', ')}}`
          }
          case 'primitive':
            // Opaque: a string is taken as a C++ expression.
            return typeof v === 'string' ? v : JSON.stringify(v)
        }
      }
    }
  }

  /** Map keys are strings in YAML / JSON: back to a value of the key type. */
  const mapKey = (k: string, t: GenTypeRef): Value => {
    const resolved = t.kind === 'ref' ? typeByName.get(t.name) : undefined
    if (resolved?.kind === 'alias') return mapKey(k, resolved.type)
    if (t.kind === 'primitive' && t.name !== 'string' && t.name !== 'char' && t.name !== 'bytes')
      return t.name === 'bool' ? k === 'true' : Number(k)
    return k
  }

  const includes = (e: Entity): string[] => {
    const std = new Set<string>()
    const own = new Set<string>()
    const self = header(e)
    const addType = (t: GenTypeRef): void =>
      walkTypeRef(t, (n) => {
        if (n.kind === 'primitive') {
          if (/int/.test(n.name)) std.add('<cstdint>')
          for (const h of STD_HEADERS[n.name] ?? []) std.add(h)
        } else if (n.kind === 'ref') {
          const def = typeByName.get(n.name)
          if (def) own.add(header(def))
        } else for (const h of STD_HEADERS[n.kind] ?? []) std.add(h)
      })
    const addMessage = (m: { params: GenParam[]; returns: GenTypeRef | null }): void => {
      for (const p of m.params) addType(p.type)
      if (m.returns) addType(m.returns)
    }
    const addChildren = (children: GenModule[]): void => {
      for (const c of children) {
        own.add(header(c))
        if (c.abstract) std.add('<memory>')
      }
    }
    switch (e.entity) {
      case 'type':
        if (e.kind === 'struct') for (const f of e.fields) addType(f.type)
        if (e.kind === 'alias') addType(e.type)
        if (e.kind === 'enum') std.add('<cstdint>')
        break
      case 'interface':
        for (const m of e.messages) addMessage(m)
        break
      case 'module':
        for (const a of e.attributes) addType(a.type)
        for (const m of e.methods) addMessage(m)
        for (const b of e.bases) own.add(header(b))
        for (const p of e.ports) {
          if (p.interface) own.add(header(p.interface))
          if (p.interface && p.role === 'out') own.add(`${root}/ports.hpp`)
        }
        addChildren(e.instances)
        break
      case 'system':
        addChildren(e.instances)
        break
    }
    own.delete(self)
    return [...[...std].sort(), ...[...own].sort().map((h) => `<${h}>`)]
  }

  /** Expression reaching a port from the scope that wires it: `core().sensor().out()`. */
  const endpoint = (x: GenEndpoint): string =>
    [...x.via.map((c) => `${accessor(c)}()`), `${cppId(x.port)}()`].join('.')

  return {
    cpp_name: (e: Entity) => name(e),
    cpp_namespace: (e: Entity) => namespace(e),
    cpp_qualified: (e: Entity) => qualified(e),
    cpp_header: (e: Entity) => header(e),
    cpp_source: (e: GenModule | GenSystem) => source(e),
    cpp_type: (t: GenTypeRef | null) => (t ? type(t) : 'void'),
    cpp_primitive: (name: string) => PRIMITIVES[name] ?? name,
    cpp_input: (t: GenTypeRef) => input(t),
    cpp_param: (p: GenParam) => param(p),
    cpp_params: (ps: GenParam[]) => ps.map(param).join(', '),
    cpp_args: (ps: GenParam[]) => ps.map((p) => cppId(p.name)).join(', '),
    cpp_scalar: (t: GenTypeRef) => scalar(t),
    cpp_value: (v: Value, t: GenTypeRef) => value(v, t),
    cpp_includes: (e: Entity) => includes(e),
    cpp_endpoint: (x: GenEndpoint) => endpoint(x),
    cpp_id: (s: string) => cppId(s),
    cpp_member: (s: string) => `${KEYWORDS.has(s) ? `${s}Member` : s}_`,
    cpp_accessor: (s: string) => accessor(s),
    cpp_string: (s: string) => cppString(s)
  }
}

/** A name usable as a C++ identifier: keywords get a trailing `_`. */
export const cppId = (name: string): string => (KEYWORDS.has(name) ? `${name}_` : name)

/** Accessor of a child module: `Sensor` → `sensor`, `Operator` → `operatorModule` (not a keyword). */
function accessor(name: string): string {
  const a = name.charAt(0).toLowerCase() + name.slice(1)
  return KEYWORDS.has(a) ? `${a}Module` : a
}

/** A plain value as written in the file. */
const text = (v: Value): string => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v))

function primitive(v: Value, name: string): string {
  switch (name) {
    case 'bool':
      return v ? 'true' : 'false'
    case 'char':
      return typeof v === 'string' ? `'${escape(v.charAt(0) || '\0', "'")}'` : text(v)
    case 'string':
      return cppString(typeof v === 'string' ? v : JSON.stringify(v))
    case 'bytes':
      return Array.isArray(v) ? `{${v.map(text).join(', ')}}` : '{}'
    case 'float32':
    case 'float64': {
      const n = Number(v)
      const s = Number.isInteger(n) ? `${n}.0` : String(n)
      return name === 'float32' ? `${s}f` : s
    }
    case 'int64':
      return `${text(v)}LL`
    case 'uint64':
      return `${text(v)}ULL`
    case 'uint32':
      return `${text(v)}U`
    default:
      return text(v)
  }
}

function escape(s: string, quote: string): string {
  let out = ''
  for (const c of s) {
    const code = c.codePointAt(0)!
    if (c === '\\' || c === quote) out += `\\${c}`
    else if (c === '\n') out += '\\n'
    else if (c === '\t') out += '\\t'
    else if (c === '\r') out += '\\r'
    else if (code < 0x20) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += c
  }
  return out
}

export const cppString = (s: string): string => `"${escape(s, '"')}"`

/** Names of the project that are C++ keywords. */
export function cppWarnings(ctx: GenContext): string[] {
  const warnings: string[] = []
  const check = (n: string, where: string): void => {
    if (KEYWORDS.has(n)) warnings.push(`${where}: '${n}' is a C++ keyword, renamed in the generated code`)
  }
  for (const t of ctx.types) {
    check(t.name, t.name)
    if (t.kind === 'struct') for (const f of t.fields) check(f.name, `${t.name}.${f.name}`)
    if (t.kind === 'enum') for (const v of t.values) check(v.name, `${t.name}.${v.name}`)
  }
  for (const i of ctx.interfaces)
    for (const m of i.messages) {
      check(m.name, `${i.name}.${m.name}`)
      for (const p of m.params) check(p.name, `${i.name}.${m.name}(${p.name})`)
    }
  for (const m of ctx.modules) {
    for (const n of new Set([m.name, m.name.charAt(0).toLowerCase() + m.name.slice(1)])) check(n, m.path)
    for (const a of m.attributes) check(a.name, `${m.path}.${a.name}`)
    for (const x of m.methods) {
      check(x.name, `${m.path}.${x.name}`)
      for (const p of x.params) check(p.name, `${m.path}.${x.name}(${p.name})`)
    }
    for (const p of m.ports) check(p.name, `${m.path}:${p.name}`)
  }
  return warnings
}
