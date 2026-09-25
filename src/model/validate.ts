// Semantic checks. Errors block export; warnings do not.
import { findPort, modulePath } from './project'
import { isReservedTypeName, walkTypeRef } from './typeExpr'
import { INT_RANGES, type Id, type Project, type TypeDef, type TypeRef } from './types'

export type Severity = 'error' | 'warning'
export type ProblemTarget =
  | { kind: 'project' }
  | { kind: 'type'; id: Id }
  | { kind: 'interface'; id: Id }
  | { kind: 'module'; id: Id }
  | { kind: 'link'; id: Id }

export interface Problem {
  severity: Severity
  message: string
  target: ProblemTarget
}

function duplicates(names: string[]): string[] {
  const seen = new Set<string>()
  const dups = new Set<string>()
  for (const n of names) (seen.has(n) ? dups : seen).add(n)
  return [...dups]
}

export function validate(p: Project): Problem[] {
  const problems: Problem[] = []
  const push = (severity: Severity, target: ProblemTarget, message: string): void => {
    problems.push({ severity, target, message })
  }
  const types = new Map(p.types.map((t) => [t.id, t]))
  const interfaces = new Map(p.interfaces.map((i) => [i.id, i]))

  /** Follow aliases to the underlying type; null for dangling or cyclic aliases. */
  const resolve = (t: TypeRef, seen = new Set<Id>()): TypeRef | TypeDef | null => {
    if (t.kind !== 'ref') return t
    const def = types.get(t.id)
    if (!def || seen.has(t.id)) return null
    if (def.kind !== 'alias') return def
    seen.add(t.id)
    return resolve(def.type, seen)
  }

  const checkTypeRef = (t: TypeRef, target: ProblemTarget, where: string): void => {
    walkTypeRef(t, (n) => {
      if (n.kind === 'ref' && !types.has(n.id)) push('error', target, `${where}: references a deleted type`)
      const keyOf = n.kind === 'map' ? n.key : n.kind === 'set' ? n.of : null
      if (!keyOf) return
      const k = resolve(keyOf)
      if (!k) return
      const ok = ('kind' in k && k.kind === 'primitive') || ('kind' in k && k.kind === 'enum')
      if (!ok) push('error', target, `${where}: ${n.kind} key must be a primitive or an enum`)
      else if (k.kind === 'primitive' && (k.name === 'float32' || k.name === 'float64'))
        push('warning', target, `${where}: floating-point ${n.kind} key`)
    })
  }

  // Project
  if (!p.name.trim()) push('warning', { kind: 'project' }, 'Project has no name')

  // Types & interfaces namespace
  for (const n of duplicates([...p.types, ...p.interfaces].map((e) => e.name)))
    push('error', { kind: 'project' }, `Duplicate type/interface name '${n}'`)

  for (const t of p.types) {
    const target = { kind: 'type', id: t.id } as const
    if (isReservedTypeName(t.name)) push('error', target, `'${t.name}' is a reserved type name`)
    switch (t.kind) {
      case 'struct':
        if (!t.fields.length) push('warning', target, `Struct '${t.name}' has no fields`)
        for (const n of duplicates(t.fields.map((f) => f.name)))
          push('error', target, `Struct '${t.name}': duplicate field '${n}'`)
        for (const f of t.fields) checkTypeRef(f.type, target, `${t.name}.${f.name}`)
        break
      case 'enum': {
        if (!t.values.length) push('warning', target, `Enum '${t.name}' has no values`)
        for (const n of duplicates(t.values.map((v) => v.name)))
          push('error', target, `Enum '${t.name}': duplicate value name '${n}'`)
        for (const n of duplicates(t.values.map((v) => String(v.value))))
          push('warning', target, `Enum '${t.name}': value ${n} used more than once`)
        const [min, max] = INT_RANGES[t.underlying]
        for (const v of t.values)
          if (BigInt(v.value) < min || BigInt(v.value) > max)
            push('error', target, `Enum '${t.name}': ${v.name} = ${v.value} does not fit in ${t.underlying}`)
        break
      }
      case 'alias':
        checkTypeRef(t.type, target, t.name)
        if (t.type.kind === 'ref' && types.has(t.type.id) && resolve(t.type, new Set([t.id])) === null)
          push('error', target, `Alias '${t.name}' is cyclic`)
        break
    }
  }

  // Structs containing themselves by value (through fields, arrays, optionals and aliases).
  const byValue = (t: TypeRef, out: Set<Id>, seenAlias = new Set<Id>()): void => {
    switch (t.kind) {
      case 'array':
      case 'optional':
        byValue(t.of, out, seenAlias)
        break
      case 'ref': {
        const def = types.get(t.id)
        if (def?.kind === 'struct') out.add(def.id)
        else if (def?.kind === 'alias' && !seenAlias.has(def.id)) {
          seenAlias.add(def.id)
          byValue(def.type, out, seenAlias)
        }
        break
      }
    }
  }
  const edges = new Map<Id, Set<Id>>()
  for (const t of p.types) {
    if (t.kind !== 'struct') continue
    const out = new Set<Id>()
    for (const f of t.fields) byValue(f.type, out)
    edges.set(t.id, out)
  }
  const state = new Map<Id, 'visiting' | 'done'>()
  const cyclic = new Set<Id>()
  const visit = (id: Id, stack: Id[]): void => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') {
      for (const s of stack.slice(stack.indexOf(id))) cyclic.add(s)
      return
    }
    state.set(id, 'visiting')
    for (const next of edges.get(id) ?? []) visit(next, [...stack, id])
    state.set(id, 'done')
  }
  for (const id of edges.keys()) visit(id, [])
  for (const id of cyclic)
    push(
      'error',
      { kind: 'type', id },
      `Struct '${types.get(id)!.name}' contains itself by value (use vector, list, map or set to break the cycle)`
    )

  // Interfaces
  for (const i of p.interfaces) {
    const target = { kind: 'interface', id: i.id } as const
    if (isReservedTypeName(i.name)) push('error', target, `'${i.name}' is a reserved type name`)
    if (!i.messages.length) push('warning', target, `Interface '${i.name}' has no messages`)
    for (const n of duplicates(i.messages.map((m) => m.name)))
      push('error', target, `Interface '${i.name}': duplicate message '${n}'`)
    for (const m of i.messages) {
      for (const n of duplicates(m.params.map((prm) => prm.name)))
        push('error', target, `${i.name}.${m.name}: duplicate parameter '${n}'`)
      for (const prm of m.params) checkTypeRef(prm.type, target, `${i.name}.${m.name}(${prm.name})`)
      if (m.returns) checkTypeRef(m.returns, target, `${i.name}.${m.name} returns`)
    }
  }

  // Modules
  const siblings = new Map<Id | null, string[]>()
  for (const m of p.modules) siblings.set(m.parentId, [...(siblings.get(m.parentId) ?? []), m.name])
  for (const [parentId, names] of siblings)
    for (const n of duplicates(names))
      push(
        'error',
        parentId ? { kind: 'module', id: parentId } : { kind: 'project' },
        `Duplicate module name '${n}'`
      )
  for (const m of p.modules) {
    const target = { kind: 'module', id: m.id } as const
    const path = modulePath(p, m.id)
    for (const n of duplicates(m.ports.map((pt) => pt.name)))
      push('error', target, `${path}: duplicate port '${n}'`)
    for (const pt of m.ports) {
      if (!pt.interfaceId) push('warning', target, `${path}:${pt.name} has no interface`)
      else if (!interfaces.has(pt.interfaceId))
        push('error', target, `${path}:${pt.name} references a deleted interface`)
    }
  }

  // Links
  for (const n of duplicates(p.links.map((l) => l.name)))
    push('error', { kind: 'project' }, `Duplicate link name '${n}'`)
  const endpoints = new Set<string>()
  for (const l of p.links) {
    const target = { kind: 'link', id: l.id } as const
    const from = findPort(p, l.from.moduleId, l.from.portId)
    const to = findPort(p, l.to.moduleId, l.to.portId)
    if (!from || !to) {
      push('error', target, `Link '${l.name}' has a missing endpoint`)
      continue
    }
    const key = `${l.from.portId}->${l.to.portId}`
    if (endpoints.has(key)) push('warning', target, `Link '${l.name}' duplicates another link`)
    endpoints.add(key)
    if (from.role !== 'out')
      push('error', target, `Link '${l.name}': source port '${from.name}' must be an 'out' port`)
    if (to.role !== 'in')
      push('error', target, `Link '${l.name}': target port '${to.name}' must be an 'in' port`)
    if (from.interfaceId !== to.interfaceId)
      push('error', target, `Link '${l.name}': ports use different interfaces`)
    const c = l.constraints
    const iface = from.interfaceId ? interfaces.get(from.interfaceId) : undefined
    if (iface && c.direction === 'unidirectional')
      for (const m of iface.messages)
        if (m.returns)
          push(
            'error',
            target,
            `Link '${l.name}' is unidirectional but ${iface.name}.${m.name} returns a value`
          )
        else if (m.params.some((prm) => prm.direction !== 'in'))
          push(
            'error',
            target,
            `Link '${l.name}' is unidirectional but ${iface.name}.${m.name} has out parameters`
          )
    if (c.direction === 'unidirectional' && c.ack.required)
      push('error', target, `Link '${l.name}' is unidirectional but requires an ack`)
    if (!c.ack.required && c.ack.timeoutMs !== undefined)
      push('warning', target, `Link '${l.name}': ack timeout set but ack not required`)
    if (c.remote.enabled && !c.remote.transport)
      push('warning', target, `Link '${l.name}' is remote but has no transport`)
    if (!c.remote.enabled && c.remote.transport)
      push('warning', target, `Link '${l.name}': transport set but link is not remote`)
    if (l.from.moduleId === l.to.moduleId)
      push('warning', target, `Link '${l.name}' loops back on the same module`)
  }

  return problems
}

export const hasErrors = (problems: Problem[]): boolean => problems.some((pr) => pr.severity === 'error')
