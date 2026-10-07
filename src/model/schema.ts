// On-disk format (YAML/JSON). Source of truth for the published JSON Schema.
import { z } from 'zod'
import {
  INT_PRIMITIVES,
  MODULE_KINDS,
  PARAM_DIRECTIONS,
  PERFORMANCE_CLASSES,
  PRIMITIVES,
  UNSIGNED_PRIMITIVES,
  type TypeRefOf
} from './types'

export const SCHEMA_VERSION = 1

export type FileTypeRef = TypeRefOf<{ name: string }>

const Identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid identifier')
const QualifiedName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/, 'must be a dot-separated module path')
const Description = z.string().optional()
const Metadata = z.record(z.string(), z.string()).optional()

const Max = z.int().positive().optional()

export const FileTypeRefSchema: z.ZodType<FileTypeRef> = z
  .lazy(() =>
    z.union([
      z.object({
        kind: z.literal('primitive'),
        name: z.enum(PRIMITIVES),
        max: Max.describe('string, bytes: most UTF-8 bytes')
      }),
      z.object({ kind: z.literal('array'), of: FileTypeRefSchema, size: z.int().positive() }),
      z.object({
        kind: z.enum(['vector', 'list', 'set']),
        of: FileTypeRefSchema,
        max: Max.describe('most items')
      }),
      z.object({ kind: z.literal('optional'), of: FileTypeRefSchema }),
      z.object({
        kind: z.literal('map'),
        key: FileTypeRefSchema,
        value: FileTypeRefSchema,
        max: Max.describe('most entries')
      }),
      z.object({ kind: z.literal('ref'), name: Identifier })
    ])
  )
  .meta({ id: 'TypeRef' })

const Field = z.object({
  name: Identifier,
  type: FileTypeRefSchema,
  description: Description
})

const ValueField = Field.extend({
  default: z
    .json()
    .optional()
    .describe(
      'default value: a mapping for a struct or map, a list for an array, vector, list or set, null for an empty optional, an enum value name, a list of bitmask flag names, a one-entry mapping `case: value` for a union; any value for a custom primitive'
    )
})

const TypeDef = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('struct'),
      name: Identifier,
      description: Description,
      fields: z.array(ValueField)
    }),
    z.object({
      kind: z.literal('enum'),
      name: Identifier,
      description: Description,
      underlying: z.enum(INT_PRIMITIVES),
      values: z.array(z.object({ name: Identifier, value: z.int() }))
    }),
    z
      .object({
        kind: z.literal('exception'),
        name: Identifier,
        description: Description,
        fields: z.array(ValueField)
      })
      .describe('raised by messages and methods (their `raises`), never used as a type'),
    z
      .object({
        kind: z.literal('bitmask'),
        name: Identifier,
        description: Description,
        underlying: z.enum(UNSIGNED_PRIMITIVES),
        flags: z.array(z.object({ name: Identifier, bit: z.int().nonnegative().describe('value: 1 << bit') }))
      })
      .describe('set of flags, combined with |'),
    z
      .object({
        kind: z.literal('union'),
        name: Identifier,
        description: Description,
        discriminator: FileTypeRefSchema.describe('integer primitive, bool, char or enum'),
        cases: z.array(
          Field.extend({
            labels: z
              .array(z.union([z.int(), z.string(), z.boolean()]))
              .optional()
              .describe(
                'discriminator values selecting the case: integers, characters, booleans, enum value names'
              ),
            default: z.boolean().optional().describe('held for the discriminator values no case lists')
          })
        )
      })
      .describe('discriminated union: one of its cases, selected by the discriminator'),
    z.object({
      kind: z.literal('alias'),
      name: Identifier,
      description: Description,
      type: FileTypeRefSchema
    }),
    z
      .object({
        kind: z.literal('primitive'),
        name: Identifier,
        description: Description
      })
      .describe('custom primitive: an opaque type that generators map to a native type')
  ])
  .meta({ id: 'TypeDef' })

const Param = Field.extend({
  direction: z
    .enum(PARAM_DIRECTIONS)
    .optional()
    .describe('in (default): caller → callee; out: callee → caller; inout: both ways')
})

const Message = z.object({
  name: Identifier,
  description: Description,
  params: z.array(Param),
  returns: FileTypeRefSchema.nullable(),
  raises: z.array(Identifier).optional().describe('exceptions it may raise (names of exception types)')
})

const Attribute = ValueField.extend({
  static: z.boolean().optional().describe('shared by all instances of the module'),
  const: z.boolean().optional().describe('not changed after initialization')
})

const MethodParam = Param.extend({
  const: z.boolean().optional().describe('not changed by the method (in parameters only)')
})

const Method = Message.extend({
  params: z.array(MethodParam),
  static: z.boolean().optional().describe('called without a module instance'),
  const: z.boolean().optional().describe("leaves the module's state unchanged"),
  virtual: z.boolean().optional().describe('can be overridden by derived modules'),
  pure: z
    .boolean()
    .optional()
    .describe('pure virtual (`= 0`): not implemented by this module (virtual only)'),
  override: z.boolean().optional().describe('overrides a virtual method of a base module (virtual only)')
})

const Interface = z
  .object({
    name: Identifier,
    description: Description,
    messages: z.array(Message)
  })
  .meta({ id: 'Interface' })

const Port = z.object({
  name: Identifier,
  role: z.enum(['out', 'in']).describe('out: initiates / sends; in: receives / serves'),
  interface: Identifier.nullable(),
  description: Description
})

export interface FileModule {
  name: string
  description?: string
  kind?: (typeof MODULE_KINDS)[number]
  bases?: string[]
  metadata?: Record<string, string>
  color?: string
  binary?: string
  attributes?: z.infer<typeof Attribute>[]
  methods?: FileMethod[]
  ports: z.infer<typeof Port>[]
  modules?: FileModule[]
}

const Module: z.ZodType<FileModule> = z
  .lazy(() =>
    z.object({
      name: Identifier,
      description: Description,
      kind: z
        .enum(MODULE_KINDS)
        .optional()
        .describe(
          'class (default): concrete; abstract: may have pure methods; interface: only pure methods, no attributes'
        ),
      bases: z
        .array(QualifiedName)
        .optional()
        .describe('paths of the modules of this project it derives from, in order'),
      metadata: Metadata,
      color: z.string().optional().describe('accent color (CSS color)'),
      binary: Identifier.optional().describe(
        "name of the binary (`binaries`) it runs in: top-level modules only, inner ones run in their ancestor's"
      ),
      attributes: z.array(Attribute).optional().describe('typed properties of the module'),
      methods: z.array(Method).optional().describe('method prototypes of the module'),
      ports: z.array(Port),
      modules: z.array(Module).optional()
    })
  )
  .meta({ id: 'Module' })

const Binary = z
  .object({
    name: Identifier,
    description: Description,
    color: z.string().optional().describe('accent color (CSS color)')
  })
  .describe('An executable of the project, holding some of its top-level modules')

const Endpoint = z.object({
  project: Identifier.optional().describe('name of a dependency: the module belongs to that other project'),
  module: QualifiedName,
  port: Identifier
})

const Constant = z
  .object({
    name: Identifier,
    description: Description,
    type: FileTypeRefSchema,
    value: z.json().describe('checked against the type, as default values are')
  })
  .meta({ id: 'Constant' })

const Dependency = z
  .object({
    name: Identifier.describe('referenced by `uses` of other dependencies and by link endpoints (`project`)'),
    file: z.string().describe('file of the other project (project file or IDL file), relative to this one'),
    uses: z
      .array(Identifier)
      .optional()
      .describe('dependencies of this list whose types and interfaces this one uses'),
    indirect: z.boolean().optional().describe('only listed because another dependency uses it'),
    shared: z
      .array(Identifier)
      .optional()
      .describe(
        'types, interfaces and constants it defines like another dependency of this list, listed there'
      ),
    types: z.array(TypeDef).describe('its own types, as last read from it'),
    interfaces: z.array(Interface).describe('its own interfaces, as last read from it'),
    constants: z.array(Constant).optional().describe('its own constants, as last read from it'),
    modules: z
      .array(z.object({ module: QualifiedName, ports: z.array(Port) }))
      .optional()
      .describe('its modules placed on this canvas so that links reach them, with their ports as last read')
  })
  .describe(
    "Another project this one uses: its types and interfaces share the namespace of the project's own ones, which reference them by name, and links may reach its modules"
  )

const Host = z.string().min(1)
const NetPort = z.int().min(1).max(65535)
const HostPort = z.object({ host: Host.optional(), port: NetPort.optional() })

const TransportSettings = z
  .object({
    client: HostPort.optional().describe('where the caller connects (tcp, udp, http, websocket, grpc)'),
    server: HostPort.optional().describe('where the callee listens (tcp, udp, http, websocket, grpc)'),
    path: z.string().min(1).optional().describe('request path (http, websocket; default /<link>)'),
    name: z.string().min(1).optional().describe('shared memory segment (shm; default <project>_<link>)'),
    capacity: z.int().positive().optional().describe('bytes of each ring (shm; default 1048576)'),
    socket: z.string().min(1).optional().describe('unix socket path (ipc)'),
    broker: HostPort.optional().describe('broker (mqtt)'),
    topic: z.string().min(1).optional().describe('topic (mqtt)'),
    interface: z.string().min(1).optional().describe('network interface (can)'),
    id: z.int().nonnegative().optional().describe('frame id (can)'),
    device: z.string().min(1).optional().describe('device path (serial)'),
    baud: z.int().positive().optional().describe('baud rate (serial)'),
    options: z.record(z.string(), z.string()).optional().describe('free settings, for any transport')
  })
  .meta({ id: 'TransportSettings' })

const RemoteDefaults = z
  .object({
    client: z.object({ host: Host.optional() }).optional().describe('host the callers connect to'),
    server: z.object({ host: Host.optional() }).optional().describe('host the callees listen on'),
    basePort: NetPort.optional().describe(
      'port of the first remote link, the next ones following (default 47000)'
    )
  })
  .describe('defaults of the addresses of the remote links (default host 127.0.0.1)')

const LinkConstraints = z.object({
  direction: z.enum(['unidirectional', 'bidirectional']),
  ack: z.object({ required: z.boolean(), timeoutMs: z.number().positive().optional() }),
  performance: z.object({
    class: z.enum(PERFORMANCE_CLASSES),
    maxLatencyMs: z.number().positive().optional(),
    rateHz: z.number().positive().optional()
  }),
  remote: z.object({
    enabled: z.boolean(),
    transport: z.string().optional(),
    settings: TransportSettings.optional().describe(
      'settings of the transport; the fields that apply depend on it'
    )
  })
})

const Link = z.object({
  name: Identifier,
  description: Description,
  from: Endpoint.describe(
    "initiator side (an `out` port; a container's `in` port into its content, an inner `out` port out of it)"
  ),
  to: Endpoint.describe(
    "receiver side (an `in` port; an inner `in` port from its container, the container's `out` port from its content)"
  ),
  constraints: LinkConstraints
})

const Rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })

const EditorView = z.object({
  name: z.string(),
  root: QualifiedName.optional().describe('module shown with its content; the whole project when absent'),
  hidden: z.array(QualifiedName).optional(),
  layout: z
    .record(QualifiedName, Rect)
    .optional()
    .describe('rects of modules in this view (parent-relative), in place of their `layout` entries')
})

const EditorNote = z.object({
  kind: z.enum(['note', 'frame']),
  text: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  color: z.string().optional(),
  locked: z.boolean().optional()
})

const Side = z.enum(['left', 'right', 'top', 'bottom'])

const Anchor = z.object({
  side: Side,
  at: z.number().min(0).max(1).describe('position along the side: 0 left / top, 1 right / bottom')
})

const PortLabels = z
  .record(Identifier, Side)
  .optional()
  .describe("direction from each port's handle where its name is drawn, by port name")

const EditorLink = z.object({
  points: z
    .array(z.object({ x: z.number(), y: z.number() }))
    .optional()
    .describe('bend points, relative to the innermost module holding both ends (absolute at the top level)'),
  from: Anchor.optional().describe('attachment of the source end on its module'),
  to: Anchor.optional().describe('attachment of the target end on its module'),
  label: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('where the badges sit along the link: 0 source, 1 target (default: the middle)')
})

const Editor = z
  .object({
    layout: z.record(QualifiedName, Rect),
    views: z.array(EditorView).optional(),
    style: z
      .record(
        QualifiedName,
        z.object({
          color: z.string().optional().describe('deprecated: use the module `color`'),
          locked: z.boolean().optional(),
          labels: PortLabels
        })
      )
      .optional(),
    notes: z.array(EditorNote).optional(),
    dependencies: z
      .record(
        Identifier,
        z.record(
          QualifiedName,
          z.object({
            x: z.number(),
            y: z.number(),
            width: z.number().optional(),
            height: z.number().optional(),
            labels: PortLabels
          })
        )
      )
      .optional()
      .describe(
        'canvas position and size of the placed modules of dependencies, by dependency and module path'
      ),
    orientation: z
      .enum(['horizontal', 'vertical'])
      .optional()
      .describe('port placement: in left / out right (default), or in top / out bottom'),
    links: z.record(Identifier, EditorLink).optional().describe('hand-set link shapes, by link name')
  })
  .describe('Editor-only data, ignored by generators')

export const FileProjectSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    project: z.object({ name: z.string(), description: Description, metadata: Metadata }),
    generation: z
      .object({
        templates: z
          .string()
          .min(1)
          .optional()
          .describe(
            'built-in template set generating the code (cpp17 by default): cpp98, cpp11, cpp14, cpp17, cpp20, python, sca-cpp98'
          )
      })
      .optional()
      .describe('code generation settings'),
    transports: z
      .array(z.string().min(1))
      .optional()
      .describe('custom transports offered for remote links, besides the built-in ones'),
    remoteDefaults: RemoteDefaults.optional(),
    binaries: z
      .array(Binary)
      .optional()
      .describe(
        'executables the top-level modules are split into (each names its own); links between two of them must be remote'
      ),
    types: z.array(TypeDef),
    interfaces: z.array(Interface),
    constants: z
      .array(Constant)
      .optional()
      .describe('named values; their names share the namespace of the types and interfaces'),
    modules: z.array(Module),
    links: z.array(Link),
    dependencies: z.array(Dependency).optional(),
    editor: Editor.optional()
  })
  .meta({ id: 'ScaffoldProject', title: 'ProjectScaffold architecture file' })

export type FileProject = z.infer<typeof FileProjectSchema>
export type FileTypeDef = z.infer<typeof TypeDef>
export type FileMessage = z.infer<typeof Message>
export type FileInterface = z.infer<typeof Interface>
export type FileMethod = z.infer<typeof Method>
export type FileLink = z.infer<typeof Link>
export type FileEditor = z.infer<typeof Editor>
export type FileDependency = z.infer<typeof Dependency>
export type FileConstant = z.infer<typeof Constant>
