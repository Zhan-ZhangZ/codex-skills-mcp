# Remote HTTP example

```bash
node dist/index.js \
  --http \
  --host 0.0.0.0 \
  --port 3456 \
  --allowed-hosts skills.example.com
```

Client URL:

```text
https://skills.example.com/mcp
```

Terminate TLS and require authentication at the reverse proxy. Do not expose an
unauthenticated instance directly to the public internet.
