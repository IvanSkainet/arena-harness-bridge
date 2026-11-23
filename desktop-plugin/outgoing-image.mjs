import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const maxWireBytes = 4 * 1024 ** 2
// Use the same source admission bounds as the standard DSH local attachment store.
const maxSourceBytes = 50 * 1024 ** 2
const maxSourcePixels = 64_000_000
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function staticPng(bytes) {
  if (!bytes.subarray(0, 8).equals(pngSignature)) return false
  // libpng can expose only the first APNG frame. Its animation-control chunk
  // precedes the first IDAT chunk, even when the default frame is a static cover.
  for (let pos = 8; pos + 12 <= bytes.length;) {
    const end = pos + 12 + bytes.readUInt32BE(pos)
    if (end > bytes.length) return false
    const tag = bytes.toString('ascii', pos + 4, pos + 8)
    if (tag === 'acTL') return false
    if (tag === 'IDAT') return true
    pos = end
  }
  return false
}

export async function outgoingPng(ctx, block, signal) {
  const ref = block.attachment
  if (block.offloaded || !['image/jpeg','image/png'].includes(ref?.mediaType)) throw Error('Arena requires an accessible static PNG or JPEG attachment')
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > maxSourceBytes) throw Error('Arena image source must fit within 50 MiB')
  const store = ctx.get('attachments')
  if (!store) throw Error('DSH attachment service unavailable')
  signal?.throwIfAborted()
  const { data } = await store.readImage(ref, signal)
  signal?.throwIfAborted()
  if (!(data instanceof Uint8Array) || data.byteLength !== ref.bytes) throw Error('DSH attachment length does not match its reference')
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (ref.mediaType === 'image/png') {
    if (!staticPng(bytes)) throw Error('Expected a static PNG matching the attachment reference')
    // The native attachment service has already verified these immutable bytes.
    if (bytes.length <= maxWireBytes) return bytes
  } else if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) {
    throw Error('JPEG bytes do not match the attachment reference')
  }

  const sharp = require('sharp')
  const open = () => sharp(bytes, {limitInputPixels:maxSourcePixels,failOn:'error'})
  const metadata = await open().metadata()
  if ('image/' + metadata.format !== ref.mediaType || (metadata.pages ?? 1) !== 1) throw Error('Expected one static image matching its reference')
  const { width, height } = metadata.autoOrient
  if (!width || !height || Math.max(width,height) > 65535 || width * height > maxSourcePixels) throw Error('DSH image exceeds the supported source dimensions')

  // First retain the native normalization envelope. For high-entropy data,
  // reserve room for four channels plus PNG scanline and compression overhead.
  for (const pixels of [2048 ** 2, Math.floor(maxWireBytes * 0.94 / 4)]) {
    signal?.throwIfAborted()
    const scale = Math.min(1, Math.sqrt(pixels / (width * height)), 8192 / Math.max(width,height))
    const png = await open().autoOrient().resize({
      width:Math.max(1, Math.floor(width * scale)), height:Math.max(1, Math.floor(height * scale)),
      fit:'inside', withoutEnlargement:true,
    }).toColourspace('srgb').png().toBuffer()
    signal?.throwIfAborted()
    if (png.length <= maxWireBytes) return png
  }
  throw Error('Converted PNG exceeds the 4 MiB Arena attachment limit')
}
