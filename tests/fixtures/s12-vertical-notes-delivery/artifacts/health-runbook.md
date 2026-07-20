# Health verification

Start with `node server.mjs`, then request `GET /api/health`. A successful response is
`{"status":"ok","version":1}`. The browser displays a loading state, then either `Service online`
or `Service unavailable`. The container healthcheck uses the same endpoint and port as the server.
