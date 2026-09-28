// Core model types. The in-memory project references entities by id; the file
// format (see schema.ts) references them by (qualified) name.

export const INT_PRIMITIVES = [
  'int8',
  'int16',
  'int32',
  'int64',
  'uint8',
  'uint16',
  'uint32',
  'uint64'
] as const
export const PRIMITIVES = [
  'bool',
  'char',
  ...INT_PRIMITIVES,
  'float32',
  'float64',
  'string',
  'bytes'
] as const
export const CONTAINERS = ['array', 'vector', 'list', 'set', 'optional', 'map'] as const

export type Primitive = (typeof PRIMITIVES)[number]
export type IntPrimitive = (typeof INT_PRIMITIVES)[number]
export type Container = (typeof CONTAINERS)[number]

export const INT_RANGES: Record<IntPrimitive, [bigint, bigint]> = {
  int8: [-(2n ** 7n), 2n ** 7n - 1n],
  int16: [-(2n ** 15n), 2n ** 15n - 1n],
  int32: [-(2n ** 31n), 2n ** 31n - 1n],
  int64: [-(2n ** 63n), 2n ** 63n - 1n],
  uint8: [0n, 2n ** 8n - 1n],
  uint16: [0n, 2n ** 16n - 1n],
  uint32: [0n, 2n ** 32n - 1n],
  uint64: [0n, 2n ** 64n - 1n]
}

/** Type reference, parameterised by how user types are referenced (`{id}` in memory, `{name}` on disk). */
export type TypeRefOf<R> =
  | { kind: 'primitive'; name: Primitive }
  | { kind: 'array'; of: TypeRefOf<R>; size: number }
  | { kind: 'vector' | 'list' | 'set' | 'optional'; of: TypeRefOf<R> }
  | { kind: 'map'; key: TypeRefOf<R>; value: TypeRefOf<R> }
  | ({ kind: 'ref' } & R)

export type TypeRef = TypeRefOf<{ id: string }>

export type Id = string
export type Metadata = Record<string, string>

export interface Field {
  id: Id
  name: string
  type: TypeRef
  description: string
}

export interface StructDef {
  id: Id
  kind: 'struct'
  name: string
  description: string
  fields: Field[]
}

export interface EnumValue {
  id: Id
  name: string
  value: number
}

export interface EnumDef {
  id: Id
  kind: 'enum'
  name: string
  description: string
  underlying: IntPrimitive
  values: EnumValue[]
}

export interface AliasDef {
  id: Id
  kind: 'alias'
  name: string
  description: string
  type: TypeRef
}

/** Custom primitive: an opaque type that generators map to a native type. */
export interface PrimitiveDef {
  id: Id
  kind: 'primitive'
  name: string
  description: string
}

export type TypeDef = StructDef | EnumDef | AliasDef | PrimitiveDef

export const PARAM_DIRECTIONS = ['in', 'out', 'inout'] as const
/** `in`: caller → callee. `out`: callee → caller. `inout`: both ways. */
export type ParamDirection = (typeof PARAM_DIRECTIONS)[number]

export interface Param extends Field {
  direction: ParamDirection
}

export interface Message {
  id: Id
  name: string
  description: string
  params: Param[]
  returns: TypeRef | null
}

export interface Interface {
  id: Id
  name: string
  description: string
  messages: Message[]
}

/** `out`: initiates / sends. `in`: receives / serves. */
export type PortRole = 'out' | 'in'

export interface Port {
  id: Id
  name: string
  role: PortRole
  interfaceId: Id | null
  description: string
  /** Editor-only: direction from the port's handle where its name is drawn (default: see PortPoint). */
  label?: Side
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Module {
  id: Id
  name: string
  description: string
  parentId: Id | null
  metadata: Metadata
  ports: Port[]
  /** Editor layout, position relative to parent. */
  layout: Rect
  /** Accent color (CSS color). */
  color?: string
  /** Editor-only: position and size are fixed on the canvas. */
  locked?: boolean
}

export const PERFORMANCE_CLASSES = ['realtime', 'low', 'normal', 'bulk'] as const
export type PerformanceClass = (typeof PERFORMANCE_CLASSES)[number]
export const TRANSPORTS = [
  'ipc',
  'shm',
  'tcp',
  'udp',
  'http',
  'grpc',
  'websocket',
  'mqtt',
  'can',
  'serial'
] as const

export interface LinkConstraints {
  direction: 'unidirectional' | 'bidirectional'
  ack: { required: boolean; timeoutMs?: number }
  performance: { class: PerformanceClass; maxLatencyMs?: number; rateHz?: number }
  remote: { enabled: boolean; transport?: string }
}

export interface Endpoint {
  /** A module of this project, or an imported module (see `Import`). */
  moduleId: Id
  portId: Id
}

export type Side = 'left' | 'right' | 'top' | 'bottom'

/** Editor-only: where a link end attaches on its module's border. */
export interface LinkAnchor {
  side: Side
  /** Position along the side, 0 to 1 (left to right, top to bottom). */
  at: number
}

/** Editor-only shape of a link, set by hand. */
export interface LinkRoute {
  /** Bend points, relative to the innermost module holding both ends (absolute at the top level). */
  points: { x: number; y: number }[]
  from?: LinkAnchor
  to?: LinkAnchor
}

export interface Link {
  id: Id
  name: string
  description: string
  from: Endpoint
  to: Endpoint
  constraints: LinkConstraints
  route?: LinkRoute
}

/**
 * Editor-only port placement of a document: `horizontal` puts `in` ports on the left and `out`
 * ports on the right (links flow right), `vertical` puts them on the top and bottom edges (links
 * flow down).
 */
export type Orientation = 'horizontal' | 'vertical'

/** Editor-only diagram view: the whole project or the inside of one module, minus hidden modules. */
export interface View {
  id: Id
  name: string
  /** Module shown with its content (drill-down); null for the whole project. */
  rootModuleId: Id | null
  /** Modules hidden in this view, with their content. */
  hidden: Id[]
}

/** Id of the implicit view showing the whole project. */
export const GLOBAL_VIEW = 'global'

/** Editor-only canvas annotation: a sticky note or a titled frame drawn behind modules. */
export interface Note {
  id: Id
  kind: 'note' | 'frame'
  text: string
  /** Absolute canvas position. */
  layout: Rect
  color?: string
  /** Position and size are fixed on the canvas. */
  locked?: boolean
}

/** Port of a module of another project, as last read from it. */
export interface ImportedPort {
  id: Id
  name: string
  role: PortRole
  /** Interface name in the other project; matched by name with this project's interfaces. */
  interface: string | null
  description: string
  /** Editor-only: direction from the port's handle where its name is drawn (default: see PortPoint). */
  label?: Side
}

/** Module of another project placed on this one's canvas, so that links can reach its ports. */
export interface ImportedModule {
  id: Id
  /** Qualified module path in the other project. */
  path: string
  ports: ImportedPort[]
  /** Editor-only absolute canvas position. */
  position: { x: number; y: number }
}

/** Another project whose modules this one links to. */
export interface Import {
  id: Id
  /** Identifier used by link endpoints (`import`). */
  name: string
  /** File of the other project, relative to this one. */
  file: string
  modules: ImportedModule[]
}

export interface Project {
  name: string
  description: string
  metadata: Metadata
  /** Transports offered for remote links, besides `TRANSPORTS`. */
  transports: string[]
  types: TypeDef[]
  interfaces: Interface[]
  modules: Module[]
  links: Link[]
  imports: Import[]
  views: View[]
  notes: Note[]
  orientation: Orientation
}
