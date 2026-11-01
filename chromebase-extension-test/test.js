const $ = (id) => document.getElementById(id);
const cmd = (msg) => chrome.runtime.sendMessage(msg);
const local = chrome.storage.local;

$('ua').textContent = navigator.userAgent;
$('snippet').textContent =
  `chrome.runtime.sendMessage("${chrome.runtime.id}", {type: "ping"}, r => console.log(r, chrome.runtime.lastError))`;

navigator.permissions.query({ name: 'camera' }).then((p) => {
  const show = () => ($('perm').textContent = p.state);
  show();
  p.onchange = show;
});

$('grant').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    $('preview').srcObject = stream;
    setTimeout(() => stream.getTracks().forEach((t) => t.stop()), 3000);
  } catch (e) {
    alert(`getUserMedia failed: ${e.name}: ${e.message}`);
  }
};

document.querySelectorAll('[data-cmd]').forEach((b) => (b.onclick = () => cmd({ type: b.dataset.cmd })));
document.querySelectorAll('[data-awake]').forEach((b) => (b.onclick = () => cmd({ type: 'awake', level: b.dataset.awake })));

$('wall').onclick = async () => {
  const url = $('server').value.trim();
  await local.set({ server: url });
  cmd({ type: 'wall', url });
};
$('server').onchange = () => local.set({ server: $('server').value.trim() });
$('wakeOnMotion').onchange = () => local.set({ wakeOnMotion: $('wakeOnMotion').checked });
$('threshold').onchange = () => local.set({ threshold: Number($('threshold').value) });
$('autostart').onchange = () => local.set({ autostart: $('autostart').checked });

$('copy').onclick = () => navigator.clipboard.writeText(`${navigator.userAgent}\n${$('log').textContent}`);
$('clear').onclick = () => local.set({ log: [] });

function renderLog(lines = []) {
  $('log').textContent = lines.slice().reverse().join('\n');
}

function renderStats(s) {
  $('frames').textContent = s ? s.frames : '–';
  $('score').textContent = s ? s.score.toFixed(1) : '–';
  $('at').textContent = s ? new Date(s.at).toLocaleTimeString() : '–';
}

local.get(['log', 'server', 'wakeOnMotion', 'threshold', 'autostart', 'awake']).then((s) => {
  renderLog(s.log);
  $('server').value = s.server || '';
  $('wakeOnMotion').checked = !!s.wakeOnMotion;
  $('threshold').value = s.threshold || 12;
  $('autostart').checked = !!s.autostart;
  $('awake').textContent = s.awake || 'released';
});
chrome.storage.session.get('stats').then((s) => renderStats(s.stats));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.log) renderLog(changes.log.newValue);
  if (area === 'local' && changes.awake) $('awake').textContent = changes.awake.newValue || 'released';
  if (area === 'session' && changes.stats) renderStats(changes.stats.newValue);
});
