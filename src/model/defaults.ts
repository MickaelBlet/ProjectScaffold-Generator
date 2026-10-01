// Default values of struct fields and module attributes: YAML values checked against their type.
import YAML from 'yaml'
import { INT_RANGES, type Id, type Primitive, type TypeDef, type TypeRef, type Value } from './types'

const INT_RE = /^([-+]?)(0x[0-9a-f]+|\d+)$/i
const FLOAT_RE = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i

/** Default value written as a one-line YAML flow literal: `{ x: 1, y: [ 2, 3 ] }`. */
export function formatValue(v: Value): string {
  return YAML.stringify(v, { collectionStyle: 'flow', lineWidth: 0 }).trim()
}

/** Reads a YAML flow literal; integers too large for a number are kept as decimal text. Throws on bad syntax. */
export function parseValue(text: string): Value {
  const norm = (v: unknown): Value => {
    if (typeof v === 'bigint')
      return v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER ? Number(v) : String(v)
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, e]) => [k, norm(e)]))
    return v as Value
  }
  return norm(YAML.parse(text, { intAsBigInt: true }))
}

const isMapping = (v: Value): v is { [key: string]: Value } =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const describe = (v: Value): string =>
  v === null
    ? 'null'
    : Array.isArray(v)
      ? 'a list'
      : typeof v === 'object'
        ? 'a mapping'
        : `${typeof v === 'string' ? 'text' : typeof v} ${formatValue(v)}`

function toBigInt(v: Value): bigint | null {
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : null
  if (typeof v !== 'string') return null
  const m = INT_RE.exec(v)
  if (!m) return null
  const n = BigInt(m[2]!)
  return m[1] === '-' ? -n : n
}

function primitiveError(v: Value, name: Primitive): string | null {
  switch (name) {
    case 'bool':
      return typeof v === 'boolean' ? null : `Expected true or false, got ${describe(v)}`
    case 'float32':
    case 'float64':
      return typeof v === 'number' && Number.isFinite(v) ? null : `Expected a number, got ${describe(v)}`
    case 'char':
      return typeof v === 'string' && [...v].length === 1
        ? null
        : `Expected one character, got ${describe(v)}`
    case 'string':
    case 'bytes':
      if (typeof v === 'string') return null
      return v !== null && typeof v !== 'object'
        ? `Expected text, got ${describe(v)} (quote it: "${String(v)}")`
        : `Expected text, got ${describe(v)}`
    default: {
      const n = toBigInt(v)
      if (n === null) return `Expected an integer, got ${describe(v)}`
      const [min, max] = INT_RANGES[name]
      return n < min || n > max ? `${n} does not fit in ${name}` : null
    }
  }
}

/** Follows aliases; null for a deleted type or a cyclic alias. */
function resolve(
  t: TypeRef,
  types: ReadonlyMap<Id, TypeDef>,
  seen = new Set<Id>()
): TypeRef | TypeDef | null {
  if (t.kind !== 'ref') return t
  const def = types.get(t.id)
  if (!def || seen.has(def.id)) return null
  if (def.kind !== 'alias') return def
  return resolve(def.type, types, seen.add(def.id))
}

/**
 * Whether a struct field of type `t` may be left out of a value: `optional` (null) or a struct
 * whose fields may all be left out.
 */
function implicit(t: TypeRef, types: ReadonlyMap<Id, TypeDef>, seen = new Set<Id>()): boolean {
  const r = resolve(t, types)
  if (r?.kind === 'optional') return true
  if (r?.kind !== 'struct' || seen.has(r.id)) return false
  seen.add(r.id)
  return r.fields.every((f) => f.default !== undefined || implicit(f.type, types, seen))
}

/** Values offered as a choice (bool, enum, and null for optional), or null for a free literal. */
export function valueChoices(t: TypeRef, types: readonly TypeDef[]): Value[] | null {
  const byId = new Map(types.map((d) => [d.id, d]))
  let r = resolve(t, byId)
  const optional = r?.kind === 'optional'
  if (r?.kind === 'optional') r = resolve(r.of, byId)
  const list =
    r?.kind === 'primitive' && r.name === 'bool'
      ? [true, false]
      : r?.kind === 'enum'
        ? r.values.map((v) => v.name)
        : null
  return list && optional ? [...list, null] : list
}

/** Flag names of a bitmask type (its values are lists of them), else null. */
export function valueFlags(t: TypeRef, types: readonly TypeDef[]): string[] | null {
  const r = resolve(t, new Map(types.map((d) => [d.id, d])))
  return r?.kind === 'bitmask' ? r.flags.map((f) => f.name) : null
}

/** Value showing the shape of a type, for a placeholder: zeros, first enum values, empty containers. */
export function valueExample(t: TypeRef, types: readonly TypeDef[]): Value {
  const byId = new Map(types.map((d) => [d.id, d]))
  const example = (t: TypeRef, seen: ReadonlySet<Id>): Value => {
    switch (t.kind) {
      case 'primitive':
        return t.name === 'bool'
          ? false
          : t.name === 'char'
            ? 'a'
            : t.name === 'string' || t.name === 'bytes'
              ? ''
              : 0
      case 'optional':
        return null
      case 'array':
        return Array.from({ length: Math.min(t.size, 4) }, () => example(t.of, seen))
      case 'vector':
      case 'list':
      case 'set':
        return []
      case 'map':
        return {}
      case 'ref': {
        const def = byId.get(t.id)
        if (!def || seen.has(def.id)) return null
        const inner = new Set(seen).add(def.id)
        switch (def.kind) {
          case 'primitive':
            return def.name
          case 'alias':
            return example(def.type, inner)
          case 'enum':
            return def.values[0]?.name ?? null
          case 'bitmask':
            return def.flags[0] ? [def.flags[0].name] : []
          case 'union': {
            const c = def.cases[0]
            return c ? { [c.name]: example(c.type, inner) } : null
          }
          case 'struct':
            return Object.fromEntries(def.fields.map((f) => [f.name, f.default ?? example(f.type, inner)]))
        }
      }
    }
  }
  return example(t, new Set())
}

/**
 * Problems of `v` as a value of type `t`, each prefixed with where it is in the value. Values of
 * custom primitives are opaque: passed as is to generators.
 */
export function valueErrors(v: Value, t: TypeRef, types: readonly TypeDef[]): string[] {
  const byId = new Map(types.map((d) => [d.id, d]))
  const errors: string[] = []
  const at = (path: string, message: string): void => void errors.push(path ? `${path}: ${message}` : message)

  /** Map keys are text in YAML: read them as the key type. */
  const key = (k: string, t: TypeRef): Value => {
    const r = resolve(t, byId)
    if (r?.kind !== 'primitive') return k
    if (r.name === 'bool') return k === 'true' ? true : k === 'false' ? false : k
    if ((r.name === 'float32' || r.name === 'float64') && FLOAT_RE.test(k)) return Number(k)
    return k
  }

  const check = (v: Value, t: TypeRef, path: string, seen: ReadonlySet<Id>): void => {
    switch (t.kind) {
      case 'primitive': {
        const e = primitiveError(v, t.name)
        if (e) at(path, e)
        else if (t.max !== undefined && typeof v === 'string') {
          // Bytes: one per character, as generators write them.
          const size = t.name === 'bytes' ? [...v].length : new TextEncoder().encode(v).length
          if (size > t.max) at(path, `${size} bytes, more than the bound of ${t.max}`)
        }
        return
      }
      case 'optional':
        if (v !== null) check(v, t.of, path, seen)
        return
      case 'array':
      case 'vector':
      case 'list':
      case 'set': {
        if (!Array.isArray(v)) return at(path, `Expected a list, got ${describe(v)}`)
        if (t.kind === 'array' && v.length !== t.size)
          at(path, `Expected ${t.size} elements, got ${v.length}`)
        if (t.kind !== 'array' && t.max !== undefined && v.length > t.max)
          at(path, `${v.length} elements, more than the bound of ${t.max}`)
        v.forEach((e, i) => check(e, t.of, `${path}[${i}]`, seen))
        if (t.kind === 'set') {
          const texts = v.map(formatValue)
          for (const [i, s] of texts.entries()) if (texts.indexOf(s) < i) at(path, `Duplicate element ${s}`)
        }
        return
      }
      case 'map':
        if (!isMapping(v)) return at(path, `Expected a mapping, got ${describe(v)}`)
        if (t.max !== undefined && Object.keys(v).length > t.max)
          at(path, `${Object.keys(v).length} entries, more than the bound of ${t.max}`)
        for (const [k, e] of Object.entries(v)) {
          check(key(k, t.key), t.key, `${path}[${k}]`, seen)
          check(e, t.value, `${path}[${k}]`, seen)
        }
        return
      case 'ref': {
        const def = byId.get(t.id)
        // Deleted types are reported on their own.
        if (!def || def.kind === 'primitive') return
        if (def.kind === 'alias') {
          if (!seen.has(def.id)) check(v, def.type, path, new Set(seen).add(def.id))
          return
        }
        if (def.kind === 'enum') {
          if (typeof v !== 'string' || !def.values.some((x) => x.name === v))
            at(
              path,
              `Expected a value of ${def.name} (${def.values.map((x) => x.name).join(', ')}), got ${describe(v)}`
            )
          return
        }
        if (def.kind === 'bitmask') {
          const names = def.flags.map((x) => x.name)
          if (!Array.isArray(v)) return at(path, `Expected a list of ${def.name} flags, got ${describe(v)}`)
          v.forEach((e, i) => {
            if (typeof e !== 'string' || !names.includes(e))
              at(`${path}[${i}]`, `Expected a flag of ${def.name} (${names.join(', ')}), got ${describe(e)}`)
            else if (v.indexOf(e) < i) at(path, `Duplicate flag ${e}`)
          })
          return
        }
        if (def.kind === 'union') {
          const entries = isMapping(v) ? Object.entries(v) : []
          const [name, e] = entries[0] ?? []
          if (entries.length !== 1 || name === undefined || e === undefined)
            return at(path, `Expected a mapping of one ${def.name} case (case: value), got ${describe(v)}`)
          const c = def.cases.find((x) => x.name === name)
          if (!c) return at(path, `Unknown case '${name}' of ${def.name}`)
          check(e, c.type, path ? `${path}.${name}` : name, seen)
          return
        }
        if (!isMapping(v)) return at(path, `Expected a mapping of ${def.name} fields, got ${describe(v)}`)
        const names = new Set(def.fields.map((f) => f.name))
        for (const k of Object.keys(v)) if (!names.has(k)) at(path, `Unknown field '${k}' of ${def.name}`)
        for (const f of def.fields) {
          const e = Object.hasOwn(v, f.name) ? v[f.name] : undefined
          if (e !== undefined) check(e, f.type, path ? `${path}.${f.name}` : f.name, seen)
          else if (f.default === undefined && !implicit(f.type, byId))
            at(path, `Missing field '${f.name}' of ${def.name}`)
        }
      }
    }
  }
  check(v, t, '', new Set())
  return errors
}
