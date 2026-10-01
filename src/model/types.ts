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
export const UNSIGNED_PRIMITIVES = ['uint8', 'uint16', 'uint32', 'uint64'] as const
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
export type UnsignedPrimitive = (typeof UNSIGNED_PRIMITIVES)[number]
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

/** Primitives that may be bounded (`string<16>`). */
export const BOUNDED_PRIMITIVES = ['string', 'bytes'] as const

/**
 * Type reference, parameterised by how user types are referenced (`{id}` in memory, `{name}` on disk).
 * `max`: bound of a string or bytes (UTF-8 bytes), or of the items of a vector, list, set or map;
 * `M` lets generators write null for none.
 */
export type TypeRefOf<R, M = number> =
  | { kind: 'primitive'; name: Primitive; max?: M }
  | { kind: 'array'; of: TypeRefOf<R, M>; size: number }
  | { kind: 'vector' | 'list' | 'set'; of: TypeRefOf<R, M>; max?: M }
  | { kind: 'optional'; of: TypeRefOf<R, M> }
  | { kind: 'map'; key: TypeRefOf<R, M>; value: TypeRefOf<R, M>; max?: M }
  | ({ kind: 'ref' } & R)

export type TypeRef = TypeRefOf<{ id: string }>

export type Id = string
export type Metadata = Record<string, string>
/** Plain data value, as in YAML / JSON. */
export type Value = null | boolean | number | string | Value[] | { [key: string]: Value }

export interface Field {
  id: Id
  name: string
  type: TypeRef
  description: string
}

/** Field with a default value: struct field or module attribute. */
export interface ValueField extends Field {
  /**
   * Default value, checked against the type (see defaults.ts): a mapping for a struct or map, a
   * list for an array, vector, list or set, null for an empty optional. Opaque for custom primitives.
   */
  default?: Value
}

/** Owner of a type or interface: absent for the project's own ones. */
export interface Owned {
  /** Dependency the entity comes from (read-only here, refreshed from that file). */
  dependency?: Id
}

export interface StructDef extends Owned {
  id: Id
  kind: 'struct'
  name: string
  description: string
  fields: ValueField[]
}

export interface EnumValue {
  id: Id
  name: string
  value: number
}

export interface EnumDef extends Owned {
  id: Id
  kind: 'enum'
  name: string
  description: string
  underlying: IntPrimitive
  values: EnumValue[]
}

export interface BitmaskFlag {
  id: Id
  name: string
  /** Position of the flag: value `1 << bit`. */
  bit: number
}

/** Set of flags, combined with `|`. */
export interface BitmaskDef extends Owned {
  id: Id
  kind: 'bitmask'
  name: string
  description: string
  underlying: UnsignedPrimitive
  flags: BitmaskFlag[]
}

/** Exception: raised by messages and methods (their `raises`), never used as a type. */
export interface ExceptionDef extends Owned {
  id: Id
  kind: 'exception'
  name: string
  description: string
  fields: ValueField[]
}

/** Case of a union: held when the discriminator is one of its labels (or none's, for the default case). */
export interface UnionCase extends Field {
  /** Discriminator values selecting it: integers, characters, booleans or enum value names. */
  labels: Value[]
  /** Held for the discriminator values no case lists. */
  isDefault: boolean
}

/** Discriminated union: one of its cases, selected by the discriminator. */
export interface UnionDef extends Owned {
  id: Id
  kind: 'union'
  name: string
  description: string
  /** Integer primitive, bool, char or enum (or an alias of one). */
  discriminator: TypeRef
  cases: UnionCase[]
}

export interface AliasDef extends Owned {
  id: Id
  kind: 'alias'
  name: string
  description: string
  type: TypeRef
}

/** Custom primitive: an opaque type that generators map to a native type. */
export interface PrimitiveDef extends Owned {
  id: Id
  kind: 'primitive'
  name: string
  description: string
}

export type TypeDef = StructDef | EnumDef | BitmaskDef | UnionDef | ExceptionDef | AliasDef | PrimitiveDef

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
  /** Exceptions (ids of exception types) it may raise; absent: none. */
  raises?: Id[]
}

/** C++-like qualifiers of module attributes and method parameters. */
export const QUALIFIERS = ['static', 'const'] as const
/** C++-like qualifiers of module methods: `pure` is `= 0`. */
export const METHOD_QUALIFIERS = ['static', 'const', 'virtual', 'pure', 'override'] as const
export type Qualifier = (typeof METHOD_QUALIFIERS)[number]

/** Module attribute: a value field with C++-like qualifiers. */
export interface Attribute extends ValueField {
  /** Shared by all instances of the module. */
  static?: boolean
  /** Not changed after initialization. */
  const?: boolean
}

/** Parameter of a module method. */
export interface MethodParam extends Param {
  /** Not changed by the method (`in` parameters only). */
  const?: boolean
}

/** Method prototype of a module: a message with C++-like qualifiers. */
export interface Method extends Message {
  params: MethodParam[]
  /** Called without a module instance. */
  static?: boolean
  /** Leaves the module's state unchanged. */
  const?: boolean
  /** Can be overridden by derived modules. */
  virtual?: boolean
  /** Pure virtual (`= 0`): no implementation here (virtual only). */
  pure?: boolean
  /** Overrides a virtual method of a base module (virtual only). */
  override?: boolean
}

/**
 * C++-like kind of a module: `class` (default) is concrete, `abstract` may have pure methods,
 * `interface` has only pure methods and no attributes.
 */
export const MODULE_KINDS = ['class', 'abstract', 'interface'] as const
export type ModuleKind = (typeof MODULE_KINDS)[number]

export interface Interface extends Owned {
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
  /** Absent for a concrete class. */
  kind?: Exclude<ModuleKind, 'class'>
  /** Modules this one derives from, in order. */
  bases?: Id[]
  metadata: Metadata
  /** Typed properties of the module, shown on the canvas apart from its ports. */
  attributes: Attribute[]
  /** Method prototypes of the module, shown on the canvas below its attributes. */
  methods: Method[]
  ports: Port[]
  /** Editor layout, position relative to parent. */
  layout: Rect
  /** Accent color (CSS color). */
  color?: string
  /** Binary (`Project.binaries`) it runs in: top-level modules only, inner ones run in their ancestor's. */
  binaryId?: Id
  /** Editor-only: position and size are fixed on the canvas. */
  locked?: boolean
}

/** An executable of the project: top-level modules run in one each, links between two are remote. */
export interface Binary {
  id: Id
  name: string
  description: string
  /** Accent color (CSS color). */
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
export type Transport = (typeof TRANSPORTS)[number]

/** Network end: host name or address, and port. */
export interface HostPort {
  host?: string
  port?: number
}

/** Settings of a link's transport; the fields that apply depend on it (see `transports.ts`). */
export interface TransportSettings {
  /** Where the caller connects (tcp, udp, http, websocket, grpc). */
  client?: HostPort
  /** Where the callee listens (tcp, udp, http, websocket, grpc). */
  server?: HostPort
  /** Request path (http, websocket). */
  path?: string
  /** Shared memory segment (shm). */
  name?: string
  /** Bytes of each ring (shm). */
  capacity?: number
  /** Unix socket path (ipc). */
  socket?: string
  /** Broker (mqtt). */
  broker?: HostPort
  topic?: string
  /** Network interface (can). */
  interface?: string
  /** Frame id (can). */
  id?: number
  /** Device path (serial). */
  device?: string
  baud?: number
  /** Free settings, for any transport. */
  options?: Record<string, string>
}

/** Defaults of the addresses of the remote links. */
export interface RemoteDefaults {
  client?: { host?: string }
  server?: { host?: string }
  /** Port of the first remote link; the next ones follow. */
  basePort?: number
}

export interface LinkConstraints {
  direction: 'unidirectional' | 'bidirectional'
  ack: { required: boolean; timeoutMs?: number }
  performance: { class: PerformanceClass; maxLatencyMs?: number; rateHz?: number }
  remote: { enabled: boolean; transport?: string; settings?: TransportSettings }
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
  /** Opened from a module and not stored in the project until kept. */
  temporary?: true
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
  /** Editor-only size set by hand; else from its ports. */
  size?: { width: number; height: number }
}

/**
 * Another project file this one uses: its types and interfaces are kept in the project's `types`
 * and `interfaces` with `dependency` set, as last read from the file (read-only here, one
 * namespace), and some of its modules may be placed on the canvas so that links reach them.
 */
/** Named constant: a value of a type. */
export interface ConstDef extends Owned {
  id: Id
  name: string
  description: string
  type: TypeRef
  /** Checked against the type, as default values are (see defaults.ts). */
  value: Value
}

export interface Dependency {
  id: Id
  /** Identifier naming the dependency in `uses` and link ends. */
  name: string
  /** File of the other project, relative to this one. */
  file: string
  /** Names of the dependencies (of this project's list) whose types and interfaces this one uses. */
  uses: string[]
  /** Only here because another dependency uses it. */
  indirect: boolean
  /** Names of the types, interfaces and constants it defines like another dependency, which holds them here. */
  shared: string[]
  /** Its modules placed on this project's canvas. */
  modules: ImportedModule[]
}

export interface Project {
  name: string
  description: string
  metadata: Metadata
  /** Transports offered for remote links, besides `TRANSPORTS`. */
  transports: string[]
  /** Defaults of the addresses of the remote links. */
  remoteDefaults?: RemoteDefaults
  /** Executables the top-level modules are split into; none: one binary holding everything. */
  binaries: Binary[]
  types: TypeDef[]
  interfaces: Interface[]
  /** Named constants; their names share the namespace of the types and interfaces. */
  consts: ConstDef[]
  modules: Module[]
  links: Link[]
  dependencies: Dependency[]
  views: View[]
  notes: Note[]
  orientation: Orientation
}
