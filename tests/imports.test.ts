import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import YAML from 'yaml'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { fromFile, toFile } from '@/model/serialize'
import { importModule, importName, refreshImport, removeImported } from '@/model/imports'
import { defaultConstraints, emptyProject, modulePath } from '@/model/project'
import { validate } from '@/model/validate'
import type { Project } from '@/model/types'

const robot = fromFile(YAML.parse(readFileSync('examples/robot.scaffold.yaml', 'utf8')))
const jsonSchema = JSON.parse(readFileSync('schema/scaffold.schema.json', 'utf8'))
const byPath = (p: Project, path: string) => p.modules.find((m) => modulePath(p, m.id) === path)!
const errors = (p: Project) =>
  validate(p)
    .filter((pr) => pr.severity === 'error')
    .map((pr) => pr.message)

/** A project with a `Monitor` module whose `in` port links to Robot's Core.Sensor `out` port. */
function monitor(): { p: Project; importedId: string } {
  let importedId = ''
  const p = produce({ ...emptyProject(), name: 'Station' }, (d) => {
    importedId = importModule(d, robot, 'robot.scaffold.yaml', byPath(robot, 'Core.Sensor').id, {
      x: 500,
      y: 40
    })!
    const telemetry = d.interfaces.find((i) => i.name === 'Telemetry')!
    d.modules.push({
      id: 'mon',
      name: 'Monitor',
      description: '',
      parentId: null,
      metadata: {},
      ports: [{ id: 'mon-in', name: 'telemetry', role: 'in', interfaceId: telemetry.id, description: '' }],
      layout: { x: 0, y: 0, width: 200, height: 72 }
    })
    const imported = d.imports[0]!.modules[0]!
    d.links.push({
      id: 'l',
      name: 'sensor_to_monitor',
      description: '',
      from: { moduleId: imported.id, portId: imported.ports[0]!.id },
      to: { moduleId: 'mon', portId: 'mon-in' },
      constraints: defaultConstraints()
    })
  })
  return { p, importedId }
}

describe('imports', () => {
  it('names imports after the project', () => {
    expect(importName('Robot')).toBe('Robot')
    expect(importName('my robot-2')).toBe('my_robot_2')
    expect(importName('2d nav')).toBe('_2d_nav')
    expect(importName('!!')).toBe('Other')
  })

  it('imports a module with its ports and the interfaces and types they need', () => {
    const { p, importedId } = monitor()
    expect(p.imports).toHaveLength(1)
    expect(p.imports[0]).toMatchObject({ name: 'Robot', file: 'robot.scaffold.yaml' })
    expect(p.imports[0]!.modules[0]).toMatchObject({
      id: importedId,
      path: 'Core.Sensor',
      position: { x: 500, y: 40 },
      ports: [{ name: 'out', role: 'out', interface: 'Telemetry' }]
    })
    expect(p.interfaces.map((i) => i.name)).toEqual(['Telemetry'])
    expect(p.types.map((t) => t.name).sort()).toEqual(['Pose', 'Vec3'])
    expect(modulePath(p, importedId)).toBe('Robot/Core.Sensor')
    expect(errors(p)).toEqual([])
  })

  it('reuses the import of a file and an already imported module', () => {
    const { p, importedId } = monitor()
    let again: string | null = null
    let other: string | null = null
    const q = produce(p, (d) => {
      again = importModule(d, robot, 'robot.scaffold.yaml', byPath(robot, 'Core.Sensor').id, { x: 0, y: 0 })
      other = importModule(d, robot, 'robot.scaffold.yaml', byPath(robot, 'Operator').id, { x: 0, y: 0 })
    })
    expect(again).toBe(importedId)
    expect(other).not.toBe(importedId)
    expect(q.imports).toHaveLength(1)
    expect(q.imports[0]!.modules.map((m) => m.path)).toEqual(['Core.Sensor', 'Operator'])
    // Control comes with Mode; Telemetry was already there.
    expect(q.interfaces.map((i) => i.name)).toEqual(['Telemetry', 'Control'])
  })

  it('round-trips links to another project, matching the JSON Schema', () => {
    const { p } = monitor()
    const file = toFile(p, { editor: true })
    expect(file.imports).toEqual([
      {
        name: 'Robot',
        file: 'robot.scaffold.yaml',
        modules: [{ module: 'Core.Sensor', ports: [{ name: 'out', role: 'out', interface: 'Telemetry' }] }]
      }
    ])
    expect(file.links[0]!.from).toEqual({ import: 'Robot', module: 'Core.Sensor', port: 'out' })
    expect(file.editor?.imports).toEqual({ Robot: { 'Core.Sensor': { x: 500, y: 40 } } })
    expect(toFile(fromFile(file), { editor: true })).toEqual(file)
    const check = new Ajv2020({ allErrors: true }).compile(jsonSchema)
    expect(check(file), JSON.stringify(check.errors)).toBe(true)
    // Exports keep the imports (generators need them), not their positions.
    const exported = toFile(p, { editor: false })
    expect(exported.imports).toEqual(file.imports)
    expect(exported.editor).toBeUndefined()
  })

  it('reports unknown imports and imported modules on load', () => {
    const file = toFile(monitor().p, { editor: false })
    file.links[0]!.from = { import: 'Nav', module: 'Core.Sensor', port: 'out' }
    expect(() => fromFile(file)).toThrow("unknown import 'Nav'")
    file.links[0]!.from = { import: 'Robot', module: 'Operator', port: 'cmd' }
    expect(() => fromFile(file)).toThrow("module 'Operator' is not listed in import 'Robot'")
  })

  it('flags interfaces not defined here and links between two imported modules', () => {
    const { p, importedId } = monitor()
    const q = produce(p, (d) => {
      d.interfaces[0]!.name = 'Telemetry2'
    })
    expect(errors(q)).toEqual([
      "Link 'sensor_to_monitor': Robot/Core.Sensor:out uses interface 'Telemetry', not defined in this project"
    ])
    const r = produce(p, (d) => {
      d.links[0]!.to = { moduleId: importedId, portId: d.imports[0]!.modules[0]!.ports[0]!.id }
    })
    expect(errors(r)).toContain(
      "Link 'sensor_to_monitor' joins two imported modules: one end must be in this project"
    )
  })

  it('refreshes ports by name, dropping links to removed ports', () => {
    const { p } = monitor()
    const portId = p.imports[0]!.modules[0]!.ports[0]!.id
    const renamed = produce(robot, (d) => {
      const sensor = byPath(d, 'Core.Sensor')
      sensor.ports.push({ id: 'x', name: 'status', role: 'out', interfaceId: null, description: '' })
    })
    let result = refreshImport(p, '', robot)
    const q = produce(p, (d) => void (result = refreshImport(d, d.imports[0]!.id, renamed)))
    expect(result).toEqual({ missing: [], renamed: [] })
    expect(q.imports[0]!.modules[0]!.ports.map((pt) => pt.name)).toEqual(['out', 'status'])
    expect(q.imports[0]!.modules[0]!.ports[0]!.id).toBe(portId)
    expect(q.links).toHaveLength(1)

    const gone = produce(robot, (d) => void (byPath(d, 'Core.Sensor').ports[0]!.name = 'data'))
    const r = produce(p, (d) => void refreshImport(d, d.imports[0]!.id, gone))
    expect(r.links).toEqual([])

    const deleted = produce(robot, (d) => void (d.modules = d.modules.filter((m) => m.name !== 'Sensor')))
    const s = produce(p, (d) => void (result = refreshImport(d, d.imports[0]!.id, deleted)))
    expect(result.missing).toEqual(['Core.Sensor'])
    expect(s.links).toHaveLength(1)
  })

  it('detects modules renamed or moved while the importing project was closed', () => {
    const { p } = monitor()
    let result = refreshImport(p, '', robot)
    const renamed = produce(robot, (d) => void (byPath(d, 'Core.Sensor').name = 'Lidar'))
    const q = produce(p, (d) => void (result = refreshImport(d, d.imports[0]!.id, renamed)))
    expect(result).toEqual({ missing: [], renamed: ['module Core.Sensor → Core.Lidar'] })
    expect(q.imports[0]!.modules[0]!.path).toBe('Core.Lidar')
    expect(q.links).toHaveLength(1)

    const moved = produce(robot, (d) => void (byPath(d, 'Core.Sensor').parentId = null))
    const r = produce(p, (d) => void (result = refreshImport(d, d.imports[0]!.id, moved)))
    expect(result.renamed).toEqual(['module Core.Sensor → Sensor'])
    expect(r.imports[0]!.modules[0]!.path).toBe('Sensor')
  })

  it('detects interfaces renamed while the importing project was closed', () => {
    const { p } = monitor()
    let result = refreshImport(p, '', robot)
    const renamed = produce(
      robot,
      (d) => void (d.interfaces.find((i) => i.name === 'Telemetry')!.name = 'Stream')
    )
    const q = produce(p, (d) => void (result = refreshImport(d, d.imports[0]!.id, renamed)))
    expect(result.renamed).toEqual(['interface Telemetry → Stream'])
    expect(q.interfaces.map((i) => i.name)).toEqual(['Stream'])
    expect(q.imports[0]!.modules[0]!.ports[0]!.interface).toBe('Stream')
    expect(errors(q)).toEqual([])
  })

  it('removes imported modules with their links and empty imports', () => {
    const { p, importedId } = monitor()
    const q = produce(p, (d) => removeImported(d, new Set([importedId])))
    expect(q.imports).toEqual([])
    expect(q.links).toEqual([])
    expect(q.modules).toHaveLength(1)
  })
})
