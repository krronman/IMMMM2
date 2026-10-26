import * as THREE from 'three';

// ================= Settings =================
const R = 0.4;      // player radius
const H = 1.8;      // player height
const SPEED = 7;
const GRAVITY = 25;
const JUMP = 9;
const CAM_DIST = 7;
const STAB_CD = 800;
const SHOT_CD = 2000;

const map = await (await fetch('map.json')).json();

// ================= Scene =================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 50, 130);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 300);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xffffff, 0x556655, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(30, 50, 20);
sun.castShadow = true;
sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
sun.shadow.camera.top = 60;   sun.shadow.camera.bottom = -60;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(300, 300),
  new THREE.MeshStandardMaterial({ color: 0x7d8f6b })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
scene.add(new THREE.GridHelper(80, 40, 0x6a7c58, 0x6a7c58));

// Map boxes (visual + collision)
const boxes = [];
for (const b of map.boxes) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(b.w, b.h, b.d),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(b.color) })
  );
  mesh.position.set(b.x, b.h / 2, b.z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  boxes.push({
    minX: b.x - b.w / 2, maxX: b.x + b.w / 2,
    minZ: b.z - b.d / 2, maxZ: b.z + b.d / 2,
    minY: 0, maxY: b.h,
  });
}

// ================= Characters =================
function makeLabel(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 36px sans-serif';
  g.textAlign = 'center';
  g.fillStyle = 'rgba(0,0,0,.5)';
  g.fillRect(0, 8, 256, 48);
  g.fillStyle = '#fff';
  g.fillText(text, 128, 46);
  const tex = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex })); // depth-tested: no seeing names through walls
  s.scale.set(2, 0.5, 1);
  s.position.y = H + 0.5;
  return s;
}

function makeCharacter(name, color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(R, H - R * 2, 4, 12),
    new THREE.MeshStandardMaterial({ color })
  );
  body.position.y = H / 2;
  body.castShadow = true;
  g.add(body);
  const nose = new THREE.Mesh(
    new THREE.BoxGeometry(0.25, 0.2, 0.3),
    new THREE.MeshStandardMaterial({ color: 0xffffff })
  );
  nose.position.set(0, H - 0.5, R);
  g.add(nose);
  g.userData = { body, nose, label: makeLabel(name), held: null, lying: false };
  g.add(g.userData.label);
  scene.add(g);
  return g;
}

function setLabel(g, name) {
  g.remove(g.userData.label);
  g.userData.label.material.map.dispose();
  g.userData.label = makeLabel(name);
  g.userData.label.position.y = g.userData.lying ? 1.0 : H + 0.5;
  g.add(g.userData.label);
}

function layDown(g) {
  const b = g.userData.body;
  b.rotation.z = Math.PI / 2;
  b.position.y = R;
  b.material.transparent = true;
  b.material.opacity = 0.55;
  g.userData.nose.visible = false;
  g.userData.label.position.y = 1.0;
  g.userData.lying = true;
}

function standUp(g) {
  const b = g.userData.body;
  b.rotation.z = 0;
  b.position.y = H / 2;
  b.material.opacity = 1;
  g.userData.nose.visible = true;
  g.userData.label.position.y = H + 0.5;
  g.userData.lying = false;
}

// ================= State =================
const me = {
  pos: new THREE.Vector3(0, 0, 8),
  vy: 0,
  onGround: false,
  ry: 0,
  mesh: null,
  name: '',
  color: 0x3b82f6,
  role: null,          // 'murderer' | 'sheriff' | 'innocent' | null
  alive: true,
  spectating: false,   // joined mid-round, waits for next round
  stabAt: 0,
  shotAt: 0,
};
const others = new Map(); // id -> {mesh, target, tRy, alive, snap}
let myId = null;
let ws = null;
let started = false;
let connected = false;
let phase = 'lobby';
let haveCount = 1, needCount = 5, countN = 3, timeLeft = 0;
let endText = '';
let spectateId = null;
let gunMesh = null;
const fx = [];

const isGhost = () => !me.alive || me.spectating;

function setRole(role) {
  me.role = role;
  const g = me.mesh;
  if (!g) return;
  if (g.userData.held) {
    g.remove(g.userData.held);
    g.userData.held = null;
  }
  let held = null;
  if (role === 'murderer') {
    held = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.07, 0.7),
      new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.6, roughness: 0.3 })
    );
  } else if (role === 'sheriff') {
    held = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.2, 0.45),
      new THREE.MeshStandardMaterial({ color: 0x222222 })
    );
  }
  if (held) {
    held.position.set(0.5, 1.0, 0.5);
    g.add(held);
    g.userData.held = held;
  }
}

function setGun(g) {
  if (gunMesh) {
    scene.remove(gunMesh);
    gunMesh = null;
  }
  if (g) {
    gunMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.3, 0.9),
      new THREE.MeshStandardMaterial({ color: 0xffd400, emissive: 0xaa8800 })
    );
    gunMesh.userData.baseY = g.y + 0.7;
    gunMesh.position.set(g.x, gunMesh.userData.baseY, g.z);
    scene.add(gunMesh);
  }
}

function pickSpectate(step = 0) {
  const list = [...others.entries()].filter(([, o]) => o.alive);
  if (!list.length) {
    spectateId = null;
    return;
  }
  let idx = list.findIndex(([id]) => id === spectateId);
  idx = idx < 0 ? 0 : (idx + step + list.length) % list.length;
  spectateId = list[idx][0];
}

// ================= Input =================
const keys = {};
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => (keys[e.code] = false));

let yaw = 0, pitch = 0.45;
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * 0.003;
  pitch += e.movementY * 0.003;
  pitch = Math.max(0.05, Math.min(1.3, pitch));
});

function aimDirection() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const target = camera.position.clone().addScaledVector(dir, 60);
  const chest = new THREE.Vector3(me.pos.x, me.pos.y + 1.2, me.pos.z);
  return target.sub(chest).normalize();
}

addEventListener('mousedown', (e) => {
  if (!started) return;
  if (document.pointerLockElement !== renderer.domElement) {
    renderer.domElement.requestPointerLock?.();
    return;
  }
  if (e.button !== 0) return;
  if (isGhost()) {
    pickSpectate(1);
    return;
  }
  if (phase !== 'playing') return;
  const now = performance.now();
  if (me.role === 'murderer' && now - me.stabAt > STAB_CD) {
    me.stabAt = now;
    me.ry = Math.atan2(-Math.sin(yaw), -Math.cos(yaw)); // face where the camera looks
    me.mesh.rotation.y = me.ry;
    sendMove();
    send({ t: 'stab', ry: me.ry });
  } else if (me.role === 'sheriff' && now - me.shotAt > SHOT_CD) {
    me.shotAt = now;
    const d = aimDirection();
    sendMove();
    send({ t: 'shoot', dx: d.x, dy: d.y, dz: d.z });
  }
});

// ================= Collision & movement =================
function hits(px, py, pz) {
  for (const b of boxes) {
    if (px + R > b.minX && px - R < b.maxX && pz + R > b.minZ && pz - R < b.maxZ && py < b.maxY && py + H > b.minY) {
      return b;
    }
  }
  return null;
}

function updateMe(dt) {
  let f = 0, r = 0;
  if (keys.KeyW || keys.ArrowUp) f += 1;
  if (keys.KeyS || keys.ArrowDown) f -= 1;
  if (keys.KeyD || keys.ArrowRight) r += 1;
  if (keys.KeyA || keys.ArrowLeft) r -= 1;

  const fx_ = -Math.sin(yaw), fz_ = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  let dx = fx_ * f + rx * r;
  let dz = fz_ * f + rz * r;
  const len = Math.hypot(dx, dz);
  if (len > 0) {
    dx /= len; dz /= len;
    const target = Math.atan2(dx, dz);
    let diff = target - me.ry;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    me.ry += diff * Math.min(1, dt * 14);
  }

  const nx = me.pos.x + dx * SPEED * dt;
  if (!hits(nx, me.pos.y, me.pos.z)) me.pos.x = nx;
  const nz = me.pos.z + dz * SPEED * dt;
  if (!hits(me.pos.x, me.pos.y, nz)) me.pos.z = nz;

  if (keys.Space && me.onGround) {
    me.vy = JUMP;
    me.onGround = false;
  }

  me.vy -= GRAVITY * dt;
  const ny = me.pos.y + me.vy * dt;
  const hit = hits(me.pos.x, ny, me.pos.z);
  me.onGround = false;
  if (hit) {
    if (me.vy < 0) {
      me.pos.y = hit.maxY;
      me.onGround = true;
    }
    me.vy = 0;
  } else {
    me.pos.y = ny;
  }
  if (me.pos.y <= 0) {
    me.pos.y = 0;
    me.vy = 0;
    me.onGround = true;
  }

  me.mesh.position.copy(me.pos);
  me.mesh.rotation.y = me.ry;
}

function updateCamera() {
  let fp = me.pos;
  if (isGhost()) {
    const o = others.get(spectateId);
    if (o) fp = o.mesh.position;
  }
  const cx = fp.x + Math.sin(yaw) * Math.cos(pitch) * CAM_DIST;
  const cy = fp.y + 1.5 + Math.sin(pitch) * CAM_DIST;
  const cz = fp.z + Math.cos(yaw) * Math.cos(pitch) * CAM_DIST;
  camera.position.set(cx, Math.max(cy, 0.3), cz);
  camera.lookAt(fp.x, fp.y + 1.4, fp.z);
}

// ================= Effects =================
function addTracer(a, b) {
  const len = a.distanceTo(b);
  if (len < 0.01) return;
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.07, len),
    new THREE.MeshBasicMaterial({ color: 0xffee55 })
  );
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.lookAt(b);
  scene.add(m);
  fx.push({ obj: m, life: 0.2, max: 0.2, type: 'tracer' });
}

function addSlash(pos) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(1, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xff3333, transparent: true, opacity: 0.5 })
  );
  m.position.copy(pos);
  m.position.y += 1;
  scene.add(m);
  fx.push({ obj: m, life: 0.25, max: 0.25, type: 'slash' });
}

function updateFx(dt) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const e = fx[i];
    e.life -= dt;
    if (e.life <= 0) {
      scene.remove(e.obj);
      e.obj.geometry.dispose();
      e.obj.material.dispose();
      fx.splice(i, 1);
    } else if (e.type === 'slash') {
      const k = 1 - e.life / e.max;
      e.obj.scale.setScalar(0.6 + k * 1.2);
      e.obj.material.opacity = (1 - k) * 0.5;
    }
  }
}

// ================= Network =================
function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function sendMove() {
  send({ t: 'move', x: me.pos.x, y: me.pos.y, z: me.pos.z, ry: me.ry });
}

function addOther(p) {
  if (p.id === myId || others.has(p.id)) return;
  const mesh = makeCharacter(p.name, p.color);
  mesh.position.set(p.x, p.y, p.z);
  mesh.rotation.y = p.ry || 0;
  const alive = p.alive !== false;
  if (!alive) layDown(mesh);
  others.set(p.id, { mesh, target: new THREE.Vector3(p.x, p.y, p.z), tRy: p.ry || 0, alive, snap: false });
}

function clearOthers() {
  for (const o of others.values()) scene.remove(o.mesh);
  others.clear();
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    connected = true;
    send({ t: 'hello', name: me.name, color: me.color });
  };

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    switch (m.t) {
      case 'init': {
        myId = m.id;
        phase = m.phase;
        needCount = m.need;
        haveCount = m.have;
        timeLeft = m.timeLeft;
        me.pos.set(m.x, 0, m.z);
        me.spectating = m.spectator;
        me.mesh.visible = !m.spectator;
        m.players.forEach(addOther);
        setGun(m.gun);
        if (m.spectator) pickSpectate(0);
        break;
      }
      case 'join':
        addOther(m.player);
        break;
      case 'leave': {
        const o = others.get(m.id);
        if (o) {
          scene.remove(o.mesh);
          others.delete(m.id);
        }
        break;
      }
      case 'info': {
        const o = others.get(m.id);
        if (o) {
          o.mesh.userData.body.material.color.setHex(m.color);
          setLabel(o.mesh, m.name);
        }
        break;
      }
      case 'state':
        for (const p of m.players) {
          const o = others.get(p.id);
          if (!o) continue;
          o.target.set(p.x, p.y, p.z);
          o.tRy = p.ry;
          if (o.snap) {
            o.mesh.position.copy(o.target);
            o.mesh.rotation.y = o.tRy;
            o.snap = false;
          }
        }
        break;
      case 'lobby':
        phase = 'lobby';
        haveCount = m.have;
        needCount = m.need;
        break;
      case 'countdown':
        phase = 'countdown';
        countN = m.n;
        break;
      case 'start': {
        phase = 'playing';
        endText = '';
        me.alive = true;
        me.spectating = false;
        me.mesh.visible = true;
        standUp(me.mesh);
        me.pos.set(m.x, 0, m.z);
        me.vy = 0;
        me.ry = m.ry;
        yaw = Math.atan2(-Math.sin(m.ry), -Math.cos(m.ry)) + Math.PI; // look toward the center
        setRole(m.role);
        timeLeft = m.seconds;
        for (const o of others.values()) {
          o.alive = true;
          standUp(o.mesh);
          o.snap = true;
        }
        spectateId = null;
        const msg = {
          murderer: 'You are the MURDERER\nStab everyone before time runs out!',
          sheriff: 'You are the SHERIFF\nShoot the murderer. If you shoot an innocent, you die!',
          innocent: 'You are INNOCENT\nSurvive! Grab the gun if the sheriff falls.',
        }[m.role];
        toast(msg, 5000);
        break;
      }
      case 'time':
        timeLeft = m.left;
        break;
      case 'death': {
        if (m.id === myId) {
          me.alive = false;
          layDown(me.mesh);
          setRole(me.role === 'murderer' ? 'murderer' : null);
          if (me.mesh.userData.held) {
            me.mesh.remove(me.mesh.userData.held);
            me.mesh.userData.held = null;
          }
          pickSpectate(0);
          toast(m.reason === 'friendly' ? 'You shot an innocent and died!' : 'You were eliminated!', 3000);
        } else {
          const o = others.get(m.id);
          if (o) {
            o.alive = false;
            layDown(o.mesh);
            if (spectateId === m.id) pickSpectate(0);
          }
          toast(`${m.name} was eliminated`, 2500);
        }
        break;
      }
      case 'gun':
        setGun(m.gun);
        if (m.gun) toast('The gun was dropped! Innocents can pick it up.', 3000);
        break;
      case 'role':
        setRole(m.role);
        toast('You picked up the gun — you are the Sheriff now!', 3000);
        break;
      case 'shot':
        addTracer(new THREE.Vector3(m.ox, m.oy, m.oz), new THREE.Vector3(m.ex, m.ey, m.ez));
        break;
      case 'stab': {
        const pos = m.id === myId ? me.pos : others.get(m.id)?.mesh.position;
        if (pos) addSlash(pos);
        break;
      }
      case 'end': {
        phase = 'ended';
        endText = m.winner === 'murderer' ? '🔪 The Murderer wins!' : '🛡️ The Innocents win!';
        const label = { murderer: 'Murderer', sheriff: 'Sheriff', innocent: 'Innocent' };
        document.getElementById('roles').textContent = m.roles
          .map((r) => `${r.name} — ${label[r.role]}${r.alive ? '' : ' (dead)'}`)
          .join('\n');
        break;
      }
      case 'reset': {
        phase = 'lobby';
        endText = '';
        document.getElementById('roles').textContent = '';
        me.alive = true;
        me.spectating = false;
        me.mesh.visible = true;
        standUp(me.mesh);
        setRole(null);
        me.pos.set(m.x, 0, m.z);
        me.vy = 0;
        for (const o of others.values()) {
          o.alive = true;
          standUp(o.mesh);
          o.snap = true;
        }
        setGun(null);
        break;
      }
    }
  };

  ws.onclose = () => {
    connected = false;
    clearOthers();
    setGun(null);
    me.alive = true;
    me.spectating = false;
    if (me.mesh) {
      me.mesh.visible = true;
      standUp(me.mesh);
      setRole(null);
    }
    phase = 'lobby';
    setTimeout(connect, 2000);
  };
}

// Send my position 15x per second
setInterval(() => {
  if (started && connected && !isGhost()) sendMove();
}, 1000 / 15);

// ================= UI =================
const $ = (id) => document.getElementById(id);
const el = { hud: $('hud'), role: $('role'), timer: $('timer'), banner: $('banner'), crosshair: $('crosshair'), toast: $('toast') };
function setText(e, s) {
  if (e._t !== s) {
    e.textContent = s;
    e._t = s;
  }
}

let toastTimer;
function toast(t, ms = 2500) {
  el.toast.textContent = t;
  el.toast.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.style.opacity = 0), ms);
}

function updateUi() {
  const ghost = isGhost();
  const total = others.size + (me.spectating ? 0 : 1);
  let hud = `Players: ${total}`;
  if (phase === 'playing') {
    const alive = (ghost ? 0 : 1) + [...others.values()].filter((o) => o.alive).length;
    hud += `\nAlive: ${alive}`;
  }
  setText(el.hud, hud);

  let role = '';
  if (phase === 'playing') {
    if (ghost) role = me.spectating ? 'Spectating' : 'You are dead';
    else role = { murderer: '🔪 Murderer', sheriff: '🔫 Sheriff', innocent: '🙂 Innocent' }[me.role] || '';
  }
  setText(el.role, role);
  el.role.style.color = me.role === 'murderer' ? '#ff6b6b' : me.role === 'sheriff' ? '#6bb6ff' : '#fff';

  if (phase === 'playing') {
    const m = Math.floor(timeLeft / 60), s = String(timeLeft % 60).padStart(2, '0');
    setText(el.timer, `${m}:${s}`);
  } else {
    setText(el.timer, '');
  }

  let banner = '';
  if (!connected) banner = 'Connecting...';
  else if (me.spectating) banner = 'Round in progress — you will join the next round';
  else if (phase === 'lobby') banner = `Waiting for players (${haveCount}/${needCount})`;
  else if (phase === 'countdown') banner = `Starting in ${countN}...`;
  else if (phase === 'ended') banner = endText;
  else if (phase === 'playing' && !me.alive) banner = 'Click to switch spectate target';
  setText(el.banner, banner);
  el.banner.style.fontSize = phase === 'countdown' ? '64px' : phase === 'ended' ? '40px' : '22px';

  el.crosshair.style.display = started && phase === 'playing' && !ghost && me.role !== 'innocent' ? 'block' : 'none';
}

$('start').onclick = () => {
  me.name = $('name').value.trim().slice(0, 12) || 'Player';
  me.color = parseInt($('color').value.slice(1), 16);
  me.mesh = makeCharacter(me.name, me.color);
  me.mesh.position.copy(me.pos);
  $('overlay').style.display = 'none';
  started = true;
  connect();
  renderer.domElement.requestPointerLock?.();
};

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ================= Main loop =================
const clock = new THREE.Clock();
camera.position.set(0, 10, 18);
camera.lookAt(0, 1, 0);

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (started) {
    if (!isGhost()) updateMe(dt);
    else if (!others.get(spectateId)?.alive) pickSpectate(0);
    updateCamera();
  }

  for (const o of others.values()) {
    o.mesh.position.lerp(o.target, Math.min(1, dt * 12));
    let diff = o.tRy - o.mesh.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    o.mesh.rotation.y += diff * Math.min(1, dt * 12);
  }

  if (gunMesh) {
    gunMesh.rotation.y += dt * 2;
    gunMesh.position.y = gunMesh.userData.baseY + Math.sin(performance.now() / 300) * 0.15;
  }

  updateFx(dt);
  updateUi();
  renderer.render(scene, camera);
}
loop();
