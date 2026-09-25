import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import { AssertionError } from 'node:assert'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { BroccoliQueue } from './queue.js'
import type { DashboardHandle, DashboardOptions, JobState } from './types.js'

const MAX_BODY_BYTES = 1_048_576
const DASHBOARD_HTML = new URL('../dashboard/index.html', import.meta.url)

class HttpError extends Error {
  status: number

  constructor (status: number, message: string) {
    super(message)
    this.status = status
  }
}

function isLoopback (host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('127.')
}

function equalSecret (provided: string, expected: string): boolean {
  const left = Buffer.from(provided)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function sendJson (response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY'
  })
  response.end(JSON.stringify(body))
}

function readJson (request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') return Promise.reject(new HttpError(415, 'Content-Type must be application/json'))
  const contentLength = request.headers['content-length']
  if (contentLength !== undefined && !/^\d+$/.test(contentLength)) {
    return Promise.reject(new HttpError(400, 'Content-Length must be a non-negative integer'))
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let tooLarge = Number(request.headers['content-length']) > MAX_BODY_BYTES
    let settled = false
    if (tooLarge) {
      settled = true
      reject(new HttpError(413, 'Request body exceeds 1 MiB'))
    }
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true
        settled = true
        reject(new HttpError(413, 'Request body exceeds 1 MiB'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (tooLarge || settled) return
      settled = true
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const value = text ? JSON.parse(text) : {}
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Request body must be a JSON object')
        resolve(value)
      } catch (error) {
        reject(error instanceof HttpError ? error : new HttpError(400, 'Request body is not valid JSON'))
      }
    })
    request.on('error', error => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

function statusFor (error: unknown): number {
  if (error instanceof HttpError) return error.status
  if (error instanceof AssertionError) return 400
  return 500
}

function messageFor (error: unknown, status: number): string {
  if (status >= 500) return 'Dashboard request failed'
  return error instanceof Error ? error.message : String(error)
}

function formatHost (host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

function parseAllowedOrigin (value: string): URL {
  let origin: URL
  try { origin = new URL(value) } catch { throw new Error(`Invalid dashboard allowed origin: ${value}`) }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin === 'null' || origin.username || origin.password ||
    origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error(`Dashboard allowed origins must be exact HTTP or HTTPS origins: ${value}`)
  }
  return origin
}

function safeRoutePart (raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new HttpError(400, 'Path contains invalid encoding')
  }
}

export async function createDashboardServer (
  queue: BroccoliQueue,
  options: DashboardOptions = {}
): Promise<DashboardHandle> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 3030
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError('dashboard port must be an integer from 0 to 65535')
  const tls = options.tls
  if (tls && (!tls.cert || !tls.key)) throw new Error('dashboard TLS requires both a certificate and private key')
  if (!isLoopback(host) && (!options.authToken || options.authToken.length < 32)) {
    throw new Error('dashboard authToken must be at least 32 characters when binding outside loopback')
  }
  if (!isLoopback(host) && !tls) throw new Error('dashboard TLS is required when binding outside loopback')
  const extraOrigins = (options.allowedOrigins ?? []).map(value => parseAllowedOrigin(value).origin)
  const html = (await readFile(DASHBOARD_HTML)).toString('utf8')

  let allowedOrigins = new Set<string>()
  let allowedHosts = new Set<string>()
  const onRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const requestHost = (request.headers.host ?? '').toLowerCase()
      if (!allowedHosts.has(requestHost)) throw new HttpError(403, 'This dashboard host is not allowed')
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
        const nonce = randomBytes(18).toString('base64')
        const page = html
          .replace('<style>', `<style nonce="${nonce}">`)
          .replace('<script>', `<script nonce="${nonce}">`)
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`,
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'X-Frame-Options': 'DENY',
          'Cross-Origin-Resource-Policy': 'same-origin'
        })
        response.end(page)
        return
      }

      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Route not found')
      if (options.authToken) {
        const authorization = request.headers.authorization ?? ''
        const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
        if (!equalSecret(supplied, options.authToken)) throw new HttpError(401, 'Dashboard token required')
      }

      if (request.method !== 'GET') {
        const fetchSite = request.headers['sec-fetch-site']?.toLowerCase()
        if (fetchSite === 'cross-site') throw new HttpError(403, 'Cross-site dashboard actions are not allowed')
        if (request.headers.origin !== undefined) {
          let origin: URL
          try { origin = new URL(request.headers.origin) } catch { throw new HttpError(403, 'Cross-origin dashboard actions are not allowed') }
          if (!allowedOrigins.has(origin.origin)) throw new HttpError(403, 'Cross-origin dashboard actions are not allowed')
        }
      }

      const method = request.method ?? 'GET'
      const path = url.pathname

      if (method === 'GET' && path === '/api/overview') {
        sendJson(response, 200, queue.getOverview())
        return
      }

      if (method === 'GET' && path === '/api/jobs') {
        const stateValue = url.searchParams.get('state') ?? undefined
        const state = stateValue ? stateValue.split(',') as JobState[] : undefined
        const jobs = queue.getJobs({
          ...(url.searchParams.has('queue') ? { queueName: url.searchParams.get('queue')! } : {}),
          ...(state ? { state } : {}),
          ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
          ...(url.searchParams.has('offset') ? { offset: Number(url.searchParams.get('offset')) } : {}),
          ...(url.searchParams.has('before') ? { beforeId: url.searchParams.get('before')! } : {})
        }).map(job => ({
          id: job.id,
          queueName: job.queueName,
          state: job.state,
          attemptsMade: job.attemptsMade,
          maxAttempts: job.maxAttempts,
          createdAt: job.createdAt
        }))
        sendJson(response, 200, { jobs })
        return
      }

      const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/)
      if (method === 'GET' && jobMatch) {
        const job = queue.getJob(safeRoutePart(jobMatch[1]!))
        if (!job) throw new HttpError(404, 'Job not found')
        sendJson(response, 200, { job })
        return
      }

      if (method === 'POST' && path === '/api/jobs') {
        const body = await readJson(request)
        if (typeof body.queueName !== 'string') throw new HttpError(400, 'queueName is required')
        const job = await queue.add(body.queueName, body.data ?? null, (body.options ?? {}) as import('./types.js').JobOptions)
        sendJson(response, 201, { job })
        return
      }

      const jobAction = path.match(/^\/api\/jobs\/([^/]+)\/(retry|cancel)$/)
      if (method === 'POST' && jobAction) {
        const id = safeRoutePart(jobAction[1]!)
        const result = jobAction[2] === 'retry'
          ? await queue.retry(id)
          : { cancelled: await queue.cancel(id) }
        sendJson(response, 200, result)
        return
      }

      if (method === 'DELETE' && jobMatch) {
        const removed = await queue.delete(safeRoutePart(jobMatch[1]!))
        if (!removed) throw new HttpError(409, 'Job cannot be deleted while active, or it no longer exists')
        sendJson(response, 200, { deleted: true })
        return
      }

      if (method === 'POST' && path === '/api/queues') {
        const body = await readJson(request)
        if (typeof body.name !== 'string') throw new HttpError(400, 'name is required')
        const created = queue.getQueue(body.name) === null
        sendJson(response, 201, { created, queue: await queue.createQueue(body.name) })
        return
      }

      const queueAction = path.match(/^\/api\/queues\/([^/]+)\/(pause|resume)$/)
      if (method === 'POST' && queueAction) {
        const name = safeRoutePart(queueAction[1]!)
        const changed = queueAction[2] === 'pause' ? await queue.pause(name) : await queue.resume(name)
        sendJson(response, 200, { changed, queue: queue.getQueue(name) })
        return
      }

      throw new HttpError(404, 'Route not found')
    } catch (error) {
      const status = statusFor(error)
      if (!response.headersSent) sendJson(response, status, { error: messageFor(error, status) })
      else response.destroy()
    }
  }

  const server: HttpServer | HttpsServer = tls ? createHttpsServer(tls, onRequest) : createHttpServer(onRequest)
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.maxHeadersCount = 100
  server.maxRequestsPerSocket = 1_000
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const addressInfo = server.address()
  const actualPort = typeof addressInfo === 'object' && addressInfo ? addressInfo.port : port
  const protocol = tls ? 'https' : 'http'
  const boundHost = `${formatHost(host)}:${actualPort}`.toLowerCase()
  const origins = [
    `${protocol}://${boundHost}`,
    ...extraOrigins
  ]
  allowedOrigins = new Set(origins)
  allowedHosts = new Set(origins.map(origin => new URL(origin).host.toLowerCase()))
  const shownHost = formatHost(host)
  let closePromise: Promise<void> | undefined
  const handle: DashboardHandle = {
    server,
    address: `${protocol}://${shownHost}:${actualPort}`,
    close: () => {
      if (closePromise) return closePromise
      closePromise = new Promise((resolve, reject) => {
        if (!server.listening) { resolve(); return }
        server.close(error => error ? reject(error) : resolve())
      })
      return closePromise
    }
  }
  return handle
}
