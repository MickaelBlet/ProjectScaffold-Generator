// Semantic checks. Errors block export; warnings do not.
import {
  allTypeRefs,
  ancestorModules,
  findImported,
  findPort,
  IDENTIFIER_RE,
  isImportedId,
  linkRoles,
  methodSignature,
  modulePath,
  unimplementedMethods
} from './project'
import { normalizeFile } from './sync'
import { isReservedTypeName, walkTypeRef } from './typeExpr'
import { valueErrors } from './defaults'
import { binariesOf, crosses } from './binaries'
import { DEFAULT_HOST, foreignFields } from './transports'
import {
  INT_RANGES,
  TRANSPORTS,
  type Id,
  type Message,
  type Project,
  type TypeDef,
  type TypeRef,
  type ValueField
} from './types'

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
  // Entities of dependencies are checked in their own file: here only errors matter.
  const fromLibrary = new Set([...p.types, ...p.interfaces].filter((e) => e.dependency).map((e) => e.id))
  const push = (severity: Severity, target: ProblemTarget, message: string): void => {
    if (severity === 'warning' && 'id' in target && fromLibrary.has(target.id)) return
    problems.push({ severity, target, message })
  }
  const types = new Map(p.types.map((t) => [t.id, t]))
  const interfaces = new Map(p.interfaces.map((i) => [i.id, i]))
  const modules = new Set(p.modules.map((m) => m.id))

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
      if (n.kind === 'primitive' && n.max !== undefined && n.name !== 'string' && n.name !== 'bytes')
        push('error', target, `${where}: ${n.name} cannot be bounded`)
      const keyOf = n.kind === 'map' ? n.key : n.kind === 'set' ? n.of : null
      if (!keyOf) return
      const k = resolve(keyOf)
      if (!k) return
      const ok = k.kind === 'primitive' || k.kind === 'enum' || k.kind === 'bitmask'
      if (!ok) push('error', target, `${where}: ${n.kind} key must be a primitive, an enum or a bitmask`)
      else if (k.kind === 'primitive' && (k.name === 'float32' || k.name === 'float64'))
        push('warning', target, `${where}: floating-point ${n.kind} key`)
    })
  }

  const checkDefault = (f: ValueField, target: ProblemTarget, where: string): void => {
    if (f.default === undefined) return
    for (const e of valueErrors(f.default, f.type, p.types)) push('error', target, `${where} default: ${e}`)
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
        for (const f of t.fields) {
          checkTypeRef(f.type, target, `${t.name}.${f.name}`)
          checkDefault(f, target, `${t.name}.${f.name}`)
        }
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
      case 'bitmask': {
        if (!t.flags.length) push('warning', target, `Bitmask '${t.name}' has no flags`)
        for (const n of duplicates(t.flags.map((v) => v.name)))
          push('error', target, `Bitmask '${t.name}': duplicate flag '${n}'`)
        for (const n of duplicates(t.flags.map((v) => String(v.bit))))
          push('error', target, `Bitmask '${t.name}': bit ${n} used more than once`)
        const width = Number(t.underlying.slice(4))
        for (const v of t.flags)
          if (v.bit >= width)
            push(
              'error',
              target,
              `Bitmask '${t.name}': ${v.name} (bit ${v.bit}) does not fit in ${t.underlying}`
            )
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

  /** Parameters and return type of an interface message or a module method. */
  const checkMessage = (m: Message, target: ProblemTarget, where: string): void => {
    for (const n of duplicates(m.params.map((prm) => prm.name)))
      push('error', target, `${where}: duplicate parameter '${n}'`)
    for (const prm of m.params) checkTypeRef(prm.type, target, `${where}(${prm.name})`)
    if (m.returns) checkTypeRef(m.returns, target, `${where} returns`)
  }

  // Interfaces
  for (const i of p.interfaces) {
    const target = { kind: 'interface', id: i.id } as const
    if (isReservedTypeName(i.name)) push('error', target, `'${i.name}' is a reserved type name`)
    if (!i.messages.length) push('warning', target, `Interface '${i.name}' has no messages`)
    for (const n of duplicates(i.messages.map((m) => m.name)))
      push('error', target, `Interface '${i.name}': duplicate message '${n}'`)
    for (const m of i.messages) checkMessage(m, target, `${i.name}.${m.name}`)
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
  // Binaries
  for (const n of duplicates(p.binaries.map((b) => b.name)))
    push('error', { kind: 'project' }, `Duplicate binary name '${n}'`)
  for (const b of p.binaries)
    if (!IDENTIFIER_RE.test(b.name))
      push('error', { kind: 'project' }, `Binary '${b.name}': not an identifier`)
  const binaryNames = new Map(p.binaries.map((b) => [b.id, b.name]))
  const binaries = binariesOf(p)

  for (const m of p.modules) {
    const target = { kind: 'module', id: m.id } as const
    const path = modulePath(p, m.id)
    if (m.binaryId && !binaryNames.has(m.binaryId)) push('error', target, `${path}: runs in a deleted binary`)
    else if (p.binaries.length && !m.parentId && !m.binaryId)
      push('error', target, `${path}: runs in no binary (the project has binaries)`)
    for (const n of duplicates(m.ports.map((pt) => pt.name)))
      push('error', target, `${path}: duplicate port '${n}'`)
    for (const n of duplicates(m.attributes.map((a) => a.name)))
      push('error', target, `${path}: duplicate attribute '${n}'`)
    for (const a of m.attributes) {
      checkTypeRef(a.type, target, `${path}.${a.name}`)
      checkDefault(a, target, `${path}.${a.name}`)
    }
    for (const n of duplicates(m.methods.map((x) => x.name)))
      push('error', target, `${path}: duplicate method '${n}'`)
    const attributes = new Set(m.attributes.map((a) => a.name))
    const ancestors = ancestorModules(p, m.id)
    for (const x of m.methods) {
      const where = `${path}.${x.name}`
      if (x.static && x.const) push('error', target, `${where}: a static method cannot be const`)
      if (x.static && x.virtual) push('error', target, `${where}: a static method cannot be virtual`)
      if ((x.pure || x.override) && !x.virtual)
        push('error', target, `${where}: a ${x.pure ? 'pure' : 'override'} method must be virtual`)
      if (x.pure && !m.kind)
        push('error', target, `${where}: pure method in a concrete module (make it abstract or an interface)`)
      if (m.kind === 'interface' && !x.pure)
        push('error', target, `${where}: methods of an interface module must be pure`)
      const inherited = ancestors
        .map((a) => ({ base: a, method: a.methods.find((y) => y.name === x.name && y.virtual) }))
        .find((e) => e.method)
      if (x.override) {
        if (!inherited) push('error', target, `${where}: overrides no virtual method of a base`)
        else if (methodSignature(x) !== methodSignature(inherited.method!))
          push(
            'error',
            target,
            `${where}: signature differs from ${modulePath(p, inherited.base.id)}.${x.name} it overrides`
          )
      } else if (inherited)
        push(
          'warning',
          target,
          `${where}: hides virtual ${modulePath(p, inherited.base.id)}.${x.name} (mark it override)`
        )
      if (attributes.has(x.name))
        push('error', target, `${path}: '${x.name}' is both an attribute and a method`)
      checkMessage(x, target, `${path}.${x.name}`)
      for (const prm of x.params)
        if (prm.const && prm.direction !== 'in')
          push(
            'error',
            target,
            `${path}.${x.name}(${prm.name}): an ${prm.direction} parameter cannot be const`
          )
    }
    if (m.kind === 'interface' && m.attributes.length)
      push('error', target, `${path}: an interface module cannot have attributes`)
    const bases = m.bases ?? []
    for (const b of bases) if (!modules.has(b)) push('error', target, `${path} derives from a deleted module`)
    if (bases.includes(m.id)) push('error', target, `${path} derives from itself`)
    else if (bases.some((b) => ancestorModules(p, b).some((a) => a.id === m.id)))
      push('error', target, `${path} derives from itself through its bases`)
    for (const id of duplicates(bases))
      push('error', target, `${path} derives from ${modulePath(p, id)} more than once`)
    if (!m.kind)
      for (const { base, method } of unimplementedMethods(p, m.id))
        push(
          'error',
          target,
          `${path} does not implement pure method ${modulePath(p, base.id)}.${method.name} (implement it or make the module abstract)`
        )
    for (const pt of m.ports) {
      if (!pt.interfaceId) push('warning', target, `${path}:${pt.name} has no interface`)
      else if (!interfaces.has(pt.interfaceId))
        push('error', target, `${path}:${pt.name} references a deleted interface`)
    }
  }

  // Dependencies
  const project = { kind: 'project' } as const
  for (const n of duplicates(p.dependencies.map((x) => x.name)))
    push('error', project, `Duplicate dependency name '${n}'`)
  for (const n of duplicates(p.dependencies.map((x) => normalizeFile(x.file))))
    push('error', project, `Dependency file '${n}' listed more than once`)
  const dependencyByName = new Map(p.dependencies.map((x) => [x.name, x]))
  /** Dependencies whose entities those of `id` may use: itself and the ones it uses, directly or not. */
  const reach = (id: Id, seen = new Set<Id>()): Set<Id> => {
    if (seen.has(id)) return seen
    seen.add(id)
    const dep = p.dependencies.find((x) => x.id === id)
    for (const u of dep?.uses ?? []) {
      const used = dependencyByName.get(u)
      if (used) reach(used.id, seen)
    }
    return seen
  }
  for (const x of p.dependencies) {
    if (!x.file.trim()) push('warning', project, `Dependency '${x.name}' has no file`)
    for (const u of x.uses)
      if (!dependencyByName.has(u))
        push('error', project, `Dependency '${x.name}' uses unknown dependency '${u}'`)
    if (
      x.uses.some((u) => {
        const used = dependencyByName.get(u)
        return !!used && reach(used.id).has(x.id)
      })
    )
      push('error', project, `Dependency '${x.name}' uses itself through other dependencies`)
  }
  const owners = new Map([...p.types, ...p.interfaces].map((e) => [e.id, e.dependency]))
  for (const { ref, where, owner } of allTypeRefs(p)) {
    const dependency = owner.kind === 'module' ? undefined : owners.get(owner.id)
    if (!dependency) continue
    const allowed = reach(dependency)
    // Entities held by another dependency count as those of the ones sharing them.
    const shared = new Set(p.dependencies.filter((x) => allowed.has(x.id)).flatMap((x) => x.shared))
    walkTypeRef(ref, (n) => {
      const used = n.kind === 'ref' && types.get(n.id)
      if (used && (!used.dependency || !allowed.has(used.dependency)) && !shared.has(used.name))
        push(
          'error',
          { kind: owner.kind, id: owner.id },
          `${where}: '${used.name}' is not in its dependency or the dependencies it uses`
        )
    })
  }

  // Links
  for (const n of duplicates(p.links.map((l) => l.name)))
    push('error', { kind: 'project' }, `Duplicate link name '${n}'`)
  const endpoints = new Set<string>()
  // Remote links by the address their server binds, and by shm segment: collisions.
  const servers = new Map<string, string>()
  const segments = new Map<string, string>()
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
    const [fromRole, toRole] = linkRoles(p, l.from.moduleId, l.to.moduleId)
    if (from.role !== fromRole)
      push('error', target, `Link '${l.name}': source port '${from.name}' must be an '${fromRole}' port`)
    if (to.role !== toRole)
      push('error', target, `Link '${l.name}': target port '${to.name}' must be an '${toRole}' port`)
    // Imported ports use this project's interface of the same name.
    const foreign = [l.from, l.to].flatMap((e) => {
      const name = findImported(p, e.moduleId)?.module.ports.find((pt) => pt.id === e.portId)?.interface
      return name && !p.interfaces.some((i) => i.name === name)
        ? [
            `${modulePath(p, e.moduleId)}:${findPort(p, e.moduleId, e.portId)?.name} uses interface '${name}', not defined in this project`
          ]
        : []
    })
    for (const f of foreign) push('error', target, `Link '${l.name}': ${f}`)
    if (!foreign.length && from.interfaceId !== to.interfaceId)
      push('error', target, `Link '${l.name}': ports use different interfaces`)
    if (isImportedId(l.from.moduleId) && isImportedId(l.to.moduleId))
      push('error', target, `Link '${l.name}' joins two imported modules: one end must be in this project`)
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
    const binaryFrom = binaries.get(l.from.moduleId)
    const binaryTo = binaries.get(l.to.moduleId)
    const between = `binaries ${binaryNames.get(binaryFrom!)} and ${binaryNames.get(binaryTo!)}`
    if (crosses(binaries, l) && !c.remote.enabled)
      push('error', target, `Link '${l.name}' joins ${between}: it must be remote`)
    else if (crosses(binaries, l) && !c.remote.transport)
      push('error', target, `Link '${l.name}' joins ${between}: it needs a transport`)
    else if (c.remote.enabled && !c.remote.transport)
      push('warning', target, `Link '${l.name}' is remote but has no transport`)
    if (c.remote.enabled && binaryFrom && binaryFrom === binaryTo)
      push(
        'warning',
        target,
        `Link '${l.name}' is remote but both ends run in binary ${binaryNames.get(binaryFrom)}`
      )
    if (
      c.remote.transport &&
      !(TRANSPORTS as readonly string[]).includes(c.remote.transport) &&
      !p.transports.includes(c.remote.transport)
    )
      push('warning', target, `Link '${l.name}': unknown transport '${c.remote.transport}'`)
    if (!c.remote.enabled && c.remote.transport)
      push('warning', target, `Link '${l.name}': transport set but link is not remote`)
    const settings = c.remote.settings
    if (!c.remote.enabled && settings)
      push('warning', target, `Link '${l.name}': transport settings set but link is not remote`)
    if (settings && c.remote.enabled) {
      const transport = c.remote.transport
      const foreign = foreignFields(settings, transport)
      if (foreign.length)
        push(
          'warning',
          target,
          `Link '${l.name}': ${foreign.join(', ')} ${foreign.length > 1 ? 'do' : 'does'} not apply to transport '${transport ?? ''}'`
        )
      if (
        (transport === 'http' || transport === 'websocket') &&
        settings.path &&
        !settings.path.startsWith('/')
      )
        push('error', target, `Link '${l.name}': path '${settings.path}' must start with '/'`)
      if (transport === 'shm' && settings.name !== undefined) {
        if (!/^\/?[^/]+$/.test(settings.name) || settings.name.length > 255)
          push('error', target, `Link '${l.name}': shared memory name '${settings.name}' is not valid`)
        const segment = settings.name.replace(/^\//, '')
        const other = segments.get(segment)
        if (other)
          push('warning', target, `Link '${l.name}' uses the shared memory '${segment}' of link '${other}'`)
        else segments.set(segment, l.name)
      }
      const port = settings.server?.port
      const family =
        transport === 'udp'
          ? 'udp'
          : ['tcp', 'http', 'websocket', 'grpc'].includes(transport ?? '')
            ? 'tcp'
            : null
      if (family && port !== undefined) {
        const host = settings.server?.host ?? p.remoteDefaults?.server?.host ?? DEFAULT_HOST
        const key = `${family} ${host}:${port}`
        const other = servers.get(key)
        if (other)
          push('warning', target, `Link '${l.name}' listens on ${family} ${host}:${port}, as link '${other}'`)
        else servers.set(key, l.name)
      }
    }
    if (l.from.moduleId === l.to.moduleId)
      push('warning', target, `Link '${l.name}' loops back on the same module`)
  }

  return problems
}

export const hasErrors = (problems: Problem[]): boolean => problems.some((pr) => pr.severity === 'error')
