import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { fromFile } from '@/model/serialize'
import { validate } from '@/model/validate'
import type { EnumDef, Project, StructDef } from '@/model/types'

const example = YAML.parse(readFileSync('examples/robot.scaffold.yaml', 'utf8'))
const load = (): Project => fromFile(structuredClone(example))
const messages = (p: Project, severity = 'error') =>
  validate(p)
    .filter((pr) => pr.severity === severity)
    .map((pr) => pr.message)

const type = <T>(p: Project, name: string) => p.types.find((t) => t.name === name) as T
const link = (p: Project, name: string) => p.links.find((l) => l.name === name)!
const mod = (p: Project, name: string) => p.modules.find((m) => m.name === name)!

describe('validate', () => {
  it('flags enum values out of range', () => {
    const p = load()
    type<EnumDef>(p, 'Mode').values[0]!.value = 256
    expect(messages(p)).toEqual(["Enum 'Mode': Idle = 256 does not fit in uint8"])
    type<EnumDef>(p, 'Mode').underlying = 'int8'
    type<EnumDef>(p, 'Mode').values[0]!.value = -128
    expect(messages(p)).toEqual(["Enum 'Mode': Fault = 255 does not fit in int8"])
  })

  it('flags duplicate names in lists', () => {
    const p = load()
    const s = type<StructDef>(p, 'Vec3')
    s.fields[1]!.name = 'x'
    link(p, 'sensor_to_logger').name = 'sensor_to_controller'
    expect(messages(p)).toEqual([
      "Struct 'Vec3': duplicate field 'x'",
      "Duplicate link name 'sensor_to_controller'"
    ])
  })

  it('flags invalid map keys', () => {
    const p = load()
    const vec3 = type<StructDef>(p, 'Vec3')
    type<StructDef>(p, 'Pose').fields[1]!.type = {
      kind: 'map',
      key: { kind: 'ref', id: vec3.id },
      value: { kind: 'primitive', name: 'bool' }
    }
    expect(messages(p)).toEqual(['Pose.orientation: map key must be a primitive or an enum'])
  })

  it('accepts enum map keys through aliases, warns on float keys', () => {
    const p = load()
    const mode = type<EnumDef>(p, 'Mode')
    p.types.push({
      id: 'alias-mode',
      kind: 'alias',
      name: 'M',
      description: '',
      type: { kind: 'ref', id: mode.id }
    })
    type<StructDef>(p, 'Pose').fields[1]!.type = {
      kind: 'set',
      of: { kind: 'ref', id: 'alias-mode' }
    }
    expect(messages(p)).toEqual([])
    type<StructDef>(p, 'Pose').fields[1]!.type = { kind: 'set', of: { kind: 'primitive', name: 'float32' } }
    expect(messages(p, 'warning')).toEqual(['Pose.orientation: floating-point set key'])
  })

  it('flags structs containing themselves by value', () => {
    const p = load()
    const pose = type<StructDef>(p, 'Pose')
    const vec3 = type<StructDef>(p, 'Vec3')
    vec3.fields.push({
      id: 'f',
      name: 'p',
      description: '',
      type: { kind: 'optional', of: { kind: 'ref', id: pose.id } }
    })
    expect(messages(p)).toEqual([
      "Struct 'Vec3' contains itself by value (use vector, list, map or set to break the cycle)",
      "Struct 'Pose' contains itself by value (use vector, list, map or set to break the cycle)"
    ])
    vec3.fields.at(-1)!.type = { kind: 'vector', of: { kind: 'ref', id: pose.id } }
    expect(messages(p)).toEqual([])
  })

  it('flags cyclic aliases', () => {
    const p = load()
    p.types.push({ id: 'a', kind: 'alias', name: 'A', description: '', type: { kind: 'ref', id: 'b' } })
    p.types.push({ id: 'b', kind: 'alias', name: 'B', description: '', type: { kind: 'ref', id: 'a' } })
    expect(messages(p)).toEqual(["Alias 'A' is cyclic", "Alias 'B' is cyclic"])
  })

  it('flags deleted type references', () => {
    const p = load()
    p.types = p.types.filter((t) => t.name !== 'Vec3')
    expect(messages(p)).toEqual(['Pose.position: references a deleted type'])
  })

  it('requires bidirectional links for messages with return values', () => {
    const p = load()
    link(p, 'operator_to_core').constraints.direction = 'unidirectional'
    expect(messages(p)).toEqual([
      "Link 'operator_to_core' is unidirectional but Control.setMode returns a value",
      "Link 'operator_to_core' is unidirectional but requires an ack"
    ])
  })

  it('checks port roles and interfaces on links', () => {
    const p = load()
    const l = link(p, 'sensor_to_logger')
    ;[l.from, l.to] = [l.to, l.from]
    expect(messages(p)).toEqual([
      "Link 'sensor_to_logger': source port 'in' must be an 'out' port",
      "Link 'sensor_to_logger': target port 'out' must be an 'in' port"
    ])
    const p2 = load()
    mod(p2, 'Logger').ports[0]!.interfaceId = p2.interfaces.find((i) => i.name === 'Control')!.id
    expect(messages(p2)).toEqual(["Link 'sensor_to_logger': ports use different interfaces"])
  })

  it('warns on inconsistent constraints', () => {
    const p = load()
    const c = link(p, 'sensor_to_controller').constraints
    c.ack.timeoutMs = 10
    c.remote.transport = 'udp'
    link(p, 'operator_to_core').constraints.remote.transport = undefined
    expect(messages(p, 'warning')).toEqual([
      "Link 'sensor_to_controller': ack timeout set but ack not required",
      "Link 'sensor_to_controller': transport set but link is not remote",
      "Link 'operator_to_core' is remote but has no transport"
    ])
  })

  it('warns on ports without interface', () => {
    const p = load()
    mod(p, 'Operator').ports.push({ id: 'x', name: 'spare', role: 'out', interfaceId: null, description: '' })
    expect(messages(p, 'warning')).toEqual(['Operator:spare has no interface'])
  })
})
