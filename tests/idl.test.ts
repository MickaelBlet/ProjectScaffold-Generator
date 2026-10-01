import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  IdlError,
  idlImport,
  idlProject,
  parseIdl,
  parseIdlFiles,
  readIdlIncludes,
  type IdlFile
} from '@/model/idl'
import { addDependency, dependencyOf } from '@/model/dependencies'
import { pasteClip } from '@/model/clipboard'
import { emptyProject } from '@/model/project'
import { printTypeExpr, printTypeRef } from '@/model/typeExpr'
import { validate } from '@/model/validate'

const SRC = `
#include "base.idl"
#pragma prefix "acme"

module Robot {
  const long AXES = 3;

  /** Position in meters. */
  struct Vec3 { double x, y, z; };

  enum Mode { IDLE, @value(10) RUN, STOP };
  const Mode START = RUN; // first mode
  const string NAME = "robot";

  typedef sequence<Vec3> Path;
  typedef double Matrix[AXES][AXES + 1];

  struct Pose : Vec3 {
    @optional float heading; // degrees
    string<16> frame;
  };

  enum Shape { CIRCLE, SQUARE, LINE };
  union Payload switch (long) { case 1: case 2: long a; default: string b; };
  union Figure switch (Shape) { case CIRCLE: double radius; case Shape::SQUARE: Vec3 side; };

  exception Busy { string reason; };

  module Control {
    // Motion commands.
    interface Motion {
      void move(in Path path, out boolean done) raises (Busy);
      Mode mode();
      oneway void stop();
      readonly attribute Pose pose raises (Busy);
      attribute unsigned long long speed;
      sequence<octet> dump(in map<string, Payload> items, inout ::Robot::Unknown u);
    };

    interface Arm : Motion { void grip(in long force); };
  };
};
`

const typeNamed = (idl: IdlFile, name: string) => idl.types.find((t) => t.name === name)
const alias = (idl: IdlFile, name: string) => {
  const t = typeNamed(idl, name)
  return t?.kind === 'alias' ? printTypeExpr(t.type) : undefined
}
const fields = (idl: IdlFile, name: string) => {
  const t = typeNamed(idl, name)
  return t?.kind === 'struct' || t?.kind === 'exception'
    ? t.fields.map((f) => `${printTypeExpr(f.type)} ${f.name}`)
    : undefined
}
const signatures = (messages: IdlFile['interfaces'][number]['messages']) =>
  messages.map(
    (m) =>
      `${m.name}(${m.params.map((p) => `${p.direction} ${printTypeExpr(p.type)} ${p.name}`).join(', ')})` +
      (m.returns ? `: ${printTypeExpr(m.returns)}` : '')
  )
const sig = (idl: IdlFile, name: string) => signatures(idl.interfaces.find((i) => i.name === name)!.messages)

/** Every definition of `idl` pasted into an empty project: no validation errors. */
function importsCleanly(idl: IdlFile): void {
  const p = emptyProject()
  const { clip } = idlImport(idl, p)
  pasteClip(p, clip!, { parent: null })
  expect(validate(p).filter((x) => x.severity === 'error')).toEqual([])
}

describe('IDL import', () => {
  const idl = parseIdl(SRC)

  it('reads types', () => {
    expect(typeNamed(idl, 'Vec3')).toMatchObject({ kind: 'struct', description: 'Position in meters.' })
    expect(fields(idl, 'Vec3')).toEqual(['float64 x', 'float64 y', 'float64 z'])
    expect(typeNamed(idl, 'Mode')).toMatchObject({
      kind: 'enum',
      underlying: 'int32',
      values: [
        { name: 'IDLE', value: 0 },
        { name: 'RUN', value: 10 },
        { name: 'STOP', value: 11 }
      ]
    })
    expect(alias(idl, 'Path')).toBe('vector<Vec3>')
    expect(alias(idl, 'Matrix')).toBe('array<array<float64, 4>, 3>')
    const pose = typeNamed(idl, 'Pose')
    expect(
      pose?.kind === 'struct' && pose.fields.map((f) => [f.name, printTypeExpr(f.type), f.description])
    ).toEqual([
      ['x', 'float64', undefined],
      ['y', 'float64', undefined],
      ['z', 'float64', undefined],
      ['heading', 'optional<float32>', 'degrees'],
      ['frame', 'string<16>', undefined]
    ])
    expect(typeNamed(idl, 'Payload')).toEqual({
      kind: 'union',
      name: 'Payload',
      description: '',
      discriminator: { kind: 'primitive', name: 'int32' },
      cases: [
        { name: 'a', type: { kind: 'primitive', name: 'int32' }, description: '', labels: [1, 2] },
        { name: 'b', type: { kind: 'primitive', name: 'string' }, description: '', default: true }
      ]
    })
    expect(typeNamed(idl, 'Figure')).toMatchObject({
      discriminator: { kind: 'ref', name: 'Shape' },
      cases: [
        { name: 'radius', labels: ['CIRCLE'] },
        { name: 'side', labels: ['SQUARE'], type: { kind: 'ref', name: 'Vec3' } }
      ]
    })
    expect(fields(idl, 'Busy')).toEqual(['string reason'])
    expect(typeNamed(idl, 'Busy')?.kind).toBe('exception')
    expect(idl.warnings).toEqual(['Line 2: base.idl not found'])
    expect(idl.missing).toEqual(['base.idl'])
    expect(idl.constants).toEqual([
      { name: 'AXES', description: '', type: { kind: 'primitive', name: 'int32' }, value: 3 },
      { name: 'START', description: 'first mode', type: { kind: 'ref', name: 'Mode' }, value: 'RUN' },
      { name: 'NAME', description: '', type: { kind: 'primitive', name: 'string' }, value: 'robot' }
    ])
  })

  it('imports the constants of the whole file, with their types', () => {
    const t = parseIdl('module M { enum E { A, B }; const E FIRST = A; const short N = -2; };')
    const { clip } = idlImport(t, emptyProject())
    expect(clip!.consts!.map((c) => [c.name, c.value])).toEqual([
      ['FIRST', 'A'],
      ['N', -2]
    ])
    expect(clip!.types.map((x) => x.name)).toEqual(['E'])
    expect(idlImport(t, emptyProject(), []).clip).toBeNull()
  })

  it('reads interfaces', () => {
    const motion = idl.interfaces.find((i) => i.name === 'Motion')!
    expect(motion.description).toBe('Motion commands.')
    expect(sig(idl, 'Motion')).toEqual([
      'move(in Path path, out bool done)',
      'mode(): Mode',
      'stop()',
      'get_pose(): Pose',
      'get_speed(): uint64',
      'set_speed(in uint64 speed)',
      'dump(in map<string, Payload> items, inout Unknown u): bytes'
    ])
    expect(motion.messages[0]!.raises).toEqual(['Busy'])
    expect(motion.messages.find((m) => m.name === 'get_pose')!.raises).toEqual(['Busy'])
    expect(idl.needs).toEqual({ Motion: ['Busy'], Arm: ['Busy'] })
    expect(sig(idl, 'Arm')).toEqual([...sig(idl, 'Motion'), 'grip(in int32 force)'])
  })

  it('imports an interface with the types it uses and the exceptions it raises', () => {
    const p = emptyProject()
    const { clip, unresolved } = idlImport(idl, p, ['Motion'])
    expect(unresolved).toEqual(['Unknown'])
    expect(clip!.interfaces.map((i) => i.name)).toEqual(['Motion'])
    expect(clip!.types.map((t) => t.name).sort()).toEqual([
      'Busy',
      'Mode',
      'Path',
      'Payload',
      'Pose',
      'Unknown',
      'Vec3'
    ])
    pasteClip(p, clip!, { parent: null })
    expect(validate(p).filter((x) => x.severity === 'error')).toEqual([])
    const names = (id: string) => [...p.types, ...p.interfaces].find((e) => e.id === id)?.name
    const move = p.interfaces[0]!.messages[0]!
    expect(printTypeRef(move.params[0]!.type, names)).toBe('Path')
  })

  it('keeps the types the project has', () => {
    const p = emptyProject()
    pasteClip(p, idlImport(idl, p, ['Vec3']).clip!, { parent: null })
    const vec = p.types[0]!.id
    const { clip, existing } = idlImport(idl, p, ['Motion'])
    expect(existing).toEqual(['Vec3'])
    expect(clip!.types.some((t) => t.name === 'Vec3')).toBe(false)
    pasteClip(p, clip!, { parent: null })
    const path = p.types.find((t) => t.name === 'Path')
    expect(path?.kind === 'alias' && path.type).toEqual({ kind: 'vector', of: { kind: 'ref', id: vec } })
    expect(idlImport(idl, p, ['Motion']).clip).toBeNull()
  })

  it('imports every type of a file without interfaces', () => {
    const { clip } = idlImport(parseIdl('struct A { long x; }; typedef A B;'), emptyProject())
    expect(clip!.types.map((t) => t.name)).toEqual(['A', 'B'])
  })

  it('reports syntax errors with their line and file', () => {
    expect(() => parseIdl('struct A {\n  long;\n};')).toThrow(IdlError)
    expect(() => parseIdl('struct A {\n  long;\n};')).toThrow(/^Line 2: expected an identifier/)
    const files = new Map([['dir/bad.idl', '\n\nstruct B { long };']])
    expect(() => parseIdl('#include "bad.idl"', { file: 'dir/main.idl', files })).toThrow(
      /^Line 3 of bad.idl/
    )
  })

  it('evaluates constant expressions', () => {
    const t = parseIdl(`
      const long N = (1 << 2) + 1;
      const unsigned long long BIG = 0xFFFFFFFFFFFFFFFF;
      const long OCT = 010;
      const boolean B = TRUE;
      typedef sequence<sequence<long>> S;
      typedef octet A[N * 2];
      typedef octet O[OCT];
      typedef octet R[(BIG >> 62) | 0x10];
      module M { const short K = 2; };
      typedef long Q[M :: K];
    `)
    expect(alias(t, 'S')).toBe('vector<vector<int32>>')
    expect(alias(t, 'A')).toBe('array<uint8, 10>')
    expect(alias(t, 'O')).toBe('array<uint8, 8>')
    expect(alias(t, 'R')).toBe('array<uint8, 19>')
    expect(alias(t, 'Q')).toBe('array<int32, 2>')
  })

  it('preprocesses: macros, conditions, includes once', () => {
    const files = new Map([
      [
        '/idl/common/types.idl',
        `#ifndef TYPES_IDL
         #define TYPES_IDL
         module Common { struct Stamp { long long ns; }; };
         #endif`
      ],
      ['/idl/robot/limits.idl', '#include "../common/types.idl"\nconst long LIMIT = 4;']
    ])
    const t = parseIdl(
      `#include "limits.idl"
       #include <common/types.idl>
       #define SIZE (LIMIT * 2)
       #define SEQ(T, N) sequence<T, N>
       #define NAME(x) x ## _t
       #define STR(x) #x
       #if defined(SIZE) && !defined(NOPE) && (2 > 1 ? 1 : 0)
       typedef SEQ(Common::Stamp, SIZE) Stamps;
       #elif 1
       typedef long Wrong;
       #else
       typedef long Wrong2;
       #endif
       #ifdef NOPE
       garbage that is never read !
       #endif
       typedef long NAME(id);
       const string S = STR(hello);
       #undef SIZE
       #ifndef SIZE
       typedef long Undefined;
       #endif
       import "../common/types.idl";`,
      { file: '/idl/robot/main.idl', files }
    )
    expect(alias(t, 'Stamps')).toBe('vector<Stamp, 8>')
    expect(typeNamed(t, 'Wrong')).toBeUndefined()
    expect(typeNamed(t, 'Wrong2')).toBeUndefined()
    expect(alias(t, 'id_t')).toBe('int32')
    expect(alias(t, 'Undefined')).toBe('int32')
    expect(t.types.filter((x) => x.name === 'Stamp')).toHaveLength(1)
    expect(t.warnings).toEqual([])
    expect(() => parseIdl('#if 1\nstruct A { long x; };')).toThrow(/missing #endif/)
    expect(() => parseIdl('#error unsupported')).toThrow(/#error unsupported/)
  })

  it('finds includes by name among picked files, and reads them with the host', async () => {
    const picked = new Map([
      ['main.idl', '#include "sub/a.idl"\nstruct M { A a; B b; };'],
      ['a.idl', 'struct A { long x; };']
    ])
    expect(fields(parseIdlFiles(picked), 'M')).toEqual(['A a', 'B b'])
    expect(parseIdlFiles(picked).missing).toEqual([])

    const disk: Record<string, string> = {
      '/w/idl/main.idl': '#include "inc/b.idl"\n#include "shared.idl"',
      '/w/idl/inc/b.idl': 'struct B { long y; };',
      '/w/shared.idl': 'struct S { long z; };'
    }
    const read = (path: string) => Promise.resolve(disk[path] ?? null)
    const files = await readIdlIncludes(new Map([['/w/idl/main.idl', disk['/w/idl/main.idl']!]]), read)
    expect([...files.keys()].sort()).toEqual(['/w/idl/inc/b.idl', '/w/idl/main.idl', '/w/shared.idl'])
    expect(parseIdlFiles(files).types.map((x) => x.name)).toEqual(['B', 'S'])
  })

  it('reads an IDL file as a project, its includes as dependencies', () => {
    const files = new Map([
      ['idl/main.idl', '#include "inc/a.idl"\nstruct M { A a; B b; };\ncomponent Main { provides IA ia; };'],
      [
        'idl/inc/a.idl',
        '#include "../b.idl"\nstruct A { B b; };\ninterface IA { void go(); };\ncomponent Other {};'
      ],
      ['idl/b.idl', 'struct B { long y; };\nconst long MAX = 3;']
    ])
    const { project: p, warnings } = idlProject('idl/main.idl', files)
    expect(warnings).toEqual([])
    expect(p.name).toBe('main')
    expect(p.dependencies.map((x) => [x.name, x.file, x.uses, x.indirect])).toEqual([
      ['a', 'inc/a.idl', ['b'], false],
      ['b', 'b.idl', [], true]
    ])
    const owner = (name: string) =>
      dependencyOf(p, [...p.types, ...p.interfaces, ...p.consts].find((e) => e.name === name)!.id)?.name
    expect(['M', 'A', 'IA', 'B', 'MAX'].map(owner)).toEqual([undefined, 'a', 'a', 'b', 'b'])
    // Components of included files belong to their own project.
    expect(p.modules.map((m) => m.name)).toEqual(['Main'])
    expect(validate(p).filter((x) => x.severity === 'error')).toEqual([])

    // Depended on like a project file: the files it includes come with it.
    const d = emptyProject()
    addDependency(d, p, 'idl/main.idl', null)
    expect(d.dependencies.map((x) => [x.name, x.file, x.indirect])).toEqual([
      ['main', 'idl/main.idl', false],
      ['a', 'idl/inc/a.idl', true],
      ['b', 'idl/b.idl', true]
    ])
    expect(d.types.map((t) => t.name).sort()).toEqual(['A', 'B', 'M'])
  })

  it('resolves scoped names and qualifies names several modules use', () => {
    const t = parseIdl(`
      module A { struct Status { long a; }; struct Use { Status s; }; };
      module B {
        struct Status { long b; };
        struct Use2 { Status s; ::A::Status t; A::Status u; };
        interface I { typedef long Local; Local get(); };
        interface J : I { Local again(); };
      };
      struct set { long x; };
    `)
    expect(fields(t, 'Use')).toEqual(['A_Status s'])
    expect(fields(t, 'Use2')).toEqual(['B_Status s', 'A_Status t', 'A_Status u'])
    expect(sig(t, 'J')).toEqual(['get(): Local', 'again(): Local'])
    expect(typeNamed(t, 'set_')).toMatchObject({ kind: 'struct' })
    expect(t.warnings).toEqual([
      'A::Status imported as A_Status',
      'B::Status imported as B_Status',
      'set imported as set_'
    ])
    importsCleanly(t)
  })

  it('imports object references as custom primitives', () => {
    const t = parseIdl(`
      interface Node;
      interface Tree { Node root(); any value(); Object raw(); };
      interface Node { Tree owner(); };
    `)
    expect(sig(t, 'Tree')).toEqual(['root(): NodeRef', 'value(): Any', 'raw(): Object'])
    expect(typeNamed(t, 'NodeRef')).toMatchObject({
      kind: 'primitive',
      description: 'Reference to a Node object'
    })
    expect(t.needs).toMatchObject({ NodeRef: ['Node'], TreeRef: ['Tree'] })
    const { clip } = idlImport(t, emptyProject(), ['Tree'])
    expect(clip!.interfaces.map((i) => i.name).sort()).toEqual(['Node', 'Tree'])
    importsCleanly(t)
  })

  it('reads annotations', () => {
    const t = parseIdl(`
      @annotation Units { string value; };
      @bit_bound(8) enum Small { @value(1) ONE, TWO };
      @bit_bound(16) bitmask Flags { A, @position(9) B };
      bitmask Big { A, @position(63) TOP };
      @final @topic
      struct S {
        @key @default(3) long count;
        @unit("m") @range(min=0, max=10.5) double length;
        @default(TWO) Small small;
        @verbatim(language="c++", text="x") @external @id(4) long other;
      };
    `)
    expect(typeNamed(t, 'Small')).toMatchObject({ underlying: 'uint8', values: [{ value: 1 }, { value: 2 }] })
    expect(typeNamed(t, 'Flags')).toMatchObject({
      kind: 'bitmask',
      underlying: 'uint16',
      flags: [
        { name: 'A', bit: 0 },
        { name: 'B', bit: 9 }
      ]
    })
    expect(typeNamed(t, 'Big')).toMatchObject({ underlying: 'uint64', flags: [{ bit: 0 }, { bit: 63 }] })
    const s = typeNamed(t, 'S')
    expect(s?.kind === 'struct' && s.fields.map((f) => [f.name, f.default, f.description])).toEqual([
      ['count', 3, undefined],
      ['length', undefined, 'Unit: m.\nRange: 0 to 10.5.'],
      ['small', 'TWO', undefined],
      ['other', undefined, undefined]
    ])
    importsCleanly(t)
  })

  it('reads valuetypes, eventtypes, bitsets and other definitions', () => {
    const t = parseIdl(`
      typeprefix M "acme.com";
      native Handle;
      valuetype Name string;
      abstract valuetype Shape { double area(); };
      valuetype Base { public long id; };
      custom valuetype Circle : truncatable Base supports Shape {
        public double radius;
        private string secret;
        factory create(in double r);
        double area();
      };
      eventtype Alarm { public string text; };
      bitset Bits { bitfield<1> on; bitfield<3> level, mode; bitfield<2>; bitfield<12, short> big; };
      typedef struct Inner { long v; } InnerAlias;
      struct Outer { struct Nested { long n; } nested; enum Color { RED, GREEN } color; };
      typeid Base "IDL:Base:1.0";
      typedef fixed<10, 2> Money;
      typedef long double Precise;
    `)
    expect(typeNamed(t, 'Handle')).toMatchObject({ kind: 'primitive' })
    expect(alias(t, 'Name')).toBe('optional<string>')
    expect(sig(t, 'Shape')).toEqual(['area(): float64'])
    expect(fields(t, 'Circle')).toEqual(['int32 id', 'float64 radius', 'string secret'])
    expect(fields(t, 'Alarm')).toEqual(['string text'])
    expect(fields(t, 'Bits')).toEqual(['bool on', 'uint8 level', 'uint8 mode', 'int16 big'])
    expect(alias(t, 'InnerAlias')).toBe('Inner')
    expect(fields(t, 'Outer')).toEqual(['Nested nested', 'Color color'])
    expect(alias(t, 'Money')).toBe('float64')
    expect(t.warnings).toEqual([
      'Line 7: valuetype Circle: 2 operations, factories or attributes left out',
      'Line 14: bitset Bits imported as a struct of its bitfields',
      'Line 18: fixed imported as float64',
      'Line 19: long double imported as float64'
    ])
    importsCleanly(t)
  })

  it('instantiates template modules', () => {
    const t = parseIdl(`
      module Buffers<typename T, const long N> {
        struct Ring { T items[N]; long head; };
        interface Queue { void push(in T item); };
      };
      module Buffers<double, 8> Doubles;
      module Buffers<string, 2> Strings;
    `)
    expect(fields(t, 'Doubles_Ring')).toEqual(['array<float64, 8> items', 'int32 head'])
    expect(fields(t, 'Strings_Ring')).toEqual(['array<string, 2> items', 'int32 head'])
    expect(sig(t, 'Doubles_Queue')).toEqual(['push(in float64 item)'])
  })

  it('imports components and connectors as modules with ports', () => {
    const t = parseIdl(`
      interface Pump { void start(); };
      interface Admin { void reset(); };
      eventtype Level { public double value; };
      porttype Control { provides Pump pump; uses Admin admin; attribute long rate; };
      component Device supports Admin {
        attribute string serial;
        readonly attribute long errors;
      };
      component Tank : Device {
        provides Pump inlet;
        uses multiple Pump outlets;
        publishes Level level;
        consumes Level alarm;
        port Control ctl;
        mirrorport Control back;
      };
      home TankHome manages Tank { factory build(in long size); };
      connector Wire { mirrorport Control a; };
    `)
    expect(t.components.map((c) => c.name)).toEqual(['Device', 'Tank', 'Wire'])
    const tank = t.components.find((c) => c.name === 'Tank')!
    expect(tank.bases).toEqual(['Device'])
    expect(tank.ports.map((p) => `${p.role} ${p.name}: ${p.interface}`)).toEqual([
      'in inlet: Pump',
      'out outlets: Pump',
      'out level: LevelConsumer',
      'in alarm: LevelConsumer',
      'in ctl_pump: Pump',
      'out ctl_admin: Admin',
      'out back_pump: Pump',
      'in back_admin: Admin'
    ])
    expect(tank.attributes.map((a) => a.name)).toEqual(['ctl_rate', 'back_rate'])
    expect(sig(t, 'LevelConsumer')).toEqual(['push(in Level event)'])
    const device = t.components.find((c) => c.name === 'Device')!
    expect(signatures(device.methods)).toEqual(['reset()'])
    expect(device.attributes.map((a) => [a.name, a.readonly])).toEqual([
      ['serial', false],
      ['errors', true]
    ])
    expect(t.warnings).toEqual(['Line 18: home TankHome left out'])

    const p = emptyProject()
    const { clip } = idlImport(t, p, ['Tank'])
    expect(clip!.modules.map((m) => m.name)).toEqual(['Device', 'Tank'])
    expect(clip!.interfaces.map((i) => i.name).sort()).toEqual(['Admin', 'LevelConsumer', 'Pump'])
    pasteClip(p, clip!, { parent: null })
    expect(validate(p).filter((x) => x.severity === 'error')).toEqual([])
    const tankModule = p.modules.find((m) => m.name === 'Tank')!
    expect(tankModule.bases).toEqual([p.modules.find((m) => m.name === 'Device')!.id])
    expect(tankModule.ports.every((pt) => pt.interfaceId)).toBe(true)
    importsCleanly(t)
  })

  it('adds empty interfaces for ports of unknown interfaces', () => {
    const t = parseIdl('component C { provides Missing m; uses Object o; };')
    const p = emptyProject()
    const { clip, unresolved } = idlImport(t, p)
    expect(unresolved.sort()).toEqual(['Missing', 'Object'])
    expect(clip!.interfaces.map((i) => i.name).sort()).toEqual(['Missing', 'Object'])
    pasteClip(p, clip!, { parent: null })
    expect(validate(p).filter((x) => x.severity === 'error')).toEqual([])
  })

  const examples = new Map(
    readdirSync('examples/idl').map((f) => [f, readFileSync(`examples/idl/${f}`, 'utf8')])
  )
  it.each([...examples.keys()])('imports examples/idl/%s', (file) => {
    const example = parseIdl(examples.get(file)!, { file, files: examples })
    expect(example.missing).toEqual([])
    const p = emptyProject()
    const { clip } = idlImport(example, p)
    pasteClip(p, clip!, { parent: null })
    expect(validate(p).filter((x) => x.severity === 'error')).toEqual([])
    expect({
      types: p.types.map((t) => `${t.kind} ${t.name}`),
      interfaces: p.interfaces.map((i) => i.name),
      modules: p.modules.map((m) => `${m.name}: ${m.ports.map((pt) => `${pt.role} ${pt.name}`).join(', ')}`),
      warnings: example.warnings
    }).toMatchSnapshot()
  })
})
