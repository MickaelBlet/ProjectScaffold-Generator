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

export type TypeDef = StructDef | EnumDef | AliasDef

export interface Message {
  id: Id
  name: string
  description: string
  params: Field[]
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
  /** Editor-only accent color (CSS color). */
  color?: string
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
  moduleId: Id
  portId: Id
}

export interface Link {
  id: Id
  name: string
  description: string
  from: Endpoint
  to: Endpoint
  constraints: LinkConstraints
}

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
}

export interface Project {
  name: string
  description: string
  metadata: Metadata
  types: TypeDef[]
  interfaces: Interface[]
  modules: Module[]
  links: Link[]
  views: View[]
  notes: Note[]
}
