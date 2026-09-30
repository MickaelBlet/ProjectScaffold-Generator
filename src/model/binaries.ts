// Binaries of a project: top-level modules run in one each, links between two of them are remote.
import type { Id, Link, Project } from './types'

/** Binary a module runs in: its own at the top level, else its top-level ancestor's. */
export function binaryOf(p: Pick<Project, 'modules'>, moduleId: Id): Id | null {
  let m = p.modules.find((x) => x.id === moduleId)
  const seen = new Set<Id>()
  while (m?.parentId && !seen.has(m.id)) {
    seen.add(m.id)
    const parentId: Id = m.parentId
    m = p.modules.find((x) => x.id === parentId)
  }
  return m?.binaryId ?? null
}

/** Binary of every module of the project. */
export function binariesOf(p: Pick<Project, 'modules'>): Map<Id, Id | null> {
  return new Map(p.modules.map((m) => [m.id, binaryOf(p, m.id)]))
}

/** Where the modules ran before a change: their binaries, and which were at the top level. */
export interface BinarySnapshot {
  of: Map<Id, Id | null>
  top: Set<Id>
}

export function binarySnapshot(p: Pick<Project, 'modules'>): BinarySnapshot {
  return { of: binariesOf(p), top: new Set(p.modules.filter((m) => !m.parentId).map((m) => m.id)) }
}

/** Whether a link joins modules of two different binaries. */
export function crosses(binaries: Map<Id, Id | null>, l: Pick<Link, 'from' | 'to'>): boolean {
  const a = binaries.get(l.from.moduleId)
  const b = binaries.get(l.to.moduleId)
  return !!a && !!b && a !== b
}

/**
 * After a change of binaries or of the module tree (`before`: taken until then):
 * only top-level modules name a binary, a module moved to the top level keeps running where it ran
 * (a new container, where all its content ran), links now crossing binaries become remote and links
 * no longer crossing, remote without transport, become local again.
 */
export function settleBinaries(d: Project, before: BinarySnapshot): void {
  const known = new Set(d.binaries.map((b) => b.id))
  for (const m of d.modules) {
    if (m.parentId || (m.binaryId && !known.has(m.binaryId))) delete m.binaryId
    if (m.parentId || m.binaryId || before.top.has(m.id)) continue
    const was = before.of.get(m.id) ?? unanimous(d, m.id, before.of)
    if (was && known.has(was)) m.binaryId = was
  }
  const after = binariesOf(d)
  for (const l of d.links) {
    const remote = l.constraints.remote
    if (crosses(after, l)) remote.enabled = true
    else if (crosses(before.of, l) && remote.enabled && !remote.transport) remote.enabled = false
  }
}

/** The binary all the modules inside `id` ran in, if one. */
function unanimous(d: Project, id: Id, before: Map<Id, Id | null>): Id | null {
  const inner = d.modules.filter((m) => m.parentId === id).map((m) => before.get(m.id) ?? null)
  return inner.length && inner.every((b) => b === inner[0]) ? inner[0]! : null
}

/** Move top-level modules into a binary (null: none), and settle the links. */
export function assignBinary(d: Project, moduleIds: Iterable<Id>, binaryId: Id | null): void {
  const before = binarySnapshot(d)
  for (const id of moduleIds) {
    const m = d.modules.find((x) => x.id === id)
    if (!m || m.parentId) continue
    if (binaryId) m.binaryId = binaryId
    else delete m.binaryId
  }
  settleBinaries(d, before)
}

/** Remove a binary: its modules run in none. */
export function removeBinary(d: Project, id: Id): void {
  const before = binarySnapshot(d)
  d.binaries = d.binaries.filter((b) => b.id !== id)
  for (const m of d.modules) if (m.binaryId === id) delete m.binaryId
  settleBinaries(d, before)
}
