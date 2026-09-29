import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { fromFile } from '@/model/serialize'
import { applyDependencyRenames, followInterfaceRenames, placeModule } from '@/model/dependencies'
import { emptyProject, modulePath } from '@/model/project'
import { diffRenames, relativeFile } from '@/model/sync'
import type { Project } from '@/model/types'

const robot = fromFile(YAML.parse(readFileSync('examples/robot.scaffold.yaml', 'utf8')))
const byPath = (p: Project, path: string) => p.modules.find((m) => modulePath(p, m.id) === path)!

/** Robot with the types and interfaces of its dependencies made its own. */
const own = produce(robot, (d) => {
  for (const e of [...d.types, ...d.interfaces]) delete e.dependency
  d.dependencies = []
})

/** A project depending on Robot, with its Core.Sensor placed. */
const station = produce(emptyProject(), (d) => {
  placeModule(d, robot, 'robot.scaffold.yaml', byPath(robot, 'Core.Sensor').id, { x: 0, y: 0 }, null)
})

describe('sync', () => {
  it('finds no renames in unrelated edits', () => {
    expect(diffRenames(robot, robot)).toBeNull()
    const moved = produce(robot, (d) => void (byPath(d, 'Core').layout.x += 10))
    expect(diffRenames(robot, moved)).toBeNull()
  })

  it('finds module, nested module, port and own interface and type renames', () => {
    const next = produce(own, (d) => {
      byPath(d, 'Core.Sensor').ports[0]!.name = 'data'
      byPath(d, 'Core').name = 'Base'
      d.interfaces.find((i) => i.name === 'Telemetry')!.name = 'Stream'
      d.types.find((t) => t.name === 'Vec3')!.name = 'Vector'
    })
    const r = diffRenames(own, next)!
    expect(r.modules.get('Core')).toBe('Base')
    expect(r.modules.get('Core.Sensor')).toBe('Base.Sensor')
    expect(r.ports.get('Base.Sensor')).toEqual(new Map([['out', 'data']]))
    expect(r.interfaces).toEqual(new Map([['Telemetry', 'Stream']]))
    expect(r.types).toEqual(new Map([['Vec3', 'Vector']]))
  })

  it('leaves the renames of dependency entities to their own project', () => {
    const next = produce(
      robot,
      (d) => void (d.interfaces.find((i) => i.name === 'Telemetry')!.name = 'Stream')
    )
    expect(diffRenames(robot, next)).toBeNull()
  })

  it('carries renames of a project to a project depending on it', () => {
    const next = produce(robot, (d) => {
      byPath(d, 'Core.Sensor').ports[0]!.name = 'data'
      byPath(d, 'Core').name = 'Base'
      d.types.find((t) => t.name === 'Primitive')!.name = 'Opaque'
    })
    const q = produce(station, (d) =>
      applyDependencyRenames(d, 'robot.scaffold.yaml', diffRenames(robot, next)!)
    )
    const m = q.dependencies[0]!.modules[0]!
    expect(m.path).toBe('Base.Sensor')
    expect(m.ports[0]).toMatchObject({ name: 'data', interface: 'Telemetry' })
    expect(q.types.find((t) => t.dependency === q.dependencies[0]!.id)!.name).toBe('Opaque')
    // Another file: untouched.
    const other = produce(station, (d) => applyDependencyRenames(d, 'other.yaml', diffRenames(robot, next)!))
    expect(other.dependencies[0]!.modules[0]!.path).toBe('Core.Sensor')
  })

  it('keeps placed ports on a renamed interface', () => {
    const q = produce(station, (d) => {
      d.interfaces.find((i) => i.name === 'Telemetry')!.name = 'Stream'
      followInterfaceRenames(station, d)
    })
    expect(q.dependencies[0]!.modules[0]!.ports[0]!.interface).toBe('Stream')
  })
})

describe('relativeFile', () => {
  it('names the file relative to the folder of the project', () => {
    expect(relativeFile('/w/main.scaffold.yaml', '/w/other.scaffold.yaml')).toBe('other.scaffold.yaml')
    expect(relativeFile('/w/main.scaffold.yaml', '/w/sub/other.scaffold.yaml')).toBe(
      'sub/other.scaffold.yaml'
    )
    expect(relativeFile('/w/a/main.scaffold.yaml', '/w/b/other.scaffold.yaml')).toBe(
      '../b/other.scaffold.yaml'
    )
    expect(relativeFile('C:\\w\\main.yaml', 'C:\\w\\sub\\other.yaml')).toBe('sub/other.yaml')
  })

  it('keeps the name alone without a folder in common', () => {
    expect(relativeFile(null, '/w/other.yaml')).toBe('other.yaml')
    expect(relativeFile('main.yaml', 'other.yaml')).toBe('other.yaml')
    expect(relativeFile('C:\\w\\main.yaml', 'D:\\w\\other.yaml')).toBe('other.yaml')
  })
})
