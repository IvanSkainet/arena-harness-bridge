import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export class Operations {
  #entries = new Map()
  #lifetime = new AbortController()

  start(id, tool, args, profile) {
    if (typeof id !== 'string' || !id.length || id.length > 256) throw Error('Stable arenaCallId required')
    if (!profile.tools().some(def => def.name === tool)) throw Error('Tool unavailable in bound profile')
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('Expected an argument object')
    const existing = this.#entries.get(id)
    if (existing) {
      if (tool !== existing.snapshot.tool || !isDeepStrictEqual(existing.args, args)) throw Error('Operation ID already belongs to another request')
      return existing.snapshot
    }
    const entry = { snapshot: { id, tool, state: 'running' }, args }
    this.#entries.set(id, entry)
    entry.done = this.#execute(entry, profile)
    return entry.snapshot
  }

  async #execute(entry, profile) {
    const { id, tool } = entry.snapshot
    try {
      const result = await profile.execute(id, tool, entry.args, this.#lifetime.signal)
      const code = result.error?.info?.code
      let state = 'succeeded'
      if (result.isError) state = ['APPROVAL_REJECTED', 'APPROVAL_CANCELLED', 'PERMISSION_DENIED'].includes(code) ? 'denied' : 'failed'
      entry.snapshot = { id, tool, state, content: result.content }
    } catch (error) {
      entry.snapshot = { id, tool, state: 'failed', content: [{ type: 'text', text: error.message }] }
    } finally {
      delete entry.answer
    }
  }

  status(id) {
    const entry = this.#entries.get(id)
    if (!entry) throw Error('Unknown operation in this session')
    return entry.snapshot
  }

  ask(request) {
    const entry = this.#entries.get(request.callId)
    if (!entry || entry.snapshot.state !== 'running' || this.#lifetime.signal.aborted) return 'unavailable'
    const approval = { id: randomUUID(), detail: request.reason }
    entry.snapshot = { ...entry.snapshot, state: 'approval', approval }
    return new Promise(resolve => { entry.answer = resolve })
  }

  decide({ id, approvalId, allow }) {
    const entry = this.#entries.get(id)
    if (typeof allow !== 'boolean' || !entry?.answer || entry.snapshot.approval.id !== approvalId) throw Error('No matching pending approval')
    const answer = entry.answer
    delete entry.answer
    entry.snapshot = { id, tool: entry.snapshot.tool, state: 'running' }
    answer(allow ? 'allowed-once' : 'rejected')
    return entry.snapshot
  }

  async close() {
    this.#lifetime.abort()
    for (const entry of this.#entries.values()) entry.answer?.('cancelled')
    await Promise.allSettled(Array.from(this.#entries.values(), entry => entry.done))
  }
}
