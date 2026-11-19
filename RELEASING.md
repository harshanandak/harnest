# Releasing Harnest

1. Open a version PR with matching package, lockfile, and plugin versions, fresh host build stamps, the changelog date, and the tagged install instructions.
2. Require green GitHub CI before merging. Fetch `origin/main` after merge and confirm CI passed for the exact merged commit.
3. Tag that commit and create the GitHub Release. Copy that version's changelog entry into the release notes.

   ```sh
   git tag -a v0.1.0 <verified-merged-main-sha> -m "Harnest v0.1.0"
   git push origin v0.1.0
   gh release create v0.1.0 --verify-tag --title "Harnest v0.1.0" --notes-file <release-notes-file>
   ```

4. Verify the GitHub Release points to the tagged commit and that a fresh checkout can install the exact tag with `bun install --frozen-lockfile --omit optional`. Harnest ships through GitHub source releases. Skip npm publication.

To roll back an installation, check out the previous release tag, run the frozen install, rerun the host installer, and restart the host.
