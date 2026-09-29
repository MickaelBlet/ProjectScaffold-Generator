import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { buildContext } from '@/codegen/context'
import { cppFilters } from '@/codegen/cpp'
import { generate, outputPath, trimTagLines } from '@/codegen/generate'
import { generateInto, generationInput, RECORD, type OutputDir } from '@/codegen/run'
import { extractSections, mergeSections, placeMarkers, SectionError, skeleton } from '@/codegen/sections'
import { parseManifest, type TemplateSet } from '@/codegen/templateSet'
import { fromFile } from '@/model/serialize'
import type { FileProject } from '@/model/schema'

const cpp17 = (): TemplateSet => {
  const dir = 'templates/cpp17'
  const manifest = parseManifest(readFileSync(join(dir, 'manifest.yaml'), 'utf8'))
  const files = Object.fromEntries(
    [...manifest.outputs.map((o) => o.template), ...(manifest.partials ?? [])].map((f) => [
      f,
      readFileSync(join(dir, f), 'utf8')
    ])
  )
  return { manifest, files }
}

const exported = (path: string): FileProject =>
  generationInput(fromFile(YAML.parse(readFileSync(path, 'utf8'))))

function memoryDir(files: Record<string, string> = {}): OutputDir & { files: Record<string, string> } {
  return {
    label: 'memory',
    files,
    read: (p) => Promise.resolve(files[p] ?? null),
    write: (p, t) => {
      files[p] = t
      return Promise.resolve()
    },
    remove: (p) => {
      delete files[p]
      return Promise.resolve()
    }
  }
}

/** The text with the content of a `//` user section replaced. */
function withSection(text: string, id: string, content: string): string {
  const re = id.replace(/\./g, '\\.')
  return text.replace(
    new RegExp(`(// <user:${re}>\\n)[\\s\\S]*?(^[ \\t]*// </user:${re}>)`, 'm'),
    `$1${content}\n$2`
  )
}

describe('user sections', () => {
  const file = [
    'int f()',
    '{',
    '    // <user:body>',
    '    return 1;',
    '    // </user:body>',
    '}',
    '// <user:empty>',
    '// </user:empty>',
    ''
  ].join('\n')

  it('extracts sections by id', () => {
    const s = extractSections(file, '//')
    expect(s.map((x) => [x.id, x.content])).toEqual([
      ['body', '    return 1;'],
      ['empty', '']
    ])
  })

  it('rejects duplicate, nested and unclosed sections', () => {
    expect(() => extractSections('// <user:a>\n// </user:a>\n// <user:a>\n// </user:a>', '//')).toThrow(
      SectionError
    )
    expect(() => extractSections('// <user:a>\n// <user:b>\n// </user:b>\n// </user:a>', '//')).toThrow(
      SectionError
    )
    expect(() => extractSections('// <user:a>\n', '//')).toThrow(SectionError)
  })

  it('carries sections over by id; unknown ones become orphans', () => {
    const previous = withSection(file, 'body', '    return 42;') + '// <user:gone>\nold();\n// </user:gone>\n'
    const generated = file.replace('int f()', 'long f()')
    const r = mergeSections(generated, previous, '//')
    expect(r.text).toContain('long f()')
    expect(r.text).toContain('    return 42;')
    expect(r.orphans.map((s) => s.id)).toEqual(['gone'])
  })

  it('gives untouched sections the new default content', () => {
    const generated = file.replace('return 1;', 'return 2;')
    const r = mergeSections(generated, file, '//', (s) => s.id === 'body')
    expect(r.text).toContain('return 2;')
  })

  it('keeps the line endings of the previous file', () => {
    const previous = withSection(file, 'body', '    return 42;').replace(/\n/g, '\r\n')
    const r = mergeSections(file, previous, '//')
    expect(r.text).toBe(withSection(file, 'body', '    return 42;').replace(/\n/g, '\r\n'))
  })

  it('skeleton ignores what sections hold', () => {
    expect(skeleton(withSection(file, 'body', 'x();'), '//')).toBe(skeleton(file, '//'))
    expect(skeleton(file.replace('int', 'long'), '//')).not.toBe(skeleton(file, '//'))
  })

  it('places markers at the indentation of the tag line', () => {
    const B = (id: string): string => `\uE000B${id}\uE001`
    const E = (id: string): string => `\uE000E${id}\uE001`
    expect(placeMarkers(`{\n    ${B('a')}\n    x();\n    ${E('a')}\n}`, '//')).toBe(
      '{\n    // <user:a>\n    x();\n    // </user:a>\n}'
    )
    expect(placeMarkers(`  ${B('a')}${E('a')}`, '#')).toBe('  # <user:a>\n  # </user:a>')
  })
})

describe('templates', () => {
  it('trims lines holding only a tag, except user sections', () => {
    expect(trimTagLines('a\n  {% if x %}\nb\n{% endif %}\n  {% user "u" %}\n')).toBe(
      'a\n{% if x %}b\n{% endif %}  {% user "u" %}\n'
    )
  })

  it('keeps output paths inside the output directory', () => {
    expect(outputPath('include//a/./b.hpp')).toBe('include/a/b.hpp')
    for (const bad of ['/etc/x', '../x', 'a/../../x', 'C:/x', 'a\\b', ''])
      expect(() => outputPath(bad)).toThrow()
  })
})

describe('C++ filters', () => {
  const plant = exported('tests/fixtures/plant.scaffold.yaml')
  const ctx = buildContext(plant)
  const f = cppFilters(ctx) as Record<string, (...a: unknown[]) => unknown>
  const reading = ctx.types.find((t) => t.name === 'Reading')!
  if (reading.kind !== 'struct') throw new Error()
  const field = (n: string) => reading.fields.find((x) => x.name === n)!

  it('spells types', () => {
    expect(f.cpp_type!(field('tags').type)).toBe('std::map<std::string, std::int32_t>')
    expect(f.cpp_type!(field('note').type)).toBe('std::optional<std::string>')
    expect(f.cpp_type!(field('state').type)).toBe('::plant_demo::State')
    expect(f.cpp_type!(null)).toBe('void')
  })

  it('writes default values as literals', () => {
    const v = (n: string) => f.cpp_value!(field(n).default, field(n).type)
    expect(v('value')).toBe('1.5')
    expect(v('state')).toBe('::plant_demo::State::On')
    expect(v('tags')).toBe('{{"a", 1}}')
    expect(v('note')).toBe('std::nullopt')
    expect(v('label')).toBe('"say \\"hi\\""')
    expect(v('count')).toBe('7ULL')
    const sensor = ctx.modules.find((m) => m.path === 'Plant.Sensor')!
    const history = sensor.attributes.find((a) => a.name === 'history')!
    expect(f.cpp_value!(history.default, history.type)).toBe(
      '{::plant_demo::Reading{2.0, ::plant_demo::State::On, {{"a", 1}}, std::nullopt, "say \\"hi\\"", 7ULL}}'
    )
  })

  it('passes scalars by value and the rest by reference', () => {
    const get = ctx.interfaces.find((i) => i.name === 'Query')!.messages[0]!
    expect(f.cpp_params!(get.params)).toBe('const std::string& key, double& value')
  })
})

describe('generation context', () => {
  it('sorts the links of the robot into wiring', () => {
    const ctx = buildContext(exported('examples/robot.scaffold.yaml'))
    const core = ctx.modules.find((m) => m.path === 'Core')!
    expect(core.connections.map((c) => [c.link.name, c.from.via, c.to.via])).toEqual([
      ['sensor_to_controller', ['Sensor'], ['Controller']],
      ['sensor_to_logger', ['Sensor'], ['Logger']]
    ])
    expect(ctx.system.connections.map((c) => c.link.name)).toEqual(['operator_to_core'])
    expect(ctx.types.map((t) => t.name)).toEqual(['Primitive'])
    expect(ctx.allTypes.find((t) => t.name === 'Pose')?.dependency).toBe('Common')
  })

  it('finds delegations through containers', () => {
    const ctx = buildContext(exported('tests/fixtures/plant.scaffold.yaml'))
    const plant = ctx.modules.find((m) => m.path === 'Plant')!
    const port = (n: string) => plant.ports.find((p) => p.name === n)!
    expect(port('feed').delegates).toEqual([
      { via: ['Group', 'Filter'], module: 'Plant.Group.Filter', port: 'in' }
    ])
    expect(port('out').delegates).toEqual([{ via: ['Group'], module: 'Plant.Group', port: 'out' }])
    expect(ctx.system.connections.map((c) => [c.link.name, c.to.via])).toEqual([
      ['ask_store', ['Plant', 'Store']],
      ['plant_to_client', ['Client']]
    ])
    // Abstract modules without ports are classes only.
    expect(ctx.system.instances.map((m) => m.name)).toEqual(['Plant', 'Client'])
  })
})

describe('C++17 generation', () => {
  it('generates the robot', () => {
    const { files, warnings } = generate(exported('examples/robot.scaffold.yaml'), cpp17())
    expect(files.map((f) => f.path)).toMatchSnapshot()
    expect(files.find((f) => f.path === 'include/robot/core/Controller.hpp')?.text).toMatchSnapshot()
    expect(files.find((f) => f.path === 'src/Core.cpp')?.text).toMatchSnapshot()
    expect(warnings).toEqual(["Operator: 'operator' is a C++ keyword, renamed in the generated code"])
  })

  it('generates types and interfaces of a project without modules', () => {
    const { files } = generate(exported('examples/common.scaffold.yaml'), cpp17())
    expect(files.map((f) => f.path)).toContain('include/common/interfaces/ITelemetry.hpp')
    expect(files.some((f) => f.path.endsWith('.cpp'))).toBe(false)
    expect(files.find((f) => f.path === 'CMakeLists.txt')?.text).toContain('add_library(common INTERFACE)')
  })

  it('keeps user code across generations', async () => {
    const plant = exported('tests/fixtures/plant.scaffold.yaml')
    const dir = memoryDir()
    const first = await generateInto(plant, cpp17(), dir)
    expect(first.conflicts).toEqual([])
    expect(dir.files[RECORD]).toBeDefined()

    const store = 'src/plant/Store.cpp'
    dir.files[store] = withSection(dir.files[store]!, 'on.query.get', '    return key == "x";')
    dir.files['src/main.cpp'] = withSection(dir.files['src/main.cpp']!, 'main', '    run(system);')
    const again = await generateInto(plant, cpp17(), dir)
    expect(again.written).toEqual([])

    // The model changes: a method is added, a port renamed.
    const next = structuredClone(plant)
    next.modules.find((m) => m.name === 'Client')!.methods = [{ name: 'start', params: [], returns: null }]
    const storeModule = next.modules
      .find((m) => m.name === 'Plant')!
      .modules!.find((m) => m.name === 'Store')!
    storeModule.ports.find((x) => x.name === 'query')!.name = 'lookup'
    for (const l of next.links)
      if (l.to.module === 'Plant.Store' && l.to.port === 'query') l.to.port = 'lookup'
    const third = await generateInto(next, cpp17(), dir)
    expect(third.conflicts).toEqual([])
    expect(dir.files['src/main.cpp']).toContain('    run(system);')
    expect(dir.files['src/Client.cpp']).toContain('void Client::start()')
    expect(third.orphans).toEqual([{ path: store, ids: ['on.query.get'] }])
    expect(dir.files[`${store}.orphans`]).toContain('return key == "x";')
  })

  it('leaves files changed outside their sections alone', async () => {
    const plant = exported('tests/fixtures/plant.scaffold.yaml')
    const dir = memoryDir()
    await generateInto(plant, cpp17(), dir)
    dir.files['src/Client.cpp'] += '// hand edit\n'
    const r = await generateInto(plant, cpp17(), dir)
    expect(r.conflicts).toEqual([{ path: 'src/Client.cpp', reason: 'changed outside its user sections' }])
    expect(dir.files['src/Client.cpp']).toContain('// hand edit')
    const forced = await generateInto(plant, cpp17(), dir, { force: true })
    expect(forced.written).toEqual(['src/Client.cpp'])
    expect(dir.files['src/Client.cpp']).not.toContain('// hand edit')
  })

  it('reports files no longer generated, and prunes them', async () => {
    const plant = exported('tests/fixtures/plant.scaffold.yaml')
    const dir = memoryDir()
    await generateInto(plant, cpp17(), dir)
    const next = structuredClone(plant)
    next.modules = next.modules.filter((m) => m.name !== 'Client')
    next.links = next.links.filter((l) => l.from.module !== 'Client' && l.to.module !== 'Client')
    dir.files['src/Client.cpp'] = withSection(dir.files['src/Client.cpp']!, 'constructor', '    hello();')
    const r = await generateInto(next, cpp17(), dir)
    expect(r.stale).toEqual(['include/plant_demo/Client.hpp', 'src/Client.cpp'])
    const pruned = await generateInto(next, cpp17(), dir, { prune: true })
    expect(pruned.removed).toEqual(['include/plant_demo/Client.hpp', 'src/Client.cpp'])
    expect(dir.files['src/Client.cpp']).toBeUndefined()
    expect(dir.files['src/Client.cpp.orphans']).toContain('hello();')
  })
})
