// On-disk format (YAML/JSON). Source of truth for the published JSON Schema.
import { z } from 'zod'
import { INT_PRIMITIVES, PERFORMANCE_CLASSES, PRIMITIVES, type TypeRefOf } from './types'

export const SCHEMA_VERSION = 1

export type FileTypeRef = TypeRefOf<{ name: string }>

const Identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid identifier')
const QualifiedName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/, 'must be a dot-separated module path')
const Description = z.string().optional()
const Metadata = z.record(z.string(), z.string()).optional()

export const FileTypeRefSchema: z.ZodType<FileTypeRef> = z
  .lazy(() =>
    z.union([
      z.object({ kind: z.literal('primitive'), name: z.enum(PRIMITIVES) }),
      z.object({ kind: z.literal('array'), of: FileTypeRefSchema, size: z.int().positive() }),
      z.object({ kind: z.enum(['vector', 'list', 'set', 'optional']), of: FileTypeRefSchema }),
      z.object({ kind: z.literal('map'), key: FileTypeRefSchema, value: FileTypeRefSchema }),
      z.object({ kind: z.literal('ref'), name: Identifier })
    ])
  )
  .meta({ id: 'TypeRef' })

const Field = z.object({
  name: Identifier,
  type: FileTypeRefSchema,
  description: Description
})

const TypeDef = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('struct'),
    name: Identifier,
    description: Description,
    fields: z.array(Field)
  }),
  z.object({
    kind: z.literal('enum'),
    name: Identifier,
    description: Description,
    underlying: z.enum(INT_PRIMITIVES),
    values: z.array(z.object({ name: Identifier, value: z.int() }))
  }),
  z.object({
    kind: z.literal('alias'),
    name: Identifier,
    description: Description,
    type: FileTypeRefSchema
  })
])

const Message = z.object({
  name: Identifier,
  description: Description,
  params: z.array(Field),
  returns: FileTypeRefSchema.nullable()
})

const Interface = z.object({
  name: Identifier,
  description: Description,
  messages: z.array(Message)
})

const Port = z.object({
  name: Identifier,
  role: z.enum(['out', 'in']).describe('out: initiates / sends; in: receives / serves'),
  interface: Identifier.nullable(),
  description: Description
})

export interface FileModule {
  name: string
  description?: string
  metadata?: Record<string, string>
  ports: z.infer<typeof Port>[]
  modules?: FileModule[]
}

const Module: z.ZodType<FileModule> = z
  .lazy(() =>
    z.object({
      name: Identifier,
      description: Description,
      metadata: Metadata,
      ports: z.array(Port),
      modules: z.array(Module).optional()
    })
  )
  .meta({ id: 'Module' })

const Endpoint = z.object({ module: QualifiedName, port: Identifier })

const LinkConstraints = z.object({
  direction: z.enum(['unidirectional', 'bidirectional']),
  ack: z.object({ required: z.boolean(), timeoutMs: z.number().positive().optional() }),
  performance: z.object({
    class: z.enum(PERFORMANCE_CLASSES),
    maxLatencyMs: z.number().positive().optional(),
    rateHz: z.number().positive().optional()
  }),
  remote: z.object({ enabled: z.boolean(), transport: z.string().optional() })
})

const Link = z.object({
  name: Identifier,
  description: Description,
  from: Endpoint.describe('initiator side (an `out` port)'),
  to: Endpoint.describe('receiver side (an `in` port)'),
  constraints: LinkConstraints
})

const Rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })

const EditorView = z.object({
  name: z.string(),
  root: QualifiedName.optional().describe('module shown with its content; the whole project when absent'),
  hidden: z.array(QualifiedName).optional()
})

const EditorNote = z.object({
  kind: z.enum(['note', 'frame']),
  text: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  color: z.string().optional()
})

const Editor = z
  .object({
    layout: z.record(QualifiedName, Rect),
    views: z.array(EditorView).optional(),
    style: z.record(QualifiedName, z.object({ color: z.string().optional() })).optional(),
    notes: z.array(EditorNote).optional()
  })
  .describe('Editor-only data, ignored by generators')

export const FileProjectSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    project: z.object({ name: z.string(), description: Description, metadata: Metadata }),
    types: z.array(TypeDef),
    interfaces: z.array(Interface),
    modules: z.array(Module),
    links: z.array(Link),
    editor: Editor.optional()
  })
  .meta({ id: 'ScaffoldProject', title: 'ProjectScaffold architecture file' })

export type FileProject = z.infer<typeof FileProjectSchema>
export type FileTypeDef = z.infer<typeof TypeDef>
export type FileLink = z.infer<typeof Link>
export type FileEditor = z.infer<typeof Editor>
