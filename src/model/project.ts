// Pure helpers over the in-memory project.
import { isReservedTypeName, mapTypeRef, printTypeExpr, walkTypeRef } from './typeExpr'
import {
  GLOBAL_VIEW,
  type Orientation,
  type Id,
  type Dependency,
  type ImportedModule,
  type LinkConstraints,
  type Method,
  type Module,
  type Port,
  type PortRole,
  type Qualifier,
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
    binaries: [],
    types: [],
    interfaces: [],
    consts: [],
    modules: [],
    links: [],
    dependencies: [],
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

export const LAYOUT_PAD = 20

// Vertical orientation: a band of `in` ports above the header, a band of `out` ports at the bottom.
export const PORT_BAND = 24
/** Width taken by one port along a band. */
const PORT_COL = 90

/** Height of one line in a module's attribute or method compartment. */
export const ATTR_ROW = 18

type WithCompartments = { attributes?: readonly unknown[]; methods?: readonly unknown[] }
type WithPorts = { ports: { role: string }[] } & WithCompartments

/** Height of one compartment of `n` lines: none when empty. */
const compartmentHeight = (n = 0): number => (n ? n * ATTR_ROW + 8 : 0)

/** Height of a module's attribute and method compartments, below its header. */
export function compartmentsHeight(m: WithCompartments): number {
  return compartmentHeight(m.attributes?.length) + compartmentHeight(m.methods?.length)
}

/**
 * Top of the area holding a module's content (submodules): below the header, the top band and
 * the attributes and methods of `m`.
 */
export function contentTop(o: Orientation, m: WithCompartments = {}): number {
  return (o === 'vertical' ? PORT_BAND + MODULE_HEADER : MODULE_HEADER) + compartmentsHeight(m)
}

/** Space kept below a module's content. */
export function contentBottom(o: Orientation): number {
  return o === 'vertical' ? PORT_BAND + LAYOUT_PAD : LAYOUT_PAD
}

/** Smallest size showing a module's header, attributes, methods and ports. */
export function minSize(m: WithPorts, o: Orientation): { width: number; height: number } {
  const attrs = compartmentsHeight(m)
  if (o === 'horizontal') return { width: 140, height: leafHeight(portRows(m)) + attrs }
  const ins = m.ports.filter((p) => p.role === 'in').length
  return {
    width: Math.max(140, Math.max(ins, m.ports.length - ins) * PORT_COL + 20),
    height: 2 * PORT_BAND + MODULE_HEADER + 8 + attrs
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
    child.layout.y = Math.max(child.layout.y, contentTop(d.orientation, parent))
    parent.layout.width = Math.max(parent.layout.width, child.layout.x + child.layout.width + LAYOUT_PAD)
    parent.layout.height = Math.max(
      parent.layout.height,
      child.layout.y + child.layout.height + contentBottom(d.orientation)
    )
    child = parent
  }
}

const byIdCache = new WeakMap<readonly { id: Id }[], ReadonlyMap<Id, { id: Id }>>()
const parentsCache = new WeakMap<readonly Module[], ReadonlySet<Id>>()

/** `items` by id, built once per array: for arrays never changed in place (store states, not drafts). */
export function indexById<T extends { id: Id }>(items: readonly T[]): ReadonlyMap<Id, T> {
  let index = byIdCache.get(items)
  if (!index) byIdCache.set(items, (index = new Map(items.map((x) => [x.id, x]))))
  return index as ReadonlyMap<Id, T>
}

/** Ids of the modules holding others, built once per array (as `indexById`). */
export function parentIds(modules: readonly Module[]): ReadonlySet<Id> {
  let parents = parentsCache.get(modules)
  if (!parents) parentsCache.set(modules, (parents = new Set(modules.flatMap((m) => m.parentId ?? []))))
  return parents
}

export function childModules(p: Project, parentId: Id | null): Module[] {
  return p.modules.filter((m) => m.parentId === parentId)
}

/** Parent-relative top of the free space below a module's submodules (`exceptId` left out). */
export function belowContent(p: Project, parentId: Id, exceptId?: Id): number {
  return Math.max(
    contentTop(
      p.orientation,
      p.modules.find((m) => m.id === parentId)
    ) + LAYOUT_PAD,
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
  if (imported) return `${imported.dep.name}/${imported.module.path}`
  const parts: string[] = []
  let cur = p.modules.find((m) => m.id === id)
  while (cur) {
    parts.unshift(cur.name)
    const parentId: Id | null = cur.parentId
    cur = parentId ? p.modules.find((m) => m.id === parentId) : undefined
  }
  return parts.join('.')
}

const findImportedIn = (p: Pick<Project, 'dependencies'>, id: Id): ImportedModule | undefined =>
  findImported(p, id)?.module

/** `modulePath` of every module and imported module, computed at once. */
export function modulePaths(p: Pick<Project, 'modules' | 'dependencies'>): Map<Id, string> {
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
  for (const dep of p.dependencies) for (const m of dep.modules) paths.set(m.id, `${dep.name}/${m.path}`)
  return paths
}

/** Text of a link end, `Module.Path:port`, from `modulePaths`. */
export function endpointLabel(
  p: Pick<Project, 'modules' | 'dependencies'>,
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
  p: Pick<Project, 'modules' | 'dependencies' | 'interfaces'>,
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

// Imported modules: modules of dependencies placed on the canvas.

export const IMPORTED_PREFIX = 'imported:'

export const isImportedId = (id: Id): boolean => id.startsWith(IMPORTED_PREFIX)

export function findImported(
  p: Pick<Project, 'dependencies'>,
  id: Id
): { dep: Dependency; module: ImportedModule } | undefined {
  if (!isImportedId(id)) return undefined
  for (const dep of p.dependencies) {
    const module = dep.modules.find((m) => m.id === id)
    if (module) return { dep, module }
  }
  return undefined
}

export const allImported = (p: Project): ImportedModule[] => p.dependencies.flatMap((d) => d.modules)

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

/** Size of an imported module on the canvas: set by hand (at least its minimum), else from its ports. */
export function importedSize(m: ImportedModule, o: Orientation): { width: number; height: number } {
  if (!m.size) return defaultSize(m, o)
  const min = minSize(m, o)
  return { width: Math.max(min.width, m.size.width), height: Math.max(min.height, m.size.height) }
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

/** Set a qualifier of an attribute, method or parameter, or leave it out. */
export function setQualifier(e: { [K in Qualifier]?: boolean }, q: Qualifier, on: boolean): void {
  if (on) e[q] = true
  else delete e[q]
}

/** Set a qualifier of a method, keeping the others consistent: `pure` and `override` imply `virtual`, which excludes `static`. */
export function setMethodQualifier(m: Method, q: Qualifier, on: boolean): void {
  setQualifier(m, q, on)
  if (!on) {
    if (q === 'virtual') for (const k of ['pure', 'override'] as const) setQualifier(m, k, false)
    return
  }
  if (q === 'static') for (const k of ['virtual', 'pure', 'override'] as const) setQualifier(m, k, false)
  else if (q === 'pure' || q === 'override' || q === 'virtual') {
    m.virtual = true
    setQualifier(m, 'static', false)
  }
}

/** Bases of a module, direct and indirect, nearest first; a base met twice (or a cycle) is listed once. */
export function ancestorModules(p: Project, id: Id): Module[] {
  const seen = new Set<Id>([id])
  const out: Module[] = []
  let level = [id]
  while (level.length) {
    const next: Id[] = []
    for (const cur of level)
      for (const b of p.modules.find((m) => m.id === cur)?.bases ?? []) {
        const base = p.modules.find((m) => m.id === b)
        if (!base || seen.has(b)) continue
        seen.add(b)
        out.push(base)
        next.push(b)
      }
    level = next
  }
  return out
}

/** Whether making `baseId` a base of `id` keeps the inheritance acyclic. */
export function canDerive(p: Project, id: Id, baseId: Id): boolean {
  return baseId !== id && !ancestorModules(p, baseId).some((m) => m.id === id)
}

/** Parameters (direction, const, type), return type and const of a method, to compare overrides. */
export function methodSignature(m: Method): string {
  const type = (t: TypeRef): string => printTypeExpr(mapTypeRef(t, (r) => ({ kind: 'ref', name: r.id })))
  const params = m.params.map((prm) => `${prm.direction} ${prm.const ? 'const ' : ''}${type(prm.type)}`)
  return `(${params.join(', ')})${m.returns ? type(m.returns) : ''}${m.const ? ' const' : ''}`
}

/**
 * Pure methods a module inherits and does not implement: those of its bases not defined (by name)
 * in itself or in a base nearer to it on the way.
 */
export function unimplementedMethods(p: Project, id: Id): { base: Module; method: Method }[] {
  const byId = new Map(p.modules.map((m) => [m.id, m]))
  const out = new Map<string, { base: Module; method: Method }>()
  /** Walks the bases of `cur`; `defined` holds the names defined on the way from the module. */
  const walk = (cur: Module, defined: Set<string>, stack: Set<Id>): void => {
    for (const b of cur.bases ?? []) {
      const base = byId.get(b)
      if (!base || stack.has(b)) continue
      for (const x of base.methods)
        if (x.pure && !defined.has(x.name) && !out.has(x.name)) out.set(x.name, { base, method: x })
      const names = new Set([...defined, ...base.methods.filter((x) => !x.pure).map((x) => x.name)])
      walk(base, names, new Set([...stack, b]))
    }
  }
  const mod = byId.get(id)
  if (mod) walk(mod, new Set(mod.methods.map((x) => x.name)), new Set([id]))
  return [...out.values()]
}

export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken)
  if (!set.has(base)) return base
  for (let i = 2; ; i++) if (!set.has(`${base}${i}`)) return `${base}${i}`
}

/** Names that must be unique together: user types, interfaces and constants share one namespace. */
export function globalTypeNames(p: Project, exceptId?: Id): string[] {
  return [...p.types, ...p.interfaces, ...p.consts].filter((e) => e.id !== exceptId).map((e) => e.name)
}

export type NameTarget =
  | { kind: 'type' | 'interface' | 'const'; id?: Id }
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
    case 'const':
      if (isReservedTypeName(name)) return `'${name}' is a reserved type name`
      if (globalTypeNames(p, target.id).includes(name))
        return `A type, interface or constant named '${name}' already exists`
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

/** Check the name of a binary (`except`: its id when renamed). */
export function binaryError(p: Project, name: string, except?: Id): string | null {
  if (!IDENTIFIER_RE.test(name)) return 'Must be an identifier'
  if (p.binaries.some((b) => b.id !== except && b.name === name)) return 'Name already used'
  return null
}

export interface UsageOwner {
  kind: 'type' | 'interface' | 'const' | 'module'
  id: Id
}

/** Every type reference in the project, with a label of where it is used and the entity holding it. */
export function* allTypeRefs(
  p: Project
): Generator<{ ref: TypeRef; where: string; owner: UsageOwner; raised?: boolean }> {
  for (const t of p.types) {
    const owner = { kind: 'type', id: t.id } as const
    if (t.kind === 'struct' || t.kind === 'exception')
      for (const f of t.fields) yield { ref: f.type, where: `${t.name}.${f.name}`, owner }
    if (t.kind === 'alias') yield { ref: t.type, where: t.name, owner }
    if (t.kind === 'union') {
      yield { ref: t.discriminator, where: `${t.name} discriminator`, owner }
      for (const c of t.cases) yield { ref: c.type, where: `${t.name}.${c.name}`, owner }
    }
  }
  for (const c of p.consts) yield { ref: c.type, where: c.name, owner: { kind: 'const', id: c.id } }
  for (const i of p.interfaces) {
    const owner = { kind: 'interface', id: i.id } as const
    for (const m of i.messages) {
      for (const prm of m.params) yield { ref: prm.type, where: `${i.name}.${m.name}(${prm.name})`, owner }
      if (m.returns) yield { ref: m.returns, where: `${i.name}.${m.name} returns`, owner }
      for (const id of m.raises ?? [])
        yield { ref: { kind: 'ref', id }, where: `${i.name}.${m.name} raises`, owner, raised: true }
    }
  }
  for (const m of p.modules) {
    const owner = { kind: 'module', id: m.id } as const
    const path = modulePath(p, m.id)
    for (const a of m.attributes) yield { ref: a.type, where: `${path}.${a.name}`, owner }
    for (const x of m.methods) {
      for (const prm of x.params) yield { ref: prm.type, where: `${path}.${x.name}(${prm.name})`, owner }
      if (x.returns) yield { ref: x.returns, where: `${path}.${x.name} returns`, owner }
      for (const id of x.raises ?? [])
        yield { ref: { kind: 'ref', id }, where: `${path}.${x.name} raises`, owner, raised: true }
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

function globalView(): View {
  return { id: GLOBAL_VIEW, name: 'Project', rootModuleId: null, hidden: [] }
}

const ISOLATED = 'isolate:'
const NO_HIDDEN: Id[] = Object.freeze([]) as unknown as Id[]

/** Id of the temporary view showing a module with its content (not stored in the project). */
export function isolatedViewId(moduleId: Id): Id {
  return ISOLATED + moduleId
}

/** Module shown by a temporary view id, else null. */
export function isolatedModuleId(viewId: Id): Id | null {
  return viewId.startsWith(ISOLATED) ? viewId.slice(ISOLATED.length) : null
}

/** The view with this id (a temporary view resolved from its module); the global view for an unknown id. */
export function findView(p: Pick<Project, 'views' | 'modules'>, viewId: Id): View {
  const stored = p.views.find((v) => v.id === viewId)
  if (stored) return stored
  const moduleId = isolatedModuleId(viewId)
  const m = moduleId ? p.modules.find((m) => m.id === moduleId) : undefined
  if (m) return { id: viewId, name: m.name, rootModuleId: m.id, hidden: NO_HIDDEN, temporary: true }
  return globalView()
}

/** Whether the view can be shown: the global view, a stored view, or a temporary view of a module. */
export function viewExists(p: Pick<Project, 'views' | 'modules'>, viewId: Id): boolean {
  return viewId === GLOBAL_VIEW || findView(p, viewId).id === viewId
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
