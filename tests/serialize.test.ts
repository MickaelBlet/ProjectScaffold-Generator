import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { fromFile, LoadError, loadText, saveText, toFile } from '@/model/serialize'
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

  it('round-trips the example (export format)', () => {
    expect(toFile(fromFile(example), { editor: false })).toEqual(example)
  })

  it.each(['yaml', 'json'] as const)('round-trips through %s text with layout', (format) => {
    const p = fromFile(example)
    const text = saveText(p, format, { editor: true })
    const again = loadText(text, format)
    expect(toFile(again, { editor: true })).toEqual(toFile(p, { editor: true }))
    expect(again.modules.map((m) => m.layout)).toEqual(p.modules.map((m) => m.layout))
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

describe('JSON Schema', () => {
  it('schema/scaffold.schema.json is up to date (run `npm run schema`)', async () => {
    const { z } = await import('zod')
    const { FileProjectSchema } = await import('@/model/schema')
    expect(z.toJSONSchema(FileProjectSchema, { target: 'draft-2020-12', io: 'input' })).toEqual(jsonSchema)
  })
})
