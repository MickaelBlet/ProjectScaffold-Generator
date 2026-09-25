import { describe, expect, it } from 'vitest'
import { parseTypeExpr, parseTypeRef, printTypeExpr, printTypeRef, TypeExprError } from '@/model/typeExpr'

describe('type expressions', () => {
  const cases = [
    'uint8',
    'string',
    'Vec3',
    'vector<uint16>',
    'list<optional<int64>>',
    'set<Mode>',
    'array<float64, 4>',
    'map<string, vector<uint16>>',
    'map<uint32, map<string, array<Vec3, 3>>>'
  ]
  it.each(cases)('round-trips %s', (src) => {
    expect(printTypeExpr(parseTypeExpr(src))).toBe(src)
  })

  it('parses structure', () => {
    expect(parseTypeExpr('map<string, list<uint8>>')).toEqual({
      kind: 'map',
      key: { kind: 'primitive', name: 'string' },
      value: { kind: 'list', of: { kind: 'primitive', name: 'uint8' } }
    })
  })

  it('tolerates whitespace', () => {
    expect(printTypeExpr(parseTypeExpr('  map < string ,vector<  uint8 > >  '))).toBe(
      'map<string, vector<uint8>>'
    )
  })

  it.each([
    '',
    'vector',
    'vector<>',
    'map<string>',
    'array<uint8>',
    'array<uint8, 0>',
    'uint8 x',
    'vector<uint8',
    'a$b'
  ])('rejects %j', (src) => {
    expect(() => parseTypeExpr(src)).toThrow(TypeExprError)
  })

  it('resolves user types to ids', () => {
    const ids: Record<string, string> = { Vec3: 'id-vec3' }
    const ref = parseTypeRef('vector<Vec3>', (n) => ids[n])
    expect(ref).toEqual({ kind: 'vector', of: { kind: 'ref', id: 'id-vec3' } })
    expect(printTypeRef(ref, (id) => (id === 'id-vec3' ? 'Vec3' : undefined))).toBe('vector<Vec3>')
    expect(() => parseTypeRef('Unknown', () => undefined)).toThrow(/Unknown type/)
  })
})
