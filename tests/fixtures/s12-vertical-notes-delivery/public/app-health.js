const health = document.querySelector("#health")

try {
  const response = await fetch("/api/health")
  const body = await response.json()
  if (!response.ok || body.status !== "ok") throw new Error("health contract rejected")
  health.textContent = "Service online"
} catch {
  health.textContent = "Service unavailable"
}
