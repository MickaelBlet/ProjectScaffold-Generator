import { describe, expect, it } from 'vitest'
import { formatValue, parseValue, valueChoices, valueErrors, valueExample } from '@/model/defaults'
import type { TypeDef, TypeRef } from '@/model/types'

const prim = (name: 'bool' | 'char' | 'uint8' | 'int8' | 'uint64' | 'float32' | 'string'): TypeRef => ({
  kind: 'primitive',
  name
})
const ref = (id: string): TypeRef => ({ kind: 'ref', id })

const types: TypeDef[] = [
  {
    id: 'Mode',
    kind: 'enum',
    name: 'Mode',
    description: '',
    underlying: 'uint8',
    values: [
      { id: 'i', name: 'Idle', value: 0 },
      { id: 'r', name: 'Run', value: 1 }
    ]
  },
  {
    id: 'Vec',
    kind: 'struct',
    name: 'Vec',
    description: '',
    fields: [
      { id: 'x', name: 'x', type: prim('float32'), description: '' },
      { id: 'y', name: 'y', type: prim('float32'), description: '' },
      { id: 'z', name: 'z', type: prim('float32'), description: '', default: 0 }
    ]
  },
  {
    id: 'Opts',
    kind: 'struct',
    name: 'Opts',
    description: '',
    fields: [
      { id: 'o', name: 'mode', type: ref('Mode'), description: '', default: 'Idle' },
      { id: 'n', name: 'note', type: { kind: 'optional', of: prim('string') }, description: '' }
    ]
  },
  {
    id: 'Pose',
    kind: 'struct',
    name: 'Pose',
    description: '',
    fields: [
      { id: 'p', name: 'position', type: ref('Vec'), description: '' },
      { id: 'q', name: 'opts', type: ref('Opts'), description: '' }
    ]
  },
  { id: 'Speed', kind: 'alias', name: 'Speed', description: '', type: prim('float32') },
  { id: 'Duration', kind: 'primitive', name: 'Duration', description: '' }
]
const errors = (v: unknown, t: TypeRef) => valueErrors(parseValue(String(v)), t, types)

describe('default values', () => {
  it('reads and writes YAML flow literals', () => {
    expect(parseValue('{x: 1, y: [2, 0x10], s: "5"}')).toEqual({ x: 1, y: [2, 16], s: '5' })
    expect(parseValue('18446744073709551615')).toBe('18446744073709551615')
    expect(formatValue({ x: 1, s: '5', m: 'Idle', n: null })).toBe('{ x: 1, s: "5", m: Idle, n: null }')
    expect(() => parseValue('{x: 1')).toThrow()
  })

  it('checks scalars', () => {
    expect(errors('true', prim('bool'))).toEqual([])
    expect(errors('1', prim('bool'))).toEqual(['Expected true or false, got number 1'])
    expect(errors('256', prim('uint8'))).toEqual(['256 does not fit in uint8'])
    expect(errors('-0x80', prim('int8'))).toEqual([])
    expect(errors('18446744073709551615', prim('uint64'))).toEqual([])
    expect(errors('1.5', prim('uint8'))).toEqual(['Expected an integer, got number 1.5'])
    expect(errors('ab', prim('char'))).toEqual(['Expected one character, got text ab'])
    expect(errors('5', prim('string'))).toEqual(['Expected text, got number 5 (quote it: "5")'])
    expect(errors('Run', ref('Mode'))).toEqual([])
    expect(errors('Stop', ref('Mode'))).toEqual(['Expected a value of Mode (Idle, Run), got text Stop'])
    expect(errors('fast', ref('Speed'))).toEqual(['Expected a number, got text fast'])
  })

  it('reports missing and unknown struct fields, with their path', () => {
    expect(errors('{x: 1, y: 2}', ref('Vec'))).toEqual([])
    expect(errors('{x: 1, w: 2}', ref('Vec'))).toEqual([
      "Unknown field 'w' of Vec",
      "Missing field 'y' of Vec"
    ])
    // Fields with a default, optional fields and fully defaulted structs may be left out.
    expect(errors('{position: {x: 1, y: 2}}', ref('Pose'))).toEqual([])
    expect(errors('{position: {x: 1, y: a}, opts: {mode: Stop}}', ref('Pose'))).toEqual([
      'position.y: Expected a number, got text a',
      'opts.mode: Expected a value of Mode (Idle, Run), got text Stop'
    ])
    expect(errors('[1, 2]', ref('Vec'))).toEqual(['Expected a mapping of Vec fields, got a list'])
  })

  it('checks containers', () => {
    const array: TypeRef = { kind: 'array', of: prim('uint8'), size: 3 }
    expect(errors('[1, 2]', array)).toEqual(['Expected 3 elements, got 2'])
    expect(errors('[1, 2, 300]', array)).toEqual(['[2]: 300 does not fit in uint8'])
    expect(errors('[1, 1]', { kind: 'set', of: prim('uint8') })).toEqual(['Duplicate element 1'])
    const map: TypeRef = { kind: 'map', key: ref('Mode'), value: prim('float32') }
    expect(errors('{Idle: 1, Stop: 2}', map)).toEqual([
      '[Stop]: Expected a value of Mode (Idle, Run), got text Stop'
    ])
    expect(errors('{1: a}', { kind: 'map', key: prim('uint8'), value: prim('string') })).toEqual([])
    expect(errors('null', { kind: 'optional', of: ref('Vec') })).toEqual([])
    expect(errors('[{x: 1}]', { kind: 'vector', of: ref('Vec') })).toEqual(["[0]: Missing field 'y' of Vec"])
  })

  it('keeps custom primitive values opaque', () => {
    expect(errors('std::chrono::milliseconds(10)', ref('Duration'))).toEqual([])
    expect(errors('{ms: 10}', ref('Duration'))).toEqual([])
  })

  it('offers choices and examples', () => {
    expect(valueChoices(ref('Mode'), types)).toEqual(['Idle', 'Run'])
    expect(valueChoices({ kind: 'optional', of: prim('bool') }, types)).toEqual([true, false, null])
    expect(valueChoices(ref('Vec'), types)).toBeNull()
    expect(formatValue(valueExample(ref('Pose'), types))).toBe(
      '{ position: { x: 0, y: 0, z: 0 }, opts: { mode: Idle, note: null } }'
    )
  })
})
