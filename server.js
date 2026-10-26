const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
};

// ---------- Game settings ----------
const MIN_PLAYERS = 5;       // round starts automatically when this many are connected
const COUNTDOWN_SECONDS = 3; // delay before the round starts
const ROUND_SECONDS = 150;
const END_DELAY_MS = 7000;   // how long the result screen stays
const STAB_RANGE = 3;
const STAB_CD = 800;
const SHOT_RANGE = 80;
const SHOT_CD = 2000;

// ---------- Map (shared with client) ----------
const mapData = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'map.json'), 'utf8'));
const boxes = mapData.boxes.map((b) => ({
  minX: b.x - b.w / 2, maxX: b.x + b.w / 2,
  minZ: b.z - b.d / 2, maxZ: b.z + b.d / 2,
  minY: 0, maxY: b.h,
}));

function rayBox(o, d, b) {
  const lo = [b.minX, b.minY, b.minZ];
  const hi = [b.maxX, b.maxY, b.maxZ];
  let tmin = 0, tmax = Infinity;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < lo[a] || o[a] > hi[a]) return null;
    } else {
      let t1 = (lo[a] - o[a]) / d[a];
      let t2 = (hi[a] - o[a]) / d[a];
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

// distance along the ray to the first wall (or maxT if none)
function firstWallHit(o, d, maxT) {
  let best = maxT;
  for (const b of boxes) {
    const t = rayBox(o, d, b);
    if (t !== null && t < best) best = t;
  }
  return best;
}

// ---------- HTTP: serve game files ----------
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------- Game state ----------
const wss = new WebSocketServer({ server });
const players = new Map(); // id -> player
let nextId = 1;

let phase = 'lobby'; // lobby | countdown | playing | ended
let participants = [];
let gun = null;      // dropped gun {x,y,z} or null
let roundEndAt = 0;
let countdownTimer = null;
let timeTimer = null;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const pub = (p) => ({ id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, z: p.z, ry: p.ry, alive: p.alive });

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(obj, except) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client !== except && client.readyState === 1) client.send(msg);
  }
}

function lobbySpawn() {
  return { x: (Math.random() - 0.5) * 10, z: 7 + Math.random() * 3 };
}

// ---------- Lobby / countdown ----------
function broadcastLobby() {
  broadcast({ t: 'lobby', have: players.size, need: MIN_PLAYERS });
}

function checkLobby() {
  if (phase !== 'lobby') return;
  if (players.size >= MIN_PLAYERS) beginCountdown();
  else broadcastLobby();
}

function beginCountdown() {
  phase = 'countdown';
  let n = COUNTDOWN_SECONDS;
  const step = () => {
    if (phase !== 'countdown') return;
    if (players.size < MIN_PLAYERS) {
      phase = 'lobby';
      broadcastLobby();
      return;
    }
    if (n === 0) {
      startRound();
      return;
    }
    broadcast({ t: 'countdown', n });
    n--;
    countdownTimer = setTimeout(step, 1000);
  };
  step();
}

// ---------- Round ----------
function startRound() {
  phase = 'playing';
  gun = null;
  participants = [...players.values()];

  // shuffle (Fisher-Yates) and assign roles
  const order = [...participants];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  order.forEach((p, i) => {
    p.role = i === 0 ? 'murderer' : i === 1 ? 'sheriff' : 'innocent';
    p.alive = true;
    p.inRound = true;
    p.stabAt = 0;
    p.shotAt = 0;
    p.ignoreMoveUntil = Date.now() + 400;
  });

  // spawn everyone around the outer edge of the arena
  const n = participants.length;
  participants.forEach((p, i) => {
    const a = (2 * Math.PI * i) / n;
    const c = Math.cos(a), s = Math.sin(a);
    const k = 34 / Math.max(Math.abs(c), Math.abs(s));
    p.x = c * k;
    p.z = s * k;
    p.y = 0;
    p.ry = Math.atan2(-c, -s); // face the center
    send(p.ws, { t: 'start', role: p.role, x: p.x, z: p.z, ry: p.ry, seconds: ROUND_SECONDS });
  });

  broadcast({ t: 'gun', gun: null });
  roundEndAt = Date.now() + ROUND_SECONDS * 1000;
  broadcast({ t: 'time', left: ROUND_SECONDS });

  clearInterval(timeTimer);
  timeTimer = setInterval(() => {
    if (phase !== 'playing') {
      clearInterval(timeTimer);
      return;
    }
    const left = Math.ceil((roundEndAt - Date.now()) / 1000);
    if (left <= 0) endRound('innocents');
    else broadcast({ t: 'time', left });
  }, 1000);
}

function dropGun(p) {
  gun = { x: p.x, y: p.y, z: p.z };
  broadcast({ t: 'gun', gun });
}

function kill(victim, reason) {
  if (!victim.alive) return;
  victim.alive = false;
  broadcast({ t: 'death', id: victim.id, name: victim.name, reason });
  if (victim.role === 'sheriff') dropGun(victim);
}

function checkWin() {
  if (phase !== 'playing') return;
  const murderer = participants.find((p) => p.role === 'murderer');
  if (!murderer || !murderer.alive) return endRound('innocents');
  if (!participants.some((p) => p.role !== 'murderer' && p.alive)) endRound('murderer');
}

function endRound(winner) {
  if (phase !== 'playing') return;
  phase = 'ended';
  clearInterval(timeTimer);
  const roles = participants.map((p) => ({ id: p.id, name: p.name, role: p.role, alive: p.alive }));
  broadcast({ t: 'end', winner, roles });
  setTimeout(resetToLobby, END_DELAY_MS);
}

function resetToLobby() {
  phase = 'lobby';
  gun = null;
  participants = [];
  for (const p of players.values()) {
    p.alive = true;
    p.inRound = false;
    p.role = null;
    const s = lobbySpawn();
    p.x = s.x; p.y = 0; p.z = s.z;
    p.ignoreMoveUntil = Date.now() + 400;
    send(p.ws, { t: 'reset', x: p.x, z: p.z });
  }
  // players who joined mid-round become visible now
  for (const p of players.values()) {
    if (p.spectator) {
      p.spectator = false;
      broadcast({ t: 'join', player: pub(p) }, p.ws);
    }
  }
  broadcast({ t: 'gun', gun: null });
  checkLobby();
}

// ---------- Combat helpers ----------
function hitPlayer(o, d, q) {
  let best = null;
  for (const h of [0.35, 0.9, 1.45]) { // feet / chest / head
    const cx = q.x - o[0], cy = q.y + h - o[1], cz = q.z - o[2];
    const t = cx * d[0] + cy * d[1] + cz * d[2];
    if (t < 0 || t > SHOT_RANGE) continue;
    const d2 = cx * cx + cy * cy + cz * cz - t * t;
    if (d2 < 0.3 && (best === null || t < best)) best = t;
  }
  return best;
}

// ---------- Connections ----------
wss.on('connection', (ws) => {
  const id = nextId++;
  const s = lobbySpawn();
  const p = {
    id, ws,
    name: 'Player' + id, color: 0x4488ff,
    x: s.x, y: 0, z: s.z, ry: 0,
    alive: true, inRound: false, role: null,
    spectator: phase === 'playing' || phase === 'ended',
    stabAt: 0, shotAt: 0, ignoreMoveUntil: 0,
  };
  players.set(id, p);
  ws.isAlive = true;

  send(ws, {
    t: 'init', id, x: p.x, z: p.z,
    spectator: p.spectator, phase, gun,
    need: MIN_PLAYERS, have: players.size,
    timeLeft: phase === 'playing' ? Math.ceil((roundEndAt - Date.now()) / 1000) : 0,
    players: [...players.values()].filter((q) => !q.spectator).map(pub),
  });
  if (!p.spectator) broadcast({ t: 'join', player: pub(p) }, ws);
  checkLobby();

  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const now = Date.now();

    if (m.t === 'hello') {
      p.name = String(m.name || '').slice(0, 12) || p.name;
      p.color = clamp(num(m.color), 0, 0xffffff);
      if (!p.spectator) broadcast({ t: 'info', id, name: p.name, color: p.color });

    } else if (m.t === 'move') {
      if (p.spectator || !p.alive || now < p.ignoreMoveUntil) return;
      p.x = clamp(num(m.x), -100, 100);
      p.y = clamp(num(m.y), 0, 30);
      p.z = clamp(num(m.z), -100, 100);
      p.ry = num(m.ry);
      // pick up a dropped gun
      if (gun && phase === 'playing' && p.inRound && p.role === 'innocent') {
        const dx = p.x - gun.x, dz = p.z - gun.z;
        if (dx * dx + dz * dz < 2.25 && Math.abs(p.y - gun.y) < 2) {
          gun = null;
          p.role = 'sheriff';
          broadcast({ t: 'gun', gun: null });
          send(ws, { t: 'role', role: 'sheriff' });
        }
      }

    } else if (m.t === 'stab') {
      if (phase !== 'playing' || !p.alive || p.role !== 'murderer' || now - p.stabAt < STAB_CD) return;
      p.stabAt = now;
      p.ry = num(m.ry);
      broadcast({ t: 'stab', id });
      const fx = Math.sin(p.ry), fz = Math.cos(p.ry);
      let best = null, bestDist = STAB_RANGE;
      for (const q of participants) {
        if (q === p || !q.alive) continue;
        const dx = q.x - p.x, dz = q.z - p.z;
        const dist = Math.hypot(dx, dz);
        if (dist >= bestDist || Math.abs(q.y - p.y) > 2.5) continue;
        if (dist > 0.01 && (dx * fx + dz * fz) / dist < -0.1) continue; // must be in front
        const o = [p.x, p.y + 1, p.z];
        const v = [dx, q.y - p.y, dz];
        const L = Math.hypot(v[0], v[1], v[2]);
        if (L > 0.01 && firstWallHit(o, [v[0] / L, v[1] / L, v[2] / L], L) < L - 0.01) continue; // wall in the way
        best = q;
        bestDist = dist;
      }
      if (best) {
        kill(best, 'stab');
        checkWin();
      }

    } else if (m.t === 'shoot') {
      if (phase !== 'playing' || !p.alive || p.role !== 'sheriff' || now - p.shotAt < SHOT_CD) return;
      let dx = num(m.dx), dy = num(m.dy), dz = num(m.dz);
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) return;
      dx /= len; dy /= len; dz /= len;
      p.shotAt = now;

      const o = [p.x, p.y + 1.2, p.z];
      const d = [dx, dy, dz];
      let bestT = firstWallHit(o, d, SHOT_RANGE);
      let target = null;
      for (const q of participants) {
        if (q === p || !q.alive) continue;
        const t = hitPlayer(o, d, q);
        if (t !== null && t < bestT) { target = q; bestT = t; }
      }
      broadcast({
        t: 'shot', id,
        ox: o[0], oy: o[1], oz: o[2],
        ex: o[0] + dx * bestT, ey: o[1] + dy * bestT, ez: o[2] + dz * bestT,
      });
      if (target) {
        kill(target, 'shot');
        if (target.role !== 'murderer') kill(p, 'friendly'); // shot an innocent -> sheriff dies too
        checkWin();
      }
    }
  });

  ws.on('close', () => {
    players.delete(id);
    if (!p.spectator) broadcast({ t: 'leave', id });
    if (p.inRound && p.alive && phase === 'playing') {
      p.alive = false;
      if (p.role === 'sheriff') dropGun(p);
      checkWin();
    }
    if (phase === 'lobby' || phase === 'countdown') {
      if (phase === 'lobby') broadcastLobby();
    }
  });
});

// Broadcast positions (15 Hz)
setInterval(() => {
  const list = [...players.values()]
    .filter((p) => !p.spectator)
    .map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z, ry: p.ry }));
  if (list.length) broadcast({ t: 'state', players: list });
}, 1000 / 15);

// Keep connections alive (Render may drop idle sockets)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log('Server listening on', PORT));
