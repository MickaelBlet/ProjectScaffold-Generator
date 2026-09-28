import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { fromFile, LoadError, loadText, reloadText, sameContent, saveText, toFile } from '@/model/serialize'
import { validate } from '@/model/validate'

const exampleText = readFileSync('examples/robot.scaffold.yaml', 'utf8')
const example = YAML.parse(exampleText)
const jsonSchema = JSON.parse(readFileSync('schema/scaffold.schema.json', 'utf8'))

describe('serialize', () => {
  it('loads the example without problems', () => {
    const p = fromFile(example)
    expect(p.modules.map((m) => m.name)).toEqual(['Core', 'Sensor', 'Controller', 'Logger', 'Operator'])
    expect(validate(p)).toEqual([])
  })

  it('round-trips the example', () => {
    expect(toFile(fromFile(example), { editor: true })).toEqual(example)
  })

  it.each(['yaml', 'json'] as const)('round-trips through %s text with layout', (format) => {
    const p = fromFile(example)
    const text = saveText(p, format, { editor: true })
    const again = loadText(text, format)
    expect(toFile(again, { editor: true })).toEqual(toFile(p, { editor: true }))
    expect(again.modules.map((m) => m.layout)).toEqual(p.modules.map((m) => m.layout))
  })

  it('round-trips custom primitives and transports', () => {
    const p = fromFile(example)
    p.types.push({ id: 'uuid', kind: 'primitive', name: 'Uuid', description: 'RFC 4122' })
    p.transports.push('zenoh')
    const file = toFile(p, { editor: false })
    expect(file.types.at(-1)).toEqual({ kind: 'primitive', name: 'Uuid', description: 'RFC 4122' })
    expect(file.transports).toEqual(['zenoh'])
    const again = fromFile(file)
    expect(again.types.at(-1)).toMatchObject({ kind: 'primitive', name: 'Uuid' })
    expect(again.transports).toEqual(['zenoh'])
    expect(toFile(fromFile(example), { editor: false }).transports).toBeUndefined()
  })

  it('round-trips locked modules and notes', () => {
    const p = fromFile(example)
    p.modules[1]!.locked = true
    p.notes.push({
      id: 'n',
      kind: 'note',
      text: 'x',
      layout: { x: 0, y: 0, width: 80, height: 40 },
      locked: true
    })
    const again = fromFile(toFile(p, { editor: true }))
    expect(again.modules.map((m) => !!m.locked)).toEqual(p.modules.map((m) => !!m.locked))
    expect(again.notes.at(-1)?.locked).toBe(true)
  })

  it('round-trips hand-set link shapes, left out of exports', () => {
    const p = fromFile(example)
    p.links[0]!.route = { points: [{ x: 10, y: 20 }], from: { side: 'bottom', at: 0.5 } }
    p.links[1]!.route = { points: [], to: { side: 'top', at: 0.25 } }
    const file = toFile(p, { editor: true })
    expect(file.editor?.links).toEqual({
      [p.links[0]!.name]: { points: [{ x: 10, y: 20 }], from: { side: 'bottom', at: 0.5 } },
      [p.links[1]!.name]: { to: { side: 'top', at: 0.25 } }
    })
    expect(fromFile(file).links.map((l) => l.route)).toEqual(p.links.map((l) => l.route))
    expect(toFile(p, { editor: false }).editor).toBeUndefined()
  })

  it('round-trips moved port names, left out of exports', () => {
    const p = fromFile(example)
    p.modules[1]!.ports[0]!.label = 'top'
    const file = toFile(p, { editor: true })
    expect(file.editor?.style).toEqual({ 'Core.Sensor': { labels: { out: 'top' } } })
    expect(fromFile(file).modules.map((m) => m.ports.map((pt) => pt.label))).toEqual(
      p.modules.map((m) => m.ports.map((pt) => pt.label))
    )
    expect(toFile(p, { editor: false }).editor).toBeUndefined()
  })

  it('exports module colors without editor data, and reads the legacy editor style', () => {
    const p = fromFile(example)
    p.modules[1]!.color = '#ff0000'
    const exported = toFile(p, { editor: false })
    expect(exported.modules[0]!.modules![0]!.color).toBe('#ff0000')
    expect(fromFile(exported).modules[1]!.color).toBe('#ff0000')
    const legacy = structuredClone(example)
    legacy.editor.style = { 'Core.Sensor': { color: '#00ff00' } }
    expect(fromFile(legacy).modules[1]!.color).toBe('#00ff00')
  })

  it('output matches the published JSON Schema', () => {
    const ajv = new Ajv2020({ allErrors: true })
    const check = ajv.compile(jsonSchema)
    expect(check(example), JSON.stringify(check.errors)).toBe(true)
    const withEditor = toFile(fromFile(example), { editor: true })
    expect(check(withEditor), JSON.stringify(check.errors)).toBe(true)
  })

  it('reports schema errors', () => {
    const bad = { ...example, types: [{ kind: 'struct', name: '1bad', fields: [] }] }
    expect(() => fromFile(bad)).toThrow(LoadError)
  })

  it('reports unresolved references', () => {
    const bad = structuredClone(example)
    bad.links[0].to.module = 'Core.Nope'
    bad.types[3].fields[0].type = { kind: 'ref', name: 'Missing' }
    try {
      fromFile(bad)
      expect.unreachable()
    } catch (e) {
      expect((e as LoadError).problems).toEqual([
        "Pose.position: unknown type 'Missing'",
        "Link 'sensor_to_controller' to: unknown module 'Core.Nope'"
      ])
    }
  })

  it('rejects duplicate referenced names', () => {
    const bad = structuredClone(example)
    bad.interfaces[0].name = 'Vec3'
    expect(() => fromFile(bad)).toThrow(/Duplicate interface name 'Vec3'/)
  })

  it('auto-lays out modules without editor data, children inside parents', () => {
    const p = fromFile(example)
    const core = p.modules.find((m) => m.name === 'Core')!
    for (const child of p.modules.filter((m) => m.parentId === core.id)) {
      expect(child.layout.x + child.layout.width).toBeLessThanOrEqual(core.layout.width)
      expect(child.layout.y + child.layout.height).toBeLessThanOrEqual(core.layout.height)
    }
  })
})

describe('parameter direction', () => {
  it('defaults to in and is omitted from the file when in', () => {
    const p = fromFile(example)
    const [publish, setMode, raw] = p.interfaces.flatMap((i) => i.messages)
    expect(publish!.params.map((prm) => prm.direction)).toEqual(['in', 'in'])
    expect(setMode!.params[0]!.direction).toBe('in')
    expect(raw!.params.map((prm) => prm.direction)).toEqual(['inout', 'in'])
    raw!.params[1]!.direction = 'out'
    const params = toFile(p, { editor: false }).interfaces[1]!.messages[1]!.params
    expect(params.map((prm) => prm.direction)).toEqual(['inout', 'out'])
    expect(toFile(p, { editor: false }).interfaces[0]!.messages[0]!.params[0]!.direction).toBeUndefined()
  })
})

describe('JSON Schema', () => {
  it('schema/scaffold.schema.json is up to date (run `npm run schema`)', async () => {
    const { z } = await import('zod')
    const { FileProjectSchema } = await import('@/model/schema')
    expect(z.toJSONSchema(FileProjectSchema, { target: 'draft-2020-12', io: 'input' })).toEqual(jsonSchema)
  })
})

describe('editor orientation', () => {
  it('round-trips the vertical orientation and defaults to horizontal', () => {
    const p = { ...fromFile(example), orientation: 'vertical' as const }
    expect(toFile(p, { editor: true }).editor?.orientation).toBe('vertical')
    expect(loadText(saveText(p, 'yaml', { editor: true }), 'yaml').orientation).toBe('vertical')
    expect(toFile(fromFile(example), { editor: true }).editor?.orientation).toBeUndefined()
    expect(fromFile(example).orientation).toBe('horizontal')
  })
})

describe('reload from edited text', () => {
  const ids = (p: ReturnType<typeof fromFile>) => ({
    modules: p.modules.map((m) => m.id),
    ports: p.modules.flatMap((m) => m.ports.map((pt) => pt.id)),
    links: p.links.map((l) => l.id),
    types: p.types.map((t) => t.id)
  })

  it('keeps ids and changes nothing when the text is unchanged', () => {
    const prev = fromFile(example)
    const next = reloadText(saveText(prev, 'yaml', { editor: true }), 'yaml', prev)
    expect(ids(next)).toEqual(ids(prev))
    expect(sameContent(next, prev)).toBe(true)
  })

  it('keeps the ids and the layout of renamed entities', () => {
    const prev = fromFile(example)
    prev.modules[1]!.locked = true
    const file = toFile(prev, { editor: true })
    file.modules[0]!.modules![0]!.name = 'Lidar'
    for (const l of file.links)
      for (const e of [l.from, l.to]) if (e.module === 'Core.Sensor') e.module = 'Core.Lidar'
    file.links[0]!.name = 'renamed_link'
    const next = fromFile(file, prev)
    expect(ids(next)).toEqual(ids(prev))
    expect(next.modules[1]!.name).toBe('Lidar')
    expect(next.modules[1]!.layout).toEqual(prev.modules[1]!.layout)
    expect(next.modules[1]!.locked).toBe(true)
  })

  it('gives fresh ids to added entities', () => {
    const prev = fromFile(example)
    const file = toFile(prev, { editor: false })
    file.modules.push({ name: 'Extra', ports: [] })
    const next = fromFile(file, prev)
    const extra = next.modules.find((m) => m.name === 'Extra')!
    expect(prev.modules.some((m) => m.id === extra.id)).toBe(false)
    expect(next.modules.filter((m) => m.name !== 'Extra').map((m) => m.id)).toEqual(ids(prev).modules)
  })

  it('keeps the editor data of the project when the text has none', () => {
    const prev = { ...fromFile(example), orientation: 'vertical' as const }
    prev.modules[0]!.layout = { x: 500, y: 600, width: 700, height: 800 }
    const next = reloadText(saveText(prev, 'yaml', { editor: false }), 'yaml', prev)
    expect(next.orientation).toBe('vertical')
    expect(next.modules[0]!.layout).toEqual(prev.modules[0]!.layout)
    expect(sameContent(next, prev)).toBe(true)
  })
})

describe('problem lines', () => {
  const linesOf = (text: string, format: 'yaml' | 'json' = 'yaml') => {
    try {
      loadText(text, format)
    } catch (e) {
      return (e as LoadError).issues.map((i) => i.line)
    }
    return null
  }

  it('locates syntax errors', () => {
    expect(linesOf('project:\n  name: [a\nmodules: []\n')).toEqual([expect.any(Number)])
    expect(linesOf('{\n  "a": 1,\n  oops\n}', 'json')).toEqual([3])
  })

  it('locates schema and reference errors at their key', () => {
    const text = exampleText.replace('module: Core.Controller', 'module: Core.Nope')
    const line = text.split('\n').findIndex((l) => l.includes('Core.Nope')) + 1
    expect(linesOf(text)).toEqual([line])
    const bad = exampleText.replace('underlying: uint8', 'underlying: nope')
    expect(linesOf(bad)).toEqual([bad.split('\n').findIndex((l) => l.includes('underlying: nope')) + 1])
  })
})
