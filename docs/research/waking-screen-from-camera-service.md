# Waking the screen from a Camera wake foreground service

Research for issue #13. It follows [Android screen-off that keeps Camera wake alive](https://github.com/DeRusto/gocasa-android/blob/research/android-screen-off/docs/research/android-screen-off-and-camera-wake.md) (#4). That research settled on CameraX running in a `camera`-type foreground service and `DevicePolicyManager.lockNow()` to turn the screen off.

Question: when that service sees motion while the device is asleep, how does it turn the screen on and bring the Wall display back in front of the lock screen, given Android's background-activity-start (BAL) limits? Which APIs work on LineageOS with no Play Services, and what does each need? Does the keyguard have to be disabled?

Sources are AOSP `frameworks/base` `main` (fetched 2026-11-01) and developer.android.com. Anything marked **[unverified]** has no primary source behind it and should be checked on hardware.

## Answer

- **A foreground service on its own may not start an Activity.** No FGS exemption appears in `BackgroundActivityStartController`, and the developer docs don't list one either. The service needs its app to qualify for some other exemption.
- **Recommended: make the Display app the default Home app** (it declares a `CATEGORY_HOME` activity and the user picks it once). AOSP exempts the home app from BAL unconditionally (`// Always allow home application to start activities.`). The Wall Activity declares `showWhenLocked` and `turnScreenOn`. On motion, the service calls `startActivity()` on it. That launch turns the screen on and shows the Wall over the keyguard. It needs no special permission and no Play Services. It also gives you auto-start after reboot for free.
- **Belt and braces:** also take a short `SCREEN_BRIGHT_WAKE_LOCK | ACQUIRE_CAUSES_WAKEUP` (permission `WAKE_LOCK`, normal). AOSP `main` only *requires* `TURN_SCREEN_ON` for apps targeting a future SDK (`@EnabledSince(CUR_DEVELOPMENT)`), so today it works without that permission. Declare `TURN_SCREEN_ON` in the manifest anyway.
- **Fallbacks if Home is not possible** (e.g. the Chromebook): user-granted `SYSTEM_ALERT_WINDOW`, which is a BAL exemption, or a full-screen-intent notification. Device owner also works but is overkill.
- **The keyguard does not need to be disabled.** A `showWhenLocked` activity is shown even over a *secure* keyguard (`canShowWhileOccluded` returns `showWhenLocked || ...`). For a seamless Wall, set the lock screen to **None**. Then `lockNow()` only sleeps the device and nothing needs occluding. **Swipe** also works. A **PIN** works for showing the Wall but makes leaving the Wall (Settings, other apps) ask for the PIN.

## 1. Why the service can't just call `startActivity()`

`BackgroundActivityStartController.checkBackgroundActivityStartAllowedByCallerInBackground()` ([source](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/wm/BackgroundActivityStartController.java)) allows a background caller only if one of these holds:

| Exemption (in source order) | Reachable for us? |
|---|---|
| root / system / NFC UID | No |
| **Home app** (`isHomeApp()`, i.e. uid matches `mHomeProcess`, or package is `getDefaultHomeActivity()`) | **Yes.** The user sets the Display app as the default Home app. |
| Current IME | No |
| Persistent system process | No |
| `START_ACTIVITIES_FROM_BACKGROUND` | No. It is `signature\|privileged\|...\|role`. |
| Recents component | No |
| **Device owner** / affiliated profile owner | Possible but heavy (see 4) |
| Associated companion app | No (needs a companion device association) |
| **`SYSTEM_ALERT_WINDOW` granted** | **Yes**, granted by the user in Settings |
| `OP_SYSTEM_EXEMPT_FROM_ACTIVITY_BG_START_RESTRICTION` app-op | No (system-granted) |
| Process state (`checkProcessAllowsBal`): visible window, grace period after the last activity stopped, bound by a foreground app, start token | Not while asleep. The Activity is stopped. |

The developer docs list the same exceptions ([Restrictions on starting activities from the background](https://developer.android.com/guide/components/activities/background-starts)). They add "a `PendingIntent` that was sent by the system (for example, from a notification tap)", which is how full-screen intents get through. A foreground service is not on either list.

Android 14 and 15 also require explicit opt-in before a `PendingIntent` carries the creator's or sender's BAL privilege (`setPendingIntentBackgroundActivityStartMode`, `setPendingIntentCreatorBackgroundActivityStartMode`, [same page](https://developer.android.com/guide/components/activities/background-starts), [Android 14 changes](https://developer.android.com/about/versions/14/behavior-changes-14)). Avoid that: the service should call `startActivity()` directly, not go through a `PendingIntent`.

## 2. Turning the screen on

### `turnScreenOn` + `showWhenLocked` on the Wall Activity (primary)

- `Activity.setTurnScreenOn` Javadoc ([Activity.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/app/Activity.java)): "Normally an activity will be transitioned to the stopped state if it is started while the screen if off, but with this flag set the activity will cause the screen to turn on if the activity will be visible and resumed". The Javadoc says to use it together with `showWhenLocked`.
- `setShowWhenLocked`: the activity "will remain in the resumed state visible on-top of the lock screen".
- Both can be set as manifest attributes (`android:showWhenLocked`, `android:turnScreenOn`, API 27+). No permission is needed.
- **The flag fires only on a launch.** In `ActivityRecord` ([source](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/wm/ActivityRecord.java)), `canTurnScreenOn()` requires `mCurrentLaunchCanTurnScreenOn`. That flag is re-armed in `notifyAppResumed()` only `if (getActivityStartController().isInExecution())`, and the screen "should only turn on at most once per activity resume". So the service has to actually call `startActivity()`, which is why it needs a BAL exemption from section 1. Use `singleTask`/`FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_REORDER_TO_FRONT` so the existing WebView instance comes forward. Whether a reorder-to-front of an existing stopped activity re-arms the flag the same way a fresh launch does is **[unverified]**: test it.
- When the screen turns on this way, `ActivityRecord` calls `mTaskSupervisor.wakeUp(..., "turnScreenOnFlag")`.

### Wake lock with `ACQUIRE_CAUSES_WAKEUP` (supplement)

- Permission: `WAKE_LOCK` (normal). `PowerManagerService.isAcquireCausesWakeupFlagAllowed()` ([source](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/power/PowerManagerService.java)) allows the flag if the app holds `TURN_SCREEN_ON`, **or** if compat change `REQUIRE_TURN_SCREEN_ON_PERMISSION` is not enabled for the app. That change is `@EnabledSince(targetSdkVersion = CUR_DEVELOPMENT)`, so on main it is not enforced for any released target SDK. The exception is a device that sets `waive_target_sdk_check_for_turn_screen_on` (the comment says "e.g. TV").
- `TURN_SCREEN_ON` is `signature|privileged|appop`, "Intended to only be used by home automation apps" ([core AndroidManifest.xml](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/res/AndroidManifest.xml)). Its app-op `OP_TURN_SCREEN_ON` defaults to `MODE_DEFAULT` ([AppOpsManager.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/app/AppOpsManager.java)). Declare it now, so a future enforcement only needs a user toggle. Where that toggle lives in LineageOS Settings is **[unverified]**.
- A wake lock only turns the panel on. It does not change which activity is on top. If the Wall Activity is still the top task, it resumes over the keyguard because of `showWhenLocked`. Otherwise the keyguard or the previous app appears. `PowerManagerService` itself recommends `turnScreenOn` over this flag "as this prevents the previous foreground app from being resumed first".
- The wake-lock levels involved (`SCREEN_BRIGHT_WAKE_LOCK`, `FULL_WAKE_LOCK`) are deprecated but still present ([PowerManager.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/os/PowerManager.java)). Release the lock after a moment. The Wall's own keep-screen-on then takes over.

### Full-screen intent notification (fallback)

- `Notification.Builder.setFullScreenIntent` Javadoc ([Notification.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/app/Notification.java)): it requires `USE_FULL_SCREEN_INTENT` for targetSdk ≥ Q and a channel with `IMPORTANCE_HIGH`. While the user is actively using the device it shows a heads-up instead, so it launches only when the device is locked or the screen is off, which fits our case. Posting notifications also needs `POST_NOTIFICATIONS` (runtime, Android 13+).
- `USE_FULL_SCREEN_INTENT` is `normal|appop`, so it is granted at install. `NotificationManagerService.checkUseFullScreenIntentPermission()` gates it: without it, the notification is degraded to a sticky heads-up.
- The Android 14 rule that limits it to calling and alarm apps is enforced by **the Google Play Store revoking it** ([Android 14 behavior changes](https://developer.android.com/about/versions/14/behavior-changes-14)). LineageOS without Play has nothing that revokes it. The user can still turn it off (`ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT`, `NotificationManager.canUseFullScreenIntent()`).
- Downsides: a notification shows each time, and the launch goes through SystemUI. Whether SystemUI wakes the screen itself or relies on the target's `turnScreenOn`, and how it handles the Android 15 `PendingIntent` opt-in, is **[unverified]**. I did not read SystemUI's source.

## 3. Keyguard: does it have to be disabled?

From `KeyguardController` ([source](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/wm/KeyguardController.java)):

- `canShowWhileOccluded(dismissKeyguard, showWhenLocked)` returns `showWhenLocked || dismissKeyguard && !isKeyguardSecure(...)`. A `showWhenLocked` activity is therefore visible over the keyguard **whether or not it is secure**.
- `canDismissKeyguard()` is true if the keyguard is trusted or not secure. Dismissing it (`KeyguardManager.requestDismissKeyguard`) without credentials therefore only works for Swipe or None.

| Lock screen setting | After `lockNow()` | On motion wake |
|---|---|---|
| **None** | Sleeps only. "If there's no lock type set, this method forces the device to go to sleep but doesn't lock the device" ([DevicePolicyManager.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/app/admin/DevicePolicyManager.java)) | Wall appears directly. **Simplest; recommended.** |
| Swipe | Insecure keyguard shows | Wall occludes it via `showWhenLocked`; leaving the Wall shows the swipe screen |
| PIN/pattern/password | Device locks | Wall still shows over it; leaving the Wall (Settings, other apps) asks for the PIN. The camera FGS is unaffected. |

So disabling the keyguard is not *required*, but **None** is the seamless setup. `DevicePolicyManager.setKeyguardDisabled()` could force it, but it is device-owner only and "has no effect if a password, pin or pattern is currently set". That isn't worth it. Tell the user to pick None during setup.

## 4. Option summary

| Route | BAL ok? | Wakes screen? | Over keyguard? | Permission / setup | LineageOS, no GMS |
|---|---|---|---|---|---|
| **Default Home app + `startActivity()` + `turnScreenOn`/`showWhenLocked`** | Yes (home exemption) | Yes | Yes | `CATEGORY_HOME` intent filter; user picks it as Home (role `ROLE_HOME`, `RoleManager.createRequestRoleIntent`) | Yes, AOSP only |
| `SYSTEM_ALERT_WINDOW` + same Activity flags | Yes | Yes | Yes | User grants "Display over other apps" (`ACTION_MANAGE_OVERLAY_PERMISSION`); `signature\|setup\|appop\|...` | Yes |
| Wake lock `ACQUIRE_CAUSES_WAKEUP` alone | n/a | Yes | Only if the Wall is still the top task | `WAKE_LOCK`; `TURN_SCREEN_ON` for future targets | Yes |
| Full-screen intent | Yes (system-sent PendingIntent) | Yes **[unverified mechanism]** | Yes, with `showWhenLocked` | `USE_FULL_SCREEN_INTENT` (install-time, no Play to revoke), `POST_NOTIFICATIONS`, high-importance channel | Yes |
| Device owner (+ lock task) | Yes ("Device Owner") | Use with Activity flags | Yes | `adb shell dpm set-device-owner` on a device with no accounts; removing it needs the app or a factory reset | Yes, but heavy. It also lifts the FGS background-start limit (#4). Not needed. |

## 5. Chromebook (ARCVM)

Whether ARC lets an Android app become the Home app, honors `turnScreenOn`/`ACQUIRE_CAUSES_WAKEUP` to wake the ChromeOS display, or offers `SYSTEM_ALERT_WINDOW` is **[unverified]**. I found no primary source. The full-screen intent and `SYSTEM_ALERT_WINDOW` are the likeliest routes there. Test on hardware.

## Open items to test on hardware

1. LineageOS: Display app as Home, lock screen None. Run `lockNow()`, then motion → service `startActivity(REORDER_TO_FRONT)`. Does the screen turn on with the Wall in front? Repeat with Swipe and with a PIN.
2. The same with only the `ACQUIRE_CAUSES_WAKEUP` wake lock (no `startActivity`).
3. If Home is declined: `SYSTEM_ALERT_WINDOW` route, and the full-screen-intent route.
4. Chromebook ARCVM: all of the above.
