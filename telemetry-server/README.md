# Anonymous usage collector

This loopback-only service accepts the plugin's daily aggregate `POST`:

```json
{
  "schema_version": 1,
  "batch_id": "uuid",
  "plugin_version": "1.7.0",
  "day": "2026-10-30",
  "skills": [
    { "name": "ppt-master", "count": 3 }
  ]
}
```

It stores only the UTC day, skill name, aggregate count, plugin version and a
short-lived batch ID used to make retries idempotent. It does not read or store
the client IP, request headers beyond validation fields, task text, search
queries or file paths.

## Query daily totals

```sh
sqlite3 /var/lib/codex-skills-telemetry/usage.sqlite3 \
  "SELECT day, skill, count FROM skill_usage ORDER BY day DESC, count DESC LIMIT 50;"
```

Daily rows and idempotency IDs older than 90 days are pruned automatically
during writes. The service is intended to listen on `127.0.0.1` only and must
be exposed through a restricted Nginx location with body-size and rate limits.
