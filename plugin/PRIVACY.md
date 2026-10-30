# Privacy

## Anonymous daily usage counts

Codex Skills is on by default for anonymous daily usage counting. Its only
purpose is to identify skills that are rarely used or consistently broken so
maintenance work can be prioritized.

The plugin uploads at most one aggregate batch per completed UTC day:

- skill name from the public catalog;
- number of successful skill reads in that day;
- UTC date;
- plugin version;
- a random batch ID used only to make retries idempotent.

The plugin does **not** upload search terms, prompts, task descriptions, file
paths, skill contents, exact call times, GitHub credentials, usernames,
installation IDs, device IDs, or raw activity logs. The collector does not
store client IP addresses or unrelated request headers.

The plugin derives counts locally from the existing cumulative `usage.json`
counter. Historical usage that predates this feature is used only to establish
the initial baseline and is never uploaded.

## Retention

- Unuploaded local daily aggregates are retained for at most 14 days.
- The server removes daily rows and idempotency batch IDs after 90 days.

## Opt out

Open the plugin settings and turn off **匿名使用统计**. This immediately stops
network uploads. Local cumulative call counts and "used skills" data remain
available and continue to update; disabling this setting does not disable the
plugin's local usage history.

Pending daily aggregates stay local. If uploads are enabled again, completed
days can be uploaded at the next check.

The telemetry endpoint is:

`https://gh.251716.xyz/api/skill-usage/v1/batch`
