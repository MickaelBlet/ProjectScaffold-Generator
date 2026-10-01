// In-memory project <-> file format (qualified names), YAML/JSON text.
import YAML, { LineCounter, YAMLParseError, isMap, isScalar, isSeq, type Node as YamlNode } from 'yaml'
import {
  FileProjectSchema,
  SCHEMA_VERSION,
  type FileEditor,
  type FileInterface,
  type FileMessage,
  type FileModule,
  type FileProject,
  type FileTypeDef
} from './schema'
import { mapTypeRef } from './typeExpr'
import { pair } from './reuse'
import {
  childModules,
  compartmentsHeight,
  findImported,
  IMPORTED_PREFIX,
  leafHeight,
  MODULE_WIDTH,
  modulePath,
  modulePaths,
  newId,
  portRows
} from './project'
import {
  METHOD_QUALIFIERS,
  type Attribute,
  type Binary,
  type Field,
  type Id,
  type Dependency,
  type Interface,
  type Link,
  type Message,
  type Metadata,
  type Method,
  type Module,
  type Note,
  type Param,
  type Qualifier,
  type Project,
  type Side,
  type TypeDef,
  type TypeRef,
  type Value,
  type ValueField,
  type View
} from './types'
import type { FileTypeRef } from './schema'

export type Format = 'yaml' | 'json'

/** Where a problem is: its path in the file data, and its line (from 1) once found in the text. */
export interface LoadIssue {
  message: string
  path?: (string | number)[]
  line?: number
}

export class LoadError extends Error {
  readonly issues: LoadIssue[]
  /** Messages, prefixed with their line when known. */
  readonly problems: string[]
  constructor(issues: (string | LoadIssue)[]) {
    const all = issues.map((i) => (typeof i === 'string' ? { message: i } : i))
    const problems = all.map((i) => (i.line ? `Line ${i.line}: ${i.message}` : i.message))
    super(problems.join('\n'))
    this.issues = all
    this.problems = problems
  }
}

type DataPath = (string | number)[]

const opt = (s: string): string | undefined => (s ? s : undefined)
/** Qualifiers of `q` that are set, the others left out. */
const qualifiers = (q: { [K in Qualifier]?: boolean }): { [K in Qualifier]?: true } =>
  Object.fromEntries(METHOD_QUALIFIERS.filter((k) => q[k]).map((k) => [k, true]))
const optMeta = (m: Metadata): Metadata | undefined => (Object.keys(m).length ? { ...m } : undefined)
/** Name placements of the ports that have one, by port name. */
const portLabels = (ports: { name: string; label?: Side }[]): Record<string, Side> | undefined => {
  const set = ports.filter((pt) => pt.label)
  return set.length ? Object.fromEntries(set.map((pt) => [pt.name, pt.label!])) : undefined
}

/** Drop keys whose value is undefined so the output stays clean. */
function clean<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

export function toFile(p: Project, options: { editor: boolean }): FileProject {
  const typeName = new Map<Id, string>([...p.types, ...p.interfaces].map((e) => [e.id, e.name]))
  const ref = (t: TypeRef): FileTypeRef =>
    mapTypeRef(t, (r) => ({ kind: 'ref', name: typeName.get(r.id) ?? '__deleted__' }))
  const field = (f: Field) => ({ name: f.name, type: ref(f.type), description: opt(f.description) })
  const valueField = (f: ValueField) => ({
    ...field(f),
    default: f.default
  })
  const param = (prm: Param) => ({
    ...field(prm),
    direction: prm.direction === 'in' ? undefined : prm.direction
  })
  const message = (m: Message) => ({
    name: m.name,
    description: opt(m.description),
    params: m.params.map(param),
    returns: m.returns ? ref(m.returns) : null
  })
  const attribute = (a: Attribute) => {
    const { name, ...rest } = valueField(a)
    return { name, ...qualifiers(a), ...rest }
  }
  const method = (m: Method) => ({
    name: m.name,
    description: opt(m.description),
    ...qualifiers(m),
    params: m.params.map((prm) => ({ ...param(prm), ...qualifiers(prm) })),
    returns: m.returns ? ref(m.returns) : null
  })

  const typeDef = (t: TypeDef): FileTypeDef => {
    switch (t.kind) {
      case 'struct':
        return {
          kind: 'struct',
          name: t.name,
          description: opt(t.description),
          fields: t.fields.map(valueField)
        }
      case 'enum':
        return {
          kind: 'enum',
          name: t.name,
          description: opt(t.description),
          underlying: t.underlying,
          values: t.values.map((v) => ({ name: v.name, value: v.value }))
        }
      case 'bitmask':
        return {
          kind: 'bitmask',
          name: t.name,
          description: opt(t.description),
          underlying: t.underlying,
          flags: t.flags.map((v) => ({ name: v.name, bit: v.bit }))
        }
      case 'alias':
        return { kind: 'alias', name: t.name, description: opt(t.description), type: ref(t.type) }
      case 'primitive':
        return { kind: 'primitive', name: t.name, description: opt(t.description) }
    }
  }
  const iface = (i: Interface) => ({
    name: i.name,
    description: opt(i.description),
    messages: i.messages.map(message)
  })
  const owned = (dependency: Id | undefined) => ({
    types: p.types.filter((t) => t.dependency === dependency).map(typeDef),
    interfaces: p.interfaces.filter((i) => i.dependency === dependency).map(iface)
  })

  const binaryName = new Map(p.binaries.map((b) => [b.id, b.name]))
  const moduleTree = (parentId: Id | null): FileModule[] =>
    childModules(p, parentId).map((m) => {
      const children = moduleTree(m.id)
      return {
        name: m.name,
        description: opt(m.description),
        kind: m.kind,
        bases: m.bases?.length ? m.bases.map((b) => modulePath(p, b)) : undefined,
        metadata: optMeta(m.metadata),
        color: m.color,
        binary: m.binaryId ? binaryName.get(m.binaryId) : undefined,
        attributes: m.attributes.length ? m.attributes.map(attribute) : undefined,
        methods: m.methods.length ? m.methods.map(method) : undefined,
        ports: m.ports.map((pt) => ({
          name: pt.name,
          role: pt.role,
          interface: pt.interfaceId ? (typeName.get(pt.interfaceId) ?? null) : null,
          description: opt(pt.description)
        })),
        modules: children.length ? children : undefined
      }
    })

  const endpoint = (e: { moduleId: Id; portId: Id }) => {
    const imported = findImported(p, e.moduleId)
    if (imported)
      return {
        project: imported.dep.name,
        module: imported.module.path,
        port: imported.module.ports.find((pt) => pt.id === e.portId)?.name ?? ''
      }
    return {
      module: modulePath(p, e.moduleId),
      port: p.modules.find((m) => m.id === e.moduleId)?.ports.find((pt) => pt.id === e.portId)?.name ?? ''
    }
  }

  const file: FileProject = {
    schemaVersion: SCHEMA_VERSION,
    project: { name: p.name, description: opt(p.description), metadata: optMeta(p.metadata) },
    transports: p.transports.length ? [...p.transports] : undefined,
    remoteDefaults:
      p.remoteDefaults && Object.keys(p.remoteDefaults).length ? clean(p.remoteDefaults) : undefined,
    binaries: p.binaries.length
      ? p.binaries.map((b) => ({ name: b.name, description: opt(b.description), color: b.color }))
      : undefined,
    ...owned(undefined),
    modules: moduleTree(null),
    links: p.links.map((l) => ({
      name: l.name,
      description: opt(l.description),
      from: endpoint(l.from),
      to: endpoint(l.to),
      constraints: l.constraints
    })),
    dependencies: p.dependencies.length
      ? p.dependencies.map((x) => ({
          name: x.name,
          file: x.file,
          uses: x.uses.length ? [...x.uses] : undefined,
          indirect: x.indirect || undefined,
          shared: x.shared.length ? [...x.shared] : undefined,
          ...owned(x.id),
          modules: x.modules.length
            ? x.modules.map((m) => ({
                module: m.path,
                ports: m.ports.map((pt) => ({
                  name: pt.name,
                  role: pt.role,
                  interface: pt.interface,
                  description: opt(pt.description)
                }))
              }))
            : undefined
        }))
      : undefined
  }
  if (options.editor) {
    const editor: FileEditor = {
      layout: Object.fromEntries(p.modules.map((m) => [modulePath(p, m.id), { ...m.layout }]))
    }
    if (p.views.length)
      editor.views = p.views.map((v) => ({
        name: v.name,
        root: v.rootModuleId ? modulePath(p, v.rootModuleId) : undefined,
        hidden: v.hidden.length ? v.hidden.map((h) => modulePath(p, h)) : undefined
      }))
    const styled = p.modules.filter((m) => m.locked || portLabels(m.ports))
    if (styled.length)
      editor.style = Object.fromEntries(
        styled.map((m) => [
          modulePath(p, m.id),
          { locked: m.locked || undefined, labels: portLabels(m.ports) }
        ])
      )
    if (p.dependencies.some((x) => x.modules.length))
      editor.dependencies = Object.fromEntries(
        p.dependencies
          .filter((x) => x.modules.length)
          .map((x) => [
            x.name,
            Object.fromEntries(
              x.modules.map((m) => [m.path, { ...m.position, ...m.size, labels: portLabels(m.ports) }])
            )
          ])
      )
    if (p.orientation !== 'horizontal') editor.orientation = p.orientation
    const routed = p.links.filter((l) => l.route)
    if (routed.length)
      editor.links = Object.fromEntries(
        routed.map((l) => [
          l.name,
          {
            points: l.route!.points.length ? l.route!.points.map((pt) => ({ ...pt })) : undefined,
            from: l.route!.from && { ...l.route!.from },
            to: l.route!.to && { ...l.route!.to }
          }
        ])
      )
    if (p.notes.length)
      editor.notes = p.notes.map((n) => ({
        kind: n.kind,
        text: n.text,
        ...n.layout,
        color: n.color,
        locked: n.locked || undefined
      }))
    file.editor = editor
  }
  return clean(file)
}

/**
 * Project of a file. With `prev`, a previous state of the project, its entities keep their ids and
 * their editor data when the file has none for them (added to the text or renamed in it).
 */
export function fromFile(data: unknown, prev?: Project): Project {
  const parsed = FileProjectSchema.safeParse(data)
  if (!parsed.success) {
    throw new LoadError(
      parsed.error.issues.map((i) => ({
        message: `${i.path.join('.') || '<root>'}: ${i.message}`,
        path: i.path.filter((k) => typeof k !== 'symbol')
      }))
    )
  }
  const f = parsed.data
  const problems: LoadIssue[] = []
  const report = (message: string, path: DataPath): void => void problems.push({ message, path })

  // Ids derived from names are stable across loads, so that open editors survive a page reload.
  // Next to kept ids they could clash: new entities then get a fresh one.
  const idOf = (was: { id: Id } | undefined, derived: () => Id): Id => was?.id ?? (prev ? newId() : derived())
  /** Previous entity of each named one of `list`. */
  const named = <T extends { name: string }>(
    before: readonly T[] | undefined,
    list: readonly { name: string }[]
  ): (T | undefined)[] =>
    pair(
      before ?? [],
      (e) => e.name,
      list.map((e) => e.name)
    )

  const fileBinaries = f.binaries ?? []
  const prevBinaries = named(prev?.binaries, fileBinaries)
  const binaryIds = new Map<string, Id>()
  const binaries: Binary[] = fileBinaries.map((b, i) => {
    if (binaryIds.has(b.name)) report(`Duplicate binary '${b.name}'`, ['binaries', i, 'name'])
    const id = idOf(prevBinaries[i], () => `binary:${b.name}`)
    binaryIds.set(b.name, id)
    return { id, name: b.name, description: b.description ?? '', ...(b.color ? { color: b.color } : {}) }
  })

  // Types and interfaces share one namespace.
  const typeIds = new Map<string, Id>()
  const declare = (
    name: string,
    what: 'type' | 'interface',
    was: { id: Id } | undefined,
    at: DataPath
  ): Id => {
    if (typeIds.has(name)) report(`Duplicate ${what} name '${name}'`, at)
    const id = idOf(was, () => `${what}:${name}`)
    typeIds.set(name, id)
    return id
  }
  // Dependencies: their types and interfaces follow the project's own ones, in the same namespace.
  const fileDependencies = f.dependencies ?? []
  const prevDependencies = named(prev?.dependencies, fileDependencies)
  const dependencyNames = new Set<string>()
  const dependencyIds = fileDependencies.map((x, i) => {
    if (dependencyNames.has(x.name)) report(`Duplicate dependency '${x.name}'`, ['dependencies', i, 'name'])
    dependencyNames.add(x.name)
    return idOf(prevDependencies[i], () => `dependency:${x.name}`)
  })
  fileDependencies.forEach((x, i) =>
    (x.uses ?? []).forEach((u, j) => {
      if (!dependencyNames.has(u))
        report(`Dependency '${x.name}' uses unknown dependency '${u}'`, ['dependencies', i, 'uses', j])
    })
  )
  /** Entries of the file with their owner dependency and their path in the file data. */
  interface Entry<T> {
    e: T
    at: DataPath
    dependency?: Id
  }
  const typeEntries: Entry<FileTypeDef>[] = [
    ...f.types.map((e, i) => ({ e, at: ['types', i] })),
    ...fileDependencies.flatMap((x, xi) =>
      x.types.map((e, i) => ({ e, at: ['dependencies', xi, 'types', i], dependency: dependencyIds[xi]! }))
    )
  ]
  const interfaceEntries: Entry<FileInterface>[] = [
    ...f.interfaces.map((e, i) => ({ e, at: ['interfaces', i] })),
    ...fileDependencies.flatMap((x, xi) =>
      x.interfaces.map((e, i) => ({
        e,
        at: ['dependencies', xi, 'interfaces', i],
        dependency: dependencyIds[xi]!
      }))
    )
  ]
  const owner = (dependency: Id | undefined) => (dependency ? { dependency } : {})

  const prevTypes = named(
    prev?.types,
    typeEntries.map((x) => x.e)
  )
  const prevInterfaces = named(
    prev?.interfaces,
    interfaceEntries.map((x) => x.e)
  )
  const typeDefIds = typeEntries.map((x, i) => declare(x.e.name, 'type', prevTypes[i], [...x.at, 'name']))
  const interfaceIds = interfaceEntries.map((x, i) =>
    declare(x.e.name, 'interface', prevInterfaces[i], [...x.at, 'name'])
  )
  const interfaceNames = new Set(interfaceEntries.map((x) => x.e.name))

  const ref = (t: FileTypeRef, where: string, at: DataPath): TypeRef =>
    mapTypeRef(t, (r) => {
      const id = typeIds.get(r.name)
      if (!id || interfaceNames.has(r.name)) report(`${where}: unknown type '${r.name}'`, at)
      return { kind: 'ref', id: id ?? newId() }
    })
  const field = (
    fl: { name: string; type: FileTypeRef; description?: string },
    where: string,
    was: { id: Id } | undefined,
    at: DataPath
  ): Field => ({
    id: was?.id ?? newId(),
    name: fl.name,
    type: ref(fl.type, `${where}.${fl.name}`, [...at, 'type']),
    description: fl.description ?? ''
  })
  const valueField = (
    fl: { name: string; type: FileTypeRef; description?: string; default?: unknown },
    where: string,
    was: { id: Id } | undefined,
    at: DataPath
  ): ValueField => {
    const vf: ValueField = field(fl, where, was, at)
    if (fl.default !== undefined) vf.default = fl.default as Value
    return vf
  }
  /** Messages of an interface or methods of a module (`owner`), at `at` in the file data. */
  const messages = (
    list: readonly FileMessage[],
    owner: string,
    before: readonly Message[] | undefined,
    at: DataPath
  ): Message[] => {
    const was = named(before, list)
    return list.map((m, j) => {
      const params = named(was[j]?.params, m.params)
      const where = `${owner}.${m.name}`
      return {
        id: was[j]?.id ?? newId(),
        name: m.name,
        description: m.description ?? '',
        params: m.params.map((prm, k) => ({
          ...field(prm, where, params[k], [...at, j, 'params', k]),
          direction: prm.direction ?? 'in'
        })),
        returns: m.returns ? ref(m.returns, `${where} returns`, [...at, j, 'returns']) : null
      }
    })
  }

  const types: TypeDef[] = typeEntries.map(({ e: t, at, dependency }, i) => {
    const base = { id: typeDefIds[i]!, name: t.name, description: t.description ?? '', ...owner(dependency) }
    const was = prevTypes[i]
    switch (t.kind) {
      case 'struct': {
        const fields = named(was?.kind === 'struct' ? was.fields : [], t.fields)
        return {
          ...base,
          kind: 'struct',
          fields: t.fields.map((fl, j) => valueField(fl, t.name, fields[j], [...at, 'fields', j]))
        }
      }
      case 'enum': {
        const values = named(was?.kind === 'enum' ? was.values : [], t.values)
        return {
          ...base,
          kind: 'enum',
          underlying: t.underlying,
          values: t.values.map((v, j) => ({ id: values[j]?.id ?? newId(), name: v.name, value: v.value }))
        }
      }
      case 'bitmask': {
        const flags = named(was?.kind === 'bitmask' ? was.flags : [], t.flags)
        return {
          ...base,
          kind: 'bitmask',
          underlying: t.underlying,
          flags: t.flags.map((v, j) => ({ id: flags[j]?.id ?? newId(), name: v.name, bit: v.bit }))
        }
      }
      case 'alias':
        return { ...base, kind: 'alias', type: ref(t.type, t.name, [...at, 'type']) }
      case 'primitive':
        return { ...base, kind: 'primitive' }
    }
  })

  const interfaces: Interface[] = interfaceEntries.map(({ e: i, at, dependency }, idx) => ({
    id: interfaceIds[idx]!,
    name: i.name,
    description: i.description ?? '',
    ...owner(dependency),
    messages: messages(i.messages, i.name, prevInterfaces[idx]?.messages, [...at, 'messages'])
  }))

  const layout = f.editor?.layout ?? {}
  const modules: Module[] = []
  const moduleByPath = new Map<string, Module>()
  const prevPaths = prev ? modulePaths(prev) : new Map<Id, string>()
  /** Modules with bases, resolved once all modules are known. */
  const derived: { mod: Module; path: string; bases: string[]; at: DataPath }[] = []

  // Auto layout (modules without editor data): rows of siblings, parents grown to fit children.
  const PAD = 20
  const GAP_X = 80
  const GAP_Y = 60
  const MAX_ROW = 1400

  /** Adds modules and returns the extent (width, height) they occupy inside their parent. */
  const addModules = (
    list: FileModule[],
    parentId: Id | null,
    parentPath: string,
    top: number,
    at: DataPath
  ): { width: number; height: number } => {
    const seen = new Set<string>()
    // A kept module keeps its id: the children of the previous state have the same parent id.
    const before = named(
      prev?.modules.filter((m) => m.parentId === parentId),
      list
    )
    const extent = { width: 0, height: 0 }
    let x = PAD
    let y = top + PAD
    let rowHeight = 0
    for (const [i, fm] of list.entries()) {
      const path = parentPath ? `${parentPath}.${fm.name}` : fm.name
      if (seen.has(fm.name)) report(`Duplicate module '${path}'`, [...at, i, 'name'])
      seen.add(fm.name)
      const was = before[i]
      const renamed = !!was && prevPaths.get(was.id) !== path
      const ports = named(was?.ports, fm.ports)
      const attributes = named(was?.attributes, fm.attributes ?? [])
      const height = leafHeight(portRows(fm)) + compartmentsHeight(fm)
      const portNames = new Set<string>()
      const mod: Module = {
        id: idOf(was, () => `module:${path}`),
        name: fm.name,
        description: fm.description ?? '',
        parentId,
        ...(fm.kind && fm.kind !== 'class' && { kind: fm.kind }),
        metadata: { ...(fm.metadata ?? {}) },
        attributes: (fm.attributes ?? []).map((a, j) => ({
          ...valueField(a, path, attributes[j], [...at, i, 'attributes', j]),
          ...qualifiers(a)
        })),
        methods: messages(fm.methods ?? [], path, was?.methods, [...at, i, 'methods']).map((x, j): Method => {
          const fx = fm.methods![j]!
          return {
            ...x,
            ...qualifiers(fx),
            params: x.params.map((prm, k) => ({ ...prm, ...qualifiers(fx.params[k]!) }))
          }
        }),
        ports: fm.ports.map((pt, j) => {
          if (portNames.has(pt.name))
            report(`Duplicate port '${path}:${pt.name}'`, [...at, i, 'ports', j, 'name'])
          portNames.add(pt.name)
          let interfaceId: Id | null = null
          if (pt.interface) {
            if (!interfaceNames.has(pt.interface))
              report(`Port '${path}:${pt.name}': unknown interface '${pt.interface}'`, [
                ...at,
                i,
                'ports',
                j,
                'interface'
              ])
            interfaceId = typeIds.get(pt.interface) ?? null
          }
          return {
            id: ports[j]?.id ?? newId(),
            name: pt.name,
            role: pt.role,
            interfaceId,
            description: pt.description ?? ''
          }
        }),
        layout: { x: 0, y: 0, width: MODULE_WIDTH, height }
      }
      if (fm.binary) {
        const binaryId = binaryIds.get(fm.binary)
        if (parentId)
          report(`Module '${path}': only top-level modules name their binary`, [...at, i, 'binary'])
        else if (!binaryId) report(`Module '${path}': unknown binary '${fm.binary}'`, [...at, i, 'binary'])
        else mod.binaryId = binaryId
      }
      modules.push(mod)
      moduleByPath.set(path, mod)
      if (fm.bases?.length) derived.push({ mod, path, bases: fm.bases, at: [...at, i, 'bases'] })

      const inner = addModules(fm.modules ?? [], mod.id, path, height, [...at, i, 'modules'])
      const style = f.editor?.style?.[path]
      const color = fm.color ?? style?.color
      if (color) mod.color = color
      if (style ? style.locked : renamed && was.locked) mod.locked = true
      for (const [j, pt] of mod.ports.entries()) {
        const label = style ? style.labels?.[pt.name] : renamed ? ports[j]?.label : undefined
        if (label) pt.label = label
      }
      const saved = layout[path] ?? was?.layout
      if (saved) {
        mod.layout = { ...saved }
      } else {
        const r = mod.layout
        r.width = Math.max(r.width, inner.width + PAD)
        r.height = Math.max(r.height, inner.height + PAD)
        if (x > PAD && x + r.width > MAX_ROW) {
          x = PAD
          y += rowHeight + GAP_Y
          rowHeight = 0
        }
        r.x = x
        r.y = y
        x += r.width + GAP_X
        rowHeight = Math.max(rowHeight, r.height)
      }
      extent.width = Math.max(extent.width, mod.layout.x + mod.layout.width)
      extent.height = Math.max(extent.height, mod.layout.y + mod.layout.height)
    }
    return extent
  }
  addModules(f.modules, null, '', 0, ['modules'])
  for (const { mod, path, bases, at } of derived)
    mod.bases = bases.flatMap((b, j) => {
      const base = moduleByPath.get(b)
      if (!base) report(`Module '${path}': unknown base '${b}'`, [...at, j])
      return base ? [base.id] : []
    })

  // Placed modules of dependencies: on the right of the project's modules when they have no position.
  let importY = PAD
  const importX =
    Math.max(0, ...modules.filter((m) => !m.parentId).map((m) => m.layout.x + m.layout.width)) + GAP_X * 2
  const dependencies: Dependency[] = fileDependencies.map((i, idx) => {
    const paths = new Set<string>()
    const fileModules = i.modules ?? []
    const before = pair(
      prevDependencies[idx]?.modules ?? [],
      (m) => m.path,
      fileModules.map((m) => m.module)
    )
    return {
      id: dependencyIds[idx]!,
      name: i.name,
      file: i.file,
      uses: [...(i.uses ?? [])],
      indirect: i.indirect ?? false,
      shared: [...(i.shared ?? [])],
      modules: fileModules.map((m, j) => {
        const where = `Dependency '${i.name}' module '${m.module}'`
        if (paths.has(m.module))
          report(`${where}: listed more than once`, ['dependencies', idx, 'modules', j, 'module'])
        paths.add(m.module)
        const portNames = new Set<string>()
        const was = before[j]
        const ports = named(was?.ports, m.ports)
        const saved = f.editor?.dependencies?.[i.name]?.[m.module]
        const at = saved ?? was?.position
        const position = at ? { x: at.x, y: at.y } : { x: importX, y: importY }
        if (!at) importY += leafHeight(portRows(m)) + GAP_Y
        const size = saved
          ? saved.width !== undefined && saved.height !== undefined
            ? { width: saved.width, height: saved.height }
            : undefined
          : was?.size
        return {
          id: idOf(was, () => `${IMPORTED_PREFIX}${i.name}/${m.module}`),
          path: m.module,
          position,
          ...(size && { size }),
          ports: m.ports.map((pt, k) => {
            if (portNames.has(pt.name))
              report(`${where}: duplicate port '${pt.name}'`, [
                'dependencies',
                idx,
                'modules',
                j,
                'ports',
                k,
                'name'
              ])
            portNames.add(pt.name)
            return {
              id: ports[k]?.id ?? newId(),
              name: pt.name,
              role: pt.role,
              interface: pt.interface,
              description: pt.description ?? '',
              ...(saved?.labels?.[pt.name] ? { label: saved.labels[pt.name] } : {})
            }
          })
        }
      })
    }
  })

  const endpoint = (e: { project?: string; module: string; port: string }, where: string, at: DataPath) => {
    if (e.project !== undefined) {
      const dep = dependencies.find((x) => x.name === e.project)
      const mod = dep?.modules.find((m) => m.path === e.module)
      const port = mod?.ports.find((pt) => pt.name === e.port)
      if (!dep) report(`${where}: unknown dependency '${e.project}'`, [...at, 'project'])
      else if (!mod)
        report(`${where}: module '${e.module}' is not placed from dependency '${e.project}'`, [
          ...at,
          'module'
        ])
      else if (!port) report(`${where}: unknown port '${e.project}/${e.module}:${e.port}'`, [...at, 'port'])
      return { moduleId: mod?.id ?? '', portId: port?.id ?? '' }
    }
    const mod = moduleByPath.get(e.module)
    const port = mod?.ports.find((pt) => pt.name === e.port)
    if (!mod) report(`${where}: unknown module '${e.module}'`, [...at, 'module'])
    else if (!port) report(`${where}: unknown port '${e.module}:${e.port}'`, [...at, 'port'])
    return { moduleId: mod?.id ?? '', portId: port?.id ?? '' }
  }
  const prevLinks = named(prev?.links, f.links)
  const links: Link[] = f.links.map((l, i) => {
    const was = prevLinks[i]
    const route = f.editor?.links?.[l.name] ?? (was?.name !== l.name ? was?.route : undefined)
    return {
      id: was?.id ?? newId(),
      name: l.name,
      description: l.description ?? '',
      from: endpoint(l.from, `Link '${l.name}' from`, ['links', i, 'from']),
      to: endpoint(l.to, `Link '${l.name}' to`, ['links', i, 'to']),
      constraints: clean(l.constraints),
      ...(route ? { route: clean({ ...route, points: route.points ?? [] }) } : {})
    }
  })

  // Editor data is best effort: dangling module paths are dropped, not reported.
  // Paths of the previous state still find the modules renamed since.
  const moduleIds = new Set(modules.map((m) => m.id))
  const prevIds = new Map([...prevPaths].map(([id, path]) => [path, id]))
  const moduleAt = (path: string): Id | undefined => {
    const id = moduleByPath.get(path)?.id ?? prevIds.get(path)
    return id && moduleIds.has(id) ? id : undefined
  }
  const prevViews = named(prev?.views, f.editor?.views ?? [])
  const views: View[] = (f.editor?.views ?? []).flatMap((v, i) => {
    const was = prevViews[i]
    const root = v.root ? moduleAt(v.root) : undefined
    if (v.root && !root) return []
    const hidden = (v.hidden ?? []).flatMap((h) => moduleAt(h) ?? [])
    return [{ id: idOf(was, () => `view:${i}`), name: v.name, rootModuleId: root ?? null, hidden }]
  })
  const notes: Note[] = (f.editor?.notes ?? []).map((n, i) => ({
    id: prev?.notes[i]?.id ?? newId(),
    kind: n.kind,
    text: n.text,
    layout: { x: n.x, y: n.y, width: n.width, height: n.height },
    ...(n.color ? { color: n.color } : {}),
    ...(n.locked ? { locked: true } : {})
  }))

  if (problems.length) throw new LoadError(problems)
  return {
    name: f.project.name,
    description: f.project.description ?? '',
    metadata: { ...(f.project.metadata ?? {}) },
    transports: [...(f.transports ?? [])],
    ...(f.remoteDefaults ? { remoteDefaults: clean(f.remoteDefaults) } : {}),
    binaries,
    types,
    interfaces,
    modules,
    links,
    dependencies,
    views,
    notes,
    orientation: f.editor?.orientation ?? 'horizontal'
  }
}

export function stringify(file: FileProject, format: Format): string {
  return format === 'json' ? JSON.stringify(file, null, 2) + '\n' : YAML.stringify(file, { lineWidth: 0 })
}

export function parseText(text: string, format: Format): unknown {
  try {
    return format === 'json' ? JSON.parse(text) : YAML.parse(text)
  } catch (e) {
    const message = `Invalid ${format.toUpperCase()}: ${(e as Error).message}`
    throw new LoadError([{ message, line: syntaxErrorLine(text, e) }])
  }
}

/** Line (from 1) of a YAML or JSON syntax error, when the parser tells. */
function syntaxErrorLine(text: string, e: unknown): number | undefined {
  if (e instanceof YAMLParseError) return e.linePos?.[0].line
  const message = e instanceof Error ? e.message : ''
  const line = /\bline (\d+)/.exec(message)
  if (line) return Number(line[1])
  const position = /\bposition (\d+)/.exec(message)
  return position ? text.slice(0, Number(position[1])).split('\n').length : undefined
}

/**
 * Line (from 1) of a path in the file data: the key of the deepest entry of the path found in the
 * text (JSON parses as YAML).
 */
export function lineOfPath(text: string, path: DataPath): number | undefined {
  const counter = new LineCounter()
  const doc = YAML.parseDocument(text, { lineCounter: counter })
  const start = (n: unknown): number | undefined => (n as YamlNode | null | undefined)?.range?.[0]
  let node: unknown = doc.contents
  let at = start(node)
  for (const key of path) {
    let next: unknown
    let offset: number | undefined
    if (isMap(node)) {
      const pair = node.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === key)
      next = pair?.value
      offset = start(pair?.key) ?? start(next)
    } else if (isSeq(node) && typeof key === 'number') {
      next = node.items[key]
      offset = start(next)
    }
    if (offset === undefined) break
    at = offset
    node = next
  }
  return at === undefined ? undefined : counter.linePos(at).line
}

/** A load error whose problems are located in the text they come from. */
function located(text: string, e: unknown): unknown {
  if (!(e instanceof LoadError) || !e.issues.some((i) => i.path && !i.line)) return e
  return new LoadError(
    e.issues.map((i) => (i.path && !i.line ? { ...i, line: lineOfPath(text, i.path) } : i))
  )
}

export function formatFromPath(path: string): Format {
  return path.toLowerCase().endsWith('.json') ? 'json' : 'yaml'
}

export function loadText(text: string, format: Format): Project {
  try {
    return fromFile(parseText(text, format))
  } catch (e) {
    throw located(text, e)
  }
}

export function saveText(p: Project, format: Format, options: { editor: boolean }): string {
  return stringify(toFile(p, options), format)
}

/**
 * New version of `prev` read from text (edited in place or changed on disk): entities keep their
 * ids, and the editor data of `prev` stands in when the text has none.
 */
export function reloadText(text: string, format: Format, prev: Project): Project {
  const data = parseText(text, format)
  if (data && typeof data === 'object' && !Array.isArray(data) && !('editor' in data))
    (data as { editor?: FileEditor }).editor = toFile(prev, { editor: true }).editor
  try {
    return fromFile(data, prev)
  } catch (e) {
    throw located(text, e)
  }
}

/** Whether two projects are saved the same (a reload that changes nothing). */
export function sameContent(a: Project, b: Project): boolean {
  return a === b || saveText(a, 'json', { editor: true }) === saveText(b, 'json', { editor: true })
}
