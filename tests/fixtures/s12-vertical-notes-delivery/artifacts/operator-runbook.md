# Operator diagnostics

Start with `node server.mjs`. Use `GET /api/health` for health and stop with SIGTERM/SIGINT. The
store defaults to `var/notes.json`; `DATA_FILE` selects another path. Error responses include an
opaque correlation ID also present in structured stdout logs. Logs contain method, route, status,
error code and correlation ID, never note text. Mount `/data` for the container. Preserve an invalid
store for inspection; recovery requires an explicit operator repair or restore, never implicit wipe.
