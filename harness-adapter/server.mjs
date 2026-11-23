import { execFileSync } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { register } from 'tsx/esm/api'

const revision = '2e39e70496aa02986ca6a820c5d497e816b69d7e'
const checkout = fileURLToPath(new URL('../deepseek-harness/', import.meta.url))
const { values } = parseArgs({ options: { root: { type: 'string' }, profile: { type: 'string', default: 'project' } } })
if (!values.root || !isAbsolute(values.root) || values.profile !== 'project') throw Error('Expected --profile project --root <absolute project directory>')
const root = await realpath(values.root)
if (!(await stat(root)).isDirectory()) throw Error('Project root must be a directory')
if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim() !== revision) throw Error('DeepSeek Harness checkout revision mismatch')
register({ tsconfig: join(checkout, 'tsconfig.json') })
const { openProfile } = await import('./profile.mjs')
const { Operations } = await import('./operations.mjs')
const operations = new Operations()
const profile = await openProfile(root, request => operations.ask(request))
const digest = value => createHash('sha256').update(value).digest()
let operator

function requireOperator(token) {
  if (typeof token !== 'string' || !timingSafeEqual(operator, digest(token))) throw Error('Operator authentication required')
}

async function dispatch(method, params) {
  if (method === 'initialize') {
    if (operator) throw Error('Adapter already initialized')
    const token = params._meta?.arenaOperatorToken
    if (typeof token !== 'string' || token.length < 32) throw Error('Private operator token required for initialization')
    operator = digest(token)
    const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
    return {
      protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
      serverInfo: { name: 'arena-harness-adapter', version: '0.1.0' }, capabilities: { tools: {} },
    }
  }
  if (!operator) throw Error('Initialize first')
  switch (method) {
    case 'ping': return {}
    case 'tools/list': return { tools: profile.tools() }
    case 'tools/call': {
      const operation = operations.start(params._meta?.arenaCallId, params.name, params.arguments ?? {}, profile)
      return { content: [{ type: 'text', text: JSON.stringify(operation) }] }
    }
    case 'arena/catalog': return profile.catalog()
    case 'arena/explicitSkill':
      requireOperator(params.token)
      return { content: await profile.explicitSkill(params.name) }
    case 'arena/status': return operations.status(params.id)
    case 'arena/decide':
      requireOperator(params.token)
      return operations.decide(params)
    default: throw Object.assign(Error('Unknown method'), { code: -32601 })
  }
}

async function respond(line) {
  let request
  try {
    request = JSON.parse(line)
    if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') throw Object.assign(Error('Invalid JSON-RPC request'), { code: -32600 })
    if (request.id === undefined) return
    const result = await dispatch(request.method, request.params ?? {})
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  } catch (error) {
    const code = error instanceof SyntaxError ? -32700 : Number.isInteger(error.code) ? error.code : -32602
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null, error: { code, message: error.message } }) + '\n')
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) await respond(line)
await operations.close()
await profile.close()
