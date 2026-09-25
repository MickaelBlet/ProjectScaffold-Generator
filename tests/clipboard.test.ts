import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { fromFile } from '@/model/serialize'
import { copyItems, parseClip, pasteClip } from '@/model/clipboard'
import { absolutePosition, emptyProject, modulePath } from '@/model/project'
import { validate } from '@/model/validate'

const example = fromFile(YAML.parse(readFileSync('examples/robot.scaffold.yaml', 'utf8')))
const byPath = (path: string) => example.modules.find((m) => modulePath(example, m.id) === path)!

describe('clipboard', () => {
  it('copies a module with its content and internal links only', () => {
    const clip = copyItems(example, [byPath('Core').id])!
    expect(clip.modules.map((m) => m.name)).toEqual(['Core', 'Sensor', 'Controller', 'Logger'])
    expect(clip.links.map((l) => l.name)).toEqual(['sensor_to_controller', 'sensor_to_logger'])
  })

  it('does not copy a module twice when its parent is selected too', () => {
    const clip = copyItems(example, [byPath('Core').id, byPath('Core.Sensor').id])!
    expect(clip.modules.filter((m) => m.name === 'Sensor')).toHaveLength(1)
    expect(Object.keys(clip.rootParents)).toEqual([byPath('Core').id])
  })

  it('duplicates several modules next to the originals, renamed, with fresh ids', () => {
    const clip = copyItems(example, [byPath('Core.Sensor').id, byPath('Core.Logger').id])!
    let pasted: string[] = []
    const p = produce(example, (d) => void (pasted = pasteClip(d, clip, { parent: 'original' })))
    expect(pasted).toHaveLength(2)
    const copies = pasted.map((id) => p.modules.find((m) => m.id === id)!)
    expect(copies.map((m) => modulePath(p, m.id))).toEqual(['Core.Sensor2', 'Core.Logger2'])
    const sensor = byPath('Core.Sensor')
    const moved = absolutePosition(p, pasted[0]!)
    const original = absolutePosition(example, sensor.id)
    expect(moved.x - original.x).toBeCloseTo(30, 0)
    expect(moved.y - original.y).toBeCloseTo(30, 0)
    // The link between the two copies is copied, rewired to the copies.
    expect(p.links).toHaveLength(example.links.length + 1)
    const link = p.links.at(-1)!
    expect([link.from.moduleId, link.to.moduleId]).toEqual(pasted)
    expect(new Set(p.modules.flatMap((m) => m.ports.map((pt) => pt.id))).size).toBe(
      p.modules.flatMap((m) => m.ports).length
    )
    expect(validate(p).filter((pr) => pr.severity === 'error')).toEqual([])
  })

  it('pastes into another project through JSON, rebinding or copying types', () => {
    const iface = example.interfaces.find((i) => i.name === 'Telemetry')!
    const pose = example.types.find((t) => t.name === 'Pose')!
    const vec3 = example.types.find((t) => t.name === 'Vec3')!
    const clip = parseClip(
      JSON.stringify(copyItems(example, [byPath('Operator').id, iface.id, pose.id, vec3.id]))
    )!
    const p = produce(
      emptyProject(),
      (d) => void pasteClip(d, clip, { parent: 'original', at: { x: 0, y: 0 } })
    )
    expect(p.interfaces.map((i) => i.name)).toEqual(['Telemetry'])
    expect(p.types.map((t) => t.name)).toEqual(['Vec3', 'Pose'])
    const operator = p.modules[0]!
    expect(operator.parentId).toBeNull()
    expect(operator.layout).toMatchObject({ x: 0, y: 0 })
    // Control is not pasted: the port becomes untyped.
    expect(operator.ports[0]!.interfaceId).toBeNull()
    // Pose.position refers to the pasted Vec3.
    const pastedPose = p.types.find((t) => t.name === 'Pose')!
    expect(pastedPose.kind === 'struct' && pastedPose.fields[0]!.type).toEqual({
      kind: 'ref',
      id: p.types.find((t) => t.name === 'Vec3')!.id
    })
  })

  it('ignores foreign text', () => {
    expect(parseClip('hello')).toBeNull()
    expect(parseClip('{"a":1}')).toBeNull()
  })
})
