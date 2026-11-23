import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Approval from '@deepseek-ai/dsh-user-approval'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as Observations from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFS from '@deepseek-ai/dsh-tool-fs'
import Skills, { isModelInvocable, isUserInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill'
import * as SkillFiles from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { projectImageTool } from './project-image.mjs'

const run = promisify(execFile)
const projectTools = ['read', 'edit', 'skill', 'project_test', 'read_image']

// DSH resolves symlinks in targetKey. Apply the project boundary to the exact
// provider target that its actual read, edit and skill loader will consume.
class ProjectFileSystem extends LocalFileSystem {
  async resolve(path, options) {
    if (/^~(?:[\\/]|$)/.test(path)) throw Error('Use a path in the bound project')
    this.assertWithinRoot(resolve(options?.cwd ?? this.config.cwd, path))
    const target = await super.resolve(path, options)
    this.assertWithinRoot(this.processPath(target))
    return target
  }

  assertWithinRoot(path) {
    const tail = relative(this.config.cwd, path)
    if (isAbsolute(tail) || tail === '..' || tail.startsWith('..' + sep)) throw Error('Path outside the bound project')
  }
}

function testTool(root, args) {
  return defineTool({
    name: 'project_test',
    description: 'Run the bound Node.js project test suite after operator approval.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    async execute(_args, exec) {
      const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
      try {
        const { stdout, stderr } = await run(process.execPath, args, { cwd: root, env, windowsHide: true, timeout: 120000, maxBuffer: 256 * 1024, signal: exec.signal })
        return stdout + stderr
      } catch (error) {
        throw Error(`Project tests failed (${error.code ?? error.signal ?? error.message})\n${error.stdout ?? ''}${error.stderr ?? ''}`)
      }
    },
  })
}

export async function openProfile(root, ask) {
  const ctx = new Context()
  try {
    for (const plugin of [LlmRuntime, SessionStore, Projections, SystemPrompt, ToolRegistry, NativeExecutor, Agents]) await ctx.plugin(plugin)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Approval, { policy: 'ask' })
    await ctx.plugin(ProjectFileSystem, { cwd: root })
    await ctx.plugin(WorkingDirectory)
    await ctx.plugin(Observations)
    await ctx.plugin(ToolFS, { write: false, readImage: false })
    await ctx.plugin(Skills)
    await ctx.plugin(SkillFiles, {
      includeDefaultRoots: false,
      customSkillDirs: [join(root, '.dsh', 'skills'), join(root, '.agents', 'skills')],
      watch: true,
      watchFollowSymlinks: false,
    })
    await ctx.plugin(ToolSkill)

    const testArgs = ['--permission', '--allow-fs-read=' + root, '--test-isolation=none', '--test']
    ctx.tools.register(testTool(root, testArgs))
    ctx.tools.register(projectImageTool(ctx))
    ctx.on('tools/pre-execute', async (exec, next) => {
      const policy = await next()
      if (policy.kind !== 'allow') return policy
      if (exec.name === 'edit') {
        const { file_path, old_string, new_string, replace_all } = exec.arguments
        const detail = [
          `Edit ${JSON.stringify(file_path)} in ${root}`,
          replace_all ? 'Replace every match' : 'Replace one unique match',
          '- ' + JSON.stringify(old_string),
          '+ ' + JSON.stringify(new_string),
        ].join('\n')
        return { kind: 'ask', reason: detail }
      }
      if (exec.name === 'project_test') {
        return { kind: 'ask', reason: `Run project tests in ${root}\n${JSON.stringify([process.execPath, ...testArgs])}` }
      }
      return policy
    })
    ctx.on('approval/request', request => Promise.resolve(ask(request)))
    const { agent } = await ctx.agents.create({
      sessionId: randomUUID(), meta: { cwd: root },
      setup: agentCtx => { agentCtx.tools.restrict({ allow: projectTools }) },
    })
    // One external conversation owns this DSH session. ApprovalService requires
    // its logged asked/decided pair inside a turn. No messages enter the DSH loop.
    agent.session.append('turn/start', { turn: 1 })
    const lookup = { cwd: root, scope: agent }
    return {
      tools: () => ctx.tools.schemas(agent).map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters })),
      async catalog() {
        const snapshot = await ctx.skills.snapshot(lookup)
        return { skills: snapshot.skills.filter(isModelInvocable).map(({ name, description }) => ({ name, description })), complete: snapshot.complete }
      },
      async explicitSkill(name) {
        if (typeof name !== 'string') throw Error('Expected skill name')
        const skill = await ctx.skills.get(name, lookup)
        return skill && isUserInvocable(skill) ? renderSkillContent(skill) : null
      },
      async execute(id, name, args, signal) {
        const batch = await ctx.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }] })
        const { result } = batch.results[0]
        // DSH images are attachment-store handles. This profile returns bytes
        // through MCP only after its ordinary execution and result policies.
        if (name === 'read_image' && !result.isError && result.content.length === 1 &&
            result.content[0].type === 'text' && result.content[0].text === result.value) {
          return { ...result, content: [{ type: 'image', mimeType: 'image/png', data: result.content[0].text }] }
        }
        return result
      },
      async close() {
        agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        await ctx.fiber.dispose()
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
