# View Assist Companion App as a reference

Reference for [Map: Display app v1](https://github.com/DeRusto/gocasa-android/issues/3). [View Assist Companion App](https://github.com/msp1974/ViewAssistCompanionApp) (VACA) is an open-source Android app that turns a tablet into a Home Assistant wall display: a WebView dashboard plus a voice satellite, with screen control and camera motion wake. It ships as a sideloaded APK, like the Display app. This note records what it does that bears on our open decisions.

Source read: VACA at commit [`5b42d23`](https://github.com/msp1974/ViewAssistCompanionApp/tree/5b42d23) (2026-10-31), its wiki, and its Home Assistant integration ([msp1974/ViewAssist_Companion_App](https://github.com/msp1974/ViewAssist_Companion_App)). Only the screen, camera, motion, service, WebView, bridge, discovery, permission and update code was read. Voice, audio, Bluetooth proxy, media and RTSP code was skipped. Large files (`MainActivity.kt`, the camera classes) were read by search and skim, not line by line.

**License:** Apache 2.0 (`LICENSE`, `NOTICE`). Code can be reused with its notice kept.

Paths below are relative to `app/src/main/java/com/msp1974/vacompanion/`.

## Answer

- VACA confirms the [Android screen-off mechanism](https://github.com/DeRusto/gocasa-android/issues/8) decision: `lockNow()` with device admin, a black-overlay mode, a dim mode, a wake lock to wake, a `camera` foreground service, and being the Home app.
- Two things that decision doesn't cover: VACA holds a **`PARTIAL_WAKE_LOCK` while the screen is off**, and it **uses raw Camera2, not CameraX**, because CameraX rejects some devices' cameras.
- VACA's control channel is **server → device over TCP**, not through the page. The device advertises itself over mDNS and the server connects to it. That is the reverse of the current discovery plan and an alternative for the bridge.
- Its self-updater (GitHub Releases API → download → system installer) fits our distribution as is.
- It has **no ChromeOS-specific code**, so it says nothing about ARCVM.

## 1. Screen control

`device/ScreenUtils.kt` has four modes (`enum class ScreenOnMode { ON, ON_DIM, ON_DARK, OFF }`):

| VACA mode | What it does | Our equivalent |
|---|---|---|
| `ON` | User's brightness, timeout and always-on settings; then `wakeScreen()` | Wall display awake |
| `ON_DIM` | Keep screen on, auto-brightness off, window brightness `0.01` | Night mode, dim clock |
| `ON_DARK` | Same as `ON_DIM` plus a black overlay (`ui/layouts/BlackScreen.kt`) | Night mode, black overlay fallback |
| `OFF` | Device admin active: `PARTIAL_WAKE_LOCK`, then `lockNow()`. Otherwise it fakes sleep: partial wake lock, overlay, `SCREEN_OFF_TIMEOUT` set to 1000 ms, waits up to 15 s for `Display.STATE_OFF`, then restores timeout and brightness | Night mode, real off |

- **Partial wake lock while off.** `setPartialWakeLock()` runs before `lockNow()` and is held until the next wake. A foreground service keeps the process from being killed, but it doesn't keep the CPU from suspending. The [screen-off research](https://github.com/DeRusto/gocasa-android/blob/research/android-screen-off/docs/research/android-screen-off-and-camera-wake.md) didn't cover this. **Add it to the build.**
- **Wake** (`wakeScreen()`): on the Activity, `setTurnScreenOn(true)` and `setShowWhenLocked(true)`. Then a 500 ms `FULL_WAKE_LOCK | ACQUIRE_CAUSES_WAKEUP | ON_AFTER_RELEASE` wake lock.
- **Device admin** (`DeviceAdminReceiver.kt`, `res/xml/device_owner_receiver.xml`): declares only `<force-lock/>`.
- **Keyguard:** `service/ForegroundService.kt` calls the deprecated `KeyguardManager.newKeyguardLock(...).disableKeyguard()` (manifest declares `DISABLE_KEYGUARD`). This is an alternative to telling the user to set the lock screen to None. It only works on a non-secure keyguard **[unverified on current Android versions]**.
- **Motion wake runs in the Activity, not the service.** `MainActivity.onMotion()` calls `applyScreenMode(ON)`, so the Activity must still exist, stopped, while the screen is off. A watchdog in `service/ForegroundService.kt` relaunches `MainActivity` with `FLAG_ACTIVITY_NEW_TASK` every 5 s if it isn't running; being the Home app makes that background start allowed. Our decision has the service start the Wall Activity on motion, which also covers the case where the Activity has died.
- **First screen-off waits for the page.** `MainActivity.waitForWebViewLoadStarted()` waits until the page has loaded, then shows `ON_DIM` for 6 s, before turning the screen off. Its comment says a WebView hidden mid-load gets throttled and stays half-loaded.
- **Debounce:** screen on/off requests within 5 s of the last one are delayed 2 s (`handleScreenOnChange`).
- The wiki notes brightness `0` turns some screens off and only dims others, and that many devices disable the touchscreen while asleep. That is why VACA adds proximity and bump wake.

## 2. Camera and motion detection

- **Camera2, not CameraX.** `device/camera/Camera2DirectSource.kt`: "CameraX's own enumeration rejects some devices' cameras that open fine this way" (seen on the Facebook Portal and Echo Show 5). One capture session feeds an analysis `ImageReader` and any preview outputs.
- **Opening the camera can block for seconds** on some devices, so start and stop run off the main thread.
- **"Opens but no frames" is detected.** The completed-frame rate is checked once the session is active. If frames don't arrive, `CameraController.onNoVideo()` releases the camera, reports `NO_VIDEO`, and retries later.
- **Low light:** exposure is boosted on the analysis-only path (`CameraController.rebindSource`).
- **Motion detection** (`device/camera/MotionDetector.kt`, `device/MotionDetectionEngine.kt`):
  - Frames are analysed at 4 fps (`TARGET_ANALYSIS_FPS`), luma only, downsampled.
  - Each frame is compared with a slowly learned background, and changed pixels are grouped into blobs.
  - The 0–100 sensitivity setting maps to a luma threshold of 50 → 5, a minimum blob size of 64 → 4 px, and a background learning rate of 0.2 → 0.1.
  - Detection ignores the first 5 s after start (1.5 s for face mode), and a detection holds for 5 s after motion stops (`MOTION_INTERVAL_TIMEOUT`).
  - Modes are `none`, `motion` and `face`. Face mode uses Google ML Kit face detection. Whether VACA uses the bundled model, which doesn't need Play Services, was **[not checked]**.
- **Orientation:** sensor orientation is wrong on some devices. `device/camera/CameraOrientation.kt` derives rotation from the display instead, and `DeviceCameraQuirks.kt` lists per-model exceptions.
- **Foreground service types** are computed at run time (`foregroundServiceTypes()`): `camera` only if the device has a front camera and the permission is granted. When the camera permission arrives later, the service calls `startForeground` again with the new types, so no restart is needed. The service returns `START_STICKY`.

## 3. Discovery and the control channel

- **The device advertises; the server connects.** `wyoming/Zeroconf.kt` registers `_vaca._tcp` named `vaca-<uuid>` with `NsdManager`. Home Assistant discovers it (`config_flow.py` `async_step_zeroconf` in the integration) and connects to the device's TCP server. The device pairs with the first server IP that starts a session and rejects others (VACA `CLAUDE.md`).
- **Control goes over that TCP connection, not the page.** Home Assistant sends JSON `settings` and `action` events: screen on/off, brightness, timeout, always-on, motion mode and sensitivity, screensaver and so on (`custom.py`, `switch.py`, `select.py`, `number.py` in the integration). The device reports sensors and motion back the same way.
- **The page bridge is small** (`jsinterface/JavascriptInterface.kt`): `ViewAssistApp.getViewAssistCAUUID()`, `ViewAssistApp.sendEvent(event, data)` (only logs today), and Home Assistant's `externalApp` auth hooks. Native → page uses `evaluateJavascript`.

Bearing on our tickets:
- [Server discovery design](https://github.com/DeRusto/gocasa-android/issues/10): the reverse direction is an option, with the Display app advertising and GoCasa finding Wall displays. It also shows `NsdManager` registration working across many kiosk devices.
- [Bridge between the page and the Display app](https://github.com/DeRusto/gocasa-android/issues/11): VACA's precedent is server → device, not page → device. Night mode commands and the motion-wake report could take either route.

## 4. WebView

From `utils/CustomWebView.kt`, `utils/CustomWebViewClient.kt` and `utils/CustomWebChromeClient.kt`:

- Settings: JavaScript and DOM storage on, `mediaPlaybackRequiresUserGesture = false`, `mixedContentMode = MIXED_CONTENT_ALWAYS_ALLOW`, `safeBrowsingEnabled = false`, renderer priority important, hardware layer. The manifest sets `usesCleartextTraffic="true"` for HTTP on the LAN.
- `onRenderProcessGone` reloads the page; if that fails, the Activity rebuilds the WebView.
- `onReceivedError` loads a bundled `file:///android_asset/web/error.html`.
- `onReceivedSslError` asks the user, with an "always" option for self-signed certificates.
- `onPermissionRequest` gives the page camera and microphone access only when the app already holds those permissions.

## 5. Permissions and setup

From `utils/Permissions.kt` and `MainActivity`:

- **Core, asked at start:** microphone, plus notifications on Android 13+.
- **Optional:** camera (if there is a front camera), `WRITE_SETTINGS`, notification-policy access, and device admin. Device admin is prompted at startup with `ACTION_ADD_DEVICE_ADMIN`. `WRITE_SETTINGS` uses `ACTION_MANAGE_WRITE_SETTINGS`.
- Firebase is initialised only when Play Services is present, because on devices without it the default init retries for seconds on every launch (manifest comment). This is a reminder to keep Google dependencies optional.

## 6. Updates and start on boot

- **Self-update** (`utils/Updater.kt`):
  - It reads the latest GitHub Release through the GitHub API and compares versions.
  - It downloads the APK with `DownloadManager` and installs it through `FileProvider` and an `application/vnd.android.package-archive` intent (`REQUEST_INSTALL_PACKAGES`).
  - The server can require a minimum app version, which prompts an update before connecting.
  - This bears on "Updates for a sideloaded APK" on the map.
- **No boot receiver.** VACA starts on boot by being the Home app (`MAIN` + `LAUNCHER` + `HOME` on a `singleTask` Activity).

## 7. ChromeOS

No ChromeOS or ARC code or checks anywhere in the files read. VACA gives no evidence for the [Chromebase hardware test in ARCVM](https://github.com/DeRusto/gocasa-android/issues/7) or [What Chromebooks get: APK or extension build](https://github.com/DeRusto/gocasa-android/issues/9). Sideloading VACA's release APK on the Chromebase could still be a quick first look at what ARCVM allows.
