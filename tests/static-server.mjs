// Minimal static file server for tests. Written by hand (rather than pulling in a
// package like http-server) so the test suite has no extra network dependency and
// full control over MIME types - CavalryWasm.js needs `.wasm` served as
// application/wasm to use WebAssembly.instantiateStreaming, matching production
// (see ../_headers).
import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { extname, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".cv": "application/octet-stream",
  ".ttf": "font/ttf",
  ".json": "application/json",
}

export function startServer(port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost")
      let path = normalize(decodeURIComponent(url.pathname))
      if (path === "/" || path === "\\") path = "/index.html"

      const filePath = join(ROOT, path)
      if (!filePath.startsWith(ROOT)) {
        res.writeHead(403)
        res.end()
        return
      }

      const fileStat = await stat(filePath)
      if (!fileStat.isFile()) throw new Error("not a file")

      const body = await readFile(filePath)
      const contentType = MIME_TYPES[extname(filePath)] || "application/octet-stream"
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": body.length,
        "Cross-Origin-Resource-Policy": "cross-origin",
      })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end("Not found")
    }
  })

  return new Promise((resolve) => {
    server.listen(port, () => resolve(server))
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.argv[2]) || 4173
  await startServer(port)
  console.log(`Static server listening on http://localhost:${port}`)
}
