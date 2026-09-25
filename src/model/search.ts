// Full-text search over the project: names, descriptions and metadata.
import { modulePath } from './project'
import type { ProblemTarget } from './validate'
import type { Project } from './types'

export interface SearchHit {
  target: ProblemTarget
  /** Entity the hit belongs to, e.g. `Core.Sensor` or `Pose.position`. */
  label: string
  /** Where the text matched: name, description, metadata key... */
  field: string
  text: string
}

export function searchProject(p: Project, query: string): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: SearchHit[] = []
  const check = (target: ProblemTarget, label: string, field: string, text: string | undefined): void => {
    if (text && text.toLowerCase().includes(q)) hits.push({ target, label, field, text })
  }
  const meta = (target: ProblemTarget, label: string, m: Record<string, string>): void => {
    for (const [k, v] of Object.entries(m)) {
      check(target, label, 'metadata key', k)
      check(target, label, `metadata ${k}`, v)
    }
  }
  check({ kind: 'project' }, 'Project', 'name', p.name)
  check({ kind: 'project' }, 'Project', 'description', p.description)
  meta({ kind: 'project' }, 'Project', p.metadata)
  for (const m of p.modules) {
    const target = { kind: 'module', id: m.id } as const
    const path = modulePath(p, m.id)
    check(target, path, 'module', m.name)
    check(target, path, 'description', m.description)
    meta(target, path, m.metadata)
    for (const pt of m.ports) {
      check(target, `${path}:${pt.name}`, `${pt.role} port`, pt.name)
      check(target, `${path}:${pt.name}`, 'port description', pt.description)
    }
  }
  for (const l of p.links) {
    const target = { kind: 'link', id: l.id } as const
    check(target, l.name, 'link', l.name)
    check(target, l.name, 'description', l.description)
    check(target, l.name, 'transport', l.constraints.remote.transport)
  }
  for (const t of p.types) {
    const target = { kind: 'type', id: t.id } as const
    check(target, t.name, t.kind, t.name)
    check(target, t.name, 'description', t.description)
    if (t.kind === 'struct')
      for (const f of t.fields) {
        check(target, `${t.name}.${f.name}`, 'field', f.name)
        check(target, `${t.name}.${f.name}`, 'field description', f.description)
      }
    if (t.kind === 'enum') for (const v of t.values) check(target, `${t.name}.${v.name}`, 'value', v.name)
  }
  for (const i of p.interfaces) {
    const target = { kind: 'interface', id: i.id } as const
    check(target, i.name, 'interface', i.name)
    check(target, i.name, 'description', i.description)
    for (const m of i.messages) {
      check(target, `${i.name}.${m.name}`, 'message', m.name)
      check(target, `${i.name}.${m.name}`, 'message description', m.description)
      for (const prm of m.params) check(target, `${i.name}.${m.name}(${prm.name})`, 'parameter', prm.name)
    }
  }
  return hits
}
