# Releasing

The add-on installs by pulling `ghcr.io/pierrejochem/{arch}-addon-claude_code`
at the tag matching `version` in `claude_code/config.yaml`. A version that has no
published image breaks every install and update, so the order below matters.

## Cutting a release

1. Bump `version` in `claude_code/config.yaml` and `version` in
   `claude_code/app/package.json` to the same value. The panel's connection chip
   reads the second one; the Supervisor reads the first.
2. Move the changelog's unreleased entries under a `## <version>` heading in
   `claude_code/CHANGELOG.md`.
3. **Tag before merging.** Push `v<version>` on the branch head and let
   `.github/workflows/release.yml` publish, rather than merging first. The moment
   `image:` and a bumped `version` reach `main`, the Supervisor stops building
   locally and starts pulling a tag that does not exist yet — every install and
   update fails until the publish lands. Tagging first means that window never
   opens.
4. Watch the run. `verify` fails if the tag does not match `config.yaml`. `check`
   runs the full CI workflow, including both architecture image builds, and
   nothing is pushed unless both succeed.
5. **Check the packages are public.** `verify-pull` does this for you: it fetches
   each manifest from a runner with no GHCR credentials, so it fails exactly the
   way a user's Supervisor would. On the v0.2.0 release both packages were public
   without any manual step — the `org.opencontainers.image.source` label in
   `release.yml` links them to this repository and GHCR inherits its visibility.

   If `verify-pull` ever goes red with `unauthorized`, that inheritance did not
   happen: switch the package to public in your account's package settings. The
   workflow shows green through this failure mode without that job, which is why
   it exists.
6. Verify an anonymous pull, from a machine with no GitHub credentials:

   ```
   docker run --rm gcr.io/go-containerregistry/crane manifest \
     ghcr.io/pierrejochem/amd64-addon-claude_code:<version>
   ```

7. Merge the branch.

## Dry run

`release.yml` accepts a manual `workflow_dispatch` with `dry_run` (default true).
That runs `verify`, the full CI workflow and both image builds without pushing —
the way to exercise the release path without publishing anything.
