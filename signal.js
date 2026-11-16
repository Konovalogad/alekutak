'use strict';
/* Поиск собеседников без своего сервера.
   Библиотека PeerJS думает, что говорит со своим сервером по WebSocket, а на деле её сообщения
   идут через несколько публичных MQTT-брокеров сразу. Достаточно, чтобы у двух человек
   открывался хотя бы один общий брокер. Сообщения шифруются ключом из кода комнаты,
   поэтому на брокере их никто не прочитает и не подделает. */
(function () {
  const RealWS = window.WebSocket;
  const HOST = 'signal.alekutak.invalid';
  const DEFAULT_BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081', 'wss://broker.hivemq.com:8884/mqtt'];
  const override = new URLSearchParams(location.search).get('mq'); // локальная проверка
  const BROKERS = override ? override.split(',') : DEFAULT_BROKERS;
  const enc = new TextEncoder(), dec = new TextDecoder();
  let room = '';

  const rand = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, '0')).join('');
  async function sha(text) { return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))); }
  const topics = new Map();
  async function topicFor(id) {
    if (!topics.has(id)) topics.set(id, 'alk4/' + [...(await sha('alekutak-topic|' + id))].slice(0, 20).map((x) => x.toString(16).padStart(2, '0')).join(''));
    return topics.get(id);
  }
  async function keyFor(code) { return crypto.subtle.importKey('raw', await sha('alekutak-key|' + code), 'AES-GCM', false, ['encrypt', 'decrypt']); }
  async function seal(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
  }
  async function unseal(key, bytes) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
    return JSON.parse(dec.decode(pt));
  }

  /* --- самый маленький MQTT 3.1.1: подключиться, подписаться, отправлять и получать --- */
  function mstr(s) { const b = enc.encode(s), o = new Uint8Array(2 + b.length); o[0] = b.length >> 8; o[1] = b.length & 255; o.set(b, 2); return o; }
  function join(parts) { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; }
  function packet(type, body) {
    const len = []; let n = body.length;
    do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; len.push(d); } while (n > 0);
    return join([Uint8Array.of(type), Uint8Array.from(len), body]);
  }
  function Link(url, topic, onPayload, onState) {
    const self = this; let ws = null, buf = new Uint8Array(0), ping = null, retry = null, dead = false;
    self.up = false; self.settled = false; self.url = url;
    function fail() {
      if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
      clearInterval(ping); self.up = false; self.settled = true;
      if (dead) return;
      setTimeout(onState, 0); retry = setTimeout(connect, 5000);
    }
    function handle(type, flags, body) {
      if (type === 2) { // CONNACK
        if (body[1] !== 0) return fail();
        ws.send(packet(0x82, join([Uint8Array.of(0, 1), mstr(topic), Uint8Array.of(0)])));
      } else if (type === 9) { // SUBACK
        self.up = true; self.settled = true;
        ping = setInterval(() => { try { ws.send(Uint8Array.of(0xc0, 0)); } catch (e) { fail(); } }, 25000);
        onState();
      } else if (type === 3) { // PUBLISH
        const tlen = (body[0] << 8) | body[1]; const skip = 2 + tlen + ((flags & 6) ? 2 : 0);
        onPayload(body.slice(skip));
      }
    }
    function connect() {
      if (dead) return;
      try { ws = new RealWS(url, 'mqtt'); } catch (e) { return fail(); }
      ws.binaryType = 'arraybuffer'; buf = new Uint8Array(0);
      ws.onopen = () => ws.send(packet(0x10, join([mstr('MQTT'), Uint8Array.of(4, 2, 0, 60), mstr('alk' + rand(8))])));
      ws.onmessage = (e) => {
        buf = join([buf, new Uint8Array(e.data)]);
        for (;;) {
          if (buf.length < 2) return;
          let mult = 1, len = 0, i = 1, d;
          do { if (i >= buf.length) return; d = buf[i++]; len += (d & 127) * mult; mult *= 128; } while (d & 128);
          if (buf.length < i + len) return;
          const type = buf[0] >> 4, flags = buf[0] & 15, body = buf.subarray(i, i + len);
          buf = buf.slice(i + len);
          handle(type, flags, body);
          if (!ws) return;
        }
      };
      ws.onclose = ws.onerror = fail;
    }
    self.publish = (t, payload) => { if (!self.up) return false; try { ws.send(packet(0x30, join([mstr(t), payload]))); return true; } catch (e) { return false; } };
    self.close = () => { dead = true; clearTimeout(retry); fail(); };
    connect();
  }

  /* --- то, что PeerJS принимает за WebSocket к своему серверу --- */
  function SignalSocket(url) {
    const self = this;
    self.readyState = 0; self.onopen = self.onmessage = self.onclose = self.onerror = null;
    const id = new URL(url).searchParams.get('id'), code = room;
    let links = [], key = null, opened = false, closed = false, grace = null, graceOver = false;
    const seen = new Set(), heard = new Set(), asked = new Set();
    const deliver = (m) => { if (!closed && self.onmessage) self.onmessage({ data: JSON.stringify(m) }); };
    function drop() {
      if (closed) return; closed = true; self.readyState = 3;
      clearTimeout(grace); for (const l of links) l.close();
      if (self.onclose) self.onclose({});
    }
    function onState() {
      if (closed) return;
      const ups = links.filter((l) => l.up).length, settled = links.every((l) => l.settled);
      if (opened) { if (!ups && settled) drop(); return; }
      if (ups && (settled || graceOver)) {
        opened = true; self.readyState = 1;
        if (self.onopen) self.onopen({});
        deliver({ type: 'OPEN' });
      } else if (ups && !grace) { // даём остальным брокерам чуть времени, чтобы не разминуться с собеседником
        grace = setTimeout(() => { graceOver = true; onState(); }, 1500);
      } else if (!ups && settled) drop();
    }
    async function publish(m) {
      m.src = id; m._n = rand(8);
      const [t, bytes] = [await topicFor(m.dst), await seal(key, m)];
      for (const l of links) l.publish(t, bytes);
    }
    async function onPayload(bytes) {
      let m; try { m = await unseal(key, bytes); } catch (e) { return; } // чужое или с другим ключом
      if (!m || m.dst !== id || !m.src || seen.has(m._n)) return;
      seen.add(m._n); if (seen.size > 2000) seen.clear();
      heard.add(m.src);
      if (m.type === 'X-PING') return void publish({ type: 'X-PONG', dst: m.src });
      if (m.type === 'X-PONG') return;
      delete m._n; deliver(m);
    }
    self.send = (data) => {
      if (closed || !opened) return;
      let m; try { m = JSON.parse(data); } catch (e) { return; }
      if (m.type === 'HEARTBEAT' || !m.dst) return;
      if (!heard.has(m.dst) && !asked.has(m.dst)) { // первый раз пишем этому адресату: проверим, что он вообще в сети
        asked.add(m.dst); publish({ type: 'X-PING', dst: m.dst });
        setTimeout(() => { if (!heard.has(m.dst)) deliver({ type: 'EXPIRE', src: m.dst }); }, 9000);
      }
      publish(m);
    };
    self.close = () => { if (closed) return; closed = true; self.readyState = 3; clearTimeout(grace); for (const l of links) l.close(); };
    (async () => {
      try { key = await keyFor(code); const topic = await topicFor(id); if (closed) return; links = BROKERS.map((u) => new Link(u, topic, onPayload, onState)); }
      catch (e) { return drop(); }
      setTimeout(() => { if (!opened) drop(); }, 12000);
    })();
  }

  function PatchedWS(url, protocols) {
    if (String(url).includes(HOST)) return new SignalSocket(url);
    return protocols === undefined ? new RealWS(url) : new RealWS(url, protocols);
  }
  PatchedWS.prototype = RealWS.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) PatchedWS[k] = RealWS[k];
  window.WebSocket = PatchedWS;

  window.AlekutakSignal = {
    host: HOST,
    brokers: BROKERS,
    setRoom: (code) => { room = String(code); },
    // проверка одного брокера: подключиться и подписаться
    probe: (url) => new Promise((resolve) => {
      const t0 = Date.now(); let done = false;
      const l = new Link(url, 'alk4/probe-' + rand(6), () => {}, () => {
        if (done || !l.settled) return; done = true; const ok = l.up; l.close(); resolve({ ok, ms: Date.now() - t0 });
      });
      setTimeout(() => { if (!done) { done = true; l.close(); resolve({ ok: false, ms: Date.now() - t0 }); } }, 9000);
    })
  };
})();
