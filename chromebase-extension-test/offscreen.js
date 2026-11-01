// Offscreen document: runs the camera and a crude frame-difference motion score.

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

const video = document.createElement('video');
video.muted = true;
const canvas = new OffscreenCanvas(64, 48);
const ctx = canvas.getContext('2d', { willReadFrequently: true });

let prev = null;
let lastTime = -1;
let frames = 0;
let stalled = 0;
let beatAt = Date.now();

function tick() {
  if (video.readyState >= 2 && video.currentTime !== lastTime) {
    lastTime = video.currentTime;
    ctx.drawImage(video, 0, 0, 64, 48);
    const px = ctx.getImageData(0, 0, 64, 48).data;
    let diff = 0;
    if (prev) for (let i = 0; i < px.length; i += 4) diff += Math.abs(px[i + 1] - prev[i + 1]);
    prev = px;
    frames++;
    send({ type: 'stats', frames, score: diff / (64 * 48) });
  } else {
    stalled++; // no new frame since the last tick: the camera is paused or frozen
  }
  const seconds = Math.round((Date.now() - beatAt) / 1000);
  if (seconds >= 30) {
    send({ type: 'heartbeat', frames, stalled, seconds });
    frames = 0;
    stalled = 0;
    beatAt = Date.now();
  }
}

navigator.mediaDevices
  .getUserMedia({ video: { width: 320, height: 240 } })
  .then((stream) => {
    const track = stream.getVideoTracks()[0];
    send({ type: 'camera-event', event: `started (${track.label})` });
    track.onmute = () => send({ type: 'camera-event', event: 'track muted' });
    track.onunmute = () => send({ type: 'camera-event', event: 'track unmuted' });
    track.onended = () => send({ type: 'camera-event', event: 'track ended' });
    video.srcObject = stream;
    return video.play();
  })
  .then(() => setInterval(tick, 500))
  .catch((e) => send({ type: 'camera-event', event: `getUserMedia failed: ${e.name}: ${e.message}` }));
