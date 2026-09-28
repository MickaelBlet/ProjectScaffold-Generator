// Imports: modules of other projects placed on this project's canvas, so that links reach them.
// An imported module keeps a copy of its ports as last read from the other project.
import { copyItems, pasteClip } from './clipboard'
import { IDENTIFIER_RE, IMPORTED_PREFIX, modulePath, newId, uniqueName } from './project'
import { renameInterfaces } from './sync'
import { walkTypeRef } from './typeExpr'
import type { Id, Import, ImportedPort, Module, Project, TypeRef } from './types'

/** An identifier made from a project name, for a new import. */
export function importName(name: string): string {
  const id = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (!id) return 'Other'
  return IDENTIFIER_RE.test(id) ? id : `_${id}`
}

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

/**
 * Copy into `d` the interfaces of `source` used by these ports that `d` lacks (by name), with the
 * types they need that `d` lacks too. Existing ones are matched by name.
 */
function copyMissingInterfaces(d: Project, source: Project, ports: ImportedPort[]): void {
  const have = new Set([...d.types, ...d.interfaces].map((e) => e.name))
  const interfaces = source.interfaces.filter(
    (i) => !have.has(i.name) && ports.some((pt) => pt.interface === i.name)
  )
  if (!interfaces.length) return
  const types = new Map(source.types.map((t) => [t.id, t]))
  const needed = new Set<Id>()
  const visit = (id: Id): void => {
    const t = types.get(id)
    if (!t || needed.has(id) || have.has(t.name)) return
    needed.add(id)
    if (t.kind === 'struct') for (const f of t.fields) walk(f.type)
    if (t.kind === 'alias') walk(t.type)
  }
  const walk = (ref: TypeRef): void =>
    walkTypeRef(ref, (n) => {
      if (n.kind === 'ref') visit(n.id)
    })
  for (const i of interfaces)
    for (const m of i.messages) {
      for (const prm of m.params) walk(prm.type)
      if (m.returns) walk(m.returns)
    }
  const clip = copyItems(source, [...needed, ...interfaces.map((i) => i.id)])
  if (clip) pasteClip(d, clip, { parent: null })
}

/**
 * Place a module of `source` (saved as `file`) on the canvas of `d`, at an absolute position.
 * Reuses the import of that file, and the imported module when it is already there. Returns the
 * imported module id, or null when the module does not exist in `source`.
 */
export function importModule(
  d: Project,
  source: Project,
  file: string,
  moduleId: Id,
  position: { x: number; y: number }
): Id | null {
  const m = source.modules.find((x) => x.id === moduleId)
  if (!m) return null
  let imp: Import | undefined = d.imports.find((i) => i.file === file)
  if (!imp) {
    imp = {
      id: newId(),
      name: uniqueName(
        importName(source.name),
        d.imports.map((i) => i.name)
      ),
      file,
      modules: []
    }
    d.imports.push(imp)
  }
  const path = modulePath(source, moduleId)
  const existing = imp.modules.find((x) => x.path === path)
  if (existing) return existing.id
  const ports = portsOf(source, m)
  copyMissingInterfaces(d, source, ports)
  const id = `${IMPORTED_PREFIX}${newId()}`
  imp.modules.push({ id, path, ports, position: { x: Math.round(position.x), y: Math.round(position.y) } })
  return id
}

export interface RefreshResult {
  /** Paths of the imported modules no longer found (left as they are). */
  missing: string[]
  /** Renames detected and applied. */
  renamed: string[]
}

const leaf = (path: string): string => path.split('.').pop()!
const signature = (ports: { name: string; role: string }[]): string =>
  ports
    .map((pt) => `${pt.role}:${pt.name}`)
    .sort()
    .join(',')

/**
 * Read the ports of an import's modules again from its project. Ports are matched by name: links
 * to removed ports are dropped. Renames made in that project while this one was closed are
 * detected: a module not found by path is the only one not yet imported with the same name
 * (moved) or else with the same ports; an interface a port now uses under another name, when
 * this project has the old name only, is renamed here too.
 */
export function refreshImport(d: Project, importId: Id, source: Project): RefreshResult {
  const result: RefreshResult = { missing: [], renamed: [] }
  const imp = d.imports.find((i) => i.id === importId)
  if (!imp) return result
  const byPath = modulesByPath(source)
  const taken = new Set(imp.modules.map((m) => m.path))
  const find = (path: string, ports: ImportedPort[]): string | null => {
    const free = [...byPath].filter(([p]) => !taken.has(p))
    const moved = free.filter(([p]) => leaf(p) === leaf(path))
    if (moved.length === 1) return moved[0]![0]
    const same = ports.length ? free.filter(([, m]) => signature(m.ports) === signature(ports)) : []
    return same.length === 1 ? same[0]![0] : null
  }
  for (const im of imp.modules) {
    if (byPath.has(im.path)) continue
    const found = find(im.path, im.ports)
    if (!found) {
      result.missing.push(im.path)
      continue
    }
    result.renamed.push(`module ${im.path} → ${found}`)
    taken.add(found)
    im.path = found
  }
  const interfaces = new Map<string, string>()
  for (const im of imp.modules) {
    const m = byPath.get(im.path)
    if (!m) continue
    const ports = portsOf(source, m, im.ports)
    for (const pt of ports) {
      const was = im.ports.find((x) => x.id === pt.id)?.interface
      const has = (name: string): boolean => d.interfaces.some((i) => i.name === name)
      if (was && pt.interface && was !== pt.interface && has(was) && !has(pt.interface))
        interfaces.set(was, pt.interface)
    }
    im.ports = ports
  }
  result.renamed.push(...renameInterfaces(d, interfaces).map((r) => `interface ${r}`))
  for (const im of imp.modules) copyMissingInterfaces(d, source, im.ports)
  const ports = new Set(imp.modules.flatMap((m) => m.ports.map((pt) => pt.id)))
  const ids = new Set(imp.modules.map((m) => m.id))
  d.links = d.links.filter(
    (l) =>
      (!ids.has(l.from.moduleId) || ports.has(l.from.portId)) &&
      (!ids.has(l.to.moduleId) || ports.has(l.to.portId))
  )
  return result
}

/** Remove imported modules and their links; imports left without modules go away. */
export function removeImported(d: Project, ids: Set<Id>): void {
  for (const i of d.imports) i.modules = i.modules.filter((m) => !ids.has(m.id))
  d.imports = d.imports.filter((i) => i.modules.length)
  d.links = d.links.filter((l) => !ids.has(l.from.moduleId) && !ids.has(l.to.moduleId))
}
