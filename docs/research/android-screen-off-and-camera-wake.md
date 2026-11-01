# Android screen-off that keeps Camera wake alive

Research for issue #4. Question: which ways of turning the screen off really cut the backlight, does CameraX keep delivering frames while the screen is off or locked, what permissions each needs, and does it work on LineageOS without Play Services?

Sources are AOSP `main` (fetched 2026-11-01) and developer.android.com. Anything marked **[unverified]** has no primary source behind it and should be checked on real hardware.

## Answer

- **Only a real "sleep" turns the backlight off.** An app can trigger one in two ways: `DevicePolicyManager.lockNow()` (device admin) or a short `Settings.System.SCREEN_OFF_TIMEOUT` (`WRITE_SETTINGS`). Setting a window's brightness to 0 does not turn the backlight off. It is clamped to the panel's minimum brightness.
- **When the screen sleeps, the Activity no longer counts as foreground for the camera.** CameraX bound to the Activity closes the camera. The camera service also blocks the app once its UID goes idle. To keep frames coming, run CameraX inside a **foreground service of type `camera`**, started while the Activity is still visible, and bind it to the service's lifecycle instead of the Activity's.
- **Recommendation:** use a `camera` foreground service that owns CameraX (a `LifecycleService` as the `LifecycleOwner`), plus `lockNow()` to turn the screen off. If the user won't enable device admin, fall back to a short screen timeout. To wake the screen, acquire a wake lock with `ACQUIRE_CAUSES_WAKEUP` and show the Activity with `setShowWhenLocked(true)` and `setTurnScreenOn(true)`.
- **None of this uses Play Services.** All of these are AOSP framework APIs, and CameraX is an AndroidX library.

## 1. Screen-off methods

| Method | Backlight really off? | Permission | Notes |
|---|---|---|---|
| `DevicePolicyManager.lockNow()` | **Yes.** It puts the device to sleep. | Active device admin that declares `<force-lock/>` (`USES_POLICY_FORCE_LOCK`). The user activates it once in Settings. | If no lock screen is set, "this method forces the device to go to sleep but doesn't lock the device" (DPM Javadoc). It does not turn the screen off on automotive builds. |
| `Settings.System.SCREEN_OFF_TIMEOUT` set low | **Yes**, once the timeout expires and nothing holds the screen on. | `WRITE_SETTINGS`, a special app-op permission the user grants via `ACTION_MANAGE_WRITE_SETTINGS`. | This is a global setting, so save the old value and restore it. The screen goes off only after the delay, not on demand. `FLAG_KEEP_SCREEN_ON` and screen wake locks must be released first. The platform enforces a minimum timeout **[unverified: believed to be about 10 s via `config_minimumScreenOffTimeout`]**. |
| Window `screenBrightness = 0` (`BRIGHTNESS_OVERRIDE_OFF`) behind a black overlay | **No.** The Javadoc says it sets the backlight "to the lowest value", and `DisplayPowerController.clampScreenBrightness()` clamps to `getCurrentBrightnessMin()`. | None | The panel stays on at minimum brightness and the Activity stays `TOP`, so the camera keeps working with no service. Whether a given panel's minimum looks fully dark depends on the device **[unverified]**. |
| `PowerManager.goToSleep()` | Yes | `DEVICE_POWER`, signature-only, and the method is `@removed` | Not available to us. |
| `PROXIMITY_SCREEN_OFF_WAKE_LOCK` | Only while the proximity sensor reports "near" | `WAKE_LOCK` | It can't be triggered on demand. Not usable. |

Sources:
- `DevicePolicyManager.lockNow()` Javadoc: [DevicePolicyManager.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/app/admin/DevicePolicyManager.java) and [reference](https://developer.android.com/reference/android/app/admin/DevicePolicyManager#lockNow()). The `LOCK_DEVICE` permission it mentions is `signature|privileged` ([core/res/AndroidManifest.xml](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/res/AndroidManifest.xml)), so a third-party app must use the device-admin route.
- `SCREEN_OFF_TIMEOUT` ("before the device goes to sleep or begins to dream") and `canWrite()`: [Settings.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/provider/Settings.java). `WRITE_SETTINGS` is `signature|preinstalled|appop|pre23|role` (core manifest).
- `BRIGHTNESS_OVERRIDE_OFF` and `screenBrightness`: [WindowManager.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/view/WindowManager.java). Clamping: `clampScreenBrightness()` in [DisplayPowerController.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/display/DisplayPowerController.java).
- `goToSleep` and `PROXIMITY_SCREEN_OFF_WAKE_LOCK`: [PowerManager.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/os/PowerManager.java).

## 2. Does the camera keep delivering frames?

The camera is cut off by three separate mechanisms. All three must be avoided.

1. **CameraX lifecycle.** CameraX "observes a lifecycle to determine when to open the camera ... and when to stop and shut down" ([CameraX architecture](https://developer.android.com/media/camera/camerax/architecture)). When the screen sleeps, the Activity is stopped: the `setTurnScreenOn` Javadoc says "an activity will be transitioned to the stopped state if it is started while the screen is off" ([Activity.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/app/Activity.java)). That closes the camera if CameraX is bound to the Activity. The docs allow a custom or decoupled `LifecycleOwner`; a service's lifecycle is one. The exact rule (open on `ON_START`, close on `ON_STOP`) is commonly documented but I could not quote it from the `ProcessCameraProvider` reference **[unverified wording]**.
2. **UID idle → camera service blocks clients.** While the device sleeps, a top app's process state is `TOP_SLEEPING` (12) ([ProcessStateEnum.aidl](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/app/ProcessStateEnum.aidl)). `ActivityManager.isProcStateBackground()` treats any state `>= TRANSIENT_BACKGROUND` (8) as background ([ActivityManager.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/app/ActivityManager.java)). When the UID goes idle, `CameraService::UidPolicy::onUidIdle()` calls `blockClientsForUid(uid)` ([CameraService.cpp](https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/services/camera/libcameraservice/CameraService.cpp)). This is the "Android 9: your app cannot access the microphone or camera" in the background rule ([Android 9 behavior changes](https://developer.android.com/about/versions/pie/android-9.0-changes-all)). A foreground service is `FOREGROUND_SERVICE` (4), which is not background, so the UID stays active.
3. **Camera app-op (while-in-use).** If the camera op comes back soft-denied, `CameraService` checks `procState <= PROCESS_STATE_BOUND_TOP`. If the app is not visible it calls `block()`, which disconnects the client (CameraService.cpp, op-change handling). A `camera`-type foreground service is the documented way to "continue to access the camera from the background" ([FGS types](https://developer.android.com/develop/background-work/services/fgs/service-types)).

**Per method:**

| Method | Activity-bound CameraX | CameraX in a `camera` FGS |
|---|---|---|
| `lockNow()` | Stops. The Activity is stopped and the UID goes to `TOP_SLEEPING` and then idle. | **Keeps running.** The UID stays at `FOREGROUND_SERVICE`. **[unverified on hardware: some camera HALs or vendor kernels may suspend on display off]** |
| Short screen timeout | Stops (same sleep path) | **Keeps running** (same as above) |
| Brightness 0 overlay | **Keeps running.** The Activity stays resumed and `TOP`, but the backlight is still on. | Keeps running |

**FGS rules** ([FGS types](https://developer.android.com/develop/background-work/services/fgs/service-types), [background-start restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)):
- Manifest: `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_CAMERA` (both `normal`, granted at install), plus `android:foregroundServiceType="camera"`. Pass `FOREGROUND_SERVICE_TYPE_CAMERA` to `startForeground()`. The `CAMERA` runtime permission must already be granted.
- The service "cannot [be] create[d] ... while the app is in the background", and it can't be launched from `BOOT_COMPLETED`. Start it while the WebView Activity is visible, **before** calling `lockNow()`. On Android 14+ a violation throws immediately. The while-in-use exemptions cover device **owner** mode, but **not** a plain device admin and not `SYSTEM_ALERT_WINDOW`.
- The service must show an ongoing notification.

## 3. Waking the screen back up

- `Activity.setShowWhenLocked(true)` and `setTurnScreenOn(true)` turn the screen on when the Activity resumes. They do **not** wake a sleeping device on their own, because the Activity has to be started first.
- `PowerManager` wake lock with `ACQUIRE_CAUSES_WAKEUP` (with `SCREEN_BRIGHT_WAKE_LOCK`/`FULL_WAKE_LOCK`) from the service: both are deprecated but still present. The Javadoc says it "will require `TURN_SCREEN_ON` in future releases". `TURN_SCREEN_ON` is `signature|privileged|appop` and "intended to only be used by home automation apps" (core manifest). When it is enforced, the user has to grant the app-op **[unverified: which Android version enforces it]**.
- Starting the Activity from the service while the app is in the background is subject to background-activity-start limits. A full-screen-intent notification or the `SYSTEM_ALERT_WINDOW` exemption is the usual route **[not researched here; follow-up]**.
- If a secure lock screen is set, `lockNow()` locks the device and the Wall needs `showWhenLocked`. On a Wall tablet with no lock screen set, `lockNow()` only sleeps the device.

## 4. LineageOS without Play Services; Chromebook

- Everything above is AOSP framework (`DevicePolicyManager`, `Settings`, `PowerManager`, `CameraService`) or AndroidX (CameraX, `LifecycleService`). None of it touches Google Play services, so it should behave the same on LineageOS. LineageOS ships without Google apps by default **[unverified: wiki.lineageos.org returned 403]**. CameraX's own dependencies being GMS-free is also **[unverified against its POM]**, but it is a Jetpack library and not part of Play services.
- Device admin activation works through the standard Settings UI (`ACTION_ADD_DEVICE_ADMIN`). It needs no GMS.
- **Chromebook (ARCVM):** whether `lockNow()` or the Android screen timeout controls the ChromeOS display, and whether ARC lets a camera FGS run with the lid or screen off, is **[unverified]**. No primary source was found. Needs a hardware test.

## Open items to test on hardware

1. LineageOS tablet: `lockNow()` with a `camera` FGS. Do CameraX `ImageAnalysis` frames keep arriving for 10+ minutes with the screen off?
2. The same with a short `SCREEN_OFF_TIMEOUT`.
3. The brightness-0 overlay: how dark does the panel actually get?
4. Chromebook ARCVM: the same three tests.
