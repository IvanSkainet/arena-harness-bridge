import { crc32 } from 'node:zlib'
import sharp from 'sharp'
import { defineTool } from '@deepseek-ai/dsh-tools'

const byteLimit = 4 * 1024 * 1024
const pixelLimit = 16 * 1024 * 1024
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function validatePngChunks(bytes) {
  if (!bytes.subarray(0, 8).equals(signature)) throw Error('Expected a PNG file')
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.length) throw Error('Truncated PNG chunk')
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    if (offset === 8 && (type !== 'IHDR' || length !== 13)) throw Error('Invalid PNG header')
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw Error('Expected a static PNG')
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw Error('PNG checksum mismatch')
    if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length) throw Error('Invalid PNG end or trailing bytes')
      return
    }
    offset = end
  }
  throw Error('Incomplete PNG')
}

export function projectImageTool(ctx) {
  return defineTool({
    name: 'read_image',
    description: 'Read an existing PNG in the bound project (up to 4 MiB and 16 megapixels) and return it as an image.',
    parameters: { file_path: { type: 'string', required: true, description: 'Project path of the PNG file.' } },
    output: {
      schema: { type: 'string' },
      render: (_args, data) => [{ type: 'text', text: data }],
    },
    async execute({ file_path }, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const target = await ctx.fs.resolve(file_path, { cwd, signal: exec.signal })
      const bytes = Buffer.from(await ctx.fs.readBytes(target, exec.signal, byteLimit))
      validatePngChunks(bytes)
      // Decode under a pixel ceiling before the browser receives original bytes.
      await sharp(bytes, { failOn: 'warning', limitInputPixels: pixelLimit }).resize(1, 1).raw().toBuffer()
      exec.signal.throwIfAborted()
      return bytes.toString('base64')
    },
  })
}
