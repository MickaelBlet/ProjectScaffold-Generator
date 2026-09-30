// Generation context: the exported project file, resolved for templates. Language neutral: names
// only, every optional value present (templates run with strict variables), modules flattened
// with their links sorted into wiring at the right level.
import { dependencyName } from '../model/dependencies'
import { mapTypeRef, walkTypeRef } from '../model/typeExpr'
import type {
  FileInterface,
  FileLink,
  FileMethod,
  FileModule,
  FileProject,
  FileTypeDef
} from '../model/schema'
import type { ModuleKind, ParamDirection, PerformanceClass, PortRole, TypeRefOf, Value } from '../model/types'

export type TypeKind = FileTypeDef['kind']

/** Type reference with the kind and owner of the user types it names. */
export type GenTypeRef = TypeRefOf<{ name: string; typeKind: TypeKind; dependency: string | null }>

interface Owned {
  /** Name of the dependency defining it; null for the project's own ones. */
  dependency: string | null
}

/** What the type references of an entity use, e.g. to know what to include or import. */
export interface GenUses {
  /** User types named, without the types those use in turn; by name. */
  types: GenType[]
  /** Primitive type names and container kinds (`int32`, `string`, `vector`, `map`...), sorted. */
  builtins: string[]
}

export interface GenField {
  name: string
  type: GenTypeRef
  description: string
  hasDefault: boolean
  default: Value
}

export type GenType = Owned & {
  entity: 'type'
  name: string
  description: string
  uses: GenUses
} & (
    | { kind: 'struct'; fields: GenField[] }
    | { kind: 'enum'; underlying: string; values: { name: string; value: number }[] }
    | { kind: 'alias'; type: GenTypeRef }
    | { kind: 'primitive' }
  )

export interface GenParam {
  name: string
  type: GenTypeRef
  description: string
  direction: ParamDirection
  const: boolean
}

export interface GenMessage {
  name: string
  description: string
  params: GenParam[]
  returns: GenTypeRef | null
}

export interface GenInterface extends Owned {
  entity: 'interface'
  name: string
  description: string
  messages: GenMessage[]
  uses: GenUses
}

export interface GenMethod extends GenMessage {
  static: boolean
  const: boolean
  virtual: boolean
  pure: boolean
  override: boolean
}

export interface GenAttribute extends GenField {
  static: boolean
  const: boolean
}

export interface GenConstraints {
  direction: 'unidirectional' | 'bidirectional'
  ack: { required: boolean; timeoutMs: number | null }
  performance: { class: PerformanceClass; maxLatencyMs: number | null; rateHz: number | null }
  remote: { enabled: boolean; transport: string | null }
}

export interface GenLink {
  name: string
  description: string
  from: { project: string | null; module: string; port: string }
  to: { project: string | null; module: string; port: string }
  constraints: GenConstraints
}

/** A port reached from a scope (module or system): through the children named in `via`, in order. */
export interface GenEndpoint {
  via: string[]
  module: string
  port: string
}

export interface GenPort {
  name: string
  role: PortRole
  description: string
  interface: GenInterface | null
  /**
   * Ports of the content the port stands for: the inner `in` ports an `in` port hands its calls to,
   * or the inner `out` ports whose calls go out through an `out` port.
   */
  delegates: GenEndpoint[]
}

/** Link between two modules inside a scope (neither end is the scope itself). */
export interface GenConnection {
  link: GenLink
  from: GenEndpoint
  to: GenEndpoint
}

/** Link to a module of another project: wired by hand. */
export interface GenExternal {
  link: GenLink
  /** End in this project, from the system. */
  local: GenEndpoint
  /** Which end of the link is local. */
  side: 'from' | 'to'
  remote: { project: string; module: string; port: string }
}

export interface GenModule {
  entity: 'module'
  name: string
  /** Qualified path, e.g. `Core.Sensor`. */
  path: string
  /** Names of the enclosing modules, outermost first. */
  namespace: string[]
  /** Path of the enclosing module; null at the top level. */
  parent: string | null
  depth: number
  description: string
  kind: ModuleKind
  /** Not concrete: cannot be held by value. */
  abstract: boolean
  bases: GenModule[]
  /** Some module derives from it. */
  isBase: boolean
  metadata: Record<string, string>
  color: string | null
  attributes: GenAttribute[]
  methods: GenMethod[]
  /** By its attributes and methods (the interfaces of its ports use their own). */
  uses: GenUses
  ports: GenPort[]
  children: GenModule[]
  /**
   * Children it holds an instance of: the concrete ones, and the abstract ones with ports (to be
   * created by hand). Abstract children without ports are only classes to derive from.
   */
  instances: GenModule[]
  /** Links between its content, wired by it. */
  connections: GenConnection[]
}

/** An executable of the project, holding some of its top-level modules. */
export interface GenBinary {
  name: string
  description: string
  color: string | null
  /** Its top-level modules. */
  modules: GenModule[]
}

/** End in this binary of a link to another binary of the project: wired through a transport. */
export interface GenRemote {
  link: GenLink
  /** End in this binary, from its system. */
  local: GenEndpoint
  /** Interface of the ports: a proxy of it sends the calls, a stub receives them. */
  interface: GenInterface
  /** End in the other binary. */
  peer: { binary: string; module: string; port: string }
}

/**
 * The top level of the project, or of one of its binaries: holds the top-level modules and wires
 * the links between them.
 */
export interface GenSystem {
  entity: 'system'
  /** `System`, or `<Binary>System`. */
  name: string
  /** Binary it is the top level of; null when the project has no binaries. */
  binary: GenBinary | null
  children: GenModule[]
  /** See GenModule.instances. */
  instances: GenModule[]
  connections: GenConnection[]
  external: GenExternal[]
  /** Links calling another binary: through a proxy of their interface. */
  proxies: GenRemote[]
  /** Links called from another binary: through a stub of their interface. */
  stubs: GenRemote[]
  /** Nothing: there for templates treating modules and the system alike. */
  uses: GenUses
}

export interface GenDependency {
  name: string
  file: string
  indirect: boolean
  types: GenType[]
  interfaces: GenInterface[]
}

export interface GenContext {
  project: {
    name: string
    /** Identifier made from the name, as dependencies name the project. */
    ident: string
    description: string
    metadata: Record<string, string>
  }
  transports: string[]
  /** The project's own types and interfaces. */
  types: GenType[]
  interfaces: GenInterface[]
  /** Every module, depth first. */
  modules: GenModule[]
  binaries: GenBinary[]
  /** One per binary, or the only one when the project has no binaries. */
  systems: GenSystem[]
  /** The only system when the project has no binaries, else null. */
  system: GenSystem | null
  /** Interfaces of the links between binaries. */
  remoteInterfaces: GenInterface[]
  links: GenLink[]
  dependencies: GenDependency[]
  /** Own types and those of the dependencies. */
  allTypes: GenType[]
  allInterfaces: GenInterface[]
  /** Problems found while building the context (the project itself is valid). */
  warnings: string[]
}

export function buildContext(file: FileProject): GenContext {
  const warnings: string[] = []
  const typeOwner = new Map<string, { kind: TypeKind; dependency: string | null }>()
  for (const t of file.types) typeOwner.set(t.name, { kind: t.kind, dependency: null })
  for (const d of file.dependencies ?? [])
    for (const t of d.types)
      if (!typeOwner.has(t.name)) typeOwner.set(t.name, { kind: t.kind, dependency: d.name })

  const ref = (t: TypeRefOf<{ name: string }>): GenTypeRef =>
    mapTypeRef(t, (r) => {
      const owner = typeOwner.get(r.name)
      return {
        kind: 'ref',
        name: r.name,
        typeKind: owner?.kind ?? 'primitive',
        dependency: owner?.dependency ?? null
      }
    })

  const field = (f: {
    name: string
    type: TypeRefOf<{ name: string }>
    description?: string
    default?: unknown
  }): GenField => ({
    name: f.name,
    type: ref(f.type),
    description: f.description ?? '',
    hasDefault: f.default !== undefined,
    default: (f.default ?? null) as Value
  })

  const typeDef = (t: FileTypeDef, dependency: string | null): GenType => {
    const base = {
      entity: 'type' as const,
      name: t.name,
      description: t.description ?? '',
      dependency,
      uses: noUses()
    }
    switch (t.kind) {
      case 'struct':
        return { ...base, kind: 'struct', fields: t.fields.map(field) }
      case 'enum':
        return { ...base, kind: 'enum', underlying: t.underlying, values: t.values.map((v) => ({ ...v })) }
      case 'alias':
        return { ...base, kind: 'alias', type: ref(t.type) }
      case 'primitive':
        return { ...base, kind: 'primitive' }
    }
  }

  const message = (m: FileInterface['messages'][number] | FileMethod): GenMessage => ({
    name: m.name,
    description: m.description ?? '',
    params: m.params.map((p) => ({
      name: p.name,
      type: ref(p.type),
      description: p.description ?? '',
      direction: p.direction ?? 'in',
      const: 'const' in p ? !!p.const : false
    })),
    returns: m.returns ? ref(m.returns) : null
  })

  const iface = (i: FileInterface, dependency: string | null): GenInterface => ({
    entity: 'interface',
    name: i.name,
    description: i.description ?? '',
    dependency,
    messages: i.messages.map(message),
    uses: noUses()
  })

  const types = file.types.map((t) => typeDef(t, null))
  const interfaces = file.interfaces.map((i) => iface(i, null))
  const dependencies: GenDependency[] = (file.dependencies ?? []).map((d) => ({
    name: d.name,
    file: d.file,
    indirect: !!d.indirect,
    types: d.types.map((t) => typeDef(t, d.name)),
    interfaces: d.interfaces.map((i) => iface(i, d.name))
  }))
  const allTypes = [...types, ...dependencies.flatMap((d) => d.types)]
  const allInterfaces = [...interfaces, ...dependencies.flatMap((d) => d.interfaces)]
  const interfaceByName = new Map<string, GenInterface>()
  for (const i of allInterfaces) if (!interfaceByName.has(i.name)) interfaceByName.set(i.name, i)

  // Modules, depth first.
  const modules: GenModule[] = []
  const byPath = new Map<string, GenModule>()
  const basesOf = new Map<GenModule, string[]>()
  const walk = (m: FileModule, namespace: string[]): GenModule => {
    const path = [...namespace, m.name].join('.')
    const g: GenModule = {
      entity: 'module',
      name: m.name,
      path,
      namespace,
      parent: namespace.length ? namespace.join('.') : null,
      depth: namespace.length,
      description: m.description ?? '',
      kind: m.kind ?? 'class',
      abstract: !!m.kind && m.kind !== 'class',
      bases: [],
      isBase: false,
      metadata: { ...(m.metadata ?? {}) },
      color: m.color ?? null,
      attributes: (m.attributes ?? []).map((a) => ({ ...field(a), static: !!a.static, const: !!a.const })),
      uses: noUses(),
      methods: (m.methods ?? []).map((x) => ({
        ...message(x),
        static: !!x.static,
        const: !!x.const,
        virtual: !!x.virtual,
        pure: !!x.pure,
        override: !!x.override
      })),
      ports: m.ports.map((p) => ({
        name: p.name,
        role: p.role,
        description: p.description ?? '',
        interface: p.interface ? (interfaceByName.get(p.interface) ?? null) : null,
        delegates: []
      })),
      children: [],
      instances: [],
      connections: []
    }
    modules.push(g)
    byPath.set(path, g)
    basesOf.set(g, m.bases ?? [])
    g.children = (m.modules ?? []).map((c) => walk(c, [...namespace, m.name]))
    g.instances = g.children.filter(instantiated)
    return g
  }
  const top = file.modules.map((m) => walk(m, []))
  for (const [g, bases] of basesOf)
    g.bases = bases.flatMap((b) => {
      const base = byPath.get(b)
      if (base) base.isBase = true
      return base ? [base] : []
    })

  // What each entity uses, now that every type exists.
  const typeByName = new Map<string, GenType>()
  for (const t of allTypes) if (!typeByName.has(t.name)) typeByName.set(t.name, t)
  const usesOf = (refs: GenTypeRef[], builtins: string[] = []): GenUses => {
    const types = new Map<string, GenType>()
    const names = new Set(builtins)
    for (const r of refs)
      walkTypeRef(r, (n) => {
        if (n.kind === 'ref') {
          const t = typeByName.get(n.name)
          if (t) types.set(t.name, t)
        } else names.add(n.kind === 'primitive' ? n.name : n.kind)
      })
    return {
      types: [...types.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
      builtins: [...names].sort()
    }
  }
  const messageRefs = (m: GenMessage): GenTypeRef[] => [
    ...m.params.map((p) => p.type),
    ...(m.returns ? [m.returns] : [])
  ]
  for (const t of allTypes)
    t.uses =
      t.kind === 'struct'
        ? usesOf(t.fields.map((f) => f.type))
        : t.kind === 'alias'
          ? usesOf([t.type])
          : usesOf([], t.kind === 'enum' ? [t.underlying] : [])
  for (const i of allInterfaces) i.uses = usesOf(i.messages.flatMap(messageRefs))
  for (const m of modules)
    m.uses = usesOf([...m.attributes.map((a) => a.type), ...m.methods.flatMap(messageRefs)])

  // One system per binary, or one for the whole project.
  const binaries: GenBinary[] = (file.binaries ?? []).map((b) => ({
    name: b.name,
    description: b.description ?? '',
    color: b.color ?? null,
    modules: []
  }))
  const systemOf = (binary: GenBinary | null, children: GenModule[]): GenSystem => ({
    entity: 'system',
    name: binary ? `${binary.name}System` : 'System',
    binary,
    children,
    instances: children.filter(instantiated),
    connections: [],
    external: [],
    proxies: [],
    stubs: [],
    uses: noUses()
  })
  const binaryOfTop = new Map<string, GenBinary>()
  for (const [i, m] of file.modules.entries()) {
    const b = binaries.find((x) => x.name === m.binary)
    if (b) {
      b.modules.push(top[i]!)
      binaryOfTop.set(m.name, b)
    } else if (binaries.length) warnings.push(`Module '${m.name}' runs in no binary: left out`)
  }
  const systems = binaries.length ? binaries.map((b) => systemOf(b, b.modules)) : [systemOf(null, top)]
  /** System of a module path; null for a module of no binary. */
  const systemAt = (path: string): GenSystem | null => {
    if (!binaries.length) return systems[0]!
    const b = binaryOfTop.get(path.split('.')[0]!)
    return b ? systems[binaries.indexOf(b)]! : null
  }
  const remoteInterfaces = new Map<string, GenInterface>()
  const links = file.links.map(genLink)
  const segments = (path: string): string[] => path.split('.')
  /** Children to go through from the module at `scope` (null: the system) to the module at `path`. */
  const via = (scope: string | null, path: string): string[] =>
    segments(path).slice(scope ? segments(scope).length : 0)
  const isAncestor = (a: string, b: string): boolean => b.startsWith(a + '.')
  const port = (path: string, name: string): GenPort | undefined =>
    byPath.get(path)?.ports.find((p) => p.name === name)

  for (const l of links) {
    const { from, to } = l
    if (from.project || to.project) {
      const local = from.project ? to : from
      const remote = from.project ? from : to
      if (local.project) continue
      systemAt(local.module)?.external.push({
        link: l,
        local: { via: via(null, local.module), module: local.module, port: local.port },
        side: from.project ? 'to' : 'from',
        remote: { project: remote.project!, module: remote.module, port: remote.port }
      })
      continue
    }
    if (!byPath.has(from.module) || !byPath.has(to.module)) {
      warnings.push(`Link '${l.name}' has a missing endpoint`)
      continue
    }
    if (isAncestor(from.module, to.module)) {
      // A container's `in` port handing its calls to an inner `in` port.
      port(from.module, from.port)?.delegates.push({
        via: via(from.module, to.module),
        module: to.module,
        port: to.port
      })
      continue
    }
    if (isAncestor(to.module, from.module)) {
      // An inner `out` port going out through the container's `out` port.
      port(to.module, to.port)?.delegates.push({
        via: via(to.module, from.module),
        module: from.module,
        port: from.port
      })
      continue
    }
    // Wired by the innermost module holding both ends.
    const a = segments(from.module)
    const b = segments(to.module)
    let n = 0
    while (n < a.length - 1 && n < b.length - 1 && a[n] === b[n]) n++
    const scope = n ? a.slice(0, n).join('.') : null
    const connection: GenConnection = {
      link: l,
      from: { via: via(scope, from.module), module: from.module, port: from.port },
      to: { via: via(scope, to.module), module: to.module, port: to.port }
    }
    if (scope) {
      byPath.get(scope)!.connections.push(connection)
      continue
    }
    const at = systemAt(from.module)
    const peer = systemAt(to.module)
    if (!at || !peer) continue
    if (at === peer) {
      at.connections.push(connection)
      continue
    }
    // Between binaries: a proxy sends the calls of the `from` end, a stub hands them to the `to` end.
    const face = port(from.module, from.port)?.interface
    if (!face) {
      warnings.push(`Link '${l.name}' between binaries has no interface: left out`)
      continue
    }
    remoteInterfaces.set(face.name, face)
    at.proxies.push({
      link: l,
      local: connection.from,
      interface: face,
      peer: { binary: peer.binary!.name, module: to.module, port: to.port }
    })
    peer.stubs.push({
      link: l,
      local: connection.to,
      interface: face,
      peer: { binary: at.binary!.name, module: from.module, port: from.port }
    })
  }
  for (const m of modules)
    for (const p of m.ports)
      if (p.role === 'in' && p.delegates.length > 1)
        warnings.push(
          `${m.path}:${p.name} hands its calls to ${p.delegates.length} inner ports: only ${p.delegates[0]!.module}:${p.delegates[0]!.port} is wired`
        )

  return {
    project: {
      name: file.project.name,
      ident: dependencyName(file.project.name),
      description: file.project.description ?? '',
      metadata: { ...(file.project.metadata ?? {}) }
    },
    transports: file.transports ?? [],
    types,
    interfaces,
    modules,
    binaries,
    systems,
    system: binaries.length ? null : systems[0]!,
    remoteInterfaces: [...remoteInterfaces.values()],
    links,
    dependencies,
    allTypes,
    allInterfaces,
    warnings
  }
}

const noUses = (): GenUses => ({ types: [], builtins: [] })

const instantiated = (m: GenModule): boolean => !m.abstract || m.ports.length > 0

function genLink(l: FileLink): GenLink {
  const c = l.constraints
  return {
    name: l.name,
    description: l.description ?? '',
    from: { project: l.from.project ?? null, module: l.from.module, port: l.from.port },
    to: { project: l.to.project ?? null, module: l.to.module, port: l.to.port },
    constraints: {
      direction: c.direction,
      ack: { required: c.ack.required, timeoutMs: c.ack.timeoutMs ?? null },
      performance: {
        class: c.performance.class,
        maxLatencyMs: c.performance.maxLatencyMs ?? null,
        rateHz: c.performance.rateHz ?? null
      },
      remote: { enabled: c.remote.enabled, transport: c.remote.transport ?? null }
    }
  }
}
