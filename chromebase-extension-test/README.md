# Chromebase extension test

A throwaway MV3 extension for [Chromebase extension test](https://github.com/DeRusto/gocasa-android/issues/16). It is not the Display app, and this branch is never merged.

Everything the extension does goes into the **Log** on its test page, with timestamps. When you're done, press **Copy log** and paste the log into the ticket with your notes.

## Setup

1. On the Chromebase, download <https://github.com/DeRusto/gocasa-android/archive/refs/heads/task/chromebase-extension-test.zip>, open it in Files, and copy the `chromebase-extension-test` folder somewhere under My files.
2. Go to `chrome://extensions`, turn on **Developer mode** (top right), then **Load unpacked** and pick that folder. This is Chrome's developer mode, not ChromeOS's: nothing is wiped.
   - If loading fails on `externally_connectable`, change `"http://*/*"` in `manifest.json` to your server, for example `"http://192.168.1.50:8080/*"`, and load it again. Note the failure.
3. The test page opens on its own. You can reopen it later from the extension's toolbar icon.
4. Note the ChromeOS version from `chrome://version` (or Settings > About ChromeOS).
5. Check Settings > Device > Power: what the Chromebase does when idle on AC power (turn off display or sleep), and whether "Lock screen when sleeping" is on. Note both.

## Checks

Record a pass or fail for each step, plus anything surprising.

1. **Camera grant.** Press **Grant camera here** and pick **Allow on every visit**. The preview shows for 3 s, and Permission reads `granted`.
2. **Offscreen camera.** Press **Start offscreen camera**. Frames climb and the motion score jumps when you wave. The log shows `camera: started (…)`, then a heartbeat every 30 s. If it says `getUserMedia failed`, the one-time grant didn't carry over to the offscreen document. Record that, because it's a key result.
3. **Bridge.** Open the GoCasa page in a normal tab, press Ctrl+Shift+J, and paste the snippet from section 4. The console prints `{ok: true, …}` and the log shows `bridge: from http://…`. If `chrome.runtime` is undefined there, the page isn't matched by `externally_connectable`.
4. **Wall window.** Enter the GoCasa URL and press **Open full screen**. Note whether it fills the screen without any browser UI. Separately, try Chrome menu > Cast, save, and share > **Install page as app** on the GoCasa tab, and note whether it's offered and whether the app opens in its own window.
5. **Night mode: panel off, camera alive.** Start the offscreen camera and press **Keep system on (display may sleep)**. Leave the room or cover the camera, and wait past the idle timeout from setup step 5. Note when the panel goes off. Wait a few minutes more, then come back and check the log:
   - Heartbeats should keep showing new frames while the panel was off (`idle state: idle` or `locked` brackets that time). Many stalled ticks, or `track muted`/`ended`, mean the camera stops when the panel is off.
   - Note whether the panel went fully dark (backlight off), not just dimmed.
6. **Camera wake.** Tick **Call `reportActivity()` on motion**. Let the panel go off again as in check 5, then walk in front of the camera.
   - Does the panel turn on? How long after the `wake: reportActivity() called` line?
   - Does the lock screen appear?
   - If motion never logs, lower the threshold. If it logs constantly, raise it. Note the value that worked.
7. **Keep display on.** Press **Keep display on** and leave it past the idle timeout. The panel should stay on.
8. **Start on boot.** Tick the autostart box, make sure the GoCasa URL is saved, then restart the Chromebase and sign in.
   - Does the Wall window open by itself?
   - Does the log show `startup: runtime.onStartup fired` and then `camera: started`, with no new permission prompt? That shows the camera grant survives a reboot.

## Report

Paste into the ticket:
- the ChromeOS version and the power settings
- a pass or fail and notes for each check
- the copied log
