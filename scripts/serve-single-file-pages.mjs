import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const rootDir = resolve(projectDir, 'single-file-pages')
const port = Number(process.env.HEADUP_SINGLE_PAGE_PORT || 4180)
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
}

function inside(base, target) {
  const normalizedBase = resolve(base) + sep
  const normalizedTarget = resolve(target)
  return normalizedTarget === resolve(base) || normalizedTarget.startsWith(normalizedBase)
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`)
    let target
    if (url.pathname.startsWith('/@fs/')) {
      const rawPath = decodeURIComponent(url.pathname.slice('/@fs/'.length))
      target = resolve(rawPath)
      if (!inside(projectDir, target)) throw new Error('Path is outside the HeadUp workspace')
    } else {
      const requestPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
      target = resolve(rootDir, `.${requestPath}`)
      if (!inside(rootDir, target)) throw new Error('Path traversal rejected')
    }
    const fileStat = await stat(target)
    if (!fileStat.isFile()) throw new Error('Not a file')
    response.writeHead(200, { 'Content-Type': mime[extname(target).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    createReadStream(target).pipe(response)
  } catch (error) {
    console.error(`404 ${request.url}: ${error.message}`)
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end(`HeadUp local file not found: ${error.message}`)
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`HeadUp single-file pages: http://127.0.0.1:${port}/`)
  console.log('Press Ctrl+C to stop.')
})
