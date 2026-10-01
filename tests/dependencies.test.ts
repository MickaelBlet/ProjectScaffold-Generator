import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import YAML from 'yaml'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { fromFile, toFile } from '@/model/serialize'
import {
  addDependency,
  applyDependencyRenames,
  dependencyName,
  dependencyOf,
  detachDependency,
  placeModule,
  refreshDependencies,
  removeDependency,
  removePlaced,
  type DependencyResult
} from '@/model/dependencies'
import { diffRenames, resolveRelative } from '@/model/sync'
import { defaultConstraints, importedSize, modulePath } from '@/model/project'
import { validate } from '@/model/validate'
import type { Project } from '@/model/types'

const jsonSchema = JSON.parse(readFileSync('schema/scaffold.schema.json', 'utf8'))
const load = (yaml: string): Project => fromFile(YAML.parse(yaml))
const read = (name: string): Project => fromFile(YAML.parse(readFileSync(`examples/${name}`, 'utf8')))
const byPath = (p: Project, path: string) => p.modules.find((m) => modulePath(p, m.id) === path)!
const errors = (p: Project) =>
  validate(p)
    .filter((pr) => pr.severity === 'error')
    .map((pr) => pr.message)
const f32 = '{ kind: primitive, name: float32 }'

const units = load(`
schemaVersion: 1
project: { name: Units }
types:
  - { kind: alias, name: Meters, type: ${f32} }
interfaces: []
modules: []
links: []
`)

/** Common, saved in `lib/common.scaffold.yaml`, depends on Units saved next to it. */
const common = load(`
schemaVersion: 1
project: { name: Common }
types:
  - kind: struct
    name: Vec3
    fields: [{ name: x, type: { kind: ref, name: Meters } }]
interfaces:
  - name: Telemetry
    messages: [{ name: publish, params: [{ name: at, type: { kind: ref, name: Vec3 } }], returns: null }]
modules: []
links: []
dependencies:
  - name: Units
    file: units.scaffold.yaml
    types:
      - { kind: alias, name: Meters, type: ${f32} }
    interfaces: []
`)

/** A project with a module whose port uses `Telemetry`, bound after the dependency is added. */
function station(): Project {
  return load(`
schemaVersion: 1
project: { name: Station }
types: []
interfaces: []
modules: [{ name: Monitor, ports: [] }]
links: []
`)
}

function withCommon(p: Project = station()): { p: Project; r: DependencyResult } {
  let r!: DependencyResult
  const q = produce(p, (d) => {
    r = addDependency(d, common, 'lib/common.scaffold.yaml', 'station.scaffold.yaml')
    const telemetry = d.interfaces.find((i) => i.name === 'Telemetry')
    if (telemetry)
      d.modules[0]!.ports.push({
        id: 'in',
        name: 'telemetry',
        role: 'in',
        interfaceId: telemetry.id,
        description: ''
      })
  })
  return { p: q, r }
}

const robot = read('robot.scaffold.yaml')

/** Station linking its Monitor to Robot's Core.Sensor, placed from robot.scaffold.yaml. */
function monitor(): { p: Project; placedId: string; r: DependencyResult } {
  let placedId = ''
  let r!: DependencyResult
  const p = produce(station(), (d) => {
    const placed = placeModule(
      d,
      robot,
      'robot.scaffold.yaml',
      byPath(robot, 'Core.Sensor').id,
      { x: 500, y: 40 },
      'station.scaffold.yaml'
    )
    placedId = placed.id!
    r = placed.result
    const telemetry = d.interfaces.find((i) => i.name === 'Telemetry')!
    d.modules[0]!.ports.push({
      id: 'in',
      name: 'telemetry',
      role: 'in',
      interfaceId: telemetry.id,
      description: ''
    })
    const sensor = d.dependencies.find((x) => x.name === 'Robot')!.modules[0]!
    d.links.push({
      id: 'l',
      name: 'sensor_to_monitor',
      description: '',
      from: { moduleId: sensor.id, portId: sensor.ports[0]!.id },
      to: { moduleId: d.modules[0]!.id, portId: 'in' },
      constraints: defaultConstraints()
    })
  })
  return { p, placedId, r }
}

describe('dependencies', () => {
  it('names dependencies after the project', () => {
    expect(dependencyName('Robot')).toBe('Robot')
    expect(dependencyName('my robot-2')).toBe('my_robot_2')
    expect(dependencyName('2d nav')).toBe('_2d_nav')
    expect(dependencyName('!!')).toBe('Other')
  })

  it('rebases nested dependency files', () => {
    expect(resolveRelative('lib/common.yaml', 'units.yaml')).toBe('lib/units.yaml')
    expect(resolveRelative('lib/common.yaml', '../units.yaml')).toBe('units.yaml')
    expect(resolveRelative('../shared/common.yaml', './x/units.yaml')).toBe('../shared/x/units.yaml')
  })

  it('adds a dependency with the dependencies it uses', () => {
    const { p, r } = withCommon()
    expect(r.conflicts).toEqual([])
    expect(p.dependencies.map((x) => [x.name, x.file, x.uses, x.indirect])).toEqual([
      ['Common', 'lib/common.scaffold.yaml', ['Units'], false],
      ['Units', 'lib/units.scaffold.yaml', [], true]
    ])
    const vec3 = p.types.find((t) => t.name === 'Vec3')!
    const meters = p.types.find((t) => t.name === 'Meters')!
    expect(dependencyOf(p, vec3.id)?.name).toBe('Common')
    expect(dependencyOf(p, meters.id)?.name).toBe('Units')
    expect(vec3.kind === 'struct' && vec3.fields[0]!.type).toEqual({ kind: 'ref', id: meters.id })
    expect(errors(p)).toEqual([])
  })

  it('round-trips through the file format, matching the JSON Schema', () => {
    const { p } = withCommon()
    const file = toFile(p, { editor: false })
    expect(file.types).toEqual([])
    expect(file.dependencies?.map((x) => x.name)).toEqual(['Common', 'Units'])
    const ajv = new Ajv2020({ strict: false })
    expect(ajv.validate(jsonSchema, file), JSON.stringify(ajv.errors)).toBe(true)
    const back = fromFile(file)
    expect(toFile(back, { editor: false })).toEqual(file)
    expect(back.modules[0]!.ports[0]!.interfaceId).toBe(back.interfaces[0]!.id)
  })

  it('copies the constants of a dependency, follows their renames, drops removed ones', () => {
    const constants = produce(common, (d) => {
      d.consts.push(
        {
          id: 'g',
          name: 'Gravity',
          description: '',
          type: { kind: 'primitive', name: 'float32' },
          value: 9.81
        },
        {
          id: 'o',
          name: 'Origin',
          description: '',
          type: { kind: 'ref', id: d.types[0]!.id },
          value: { x: 1 }
        }
      )
    })
    const p = produce(station(), (d) => void addDependency(d, constants, 'common.scaffold.yaml', null))
    const dep = p.dependencies.find((x) => x.name === 'Common')!
    expect(p.consts.map((c) => [c.name, c.dependency])).toEqual([
      ['Gravity', dep.id],
      ['Origin', dep.id]
    ])
    expect(errors(p)).toEqual([])
    // File: under the dependency, matching the JSON Schema.
    const file = toFile(p, { editor: false })
    expect(file.constants).toBeUndefined()
    expect(file.dependencies?.[0]?.constants?.map((c) => c.name)).toEqual(['Gravity', 'Origin'])
    const ajv = new Ajv2020({ strict: false })
    expect(ajv.validate(jsonSchema, file), JSON.stringify(ajv.errors)).toBe(true)
    expect(toFile(fromFile(file), { editor: false })).toEqual(file)
    // Renamed in the dependency, then removed there.
    const renamed = produce(constants, (d) => void (d.consts[0]!.name = 'G'))
    const q = produce(p, (d) =>
      applyDependencyRenames(d, 'common.scaffold.yaml', diffRenames(constants, renamed)!)
    )
    expect(q.consts.map((c) => c.name)).toEqual(['G', 'Origin'])
    const removed = produce(renamed, (d) => void (d.consts = []))
    const r = produce(q, (d) => void refreshDependencies(d, new Map([[dep.id, removed]]), null))
    expect(r.consts).toEqual([])
  })

  it('keeps ids when reloaded', () => {
    const { p } = withCommon()
    const again = fromFile(toFile(p, { editor: true }), p)
    expect(again.types.map((t) => t.id)).toEqual(p.types.map((t) => t.id))
    expect(again.interfaces.map((t) => t.id)).toEqual(p.interfaces.map((t) => t.id))
  })

  it('reports names defined both here and in a dependency', () => {
    const file = toFile(withCommon().p, { editor: false })
    file.types.push({ kind: 'primitive', name: 'Vec3' })
    expect(() => fromFile(file)).toThrow(/Duplicate type name 'Vec3'/)
  })

  it('takes over an own entity with the same definition, skips a different one', () => {
    const same = produce(station(), (d) => void addDependency(d, units, 'units.scaffold.yaml', null))
    const detached = produce(same, (d) => void detachDependency(d, d.dependencies[0]!.id))
    expect(detached.types[0]!.dependency).toBeUndefined()
    const again = withCommon(detached)
    expect(again.r.conflicts).toEqual([])
    expect(again.p.types.find((t) => t.name === 'Meters')!.id).toBe(detached.types[0]!.id)

    const other = produce(detached, (d) => {
      const t = d.types[0]!
      if (t.kind === 'alias') t.type = { kind: 'primitive', name: 'float64' }
    })
    const { p, r } = withCommon(other)
    expect(r.conflicts).toEqual(['Units: Meters is already defined differently here'])
    // The rest is taken all the same.
    expect(p.types.find((t) => t.name === 'Meters')!.dependency).toBeUndefined()
    expect(dependencyOf(p, p.types.find((t) => t.name === 'Vec3')!.id)?.name).toBe('Common')
  })

  it('shares an entity two dependencies define the same way, and hands it over on removal', () => {
    // Other defines Meters like Units does.
    const other = load(`
schemaVersion: 1
project: { name: Other }
types:
  - { kind: alias, name: Meters, type: ${f32} }
interfaces: []
modules: []
links: []
`)
    let r!: DependencyResult
    const p = produce(withCommon().p, (d) => void (r = addDependency(d, other, 'other.scaffold.yaml', null)))
    expect(r.conflicts).toEqual([])
    const dep = (name: string) => p.dependencies.find((x) => x.name === name)!
    expect(dep('Other').shared).toEqual(['Meters'])
    expect(p.types.filter((t) => t.name === 'Meters')).toHaveLength(1)
    expect(errors(p)).toEqual([])
    const file = toFile(p, { editor: false })
    expect(file.dependencies?.find((x) => x.name === 'Other')).toMatchObject({
      shared: ['Meters'],
      types: []
    })
    expect(toFile(fromFile(file), { editor: false })).toEqual(file)

    // Without Common, Units goes; Meters stays, with Other.
    const q = produce(p, (d) => {
      d.modules[0]!.ports = []
      expect(removeDependency(d, dep('Common').id)).toEqual([])
    })
    expect(q.dependencies.map((x) => [x.name, x.shared])).toEqual([['Other', []]])
    expect(dependencyOf(q, q.types.find((t) => t.name === 'Meters')!.id)?.name).toBe('Other')
  })

  it('refuses a dependency using this project', () => {
    let r!: DependencyResult
    produce(
      station(),
      (d) => void (r = addDependency(d, common, 'lib/common.scaffold.yaml', 'lib/units.scaffold.yaml'))
    )
    expect(r.conflicts).toEqual(['lib/units.scaffold.yaml: uses this project (cycle)'])
  })

  it('refreshes: renamed entities keep their id, removed ones still used stay as own ones', () => {
    const { p } = withCommon()
    const telemetryId = p.interfaces[0]!.id
    const changed = produce(common, (d) => {
      d.interfaces[0]!.name = 'Telemetry2'
      d.types = d.types.filter((t) => t.name !== 'Vec3')
      d.interfaces[0]!.messages[0]!.params = []
    })
    let r!: DependencyResult
    const q = produce(p, (d) => {
      r = refreshDependencies(d, new Map([[d.dependencies[0]!.id, changed]]), null)
    })
    expect(r.renamed).toEqual(['Telemetry → Telemetry2'])
    expect(q.interfaces[0]).toMatchObject({ id: telemetryId, name: 'Telemetry2' })
    expect(q.types.some((t) => t.name === 'Vec3')).toBe(false)
    expect(errors(q)).toEqual([])
  })

  it('leaves a project unchanged when refreshed from the same content', () => {
    const { p } = monitor()
    const q = produce(p, (d) => {
      refreshDependencies(d, new Map([[d.dependencies.find((x) => x.name === 'Robot')!.id, robot]]), null)
    })
    expect(q).toBe(p)
  })

  it('follows renames made in an open dependency', () => {
    const { p } = withCommon()
    const renamed = produce(common, (d) => void (d.types[0]!.name = 'Vector'))
    const q = produce(p, (d) =>
      applyDependencyRenames(d, 'common.scaffold.yaml', diffRenames(common, renamed)!)
    )
    expect(q.types.find((t) => t.dependency === q.dependencies[0]!.id)!.name).toBe('Vector')
  })

  it('removes a dependency only when unused, detaches it otherwise', () => {
    const { p } = withCommon()
    let blockers: string[] = []
    produce(p, (d) => void (blockers = removeDependency(d, d.dependencies[1]!.id)))
    expect(blockers).toEqual(['dependency Common', 'Meters'])
    produce(p, (d) => void (blockers = removeDependency(d, d.dependencies[0]!.id)))
    expect(blockers).toEqual(['Telemetry'])

    const own = produce(p, (d) => void detachDependency(d, d.dependencies[0]!.id))
    expect(own.dependencies.map((x) => [x.name, x.indirect])).toEqual([['Units', false]])
    expect(errors(own)).toEqual([])

    const unused = produce(p, (d) => {
      d.modules[0]!.ports = []
      removeDependency(d, d.dependencies[0]!.id)
    })
    expect(unused.dependencies).toEqual([])
    expect(unused.types).toEqual([])
  })

  it('checks that dependency entities only use their dependencies', () => {
    const { p } = withCommon()
    const q = produce(p, (d) => void (d.dependencies[0]!.uses = []))
    expect(errors(q)).toEqual(["Vec3.x: 'Meters' is not in its dependency or the dependencies it uses"])
  })
})

describe('placed modules', () => {
  it('places a module, depending on its project instead of copying its interfaces', () => {
    const { p, placedId, r } = monitor()
    expect(r.conflicts).toEqual([])
    expect(p.dependencies.map((x) => [x.name, x.file, x.uses, x.indirect])).toEqual([
      ['Robot', 'robot.scaffold.yaml', ['Common'], false],
      ['Common', 'common.scaffold.yaml', [], true]
    ])
    expect(p.dependencies[0]!.modules[0]).toMatchObject({
      id: placedId,
      path: 'Core.Sensor',
      position: { x: 500, y: 40 },
      ports: [{ name: 'out', role: 'out', interface: 'Telemetry' }]
    })
    expect(p.interfaces.every((i) => dependencyOf(p, i.id)?.name === 'Common')).toBe(true)
    expect(p.types.find((t) => t.name === 'Primitive')!.dependency).toBe(p.dependencies[0]!.id)
    expect(modulePath(p, placedId)).toBe('Robot/Core.Sensor')
    expect(errors(p)).toEqual([])
  })

  it('reuses the dependency and an already placed module', () => {
    const { p, placedId } = monitor()
    let again: string | null = null
    let other: string | null = null
    const q = produce(p, (d) => {
      const place = (path: string) =>
        placeModule(d, robot, 'robot.scaffold.yaml', byPath(robot, path).id, { x: 0, y: 0 }, null).id
      again = place('Core.Sensor')
      other = place('Operator')
    })
    expect(again).toBe(placedId)
    expect(other).not.toBe(placedId)
    expect(q.dependencies.map((x) => x.name)).toEqual(['Robot', 'Common'])
    expect(q.dependencies[0]!.modules.map((m) => m.path)).toEqual(['Core.Sensor', 'Operator'])
  })

  it('round-trips links to placed modules, matching the JSON Schema', () => {
    const { p } = monitor()
    const file = toFile(p, { editor: true })
    expect(file.dependencies?.[0]).toMatchObject({
      name: 'Robot',
      file: 'robot.scaffold.yaml',
      uses: ['Common'],
      modules: [{ module: 'Core.Sensor', ports: [{ name: 'out', role: 'out', interface: 'Telemetry' }] }]
    })
    expect(file.links[0]!.from).toEqual({ project: 'Robot', module: 'Core.Sensor', port: 'out' })
    expect(file.editor?.dependencies).toEqual({ Robot: { 'Core.Sensor': { x: 500, y: 40 } } })
    expect(toFile(fromFile(file), { editor: true })).toEqual(file)
    const check = new Ajv2020({ allErrors: true }).compile(jsonSchema)
    expect(check(file), JSON.stringify(check.errors)).toBe(true)
    // Exports keep the placed modules (generators need them), not their positions.
    const exported = toFile(p, { editor: false })
    expect(exported.dependencies).toEqual(file.dependencies)
    expect(exported.editor).toBeUndefined()
  })

  it('round-trips moved names of placed ports', () => {
    const p = produce(monitor().p, (d) => {
      d.dependencies[0]!.modules[0]!.ports[0]!.label = 'bottom'
    })
    const file = toFile(p, { editor: true })
    expect(file.editor?.dependencies).toEqual({
      Robot: { 'Core.Sensor': { x: 500, y: 40, labels: { out: 'bottom' } } }
    })
    expect(fromFile(file).dependencies[0]!.modules[0]!.ports[0]!.label).toBe('bottom')
  })

  it('round-trips the size of resized placed modules, kept at least their minimum', () => {
    const p = produce(monitor().p, (d) => {
      d.dependencies[0]!.modules[0]!.size = { width: 300, height: 10 }
    })
    const file = toFile(p, { editor: true })
    expect(file.editor?.dependencies).toEqual({
      Robot: { 'Core.Sensor': { x: 500, y: 40, width: 300, height: 10 } }
    })
    const q = fromFile(file)
    expect(q.dependencies[0]!.modules[0]!.size).toEqual({ width: 300, height: 10 })
    const size = importedSize(q.dependencies[0]!.modules[0]!, q.orientation)
    expect(size.width).toBe(300)
    expect(size.height).toBeGreaterThan(10)
  })

  it('reports unknown dependencies and modules not placed on load', () => {
    const file = toFile(monitor().p, { editor: false })
    file.links[0]!.from = { project: 'Nav', module: 'Core.Sensor', port: 'out' }
    expect(() => fromFile(file)).toThrow("unknown dependency 'Nav'")
    file.links[0]!.from = { project: 'Robot', module: 'Operator', port: 'cmd' }
    expect(() => fromFile(file)).toThrow("module 'Operator' is not placed from dependency 'Robot'")
  })

  it('flags interfaces not defined here and links between two placed modules', () => {
    const { p, placedId } = monitor()
    const q = produce(p, (d) => {
      d.dependencies[0]!.modules[0]!.ports[0]!.interface = 'Stream'
    })
    expect(errors(q)).toEqual([
      "Link 'sensor_to_monitor': Robot/Core.Sensor:out uses interface 'Stream', not defined in this project"
    ])
    const r = produce(p, (d) => {
      d.links[0]!.to = { moduleId: placedId, portId: d.dependencies[0]!.modules[0]!.ports[0]!.id }
    })
    expect(errors(r)).toContain(
      "Link 'sensor_to_monitor' joins two imported modules: one end must be in this project"
    )
  })

  it('refreshes ports by name, dropping links to removed ports', () => {
    const { p } = monitor()
    const robotId = p.dependencies[0]!.id
    const portId = p.dependencies[0]!.modules[0]!.ports[0]!.id
    const refresh = (source: Project): { q: Project; r: DependencyResult } => {
      let r!: DependencyResult
      const q = produce(p, (d) => void (r = refreshDependencies(d, new Map([[robotId, source]]), null)))
      return { q, r }
    }
    const added = produce(robot, (d) => {
      byPath(d, 'Core.Sensor').ports.push({
        id: 'x',
        name: 'status',
        role: 'out',
        interfaceId: null,
        description: ''
      })
    })
    const { q, r } = refresh(added)
    expect(r).toEqual({ conflicts: [], detached: [], renamed: [], missing: [] })
    expect(q.dependencies[0]!.modules[0]!.ports.map((pt) => pt.name)).toEqual(['out', 'status'])
    expect(q.dependencies[0]!.modules[0]!.ports[0]!.id).toBe(portId)
    expect(q.links).toHaveLength(1)

    const gone = produce(robot, (d) => void (byPath(d, 'Core.Sensor').ports[0]!.name = 'data'))
    expect(refresh(gone).q.links).toEqual([])

    const deleted = produce(robot, (d) => void (d.modules = d.modules.filter((m) => m.name !== 'Sensor')))
    const s = refresh(deleted)
    expect(s.r.missing).toEqual(["Robot: module 'Core.Sensor' no longer exists in robot.scaffold.yaml"])
    expect(s.q.links).toHaveLength(1)
  })

  it('detects modules renamed or moved while this project was closed', () => {
    const { p } = monitor()
    const robotId = p.dependencies[0]!.id
    let r!: DependencyResult
    const renamed = produce(robot, (d) => void (byPath(d, 'Core.Sensor').name = 'Lidar'))
    const q = produce(p, (d) => void (r = refreshDependencies(d, new Map([[robotId, renamed]]), null)))
    expect(r.renamed).toEqual(['module Core.Sensor → Core.Lidar'])
    expect(q.dependencies[0]!.modules[0]!.path).toBe('Core.Lidar')
    expect(q.links).toHaveLength(1)

    const moved = produce(robot, (d) => void (byPath(d, 'Core.Sensor').parentId = null))
    const s = produce(p, (d) => void (r = refreshDependencies(d, new Map([[robotId, moved]]), null)))
    expect(r.renamed).toEqual(['module Core.Sensor → Sensor'])
    expect(s.dependencies[0]!.modules[0]!.path).toBe('Sensor')
  })

  it('follows an interface renamed in the project it comes from', () => {
    const { p } = monitor()
    const commonFile = read('common.scaffold.yaml')
    const renamed = produce(
      commonFile,
      (d) => void (d.interfaces.find((i) => i.name === 'Telemetry')!.name = 'Stream')
    )
    const q = produce(p, (d) =>
      applyDependencyRenames(d, 'common.scaffold.yaml', diffRenames(commonFile, renamed)!)
    )
    expect(q.interfaces.map((i) => i.name)).toContain('Stream')
    expect(q.dependencies[0]!.modules[0]!.ports[0]!.interface).toBe('Stream')
    expect(errors(q)).toEqual([])
  })

  it('removes placed modules with their links, keeping the dependency', () => {
    const { p, placedId } = monitor()
    let blockers: string[] = []
    produce(p, (d) => void (blockers = removeDependency(d, d.dependencies[0]!.id)))
    expect(blockers).toEqual(['module Core.Sensor, placed on the canvas'])
    const q = produce(p, (d) => removePlaced(d, new Set([placedId])))
    expect(q.dependencies.map((x) => [x.name, x.modules.length])).toEqual([
      ['Robot', 0],
      ['Common', 0]
    ])
    expect(q.links).toEqual([])
    expect(q.modules).toHaveLength(1)
  })
})

describe('dependency examples', () => {
  it('robot depends on common, up to date', () => {
    expect(errors(robot)).toEqual([])
    const fresh = produce(robot, (d) => {
      expect(
        refreshDependencies(d, new Map([[d.dependencies[0]!.id, read('common.scaffold.yaml')]]), null)
      ).toEqual({
        conflicts: [],
        detached: [],
        renamed: [],
        missing: []
      })
    })
    expect(fresh).toBe(robot)
  })

  it('station depends on common and robot, links to a placed module, up to date', () => {
    const station = read('station.scaffold.yaml')
    expect(errors(station)).toEqual([])
    const sources = new Map([
      [station.dependencies[0]!.id, read('common.scaffold.yaml')],
      [station.dependencies[1]!.id, robot]
    ])
    const fresh = produce(station, (d) => {
      expect(refreshDependencies(d, sources, 'station.scaffold.yaml')).toEqual({
        conflicts: [],
        detached: [],
        renamed: [],
        missing: []
      })
    })
    expect(toFile(fresh, { editor: false })).toEqual(toFile(station, { editor: false }))
  })
})
