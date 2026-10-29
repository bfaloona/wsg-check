// @vitest-environment node
/**
 * Uses a real server and un-mocked axios: the byte count must come from the
 * network stream, which the mocked tests cannot observe. Needs the node
 * environment so axios uses its http adapter.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import zlib from 'node:zlib'
import { HttpClient } from '@/utils/http-client'

// Non-ASCII text so the UTF-8 byte count differs from the string length.
const HTML = `<!DOCTYPE html><html lang="en"><head><title>t</title></head><body>${'<p>héllo wörld</p>'.repeat(200)}</body></html>`
const HTML_BYTES = Buffer.byteLength(HTML)
const GZIPPED = zlib.gzipSync(HTML)

type Route = { body: Buffer | string; encoding?: string; chunked: boolean }

const ROUTES: Record<string, Route> = {
  '/gzip-chunked': { body: GZIPPED, encoding: 'gzip', chunked: true },
  '/gzip-content-length': { body: GZIPPED, encoding: 'gzip', chunked: false },
  '/plain-chunked': { body: HTML, chunked: true },
}

const server = http.createServer((req, res) => {
  const route = ROUTES[req.url ?? '']
  if (!route) {
    res.writeHead(404).end()
    return
  }
  const body = Buffer.from(route.body)
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    ...(route.encoding ? { 'Content-Encoding': route.encoding } : {}),
    // Without Content-Length, Node sends the body with chunked transfer encoding.
    ...(route.chunked ? {} : { 'Content-Length': body.length }),
  })
  if (route.chunked) {
    const half = Math.floor(body.length / 2)
    res.write(body.subarray(0, half))
    res.end(body.subarray(half))
  } else {
    res.end(body)
  }
})

let baseUrl = ''

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('HttpClient contentLength against a real server', () => {
  it.each([
    ['gzip with chunked transfer encoding', '/gzip-chunked', GZIPPED.length],
    ['gzip with Content-Length', '/gzip-content-length', GZIPPED.length],
    ['uncompressed with chunked transfer encoding', '/plain-chunked', HTML_BYTES],
  ])('counts the bytes received for %s', async (_label, path, expectedBytes) => {
    const result = await new HttpClient({ maxRetries: 0 }).fetch(`${baseUrl}${path}`)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.body).toBe(HTML)
    expect(result.value.contentLength).toBe(expectedBytes)
  })
})
