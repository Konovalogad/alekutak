'use strict';
/* ALEKUTAK — голосовая связь для игр. WebRTC «каждый с каждым», сигналинг через PeerJS. */

const PREFIX = 'alekutak-v3-';
const MAX_PLAYERS = 4;
const COLORS = ['#ffc531', '#ff5c8a', '#38d6ff', '#7cff6b'];
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const $ = (id) => document.getElementById(id);
const api = window.tetra || null; // есть только в программе для Windows; в браузере и на телефоне его нет
if (!api) document.body.classList.add('web');
if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) document.body.classList.add('noshare');
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
};

const I = {
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  micoff: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16"/></svg>',
  ear: '<svg viewBox="0 0 24 24"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>',
  earoff: '<svg viewBox="0 0 24 24"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/><path d="M4 4l16 16"/></svg>',
  cam: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="12" height="12" rx="2"/><path d="M15 10l6-3v10l-6-3"/></svg>',
  screen: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  overlay: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><rect x="13" y="7" width="5" height="7" rx="1"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
  leave: '<svg viewBox="0 0 24 24"><path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9"/></svg>',
  spk: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6"/></svg>',
  spkoff: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16 9l5 6M21 9l-5 6"/></svg>'
};
let markN = 0;
const MARK_SHAPE = '<path class="lg-l" d="M19.5 5h9L14 43H4z"/><path class="lg-r" d="M19.5 5h9L44 43H34z"/>' +
  '<rect class="lg-b" x="17.6" y="36.5" width="2.8" height="6.5" rx="1.2"/><rect class="lg-b" x="22.6" y="28" width="2.8" height="15" rx="1.2"/><rect class="lg-b" x="27.6" y="33.5" width="2.8" height="9.5" rx="1.2"/>';
function markSvg() { // буква A из платины, вместо перекладины — столбики звука
  const g = 'mg' + (++markN);
  return '<svg viewBox="0 0 48 48"><defs><linearGradient id="' + g + '" gradientUnits="userSpaceOnUse" x1="8" y1="4" x2="40" y2="44">' +
    '<stop offset="0" stop-color="#ffffff"/><stop offset=".3" stop-color="#cfd4db"/><stop offset=".5" stop-color="#8a919b"/><stop offset=".62" stop-color="#eef0f3"/><stop offset="1" stop-color="#9aa1ab"/></linearGradient></defs>' +
    '<g fill="url(#' + g + ')">' + MARK_SHAPE + '</g></svg>';
}
document.querySelectorAll('[data-mark]').forEach((el) => { el.innerHTML = markSvg(); });
document.querySelectorAll('[data-ico]').forEach((el) => { el.innerHTML = I[el.dataset.ico]; });

/* ---------------- состояние ---------------- */
let peer = null, isHost = false, roomCode = '', myName = '', inRoom = false;
let actx = null, masterGain = null, micBoost = null, micAnalyser = null, micGate = null, micDest = null, micSrc = null, micRaw = null;
let localStream = null, hasMic = false, micOn = true, deaf = false, micBeforeDeaf = true;
let gateOpen = false, lastLoud = 0, pttHeld = false, myLevel = 0;
let camTrack = null, screenTrack = null, blankTrack = null, blankTimer = null, videoKind = 'none';
let tickTimer = null, statTimer = null, clockTimer = null, joinTimer = null, startedAt = 0;
let overlayOn = false, unread = 0, wakeLock = null;
const holdPtt = () => !api && cfg.mode === 'ptt' && micOn && !deaf; // в браузере рация — это удержание кнопки микрофона
let slots = [];
const peers = new Map(); // id -> { id, name, conn, call, slot, gain, analyser, src, stream, vol, muted, state }
const cfg = {
  mode: store.get('mode', 'voice'),
  gate: +store.get('gate', '10'),
  boost: +store.get('boost', '100'),
  master: +store.get('master', '100'),
  cues: store.get('cues', '1') === '1',
  ovOp: +store.get('ovOp', '90'),
  ptt: (() => { try { return JSON.parse(store.get('ptt', 'null')); } catch (e) { return null; } })()
};

/* ---------------- мелочи ---------------- */
function toast(text) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = text;
  $('toasts').appendChild(t); setTimeout(() => t.remove(), 3500);
}
function lobbyMsg(text, info) { $('lobbyMsg').textContent = text || ''; $('lobbyMsg').classList.toggle('info', !!info); }
function busy(b) { $('btnCreate').disabled = b; $('btnJoin').disabled = b; }
function genCode() {
  let s = ''; for (const x of crypto.getRandomValues(new Uint8Array(6))) s += CODE_ABC[x % CODE_ABC.length];
  return s;
}
function myRoomCode() {
  let c = store.get('myRoom', '');
  if (!/^[A-Z0-9]{6}$/.test(c)) { c = genCode(); store.set('myRoom', c); }
  return c;
}
function peerOptions() {
  const dev = new URLSearchParams(location.search).get('dev'); // локальная проверка
  const o = {
    debug: 1,
    config: {
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' }
      ],
      sdpSemantics: 'unified-plan'
    }
  };
  if (dev) { const [h, p] = dev.split(':'); o.host = h; o.port = +p; o.path = '/'; o.secure = false; }
  return o;
}

/* ---------------- звуковые сигналы ---------------- */
function cue(kind) {
  if (!cfg.cues || !actx) return;
  const seq = { join: [523, 784], leave: [659, 392], unmute: [740], mute: [330], deaf: [330, 247], undeaf: [494, 740] }[kind];
  if (!seq) return;
  const t0 = actx.currentTime;
  seq.forEach((f, i) => {
    const o = actx.createOscillator(), g = actx.createGain(), t = t0 + i * 0.09;
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.11, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.16);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.18);
  });
}

/* ---------------- устройства ---------------- */
async function refreshDevices() {
  let list = [];
  try { list = await navigator.mediaDevices.enumerateDevices(); } catch (e) { return; }
  const fill = (sel, kind, key, word) => {
    const saved = store.get(key, ''); sel.innerHTML = '';
    const def = document.createElement('option'); def.value = ''; def.textContent = 'Как в Windows'; sel.appendChild(def);
    let n = 0;
    for (const d of list) {
      if (d.kind !== kind || !d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') continue;
      const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || (word + ' ' + (++n)); sel.appendChild(o);
    }
    sel.value = saved; if (sel.value !== saved) sel.value = '';
  };
  fill($('selMic'), 'audioinput', 'dev:mic', 'Микрофон');
  fill($('selOut'), 'audiooutput', 'dev:out', 'Выход');
  fill($('selCam'), 'videoinput', 'dev:cam', 'Камера');
}
async function applyOutput() {
  if (!actx || !actx.setSinkId) return;
  try { await actx.setSinkId($('selOut').value || ''); } catch (e) { toast('Не получилось переключить выход звука'); }
}

/* ---------------- свой звук: усиление → порог шума → в эфир ---------------- */
function initAudio() {
  if (actx) return;
  actx = new AudioContext({ latencyHint: 'interactive' });
  masterGain = actx.createGain(); masterGain.connect(actx.destination);
  micBoost = actx.createGain(); micAnalyser = actx.createAnalyser(); micAnalyser.fftSize = 512;
  micGate = actx.createGain(); micGate.gain.value = 0;
  micDest = actx.createMediaStreamDestination();
  micBoost.connect(micAnalyser); micBoost.connect(micGate); micGate.connect(micDest);
}
async function openMic() {
  const id = $('selMic').value;
  const old = micRaw;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    micRaw = s.getAudioTracks()[0]; hasMic = true;
  } catch (e) {
    if (id) { $('selMic').value = ''; store.set('dev:mic', ''); return openMic(); }
    micRaw = null; hasMic = false;
  }
  try { if (micSrc) micSrc.disconnect(); } catch (e) { /* ignore */ }
  micSrc = null;
  if (micRaw) { micSrc = actx.createMediaStreamSource(new MediaStream([micRaw])); micSrc.connect(micBoost); }
  if (old && old !== micRaw) old.stop();
}
const levelBuf = new Uint8Array(512);
function level(an) {
  if (!an) return 0;
  an.getByteTimeDomainData(levelBuf);
  let s = 0; for (let i = 0; i < levelBuf.length; i++) { const v = (levelBuf[i] - 128) / 128; s += v * v; }
  return Math.sqrt(s / levelBuf.length);
}
const gateThr = () => cfg.gate / 100 * 0.15;
function tick() {
  const now = performance.now(), thr = gateThr();
  myLevel = hasMic ? level(micAnalyser) : 0;
  let open = false;
  if (micOn && !deaf && hasMic) {
    if (cfg.mode === 'ptt') open = pttHeld;
    else { if (myLevel > thr) lastLoud = now; open = cfg.gate === 0 || now - lastLoud < 400; }
  }
  if (open !== gateOpen) { gateOpen = open; micGate.gain.setTargetAtTime(open ? 1 : 0, actx.currentTime, open ? 0.008 : 0.05); }
  const me = slots[0];
  if (me) paintVoice(me, open && myLevel > Math.max(thr, 0.012), myLevel);
  for (const p of peers.values()) {
    const lv = level(p.analyser);
    paintVoice(p.slot, p.state.mic && !p.muted && lv > 0.012, lv);
  }
  if (!$('settings').hidden) {
    $('meterBar').style.width = Math.min(100, myLevel / 0.15 * 100) + '%';
    $('meterBar').classList.toggle('low', cfg.mode === 'voice' && myLevel <= thr);
  }
}
function paintVoice(slot, on, lv) {
  const v = Math.min(1, lv * 2.2).toFixed(2);
  for (const el of [slot.el, slot.row]) {
    if (!el) continue;
    el.classList.toggle('speaking', on);
    el.style.setProperty('--on', on ? 1 : 0); el.style.setProperty('--lv', v);
  }
}

/* ---------------- видео ---------------- */
function makeBlankTrack() {
  const c = document.createElement('canvas'); c.width = 320; c.height = 180;
  const g = c.getContext('2d'); let k = 0;
  const draw = () => { g.fillStyle = '#151a2e'; g.fillRect(0, 0, 320, 180); g.fillStyle = (k ^= 1) ? '#151a2f' : '#151a2e'; g.fillRect(0, 0, 2, 2); };
  draw(); blankTimer = setInterval(draw, 500);
  return c.captureStream(2).getVideoTracks()[0];
}
function refreshLocalVideo() {
  const track = videoKind === 'screen' ? screenTrack : videoKind === 'camera' ? camTrack : blankTrack;
  for (const t of localStream.getVideoTracks()) localStream.removeTrack(t);
  localStream.addTrack(track);
  for (const p of peers.values()) {
    const pc = p.call && p.call.peerConnection; if (!pc) continue;
    const s = pc.getSenders().find((x) => x.track && x.track.kind === 'video');
    if (s) s.replaceTrack(track).catch(() => {});
  }
  const me = slots[0];
  if (me) {
    me.video.srcObject = new MediaStream([track]);
    me.el.classList.toggle('novideo', videoKind === 'none');
    me.el.classList.toggle('mirror', videoKind === 'camera');
  }
  paintControls(); broadcast(stateMsg());
}
async function camOn() {
  const id = $('selCam').value;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: id ? { exact: id } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
    camTrack = s.getVideoTracks()[0];
    camTrack.onended = () => { camTrack = null; if (videoKind === 'camera') videoKind = 'none'; refreshLocalVideo(); };
    if (videoKind !== 'screen') videoKind = 'camera';
    refreshLocalVideo(); refreshDevices();
  } catch (e) { toast('Камера не найдена или занята другой программой'); }
}
function camOff() {
  if (camTrack) { camTrack.onended = null; camTrack.stop(); camTrack = null; }
  if (videoKind === 'camera') videoKind = 'none';
  refreshLocalVideo();
}
async function screenOn() {
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
    screenTrack = s.getVideoTracks()[0]; screenTrack.contentHint = 'detail'; screenTrack.onended = screenOff;
    videoKind = 'screen'; refreshLocalVideo();
  } catch (e) { /* выбор отменён */ }
}
function screenOff() {
  if (screenTrack) { screenTrack.onended = null; screenTrack.stop(); screenTrack = null; }
  videoKind = camTrack ? 'camera' : 'none'; refreshLocalVideo();
}

/* ---------------- микрофон и «заглушить всех» ---------------- */
function setMic(on, quiet) {
  if (on && !hasMic) { toast('Микрофон не найден'); on = false; }
  if (on && deaf) { setDeaf(false); return; }
  micOn = on; if (micRaw) micRaw.enabled = on;
  if (!quiet) cue(on ? 'unmute' : 'mute');
  paintControls(); broadcast(stateMsg());
}
function setDeaf(on) {
  if (on === deaf) return;
  deaf = on;
  if (on) { micBeforeDeaf = micOn; micOn = false; } else { micOn = micBeforeDeaf && hasMic; }
  if (micRaw) micRaw.enabled = micOn;
  masterGain.gain.value = on ? 0 : cfg.master / 100;
  cue(on ? 'deaf' : 'undeaf');
  paintControls(); broadcast(stateMsg());
}
function paintControls() {
  const micLive = micOn && !deaf;
  const mic = (b) => { b.classList.toggle('cut', !micLive); (b.querySelector('.ico') || b).innerHTML = micLive ? I.mic : I.micoff; };
  const ear = (b) => { b.classList.toggle('cut', deaf); (b.querySelector('.ico') || b).innerHTML = deaf ? I.earoff : I.ear; };
  mic($('btnMic')); mic($('ovMic')); ear($('btnDeaf')); ear($('ovDeaf'));
  $('btnMic').querySelector('em').textContent = cfg.mode === 'ptt' && micLive ? (api ? 'Рация' : 'Держи и говори') : 'Микрофон';
  $('btnMic').classList.toggle('hold', !api && cfg.mode === 'ptt' && micLive);
  $('btnCam').classList.toggle('live', !!camTrack);
  $('btnScreen').classList.toggle('live', videoKind === 'screen');
  $('btnChat').classList.toggle('live', !$('chat').hidden);
  const me = slots[0];
  if (me) for (const el of [me.el, me.row]) { if (el) { el.classList.toggle('micoff', !micLive); el.classList.toggle('deaf', deaf); } }
}

/* ---------------- слоты игроков ---------------- */
function buildSlots() {
  $('grid').innerHTML = '';
  slots = COLORS.map((c, i) => {
    const el = document.createElement('div'); el.className = 'slot empty novideo'; el.style.setProperty('--c', c);
    el.innerHTML =
      '<video autoplay playsinline muted></video><div class="ava"></div>' +
      '<div class="wait"><strong>Слот свободен</strong>Код комнаты <b></b></div>' +
      '<div class="hud"><span class="num">' + (i + 1) + '</span><span class="nm"></span><span class="you"></span>' +
      '<span class="eq"><i></i><i></i><i></i><i></i></span><span class="st m">' + I.micoff + '</span><span class="st d">' + I.earoff + '</span></div>' +
      '<div class="ping"></div>' +
      '<div class="vol" hidden><button title="Заглушить игрока"></button><input type="range" min="0" max="200" step="1"><span class="val"></span></div>';
    $('grid').appendChild(el);
    const q = (s) => el.querySelector(s);
    q('.wait b').textContent = roomCode;
    const s = { i, color: c, el, video: q('video'), ava: q('.ava'), nm: q('.nm'), you: q('.you'), ping: q('.ping'), vol: q('.vol'), rng: q('.vol input'), val: q('.vol .val'), mute: q('.vol button'), owner: null, peer: null, row: null };
    s.rng.oninput = () => { const p = s.peer; if (!p) return; p.vol = +s.rng.value; p.muted = false; store.set('vol:' + p.name, p.vol); applyVolume(p); };
    s.rng.ondblclick = () => { s.rng.value = 100; s.rng.oninput(); };
    s.mute.onclick = () => { const p = s.peer; if (!p) return; p.muted = !p.muted; applyVolume(p); };
    return s;
  });
}
function claimSlot(owner, name, peerObj) {
  const s = slots.find((x) => !x.owner); if (!s) return null;
  s.owner = owner; s.peer = peerObj || null;
  s.el.className = 'slot novideo';
  s.nm.textContent = name; s.ava.textContent = name.trim().charAt(0).toUpperCase() || '?';
  s.you.textContent = owner === 'me' ? 'это ты' : '';
  s.vol.hidden = !peerObj; s.ping.textContent = ''; s.ping.className = 'ping';
  renderOverlayRows();
  return s;
}
function freeSlot(s) {
  s.owner = null; s.peer = null; s.video.srcObject = null;
  s.el.className = 'slot empty novideo'; s.el.style.setProperty('--on', 0);
  s.vol.hidden = true; s.ping.textContent = '';
  renderOverlayRows();
}
function applyVolume(p) {
  if (p.gain) p.gain.gain.value = p.muted ? 0 : p.vol / 100;
  const s = p.slot;
  s.rng.value = p.vol; s.val.textContent = (p.muted ? 0 : p.vol) + '%';
  s.mute.innerHTML = p.muted || p.vol === 0 ? I.spkoff : I.spk;
  s.vol.classList.toggle('muted', p.muted); s.vol.classList.toggle('boost', !p.muted && p.vol > 100);
}
function applyPeerState(p) {
  for (const el of [p.slot.el, p.slot.row]) { if (el) { el.classList.toggle('micoff', !p.state.mic); el.classList.toggle('deaf', !!p.state.deaf); } }
  p.slot.el.classList.toggle('novideo', !p.state.video);
}
function ensurePeer(id, name) {
  let p = peers.get(id);
  if (p) {
    if (name && p.name !== name) { p.name = name; p.slot.nm.textContent = name; p.slot.ava.textContent = name.charAt(0).toUpperCase(); renderOverlayRows(); }
    return p;
  }
  name = name || 'Игрок';
  const vol = Math.min(200, Math.max(0, parseInt(store.get('vol:' + name, '100'), 10) || 0));
  p = { id, name, conn: null, call: null, vol, muted: false, state: { mic: true, video: false, deaf: false }, gain: null, analyser: null, src: null, stream: null };
  p.slot = claimSlot(id, name, p);
  if (!p.slot) return null;
  p.slot.ping.textContent = 'соединяемся';
  peers.set(id, p); applyVolume(p);
  sysMsg(name + ' в комнате'); cue('join');
  return p;
}
function removePeer(id, silent) {
  const p = peers.get(id); if (!p) return;
  peers.delete(id);
  try { p.call && p.call.close(); } catch (e) { /* ignore */ }
  try { p.conn && p.conn.close(); } catch (e) { /* ignore */ }
  try { p.src && p.src.disconnect(); p.gain && p.gain.disconnect(); } catch (e) { /* ignore */ }
  freeSlot(p.slot);
  if (!silent) {
    sysMsg(p.name + ' вышел'); toast(p.name + ' вышел'); cue('leave');
    if (!isHost && id === PREFIX + roomCode) toast('Хозяин комнаты вышел. Вы на связи, но новые игроки по этому коду не войдут');
  }
}
function attachRemoteStream(p, stream) {
  if (p.stream === stream) return;
  p.stream = stream; p.slot.video.srcObject = stream;
  try { p.src && p.src.disconnect(); p.gain && p.gain.disconnect(); } catch (e) { /* ignore */ }
  p.src = actx.createMediaStreamSource(stream);
  p.analyser = actx.createAnalyser(); p.analyser.fftSize = 512;
  p.gain = actx.createGain();
  p.src.connect(p.analyser); p.src.connect(p.gain); p.gain.connect(masterGain);
  applyVolume(p); applyPeerState(p);
}

/* ---------------- задержка до каждого игрока ---------------- */
async function pollStats() {
  for (const p of peers.values()) {
    const pc = p.call && p.call.peerConnection; if (!pc || !peers.has(p.id)) continue;
    const st = pc.iceConnectionState;
    if (st !== 'connected' && st !== 'completed') continue;
    try {
      const stats = await pc.getStats(); let pair = null;
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
      if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
      if (!pair || typeof pair.currentRoundTripTime !== 'number') continue;
      const ms = Math.round(pair.currentRoundTripTime * 1000);
      p.slot.ping.textContent = ms + ' мс';
      p.slot.ping.className = 'ping ' + (ms < 80 ? 'good' : ms < 180 ? 'mid' : 'bad');
    } catch (e) { /* ignore */ }
  }
}

/* ---------------- сеть ---------------- */
function stateMsg() { return { type: 'state', mic: micOn && !deaf, deaf, video: videoKind !== 'none' }; }
function broadcast(msg) { for (const p of peers.values()) if (p.conn && p.conn.open) { try { p.conn.send(msg); } catch (e) { /* ignore */ } } }
function onData(id, d) {
  if (!d || typeof d !== 'object') return;
  const p = peers.get(id);
  if (d.type === 'state' && p) { p.state = { mic: !!d.mic, video: !!d.video, deaf: !!d.deaf }; applyPeerState(p); }
  else if (d.type === 'chat' && p && typeof d.text === 'string') chatAdd(p.name, d.text.slice(0, 500), p.slot.color);
  else if (d.type === 'bye') removePeer(id);
}
function wireConn(conn, onOpen) {
  conn.on('open', onOpen);
  conn.on('data', (d) => onData(conn.peer, d));
  conn.on('close', () => removePeer(conn.peer));
  conn.on('error', () => {});
}
function onIncomingConn(conn) {
  const name = String((conn.metadata && conn.metadata.name) || 'Игрок').slice(0, 20);
  if (peers.size >= MAX_PLAYERS - 1 && !peers.has(conn.peer)) {
    conn.on('open', () => { conn.send({ type: 'full' }); setTimeout(() => conn.close(), 500); });
    return;
  }
  wireConn(conn, () => {
    const p = ensurePeer(conn.peer, name); if (!p) return conn.close();
    p.conn = conn;
    if (isHost) {
      const members = [...peers.values()].filter((x) => x.id !== conn.peer).map((x) => ({ id: x.id, name: x.name }));
      conn.send({ type: 'welcome', hostName: myName, members });
    }
    conn.send(stateMsg());
  });
}
function wireCall(call, p) {
  p.call = call;
  call.on('stream', (s) => attachRemoteStream(p, s));
  call.on('close', () => removePeer(p.id));
  call.on('error', () => {});
  const pc = call.peerConnection;
  if (pc) pc.addEventListener('iceconnectionstatechange', () => {
    if (!peers.has(p.id)) return;
    const st = pc.iceConnectionState;
    if (st === 'disconnected') { p.slot.ping.textContent = 'связь пропала'; p.slot.ping.className = 'ping bad'; }
    else if (st === 'failed') { toast('Не получилось соединиться с ' + p.name); removePeer(p.id); }
  });
}
function onIncomingCall(call) {
  const name = String((call.metadata && call.metadata.name) || '').slice(0, 20);
  const p = ensurePeer(call.peer, name);
  if (!p) { call.close(); return; }
  call.answer(localStream); wireCall(call, p);
}
function callPeer(p) {
  const call = peer.call(p.id, localStream, { metadata: { name: myName } });
  if (call) wireCall(call, p);
}
function attachPeerEvents() {
  peer.on('connection', onIncomingConn);
  peer.on('call', onIncomingCall);
  peer.on('disconnected', () => {
    $('netState').textContent = 'сервер недоступен'; $('netState').classList.add('off');
    setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch (e) { /* ignore */ } } }, 2000);
  });
  peer.on('open', () => { $('netState').textContent = 'на связи'; $('netState').classList.remove('off'); });
}

async function prepareMedia() {
  initAudio();
  if (actx.state === 'suspended') { try { await actx.resume(); } catch (e) { /* ignore */ } }
  masterGain.gain.value = cfg.master / 100; micBoost.gain.value = cfg.boost / 100;
  deaf = false; gateOpen = false; micGate.gain.value = 0;
  applyOutput();
  await openMic();
  micOn = hasMic && $('startMic').checked; if (micRaw) micRaw.enabled = micOn;
  blankTrack = makeBlankTrack(); videoKind = 'none';
  localStream = new MediaStream([micDest.stream.getAudioTracks()[0], blankTrack]);
  refreshDevices();
}
function readNick() {
  const n = $('nick').value.trim().slice(0, 20);
  if (!n) { lobbyMsg('Сначала введи ник'); $('nick').focus(); return null; }
  store.set('nick', n); return n;
}

async function createRoom(attempt) {
  attempt = attempt || 0;
  if (!attempt) {
    myName = readNick(); if (!myName) return;
    busy(true); lobbyMsg('Создаём комнату', true);
    await prepareMedia();
    roomCode = myRoomCode();
  }
  isHost = true;
  peer = new Peer(PREFIX + roomCode, peerOptions());
  peer.once('open', () => enterRoom());
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id' && !inRoom) {
      try { peer.destroy(); } catch (e) { /* ignore */ }
      if (attempt < 3) { lobbyMsg('Код ещё занят прошлым запуском, ждём', true); setTimeout(() => createRoom(attempt + 1), 1500); return; }
      if (attempt === 3) { roomCode = genCode(); store.set('myRoom', roomCode); paintMyCode(); toast('Прежний код занят, комнате выдан новый'); createRoom(4); return; }
    }
    peerError(err);
  });
  attachPeerEvents();
}
async function joinRoom() {
  myName = readNick(); if (!myName) return;
  const code = $('code').value.trim().toUpperCase();
  if (code.length !== 6) { lobbyMsg('В коде комнаты шесть символов'); return; }
  busy(true); lobbyMsg('Подключаемся', true);
  await prepareMedia();
  isHost = false; roomCode = code;
  const hostId = PREFIX + code;
  peer = new Peer(peerOptions());
  peer.on('error', peerError);
  attachPeerEvents();
  joinTimer = setTimeout(() => { if (!inRoom) failJoin('Не получилось подключиться. Проверь код и интернет'); }, 15000);
  peer.once('open', () => {
    const conn = peer.connect(hostId, { metadata: { name: myName }, reliable: true });
    conn.on('data', (d) => {
      if (d && d.type === 'full') return failJoin('В комнате уже четверо');
      if (d && d.type === 'welcome' && !inRoom) {
        store.set('lastJoin', code);
        enterRoom();
        const host = ensurePeer(hostId, String(d.hostName || 'Хозяин').slice(0, 20)); host.conn = conn;
        conn.send(stateMsg()); callPeer(host);
        for (const m of (d.members || []).slice(0, MAX_PLAYERS - 2)) {
          const p = ensurePeer(m.id, String(m.name || 'Игрок').slice(0, 20)); if (!p) break;
          const c = peer.connect(m.id, { metadata: { name: myName }, reliable: true });
          wireConn(c, () => { p.conn = c; c.send(stateMsg()); });
          callPeer(p);
        }
        return;
      }
      onData(hostId, d);
    });
    conn.on('close', () => { if (inRoom) removePeer(hostId); });
    conn.on('error', () => {});
  });
}
function failJoin(text) { cleanup(); lobbyMsg(text); }
function peerError(err) {
  const t = err && err.type;
  if (!inRoom) {
    if (t === 'peer-unavailable') return failJoin('Комнаты с таким кодом сейчас нет. Попроси друга создать её');
    return failJoin('Сервер связи недоступен. Проверь интернет и попробуй ещё раз');
  }
  if (t === 'peer-unavailable') return;
  if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') { $('netState').textContent = 'сервер недоступен'; $('netState').classList.add('off'); }
}

function enterRoom() {
  clearTimeout(joinTimer);
  inRoom = true; busy(false); lobbyMsg('');
  $('lobby').hidden = true; $('room').hidden = false; $('barRoom').hidden = false;
  $('roomCode').textContent = roomCode; $('ovCode').textContent = roomCode;
  buildSlots();
  const me = claimSlot('me', myName);
  me.video.srcObject = new MediaStream([blankTrack]);
  paintControls();
  startedAt = Date.now();
  tickTimer = setInterval(tick, 30); statTimer = setInterval(pollStats, 2000);
  clockTimer = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000), h = Math.floor(s / 3600);
    const mm = String(Math.floor(s / 60) % 60).padStart(2, '0'), ss = String(s % 60).padStart(2, '0');
    $('timer').textContent = (h ? h + ':' : '') + mm + ':' + ss;
  }, 1000);
  sendPttConfig(); keepAwake();
  if (!hasMic) toast('Микрофон не найден, команда тебя не услышит');
  if ($('startCam').checked) camOn();
  if (isHost) sysMsg('Комната открыта. Код для друзей: ' + roomCode);
}
function cleanup() {
  clearTimeout(joinTimer); clearInterval(tickTimer); clearInterval(statTimer); clearInterval(clockTimer); clearInterval(blankTimer);
  if (overlayOn) setOverlay(false);
  broadcast({ type: 'bye' });
  for (const id of [...peers.keys()]) removePeer(id, true);
  if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } peer = null; }
  for (const t of [micRaw, camTrack, screenTrack, blankTrack]) { if (t) { t.onended = null; try { t.stop(); } catch (e) { /* ignore */ } } }
  try { if (micSrc) micSrc.disconnect(); } catch (e) { /* ignore */ }
  micSrc = micRaw = camTrack = screenTrack = blankTrack = null; localStream = null; videoKind = 'none'; pttHeld = false;
  if (micGate) micGate.gain.value = 0;
  if (api) api.pttConfig({ enabled: false });
  if (wakeLock) { try { wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
  $('grid').innerHTML = ''; slots = []; $('chatLog').innerHTML = ''; unread = 0; $('chatBadge').hidden = true; $('timer').textContent = '00:00';
  inRoom = false; busy(false);
  $('room').hidden = true; $('barRoom').hidden = true; $('lobby').hidden = false; $('chat').hidden = true; $('settings').hidden = true; $('picker').hidden = true;
  $('code').value = store.get('lastJoin', '');
}

/* ---------------- мини-окно поверх игры ---------------- */
function renderOverlayRows() {
  const list = $('ovList'); list.innerHTML = '';
  for (const s of slots) {
    s.row = null; if (!s.owner) continue;
    const r = document.createElement('div'); r.className = 'ov-row'; r.style.setProperty('--c', s.color);
    const nm = document.createElement('span'); nm.textContent = s.nm.textContent;
    r.append(nm);
    r.insertAdjacentHTML('beforeend', '<i class="st m">' + I.micoff + '</i><i class="st d">' + I.earoff + '</i>');
    list.appendChild(r); s.row = r;
  }
  paintControls(); for (const p of peers.values()) if (p.slot) applyPeerState(p);
  if (overlayOn && api) api.overlay(true, list.children.length, cfg.ovOp / 100);
}
function setOverlay(on) {
  if (on && !inRoom) return;
  overlayOn = on;
  document.body.classList.toggle('overlay', on); $('ov').hidden = !on;
  if (api) api.overlay(on, $('ovList').children.length, cfg.ovOp / 100);
}

/* ---------------- телефон: не гасить экран во время звонка ---------------- */
async function keepAwake() {
  if (!inRoom || !navigator.wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* не разрешено — не страшно */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

/* ---------------- рация по кнопке ---------------- */
function sendPttConfig() {
  if (!api) return;
  const on = inRoom && cfg.mode === 'ptt' && !!cfg.ptt;
  api.pttConfig(on ? { enabled: true, type: cfg.ptt.type, code: cfg.ptt.code } : { enabled: false });
}
function paintSettings() {
  document.querySelectorAll('#segMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === cfg.mode));
  $('pttRow').hidden = cfg.mode !== 'ptt'; $('gateRow').hidden = cfg.mode === 'ptt';
  $('btnBind').textContent = cfg.ptt ? cfg.ptt.label + ' (нажми, чтобы сменить)' : 'Назначить кнопку';
  $('gate').value = cfg.gate; $('gateVal').textContent = cfg.gate === 0 ? 'выключен' : cfg.gate + '%';
  $('meterMark').style.left = Math.min(100, cfg.gate) + '%';
  $('boost').value = cfg.boost; $('boostVal').textContent = cfg.boost + '%';
  $('master').value = cfg.master; $('masterVal').textContent = cfg.master + '%';
  $('cues').checked = cfg.cues;
  $('ovOp').value = cfg.ovOp; $('ovOpVal').textContent = cfg.ovOp + '%';
}
async function bindPtt() {
  if (!api) return toast('Рация по кнопке работает только в программе для Windows');
  const b = $('btnBind'); b.classList.add('wait'); b.textContent = 'Нажми клавишу или боковую кнопку мыши';
  const r = await api.pttCapture();
  b.classList.remove('wait');
  if (r && r.error) { toast('Не удалось включить перехват клавиш. Остался режим «Когда говорю»'); cfg.mode = 'voice'; store.set('mode', 'voice'); }
  else if (r) { cfg.ptt = r; store.set('ptt', JSON.stringify(r)); }
  paintSettings(); sendPttConfig(); paintControls();
}

/* ---------------- чат ---------------- */
function chatAdd(name, text, color) {
  const m = document.createElement('div'); m.className = 'msg'; if (color) m.style.setProperty('--c', color);
  const b = document.createElement('b'); b.textContent = name;
  const s = document.createElement('span'); s.textContent = text;
  m.append(b, s); $('chatLog').appendChild(m); $('chatLog').scrollTop = 1e9;
  if (name !== myName && $('chat').hidden) { unread++; $('chatBadge').textContent = unread; $('chatBadge').hidden = false; }
}
function sysMsg(text) {
  const m = document.createElement('div'); m.className = 'msg sys'; m.textContent = text;
  $('chatLog').appendChild(m); $('chatLog').scrollTop = 1e9;
}
function paintMyCode() { $('myCode').textContent = myRoomCode(); }

/* ---------------- обработчики ---------------- */
$('nick').value = store.get('nick', ''); $('code').value = store.get('lastJoin', '');
paintMyCode(); paintSettings(); paintControls();

$('btnCreate').onclick = () => createRoom(0);
$('btnJoin').onclick = joinRoom;
$('btnNewCode').onclick = () => { store.set('myRoom', genCode()); paintMyCode(); };
$('nick').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('code').value.length === 6 ? joinRoom() : createRoom(0)); });
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
$('code').addEventListener('input', () => { $('code').value = $('code').value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

$('ovMic').onclick = () => setMic(!(micOn && !deaf));
$('btnMic').onclick = () => { if (!holdPtt()) setMic(!(micOn && !deaf)); };
$('btnMic').addEventListener('pointerdown', (e) => { if (holdPtt()) { pttHeld = true; try { $('btnMic').setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } } });
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) $('btnMic').addEventListener(ev, () => { if (!api) pttHeld = false; });
$('btnMic').addEventListener('contextmenu', (e) => { if (!api) e.preventDefault(); });
if (!api) {
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !typing(e) && holdPtt()) { pttHeld = true; e.preventDefault(); } });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') pttHeld = false; });
  $('btnBind').hidden = true;
  $('pttHint').textContent = 'Держи кнопку микрофона на экране, а на компьютере — пробел.';
}
$('btnDeaf').onclick = $('ovDeaf').onclick = () => setDeaf(!deaf);
$('btnCam').onclick = () => (camTrack ? camOff() : camOn());
$('btnScreen').onclick = () => (videoKind === 'screen' ? screenOff() : screenOn());
$('btnChat').onclick = () => {
  $('chat').hidden = !$('chat').hidden;
  if (!$('chat').hidden) { unread = 0; $('chatBadge').hidden = true; $('chatInput').focus(); }
  paintControls();
};
$('chatClose').onclick = () => { $('chat').hidden = true; paintControls(); };
$('btnOverlay').onclick = () => setOverlay(true);
$('ovBack').onclick = () => setOverlay(false);
$('btnSettings').onclick = $('btnSettingsLobby').onclick = () => { refreshDevices(); paintSettings(); $('settings').hidden = false; };
$('settingsClose').onclick = () => { $('settings').hidden = true; };
$('btnLeave').onclick = cleanup;
$('btnCode').onclick = async () => {
  try { await navigator.clipboard.writeText(roomCode); toast('Код ' + roomCode + ' скопирован'); } catch (e) { toast('Код комнаты: ' + roomCode); }
};
$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim(); if (!text) return;
  $('chatInput').value = ''; chatAdd(myName, text, COLORS[0]); broadcast({ type: 'chat', text });
};
document.querySelectorAll('.winbtns button').forEach((b) => { b.onclick = () => api && api.win(b.dataset.win); });

document.querySelectorAll('#segMode button').forEach((b) => {
  b.onclick = () => {
    cfg.mode = b.dataset.mode; store.set('mode', cfg.mode); paintSettings(); paintControls(); sendPttConfig();
    if (cfg.mode === 'ptt' && !cfg.ptt && api) bindPtt();
  };
});
$('btnBind').onclick = bindPtt;
$('gate').oninput = () => { cfg.gate = +$('gate').value; store.set('gate', cfg.gate); paintSettings(); };
$('boost').oninput = () => { cfg.boost = +$('boost').value; store.set('boost', cfg.boost); if (micBoost) micBoost.gain.value = cfg.boost / 100; paintSettings(); };
$('master').oninput = () => { cfg.master = +$('master').value; store.set('master', cfg.master); if (masterGain && !deaf) masterGain.gain.value = cfg.master / 100; paintSettings(); };
$('cues').onchange = () => { cfg.cues = $('cues').checked; store.set('cues', cfg.cues ? '1' : '0'); };
$('ovOp').oninput = () => { cfg.ovOp = +$('ovOp').value; store.set('ovOp', cfg.ovOp); paintSettings(); };
$('selMic').onchange = async () => { store.set('dev:mic', $('selMic').value); if (inRoom) { await openMic(); if (micRaw) micRaw.enabled = micOn; else setMic(false, true); } };
$('selCam').onchange = async () => { store.set('dev:cam', $('selCam').value); if (inRoom && camTrack) { camTrack.onended = null; camTrack.stop(); camTrack = null; await camOn(); } };
$('selOut').onchange = () => { store.set('dev:out', $('selOut').value); applyOutput(); };
navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
window.addEventListener('beforeunload', () => { broadcast({ type: 'bye' }); if (peer) peer.destroy(); });

if (api) {
  api.onHotkey((name) => {
    if (!inRoom) return;
    if (name === 'mic') setMic(!(micOn && !deaf));
    else if (name === 'deaf') setDeaf(!deaf);
    else if (name === 'overlay') setOverlay(!overlayOn);
  });
  api.onPtt((down) => { pttHeld = down; });
  api.onPttFailed(() => { cfg.mode = 'voice'; store.set('mode', 'voice'); paintSettings(); paintControls(); toast('Перехват клавиш не запустился. Включён режим «Когда говорю»'); });
  api.onPickSource((sources) => {
    const list = $('pickerList'); list.innerHTML = '';
    const done = (id) => { $('picker').hidden = true; api.pickSource(id); };
    for (const s of sources) {
      const b = document.createElement('button'); b.className = 'src';
      const img = document.createElement('img'); img.src = s.thumb;
      const nm = document.createElement('div'); nm.textContent = s.name;
      b.append(img, nm); b.onclick = () => done(s.id); list.appendChild(b);
    }
    $('pickerCancel').onclick = () => done(null);
    if (overlayOn) setOverlay(false);
    $('picker').hidden = false;
  });
}
refreshDevices();

/* ---------------- проверка связи: какие серверы видны из этой сети ---------------- */
function iceProbe(server, relayOnly) { // собирает адреса через один сервер и смотрит, ответил ли он
  return new Promise((resolve) => {
    let pc, found = false; const t0 = Date.now();
    const want = relayOnly ? 'relay' : 'srflx';
    const finish = () => { try { pc.close(); } catch (e) { /* ignore */ } resolve({ ok: found, ms: Date.now() - t0 }); };
    try {
      pc = new RTCPeerConnection({ iceServers: [server], iceTransportPolicy: relayOnly ? 'relay' : 'all' });
      pc.onicecandidate = (e) => {
        if (!e.candidate) return finish();
        if (e.candidate.type === want || e.candidate.candidate.includes(' typ ' + want)) { found = true; finish(); }
      };
      pc.createDataChannel('probe');
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(finish);
      setTimeout(finish, 7000);
    } catch (e) { resolve({ ok: false, ms: 0 }); }
  });
}
async function runDiag() {
  const list = $('diagList'); list.innerHTML = ''; $('diagCopy').disabled = true;
  const report = ['ALEKUTAK, проверка связи, ' + new Date().toLocaleString('ru-RU'), navigator.userAgent];
  const row = (title) => { const li = document.createElement('li'); li.className = 'wait'; li.innerHTML = '<span></span><b></b>'; li.firstChild.textContent = title; list.appendChild(li); return li; };
  const set = (li, ok, text) => { li.className = ok ? 'ok' : 'bad'; li.lastChild.textContent = text; report.push((ok ? '[да]  ' : '[НЕТ] ') + li.firstChild.textContent + ': ' + text); };
  const timed = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
  const opt = peerOptions();

  const r1 = row('Сервер поиска собеседников: обычный запрос');
  const t1 = Date.now();
  const http = await timed(fetch('https://0.peerjs.com/peerjs/id', { cache: 'no-store' }).then((r) => r.ok).catch(() => false), 8000);
  set(r1, !!http, http ? 'отвечает, ' + (Date.now() - t1) + ' мс' : http === null ? 'нет ответа за 8 секунд' : 'запрос не прошёл');

  const r2 = row('Сервер поиска собеседников: постоянное соединение');
  const ws = await new Promise((res) => {
    const t0 = Date.now(); let p;
    const done = (ok, text) => { try { p.destroy(); } catch (e) { /* ignore */ } res({ ok, text }); };
    try {
      p = new Peer(opt);
      p.on('open', () => done(true, 'подключается, ' + (Date.now() - t0) + ' мс'));
      p.on('error', (e) => done(false, 'ошибка: ' + (e.type || 'неизвестная')));
      setTimeout(() => done(false, 'нет ответа за 10 секунд'), 10000);
    } catch (e) { res({ ok: false, text: 'не запустилось' }); }
  });
  set(r2, ws.ok, ws.text);

  const stuns = [['Определение адреса: Google', { urls: 'stun:stun.l.google.com:19302' }], ['Определение адреса: Cloudflare', { urls: 'stun:stun.cloudflare.com:3478' }]];
  for (const [title, srv] of stuns) { const li = row(title); const r = await iceProbe(srv, false); set(li, r.ok, r.ok ? 'отвечает, ' + r.ms + ' мс' : 'не отвечает'); }
  const turn = opt.config.iceServers.find((x) => x.username);
  const r5 = row('Запасной путь для звука и видео (ретранслятор)');
  const tr = await iceProbe(turn, true); set(r5, tr.ok, tr.ok ? 'работает, ' + tr.ms + ' мс' : 'не работает');

  // запасные площадки: где можно разместить сервер поиска так, чтобы он открывался из любой страны
  const timedOk = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(false), ms))]);
  const httpProbe = (url) => timedOk(fetch(url, { mode: 'no-cors', cache: 'no-store' }).then(() => true).catch(() => false), 8000);
  const wsProbe = (url, proto) => timedOk(new Promise((res) => {
    try { const w = proto ? new WebSocket(url, proto) : new WebSocket(url); w.onopen = () => { res(true); w.close(); }; w.onerror = () => res(false); w.onclose = () => res(false); } catch (e) { res(false); }
  }), 8000);
  const spare = [
    ['huggingface.co', () => httpProbe('https://huggingface.co/robots.txt')],
    ['hf.space', () => httpProbe('https://alekutak-probe.hf.space/')],
    ['deno.dev', () => httpProbe('https://alekutak-probe.deno.dev/')],
    ['onrender.com', () => httpProbe('https://alekutak-probe.onrender.com/')],
    ['koyeb.app', () => httpProbe('https://alekutak-probe.koyeb.app/')],
    ['fly.dev', () => httpProbe('https://alekutak-probe.fly.dev/')],
    ['workers.dev', () => httpProbe('https://alekutak-probe.workers.dev/')],
    ['supabase.co', () => httpProbe('https://alekutak-probe.supabase.co/')],
    ['firebaseio.com', () => httpProbe('https://alekutak-probe-default-rtdb.firebaseio.com/.json')],
    ['broker.emqx.io', () => wsProbe('wss://broker.emqx.io:8084/mqtt', 'mqtt')],
    ['broker.hivemq.com', () => wsProbe('wss://broker.hivemq.com:8884/mqtt', 'mqtt')],
    ['test.mosquitto.org', () => wsProbe('wss://test.mosquitto.org:8081', 'mqtt')],
    ['tracker.openwebtorrent.com', () => wsProbe('wss://tracker.openwebtorrent.com')],
    ['tracker.webtorrent.dev', () => wsProbe('wss://tracker.webtorrent.dev')],
    ['relay.damus.io', () => wsProbe('wss://relay.damus.io')],
    ['nos.lol', () => wsProbe('wss://nos.lol')],
    ['relay.primal.net', () => wsProbe('wss://relay.primal.net')]
  ];
  await Promise.all(spare.map(async ([host, run]) => {
    const li = row('Запасная площадка: ' + host), t0 = Date.now();
    const ok = await run(); set(li, ok, ok ? 'открывается, ' + (Date.now() - t0) + ' мс' : 'не открывается');
  }));

  $('diagCopy').disabled = false;
  $('diagCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(report.join('\n')); toast('Отчёт скопирован, отправь его Ваду'); }
    catch (e) { prompt('Скопируй отчёт', report.join(' | ')); }
  };
}
$('btnDiag').onclick = () => { $('diag').hidden = false; runDiag(); };
$('diagClose').onclick = () => { $('diag').hidden = true; };
if (new URLSearchParams(location.search).has('diag')) { const sp0 = $('splash'); if (sp0) sp0.remove(); $('diag').hidden = false; runDiag(); }

/* ---------------- заставка при запуске ---------------- */
(function splash() {
  const sp = $('splash'); if (!sp) return;
  let snd = null, done = false;
  const end = (fast) => {
    if (done) return; done = true;
    if (snd && fast) { // пропуск по клику: звук быстро затихает
      const v0 = snd.volume; let k = 0;
      const t = setInterval(() => { k++; snd.volume = Math.max(0, v0 * (1 - k / 8)); if (k >= 8) { clearInterval(t); snd.pause(); } }, 25);
    }
    sp.remove();
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return end();
  // блик идёт только по форме знака
  const mask = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' + MARK_SHAPE + '</svg>') + '")';
  $('spSheen').style.webkitMaskImage = mask; $('spSheen').style.maskImage = mask;
  const start = () => { if (done || sp.classList.contains('run')) return; sp.classList.add('run'); setTimeout(() => end(false), 4850); };
  sp.onclick = () => end(true);
  if (!cfg.cues) return start();
  snd = new Audio('intro.wav'); snd.volume = 0.5; snd.preload = 'auto';
  const go = () => { if (go.did) return; go.did = true; snd.play().then(() => setTimeout(start, 40)).catch(start); };
  snd.addEventListener('canplaythrough', go, { once: true });
  snd.addEventListener('error', start, { once: true });
  setTimeout(go, 700); // если файл долго читается, не ждём
})();
