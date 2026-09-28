// Pure helpers over the in-memory project.
import { isReservedTypeName, walkTypeRef } from './typeExpr'
import {
  GLOBAL_VIEW,
  type Orientation,
  type Id,
  type Import,
  type ImportedModule,
  type LinkConstraints,
  type Module,
  type Port,
  type PortRole,
  type Project,
  type Rect,
  type TypeRef,
  type View,
  TRANSPORTS
} from './types'

export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function newId(): Id {
  return crypto.randomUUID()
}

export function emptyProject(): Project {
  return {
    name: 'Untitled',
    description: '',
    metadata: {},
    transports: [],
    types: [],
    interfaces: [],
    modules: [],
    links: [],
    imports: [],
    views: [],
    notes: [],
    orientation: 'horizontal'
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

export const LAYOUT_PAD = 20

// Vertical orientation: a band of `in` ports above the header, a band of `out` ports at the bottom.
export const PORT_BAND = 24
/** Width taken by one port along a band. */
export const PORT_COL = 90

type WithPorts = { ports: { role: string }[] }

/** Top of the area holding a module's content (submodules): below the header and the top band. */
export function contentTop(o: Orientation): number {
  return o === 'vertical' ? PORT_BAND + MODULE_HEADER : MODULE_HEADER
}

/** Space kept below a module's content. */
export function contentBottom(o: Orientation): number {
  return o === 'vertical' ? PORT_BAND + LAYOUT_PAD : LAYOUT_PAD
}

/** Smallest size showing a module's header and ports. */
export function minSize(m: WithPorts, o: Orientation): { width: number; height: number } {
  if (o === 'horizontal') return { width: 140, height: leafHeight(portRows(m)) }
  const ins = m.ports.filter((p) => p.role === 'in').length
  return {
    width: Math.max(140, Math.max(ins, m.ports.length - ins) * PORT_COL + 20),
    height: 2 * PORT_BAND + MODULE_HEADER + 8
  }
}

/** Size of a new or reset module (no content). */
export function defaultSize(m: WithPorts, o: Orientation): { width: number; height: number } {
  const min = minSize(m, o)
  return { width: Math.max(MODULE_WIDTH, min.width), height: min.height }
}

/** Keep `id` inside its parent's content area (below header and ports), growing ancestors as needed. */
export function growAncestors(d: Project, id: Id): void {
  let child = d.modules.find((m) => m.id === id)
  while (child?.parentId) {
    const parentId: Id = child.parentId
    const parent = d.modules.find((m) => m.id === parentId)
    if (!parent) return
    child.layout.x = Math.max(child.layout.x, LAYOUT_PAD / 2)
    child.layout.y = Math.max(child.layout.y, contentTop(d.orientation))
    parent.layout.width = Math.max(parent.layout.width, child.layout.x + child.layout.width + LAYOUT_PAD)
    parent.layout.height = Math.max(
      parent.layout.height,
      child.layout.y + child.layout.height + contentBottom(d.orientation)
    )
    child = parent
  }
}

export function childModules(p: Project, parentId: Id | null): Module[] {
  return p.modules.filter((m) => m.parentId === parentId)
}

/** Parent-relative top of the free space below a module's submodules (`exceptId` left out). */
export function belowContent(p: Project, parentId: Id, exceptId?: Id): number {
  return Math.max(
    contentTop(p.orientation) + LAYOUT_PAD,
    ...childModules(p, parentId)
      .filter((c) => c.id !== exceptId)
      .map((c) => c.layout.y + c.layout.height + LAYOUT_PAD)
  )
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
  const imported = findImported(p, id)
  if (imported) return `${imported.imp.name}/${imported.module.path}`
  const parts: string[] = []
  let cur = p.modules.find((m) => m.id === id)
  while (cur) {
    parts.unshift(cur.name)
    const parentId: Id | null = cur.parentId
    cur = parentId ? p.modules.find((m) => m.id === parentId) : undefined
  }
  return parts.join('.')
}

const findImportedIn = (p: Pick<Project, 'imports'>, id: Id): ImportedModule | undefined =>
  findImported(p, id)?.module

/** `modulePath` of every module and imported module, computed at once. */
export function modulePaths(p: Pick<Project, 'modules' | 'imports'>): Map<Id, string> {
  const byId = new Map(p.modules.map((m) => [m.id, m]))
  const paths = new Map<Id, string>()
  const path = (m: Module): string => {
    let known = paths.get(m.id)
    if (known === undefined) {
      const parent = m.parentId ? byId.get(m.parentId) : undefined
      known = parent ? `${path(parent)}.${m.name}` : m.name
      paths.set(m.id, known)
    }
    return known
  }
  for (const m of p.modules) path(m)
  for (const imp of p.imports) for (const m of imp.modules) paths.set(m.id, `${imp.name}/${m.path}`)
  return paths
}

/** Text of a link end, `Module.Path:port`, from `modulePaths`. */
export function endpointLabel(
  p: Pick<Project, 'modules' | 'imports'>,
  paths: Map<Id, string>,
  e: { moduleId: Id; portId: Id }
): string {
  const ports = p.modules.find((m) => m.id === e.moduleId)?.ports ?? findImportedIn(p, e.moduleId)?.ports
  return `${paths.get(e.moduleId) ?? ''}:${ports?.find((pt) => pt.id === e.portId)?.name ?? '?'}`
}

/** Absolute canvas position of a module (layouts are parent-relative). */
export function absolutePosition(p: Project, id: Id): { x: number; y: number } {
  const imported = findImported(p, id)
  if (imported) return { ...imported.module.position }
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

/**
 * Roles of the ports at both ends of a link from module `from` to module `to`: `out` → `in`
 * between modules side by side; through a container's port to its content, `in` → `in` into it
 * and `out` → `out` out of it (delegation).
 */
export function linkRoles(p: Project, from: Id, to: Id): [PortRole, PortRole] {
  if (subtreeIds(p, from).has(to)) return ['in', 'in']
  if (subtreeIds(p, to).has(from)) return ['out', 'out']
  return ['out', 'in']
}

/**
 * Two link ends in link order (from, to), matching the roles of their ports (null: a new port,
 * any role), or null when neither order fits.
 */
export function orderLinkEnds<T extends { moduleId: Id; role: PortRole | null }>(
  p: Project,
  a: T,
  b: T
): [T, T] | null {
  for (const [x, y] of [
    [a, b],
    [b, a]
  ] as const) {
    const [rx, ry] = linkRoles(p, x.moduleId, y.moduleId)
    if ((x.role ?? rx) === rx && (y.role ?? ry) === ry) return [x, y]
  }
  return null
}

/**
 * Innermost module holding both ends of a link (an end itself when the other is inside it), or
 * null at the top level: bend points are relative to it so that they follow it.
 */
export function linkOrigin(p: Project, l: { from: { moduleId: Id }; to: { moduleId: Id } }): Id | null {
  const chain = (id: Id): Id[] => {
    const ids: Id[] = []
    let m = p.modules.find((x) => x.id === id)
    while (m) {
      ids.push(m.id)
      const parentId: Id | null = m.parentId
      m = parentId ? p.modules.find((x) => x.id === parentId) : undefined
    }
    return ids
  }
  const theirs = new Set(chain(l.to.moduleId))
  return chain(l.from.moduleId).find((id) => theirs.has(id)) ?? null
}

/**
 * A port of a module or of an imported module. An imported port is a copy whose interface is this
 * project's interface of the same name (null when there is none): changing it has no effect.
 */
export function findPort(
  p: Pick<Project, 'modules' | 'imports' | 'interfaces'>,
  moduleId: Id,
  portId: Id
): Port | undefined {
  const port = p.modules.find((m) => m.id === moduleId)?.ports.find((pt) => pt.id === portId)
  if (port) return port
  const imported = findImported(p, moduleId)?.module.ports.find((pt) => pt.id === portId)
  if (!imported) return undefined
  const { interface: iface, ...rest } = imported
  return { ...rest, interfaceId: p.interfaces.find((i) => i.name === iface)?.id ?? null }
}

// Imports: modules of other projects placed on the canvas.

export const IMPORTED_PREFIX = 'imported:'

export const isImportedId = (id: Id): boolean => id.startsWith(IMPORTED_PREFIX)

export function findImported(
  p: Pick<Project, 'imports'>,
  id: Id
): { imp: Import; module: ImportedModule } | undefined {
  if (!isImportedId(id)) return undefined
  for (const imp of p.imports) {
    const module = imp.modules.find((m) => m.id === id)
    if (module) return { imp, module }
  }
  return undefined
}

export const allImported = (p: Project): ImportedModule[] => p.imports.flatMap((i) => i.modules)

/** Top-level modules, notes and imported modules lying fully inside a frame, at their saved size. */
export function frameContents(
  p: Project,
  frameId: Id
): { id: Id; kind: 'module' | 'note' | 'imported'; name: string }[] {
  const f = p.notes.find((n) => n.id === frameId)?.layout
  if (!f) return []
  const within = (r: Rect): boolean =>
    r.x >= f.x && r.y >= f.y && r.x + r.width <= f.x + f.width && r.y + r.height <= f.y + f.height
  return [
    ...p.modules
      .filter((m) => !m.parentId && within(m.layout))
      .map((m) => ({ id: m.id, kind: 'module' as const, name: m.name })),
    ...p.notes
      .filter((n) => n.id !== frameId && within(n.layout))
      .map((n) => ({ id: n.id, kind: 'note' as const, name: n.text.split('\n')[0] || `(${n.kind})` })),
    ...allImported(p)
      .filter((m) => within({ ...m.position, ...importedSize(m, p.orientation) }))
      .map((m) => ({ id: m.id, kind: 'imported' as const, name: m.path }))
  ]
}

/** Size of an imported module on the canvas: fixed, from its ports. */
export function importedSize(m: ImportedModule, o: Orientation): { width: number; height: number } {
  return defaultSize(m, o)
}

export const PALETTE = [
  '#e0513b',
  '#d98b00',
  '#d6c21f',
  '#2e9e5b',
  '#2e9e8f',
  '#3b8fd1',
  '#3b6fe0',
  '#8a4fd1',
  '#d14f9e',
  '#7a8496'
]

/** The least used palette hue (grey excluded), so each new module stands out from the others. */
export function nextModuleColor(p: Project): string {
  const hues = PALETTE.slice(0, -1)
  const count = new Map(hues.map((c) => [c, 0]))
  for (const m of p.modules) if (m.color && count.has(m.color)) count.set(m.color, count.get(m.color)! + 1)
  return hues.reduce((best, c) => (count.get(c)! < count.get(best)! ? c : best))
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

/** Check the name of a custom transport (`except`: its index when renamed). */
export function transportError(p: Project, name: string, except?: number): string | null {
  if (!name.trim()) return 'Must not be empty'
  if ((TRANSPORTS as readonly string[]).includes(name)) return 'Built-in transport'
  if (p.transports.some((t, i) => i !== except && t === name)) return 'Name already used'
  return null
}

export interface UsageOwner {
  kind: 'type' | 'interface'
  id: Id
}

/** Every type reference in the project, with a label of where it is used and the entity holding it. */
export function* allTypeRefs(p: Project): Generator<{ ref: TypeRef; where: string; owner: UsageOwner }> {
  for (const t of p.types) {
    const owner = { kind: 'type', id: t.id } as const
    if (t.kind === 'struct')
      for (const f of t.fields) yield { ref: f.type, where: `${t.name}.${f.name}`, owner }
    if (t.kind === 'alias') yield { ref: t.type, where: t.name, owner }
  }
  for (const i of p.interfaces) {
    const owner = { kind: 'interface', id: i.id } as const
    for (const m of i.messages) {
      for (const prm of m.params) yield { ref: prm.type, where: `${i.name}.${m.name}(${prm.name})`, owner }
      if (m.returns) yield { ref: m.returns, where: `${i.name}.${m.name} returns`, owner }
    }
  }
}

/** Places using a type, with the entity holding each reference. */
export function typeUsageTargets(p: Project, typeId: Id): { where: string; owner: UsageOwner }[] {
  const out: { where: string; owner: UsageOwner }[] = []
  for (const { ref, where, owner } of allTypeRefs(p)) {
    let used = false
    walkTypeRef(ref, (n) => {
      if (n.kind === 'ref' && n.id === typeId) used = true
    })
    if (used) out.push({ where, owner })
  }
  return out
}

export function typeUsages(p: Project, typeId: Id): string[] {
  return typeUsageTargets(p, typeId).map((u) => u.where)
}

// Views

export function globalView(): View {
  return { id: GLOBAL_VIEW, name: 'Global', rootModuleId: null, hidden: [] }
}

/** The view with this id; the global view for an unknown id. */
export function findView(p: Pick<Project, 'views'>, viewId: Id): View {
  return p.views.find((v) => v.id === viewId) ?? globalView()
}

/** Ids of the modules drawn in a view: the root's subtree (or everything) minus hidden subtrees. */
export function visibleModuleIds(p: Project, view: View): Set<Id> {
  // Imported modules are drawn in the global view only.
  const scope = view.rootModuleId
    ? subtreeIds(p, view.rootModuleId)
    : new Set([...p.modules, ...allImported(p)].map((m) => m.id))
  for (const h of view.hidden)
    if (h !== view.rootModuleId) for (const id of subtreeIds(p, h)) scope.delete(id)
  return scope
}

/** Drop view references to deleted modules; views rooted in a deleted module go away. */
export function pruneViews(p: Project): void {
  const ids = new Set(p.modules.map((m) => m.id))
  p.views = p.views.filter((v) => !v.rootModuleId || ids.has(v.rootModuleId))
  for (const v of p.views) v.hidden = v.hidden.filter((h) => ids.has(h))
}

/** Bounding box of rects. */
export function boundsOf(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 }
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  return { x, y, width: right - x, height: bottom - y }
}

/** Absolute rect of a module. */
export function absoluteRect(p: Project, id: Id): Rect {
  const imported = findImported(p, id)
  if (imported) return { ...imported.module.position, ...importedSize(imported.module, p.orientation) }
  const m = p.modules.find((m) => m.id === id)
  const { x, y } = absolutePosition(p, id)
  return { x, y, width: m?.layout.width ?? 0, height: m?.layout.height ?? 0 }
}

/** Depth of a module in the tree (0 for top level). */
export function moduleDepth(p: Project, id: Id): number {
  let d = 0
  let cur = p.modules.find((m) => m.id === id)
  while (cur?.parentId) {
    d++
    const parentId: Id = cur.parentId
    cur = p.modules.find((m) => m.id === parentId)
  }
  return d
}
