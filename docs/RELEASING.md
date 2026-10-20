# Releasing

## Before a release

1. Confirm the working tree contains no local-only files.
2. Update `package.json`, `plugin/package.json` and both plugin manifests.
3. Update [CHANGELOG.md](../CHANGELOG.md).
4. Run the complete verification sequence.

```bash
npm ci
npm test
npm run build:plugin
npm run check:package
```

5. Inspect the npm file list:

```bash
npm pack --dry-run
```

6. Confirm the package contains `LICENSE`, `NOTICE`, `brand/` and the built app.
7. Review generated plugin output and license copies.

## Version policy

Use SemVer for the server package. Pre-release versions may use an npm `beta`
dist-tag. The Codex plugin has its own version and must stay synchronized across:

- `plugin/package.json`;
- `plugin/plugin.json`;
- `plugin/.codex-plugin/plugin.json`.

## Publish

```bash
npm publish --access public
```

For a pre-release:

```bash
npm publish --tag beta
```

Do not publish from a dirty working tree. After publishing, verify a clean
install with:

```bash
node scripts/check-published-package.mjs <version>
```

## Rollback

npm versions are immutable. Fix forward with a new patch version and deprecate
the affected version through npm rather than attempting to replace its bytes.
