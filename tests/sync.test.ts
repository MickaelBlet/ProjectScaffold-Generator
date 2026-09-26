import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { fromFile } from '@/model/serialize'
import { importModule } from '@/model/imports'
import { emptyProject, modulePath } from '@/model/project'
import { applySourceRenames, diffRenames, followInterfaceRenames, renameInterfaces } from '@/model/sync'
import type { Project } from '@/model/types'

const robot = fromFile(YAML.parse(readFileSync('examples/robot.scaffold.yaml', 'utf8')))
const byPath = (p: Project, path: string) => p.modules.find((m) => modulePath(p, m.id) === path)!

/** A project importing Robot's Core.Sensor (with Telemetry copied). */
const station = produce(emptyProject(), (d) => {
  importModule(d, robot, 'robot.scaffold.yaml', byPath(robot, 'Core.Sensor').id, { x: 0, y: 0 })
})

describe('sync', () => {
  it('finds no renames in unrelated edits', () => {
    expect(diffRenames(robot, robot)).toBeNull()
    const moved = produce(robot, (d) => void (byPath(d, 'Core').layout.x += 10))
    expect(diffRenames(robot, moved)).toBeNull()
  })

  it('finds module, nested module, port and interface renames', () => {
    const next = produce(robot, (d) => {
      byPath(d, 'Core.Sensor').ports[0]!.name = 'data'
      byPath(d, 'Core').name = 'Base'
      d.interfaces.find((i) => i.name === 'Telemetry')!.name = 'Stream'
    })
    const r = diffRenames(robot, next)!
    expect(r.modules.get('Core')).toBe('Base')
    expect(r.modules.get('Core.Sensor')).toBe('Base.Sensor')
    expect(r.ports.get('Base.Sensor')).toEqual(new Map([['out', 'data']]))
    expect(r.interfaces).toEqual(new Map([['Telemetry', 'Stream']]))
  })

  it('carries renames of a project to a project importing it', () => {
    const next = produce(robot, (d) => {
      byPath(d, 'Core.Sensor').ports[0]!.name = 'data'
      byPath(d, 'Core').name = 'Base'
      d.interfaces.find((i) => i.name === 'Telemetry')!.name = 'Stream'
    })
    const q = produce(station, (d) => applySourceRenames(d, 'robot.scaffold.yaml', diffRenames(robot, next)!))
    const m = q.imports[0]!.modules[0]!
    expect(m.path).toBe('Base.Sensor')
    expect(m.ports[0]).toMatchObject({ name: 'data', interface: 'Stream' })
    expect(q.interfaces.map((i) => i.name)).toEqual(['Stream'])
    // Another file: untouched.
    const other = produce(station, (d) => applySourceRenames(d, 'other.yaml', diffRenames(robot, next)!))
    expect(other.imports[0]!.modules[0]!.path).toBe('Core.Sensor')
  })

  it('renames shared interfaces unless the new name is taken', () => {
    const q = produce(robot, (d) => void renameInterfaces(d, new Map([['Telemetry', 'Control']])))
    expect(q.interfaces.map((i) => i.name)).toEqual(['Telemetry', 'Control'])
    const r = produce(robot, (d) => void renameInterfaces(d, new Map([['Telemetry', 'Stream']])))
    expect(r.interfaces.map((i) => i.name)).toEqual(['Stream', 'Control'])
  })

  it('keeps imported ports on a renamed local interface', () => {
    const q = produce(station, (d) => {
      d.interfaces[0]!.name = 'Stream'
      followInterfaceRenames(station, d)
    })
    expect(q.imports[0]!.modules[0]!.ports[0]!.interface).toBe('Stream')
  })
})
