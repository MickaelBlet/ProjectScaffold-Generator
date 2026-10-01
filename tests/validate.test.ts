import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { fromFile } from '@/model/serialize'
import { validate } from '@/model/validate'
import type { EnumDef, Project, StructDef } from '@/model/types'

const example = YAML.parse(readFileSync('examples/robot.scaffold.yaml', 'utf8'))
/** The example, with the types and interfaces of its dependencies made its own: edited and checked here. */
const load = (): Project => {
  const p = fromFile(structuredClone(example))
  for (const e of [...p.types, ...p.interfaces]) delete e.dependency
  p.dependencies = []
  return p
}
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
    // Another type: the default no longer fits.
    delete type<StructDef>(p, 'Pose').fields[1]!.default
    type<StructDef>(p, 'Pose').fields[1]!.type = {
      kind: 'map',
      key: { kind: 'ref', id: vec3.id },
      value: { kind: 'primitive', name: 'bool' }
    }
    expect(messages(p)).toEqual(['Pose.orientation: map key must be a primitive or an enum'])
  })

  it('bounds strings, bytes and containers only', () => {
    const p = load()
    delete type<StructDef>(p, 'Pose').fields[1]!.default
    type<StructDef>(p, 'Pose').fields[1]!.type = {
      kind: 'vector',
      of: { kind: 'primitive', name: 'string', max: 8 },
      max: 4
    }
    expect(messages(p)).toEqual([])
    type<StructDef>(p, 'Pose').fields[1]!.type = { kind: 'primitive', name: 'int32', max: 8 }
    expect(messages(p)).toEqual(['Pose.orientation: int32 cannot be bounded'])
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
    // Another type: the default no longer fits.
    delete type<StructDef>(p, 'Pose').fields[1]!.default
    type<StructDef>(p, 'Pose').fields[1]!.type = {
      kind: 'set',
      of: { kind: 'ref', id: 'alias-mode' }
    }
    expect(messages(p)).toEqual([])
    // Another type: the default no longer fits.
    delete type<StructDef>(p, 'Pose').fields[1]!.default
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
    const c = link(p, 'operator_to_core').constraints
    c.direction = 'unidirectional'
    c.ack.required = true
    expect(messages(p)).toEqual([
      "Link 'operator_to_core' is unidirectional but Control.setMode returns a value",
      "Link 'operator_to_core' is unidirectional but Control.raw has out parameters",
      "Link 'operator_to_core' is unidirectional but requires an ack"
    ])
  })

  it('requires bidirectional links for messages with out parameters', () => {
    const p = load()
    const control = p.interfaces.find((i) => i.name === 'Control')!
    control.messages[0]!.returns = null
    link(p, 'operator_to_core').constraints.direction = 'unidirectional'
    link(p, 'operator_to_core').constraints.ack.required = false
    expect(messages(p)).toEqual([
      "Link 'operator_to_core' is unidirectional but Control.raw has out parameters"
    ])
    control.messages[1]!.params[0]!.direction = 'in'
    expect(messages(p)).toEqual([])
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

  it('warns on undeclared transports', () => {
    const p = load()
    link(p, 'operator_to_core').constraints.remote.transport = 'zenoh'
    expect(messages(p, 'warning')).toEqual(["Link 'operator_to_core': unknown transport 'zenoh'"])
    p.transports.push('zenoh')
    expect(messages(p, 'warning')).toEqual([])
  })

  it('checks transport settings', () => {
    const p = load()
    const core = link(p, 'operator_to_core').constraints.remote
    core.settings = { server: { port: 5000 }, name: 'seg', options: { qos: '1' } }
    const other = link(p, 'sensor_to_controller').constraints.remote
    other.settings = { path: 'x' }
    expect(messages(p, 'warning')).toEqual([
      "Link 'sensor_to_controller': transport settings set but link is not remote",
      "Link 'operator_to_core': name does not apply to transport 'tcp'"
    ])
    Object.assign(other, { enabled: true, transport: 'http' })
    delete core.settings.name
    expect(messages(p)).toEqual(["Link 'sensor_to_controller': path 'x' must start with '/'"])
    other.settings = { path: '/x', server: { host: '127.0.0.1', port: 5000 } }
    expect(messages(p, 'warning')).toEqual([
      "Link 'operator_to_core' listens on tcp 127.0.0.1:5000, as link 'sensor_to_controller'"
    ])
    p.remoteDefaults = { server: { host: '0.0.0.0' } }
    expect(messages(p, 'warning')).toEqual([])
    Object.assign(core, { transport: 'shm', settings: { name: '/seg' } })
    Object.assign(other, { transport: 'shm', settings: { name: 'seg' } })
    expect(messages(p, 'warning')).toEqual([
      "Link 'operator_to_core' uses the shared memory 'seg' of link 'sensor_to_controller'"
    ])
    core.settings = { name: 'a/b' }
    expect(messages(p)).toEqual(["Link 'operator_to_core': shared memory name 'a/b' is not valid"])
  })

  it('accepts custom primitives as map keys', () => {
    const p = load()
    p.types.push({ id: 'uuid', kind: 'primitive', name: 'Uuid', description: '' })
    // Another type: the default no longer fits.
    delete type<StructDef>(p, 'Pose').fields[1]!.default
    type<StructDef>(p, 'Pose').fields[1]!.type = {
      kind: 'map',
      key: { kind: 'ref', id: 'uuid' },
      value: { kind: 'primitive', name: 'bool' }
    }
    expect(messages(p)).toEqual([])
  })

  it('warns on ports without interface', () => {
    const p = load()
    mod(p, 'Operator').ports.push({ id: 'x', name: 'spare', role: 'out', interfaceId: null, description: '' })
    expect(messages(p, 'warning')).toEqual(['Operator:spare has no interface'])
  })

  it('checks port roles of links between a container and its content', () => {
    const p = load()
    const parent = mod(p, 'Operator')
    const child = { ...structuredClone(parent), id: 'child', name: 'child', parentId: parent.id }
    child.ports = [
      { id: 'ci', name: 'ci', role: 'in', interfaceId: null, description: '' },
      { id: 'co', name: 'co', role: 'out', interfaceId: null, description: '' }
    ]
    parent.ports.push(
      { id: 'pi', name: 'pi', role: 'in', interfaceId: null, description: '' },
      { id: 'po', name: 'po', role: 'out', interfaceId: null, description: '' }
    )
    p.modules.push(child)
    const add = (name: string, from: [string, string], to: [string, string]) =>
      p.links.push({
        ...structuredClone(p.links[0]!),
        id: name,
        name,
        from: { moduleId: from[0], portId: from[1] },
        to: { moduleId: to[0], portId: to[1] }
      })
    add('down', [parent.id, 'pi'], ['child', 'ci'])
    add('up', ['child', 'co'], [parent.id, 'po'])
    expect(messages(p)).toEqual([])
    add('wrong', [parent.id, 'po'], ['child', 'ci'])
    expect(messages(p)).toEqual(["Link 'wrong': source port 'po' must be an 'in' port"])
  })
})

describe('validate module attributes', () => {
  it('flags duplicate attributes and deleted types', () => {
    const p = load()
    const controller = mod(p, 'Controller')
    controller.attributes.push({ ...controller.attributes[0]!, id: 'dup' })
    expect(messages(p)).toContain("Core.Controller: duplicate attribute 'mode'")
    controller.attributes = [{ id: 'a', name: 'x', type: { kind: 'ref', id: 'gone' }, description: '' }]
    expect(messages(p)).toContain('Core.Controller.x: references a deleted type')
  })

  it('checks defaults of attributes and struct fields against their type', () => {
    const p = load()
    expect(messages(p)).toEqual([])
    mod(p, 'Controller').attributes[0]!.default = 'Nope'
    const vec = type<StructDef>(p, 'Vec3')
    vec.fields[0]!.default = 1.5
    vec.fields[1]!.default = 'up'
    expect(messages(p)).toEqual([
      'Vec3.y default: Expected a number, got text up',
      'Core.Controller.mode default: Expected a value of Mode (Idle, Run, Fault), got text Nope'
    ])
  })
})

describe('validate module methods', () => {
  it('flags duplicate methods and parameters, names clashing with attributes and deleted types', () => {
    const p = load()
    const controller = mod(p, 'Controller')
    const [setMode] = controller.methods
    controller.methods.push({ ...setMode!, id: 'dup' })
    expect(messages(p)).toContain("Core.Controller: duplicate method 'setMode'")
    controller.methods = [
      {
        ...setMode!,
        name: 'mode',
        params: [...setMode!.params, { ...setMode!.params[0]!, id: 'p2' }],
        returns: { kind: 'ref', id: 'gone' }
      }
    ]
    expect(messages(p)).toEqual([
      "Core.Controller: 'mode' is both an attribute and a method",
      "Core.Controller.mode: duplicate parameter 'mode'",
      'Core.Controller.mode returns: references a deleted type'
    ])
  })

  it('flags const out parameters', () => {
    const p = load()
    mod(p, 'Controller').methods[0]!.params[0]!.direction = 'inout'
    expect(messages(p)).toEqual(['Core.Controller.setMode(mode): an inout parameter cannot be const'])
  })

  it('flags static const methods', () => {
    const p = load()
    const instances = mod(p, 'Controller').methods.find((x) => x.name === 'instances')!
    instances.const = true
    expect(messages(p)).toEqual(['Core.Controller.instances: a static method cannot be const'])
  })
})
