// Template sets: a `manifest.yaml` listing the files to generate, and Liquid templates.
import YAML from 'yaml'
import { z } from 'zod'

export const MANIFEST = 'manifest.yaml'

const Output = z.object({
  template: z.string().min(1).describe('template file, relative to the manifest'),
  path: z
    .string()
    .min(1)
    .describe('Liquid template of the generated file path, relative to the output directory'),
  each: z
    .string()
    .optional()
    .describe('Liquid expression of a list: one file per item (e.g. `modules`), bound to `as`'),
  as: z.string().default('item'),
  when: z.string().optional().describe('Liquid condition: the file is generated only when it holds'),
  comment: z.string().optional().describe('line comment starting the user section markers of this output')
})

export const ManifestSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  reserved: z
    .union([z.array(z.string()), z.string().transform((s) => s.split(/\s+/).filter(Boolean))])
    .default([])
    .describe(
      'reserved words of the target language (a list, or words separated by spaces): names of the project among them are warned about'
    ),
  comment: z.string().default('//').describe('line comment starting the user section markers'),
  trimTagLines: z
    .boolean()
    .default(true)
    .describe('lines holding only a `{% tag %}` (other than `user`) leave no line nor indentation'),
  squeezeBlankLines: z.boolean().default(true).describe('collapse runs of blank lines into one'),
  partials: z
    .array(z.string())
    .optional()
    .describe('templates only used by `render` / `include`, which name them without `.liquid`'),
  outputs: z.array(Output)
})

export type Manifest = z.infer<typeof ManifestSchema>
export type ManifestOutput = Manifest['outputs'][number]

export interface TemplateSet {
  manifest: Manifest
  /** Templates by path relative to the manifest. */
  files: Record<string, string>
}

export class TemplateSetError extends Error {}

export function parseManifest(text: string): Manifest {
  const r = ManifestSchema.safeParse(YAML.parse(text))
  if (!r.success)
    throw new TemplateSetError(
      `${MANIFEST}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`
    )
  return r.data
}

/** Files a template set is made of, besides its manifest. */
export const templateFiles = (m: Manifest): string[] => [
  ...new Set([...m.outputs.map((o) => o.template), ...(m.partials ?? [])])
]

/** Reads a template set through `read` (relative paths); missing templates are errors. */
export async function loadTemplateSet(read: (path: string) => Promise<string | null>): Promise<TemplateSet> {
  const text = await read(MANIFEST)
  if (text === null) throw new TemplateSetError(`${MANIFEST} not found`)
  const manifest = parseManifest(text)
  const files: Record<string, string> = {}
  for (const f of templateFiles(manifest)) {
    const content = await read(f)
    if (content === null) throw new TemplateSetError(`template '${f}' not found`)
    files[f] = content
  }
  return { manifest, files }
}
