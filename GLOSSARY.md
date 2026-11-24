# GoCasa Android

The companion to GoCasa that turns a tablet or Chromebook into a Wall display. Terms borrowed from GoCasa keep GoCasa's meaning.

## Language

**Display app**:
The app that turns a device into a Wall display. It comes as an APK build for Android and an Extension build for ChromeOS.
_Avoid_: Kiosk, kiosk app, shell, wrapper

**APK build**:
The Display app as an Android app, for Android devices such as LineageOS tablets.
_Avoid_: Android version, the app

**Extension build**:
The Display app as a ChromeOS extension, the build Chromebooks get.
_Avoid_: Chrome app, PWA, ChromeOS version

**Wall display** (from GoCasa):
A device switched into always-on dashboard mode.
_Avoid_: Kiosk, display, screen, tablet

**Night mode** (from GoCasa):
The Household's set hours when a Wall display shows a black screen, or a dim clock, instead of the screensaver.
_Avoid_: Sleep, do not disturb, off hours

**Camera wake** (from GoCasa):
A Wall display waking when its camera sees motion.
_Avoid_: Motion waking, motion detection, presence

**Wake sensitivity**:
How much motion the camera must see before a Camera wake. Set per device in Display settings.
_Avoid_: Threshold, motion level, trigger level

**Bridge**:
The channel between GoCasa's page and the Display app on the same device. The page reports what it is showing, and the app reports a Camera wake. GoCasa's server never contacts the Display app directly.
_Avoid_: JS interface, control channel, API

**Server discovery**:
The Display app finding the Household's GoCasa server on the local network without the URL being typed in.
_Avoid_: Auto-detect, autoconfig, pairing

**First-run setup**:
The guided screens the Display app shows on first launch: connect to a GoCasa server, then grant what the Wall display needs. Each optional step says what is lost if skipped.
_Avoid_: Onboarding, wizard, pairing

**Display settings**:
The screen for changing the server or fixing a missing permission after First-run setup. Reached by a long-press on a corner in the APK build, and through the Options page in the Extension build.
_Avoid_: Admin settings, preferences
