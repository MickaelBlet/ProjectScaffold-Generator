import { writeFileSync } from 'node:fs'
import { z } from 'zod'
import { FileProjectSchema } from '../src/renderer/src/model/schema'
import { FileWorkspaceSchema } from '../src/renderer/src/model/workspace'

for (const [file, schema] of [
  ['schema/scaffold.schema.json', FileProjectSchema],
  ['schema/scaffold-workspace.schema.json', FileWorkspaceSchema]
] as const) {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' })
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
  console.log(`wrote ${file}`)
}
