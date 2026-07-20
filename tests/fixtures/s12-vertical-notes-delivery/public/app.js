const health = document.querySelector("#health")
const form = document.querySelector("#note-form")
const text = document.querySelector("#note-text")
const feedback = document.querySelector("#feedback")
const notes = document.querySelector("#notes")

function render(items) {
  notes.replaceChildren(
    ...items.map((note) => {
      const item = document.createElement("li")
      item.textContent = note.text
      return item
    }),
  )
}

async function request(path, options) {
  const response = await fetch(path, options)
  const body = await response.json()
  if (!response.ok) {
    const error = new Error(body.error?.message || "Request failed")
    error.correlationId = body.error?.correlationId
    throw error
  }
  return body
}

try {
  const status = await request("/api/health")
  if (status.status !== "ok") throw new Error("Health contract rejected")
  health.textContent = "Service online"
  form.hidden = false
  render((await request("/api/notes")).notes)
} catch (error) {
  health.textContent = "Service unavailable"
  feedback.textContent = error.correlationId
    ? `Unavailable. Reference ${error.correlationId}`
    : "Unavailable. Try again later."
}

form.addEventListener("submit", async (event) => {
  event.preventDefault()
  feedback.textContent = "Saving…"
  try {
    const created = await request("/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: text.value }),
    })
    const current = await request("/api/notes")
    render(current.notes)
    text.value = ""
    feedback.textContent = `Saved ${created.note.id}`
  } catch (error) {
    feedback.textContent = error.correlationId
      ? `${error.message} Reference ${error.correlationId}`
      : error.message
  }
})
