# Releasing

## Before a release

1. Confirm the working tree contains no local-only files.
2. Update `package.json`. `npm run build:plugin` synchronizes the version into
   `plugin/package.json` and both plugin manifests.
3. Update [CHANGELOG.md](../CHANGELOG.md).
4. Run the complete verification sequence.

```bash
npm ci
npm test
npm run build:plugin
npm run check:plugin
npm run check:package
```

5. Confirm the plugin runtime test passed on macOS, Windows and Linux in CI,
   including the minimal-PATH launcher case.
6. Inspect the npm file list:

```bash
npm pack --dry-run
```

7. Confirm the package contains `LICENSE`, `NOTICE`, `brand/` and the built app.
8. Review generated plugin output and license copies.

## Version policy

Use SemVer for the server package. Pre-release versions may use an npm `beta`
dist-tag. The Codex plugin version is synchronized automatically across:

- `plugin/package.json`;
- `plugin/plugin.json`;
- `plugin/.codex-plugin/plugin.json`.

The marketplace entry lives at `.agents/plugins/marketplace.json`. Do not bump
the plugin version by hand in only one file.

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

### Publish the Codex plugin

Commit the rebuilt `plugin/` directory, then create a tag matching the plugin
manifest exactly:

```bash
git tag plugin-v1.6.1
git push origin main plugin-v1.6.1
```

The tag workflow validates every artifact, builds
`codex-skills-plugin-<tag>.zip` and attaches it to a GitHub Release.

Users on the `main` marketplace source update with:

```bash
codex plugin marketplace upgrade codex-skills-marketplace
codex plugin add codex-skills@codex-skills-marketplace
```

Users can pin a release with `--ref plugin-v1.6.1`. Pinned installations do not
move automatically.

## Rollback

npm versions are immutable. Fix forward with a new patch version and deprecate
the affected version through npm rather than attempting to replace its bytes.

Plugin releases are immutable Git tags. To roll a user back, re-add the
marketplace using the previous `plugin-vX.Y.Z` tag and reinstall the plugin.
