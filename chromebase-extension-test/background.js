// Service worker: owns keep-awake, the offscreen camera, the Wall window and the log.

let queue = Promise.resolve();
// Writes are chained so concurrent events don't overwrite each other's lines.
function log(msg) {
  queue = queue.then(async () => {
    const { log: lines = [] } = await chrome.storage.local.get('log');
    lines.push(`${new Date().toISOString()} ${msg}`);
    await chrome.storage.local.set({ log: lines.slice(-2000) });
  });
  return queue;
}

async function startCamera() {
  if (await chrome.offscreen.hasDocument()) return log('camera: offscreen document already running');
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Camera wake test',
  });
  await log('camera: offscreen document created');
}

async function stopCamera() {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  await chrome.storage.session.remove('stats');
  await log('camera: offscreen document closed');
}

async function setAwake(level) {
  if (level) chrome.power.requestKeepAwake(level);
  else chrome.power.releaseKeepAwake();
  await chrome.storage.local.set({ awake: level || '' });
  await log(`keep-awake: ${level || 'released'}`);
}

async function openWall(url) {
  if (!url) return log('wall: no server URL saved');
  const w = await chrome.windows.create({ url, type: 'popup' });
  await chrome.windows.update(w.id, { state: 'fullscreen' });
  await log(`wall: opened ${url} full screen`);
}

function openTestPage() {
  chrome.tabs.create({ url: 'test.html' });
}

let lastWake = 0;
async function onMotion(score) {
  const { wakeOnMotion, threshold = 12 } = await chrome.storage.local.get(['wakeOnMotion', 'threshold']);
  if (score < threshold) return;
  await log(`motion: score ${score.toFixed(1)}`);
  if (!wakeOnMotion || Date.now() - lastWake < 5000) return;
  lastWake = Date.now();
  if (!chrome.power.reportActivity) return log('wake: chrome.power.reportActivity is missing (needs ChromeOS, Chrome 113+)');
  await chrome.power.reportActivity();
  await log('wake: reportActivity() called');
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = {
    startCamera,
    stopCamera,
    awake: () => setAwake(msg.level),
    wall: () => openWall(msg.url),
    stats: () => chrome.storage.session.set({ stats: { frames: msg.frames, score: msg.score, at: Date.now() } }).then(() => onMotion(msg.score)),
    heartbeat: () => log(`camera: ${msg.frames} new frames, ${msg.stalled} stalled ticks in the last ${msg.seconds}s`),
    'camera-event': () => log(`camera: ${msg.event}`),
  }[msg.type];
  if (!run) return;
  run().catch((e) => log(`error in ${msg.type}: ${e.message}`)).finally(() => sendResponse({}));
  return true;
});

// The bridge check: the GoCasa page (plain HTTP, LAN IP) messages the extension.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  log(`bridge: from ${sender.url}: ${JSON.stringify(msg)}`);
  sendResponse({ ok: true, from: 'GoCasa Chromebase test', at: new Date().toISOString() });
});

chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener((state) => log(`idle state: ${state}`));

chrome.action.onClicked.addListener(openTestPage);
chrome.runtime.onInstalled.addListener(({ reason }) => {
  log(`installed (${reason})`);
  openTestPage();
});

chrome.runtime.onStartup.addListener(async () => {
  await log('startup: runtime.onStartup fired');
  const { autostart, awake, server } = await chrome.storage.local.get(['autostart', 'awake', 'server']);
  if (!autostart) return log('startup: autostart is off');
  await setAwake(awake || 'system').catch((e) => log(`startup keep-awake failed: ${e.message}`));
  await startCamera().catch((e) => log(`startup camera failed: ${e.message}`));
  await openWall(server).catch((e) => log(`startup wall failed: ${e.message}`));
});
