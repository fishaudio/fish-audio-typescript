# Contributing

## Development

Node.js 20 or later.

```bash
npm ci
npm run build
npm test
node scripts/smoke-pack.mjs
```

`scripts/smoke-pack.mjs` packs the package, installs the tarball in an empty project, loads it from CommonJS and from ESM, and type-checks a TypeScript consumer against it. CI runs all four commands on Node.js 20, 22 and 24 for every pull request.

## Releasing

A release is published to npm by the `Release` workflow (`.github/workflows/release.yml`) when a GitHub Release is published. Nobody needs an npm token.

1. Open a pull request that sets the new version and describes it:
    - `npm version X.Y.Z --no-git-tag-version` updates `package.json` and `package-lock.json`.
    - Add a `## [X.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md`, with upgrade notes for anything that can break existing code.
2. Merge the pull request.
3. Optional rehearsal: run the `Release` workflow by hand from the Actions tab on `main`. It tests the package and runs `npm publish --dry-run`; it uploads nothing.
4. Create a GitHub Release from `main` with the tag `vX.Y.Z`. The tag must be `v` followed by the version in `package.json`, or the workflow stops before publishing.

    ```bash
    gh release create vX.Y.Z --target main --title "vX.Y.Z" --notes "See CHANGELOG.md"
    ```

5. The workflow tests the package on Node.js 20, 22 and 24, then runs `npm publish`. Check the result with `npm view fish-audio version`.

A version with a pre-release part, such as `1.0.0-beta.1`, is published under the `next` dist-tag instead of `latest`.

If the publish job fails, fix the cause and re-run the failed job: nothing is uploaded before its last step. A version that is already on npm cannot be published again; release a new version instead.

### One-time setup: npm Trusted Publisher

An owner of the npm package sets this once, on npmjs.com under `fish-audio` → Settings → Trusted Publisher → GitHub Actions:

| Field | Value |
| --- | --- |
| Organization or user | `fishaudio` |
| Repository | `fish-audio-typescript` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |

The values are case-sensitive, and npm does not check them when they are saved; a mistake shows up as an authentication error on the first publish. npm also expects the first publish within two days of saving the configuration, so set it up shortly before a release.

The `npm` environment in GitHub is created by the first run of the publish job. A repository admin can add required reviewers to it under Settings → Environments, so that each publish needs an approval.
