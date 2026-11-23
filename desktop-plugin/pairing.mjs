import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

function showPairing(setup, signal) {
  if (process.platform !== 'win32') throw Error('Connect Arena dialog currently requires Windows Desktop')
  const file = fileURLToPath(new URL('./pairing.ps1', import.meta.url))
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-File', file], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, signal,
  })
  return new Promise((resolve, reject) => {
    let action = ''
    child.stdout.on('data', chunk => { action += chunk })
    child.once('error', reject)
    child.stdin.once('error', reject)
    child.once('close', code => {
      if (code !== 0) reject(Error('Cannot display Connect Arena. Check Windows PowerShell and desktop access.'))
      else resolve(action.trim())
    })
    // Explicit human-only output; the Desktop Session records slash-command
    // return text, so credentials are never returned through that channel.
    child.stdin.end(JSON.stringify({
      token:setup.pairToken, chat:setup.chat, pause:setup.pause, port:setup.port,
      title:'Connect Arena / Подключить Arena',
      instructions:'Open the Arena Agent Mode tab. In the bridge extension, paste the token and bind this chat. In DeepSeek Harness select Arena Agent Mode and use the normal message field.\n\nОткройте вкладку Arena Agent Mode. В расширении вставьте токен и привяжите этот чат. В DeepSeek Harness выберите модель Arena Agent Mode и пишите в обычном поле сообщения.',
    }))
  })
}

export function pairingCommand(companion, show = showPairing) {
  return {
    name: 'arena-pair',
    description: 'Connect Arena / Подключить Arena — pair the extension, view status or disconnect',
    recordInput: false,
    async handler({ agent, rawInput, signal }) {
      if (rawInput.trim()) return {kind:'error',text:'Select Connect Arena or enter /arena-pair without arguments.'}
      const address = { sessionId: agent.session.id }
      const setup = await companion.rpc('setup', address)
      if (await show(setup, signal) === 'disconnect') {
        await companion.rpc('disconnect', address)
        return { kind:'success', text:'Disconnected Arena. Open Connect Arena to pair another conversation.' }
      }
      return { kind:'success', text:'Select Arena Agent Mode in the model picker. Выберите Arena Agent Mode в списке моделей.' }
    },
  }
}

export function resetCommand(companion) {
  return {
    name: 'arena-reset',
    description: 'Reset Arena / Сбросить Arena — clear the delivery queue and release the connection from any Desktop conversation',
    recordInput: false,
    async handler({ agent, rawInput, signal }) {
      if (rawInput.trim()) return { kind:'error', text:'Enter /arena-reset without arguments.' }
      signal?.throwIfAborted()
      const result = await companion.rpc('reset', { sessionId:agent.session.id })
      if (result?.ok !== true) throw Error('The Arena companion did not confirm the reset.')
      return { kind:'success', text:'Привязка Arena сброшена. Для подключения выполните /arena-pair. / Arena connection reset. Run /arena-pair to reconnect.' }
    },
  }
}
