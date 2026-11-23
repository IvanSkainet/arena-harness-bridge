import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { crc32 } from 'node:zlib'
import sharp from 'sharp'

const entry = fileURLToPath(new URL('../server.mjs', import.meta.url))
const operator = randomUUID()

function connect(root) {
  const child = spawn(process.execPath, [entry, '--profile', 'project', '--root', root], { windowsHide: true })
  let seq = 0
  let diagnostics = ''
  const inFlight = new Map()
  child.stderr.on('data', chunk => { diagnostics += chunk })
  createInterface({ input: child.stdout }).on('line', line => {
    const reply = JSON.parse(line)
    const pending = inFlight.get(reply.id)
    inFlight.delete(reply.id)
    if (!pending) throw new Error('unrecognized JSON-RPC reply')
    if (reply.error) pending.reject(new Error(reply.error.message))
    else pending.resolve(reply.result)
  })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    for (const item of inFlight.values()) item.reject(new Error(`adapter exited ${code ?? signal}: ${diagnostics}`))
    resolve(code)
  }))
  function rpc(method, params = {}) {
    const id = ++seq
    const reply = Promise.withResolvers()
    inFlight.set(id, reply)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return reply.promise
  }
  const call = async (id, name, args) => {
    const result = await rpc('tools/call', { name, arguments: args, _meta: { arenaCallId: id } })
    if (result.isError) throw Error(result.content[0].text)
    return JSON.parse(result.content[0].text)
  }
  async function wait(id, states) {
    for (let i = 0; i < 350; ++i) {
      const operation = await rpc('arena/status', { id })
      if (states.includes(operation.state)) return operation
      if (['failed', 'succeeded', 'denied'].includes(operation.state)) assert.fail(JSON.stringify(operation))
      await delay(25)
    }
    assert.fail('operation did not reach ' + states.join('/'))
  }
  return { rpc, call, wait, close: async () => { child.stdin.end(); await exited } }
}

test('project profile over private MCP stdio', { timeout: 150000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'arena-harness-'))
  const root = join(dir, 'project')
  await mkdir(root)
  await writeFile(join(root, 'sample.txt'), 'before\n')
  await writeFile(join(dir, 'outside.txt'), 'private-label')
  await symlink(dir, join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(root, join(dir, 'alias-back'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const [name, policy] of [['shared', ''], ['manual', 'disable-model-invocation: true'], ['automatic', 'user-invocable: false']]) {
    const path = join(root, '.agents', 'skills', name, 'SKILL.md')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `---\nname: ${name}\ndescription: Description for ${name}\n${policy}\n---\nbody-marker-${name}\n`)
  }
  await writeFile(join(root, 'project.test.mjs'), "import test from 'node:test'; test('marker-for-real-test', () => {})\n")
  const { rpc, call, wait, close } = connect(root)
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }) })
  const hello = { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offline', version: '1' }, _meta: { arenaOperatorToken: operator } }
  assert.equal((await rpc('initialize', hello)).protocolVersion, '2024-11-05')
  await assert.rejects(rpc('initialize', { ...hello, _meta: { arenaOperatorToken: randomUUID() } }))

  await t.test('exposes the profile registry and only eligible skill summaries', async () => {
    const { tools } = await rpc('tools/list')
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['edit', 'project_test', 'read', 'read_image', 'skill'])
    assert.deepEqual(tools.find(tool => tool.name === 'read').inputSchema.required, ['file_path'])
    assert.deepEqual((await rpc('arena/catalog')).skills.map(s => s.name).sort(), ['automatic', 'shared'])
    assert.doesNotMatch(JSON.stringify(await rpc('arena/catalog')), /body-marker/)
    assert.match((await rpc('arena/explicitSkill', { token: operator, name: 'manual' })).content, /body-marker-manual/)
    assert.equal((await rpc('arena/explicitSkill', { token: operator, name: 'automatic' })).content, null)
    await assert.rejects(rpc('arena/explicitSkill', { name: 'manual' }))
    await call('model-manual', 'skill', { name: 'manual' })
    assert.doesNotMatch(JSON.stringify(await wait('model-manual', ['failed'])), /body-marker-manual/)
    await call('model-automatic', 'skill', { name: 'automatic' })
    assert.match(JSON.stringify(await wait('model-automatic', ['succeeded'])), /body-marker-automatic/)
  })

  await t.test('rejects paths outside the project including a directory alias', async () => {
    for (const [i, file_path] of ['../outside.txt', 'outside/outside.txt', '../alias-back/sample.txt'].entries()) {
      await call('outside-' + i, 'read', { file_path })
      assert.doesNotMatch(JSON.stringify(await wait('outside-' + i, ['failed'])), /private-label/)
    }
  })

  await t.test('returns the exact project PNG as an image and rejects oversized, corrupt and outside files', async () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGPgEtHlEtFlgFAAB7YBLctR6mAAAAAASUVORK5CYII='
    const png = Buffer.from(base64, 'base64')
    await writeFile(join(root, 'capture.png'), png)
    await call('picture', 'read_image', { file_path: 'capture.png' })
    assert.deepEqual((await wait('picture', ['succeeded'])).content, [{ type: 'image', mimeType: 'image/png', data: base64 }])
    const large = await sharp(randomBytes(256 * 256 * 3), { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer()
    assert.ok(large.length > 64 * 1024)
    await writeFile(join(root, 'large.png'), large)
    await call('large-picture', 'read_image', { file_path: 'large.png' })
    assert.deepEqual(Buffer.from((await wait('large-picture', ['succeeded'])).content[0].data, 'base64'), large)

    await writeFile(join(dir, 'external.png'), png)
    await writeFile(join(root, 'wrong.png'), 'ordinary text')
    await writeFile(join(root, 'truncated.png'), png.subarray(0, png.length - 8))
    await writeFile(join(root, 'trailing.png'), Buffer.concat([png, Buffer.from('hidden trailing payload')]))
    const corrupt = Buffer.from(png)
    corrupt[43] ^= 1
    await writeFile(join(root, 'corrupt.png'), corrupt)
    // Structurally correct checksum, corrupt compressed pixels.
    corrupt.writeUInt32BE(crc32(corrupt.subarray(37, 58)), 58)
    await writeFile(join(root, 'bad-pixels.png'), corrupt)
    const animation = Buffer.from('000000086163544c000000020000000000000000', 'hex')
    animation.writeUInt32BE(crc32(animation.subarray(4, 16)), 16)
    await writeFile(join(root, 'animated.png'), Buffer.concat([png.subarray(0, 33), animation, png.subarray(33)]))
    const enormous = Buffer.from(png)
    enormous.writeUInt32BE(100000000, 16)
    enormous.writeUInt32BE(crc32(enormous.subarray(12, 29)), 29)
    await writeFile(join(root, 'too-many-pixels.png'), enormous)
    await writeFile(join(root, 'oversized.png'), Buffer.alloc(4 * 1024 * 1024 + 1))
    for (const file_path of ['wrong.png', 'truncated.png', 'corrupt.png', 'bad-pixels.png', 'animated.png', 'too-many-pixels.png', 'trailing.png', 'oversized.png', 'outside/external.png']) {
      await call(file_path, 'read_image', { file_path })
      const failure = await wait(file_path, ['failed'])
      assert.equal(failure.content[0].type, 'text')
      assert.doesNotMatch(failure.content[0].text, /iVBOR|hidden trailing payload/)
    }
  })

  await t.test('shows the diff and gates native edits on a correlated operator decision', async () => {
    await call('read', 'read', { file_path: 'sample.txt' })
    assert.match(JSON.stringify(await wait('read', ['succeeded'])), /1: before/)
    const args = { file_path: 'sample.txt', old_string: 'before', new_string: 'after' }
    for (const [id, allow] of [['refused', false], ['accepted', true]]) {
      const initial = await call(id, 'edit', args)
      assert.ok(['running', 'approval'].includes(initial.state))
      const pending = await wait(id, ['approval'])
      if (id === 'accepted') {
        // The same pending invocation must survive a longer operator wait than
        // the MCP client's normal 60s request timeout.
        const hold = Number(process.env.ARENA_TEST_APPROVAL_DELAY_MS ?? 0)
        if (hold) await delay(hold)
        await call('another-read', 'read', { file_path: 'sample.txt' })
        assert.match(JSON.stringify(await wait('another-read', ['succeeded'])), /1: before/)
        assert.deepEqual(await call(id, 'edit', args), pending)
      }
      assert.match(pending.approval.detail, /sample\.txt/)
      assert.match(pending.approval.detail, /before/)
      assert.match(pending.approval.detail, /after/)
      assert.match(pending.approval.detail, /^- "before"\n\+ "after"$/m)
      const decision = { id, approvalId: pending.approval.id, allow }
      await assert.rejects(rpc('arena/decide', { ...decision, token: 'guess' }))
      await assert.rejects(rpc('arena/decide', { ...decision, token: operator, approvalId: 'old' }))
      await assert.rejects(call('forged', 'arena/decide', { ...decision, token: operator }))
      assert.equal(await readFile(join(root, 'sample.txt'), 'utf8'), 'before\n')
      await rpc('arena/decide', { ...decision, token: operator })
      await wait(id, [allow ? 'succeeded' : 'denied'])
      await assert.rejects(rpc('arena/decide', { ...decision, token: operator }))
      assert.equal(await readFile(join(root, 'sample.txt'), 'utf8'), allow ? 'after\n' : 'before\n')
    }
    assert.equal((await call('accepted', 'edit', args)).state, 'succeeded')
    await assert.rejects(call('accepted', 'edit', { ...args, new_string: 'different' }))
  })

  await t.test('retains read-before-edit and stale read protections after explicit skill loading', async () => {
    const name = 'extra.txt'
    await writeFile(join(root, name), 'initial\n')
    assert.match((await rpc('arena/explicitSkill', { token: operator, name: 'manual' })).content, /body-marker-manual/)
    const edit = { file_path: name, old_string: 'initial', new_string: 'replaced' }
    async function approveEdit(id) {
      await call(id, 'edit', edit)
      const pending = await wait(id, ['approval'])
      await rpc('arena/decide', { token: operator, id, approvalId: pending.approval.id, allow: true })
      return JSON.stringify(await wait(id, ['failed']))
    }
    assert.match(await approveEdit('never-read'), /has not been read/)
    await call('baseline', 'read', { file_path: name })
    await wait('baseline', ['succeeded'])
    await writeFile(join(root, name), 'initial\nexternal change\n')
    assert.match(await approveEdit('stale-read'), /re-read|changed since/i)
    assert.equal(await readFile(join(root, name), 'utf8'), 'initial\nexternal change\n')
  })

  await t.test('runs real project tests after approval and propagates failing test output', async () => {
    for (const fail of [false, true]) {
      if (fail) await writeFile(join(root, 'project.test.mjs'), "import test from 'node:test'; test('failure-marker', () => { throw Error('real failure') })\n")
      const id = fail ? 'broken-tests' : 'tests'
      await call(id, 'project_test', {})
      const pending = await wait(id, ['approval'])
      assert.match(pending.approval.detail, /--test/)
      assert.ok(pending.approval.detail.includes(root))
      await rpc('arena/decide', { id, approvalId: pending.approval.id, allow: true, token: operator })
      assert.match(JSON.stringify(await wait(id, [fail ? 'failed' : 'succeeded'])), fail ? /failure-marker/ : /marker-for-real-test/)
    }
  })

  await t.test('refreshes the project catalogue when a local skill is added between turns', async () => {
    const dir = join(root, '.agents', 'skills', 'newer')
    await mkdir(dir)
    await writeFile(join(dir, 'SKILL.md'), '---\nname: newer\ndescription: Newly added\n---\nprivate-body-marker\n')
    for (let i = 0; i < 30; i++) {
      const { skills } = await rpc('arena/catalog')
      if (skills.some(skill => skill.name === 'newer')) {
        assert.doesNotMatch(JSON.stringify(skills), /private-body-marker/)
        return
      }
      await delay(100)
    }
    assert.fail('new local skill missing from next catalogue')
  })
})
