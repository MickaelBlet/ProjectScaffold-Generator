import YAML from 'yaml'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { fromFile, LoadError, toFile } from '@/model/serialize'
import { assignBinary, binaryOf, removeBinary, settleBinaries, binarySnapshot } from '@/model/binaries'
import { validate } from '@/model/validate'
import type { Project } from '@/model/types'

const text = `
schemaVersion: 1
project: { name: Split }
binaries:
  - { name: Onboard, color: "#2e9e8f" }
  - { name: Ground }
types: []
interfaces:
  - name: Ping
    messages: [{ name: ping, params: [], returns: null }]
modules:
  - name: Camera
    binary: Onboard
    ports: [{ name: out, role: out, interface: Ping }]
    modules:
      - name: Sensor
        ports: [{ name: out, role: out, interface: Ping }]
  - name: Planner
    binary: Onboard
    ports: [{ name: in, role: in, interface: Ping }, { name: out, role: out, interface: Ping }]
  - name: Station
    binary: Ground
    ports: [{ name: in, role: in, interface: Ping }]
links:
  - name: camera_to_planner
    from: { module: Camera, port: out }
    to: { module: Planner, port: in }
    constraints:
      direction: unidirectional
      ack: { required: false }
      performance: { class: normal }
      remote: { enabled: false }
  - name: planner_to_station
    from: { module: Planner, port: out }
    to: { module: Station, port: in }
    constraints:
      direction: unidirectional
      ack: { required: false }
      performance: { class: normal }
      remote: { enabled: true, transport: tcp }
`
const load = (yaml = text): Project => fromFile(YAML.parse(yaml))
const mod = (p: Project, name: string) => p.modules.find((m) => m.name === name)!
const bin = (p: Project, name: string) => p.binaries.find((b) => b.name === name)!
const link = (p: Project, name: string) => p.links.find((l) => l.name === name)!
const problems = (p: Project, severity = 'error') =>
  validate(p)
    .filter((pr) => pr.severity === severity)
    .map((pr) => pr.message)

describe('binaries', () => {
  it('load and save by name, inner modules running in their ancestor', () => {
    const p = load()
    expect(p.binaries.map((b) => b.name)).toEqual(['Onboard', 'Ground'])
    expect(binaryOf(p, mod(p, 'Sensor').id)).toBe(bin(p, 'Onboard').id)
    expect(mod(p, 'Sensor').binaryId).toBeUndefined()
    const file = toFile(p, { editor: false })
    expect(file.binaries).toEqual([{ name: 'Onboard', color: '#2e9e8f' }, { name: 'Ground' }])
    expect(file.modules.map((m) => m.binary)).toEqual(['Onboard', 'Onboard', 'Ground'])
    expect(file.modules[0]!.modules![0]!.binary).toBeUndefined()
    expect(problems(p)).toEqual([])
    expect(problems(p, 'warning')).toEqual([])
  })

  it('rejects unknown binaries and binaries of inner modules', () => {
    expect(() => load(text.replace('binary: Ground', 'binary: Nowhere'))).toThrow(
      "Module 'Station': unknown binary 'Nowhere'"
    )
    expect(() => load(text.replace('- name: Sensor\n', '- name: Sensor\n        binary: Ground\n'))).toThrow(
      LoadError
    )
  })

  it('requires a binary for each top-level module and remote links between binaries', () => {
    const p = produce(load(), (d) => {
      delete mod(d, 'Station').binaryId
      mod(d, 'Planner').binaryId = bin(d, 'Ground').id
      link(d, 'planner_to_station').constraints.remote = { enabled: true }
    })
    expect(problems(p)).toEqual([
      'Station: runs in no binary (the project has binaries)',
      "Link 'camera_to_planner' joins binaries Onboard and Ground: it must be remote"
    ])
    const q = produce(p, (d) => {
      mod(d, 'Station').binaryId = bin(d, 'Onboard').id
      link(d, 'camera_to_planner').constraints.remote = { enabled: true }
    })
    expect(problems(q)).toEqual([
      "Link 'camera_to_planner' joins binaries Onboard and Ground: it needs a transport",
      "Link 'planner_to_station' joins binaries Ground and Onboard: it needs a transport"
    ])
  })

  it('warns about a remote link inside one binary', () => {
    const p = produce(load(), (d) => void (mod(d, 'Station').binaryId = bin(d, 'Onboard').id))
    expect(problems(p, 'warning')).toEqual([
      "Link 'planner_to_station' is remote but both ends run in binary Onboard"
    ])
  })

  it('makes links remote when assigning modules to another binary, and local again', () => {
    const p = load()
    const moved = produce(p, (d) => assignBinary(d, [mod(d, 'Planner').id], bin(d, 'Ground').id))
    expect(link(moved, 'camera_to_planner').constraints.remote).toEqual({ enabled: true })
    // Kept: it has a transport.
    expect(link(moved, 'planner_to_station').constraints.remote).toEqual({ enabled: true, transport: 'tcp' })
    const back = produce(moved, (d) => assignBinary(d, [mod(d, 'Planner').id], bin(d, 'Onboard').id))
    expect(link(back, 'camera_to_planner').constraints.remote).toEqual({ enabled: false })
    // Inner modules are not assigned.
    const inner = produce(p, (d) => assignBinary(d, [mod(d, 'Sensor').id], bin(d, 'Ground').id))
    expect(inner).toBe(p)
  })

  it('unassigns the modules of a removed binary', () => {
    const p = produce(load(), (d) => removeBinary(d, bin(d, 'Ground').id))
    expect(p.binaries.map((b) => b.name)).toEqual(['Onboard'])
    expect(mod(p, 'Station').binaryId).toBeUndefined()
    expect(problems(p)).toEqual(['Station: runs in no binary (the project has binaries)'])
  })

  it('keeps the binary of a module moved to the top level, drops it when nested', () => {
    const p = load()
    const up = produce(p, (d) => {
      const before = binarySnapshot(d)
      mod(d, 'Sensor').parentId = null
      mod(d, 'Station').parentId = mod(d, 'Planner').id
      settleBinaries(d, before)
    })
    expect(mod(up, 'Sensor').binaryId).toBe(bin(up, 'Onboard').id)
    expect(mod(up, 'Station').binaryId).toBeUndefined()
    expect(binaryOf(up, mod(up, 'Station').id)).toBe(bin(up, 'Onboard').id)
  })
})
