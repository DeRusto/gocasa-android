# Updating an unpacked extension

Research for [#18](https://github.com/DeRusto/gocasa-android/issues/18). Context: the Extension build is an MV3 extension installed with **Load unpacked** on a consumer (unmanaged) Chromebook. The Chrome Web Store and enterprise policy are out of scope.

Anything not confirmed against a primary source (Chrome developer docs, Chromium source, GitHub docs) is marked **[unverified]**. Claims read from Chromium source rather than from docs are marked **(from source)**.

## Answer

- **It cannot update itself.** Chrome's updater skips unpacked extensions. `update_url` has no effect, and `chrome.runtime.requestUpdateCheck()` can never return `update_available` for them. `onUpdateAvailable` never fires.
- **It can detect a new GitHub Release and tell the user.** Call `GET https://api.github.com/repos/DeRusto/gocasa-android/releases/latest`, compare the result with `chrome.runtime.getManifest().version`, and show a banner. GitHub's API allows CORS from any origin. Unauthenticated callers get 60 requests an hour, so check about once a day.
- **The least manual path:** unzip the new release *over the same folder* and reload the extension (the reload button on chrome://extensions, or the extension calls `chrome.runtime.reload()`). The ID stays the same, and Chrome treats the reload as an update, so `chrome.storage`, the camera grant and granted permissions stay with it.
- **Put a `key` in the manifest anyway.** With a `key`, the ID no longer depends on the folder path, so a user who loads a new folder still gets the same ID. They must load it in place of the old copy, not remove the old copy first: removing the extension deletes its `chrome.storage`.
- **Re-register content scripts on every update.** Chromium clears an extension's registered content scripts when it installs an update, and a reload counts as an update **(from source)**. Re-register them from `runtime.onInstalled`, which also fires on reload.
- **No other route avoids both the Web Store and policy on ChromeOS.** Self-hosted `.crx` + `update_url` is supported only on desktop Linux. Windows and macOS block off-store installs, and ChromeOS has no documented equivalent.

## 1. Does `update_url` / `requestUpdateCheck` do anything for an unpacked extension?

No.

- Chromium's updater drops every extension whose install location is not auto-updatable. In `ExtensionUpdater::EraseUnupdatableIds`, the comment is "Remove extensions that aren't in an autoupdatable location" and the check is `!Manifest::IsAutoUpdateableLocation(extension->location())`. ([extension_updater.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/updater/extension_updater.cc))
- `IsAutoUpdateableLocation` returns true only for `kInternal` (Web Store / CRX installs) and external (policy, preferences file, registry) locations: "Only internal and external extensions can be autoupdated." Unpacked extensions have location `kUnpacked` (or `kCommandLine` for `--load-extension`), so they are never updated. ([manifest.h](https://chromium.googlesource.com/chromium/src/+/main/extensions/common/manifest.h))
- `update_url` in the manifest only tells the updater *where* to look. Unpacked extensions are dropped before that step, so the field does nothing.
- `chrome.runtime.requestUpdateCheck()`: the delegate queues a check and reports `no_update` when the updater finds nothing, or `throttled` under backoff ([chrome_runtime_api_delegate.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/runtime/chrome_runtime_api_delegate.cc), [runtime_api.cc](https://chromium.googlesource.com/chromium/src/+/main/extensions/browser/api/runtime/runtime_api.cc)). Because the unpacked ID is erased from the update set, the expected result is always `no_update` or `throttled`, never `update_available` **(from source, not run on a device)**.
- `chrome.runtime.onUpdateAvailable` fires only when the updater has downloaded an update ([runtime API docs](https://developer.chrome.com/docs/extensions/reference/api/runtime)), so it never fires for an unpacked extension.

## 2. Can the extension detect a newer GitHub Release and tell the user?

Yes. This is ordinary app code.

- `GET /repos/{owner}/{repo}/releases/latest` returns the newest published release that is not a draft or prerelease ([GitHub REST: releases](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)). Read `tag_name` and the zip asset's `browser_download_url`.
- "The REST API supports cross-origin resource sharing (CORS) for AJAX requests from any origin" ([GitHub CORS docs](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests)), so the extension needs no host permission for `api.github.com` **[unverified on a device]**.
- "The primary rate limit for unauthenticated requests is 60 requests per hour", counted per IP ([GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)). One check a day per display is well under it, even with several displays on one home IP.
- Compare the tag with `chrome.runtime.getManifest().version` and show a "new version available" banner in the display UI. The extension can open the release page with `chrome.tabs.create`, but it cannot install the update. Tags must stay in step with `manifest.json` `version` for the comparison to work.

## 3. What the user must do, and what survives

### Option A (recommended): replace the files in the same folder, then reload

1. Download the release zip and extract it **over the existing folder**, replacing the files.
2. Reload: click the refresh icon on chrome://extensions, or use a "Reload now" button in the extension that calls `chrome.runtime.reload()`.

- The Chrome docs require a reload after changes to the manifest, service worker or content scripts ([Hello World tutorial](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)).
- "When an unpacked extension is reloaded, this is treated as an update. This includes when the extension is reloaded with `runtime.reload()`", and `onInstalled` fires with reason `update` ([runtime API docs](https://developer.chrome.com/docs/extensions/reference/api/runtime)).
- `chrome.runtime.reload()` reloads in place **(from source)**. Chromium terminates an extension that reloads too often in a short window, so call it once only.
- The path and ID do not change, so state keyed to the ID stays.

### Option B: load a new folder

- Without a `key`, the ID of an unpacked extension is derived from its folder path **[unverified: standard Chromium behaviour, not in the docs fetched]**, so a new folder gets a **new ID**. A new ID means new, empty storage, a new origin with no camera grant, and no host permission. Everything has to be set up again.
- With a `key` in the manifest, "the extension will use the same ID" ([manifest `key` docs](https://developer.chrome.com/docs/extensions/reference/manifest/key)). Loading a second folder that has the same ID replaces the installed copy, as an update **[unverified]**. Test this on a Chromebook before relying on it.
- **Do not remove the old copy first.** `chrome.storage.local` is "cleared when the extension is removed" ([storage docs](https://developer.chrome.com/docs/extensions/reference/api/storage)).

### What survives an update or reload (same ID)

| State | Survives update or reload? | Basis |
|---|---|---|
| `chrome.storage.local` (server URL) | Yes. Cleared only when the extension is removed. Survives users clearing browsing data. | [storage docs](https://developer.chrome.com/docs/extensions/reference/api/storage) |
| Camera grant (offscreen document) | Yes, if the ID is unchanged. It is a content setting for the `chrome-extension://<id>` origin, so a new ID loses it. | **[unverified]** |
| Optional host permission (one http LAN origin) | Yes, if the ID is unchanged. Granted permissions are stored per ID. | **[unverified]** |
| New *required* permission that triggers a warning | Chrome docs say "the extension will be disabled until the user accepts the new permission". The docs do not say whether this applies to unpacked reloads. Keep such permissions optional. | [permission warnings](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings) |
| Dynamically registered content scripts | **No (from source).** `UserScriptManager::OnExtensionWillBeInstalled` calls `scripting::ClearPersistentScriptURLPatterns` on every install, update or not. Re-register them in `runtime.onInstalled`. | [user_script_manager.cc](https://chromium.googlesource.com/chromium/src/+/main/extensions/browser/user_script_manager.cc) |

The docs do not say whether `registerContentScripts` scripts survive an update ([scripting docs](https://developer.chrome.com/docs/extensions/reference/api/scripting) only say `persistAcrossSessions` defaults to true). Re-registering on `onInstalled` is safe either way. Check with `getRegisteredContentScripts()` first to avoid duplicate-ID errors.

## 4. Routes that avoid the Web Store and policy

- **Self-hosted CRX + `update_url`:** "Linux is the only platform where Chrome users can install extensions that are hosted outside of the" Web Store ([host on Linux](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux)). Updates must also be signed with the same key.
- **External install (preferences file / registry):** the preferences file works only on macOS and Linux, and the registry only on Windows. On Windows and macOS the `update_url` must point to the Web Store, and local CRX paths are blocked (Chrome 33 on Windows, Chrome 44 on macOS) ([install-extensions docs](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)). The page does not mention ChromeOS. On a consumer Chromebook the browser's system folders cannot be written to, so this route is not available **[unverified]**.
- **Enterprise policy (`ExtensionInstallForcelist`, self-hosted update URL):** out of scope.
- **The extension writes its own files:** an extension page could ask the user for the extension's folder with the File System Access API (`showDirectoryPicker`), write the new files into it, then call `chrome.runtime.reload()`. This would make updating one click plus one folder pick. It is untested, depends on ChromeOS allowing write access to that folder, and needs a zip decoder. **[unverified]**, and only worth a prototype if manual updates prove painful.

So with Load unpacked, the realistic path is: the extension detects the release, the user downloads and extracts the zip over the same folder, and the extension reloads itself.

## Implications for the Extension build

1. Add a fixed `key` to `manifest.json` so the ID never depends on the folder path.
2. Tell users to keep one fixed folder (for example `Downloads/gocasa-display`) and to extract each release over it. Never remove and re-add the extension.
3. Add a once-a-day release check against the GitHub API, with a banner and a "Reload now" button (`chrome.runtime.reload()`).
4. In `runtime.onInstalled` (reason `update`), re-register the dynamic content scripts and re-check the camera grant and host permission.
5. Keep new host permissions optional, so an update never disables the extension.
