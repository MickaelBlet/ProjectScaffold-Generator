// Copy / paste of several entities at once: modules (with content, ports and the links between
// them), notes, types and interfaces. Clips are plain JSON so that they go through the system
// clipboard, between documents and browser tabs.
import { mapTypeRef } from './typeExpr'
import { binarySnapshot, settleBinaries } from './binaries'
import {
  absolutePosition,
  boundsOf,
  childModules,
  globalTypeNames,
  growAncestors,
  linkOrigin,
  newId,
  subtreeIds,
  uniqueName
} from './project'
import type {
  ConstDef,
  Field,
  Id,
  Interface,
  Link,
  Message,
  Module,
  Note,
  Project,
  TypeDef,
  TypeRef
} from './types'

const originOf = (p: Project, id: Id | null): { x: number; y: number } =>
  id ? absolutePosition(p, id) : { x: 0, y: 0 }
const add = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: a.x + b.x, y: a.y + b.y })

export const CLIP_FORMAT = 'project-scaffold/clip'

export interface Clip {
  format: typeof CLIP_FORMAT
  /** Copied modules, parents first. Copied roots have absolute layouts. */
  modules: Module[]
  /** Parent of each copied root in the source project. */
  rootParents: Record<Id, Id | null>
  /** Links between copied modules; their bend points are absolute. */
  links: Link[]
  notes: Note[]
  types: TypeDef[]
  interfaces: Interface[]
  /** Absent in clips of older versions. */
  consts?: ConstDef[]
  /** Names of the source project's types and interfaces, to rebind references elsewhere. */
  names: Record<Id, string>
}

/** Copy the entities with these ids; null when none can be copied. */
export function copyItems(p: Project, ids: Id[]): Clip | null {
  const selected = new Set(ids)
  const moduleIds = new Set<Id>()
  const roots = p.modules.filter((m) => {
    if (!selected.has(m.id)) return false
    // A module whose ancestor is copied comes with it.
    let parentId = m.parentId
    while (parentId) {
      if (selected.has(parentId)) return false
      parentId = p.modules.find((x) => x.id === parentId)?.parentId ?? null
    }
    return true
  })
  for (const r of roots) for (const id of subtreeIds(p, r.id)) moduleIds.add(id)
  const rootIds = new Set(roots.map((r) => r.id))
  const modules = p.modules
    .filter((m) => moduleIds.has(m.id))
    .map((m) =>
      rootIds.has(m.id)
        ? { ...m, parentId: null, layout: { ...m.layout, ...absolutePosition(p, m.id) } }
        : structuredClone(m)
    )
  const clip: Clip = {
    format: CLIP_FORMAT,
    modules,
    rootParents: Object.fromEntries(roots.map((r) => [r.id, r.parentId])),
    links: p.links
      .filter((l) => moduleIds.has(l.from.moduleId) && moduleIds.has(l.to.moduleId))
      .map((l) => {
        if (!l.route?.points.length) return l
        const origin = originOf(p, linkOrigin(p, l))
        return { ...l, route: { ...l.route, points: l.route.points.map((pt) => add(pt, origin)) } }
      }),
    notes: p.notes.filter((n) => selected.has(n.id)),
    types: p.types.filter((t) => selected.has(t.id)),
    interfaces: p.interfaces.filter((i) => selected.has(i.id)),
    consts: p.consts.filter((c) => selected.has(c.id)),
    names: Object.fromEntries([...p.types, ...p.interfaces].map((e) => [e.id, e.name]))
  }
  const empty =
    !clip.modules.length &&
    !clip.notes.length &&
    !clip.types.length &&
    !clip.interfaces.length &&
    !clip.consts?.length
  return empty ? null : structuredClone(clip)
}

/**
 * The whole content of `source`, to paste into `target`: its modules with their links, its notes
 * when asked, and the types, interfaces and constants `target` lacks (the others are matched by name).
 * Links to modules of other projects are left out.
 */
export function copyProject(source: Project, target: Project, withNotes: boolean): Clip | null {
  const have = new Set(globalTypeNames(target))
  return copyItems(source, [
    ...childModules(source, null).map((m) => m.id),
    ...(withNotes ? source.notes.map((n) => n.id) : []),
    ...[...source.types, ...source.interfaces, ...source.consts]
      .filter((e) => !have.has(e.name))
      .map((e) => e.id)
  ])
}

export function parseClip(text: string): Clip | null {
  try {
    const data = JSON.parse(text) as Clip
    return data?.format === CLIP_FORMAT && Array.isArray(data.modules) ? data : null
  } catch {
    return null
  }
}

export interface PasteOptions {
  /**
   * Parent of the pasted top modules: `'original'` keeps the source parent when it exists
   * here (duplicate, paste in the same document), else they go to the top level.
   */
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- documents the special value
  parent: 'original' | Id | null
  /** Absolute position of the pasted content's top-left corner; else shifted by `offset`. */
  at?: { x: number; y: number }
  offset?: number
}

/** Paste a clip into a project draft; returns the ids of the pasted top-level entities. */
export function pasteClip(d: Project, clip: Clip, options: PasteOptions): Id[] {
  const before = binarySnapshot(d)
  const pasted: Id[] = []
  const typeIds = new Map<Id, Id>()

  // Types and interfaces first: pasted modules and fields may reference them.
  for (const e of [...clip.types, ...clip.interfaces]) typeIds.set(e.id, newId())
  const rebind = (id: Id): Id => {
    const copied = typeIds.get(id)
    if (copied) return copied
    if ([...d.types, ...d.interfaces].some((e) => e.id === id)) return id
    const name = clip.names[id]
    return [...d.types, ...d.interfaces].find((e) => e.name === name)?.id ?? id
  }
  const ref = (t: TypeRef): TypeRef => mapTypeRef(t, (r) => ({ kind: 'ref', id: rebind(r.id) }))
  const field = <F extends Field>(f: F): F => ({ ...f, id: newId(), type: ref(f.type) })
  const message = <M extends Message>(m: M): M => ({
    ...m,
    id: newId(),
    params: m.params.map(field),
    returns: m.returns ? ref(m.returns) : null,
    ...(m.raises ? { raises: m.raises.map(rebind) } : {})
  })

  for (const t of clip.types) {
    const base = {
      id: typeIds.get(t.id)!,
      name: uniqueName(t.name, globalTypeNames(d)),
      description: t.description
    }
    if (t.kind === 'struct' || t.kind === 'exception')
      d.types.push({ ...base, kind: t.kind, fields: t.fields.map(field) })
    else if (t.kind === 'enum')
      d.types.push({
        ...base,
        kind: 'enum',
        underlying: t.underlying,
        values: t.values.map((v) => ({ ...v, id: newId() }))
      })
    else if (t.kind === 'bitmask')
      d.types.push({
        ...base,
        kind: 'bitmask',
        underlying: t.underlying,
        flags: t.flags.map((v) => ({ ...v, id: newId() }))
      })
    else if (t.kind === 'union')
      d.types.push({ ...base, kind: 'union', discriminator: ref(t.discriminator), cases: t.cases.map(field) })
    else if (t.kind === 'alias') d.types.push({ ...base, kind: 'alias', type: ref(t.type) })
    else d.types.push({ ...base, kind: 'primitive' })
    pasted.push(base.id)
  }
  for (const c of clip.consts ?? []) {
    const id = newId()
    d.consts.push({
      id,
      name: uniqueName(c.name, globalTypeNames(d)),
      description: c.description,
      type: ref(c.type),
      value: structuredClone(c.value)
    })
    pasted.push(id)
  }
  for (const i of clip.interfaces) {
    const id = typeIds.get(i.id)!
    d.interfaces.push({
      id,
      name: uniqueName(i.name, globalTypeNames(d)),
      description: i.description,
      messages: i.messages.map(message)
    })
    pasted.push(id)
  }

  // Placement: roots keep their relative arrangement.
  const roots = clip.modules.filter((m) => m.id in clip.rootParents)
  const box = boundsOf([...roots.map((m) => m.layout), ...clip.notes.map((n) => n.layout)])
  const offset = options.offset ?? 30
  const shift = options.at ? { x: options.at.x - box.x, y: options.at.y - box.y } : { x: offset, y: offset }

  const moduleIds = new Map<Id, Id>()
  const portIds = new Map<Id, Id>()
  for (const m of clip.modules) moduleIds.set(m.id, newId())
  for (const m of clip.modules) {
    const isRoot = m.id in clip.rootParents
    let parentId: Id | null
    if (!isRoot) parentId = moduleIds.get(m.parentId!)!
    else if (options.parent === 'original') {
      const original = clip.rootParents[m.id] ?? null
      parentId = original && d.modules.some((x) => x.id === original) ? original : null
    } else parentId = options.parent && d.modules.some((x) => x.id === options.parent) ? options.parent : null

    const layout = { ...m.layout }
    if (isRoot) {
      const origin = parentId ? absolutePosition(d, parentId) : { x: 0, y: 0 }
      layout.x = Math.round(m.layout.x + shift.x - origin.x)
      layout.y = Math.round(m.layout.y + shift.y - origin.y)
    }
    const id = moduleIds.get(m.id)!
    d.modules.push({
      ...structuredClone(m),
      id,
      parentId,
      // Copies are placed by the user: they start unlocked.
      locked: undefined,
      name: uniqueName(
        m.name,
        childModules(d, parentId).map((s) => s.name)
      ),
      layout,
      attributes: m.attributes.map(field),
      methods: m.methods.map(message),
      ports: m.ports.map((pt) => {
        const pid = newId()
        portIds.set(pt.id, pid)
        return { ...pt, id: pid, interfaceId: pt.interfaceId ? rebind(pt.interfaceId) : null }
      })
    })
    if (isRoot) {
      growAncestors(d, id)
      pasted.push(id)
    }
  }
  // Ports whose interface does not exist here become untyped.
  const ifaceIds = new Set(d.interfaces.map((i) => i.id))
  const newModules = new Set(moduleIds.values())
  // Bases follow copied modules, else stay when they exist here.
  const existing = new Set(d.modules.map((m) => m.id))
  for (const m of d.modules)
    if (newModules.has(m.id)) {
      for (const pt of m.ports) if (pt.interfaceId && !ifaceIds.has(pt.interfaceId)) pt.interfaceId = null
      if (m.bases) {
        m.bases = m.bases.flatMap((b) => {
          const id = moduleIds.get(b) ?? b
          return existing.has(id) ? [id] : []
        })
        if (!m.bases.length) delete m.bases
      }
    }

  for (const l of clip.links) {
    const link: Link = {
      ...structuredClone(l),
      id: newId(),
      name: uniqueName(
        l.name,
        d.links.map((x) => x.name)
      ),
      from: { moduleId: moduleIds.get(l.from.moduleId)!, portId: portIds.get(l.from.portId)! },
      to: { moduleId: moduleIds.get(l.to.moduleId)!, portId: portIds.get(l.to.portId)! }
    }
    // Bend points move with the pasted modules.
    if (link.route?.points.length) {
      const origin = originOf(d, linkOrigin(d, link))
      link.route.points = link.route.points.map((pt) => ({
        x: Math.round(pt.x + shift.x - origin.x),
        y: Math.round(pt.y + shift.y - origin.y)
      }))
    }
    d.links.push(link)
  }

  for (const n of clip.notes) {
    const id = newId()
    d.notes.push({
      ...structuredClone(n),
      id,
      locked: undefined,
      layout: { ...n.layout, x: Math.round(n.layout.x + shift.x), y: Math.round(n.layout.y + shift.y) }
    })
    pasted.push(id)
  }
  settleBinaries(d, before)
  return pasted
}
