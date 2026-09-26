// Keeping linked projects in sync: renames of modules, ports and interfaces made in one project are
// carried to the projects linked to it (see imports.ts). Interfaces are shared by name.
import type { Id, Project } from './types'

/** Renames between two states of a project (entities keep their id when renamed). */
export interface Renames {
  /** Old module path → new path. */
  modules: Map<string, string>
  /** New module path → old port name → new name. */
  ports: Map<string, Map<string, string>>
  /** Old interface name → new name. */
  interfaces: Map<string, string>
}

/** Last component of a file path: imports name files relative to the project, tabs by their name. */
export const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

export const sameFile = (a: string, b: string): boolean => baseName(a) === baseName(b)

/** Module paths by id, in one pass. */
function paths(p: Project): Map<Id, string> {
  const byId = new Map(p.modules.map((m) => [m.id, m]))
  const out = new Map<Id, string>()
  const path = (id: Id): string => {
    const known = out.get(id)
    if (known !== undefined) return known
    const m = byId.get(id)
    if (!m) return ''
    const parent = m.parentId ? path(m.parentId) : ''
    const result = parent ? `${parent}.${m.name}` : m.name
    out.set(id, result)
    return result
  }
  for (const m of p.modules) path(m.id)
  return out
}

/** Renames from `prev` to `next`; null when there are none. */
export function diffRenames(prev: Project, next: Project): Renames | null {
  if (prev.modules === next.modules && prev.interfaces === next.interfaces) return null
  const r: Renames = { modules: new Map(), ports: new Map(), interfaces: new Map() }
  if (prev.modules !== next.modules) {
    const before = paths(prev)
    const after = paths(next)
    const prevModules = new Map(prev.modules.map((m) => [m.id, m]))
    for (const m of next.modules) {
      const old = prevModules.get(m.id)
      if (!old) continue
      const from = before.get(m.id)!
      const to = after.get(m.id)!
      if (from !== to) r.modules.set(from, to)
      if (old.ports === m.ports) continue
      const names = new Map<string, string>()
      for (const pt of m.ports) {
        const was = old.ports.find((x) => x.id === pt.id)
        if (was && was.name !== pt.name) names.set(was.name, pt.name)
      }
      if (names.size) r.ports.set(to, names)
    }
  }
  if (prev.interfaces !== next.interfaces)
    for (const i of next.interfaces) {
      const was = prev.interfaces.find((x) => x.id === i.id)
      if (was && was.name !== i.name) r.interfaces.set(was.name, i.name)
    }
  return r.modules.size || r.ports.size || r.interfaces.size ? r : null
}

/**
 * Rename interfaces in a project draft: its own interface of each old name (unless the new name is
 * taken) and the interface of every imported port. Returns the renamed local interfaces.
 */
export function renameInterfaces(d: Project, renames: Map<string, string>): string[] {
  const done: string[] = []
  for (const [from, to] of renames) {
    const local = d.interfaces.find((i) => i.name === from)
    const taken = [...d.types, ...d.interfaces].some((e) => e.name === to)
    if (local && !taken) {
      local.name = to
      done.push(`${from} → ${to}`)
    }
    for (const imp of d.imports)
      for (const m of imp.modules) for (const pt of m.ports) if (pt.interface === from) pt.interface = to
  }
  return done
}

/**
 * Carry the renames made in the project saved as `file` to a project draft that imports it: paths
 * and port names of its imported modules, and the shared interfaces.
 */
export function applySourceRenames(d: Project, file: string, r: Renames): void {
  for (const imp of d.imports) {
    if (!sameFile(imp.file, file)) continue
    for (const m of imp.modules) {
      m.path = r.modules.get(m.path) ?? m.path
      const names = r.ports.get(m.path)
      if (names) for (const pt of m.ports) pt.name = names.get(pt.name) ?? pt.name
    }
  }
  renameInterfaces(d, r.interfaces)
}

/**
 * In a project draft whose own interfaces were renamed (compared with `prev`), make its imported
 * ports follow: they reference interfaces by name.
 */
export function followInterfaceRenames(prev: Project, d: Project): void {
  if (!d.imports.length) return
  const renames = new Map<string, string>()
  for (const i of d.interfaces) {
    const was = prev.interfaces.find((x) => x.id === i.id)
    if (was && was.name !== i.name) renames.set(was.name, i.name)
  }
  for (const [from, to] of renames)
    for (const imp of d.imports)
      for (const m of imp.modules) for (const pt of m.ports) if (pt.interface === from) pt.interface = to
}
