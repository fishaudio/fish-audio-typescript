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
3. Optional rehearsal: run the `Release` workflow by hand from the Actions tab on `main`. It tests the package on Node.js 20, 22 and 24 and runs `npm pack --dry-run`, which builds the package and lists the files a publish would upload. It does not ask the registry about the version and uploads nothing, so it works at any time, also right after a release.
4. Create a GitHub Release from `main` with the tag `vX.Y.Z`. The tag must be `v` followed by the version in `package.json`, or the workflow stops before publishing.

    ```bash
    gh release create vX.Y.Z --target main --title "vX.Y.Z" --notes "See CHANGELOG.md"
    ```

    If the tag `vX.Y.Z` already exists, `gh` uses it and ignores `--target`. The workflow publishes the commit the tag points to, with the workflow file of that commit.

5. The workflow tests the package on Node.js 20, 22 and 24, then runs `npm publish`. Check the result with `npm view fish-audio dist-tags`.

### Which dist-tag a version gets

- A stable version, such as `1.2.0`, is published without `--tag`, and npm gives it `latest`.
- A version with a pre-release part, such as `1.0.0-beta.1`, is published with `--tag next`.
- Before publishing, the workflow reads the dist-tags from the registry. It stops if the tag already points to the same or a higher version, or if it cannot read the tags. The workflow therefore cannot move `latest` or `next` backwards.
- A stable version lower than `latest`, such as a patch for an older minor, is not published by this workflow: the publish job stops at that check. A package owner publishes it by hand with a tag of its own, for example `npm publish --tag release-1.1`.

### Several releases, re-runs and failures

- Releases run one at a time, in the order their GitHub Releases were published. A release that is waiting is not dropped when another one is started, and a rehearsal never takes the place of a waiting release.
- Publish versions in ascending order. If `1.2.1` is released before `1.2.0`, the run for `1.2.0` stops at the dist-tag check.
- If a job fails for a reason outside the code (a network error, an approval that timed out), re-run the failed jobs. Nothing is uploaded before the last step of the publish job, and that step either publishes the whole version or nothing.
- If the code or the workflow must change, the existing tag cannot be reused as it is: a re-run uses the tagged commit and its copy of the workflow. As long as the version is not on npm, delete the GitHub Release and its tag, merge the fix, and create the release again. This starts a new run.

    ```bash
    gh release delete vX.Y.Z --cleanup-tag
    ```

- A version that is on npm cannot be published again. Re-running its release, or creating a GitHub Release for a version that was published by hand, stops at the dist-tag check. That failure changes nothing on npm. To change a published version, release a new one.
- If a GitHub Release exists but its version is not on npm, the publish did not happen. Open the workflow run of that release to see why, then follow the two cases above.

### One-time setup: npm Trusted Publisher

An owner of the npm package sets this once, on npmjs.com under `fish-audio` → Settings → Trusted Publisher → GitHub Actions:

| Field | Value |
| --- | --- |
| Organization or user | `fishaudio` |
| Repository | `fish-audio-typescript` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |
| Allowed actions | allow `npm publish` |

**Allowed actions** matters: a Trusted Publisher created after 3 September 2026 allows only `npm stage publish` unless `npm publish` is also allowed, and this workflow runs `npm publish`. `npm dist-tag` is not needed.

The values are case-sensitive, and npm does not check them when they are saved; a mistake shows up as an authentication error on the first publish. npm also expects the first publish within two days of saving the configuration, so set it up shortly before a release.

The `npm` environment in GitHub is created by the first run of the publish job. A repository admin can add required reviewers to it under Settings → Environments, so that each publish needs an approval.
