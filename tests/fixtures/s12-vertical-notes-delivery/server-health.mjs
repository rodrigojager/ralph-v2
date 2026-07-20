import { readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve } from "node:path"

const root = process.cwd()
const host = process.env.HOST || "127.0.0.1"
const requestedPort = Number(process.env.PORT || 3000)
const readyFile = process.env.READY_FILE

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  response.end(JSON.stringify(value))
}

async function staticFile(response, path, contentType) {
  try {
    const body = await readFile(resolve(root, path))
    response.writeHead(200, { "content-type": contentType })
    response.end(body)
  } catch {
    json(response, 404, { error: { code: "not_found" } })
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${host}`)
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json(response, 200, { status: "ok", version: 1 })
  }
  if (request.method === "GET" && url.pathname === "/") {
    return staticFile(response, "public/index.html", "text/html; charset=utf-8")
  }
  if (request.method === "GET" && url.pathname === "/app.js") {
    return staticFile(response, "public/app-health.js", "text/javascript; charset=utf-8")
  }
  return json(response, 404, { error: { code: "not_found" } })
})

server.listen(requestedPort, host, async () => {
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : requestedPort
  if (readyFile) await writeFile(readyFile, JSON.stringify({ host, port }), "utf8")
  process.stdout.write(`LISTENING:${host}:${port}\n`)
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
