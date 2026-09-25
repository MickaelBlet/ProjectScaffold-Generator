// Textual type expressions, e.g. `map<string, vector<uint16>>`, `array<Vec3, 4>`.
import { CONTAINERS, PRIMITIVES, type Primitive, type TypeRef, type TypeRefOf } from './types'
import type { FileTypeRef } from './schema'

export class TypeExprError extends Error {}

const PRIMITIVE_SET = new Set<string>(PRIMITIVES)
const RESERVED = new Set<string>([...PRIMITIVES, ...CONTAINERS])

export function isReservedTypeName(name: string): boolean {
  return RESERVED.has(name)
}

type Token = { kind: 'ident' | 'int' | 'punct'; text: string; pos: number }

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  const re = /\s+|([A-Za-z_][A-Za-z0-9_]*)|(\d+)|([<>,])/y
  while (re.lastIndex < src.length) {
    const pos = re.lastIndex
    const m = re.exec(src)
    if (!m) throw new TypeExprError(`Unexpected character '${src[pos]}' at ${pos}`)
    if (m[1]) tokens.push({ kind: 'ident', text: m[1], pos })
    else if (m[2]) tokens.push({ kind: 'int', text: m[2], pos })
    else if (m[3]) tokens.push({ kind: 'punct', text: m[3], pos })
  }
  return tokens
}

/** Parse a type expression into a name-based type reference. */
export function parseTypeExpr(src: string): FileTypeRef {
  const tokens = tokenize(src)
  let i = 0
  const peek = (): Token | undefined => tokens[i]
  const expect = (text: string): void => {
    const t = tokens[i]
    if (!t || t.text !== text)
      throw new TypeExprError(`Expected '${text}'${t ? ` but found '${t.text}'` : ' at end'}`)
    i++
  }

  const parseType = (): FileTypeRef => {
    const t = tokens[i++]
    if (!t) throw new TypeExprError('Expected a type')
    if (t.kind !== 'ident') throw new TypeExprError(`Expected a type but found '${t.text}'`)
    const name = t.text
    if (PRIMITIVE_SET.has(name)) return { kind: 'primitive', name: name as Primitive }
    switch (name) {
      case 'vector':
      case 'list':
      case 'set':
      case 'optional': {
        expect('<')
        const of = parseType()
        expect('>')
        return { kind: name, of }
      }
      case 'array': {
        expect('<')
        const of = parseType()
        expect(',')
        const n = tokens[i++]
        if (!n || n.kind !== 'int') throw new TypeExprError('Expected array size')
        const size = Number(n.text)
        if (size <= 0) throw new TypeExprError('Array size must be > 0')
        expect('>')
        return { kind: 'array', of, size }
      }
      case 'map': {
        expect('<')
        const key = parseType()
        expect(',')
        const value = parseType()
        expect('>')
        return { kind: 'map', key, value }
      }
      default:
        return { kind: 'ref', name }
    }
  }

  const result = parseType()
  const rest = peek()
  if (rest) throw new TypeExprError(`Unexpected '${rest.text}'`)
  return result
}

/** Print a name-based type reference. */
export function printTypeExpr(t: FileTypeRef): string {
  switch (t.kind) {
    case 'primitive':
      return t.name
    case 'ref':
      return t.name
    case 'array':
      return `array<${printTypeExpr(t.of)}, ${t.size}>`
    case 'map':
      return `map<${printTypeExpr(t.key)}, ${printTypeExpr(t.value)}>`
    default:
      return `${t.kind}<${printTypeExpr(t.of)}>`
  }
}

/** Rewrite the user-type references of a type tree. */
export function mapTypeRef<A, B>(
  t: TypeRefOf<A>,
  f: (ref: { kind: 'ref' } & A) => { kind: 'ref' } & B
): TypeRefOf<B> {
  switch (t.kind) {
    case 'primitive':
      return t
    case 'ref':
      return f(t)
    case 'array':
      return { kind: 'array', of: mapTypeRef(t.of, f), size: t.size }
    case 'map':
      return { kind: 'map', key: mapTypeRef(t.key, f), value: mapTypeRef(t.value, f) }
    default:
      return { kind: t.kind, of: mapTypeRef(t.of, f) }
  }
}

/** Visit every node of a type tree. */
export function walkTypeRef<R>(t: TypeRefOf<R>, visit: (node: TypeRefOf<R>) => void): void {
  visit(t)
  switch (t.kind) {
    case 'array':
    case 'vector':
    case 'list':
    case 'set':
    case 'optional':
      walkTypeRef(t.of, visit)
      break
    case 'map':
      walkTypeRef(t.key, visit)
      walkTypeRef(t.value, visit)
      break
  }
}

/** Print an id-based type reference, resolving ids with `nameOf`. */
export function printTypeRef(t: TypeRef, nameOf: (id: string) => string | undefined): string {
  return printTypeExpr(mapTypeRef(t, (r) => ({ kind: 'ref', name: nameOf(r.id) ?? '<deleted>' })))
}

/** Parse a type expression into an id-based reference, resolving names with `idOf`. */
export function parseTypeRef(src: string, idOf: (name: string) => string | undefined): TypeRef {
  return mapTypeRef(parseTypeExpr(src), (r) => {
    const id = idOf(r.name)
    if (!id) throw new TypeExprError(`Unknown type '${r.name}'`)
    return { kind: 'ref', id }
  })
}
