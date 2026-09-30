// Workspace files: the project files of a large architecture, opened together. They only list the
// project files, relative to the workspace file; each project stays a file of its own.
import YAML from 'yaml'
import { z } from 'zod'
import { SCHEMA_VERSION } from './schema'
import { LoadError } from './serialize'
import { normalizeFile } from './sync'

export const WORKSPACE_SUFFIX = '.scaffold-workspace.yaml'

export const FileWorkspaceSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    workspace: z.object({ name: z.string(), description: z.string().optional() }),
    projects: z
      .array(z.string().min(1))
      .describe('project files, relative to the workspace file, opened in this order')
  })
  .meta({ id: 'ScaffoldWorkspace', title: 'ProjectScaffold workspace file' })

export interface Workspace {
  name: string
  description?: string
  /** Project files relative to the workspace file, `/` separated, without duplicates. */
  projects: string[]
}

/** Whether parsed file data is a workspace rather than a project. */
export function isWorkspaceData(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'workspace' in data && !('project' in data)
}

export function workspaceFromFile(data: unknown): Workspace {
  const parsed = FileWorkspaceSchema.safeParse(data)
  if (!parsed.success)
    throw new LoadError(
      parsed.error.issues.map((i) => ({
        message: `${i.path.join('.') || '<root>'}: ${i.message}`,
        path: i.path.filter((k) => typeof k !== 'symbol')
      }))
    )
  const { workspace, projects } = parsed.data
  return {
    name: workspace.name,
    ...(workspace.description && { description: workspace.description }),
    projects: [...new Set(projects.map(normalizeFile))]
  }
}

export function workspaceText(ws: Workspace): string {
  const file: z.input<typeof FileWorkspaceSchema> = {
    schemaVersion: SCHEMA_VERSION,
    workspace: { name: ws.name, ...(ws.description && { description: ws.description }) },
    projects: ws.projects
  }
  return YAML.stringify(file)
}
