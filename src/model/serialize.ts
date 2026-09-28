// In-memory project <-> file format (qualified names), YAML/JSON text.
import YAML from 'yaml'
import {
  FileProjectSchema,
  SCHEMA_VERSION,
  type FileEditor,
  type FileModule,
  type FileProject,
  type FileTypeDef
} from './schema'
import { mapTypeRef } from './typeExpr'
import {
  childModules,
  findImported,
  IMPORTED_PREFIX,
  leafHeight,
  MODULE_WIDTH,
  modulePath,
  newId,
  portRows
} from './project'
import type {
  Field,
  Id,
  Import,
  Link,
  Metadata,
  Module,
  Note,
  Param,
  Project,
  Side,
  TypeDef,
  TypeRef,
  View
} from './types'
import type { FileTypeRef } from './schema'

export type Format = 'yaml' | 'json'

export class LoadError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join('\n'))
  }
}

const opt = (s: string): string | undefined => (s ? s : undefined)
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
  const param = (prm: Param) => ({
    ...field(prm),
    direction: prm.direction === 'in' ? undefined : prm.direction
  })

  const types: FileTypeDef[] = p.types.map((t) => {
    switch (t.kind) {
      case 'struct':
        return { kind: 'struct', name: t.name, description: opt(t.description), fields: t.fields.map(field) }
      case 'enum':
        return {
          kind: 'enum',
          name: t.name,
          description: opt(t.description),
          underlying: t.underlying,
          values: t.values.map((v) => ({ name: v.name, value: v.value }))
        }
      case 'alias':
        return { kind: 'alias', name: t.name, description: opt(t.description), type: ref(t.type) }
    }
  })

  const moduleTree = (parentId: Id | null): FileModule[] =>
    childModules(p, parentId).map((m) => {
      const children = moduleTree(m.id)
      return {
        name: m.name,
        description: opt(m.description),
        metadata: optMeta(m.metadata),
        color: m.color,
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
        import: imported.imp.name,
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
    types,
    interfaces: p.interfaces.map((i) => ({
      name: i.name,
      description: opt(i.description),
      messages: i.messages.map((m) => ({
        name: m.name,
        description: opt(m.description),
        params: m.params.map(param),
        returns: m.returns ? ref(m.returns) : null
      }))
    })),
    modules: moduleTree(null),
    imports: p.imports.length
      ? p.imports.map((i) => ({
          name: i.name,
          file: i.file,
          modules: i.modules.map((m) => ({
            module: m.path,
            ports: m.ports.map((pt) => ({
              name: pt.name,
              role: pt.role,
              interface: pt.interface,
              description: opt(pt.description)
            }))
          }))
        }))
      : undefined,
    links: p.links.map((l) => ({
      name: l.name,
      description: opt(l.description),
      from: endpoint(l.from),
      to: endpoint(l.to),
      constraints: l.constraints
    }))
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
        styled.map((m) => [modulePath(p, m.id), { locked: m.locked || undefined, labels: portLabels(m.ports) }])
      )
    if (p.imports.some((i) => i.modules.length))
      editor.imports = Object.fromEntries(
        p.imports.map((i) => [i.name, Object.fromEntries(i.modules.map((m) => [m.path, { ...m.position, labels: portLabels(m.ports) }]))])
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

export function fromFile(data: unknown): Project {
  const parsed = FileProjectSchema.safeParse(data)
  if (!parsed.success) {
    throw new LoadError(parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`))
  }
  const f = parsed.data
  const problems: string[] = []

  // Types and interfaces share one namespace.
  const typeIds = new Map<string, Id>()
  // Ids derived from names are stable across loads, so that open editors survive a page reload.
  const declare = (name: string, what: 'type' | 'interface'): Id => {
    if (typeIds.has(name)) problems.push(`Duplicate ${what} name '${name}'`)
    const id = `${what}:${name}`
    typeIds.set(name, id)
    return id
  }
  const typeDefIds = f.types.map((t) => declare(t.name, 'type'))
  const interfaceIds = f.interfaces.map((i) => declare(i.name, 'interface'))
  const interfaceNames = new Set(f.interfaces.map((i) => i.name))

  const ref = (t: FileTypeRef, where: string): TypeRef =>
    mapTypeRef(t, (r) => {
      const id = typeIds.get(r.name)
      if (!id || interfaceNames.has(r.name)) problems.push(`${where}: unknown type '${r.name}'`)
      return { kind: 'ref', id: id ?? newId() }
    })
  const field = (fl: { name: string; type: FileTypeRef; description?: string }, where: string): Field => ({
    id: newId(),
    name: fl.name,
    type: ref(fl.type, `${where}.${fl.name}`),
    description: fl.description ?? ''
  })

  const types: TypeDef[] = f.types.map((t, i) => {
    const base = { id: typeDefIds[i]!, name: t.name, description: t.description ?? '' }
    switch (t.kind) {
      case 'struct':
        return { ...base, kind: 'struct', fields: t.fields.map((fl) => field(fl, t.name)) }
      case 'enum':
        return {
          ...base,
          kind: 'enum',
          underlying: t.underlying,
          values: t.values.map((v) => ({ id: newId(), name: v.name, value: v.value }))
        }
      case 'alias':
        return { ...base, kind: 'alias', type: ref(t.type, t.name) }
    }
  })

  const interfaces = f.interfaces.map((i, idx) => ({
    id: interfaceIds[idx]!,
    name: i.name,
    description: i.description ?? '',
    messages: i.messages.map((m) => ({
      id: newId(),
      name: m.name,
      description: m.description ?? '',
      params: m.params.map((prm) => ({
        ...field(prm, `${i.name}.${m.name}`),
        direction: prm.direction ?? 'in'
      })),
      returns: m.returns ? ref(m.returns, `${i.name}.${m.name} returns`) : null
    }))
  }))

  const layout = f.editor?.layout ?? {}
  const modules: Module[] = []
  const moduleByPath = new Map<string, Module>()

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
    top: number
  ): { width: number; height: number } => {
    const seen = new Set<string>()
    const extent = { width: 0, height: 0 }
    let x = PAD
    let y = top + PAD
    let rowHeight = 0
    for (const fm of list) {
      const path = parentPath ? `${parentPath}.${fm.name}` : fm.name
      if (seen.has(fm.name)) problems.push(`Duplicate module '${path}'`)
      seen.add(fm.name)
      const portNames = new Set<string>()
      const mod: Module = {
        id: `module:${path}`,
        name: fm.name,
        description: fm.description ?? '',
        parentId,
        metadata: { ...(fm.metadata ?? {}) },
        ports: fm.ports.map((pt) => {
          if (portNames.has(pt.name)) problems.push(`Duplicate port '${path}:${pt.name}'`)
          portNames.add(pt.name)
          let interfaceId: Id | null = null
          if (pt.interface) {
            if (!interfaceNames.has(pt.interface))
              problems.push(`Port '${path}:${pt.name}': unknown interface '${pt.interface}'`)
            interfaceId = typeIds.get(pt.interface) ?? null
          }
          return { id: newId(), name: pt.name, role: pt.role, interfaceId, description: pt.description ?? '' }
        }),
        layout: { x: 0, y: 0, width: MODULE_WIDTH, height: leafHeight(portRows(fm)) }
      }
      modules.push(mod)
      moduleByPath.set(path, mod)

      const inner = addModules(fm.modules ?? [], mod.id, path, leafHeight(portRows(fm)))
      const style = f.editor?.style?.[path]
      const color = fm.color ?? style?.color
      if (color) mod.color = color
      if (style?.locked) mod.locked = true
      for (const pt of mod.ports) {
        const label = style?.labels?.[pt.name]
        if (label) pt.label = label
      }
      const saved = layout[path]
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
  addModules(f.modules, null, '', 0)

  // Imported modules: placed on the right of the project's modules when they have no position.
  const importNames = new Set<string>()
  let importY = PAD
  const importX =
    Math.max(0, ...modules.filter((m) => !m.parentId).map((m) => m.layout.x + m.layout.width)) + GAP_X * 2
  const imports: Import[] = (f.imports ?? []).map((i) => {
    if (importNames.has(i.name)) problems.push(`Duplicate import '${i.name}'`)
    importNames.add(i.name)
    const paths = new Set<string>()
    return {
      id: `import:${i.name}`,
      name: i.name,
      file: i.file,
      modules: i.modules.map((m) => {
        const where = `Import '${i.name}' module '${m.module}'`
        if (paths.has(m.module)) problems.push(`${where}: listed more than once`)
        paths.add(m.module)
        const portNames = new Set<string>()
        const saved = f.editor?.imports?.[i.name]?.[m.module]
        const position = saved ? { x: saved.x, y: saved.y } : { x: importX, y: importY }
        if (!saved) importY += leafHeight(portRows(m)) + GAP_Y
        return {
          id: `${IMPORTED_PREFIX}${i.name}/${m.module}`,
          path: m.module,
          position,
          ports: m.ports.map((pt) => {
            if (portNames.has(pt.name)) problems.push(`${where}: duplicate port '${pt.name}'`)
            portNames.add(pt.name)
            return {
              id: newId(),
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

  const endpoint = (e: { import?: string; module: string; port: string }, where: string) => {
    if (e.import !== undefined) {
      const imp = imports.find((i) => i.name === e.import)
      const mod = imp?.modules.find((m) => m.path === e.module)
      const port = mod?.ports.find((pt) => pt.name === e.port)
      if (!imp) problems.push(`${where}: unknown import '${e.import}'`)
      else if (!mod) problems.push(`${where}: module '${e.module}' is not listed in import '${e.import}'`)
      else if (!port) problems.push(`${where}: unknown port '${e.import}/${e.module}:${e.port}'`)
      return { moduleId: mod?.id ?? '', portId: port?.id ?? '' }
    }
    const mod = moduleByPath.get(e.module)
    const port = mod?.ports.find((pt) => pt.name === e.port)
    if (!mod) problems.push(`${where}: unknown module '${e.module}'`)
    else if (!port) problems.push(`${where}: unknown port '${e.module}:${e.port}'`)
    return { moduleId: mod?.id ?? '', portId: port?.id ?? '' }
  }
  const links: Link[] = f.links.map((l) => {
    const route = f.editor?.links?.[l.name]
    return {
      id: newId(),
      name: l.name,
      description: l.description ?? '',
      from: endpoint(l.from, `Link '${l.name}' from`),
      to: endpoint(l.to, `Link '${l.name}' to`),
      constraints: clean(l.constraints),
      ...(route ? { route: clean({ ...route, points: route.points ?? [] }) } : {})
    }
  })

  // Editor data is best effort: dangling module paths are dropped, not reported.
  const views: View[] = (f.editor?.views ?? []).flatMap((v, i) => {
    const root = v.root ? moduleByPath.get(v.root) : undefined
    if (v.root && !root) return []
    const hidden = (v.hidden ?? []).flatMap((h) => moduleByPath.get(h)?.id ?? [])
    return [{ id: `view:${i}`, name: v.name, rootModuleId: root?.id ?? null, hidden }]
  })
  const notes: Note[] = (f.editor?.notes ?? []).map((n) => ({
    id: newId(),
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
    types,
    interfaces,
    modules,
    links,
    imports,
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
    throw new LoadError([`Invalid ${format.toUpperCase()}: ${(e as Error).message}`])
  }
}

export function formatFromPath(path: string): Format {
  return path.toLowerCase().endsWith('.json') ? 'json' : 'yaml'
}

export function loadText(text: string, format: Format): Project {
  return fromFile(parseText(text, format))
}

export function saveText(p: Project, format: Format, options: { editor: boolean }): string {
  return stringify(toFile(p, options), format)
}
