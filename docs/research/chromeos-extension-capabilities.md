# ChromeOS extension capabilities on a consumer Chromebook

Research for issue #5. Question: on an **unmanaged** ChromeOS device (for example an HP Chromebase, no Kiosk & Signage licence), can the ChromeOS extension build of the Display app do what the Wall display needs?

Sources are primary: developer.chrome.com, Chromium source (`chromium/chromium` mirror, `main`, read 2026-11-01), the GoogleChrome samples repo, and Google support pages. Items marked **Unverified** have no primary source saying so and need a test on a real device.

## Short answer

| Sub-question | Answer |
|---|---|
| Offscreen document uses the camera | **Yes, with a one-time grant.** The offscreen document cannot show the permission prompt itself. A visible extension page must call `getUserMedia` once so the user grants camera access to the extension origin; after that the offscreen document can open the camera. |
| `chrome.power` holds and wakes the panel | **Yes.** `requestKeepAwake` is available to any extension on stable with the `power` permission and is held by the browser until released or the extension unloads. `reportActivity` is ChromeOS-only (Chrome 113+) and wakes a dimmed or off screen. Neither needs policy. |
| Plain-HTTP LAN IP page talks to the extension via `externally_connectable` | **Yes.** `matches` takes any valid URL pattern, including `http://` and IP hosts. The page-side `runtime.sendMessage`/`connect` are exposed to `web_page` contexts with no secure-context requirement. |
| Consumer installs web app and extension without policy | **Yes.** Extension: Chrome Web Store (Unlisted is enough) or Developer mode "Load unpacked". Web app: "Install page as app" works on any page; whether it works for a plain-HTTP origin on ChromeOS is **Unverified**. |

## 1. Camera in an offscreen document

- `chrome.offscreen` has the `USER_MEDIA` reason: "the offscreen document needs to interact with media streams from user media (e.g. `getUserMedia()`)". Only `AUDIO_PLAYBACK` has a lifetime limit (30 s without audio); other reasons do not. One offscreen document per extension at a time. Source: <https://developer.chrome.com/docs/extensions/reference/api/offscreen>
- The `offscreen` permission is stable for `extension` type, MV3 only, with no policy dependency. Source: `extensions/common/api/_permission_features.json` ("offscreen").
- The offscreen document **cannot show a permission prompt**. Google's own sample (merged July 2026) states: "getUserMedia in an offscreen document cannot show a permission prompt, so a regular extension page opened in a tab grants mic access to the extension origin first". Source: GoogleChrome/chrome-extensions-samples PR #1717 (`functional-samples/cookbook.offscreen-user-media`), which closed issue #821. In #821, calls made before the grant failed with `NotAllowedError: Failed due to shutdown`.
- The sample does microphone. **Camera is inferred**, not shown: camera and mic use the same per-origin media permission, so the same grant flow should apply. Verify on device.
- Caveats from #821 (community reports, not official): if the user picks "Allow this time", the grant ends when the page closes; if they pick "Don't allow", the prompt will not come back and they must fix it in the extension's site settings. The setup flow must ask the user to choose "Allow on every visit".
- The offscreen document only gets `chrome.runtime` messaging (context `offscreen_extension`). `chrome.power` is `privileged_extension` only, so motion detected in the offscreen document must be messaged to the service worker, which calls `chrome.power`. Source: `extensions/common/api/_api_features.json` ("power", "offscreen").

## 2. `chrome.power` keep-awake and wake

Source for API text: <https://developer.chrome.com/docs/extensions/reference/api/power>

- `requestKeepAwake(level)`: "Requests that power management be temporarily disabled." Levels: `system` ("Prevents the system from sleeping in response to user inactivity") and `display` ("Prevents the display from being turned off or dimmed, or the system from sleeping...").
- `reportActivity()`: "Reports a user activity in order to awake the screen from a dimmed or turned off state or from a screensaver." Chrome 113+, ChromeOS only.
- Availability: the `power` permission is stable for `extension`, `legacy_packaged_app` and `platform_app`, no policy dependency; `power.reportActivity` is restricted to `platforms: ["chromeos"]`. Source: `_permission_features.json` ("power"), `_api_features.json` ("power.reportActivity").
- Lifetime: in `extensions/browser/api/power/power_api.cc` the wake lock is held by the browser-side `PowerAPI` keyed service (`display` maps to `kPreventDisplaySleep`, `system` to `kPreventAppSuspension`) and is cancelled on `releaseKeepAwake` or `OnExtensionUnloaded`. So it does not depend on the MV3 service worker staying alive.
- Design that fits the Wall display: hold `system` so the device stays awake and JS keeps running while the panel is allowed to dim or turn off; on motion, call `reportActivity()` to turn the panel back on. Hold `display` instead to keep the panel always on.
- **Unverified:** whether waking with `reportActivity` after an idle screen-off shows the ChromeOS lock screen. That depends on the user's "Show lock screen when waking from sleep" setting and was not confirmed from a primary source. Test on device.
- **Unverified:** behaviour if the system has actually suspended. `reportActivity` cannot run then, since no JS runs; the `system` lock is what prevents that.

## 3. `externally_connectable` from a plain-HTTP LAN IP page

- `matches` patterns are parsed with `URLPattern(URLPattern::SCHEME_ALL)` and accepted if they parse. No secure-scheme, eTLD or IP-host check remains. Source: `extensions/common/manifest_handlers/externally_connectable.cc`.
- The broad-host restriction was removed in Chromium commit `e9175bad72` (2022-09-15, "[Extensions] Allow externally-connectable on all domains"), which says the old restriction "is preventing any capability".
- So `"matches": ["http://192.168.1.50:8080/*"]` is valid. URL patterns allow only a leading `*.` host wildcard, so a whole subnet such as `192.168.1.*` cannot be matched. Options are to list the server's IP, or use `http://*/*` (now allowed), which exposes the extension to every site and so needs sender checks in `onMessageExternal`.
- Page side: `runtime.sendMessage` and `runtime.connect` list `web_page` among their contexts with `"matches": ["<all_urls>"]` and no secure-context flag. Source: `_api_features.json`. Messaging guide: <https://developer.chrome.com/docs/extensions/develop/concepts/messaging>. The manifest docs (<https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable>) do not state any HTTPS requirement.
- **Unverified end to end** on ChromeOS with an HTTP IP origin; the source supports it, but nothing was run.

## 4. Consumer install without policy

- Extension, option A: Chrome Web Store with **Unlisted** visibility, which "allows anyone to install your item if they know its Chrome Web Store URL". Source: <https://developer.chrome.com/docs/webstore/cws-dashboard-distribution>. Needs a developer account and review.
- Extension, option B: `chrome://extensions` > Developer mode > Load unpacked. Source: <https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world>. **Unverified from a ChromeOS-specific primary doc** (the tutorial is not platform-specific); expected to work on an unmanaged device since no policy is set. This is Chrome's developer mode, not ChromeOS developer mode, so no powerwash or OS verification change.
- Self-hosted `.crx` installs from outside the store: no primary source found saying a consumer ChromeOS device allows them; assume not.
- Web app: PWA installability (the automatic Install prompt) requires HTTPS. Source: <https://web.dev/articles/install-criteria>. That page adds that "Users can install your web app even if it doesn't meet the PWA installability criteria". The manual path is More > Cast, save, and share > **Install page as app**. Sources: <https://developer.chrome.com/blog/how_chrome_helps_users_install_the_apps_they_value>, <https://support.google.com/chromebook/answer/9658361>.
- **Unverified:** that "Install page as app" is offered for a plain-HTTP LAN IP origin on ChromeOS and opens in its own window. Test on device. Fallback: the extension opens the Wall page itself (for example `chrome.windows.create` with a full-screen window), so no web-app install is needed.
- Installing a web app or extension does not grant Wake Lock or other secure-context APIs to the HTTP page. That is why keep-awake has to live in the extension.

## Open items to test on a Chromebase

1. Camera grant from an extension tab, then `getUserMedia({video: true})` in the offscreen document, survives reboot.
2. `system` keep-awake plus `reportActivity()` turns the panel on from off, and whether the lock screen appears.
3. `chrome.runtime.sendMessage(extId, ...)` from `http://<LAN IP>:<port>` reaches `onMessageExternal`.
4. "Install page as app" offered for the HTTP origin.
