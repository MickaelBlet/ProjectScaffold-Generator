import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import { buildContext } from '@/codegen/context'
import { createEngine, generate, outputPath, trimTagLines } from '@/codegen/generate'
import {
  generatedFiles,
  generateInto,
  generationInput,
  RECORD,
  reportEntries,
  type OutputDir
} from '@/codegen/run'
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

describe('C++17 partials', () => {
  const plant = exported('tests/fixtures/plant.scaffold.yaml')
  const ctx = buildContext(plant)
  const set = cpp17()
  const liquid = createEngine(
    Object.fromEntries(Object.entries(set.files).map(([k, v]) => [k, trimTagLines(v)])),
    { ...ctx, files: [], generator: { name: set.manifest.name, reserved: set.manifest.reserved } }
  )
  const render = (partial: string, params: Record<string, unknown>): string =>
    String(
      liquid.parseAndRenderSync(
        `{% render '${partial}', ${Object.keys(params)
          .map((k) => `${k}: ${k}`)
          .join(', ')} %}`,
        params
      )
    )
  const reading = ctx.types.find((t) => t.name === 'Reading')!
  if (reading.kind !== 'struct') throw new Error()
  const field = (n: string) => reading.fields.find((x) => x.name === n)!

  it('spell types', () => {
    expect(render('_type', { t: field('tags').type })).toBe('std::map<std::string, std::int32_t>')
    expect(render('_type', { t: field('note').type })).toBe('std::optional<std::string>')
    expect(render('_type', { t: field('state').type })).toBe('::plant_demo::State')
    expect(render('_type', { t: null })).toBe('void')
  })

  it('write default values as literals', () => {
    const v = (n: string) => render('_value', { v: field(n).default, t: field(n).type })
    expect(v('value')).toBe('1.5')
    expect(v('state')).toBe('::plant_demo::State::On')
    expect(v('tags')).toBe('{{"a", 1}}')
    expect(v('note')).toBe('std::nullopt')
    expect(v('label')).toBe('"say \\"hi\\""')
    expect(v('count')).toBe('7ULL')
    const sensor = ctx.modules.find((m) => m.path === 'Plant.Sensor')!
    const history = sensor.attributes.find((a) => a.name === 'history')!
    expect(render('_value', { v: history.default, t: history.type })).toBe(
      '{::plant_demo::Reading{2.0, ::plant_demo::State::On, {{"a", 1}}, std::nullopt, "say \\"hi\\"", 7ULL}}'
    )
  })

  it('pass scalars by value and the rest by reference', () => {
    const get = ctx.interfaces.find((i) => i.name === 'Query')!.messages[0]!
    expect(render('_params', { params: get.params })).toBe('const std::string& key, double& value')
  })

  it('rename reserved words', () => {
    expect(render('_id', { name: 'operator' })).toBe('operator_')
    expect(render('_accessor', { name: 'Operator' })).toBe('operatorModule')
    expect(render('_member', { name: 'delete' })).toBe('deleteMember_')
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
    expect(ctx.system!.connections.map((c) => c.link.name)).toEqual(['operator_to_core'])
    expect(ctx.types.map((t) => t.name)).toEqual(['Primitive'])
    expect(ctx.allTypes.find((t) => t.name === 'Pose')?.dependency).toBe('Common')
    const controller = ctx.modules.find((m) => m.path === 'Core.Controller')!
    expect(controller.uses.types.map((t) => t.name)).toEqual(['Mode'])
    expect(controller.uses.builtins).toEqual(['bool', 'uint32'])
  })

  it('finds delegations through containers', () => {
    const ctx = buildContext(exported('tests/fixtures/plant.scaffold.yaml'))
    const plant = ctx.modules.find((m) => m.path === 'Plant')!
    const port = (n: string) => plant.ports.find((p) => p.name === n)!
    expect(port('feed').delegates).toEqual([
      { via: ['Group', 'Filter'], module: 'Plant.Group.Filter', port: 'in' }
    ])
    expect(port('out').delegates).toEqual([{ via: ['Group'], module: 'Plant.Group', port: 'out' }])
    expect(ctx.system!.connections.map((c) => [c.link.name, c.to.via])).toEqual([
      ['ask_store', ['Plant', 'Store']],
      ['plant_to_client', ['Client']]
    ])
    // Abstract modules without ports are classes only.
    expect(ctx.system!.instances.map((m) => m.name)).toEqual(['Plant', 'Client'])
  })

  it('lists the links between binaries, and the types their calls use', () => {
    const ctx = buildContext(exported('tests/fixtures/relay.scaffold.yaml'))
    expect(ctx.remoteLinks.map((r) => [r.index, r.link.name, r.from.binary, r.to.binary])).toEqual([
      [0, 'echo_tcp', 'Client', 'Server'],
      [1, 'echo_udp', 'Client', 'Server'],
      [2, 'echo_http', 'Client', 'Server'],
      [3, 'echo_websocket', 'Client', 'Server'],
      [4, 'echo_shm', 'Client', 'Server'],
      [5, 'echo_mqtt', 'Client', 'Server'],
      [6, 'status', 'Server', 'Client']
    ])
    const client = ctx.systems.find((s) => s.binary?.name === 'Client')!
    expect(client.proxies.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5])
    expect(client.stubs.map((r) => [r.index, r.interface.name])).toEqual([[6, 'Status']])
    // Through the parameters, the raised exceptions and the fields of Sample, Tree and Badge, sorted by name.
    expect(ctx.remoteTypes.map((t) => t.name)).toEqual([
      'Access',
      'Badge',
      'Command',
      'Item',
      'Mode',
      'Names',
      'Numbers',
      'Refused',
      'Sample',
      'Samples',
      'Timeout',
      'Tree',
      'Vec3'
    ])
    expect(ctx.constants.map((c) => c.name)).toEqual([
      'MaxNames',
      'Greeting',
      'DefaultMode',
      'DefaultAccess',
      'Origin',
      'Weights',
      'FirstItem'
    ])
    expect(ctx.remoteConstants).toHaveLength(7)
    expect(ctx.constantsFile.uses.types.map((t) => t.name)).toEqual(['Access', 'Item', 'Mode', 'Vec3'])
    // Raised exceptions: types of the calls, in order.
    const echoCheck = ctx.interfaces[0]!.messages.find((m) => m.name === 'check')!
    expect(echoCheck.raises.map((r) => [r.name, r.typeKind])).toEqual([
      ['Refused', 'exception'],
      ['Timeout', 'exception']
    ])
    // Unions: the label set with each case, a free one for the default case.
    const item = ctx.types.find((t) => t.name === 'Item')!
    expect(item.kind === 'union' && item.cases.map((c) => [c.name, c.label, c.index])).toEqual([
      ['number', 1, 1],
      ['names', -3, 2],
      ['text', 0, 3]
    ])
    expect(item.uses.builtins).toEqual(['int16', 'int32', 'string', 'variant'])
    const scale = ctx.interfaces.find((i) => i.name === 'Echo')!.messages.find((m) => m.name === 'scale')!
    expect(scale.inputs.map((p) => p.name)).toEqual(['v', 'factor'])
    expect(scale.outputs.map((p) => p.name)).toEqual(['v'])
    expect(buildContext(exported('tests/fixtures/plant.scaffold.yaml')).remoteLinks).toEqual([])
  })
})

describe('C++17 generation', () => {
  it('generates the robot', () => {
    const { files, warnings } = generate(exported('examples/robot.scaffold.yaml'), cpp17())
    expect(files.map((f) => f.path)).toMatchSnapshot()
    expect(files.find((f) => f.path === 'include/robot/core/Controller.hpp')?.text).toMatchSnapshot()
    expect(files.find((f) => f.path === 'src/Core.cpp')?.text).toMatchSnapshot()
    expect(warnings).toEqual([])
  })

  it('generates the rover: modules wired by their ports only', () => {
    const { files, warnings } = generate(exported('examples/rover.scaffold.yaml'), cpp17())
    expect(warnings).toEqual([])
    const text = (path: string): string => files.find((f) => f.path === path)!.text
    expect(text('include/rover/Perception.hpp')).toContain(
      '::rover::IFrameSink& frames() { return preprocess().in(); }'
    )
    expect(text('src/Perception.cpp')).toContain('detector().out().forward(detections_);')
    expect(text('src/Motors.cpp')).toContain('void Motors::onDriveCommand(const ::rover::Command& command)')
  })

  it('generates one executable per binary, linked through proxies and stubs', () => {
    const { files, warnings } = generate(exported('examples/rover.scaffold.yaml'), cpp17())
    expect(warnings).toEqual([])
    const paths = files.map((f) => f.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        'include/rover/remote/LifecycleProxy.hpp',
        'include/rover/remote/LifecycleStub.hpp',
        'include/rover/remote/HealthQueryProxy.hpp',
        'include/rover/remote/HealthQueryStub.hpp',
        'include/rover/OnboardSystem.hpp',
        'include/rover/GroundSystem.hpp',
        'src/onboard/main.cpp',
        'src/ground/main.cpp'
      ])
    )
    expect(paths).not.toContain('src/main.cpp')
    const text = (path: string): string => files.find((f) => f.path === path)!.text
    expect(text('src/GroundSystem.cpp')).toContain('supervisor().camera().connect(superviseCameraProxy_);')
    expect(text('src/OnboardSystem.cpp')).toContain('superviseCameraStub_.bind(camera().lifecycle());')
    expect(text('src/OnboardSystem.cpp')).toContain('camera().frames().connect(recorder().frames());')
    expect(text('include/rover/OnboardSystem.hpp')).not.toContain('supervisor')
    expect(text('include/rover/remote/LifecycleProxy.hpp')).toContain(
      'class LifecycleProxy final : public ::rover::ILifecycle {'
    )
    expect(text('CMakeLists.txt')).toContain('add_executable(rover_onboard src/onboard/main.cpp)')
    expect(text('CMakeLists.txt')).toContain('add_executable(rover_ground src/ground/main.cpp)')
  })

  it('generates the transports of the links between binaries, and Python peers', () => {
    const { files, warnings } = generate(exported('tests/fixtures/relay.scaffold.yaml'), cpp17())
    expect(warnings).toEqual([])
    const paths = files.map((f) => f.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        'include/relay/remote/wire.hpp',
        'include/relay/remote/codec.hpp',
        'include/relay/remote/transport.hpp',
        'src/remote/transport.cpp',
        'python/relay/wire.py',
        'python/relay/transport.py',
        'python/relay/links.py',
        'python/relay/data.py',
        'python/relay/remote/echo.py',
        'python/relay/remote/status.py',
        'python/relay/peers/client.py',
        'python/relay/peers/server.py'
      ])
    )
    const text = (path: string): string => files.find((f) => f.path === path)!.text
    const client = text('src/ClientSystem.cpp')
    expect(client).toContain(
      'echoUdpProxy_.open(remote::connect("udp", remote::address("RELAY_ECHO_UDP", "127.0.0.1:47001")),\n' +
        '        false, std::chrono::milliseconds(5000));'
    )
    // Settings of the links: client and server ends, http path, shared memory name and capacity.
    expect(client).toContain('remote::address("RELAY_ECHO_TCP", "127.0.0.1:47210")')
    expect(client).toContain('remote::address("RELAY_ECHO_HTTP", "127.0.0.1:47002"), "/relay/echo")')
    expect(client).toContain('remote::address("RELAY_ECHO_WEBSOCKET", "127.0.0.1:47003"), "/echo_websocket")')
    expect(client).toContain('remote::address("RELAY_ECHO_SHM", "relay_echo_segment")')
    const server = text('src/ServerSystem.cpp')
    expect(server).toContain(
      'echoTcpStub_.serve("tcp", remote::address("RELAY_ECHO_TCP_LISTEN", "0.0.0.0:47210"));'
    )
    expect(server).toContain(
      'echoShmStub_.serve("shm", remote::address("RELAY_ECHO_SHM_LISTEN", "relay_echo_segment"), 4194304);'
    )
    // No transport generated for mqtt: left to a user section.
    expect(client).not.toContain('remote::connect("mqtt"')
    expect(client).toContain('// Open echoMqttProxy_ with a remote::Channel to binary Server over mqtt.')
    expect(client).toContain('    // Settings: broker broker.local:1883, topic relay/echo, qos=1.')
    expect(client).toContain(
      'statusStub_.serve("tcp", remote::address("RELAY_STATUS_LISTEN", "127.0.0.1:47006"));'
    )
    expect(text('src/server/main.cpp')).toContain('relay::remote::waitForStop();')
    expect(text('CMakeLists.txt')).toContain('src/remote/transport.cpp')
    expect(text('CMakeLists.txt')).toContain(
      'target_link_libraries(relay ${SCAFFOLD_SCOPE} Threads::Threads)'
    )
    const proxy = text('include/relay/remote/EchoProxy.hpp')
    expect(proxy).toContain('const Bytes reply_ = caller_.call(2, request_.bytes(), true);')
    expect(proxy).toContain('caller_.call(3, request_.bytes(), false);')
    expect(text('include/relay/remote/codec.hpp')).toContain('    encode(w, v.children);')
    expect(text('python/relay/data.py')).toContain('    w.map(v.tags, Writer.string, Writer.int32)')
    expect(text('python/relay/remote/echo.py')).toContain(
      '    def scale(self, v: _data.Vec3, factor: float) -> Tuple[bool, _data.Vec3]:'
    )
    const peer = text('python/relay/peers/client.py')
    expect(peer).toContain('self.echo_tcp = EchoProxy.connect(links.ECHO_TCP)')
    expect(peer).not.toContain('links.ECHO_MQTT')
    expect(text('python/relay/links.py')).toContain(
      "ECHO_SHM = Link('echo_shm', 4, 'Echo', 'shm', 'RELAY_ECHO_SHM', 'relay_echo_segment', 'RELAY_ECHO_SHM_LISTEN', " +
        "'relay_echo_segment', '/', 4194304, 'name relay_echo_segment, capacity 4194304', {}, True, 2, 'Client', 'Server')"
    )
    expect(text('python/relay/links.py')).toContain(
      "'/', 1048576, 'broker broker.local:1883, topic relay/echo, qos=1', {'qos': '1'}"
    )
    // Project defaults: hosts of both ends, first port.
    const relay = exported('tests/fixtures/relay.scaffold.yaml')
    relay.remoteDefaults = { client: { host: '10.0.0.2' }, server: { host: '::' }, basePort: 50000 }
    const moved = generate(relay, cpp17()).files
    const at = (path: string): string => moved.find((f) => f.path === path)!.text
    expect(at('src/ClientSystem.cpp')).toContain('remote::address("RELAY_ECHO_UDP", "10.0.0.2:50001")')
    expect(at('src/ServerSystem.cpp')).toContain('remote::address("RELAY_ECHO_UDP_LISTEN", "[::]:50001")')
    // Without links between binaries: neither transports nor Python.
    const plain = generate(exported('tests/fixtures/plant.scaffold.yaml'), cpp17()).files.map((f) => f.path)
    expect(plain.filter((p) => p.includes('remote') || p.startsWith('python/'))).toEqual([])
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
    // Listed with the files generated, beside its file.
    const listed = await generatedFiles(dir)
    expect(listed).toContain(store)
    expect(listed[listed.indexOf(store) + 1]).toBe(`${store}.orphans`)
    expect(listed).not.toContain(RECORD)
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

describe('report entries', () => {
  it('lists files as information and problems as warnings, with the file to open', () => {
    const entries = reportEntries({
      written: ['a.hpp'],
      unchanged: ['b.hpp'],
      conflicts: [{ path: 'c.cpp', reason: 'changed outside its user sections' }],
      orphans: [{ path: 'd.cpp', ids: ['init'] }],
      stale: ['e.cpp'],
      removed: ['f.cpp'],
      warnings: ['unknown type']
    })
    expect(entries.map((e) => [e.level, e.path])).toEqual([
      ['info', 'a.hpp'],
      ['info', 'b.hpp'],
      ['info', undefined],
      ['warning', 'c.cpp'],
      ['warning', 'd.cpp.orphans'],
      ['warning', 'e.cpp'],
      ['warning', undefined]
    ])
    expect(entries[3]!.text).toContain('changed outside its user sections')
    expect(entries[4]!.text).toContain('init')
  })
})
