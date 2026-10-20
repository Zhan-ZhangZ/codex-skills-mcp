# Performance

Performance is driven by four properties:

1. startup uses a compact manifest rather than the complete skill library;
2. search runs against an in-process index;
3. a selected skill is downloaded once and reused from a verified cache;
4. network fallbacks are bounded by shared admission and deadlines.

## Operational model

| Stage | Network behavior |
|---|---|
| Startup | Manifest fetch and local index construction |
| Search | Local index; optional throttled freshness check |
| First skill read | Immutable file catalog or tree discovery, then parallel files |
| Cached skill read | Local disk verification; no full redownload |
| Stale cache | Revalidate changed files while preserving a usable old version |

The server limits concurrent HTTP operations and separates manifest capacity
from data transfers. This prevents large skill downloads from blocking catalog
refresh.

## Reproducible checks

```bash
npm run benchmark
npm run benchmark:loader
npm run benchmark:remote
npm run preview:app
```

Benchmarks are diagnostic tools, not release guarantees. Results depend on the
source repository, network route and local cache state. Record the commit,
Node.js version, operating system and whether caches were cold or warm when
comparing results.

The release gate is:

```bash
npm test
npm run build:plugin
npm run check:package
```

This verifies correctness, package contents, the npm artifact and the plugin
bundle independently of publication.
