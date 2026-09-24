// Pure helpers over the in-memory project.
import { isReservedTypeName, walkTypeRef } from './typeExpr'
import type { Id, LinkConstraints, Module, Port, Project, Rect, TypeRef } from './types'

export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function newId(): Id {
  return crypto.randomUUID()
}

export function emptyProject(): Project {
  return {
    name: 'Untitled',
    description: '',
    metadata: {},
    types: [],
    interfaces: [],
    modules: [],
    links: []
  }
}

export function defaultConstraints(): LinkConstraints {
  return {
    direction: 'unidirectional',
    ack: { required: false },
    performance: { class: 'normal' },
    remote: { enabled: false }
  }
}

export const MODULE_WIDTH = 200
export const MODULE_HEADER = 36
export const PORT_ROW = 24

/** Port rows of a module node: `in` ports on the left, `out` ports on the right. */
export function portRows(m: { ports: { role: string }[] }): number {
  const ins = m.ports.filter((p) => p.role === 'in').length
  return Math.max(ins, m.ports.length - ins)
}

export function leafHeight(portCount: number): number {
  return MODULE_HEADER + Math.max(1, portCount) * PORT_ROW + 12
}

export function defaultLayout(x: number, y: number, portCount = 0): Rect {
  return { x, y, width: MODULE_WIDTH, height: leafHeight(portCount) }
}

export function childModules(p: Project, parentId: Id | null): Module[] {
  return p.modules.filter((m) => m.parentId === parentId)
}

/** Ids of `id` and all its descendants. */
export function subtreeIds(p: Project, id: Id): Set<Id> {
  const ids = new Set<Id>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const m of p.modules) {
      if (m.parentId && ids.has(m.parentId) && !ids.has(m.id)) {
        ids.add(m.id)
        grew = true
      }
    }
  }
  return ids
}

export function modulePath(p: Project, id: Id): string {
  const parts: string[] = []
  let cur = p.modules.find((m) => m.id === id)
  while (cur) {
    parts.unshift(cur.name)
    const parentId: Id | null = cur.parentId
    cur = parentId ? p.modules.find((m) => m.id === parentId) : undefined
  }
  return parts.join('.')
}

/** Absolute canvas position of a module (layouts are parent-relative). */
export function absolutePosition(p: Project, id: Id): { x: number; y: number } {
  let x = 0
  let y = 0
  let cur = p.modules.find((m) => m.id === id)
  while (cur) {
    x += cur.layout.x
    y += cur.layout.y
    const parentId: Id | null = cur.parentId
    cur = parentId ? p.modules.find((m) => m.id === parentId) : undefined
  }
  return { x, y }
}

export function findPort(p: Project, moduleId: Id, portId: Id): Port | undefined {
  return p.modules.find((m) => m.id === moduleId)?.ports.find((pt) => pt.id === portId)
}

export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken)
  if (!set.has(base)) return base
  for (let i = 2; ; i++) if (!set.has(`${base}${i}`)) return `${base}${i}`
}

/** Names that must be unique together: user types and interfaces share one namespace. */
export function globalTypeNames(p: Project, exceptId?: Id): string[] {
  return [...p.types, ...p.interfaces].filter((e) => e.id !== exceptId).map((e) => e.name)
}

export type NameTarget =
  | { kind: 'type' | 'interface'; id?: Id }
  | { kind: 'module'; id?: Id; parentId: Id | null }
  | { kind: 'port'; id?: Id; moduleId: Id }
  | { kind: 'other' }

/**
 * Check a name for an entity. Names referenced from other entities in the file
 * (types, interfaces, modules, ports) must be unique in their scope, so that
 * the file can always be reloaded.
 */
export function nameError(p: Project, target: NameTarget, name: string): string | null {
  if (!IDENTIFIER_RE.test(name))
    return 'Must be an identifier: letters, digits, _ (not starting with a digit)'
  switch (target.kind) {
    case 'type':
    case 'interface':
      if (isReservedTypeName(name)) return `'${name}' is a reserved type name`
      if (globalTypeNames(p, target.id).includes(name))
        return `A type or interface named '${name}' already exists`
      return null
    case 'module':
      if (childModules(p, target.parentId).some((m) => m.id !== target.id && m.name === name))
        return `A sibling module named '${name}' already exists`
      return null
    case 'port': {
      const mod = p.modules.find((m) => m.id === target.moduleId)
      if (mod?.ports.some((pt) => pt.id !== target.id && pt.name === name))
        return `This module already has a port named '${name}'`
      return null
    }
    default:
      return null
  }
}

/** Every type reference in the project, with a label of where it is used. */
export function* allTypeRefs(p: Project): Generator<{ ref: TypeRef; where: string }> {
  for (const t of p.types) {
    if (t.kind === 'struct') for (const f of t.fields) yield { ref: f.type, where: `${t.name}.${f.name}` }
    if (t.kind === 'alias') yield { ref: t.type, where: t.name }
  }
  for (const i of p.interfaces)
    for (const m of i.messages) {
      for (const prm of m.params) yield { ref: prm.type, where: `${i.name}.${m.name}(${prm.name})` }
      if (m.returns) yield { ref: m.returns, where: `${i.name}.${m.name} returns` }
    }
}

export function typeUsages(p: Project, typeId: Id): string[] {
  const out: string[] = []
  for (const { ref, where } of allTypeRefs(p)) {
    let used = false
    walkTypeRef(ref, (n) => {
      if (n.kind === 'ref' && n.id === typeId) used = true
    })
    if (used) out.push(where)
  }
  return out
}
