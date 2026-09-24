import { writeFileSync } from 'node:fs'
import { z } from 'zod'
import { FileProjectSchema } from '../src/renderer/src/model/schema'

const schema = z.toJSONSchema(FileProjectSchema, { target: 'draft-2020-12', io: 'input' })
writeFileSync('schema/scaffold.schema.json', JSON.stringify(schema, null, 2) + '\n')
console.log('wrote schema/scaffold.schema.json')
