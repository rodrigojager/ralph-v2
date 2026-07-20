import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { createNote, readNotes } from "./src/store.mjs"

const root = process.cwd()
const host = process.env.HOST || "127.0.0.1"
const requestedPort = Number(process.env.PORT || 3000)
const dataFile = resolve(process.env.DATA_FILE || resolve(root, "var/notes.json"))
const readyFile = process.env.READY_FILE
const maximumBodyBytes = 8 * 1024

function emitLog(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function json(response, status, value, correlationId) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...(correlationId ? { "x-correlation-id": correlationId } : {}),
  })
  response.end(JSON.stringify(value))
}

function failure(response, status, code, message, correlationId, request) {
  emitLog({
    level: "warn",
    status,
    method: request.method,
    path: new URL(request.url || "/", `http://${host}`).pathname,
    correlationId,
    errorCode: code,
  })
  json(response, status, { error: { code, message, correlationId } }, correlationId)
}

async function body(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.byteLength
    if (bytes > maximumBodyBytes) throw Object.assign(new Error("Request is too large"), { code: "BODY_TOO_LARGE" })
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw Object.assign(new Error("Request body must be JSON"), { code: "BODY_INVALID" })
  }
}

async function staticFile(response, path, contentType) {
  try {
    const value = await readFile(resolve(root, path))
    response.writeHead(200, { "content-type": contentType })
    response.end(value)
  } catch {
    json(response, 404, { error: { code: "not_found" } })
  }
}

const server = createServer(async (request, response) => {
  const correlationId = randomUUID()
  const url = new URL(request.url || "/", `http://${host}`)
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, { status: "ok", version: 1 })
    }
    if (request.method === "GET" && url.pathname === "/api/notes") {
      return json(response, 200, { notes: await readNotes(dataFile) })
    }
    if (request.method === "POST" && url.pathname === "/api/notes") {
      const input = await body(request)
      const note = await createNote(dataFile, input?.text)
      return json(response, 201, { note })
    }
    if (request.method === "GET" && url.pathname === "/") {
      return staticFile(response, "public/index.html", "text/html; charset=utf-8")
    }
    if (request.method === "GET" && url.pathname === "/app.js") {
      return staticFile(response, "public/app.js", "text/javascript; charset=utf-8")
    }
    return json(response, 404, { error: { code: "not_found" } })
  } catch (error) {
    const code = error?.code || "INTERNAL_ERROR"
    const clientError = code === "NOTE_INVALID" || code === "BODY_INVALID" || code === "BODY_TOO_LARGE"
    return failure(
      response,
      clientError ? 400 : 500,
      code.toLowerCase(),
      clientError ? error.message : "Notes are temporarily unavailable",
      correlationId,
      request,
    )
  }
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
