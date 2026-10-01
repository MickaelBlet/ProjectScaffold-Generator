// Dependencies: other project files this project uses. Their types, interfaces and constants are
// kept in the project's `types`, `interfaces` and `consts` with `dependency` set, as last read from the file, so that the
// file stays self-contained for generators. The dependencies they use are listed too (flattened,
// `indirect`), each with its file relative to this project. Some of their modules may be placed on
// the canvas, with a copy of their ports as last read, so that links reach them.
import { IDENTIFIER_RE, IMPORTED_PREFIX, modulePath, newId, typeUsageTargets, uniqueName } from './project'
import { pair } from './reuse'
import { normalizeFile, resolveRelative, sameFile, type Renames } from './sync'
import { mapTypeRef } from './typeExpr'
import type {
  ConstDef,
  Dependency,
  Id,
  ImportedModule,
  ImportedPort,
  Interface,
  Module,
  Project,
  TypeDef,
  TypeRef
} from './types'

type Entity = TypeDef | Interface | ConstDef
type Kind = 'types' | 'interfaces' | 'consts'
const KINDS = ['types', 'interfaces', 'consts'] as const

const entities = (p: Pick<Project, Kind>): Entity[] => [...p.types, ...p.interfaces, ...p.consts]
const isInterface = (e: Entity): e is Interface => 'messages' in e
const isConst = (e: Entity): e is ConstDef => 'value' in e
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** An identifier made from a project name, for a new dependency. */
export function dependencyName(name: string): string {
  const id = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (!id) return 'Other'
  return IDENTIFIER_RE.test(id) ? id : `_${id}`
}

/** Types, interfaces and constants of a dependency, or the project's own ones (`undefined`). */
export const dependencyEntities = (p: Pick<Project, Kind>, dependency: Id | undefined): Entity[] =>
  entities(p).filter((e) => e.dependency === dependency)

/** Dependency defining a type or interface; undefined for the project's own ones. */
export function dependencyOf(p: Project, id: Id): Dependency | undefined {
  const dependency = entities(p).find((e) => e.id === id)?.dependency
  return dependency ? p.dependencies.find((x) => x.id === dependency) : undefined
}

/** Dependency of a project read from `file` (relative to it). */
export const dependencyAt = (p: Project, file: string): Dependency | undefined =>
  p.dependencies.find((x) => normalizeFile(x.file) === normalizeFile(file))

/** Whether `p` depends on the project saved as `file` (file names compared, as for tabs). */
export const usesDependency = (p: Project, file: string): boolean =>
  p.dependencies.some((x) => sameFile(x.file, file))

function modulesByPath(p: Project): Map<string, Module> {
  return new Map(p.modules.map((m) => [modulePath(p, m.id), m]))
}

function portsOf(source: Project, m: Module, previous: ImportedPort[] = []): ImportedPort[] {
  return m.ports.map((pt) => {
    // Ports keep their id and name placement by name, so that links survive a refresh.
    const was = previous.find((x) => x.name === pt.name)
    return {
      id: was?.id ?? newId(),
      name: pt.name,
      role: pt.role,
      interface: source.interfaces.find((i) => i.id === pt.interfaceId)?.name ?? null,
      description: pt.description,
      ...(was?.label && { label: was.label })
    }
  })
}

/** Content of an entity without ids, references by name: equal for the same definition in two projects. */
function shaper(p: Project): (e: Entity) => string {
  const names = new Map(entities(p).map((e) => [e.id, e.name]))
  return (e) =>
    JSON.stringify(e, (key, value: unknown) => {
      if (key === 'id' || key === 'dependency') return undefined
      const ref = value as { kind?: unknown; id?: unknown } | null
      if (ref && typeof ref === 'object' && ref.kind === 'ref' && typeof ref.id === 'string')
        return { kind: 'ref', name: names.get(ref.id) ?? '' }
      return value
    })
}

function rebind(e: Entity, idOf: (id: Id) => Id): void {
  const ref = (t: TypeRef): TypeRef => mapTypeRef(t, (r) => ({ kind: 'ref', id: idOf(r.id) }))
  if (isInterface(e))
    for (const m of e.messages) {
      for (const prm of m.params) prm.type = ref(prm.type)
      if (m.returns) m.returns = ref(m.returns)
    }
  else if (isConst(e)) e.type = ref(e.type)
  else if (e.kind === 'struct') for (const f of e.fields) f.type = ref(f.type)
  else if (e.kind === 'union') {
    e.discriminator = ref(e.discriminator)
    for (const c of e.cases) c.type = ref(c.type)
  } else if (e.kind === 'alias') e.type = ref(e.type)
}

/** Whether something outside `inside` (ids) uses a type or interface (nothing refers to constants). */
function usedOutside(p: Project, e: Entity, inside: Set<Id>): boolean {
  if (isConst(e)) return false
  if (isInterface(e))
    return (
      p.modules.some((m) => m.ports.some((pt) => pt.interfaceId === e.id)) ||
      p.dependencies.some((x) => x.modules.some((m) => m.ports.some((pt) => pt.interface === e.name)))
    )
  return typeUsageTargets(p, e.id).some((u) => !inside.has(u.owner.id))
}

/**
 * Hand the entities of `dep` that another dependency defines the same way (its `shared`) over to
 * that one. Returns the entities left to `dep`.
 */
function handOver(d: Project, dep: Dependency, list: Entity[] = dependencyEntities(d, dep.id)): Entity[] {
  return list.filter((e) => {
    const other = d.dependencies.find((x) => x.id !== dep.id && x.shared.includes(e.name))
    if (!other) return true
    e.dependency = other.id
    other.shared = other.shared.filter((n) => n !== e.name)
    return false
  })
}

export interface DependencyResult {
  /** Entities not taken because this project or another dependency defines the name differently. */
  conflicts: string[]
  /** Entities no longer in their dependency but still used here: kept as own ones. */
  detached: string[]
  /** Renames detected and applied. */
  renamed: string[]
  /** Placed modules no longer found in their project (left as they are). */
  missing: string[]
}

const leaf = (path: string): string => path.split('.').pop()!
const signature = (ports: { name: string; role: string }[]): string =>
  ports
    .map((pt) => `${pt.role}:${pt.name}`)
    .sort()
    .join(',')

/** One change of dependencies: copies are bound by name once every entity is in place. */
class Sync {
  readonly result: DependencyResult = { conflicts: [], detached: [], renamed: [], missing: [] }
  /** Copied entities, with the names of the entities of the project they come from. */
  private readonly copied: { entity: Entity; names: Map<Id, string> }[] = []
  /** Entities left by their dependency, removed at the end unless still used. */
  private readonly removed: Entity[] = []
  /** Dependencies brought up to date: snapshots do not overwrite them. */
  readonly fresh = new Set<Id>()

  constructor(
    private readonly d: Project,
    /** This project's own file name, to refuse depending on itself. */
    private readonly self: string | null
  ) {}

  /** Dependency on `file`, added (indirect) when missing; undefined when it is this project. */
  dependencyFor(file: string, name: string): Dependency | undefined {
    if (this.self && normalizeFile(file) === normalizeFile(this.self)) {
      this.result.conflicts.push(`${file}: uses this project (cycle)`)
      return undefined
    }
    let dep = dependencyAt(this.d, file)
    if (!dep) {
      dep = {
        id: newId(),
        name: uniqueName(
          dependencyName(name),
          this.d.dependencies.map((x) => x.name)
        ),
        file,
        uses: [],
        indirect: true,
        shared: [],
        modules: []
      }
      this.d.dependencies.push(dep)
    }
    return dep
  }

  /** Make the entities of `dep` those of `source` owned by `owner` (its own ones when undefined). */
  entities(dep: Dependency, source: Project, owner: Id | undefined): void {
    const names = new Map(entities(source).map((e) => [e.id, e.name]))
    const sourceShape = shaper(source)
    const shared: string[] = []
    for (const kind of KINDS) {
      const here = shaper(this.d)
      const list = this.d[kind] as Entity[]
      const current = list.filter((e) => e.dependency === dep.id)
      const next = (source[kind] as Entity[]).filter((e) => e.dependency === owner)
      const was = pair(
        current,
        (e) => e.name,
        next.map((e) => e.name)
      )
      const kept = new Set<Entity>()
      for (const [i, e] of next.entries()) {
        const taken = entities(this.d).find((x) => x.name === e.name && x.dependency !== dep.id)
        const target = was[i]
        if (taken) {
          const alike =
            !target &&
            isInterface(taken) === isInterface(e) &&
            isConst(taken) === isConst(e) &&
            here(taken) === sourceShape(e)
          // An own entity with the same definition becomes the dependency's; one of another
          // dependency stays that one's, shared.
          if (alike && !taken.dependency) taken.dependency = dep.id
          else if (alike) shared.push(e.name)
          else this.result.conflicts.push(`${dep.name}: ${e.name} is already defined differently here`)
          continue
        }
        if (target) {
          kept.add(target)
          if (target.name !== e.name) this.result.renamed.push(`${target.name} → ${e.name}`)
          else if (here(target) === sourceShape(e)) continue
        }
        const copy = { ...structuredClone(e), id: target?.id ?? newId(), dependency: dep.id } as Entity
        const at = target ? list.indexOf(target) : -1
        if (at >= 0) list[at] = copy
        else list.push(copy)
        this.copied.push({ entity: copy, names })
      }
      this.removed.push(...current.filter((e) => !kept.has(e)))
    }
    if (!same(dep.shared, shared)) dep.shared = shared
  }

  /**
   * Bring the dependencies `source` uses (its file: `file`) here, and set `dep.uses`. Those not
   * brought up to date from their own file take the snapshot of `source`.
   */
  nested(dep: Dependency, source: Project, file: string): void {
    const targets = new Map<Id, Dependency>()
    for (const n of source.dependencies) {
      const target = this.dependencyFor(resolveRelative(file, n.file), n.name)
      if (target) targets.set(n.id, target)
    }
    const namesOf = (uses: string[]): string[] =>
      uses.flatMap((u) => {
        const used = source.dependencies.find((x) => x.name === u)
        const t = used && targets.get(used.id)
        return t ? [t.name] : []
      })
    for (const n of source.dependencies) {
      const target = targets.get(n.id)
      if (!target || this.fresh.has(target.id)) continue
      this.fresh.add(target.id)
      this.entities(target, source, n.id)
      const uses = namesOf(n.uses)
      if (!same(target.uses, uses)) target.uses = uses
    }
    const uses = source.dependencies
      .filter((n) => !n.indirect && targets.has(n.id))
      .map((n) => targets.get(n.id)!.name)
    if (!same(dep.uses, uses)) dep.uses = uses
  }

  /**
   * Dependency `n` of `source` (saved as `file`) here, from the snapshot `source` has of it, with
   * the dependencies it uses. One already here is kept as it is.
   */
  snapshot(source: Project, file: string, n: Dependency): Dependency | undefined {
    const known = dependencyAt(this.d, resolveRelative(file, n.file))
    if (known) return known
    const dep = this.dependencyFor(resolveRelative(file, n.file), n.name)
    if (!dep) return undefined
    this.fresh.add(dep.id)
    this.entities(dep, source, n.id)
    dep.uses = n.uses.flatMap((u) => {
      const used = source.dependencies.find((x) => x.name === u)
      const t = used && this.snapshot(source, file, used)
      return t ? [t.name] : []
    })
    return dep
  }

  /**
   * Read the ports of the modules of `dep` placed here again from its project. Ports are matched by
   * name: links to removed ports are dropped. A module not found by path (renamed or moved while
   * this project was closed) is the only one not yet placed with the same name, else with the
   * same ports.
   */
  modules(dep: Dependency, source: Project): void {
    if (!dep.modules.length) return
    const byPath = modulesByPath(source)
    const taken = new Set(dep.modules.map((m) => m.path))
    const find = (path: string, ports: ImportedPort[]): string | null => {
      const free = [...byPath].filter(([p]) => !taken.has(p))
      const moved = free.filter(([p]) => leaf(p) === leaf(path))
      if (moved.length === 1) return moved[0]![0]
      const alike = ports.length ? free.filter(([, m]) => signature(m.ports) === signature(ports)) : []
      return alike.length === 1 ? alike[0]![0] : null
    }
    for (const im of dep.modules) {
      if (byPath.has(im.path)) continue
      const found = find(im.path, im.ports)
      if (!found) {
        this.result.missing.push(`${dep.name}: module '${im.path}' no longer exists in ${dep.file}`)
        continue
      }
      this.result.renamed.push(`module ${im.path} → ${found}`)
      taken.add(found)
      im.path = found
    }
    for (const im of dep.modules) {
      const m = byPath.get(im.path)
      if (!m) continue
      const ports = portsOf(source, m, im.ports)
      if (!same(im.ports, ports)) im.ports = ports
    }
    const ports = new Set(dep.modules.flatMap((m) => m.ports.map((pt) => pt.id)))
    const ids = new Set(dep.modules.map((m) => m.id))
    const kept = this.d.links.filter(
      (l) =>
        (!ids.has(l.from.moduleId) || ports.has(l.from.portId)) &&
        (!ids.has(l.to.moduleId) || ports.has(l.to.portId))
    )
    if (kept.length !== this.d.links.length) this.d.links = kept
  }

  /** Bring `dep` up to date from its project `source`. */
  take(dep: Dependency, source: Project): void {
    this.fresh.add(dep.id)
    this.entities(dep, source, undefined)
    this.modules(dep, source)
  }

  finish(): DependencyResult {
    const d = this.d
    const ids = new Map(entities(d).map((e) => [e.name, e.id]))
    for (const { entity, names } of this.copied)
      rebind(entity, (id) => ids.get(names.get(id) ?? '') ?? newId())
    const gone = new Set<Entity>()
    for (const e of this.removed) {
      const dep = d.dependencies.find((x) => x.id === e.dependency)
      if (dep && !handOver(d, dep, [e]).length) continue
      const inside = new Set(dependencyEntities(d, e.dependency).map((x) => x.id))
      if (usedOutside(d, e, inside)) {
        delete e.dependency
        this.result.detached.push(e.name)
      } else gone.add(e)
    }
    if (gone.size) {
      d.types = d.types.filter((e) => !gone.has(e))
      d.interfaces = d.interfaces.filter((e) => !gone.has(e))
      d.consts = d.consts.filter((e) => !gone.has(e))
    }
    prune(d)
    return this.result
  }
}

/** Whether this project uses a dependency itself: its types or interfaces, or its placed modules. */
function usedHere(d: Project, dep: Dependency): boolean {
  if (dep.modules.length) return true
  const own = dependencyEntities(d, dep.id)
  const inside = new Set(own.map((e) => e.id))
  return own.some((e) => usedOutside(d, e, inside))
}

/**
 * Dependencies used by no other one: indirect ones this project uses become direct, the others go
 * away with their entities.
 */
function prune(d: Project): void {
  for (;;) {
    const unused = d.dependencies.find(
      (x) => x.indirect && !d.dependencies.some((o) => o.uses.includes(x.name))
    )
    if (!unused) return
    if (usedHere(d, unused)) unused.indirect = false
    else removeWithEntities(d, unused)
  }
}

function removeWithEntities(d: Project, dep: Dependency): void {
  const left = new Set(handOver(d, dep))
  d.dependencies = d.dependencies.filter((x) => x.id !== dep.id)
  d.types = d.types.filter((e) => !left.has(e))
  d.interfaces = d.interfaces.filter((e) => !left.has(e))
  d.consts = d.consts.filter((e) => !left.has(e))
}

/**
 * Depend on `source` (saved as `file`, relative to this project): its own types and interfaces,
 * and those of the dependencies it uses. `self`: this project's file name, if saved. Adding a
 * dependency already there refreshes it.
 */
export function addDependency(
  d: Project,
  source: Project,
  file: string,
  self: string | null
): DependencyResult {
  const sync = new Sync(d, self)
  const dep = sync.dependencyFor(file, source.name)
  if (!dep) return sync.result
  dep.indirect = false
  sync.take(dep, source)
  sync.nested(dep, source, dep.file)
  return sync.finish()
}

/**
 * Depend here on the dependency `dependencyId` of `source` (saved as `file`), as `source` last read
 * it: for content copied from `source` that uses its types and interfaces.
 */
export function addDependencyOf(
  d: Project,
  source: Project,
  file: string,
  dependencyId: Id
): DependencyResult {
  const sync = new Sync(d, null)
  const n = source.dependencies.find((x) => x.id === dependencyId)
  const dep = n && sync.snapshot(source, file, n)
  if (dep) dep.indirect = false
  return sync.finish()
}

/**
 * Place a module of `source` (saved as `file`) on the canvas of `d`, at an absolute position,
 * depending on `source` (refreshed when already there). Returns the placed module id (the one
 * already there for that module), or null when the module does not exist in `source` or `source`
 * is this project.
 */
export function placeModule(
  d: Project,
  source: Project,
  file: string,
  moduleId: Id,
  position: { x: number; y: number },
  self: string | null
): { id: Id | null; result: DependencyResult } {
  const m = source.modules.find((x) => x.id === moduleId)
  if (!m) return { id: null, result: { conflicts: [], detached: [], renamed: [], missing: [] } }
  const result = addDependency(d, source, file, self)
  const dep = dependencyAt(d, file)
  if (!dep) return { id: null, result }
  const path = modulePath(source, moduleId)
  const existing = dep.modules.find((x) => x.path === path)
  if (existing) return { id: existing.id, result }
  const id = `${IMPORTED_PREFIX}${newId()}`
  const placed: ImportedModule = {
    id,
    path,
    ports: portsOf(source, m),
    position: { x: Math.round(position.x), y: Math.round(position.y) }
  }
  dep.modules.push(placed)
  return { id, result }
}

/** Read dependencies again from their projects (by dependency id). */
export function refreshDependencies(
  d: Project,
  sources: Map<Id, Project>,
  self: string | null
): DependencyResult {
  const sync = new Sync(d, self)
  const deps = d.dependencies.filter((x) => sources.has(x.id))
  for (const x of deps) sync.take(x, sources.get(x.id)!)
  for (const x of deps) sync.nested(x, sources.get(x.id)!, x.file)
  return sync.finish()
}

/** Remove placed modules and their links; their dependencies stay. */
export function removePlaced(d: Project, ids: Set<Id>): void {
  for (const x of d.dependencies)
    if (x.modules.some((m) => ids.has(m.id))) x.modules = x.modules.filter((m) => !ids.has(m.id))
  d.links = d.links.filter((l) => !ids.has(l.from.moduleId) && !ids.has(l.to.moduleId))
}

/** What keeps a dependency: the dependencies using it and its modules placed here. */
function holders(d: Project, dep: Dependency): string[] {
  return [
    ...d.dependencies.filter((x) => x.uses.includes(dep.name)).map((x) => `dependency ${x.name}`),
    ...dep.modules.map((m) => `module ${m.path}, placed on the canvas`)
  ]
}

/**
 * Stop depending on a project. Returns why it cannot be removed (another dependency uses it, its
 * modules are placed here, or this project uses its types or interfaces): then nothing changes.
 */
export function removeDependency(d: Project, dependencyId: Id): string[] {
  const dep = d.dependencies.find((x) => x.id === dependencyId)
  if (!dep) return []
  const users = holders(d, dep)
  // Entities another dependency also defines stay, with that one.
  const own = dependencyEntities(d, dep.id).filter(
    (e) => !d.dependencies.some((x) => x.shared.includes(e.name))
  )
  const inside = new Set(dependencyEntities(d, dep.id).map((e) => e.id))
  users.push(...own.filter((e) => usedOutside(d, e, inside)).map((e) => e.name))
  if (users.length) return users
  removeWithEntities(d, dep)
  prune(d)
  return []
}

/**
 * Make the types and interfaces of a dependency this project's own, and stop depending on it.
 * Returns what keeps it (dependencies using it, modules placed here): then nothing changes.
 */
export function detachDependency(d: Project, dependencyId: Id): string[] {
  const dep = d.dependencies.find((x) => x.id === dependencyId)
  if (!dep) return []
  const users = holders(d, dep)
  if (users.length) return users
  for (const e of handOver(d, dep)) delete e.dependency
  d.dependencies = d.dependencies.filter((x) => x.id !== dep.id)
  prune(d)
  return []
}

/**
 * Carry the renames made in the project saved as `file` to a project draft depending on it: paths
 * and port names of its placed modules, names of its types, interfaces and constants, and the interfaces of
 * placed ports.
 */
export function applyDependencyRenames(d: Project, file: string, r: Renames): void {
  for (const dep of d.dependencies) {
    if (!sameFile(dep.file, file)) continue
    for (const m of dep.modules) {
      const path = r.modules.get(m.path)
      if (path) m.path = path
      const names = r.ports.get(m.path)
      if (names)
        for (const pt of m.ports) {
          const to = names.get(pt.name)
          if (to) pt.name = to
        }
    }
    const rename = (kind: Kind, renames: Map<string, string>): void => {
      for (const e of d[kind] as Entity[]) {
        const to = e.dependency === dep.id ? renames.get(e.name) : undefined
        if (to && !entities(d).some((x) => x.name === to)) e.name = to
      }
    }
    rename('types', r.types)
    rename('interfaces', r.interfaces)
    rename('consts', r.consts)
  }
  followPortInterfaces(d, r.interfaces)
}

/** Make placed ports follow interface renames: they reference interfaces by name. */
export function followPortInterfaces(d: Project, renames: Map<string, string>): void {
  if (!renames.size) return
  const names = new Set(d.interfaces.map((i) => i.name))
  for (const dep of d.dependencies)
    for (const m of dep.modules)
      for (const pt of m.ports) {
        const to = pt.interface && !names.has(pt.interface) ? renames.get(pt.interface) : undefined
        if (to) pt.interface = to
      }
}

/** In a project draft whose own interfaces were renamed (compared with `prev`), make its placed ports follow. */
export function followInterfaceRenames(prev: Project, d: Project): void {
  if (!d.dependencies.some((x) => x.modules.length)) return
  const renames = new Map<string, string>()
  for (const i of d.interfaces) {
    const was = prev.interfaces.find((x) => x.id === i.id)
    if (was && was.name !== i.name) renames.set(was.name, i.name)
  }
  followPortInterfaces(d, renames)
}
