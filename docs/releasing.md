# Release runbook

This runbook covers updater trust and release inspection. Platform code signing
and Apple notarization are separate work tracked in issue #65.

## Production signing key

The repository owner generates the production keypair once, on a trusted
machine, with a strong unique password:

```console
$ pnpm tauri signer generate --write-keys /secure/path/epubzilla-updater.key
```

Let the signer prompt for the password instead of putting it in shell history.
The command writes the encrypted private key and a `.pub` file.

1. Replace `REPLACE_WITH_PRODUCTION_MINISIGN_PUBLIC_KEY` in
   `crates/app/tauri.conf.json` with the exact full `.pub` contents, preserving
   embedded newlines as JSON `\n` escapes if present.
2. Put the full encrypted private-key contents in the repository Actions secret
   `TAURI_SIGNING_PRIVATE_KEY`.
3. Put its password in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. Keep a second recoverable, encrypted backup of both the key and password
   outside GitHub, accessible to the repository owner or designated successor.

Never commit the private key, place it in `.env`, upload it as an artifact, or
paste it into an issue, pull request, command output, or build log. The release
workflow fails before building if either secret is absent or the public-key
placeholder remains.

## Local signed build

Use the tested full-key-contents environment form. Do not use
`TAURI_SIGNING_PRIVATE_KEY_PATH`; it did not sign the production-style test
build used to establish this workflow.

In Fish:

```fish
set -gx TAURI_SIGNING_PRIVATE_KEY \
  (string collect --no-trim-newlines < /secure/path/epubzilla-updater.key)
read --silent --line --prompt-str "Updater key password: " \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD
echo
set -gx TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
  "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
pnpm tauri build --target aarch64-apple-darwin
set -e TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Run this only in a trusted terminal. The normal installer plus an updater archive
and adjacent `.sig` should appear under the Tauri target bundle directory. On
macOS Apple Silicon the updater pair is `*.app.tar.gz` and
`*.app.tar.gz.sig`.

For a throwaway-key rehearsal, copy the repository to an isolated worktree,
generate a throwaway key, temporarily embed its public key there, and build with
the throwaway private-key contents. Never reuse that key for a real release.
Verify the archive using the public key and a Minisign-compatible verifier. Then
copy the archive, mutate one byte, and confirm verification fails:

```sh
minisign -Vm path/to/epubzilla.app.tar.gz -p /secure/path/epubzilla-updater.key.pub \
  -x path/to/epubzilla.app.tar.gz.sig
cp path/to/epubzilla.app.tar.gz /tmp/epubzilla-mutated.app.tar.gz
printf x | dd of=/tmp/epubzilla-mutated.app.tar.gz bs=1 seek=32 count=1 conv=notrunc
! minisign -Vm /tmp/epubzilla-mutated.app.tar.gz \
  -p /secure/path/epubzilla-updater.key.pub \
  -x path/to/epubzilla.app.tar.gz.sig
```

## Draft inspection and publishing

The release workflow creates a draft and automatically checks the active target
before review. Do not publish unless all of these remain true:

- Every active target has its normal installer, updater artifact, and adjacent
  `.sig`. Current coverage is macOS Apple Silicon (`dmg`, `app.tar.gz`, and
  `app.tar.gz.sig`). Repeat this check for every installer type when Windows or
  Linux returns.
- Exactly one `latest.json` exists. Its `version` equals the tag/app version.
- Every active platform entry points to an asset under the same release tag and
  contains the matching signature. Download each referenced URL from a logged-
  out browser or with unauthenticated `curl` before publishing if testing a
  non-production endpoint.
- Verification succeeds against the public key embedded in that tagged source.
  A one-byte-mutated copy fails verification.
- Build logs and uploaded assets contain no private-key material. Inspect asset
  names and contents; never print a secret in order to compare it.

When parallel platform jobs are re-enabled, move final manifest inspection into
a separate job that depends on every build. Keep `retryAttempts: 3`; publish only
after that final job confirms all targets are present in the one merged manifest.

After publishing, check anonymous access and the resolved version:

```sh
curl -fL https://github.com/SeanCassiere/epubzilla/releases/latest/download/latest.json \
  | jq '.version, (.platforms | keys)'
curl -fL -o /dev/null https://github.com/SeanCassiere/epubzilla/releases/latest
```

Also fetch every asset URL named by `latest.json` without GitHub credentials.
Draft and prerelease manifests must not resolve through the production `latest`
endpoint.

## Two-release canary

For the first updater-enabled production rollout:

1. Publish and install the first signed updater-enabled release.
2. Publish the next signed patch release with the same production key.
3. Confirm `latest.json` and all referenced assets download anonymously.
4. Launch the prior installed release on macOS Apple Silicon and confirm it
   shows the patch version once and **View release** opens the exact public
   latest-release page.
5. Repeat with a book open and an unapplied editor buffer. Dismiss and open the
   notice; confirm the app remains open and all book/editor state is intact.

Repeat the canary for each installer type when Windows and Linux targets return.

## Loss, compromise, rotation, and rollback

- **Lost old key:** existing installations trust only that key. If no usable
  backup remains, those users must manually reinstall a release that embeds a
  new public key. Document the incident prominently on the release page.
- **Suspected compromise:** stop publishing, remove/replace the GitHub secrets,
  assess which releases and logs were exposed, and notify users. Do not sign
  further releases with the suspected key.
- **Planned rotation:** while the old private key is still trusted and secure,
  generate the new pair and ship a transitional release embedding the new public
  key but signed by the old private key. After that release is broadly installed,
  switch CI to the new private key. Users who skipped the transition may require
  a manual reinstall.
- **Rollback:** never repoint `latest.json` to an older version and never offer a
  downgrade. Fix or revert the code and publish it as a new, higher forward
  version signed by the current trusted key.
