/* レース中継映像。実際のコース形状(直線 2 本+半円 2 つ)を 3D 空間に置いて透視投影で描き、
   ゲート → サイド追走 → コーナー → 向正面の俯瞰 → 直線の正面 → ゴール前 とカメラを切り替える */
(function (root) {
  'use strict';

  const TRACK_W = 26; // コース幅(m)。横位置 l=0 が内ラチ、l=TRACK_W が外ラチ
  const POST = 100; // ゴール板から 1 コーナーまでの直線(m)
  const TAU = Math.PI * 2;
  const CAP = { 1: '#ffffff', 2: '#222222', 3: '#e53935', 4: '#1e6fd9', 5: '#f6d000', 6: '#1a9b4b', 7: '#f08a00', 8: '#f49ac1' };
  const CAP_FG = { 1: '#111', 2: '#fff', 3: '#fff', 4: '#fff', 5: '#111', 6: '#fff', 7: '#111', 8: '#111' };
  // [馬体, たてがみ・尾, 脚先]
  const COAT = {
    鹿毛: ['#7a4a26', '#1b120c', '#1b120c'], 黒鹿毛: ['#4a2d1a', '#120c08', '#120c08'],
    青鹿毛: ['#2e2018', '#0b0806', '#0b0806'], 青毛: ['#1c1613', '#0a0806', '#0a0806'],
    栗毛: ['#a9592b', '#cf9358', '#8c4a24'], 栃栗毛: ['#7d3c1d', '#c39a6c', '#6a3318'],
    芦毛: ['#c4c1bb', '#8f8b85', '#77736e'],
  };
  const SEG_LABEL = {
    gate: 'スタート', home: 'スタンド前', c1: '1コーナー', c2: '2コーナー', back: '向正面',
    c3: '3コーナー', c4: '4コーナー', straight: '最後の直線', goal: 'ゴール',
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const hash = n => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

  function shade(hex, k) {
    const v = parseInt(hex.slice(1), 16);
    const f = c => clamp(Math.round(c * k), 0, 255);
    return `rgb(${f(v >> 16)},${f((v >> 8) & 255)},${f(v & 255)})`;
  }


  function createTV(canvas, race, opts = {}) {
    const ctx = canvas.getContext('2d');
    const n = race.n, D = race.distance;
    const mirror = race.dir === '左' ? 1 : -1; // 右回りは画面の左右反転で表す
    const going = ['良', '稍重', '重', '不良'].indexOf(race.going);
    const turf = race.surface === '芝';
    const mine = opts.mine || new Set();

    // ---------- コース形状 ----------
    // ゴール板を原点に、ホームストレッチを +X 方向へ走る。内馬場は -Z 側。
    // q はゴール板から進行方向へ測った内ラチ上の距離、s はレースの走行距離(ゴール板で s=D)
    const S = race.course.straight, Ls = S + POST;
    const arc = Math.max(150, (race.course.lap - 2 * Ls) / 2);
    const R = arc / Math.PI, lap = 2 * Ls + 2 * arc;
    const Q_C1 = POST, Q_BACK = POST + arc, Q_C3 = POST + arc + Ls, Q_HOME = POST + 2 * arc + Ls;
    const mod = (a, m) => ((a % m) + m) % m;
    // 内ラチ上の点 (x, z)、進行方向 (tx, tz)、外向き法線 (nx, nz)
    function frameQ(q) {
      if (q < Q_C1) return { x: q, z: 0, tx: 1, tz: 0, nx: 0, nz: 1 };
      if (q < Q_BACK) {
        const p = (q - Q_C1) / R, sn = Math.sin(p), cs = Math.cos(p);
        return { x: POST + R * sn, z: -R + R * cs, tx: cs, tz: -sn, nx: sn, nz: cs };
      }
      if (q < Q_C3) return { x: POST - (q - Q_BACK), z: -2 * R, tx: -1, tz: 0, nx: 0, nz: -1 };
      if (q < Q_HOME) {
        const p = (q - Q_C3) / R, sn = Math.sin(p), cs = Math.cos(p);
        return { x: -S - R * sn, z: -R - R * cs, tx: -cs, tz: sn, nx: -sn, nz: -cs };
      }
      return { x: -S + (q - Q_HOME), z: 0, tx: 1, tz: 0, nx: 0, nz: 1 };
    }
    const frame = s => frameQ(mod(s - D, lap));
    const wq = (q, y, l) => { const f = frameQ(q); return [f.x + f.nx * l, y, f.z + f.nz * l]; };
    const wp = (s, y, l) => { const f = frame(s); return [f.x + f.nx * l, y, f.z + f.nz * l]; };
    // 輪郭の分割点(直線は端点だけ、カーブは細かく)
    const qSamples = [0, Q_C1];
    for (let i = 1; i <= 28; i++) qSamples.push(Q_C1 + arc * i / 28);
    qSamples.push(Q_C3);
    for (let i = 1; i <= 28; i++) qSamples.push(Q_C3 + arc * i / 28);
    qSamples.push(lap);

    const gateZ = no => 0.35 + (no - 0.5) * 1.15;
    const lane = race.horses.map(h => gateZ(h.no));
    const pref = race.horses.map((h, i) => hash(i + 0.5) * 0.7);
    const fan = race.horses.map((h, i) => ({ 逃げ: 0.3, 先行: 1.2, 差し: 3, 追込: 5 }[h.style]) * (0.4 + hash(i * 3.7 + race.seed % 997)));
    const stridePhase = race.horses.map((h, i) => hash(i * 7.3 + 1));
    const prevPos = race.horses.map(() => 0);
    const speed = race.horses.map(() => 0);
    const particles = [];

    // 背景:コース外周の木立(スタンド裏は除く)と内馬場の植え込み・池
    const pond = { x: (POST - S) / 2, z: -R, rx: Ls * 0.22, rz: R * 0.3 };
    const trees = [];
    for (let q = 0; q < lap; q += 14) {
      const [x, , z] = wq(q, 0, TRACK_W + 95 + hash(q) * 160);
      if (z > 0 && x > -Math.min(420, S + 60) && x < 140) continue;
      trees.push({ x, z, r: 3.5 + hash(q + 7) * 3.5, h: 7 + hash(q + 9) * 7 });
    }
    for (let i = 0; i < 12; i++) {
      const x = -S + 40 + hash(i * 3.3) * (Ls - 80), z = -2 * R + 45 + hash(i * 5.7) * (2 * R - 115);
      if (((x - pond.x) / (pond.rx * 1.3)) ** 2 + ((z - pond.z) / (pond.rz * 1.3)) ** 2 < 1) continue;
      trees.push({ x, z, r: 2.2 + hash(i) * 2, h: 5 + hash(i + 1) * 4 });
    }
    const tvx = -S * 0.45, tvz = -Math.min(60, R * 0.45);

    const cam = { x: 0, y: 7, z: 40, yaw: -Math.PI / 2, pitch: 0.1, f: 1000 };
    let camS = 0, span = 40, camL = TRACK_W / 2, camDist = 60;
    let W = 0, H = 0, lastT = null, shot = null, shotSince = -99, segment = 'gate';
    let fX, fZ, rX, rZ, cp, sp;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      W = canvas.clientWidth || 640;
      H = canvas.clientHeight || 360;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ---------- 投影(ワールド座標 [x, y, z]) ----------
    function setBasis() {
      fX = Math.cos(cam.yaw); fZ = Math.sin(cam.yaw);
      rX = -fZ; rZ = fX;
      cp = Math.cos(cam.pitch); sp = Math.sin(cam.pitch);
    }
    function toCam(X, Y, Z) {
      const dx = X - cam.x, dy = Y - cam.y, dz = Z - cam.z;
      const h = dx * fX + dz * fZ;
      return { x: dx * rX + dz * rZ, u: h * sp + dy * cp, z: h * cp - dy * sp };
    }
    const scr = c => [W / 2 + mirror * cam.f * c.x / c.z, H / 2 - cam.f * c.u / c.z];
    function proj(X, Y, Z) {
      const c = toCam(X, Y, Z);
      if (c.z < 0.5) return null;
      const [x, y] = scr(c);
      return { x, y, z: c.z, s: cam.f / c.z };
    }
    const NEAR = 0.5;
    function clipPoly(pts) {
      const cs = pts.map(p => toCam(p[0], p[1], p[2]));
      const out = [];
      for (let i = 0; i < cs.length; i++) {
        const a = cs[i], b = cs[(i + 1) % cs.length];
        const ain = a.z > NEAR, bin = b.z > NEAR;
        if (ain) out.push(a);
        if (ain !== bin) {
          const t = (NEAR - a.z) / (b.z - a.z);
          out.push({ x: a.x + (b.x - a.x) * t, u: a.u + (b.u - a.u) * t, z: NEAR });
        }
      }
      return out.length >= 3 ? out.map(scr) : null;
    }
    function poly(pts, fill, stroke) {
      const p = clipPoly(pts);
      if (!p) return;
      ctx.beginPath();
      p.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
    }
    function line3(a, b, color, widthM, minPx = 1) {
      let ca = toCam(...a), cb = toCam(...b);
      if (ca.z < NEAR && cb.z < NEAR) return;
      if (ca.z < NEAR || cb.z < NEAR) {
        const t = (NEAR - ca.z) / (cb.z - ca.z);
        const m = { x: ca.x + (cb.x - ca.x) * t, u: ca.u + (cb.u - ca.u) * t, z: NEAR };
        if (ca.z < NEAR) ca = m; else cb = m;
      }
      const [x1, y1] = scr(ca), [x2, y2] = scr(cb);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(minPx, widthM * cam.f / Math.max(ca.z, cb.z));
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }

    // ---------- 位置・コーナー ----------
    function segmentOf(lead) {
      const rem = D - lead;
      if (rem <= 0) return 'goal';
      if (rem <= S) return 'straight';
      const q = mod(lead - D, lap);
      if (q < Q_C1) return 'home';
      if (q < Q_C1 + arc / 2) return 'c1';
      if (q < Q_BACK) return 'c2';
      if (q < Q_C3) return 'back';
      if (q < Q_C3 + arc / 2) return 'c3';
      if (q < Q_HOME) return 'c4';
      return 'home';
    }

    // 横位置:内ラチ沿いを好み、前が詰まれば外へ。直線では差し・追込が外に持ち出す
    const BODY = 3.4;   // 鼻先から尾までの長さ(m)
    const WIDTH = 1.2;  // 横に並ぶときの間隔(m)
    function updateLanes(pos, dt) {
      if (dt <= 0) return;
      const order = race.horses.map((_, j) => j).sort((a, b) => pos[b] - pos[a]);
      const placed = [];
      for (const j of order) {
        if (pos[j] > 12) {
          const remj = D - pos[j];
          const want = 1.0 + pref[j] + (remj < S ? fan[j] * clamp((S - remj) / 220, 0, 1) : 0);
          let target = want;
          // 追いつきそうな前の馬(相対速度ぶん先読み)と、すぐ横の馬を避ける
          for (let it = 0; it < n; it++) {
            const b = placed.find(o => {
              const gap = o.p - pos[j];
              const look = BODY + 0.6 + Math.max(0, speed[j] - o.v) * 2.0;
              return gap < look && gap > -BODY && Math.abs(o.l - target) < WIDTH;
            });
            if (!b) break;
            target = b.l + WIDTH + 0.05;
          }
          target = clamp(target, 0.8, TRACK_W - 1.2);
          lane[j] += clamp(target - lane[j], -0.9 * dt, 2.2 * dt);
        }
        placed.push({ p: pos[j], l: lane[j], v: speed[j] });
      }
      separate(pos);
    }
    // 体が重なっている 2 頭を左右に押し分ける(外の馬は外へ、内の馬は内へ)
    function separate(pos) {
      for (let iter = 0; iter < 4; iter++) {
        let moved = false;
        for (let a = 0; a < n; a++) {
          if (pos[a] <= 12) continue;
          for (let b = a + 1; b < n; b++) {
            if (pos[b] <= 12 || Math.abs(pos[a] - pos[b]) >= BODY) continue;
            const dl = lane[b] - lane[a];
            const overlap = WIDTH - Math.abs(dl);
            if (overlap <= 0) continue;
            const dir = dl !== 0 ? Math.sign(dl) : (pos[a] > pos[b] ? 1 : -1); // 同じなら後ろの馬が外へ
            lane[a] -= dir * overlap / 2;
            lane[b] += dir * overlap / 2;
            moved = true;
          }
        }
        // 内ラチ・外ラチからはみ出したら戻す(戻した分は次の反復で隣が受け止める)
        for (let j = 0; j < n; j++) lane[j] = clamp(lane[j], 0.6, TRACK_W - 0.8);
        if (!moved) break;
      }
    }

    // ---------- カメラワーク ----------
    function lookFrom(p, t) {
      cam.x = p[0]; cam.y = p[1]; cam.z = p[2];
      const dx = t[0] - p[0], dz = t[2] - p[2], d = Math.hypot(dx, dz);
      cam.yaw = Math.atan2(dz, dx);
      cam.pitch = Math.atan2(p[1] - t[1], d);
      camDist = d;
      return d;
    }
    // 先頭馬が画面端から外れないよう首を振る(パン)
    function keepInView(s, l) {
      setBasis();
      const c = toCam(...wp(s, 1.3, l));
      if (c.z <= 1) return;
      const ax = Math.atan2(c.x, c.z), lim = Math.atan(W * 0.42 / cam.f);
      if (ax > lim) cam.yaw += ax - lim;
      else if (ax < -lim) cam.yaw += ax + lim;
    }

    function chooseShot(T, pos, order, dt) {
      const lead = pos[order[0]], rem = D - lead;
      let want;
      if (T < 1.6) want = 'gate';
      else {
        const seg = segmentOf(lead);
        if (seg === 'straight' && rem > 170 && S >= 280) want = 'front';
        else if (seg === 'straight' || seg === 'goal') want = 'goal';
        else if (seg === 'back') want = 'high';
        else if (seg[0] === 'c') want = 'corner';
        else want = 'side';
      }
      let cut = false;
      if (want !== shot && (shot === null || T - shotSince > 2.5 || want === 'front' || want === 'goal' || T < shotSince)) {
        shot = want; shotSince = T; cut = true;
      }
      const k = cut ? 1 : 1 - Math.exp(-dt * 2.6);
      const kf = cut ? 1 : 1 - Math.exp(-dt * 1.4);

      if (shot === 'gate') {
        const g = frame(0), off = TRACK_W + 15;
        const d = lookFrom([g.x + g.tx * 27 + g.nx * off, 4.2, g.z + g.tz * 27 + g.nz * off], wp(-2, 1.4, gateZ((n + 1) / 2)));
        cam.f = W * d / Math.max(20, n * 1.15 + 9);
        return;
      }
      if (shot === 'front') {
        const top = order.slice(0, Math.min(6, n));
        const meanLane = top.reduce((a, j) => a + lane[j], 0) / top.length;
        camL += (clamp(meanLane, 5, TRACK_W - 5) - camL) * k;
        // 最後の直線上ではワールド X = 走行距離 - D。カメラは直線の延長線上(1 コーナーの奥)
        const d = lookFrom([230, 7, camL], [lead - D, 1.3, camL]);
        cam.f += (W * 0.85 * d / 15 - cam.f) * kf;
        return;
      }
      // l: カメラの横位置(外ラチの外)、back/ahead: コーナーで少し後ろから先を見通す
      const cfg = {
        side: { y: 7, l: TRACK_W + 45, min: 24, max: 58, pad: 14, k: Math.ceil(n * 0.6) - 1, back: 0, ahead: 0 },
        corner: { y: 8, l: TRACK_W + 50, min: 30, max: 62, pad: 16, k: Math.ceil(n * 0.6) - 1, back: 26, ahead: 0 },
        high: { y: 18, l: TRACK_W + 58, min: 34, max: 110, pad: 18, k: n - 1, back: 0, ahead: 0 },
        goal: { y: 4.5, l: TRACK_W + 36, min: 17, max: 34, pad: 9, k: 3, back: 0, ahead: 0 },
      }[shot];
      const back = pos[order[Math.min(n - 1, cfg.k)]];
      const spread = Math.max(0, Math.min(lead, D + 40) - back);
      const spanT = clamp(spread * 1.25 + cfg.pad, cfg.min, cfg.max);
      let ts = (lead + back) / 2 + spanT * 0.1;
      // 先頭がゴール前後にいる間はゴール板を画面に入れる
      if (shot === 'goal' && lead > D - 30 && lead < D + 30) ts = clamp(ts, D - spanT * 0.3, D + spanT * 0.3);
      if (cut) { camS = ts; span = spanT; }
      camS += (ts - camS) * k;
      span += (spanT - span) * kf;
      const f0 = frame(camS);
      const d = lookFrom([f0.x + f0.nx * cfg.l - f0.tx * cfg.back, cfg.y, f0.z + f0.nz * cfg.l - f0.tz * cfg.back], wp(camS + cfg.ahead, 1, 6));
      cam.f = W * d / span;
      keepInView(lead - 1, lane[order[0]]);
    }

    // ---------- 背景 ----------
    function drawSky(hy) {
      const sky = {
        晴: ['#6aa8e8', '#cfe6f7'], 曇: ['#8e9aa6', '#d5dbe0'], 小雨: ['#7d8893', '#c3c9ce'], 雨: ['#5f6a74', '#9fa7ad'],
      }[race.weather] || ['#6aa8e8', '#cfe6f7'];
      const g = ctx.createLinearGradient(0, 0, 0, Math.max(1, hy));
      g.addColorStop(0, sky[0]); g.addColorStop(1, sky[1]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, Math.max(0, hy) + 1);
      if (hy <= 0) return;
      // 山並み(視線の向きでずれる)
      const off = cam.yaw * W * 1.3 * mirror;
      [['#9fb4c4', 0.10, 0.006], ['#7d9a8a', 0.055, 0.011]].forEach(([c, amp, fr], li) => {
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.moveTo(0, hy + 1);
        for (let x = 0; x <= W; x += 8) {
          const u = (x - off * (li + 1)) * fr;
          const y = hy - H * amp * (0.55 + 0.25 * Math.sin(u) + 0.2 * Math.sin(u * 2.7 + li));
          ctx.lineTo(x, y);
        }
        ctx.lineTo(W, hy + 1); ctx.closePath(); ctx.fill();
      });
    }

    function drawTree(t) {
      const b = proj(t.x, 0, t.z);
      if (!b || b.z > 1400 || (shot === 'front' && b.z < 500)) return; // 望遠の正面カメラでは近い木を写さない
      const r = t.r * b.s;
      if (b.x < -r * 2 || b.x > W + r * 2) return;
      const top = b.y - t.h * b.s;
      ctx.fillStyle = '#4a3a28';
      ctx.fillRect(b.x - r * 0.12, top + r * 0.6, r * 0.24, b.y - top - r * 0.6);
      // 遠いほど空の色に霞む
      const haze = clamp(b.z / 700, 0.15, 0.6), k = 0.85 + hash(t.x) * 0.3;
      const mix = (c, s) => Math.round(c * k * (1 - haze) + s * haze);
      ctx.fillStyle = `rgb(${mix(47, 170)},${mix(93, 190)},${mix(52, 200)})`;
      ctx.beginPath();
      ctx.arc(b.x, top + r * 0.4, r, 0, TAU);
      ctx.arc(b.x - r * 0.6, top + r * 0.9, r * 0.75, 0, TAU);
      ctx.arc(b.x + r * 0.6, top + r * 0.9, r * 0.75, 0, TAU);
      ctx.fill();
    }

    function drawGrandstand() {
      const Xa = -Math.min(380, S + 40), Xb = 80, Zs = TRACK_W + 52;
      poly([[Xa, 0, Zs], [Xb, 0, Zs], [Xb, 4, Zs], [Xa, 4, Zs]], '#9aa0a6');
      poly([[Xa, 4, Zs], [Xb, 4, Zs], [Xb, 22, Zs + 30], [Xa, 22, Zs + 30]], '#5d6670');
      if (shot === 'front') {
        // 観客(段ごとの点描)
        for (let x = Xa + 2; x < Xb; x += 4) {
          for (let v = 0.05; v < 1; v += 0.09) {
            const p = proj(x + hash(x + v) * 2, 4 + v * 18, Zs + v * 30);
            if (!p || p.x < 0 || p.x > W) continue;
            const c = hash(x * 3.1 + v * 17);
            ctx.fillStyle = c < 0.3 ? '#e9e4da' : c < 0.55 ? '#2c3440' : c < 0.7 ? '#b24a3a' : c < 0.85 ? '#3c6aa8' : '#d8c26a';
            const sz = Math.max(1, p.s * 0.6);
            ctx.fillRect(p.x, p.y, sz, sz * 1.4);
          }
        }
      }
      poly([[Xa, 25, Zs - 3], [Xb, 25, Zs - 3], [Xb, 27, Zs + 34], [Xa, 27, Zs + 34]], '#3d444c');
    }

    function drawTurfVision() {
      const Xa = tvx - 35, Xb = tvx + 35, Z = tvz;
      [Xa + 8, Xb - 8].forEach(x => line3([x, 0, Z], [x, 7, Z], '#555', 1.2));
      poly([[Xa, 6, Z], [Xb, 6, Z], [Xb, 20, Z], [Xa, 20, Z]], '#1e2226');
      poly([[Xa + 1.5, 7.5, Z + 0.1], [Xb - 1.5, 7.5, Z + 0.1], [Xb - 1.5, 18.5, Z + 0.1], [Xa + 1.5, 18.5, Z + 0.1]], turf ? '#3f8f58' : '#9a7652');
    }

    function drawPond() {
      const pts = [];
      for (let i = 0; i < 24; i++) { const a = i / 24 * TAU; pts.push([pond.x + Math.cos(a) * pond.rx, 0.02, pond.z + Math.sin(a) * pond.rz]); }
      poly(pts, '#5b8fb0');
    }

    // 輪状の帯(内ラチから l0〜l1)。継ぎ目が出ないよう同色で縁取る
    function ring(l0, l1, color, seam = true) {
      for (let i = 0; i < qSamples.length - 1; i++) {
        const a = qSamples[i], b = qSamples[i + 1];
        poly([wq(a, 0, l0), wq(b, 0, l0), wq(b, 0, l1), wq(a, 0, l1)], color, seam ? color : null);
      }
    }

    function drawGround() {
      poly(qSamples.slice(0, -1).map(q => wq(q, 0, -0.2)), turf ? '#4f9448' : '#55954c');
      // JRA は芝コースが外、ダートコースが内
      if (turf) ring(-16, -3, '#a07d58');
      else ring(TRACK_W + 3, TRACK_W + 18, '#3f8d41');
      const base = turf ? ['#3f8d41', '#3a8a3d', '#357a37', '#2f6e33'][going] : ['#a87d55', '#94694a', '#7f5a3f', '#6e4d36'][going];
      ring(0, TRACK_W, base);
      // 芝の刈り目・ダートのハロー跡(横縞で動きが出る)
      const band = turf ? 12 : 6;
      const alt = turf ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
      for (let q = 0; q < lap; q += band * 2) {
        const c = toCam(...wq(q + band / 2, 0, TRACK_W / 2));
        if (c.z < -30 || c.z > 1600) continue;
        const qb = Math.min(lap, q + band);
        poly([wq(q, 0, 0.1), wq(qb, 0, 0.1), wq(qb, 0, TRACK_W - 0.1), wq(q, 0, TRACK_W - 0.1)], alt);
      }
      if (turf && going >= 1) ring(0, 4, 'rgba(90,70,40,0.12)', false);
      drawPond();
    }

    // part: all / far(カメラから遠い側) / near(カメラと馬の間)
    function drawRail(l, part) {
      const nearDepth = camDist * 0.7;
      const pick = z => part === 'all' || ((part === 'near') === (z < nearDepth));
      for (let i = 0; i < qSamples.length - 1; i++) {
        const a = wq(qSamples[i], 1.05, l), b = wq(qSamples[i + 1], 1.05, l);
        if (!pick(Math.min(toCam(...a).z, toCam(...b).z))) continue;
        line3(a, b, '#ffffff', 0.12, 1.2);
        line3([a[0], 0.55, a[2]], [b[0], 0.55, b[2]], 'rgba(255,255,255,0.75)', 0.06, 0.8);
      }
      for (let q = 0; q < lap; q += 4) {
        const p = wq(q, 0.5, l);
        const c = toCam(...p);
        if (c.z < 25 || c.z > 450 || !pick(c.z)) continue; // カメラ直下の支柱は写さない
        line3([p[0], 0, p[2]], [p[0], 1.05, p[2]], '#f2f2f2', 0.08, 0.8);
      }
    }

    // ---------- 物体(奥から順に描く) ----------
    function drawPole(o) {
      const b = proj(...wp(o.s, 0, o.l)), t = proj(...wp(o.s, 2.7, o.l));
      if (!b || !t) return;
      const w = Math.max(1.2, 0.14 * b.s);
      for (let i = 0; i < 5; i++) {
        ctx.strokeStyle = i % 2 ? '#ffffff' : '#d32f2f';
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(b.x + (t.x - b.x) * i / 5, b.y + (t.y - b.y) * i / 5);
        ctx.lineTo(b.x + (t.x - b.x) * (i + 1) / 5, b.y + (t.y - b.y) * (i + 1) / 5);
        ctx.stroke();
      }
      const sz = Math.max(8, 0.95 * t.s);
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#d32f2f'; ctx.lineWidth = Math.max(1, sz * 0.08);
      ctx.fillRect(t.x - sz / 2, t.y - sz, sz, sz); ctx.strokeRect(t.x - sz / 2, t.y - sz, sz, sz);
      ctx.fillStyle = '#c62828'; ctx.font = `bold ${Math.round(sz * 0.7)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(o.label, t.x, t.y - sz / 2 + 1);
    }

    function drawGoalPost() {
      const b = proj(...wp(D, 0, -1.2)), t = proj(...wp(D, 5.2, -1.2));
      if (!b || !t) return;
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(2, 0.22 * b.s);
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(t.x, t.y); ctx.stroke();
      const r = Math.max(5, 0.75 * t.s);
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, TAU); ctx.fill();
      ctx.fillStyle = '#d32f2f'; ctx.beginPath(); ctx.arc(t.x, t.y, r * 0.62, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(t.x, t.y, r * 0.28, 0, TAU); ctx.fill();
      // 決勝線
      line3(wp(D, 0.02, 0), wp(D, 0.02, TRACK_W), 'rgba(255,255,255,0.55)', 0.12);
    }

    function gateObjects(T, list) {
      if (T > 9) return; // 発走後はゲート車が退く
      const z0 = 0.35, z1 = 0.35 + n * 1.15;
      for (let i = 0; i <= n; i++) {
        const z = z0 + i * 1.15;
        list.push({ z: toCam(...wp(-2, 1.7, z)).z + 0.01, draw() {
          poly([wp(-3.9, 0.15, z), wp(0, 0.15, z), wp(0, 3.3, z), wp(-3.9, 3.3, z)], 'rgba(46,125,91,0.92)', 'rgba(0,0,0,0.35)');
        } });
      }
      for (let i = 0; i < n; i++) {
        const za = z0 + i * 1.15, zb = za + 1.15;
        list.push({ z: toCam(...wp(0, 1.4, (za + zb) / 2)).z - 0.5, draw() {
          if (T < 0) poly([wp(0, 0.45, za + 0.05), wp(0, 0.45, zb - 0.05), wp(0, 2.5, zb - 0.05), wp(0, 2.5, za + 0.05)], '#e9f1ec', 'rgba(0,0,0,0.3)');
          else {
            poly([wp(0, 0.45, za + 0.05), wp(0.55, 0.45, za + 0.22), wp(0.55, 2.5, za + 0.22), wp(0, 2.5, za + 0.05)], '#dfe8e2');
            poly([wp(0, 0.45, zb - 0.05), wp(0.55, 0.45, zb - 0.22), wp(0.55, 2.5, zb - 0.22), wp(0, 2.5, zb - 0.05)], '#dfe8e2');
          }
        } });
      }
      list.push({ z: toCam(...wp(-2, 3.4, (z0 + z1) / 2)).z - 3, draw() {
        poly([wp(-3.9, 3.3, z0), wp(0, 3.3, z0), wp(0, 3.3, z1), wp(-3.9, 3.3, z1)], '#2e7d5b', 'rgba(0,0,0,0.3)');
        poly([wp(0, 2.9, z0), wp(0, 2.9, z1), wp(0, 3.3, z1), wp(0, 3.3, z0)], '#f2f2f2');
      } });
    }

    // ---------- 馬と騎手 ----------
    function silkFill(silks, x0, y0, x1, y1) {
      ctx.fillStyle = silks.body;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.fillStyle = silks.accent;
      const w = x1 - x0, h = y1 - y0;
      switch (silks.pattern) {
        case 'hoops': ctx.fillRect(x0, y0 + h * 0.38, w, h * 0.24); break;
        case 'stripes': for (let x = x0 + w * 0.1; x < x1; x += w * 0.3) ctx.fillRect(x, y0, w * 0.12, h); break;
        case 'halves': ctx.fillRect(x0 + w / 2, y0, w / 2, h); break;
        case 'sash':
          ctx.beginPath(); ctx.moveTo(x0, y0 + h * 0.75); ctx.lineTo(x0, y0 + h); ctx.lineTo(x1, y0 + h * 0.25); ctx.lineTo(x1, y0); ctx.closePath(); ctx.fill(); break;
        case 'dots':
          for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { ctx.beginPath(); ctx.arc(x0 + w * (0.2 + i * 0.3), y0 + h * (0.3 + j * 0.4), Math.min(w, h) * 0.09, 0, TAU); ctx.fill(); }
          break;
        case 'chevron':
          ctx.beginPath(); ctx.moveTo(x0, y0 + h * 0.3); ctx.lineTo(x0 + w / 2, y0 + h * 0.65); ctx.lineTo(x1, y0 + h * 0.3);
          ctx.lineTo(x1, y0 + h * 0.5); ctx.lineTo(x0 + w / 2, y0 + h * 0.85); ctx.lineTo(x0, y0 + h * 0.5); ctx.closePath(); ctx.fill(); break;
      }
    }

    // 横向き。原点=馬体中央の地面、+x が進行方向、y 上向き(単位 m)
    function horseSide(h, phase, moving, finalPush) {
      const [coat, mane, sock] = COAT[h.coat] || COAT['鹿毛'];
      const bob = moving ? 0.075 * Math.sin(TAU * phase) : 0;
      const ext = moving ? 0.1 * Math.sin(TAU * phase + 1.2) : -0.15;
      const legs = [[-0.72, 1.06, 0.0, false, false], [0.62, 1.02, 0.42, true, false], [-0.72, 1.06, 0.12, false, true], [0.62, 1.02, 0.54, true, true]];
      const drawLeg = ([x0, y0, off, front, near]) => {
        let a = 0, k = 0;
        if (moving) {
          const q = TAU * (phase + off);
          a = (front ? 0.6 : 0.5) * Math.sin(q);
          k = Math.max(0, Math.sin(q + (front ? 1.4 : -1.2))) * (front ? 1.6 : 1.1);
        }
        const l1 = front ? 0.55 : 0.6, l2 = front ? 0.62 : 0.64;
        const x1 = x0 + Math.sin(a) * l1, y1 = y0 + bob - Math.cos(a) * l1;
        const a2 = front ? a - k : a + k * 0.8;
        const x2 = x1 + Math.sin(a2) * l2, y2 = y1 - Math.cos(a2) * l2;
        const dim = near ? 1 : 0.7;
        ctx.lineCap = 'round';
        ctx.strokeStyle = shade(coat, dim); ctx.lineWidth = front ? 0.17 : 0.2;
        ctx.beginPath(); ctx.moveTo(x0, y0 + bob); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.strokeStyle = shade(sock, dim); ctx.lineWidth = 0.1;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      };
      legs.filter(l => !l[4]).forEach(drawLeg);
      // 尾
      ctx.strokeStyle = mane; ctx.lineWidth = 0.17; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-1.05, 1.5 + bob);
      ctx.quadraticCurveTo(-1.5, 1.45 + bob, -1.8, 1.15 + bob + (moving ? 0.12 * Math.sin(TAU * phase) : -0.25)); ctx.stroke();
      // 胴・首・頭
      ctx.fillStyle = coat;
      ctx.beginPath(); ctx.ellipse(0, 1.3 + bob, 1.0, 0.36, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(-0.68, 1.34 + bob, 0.46, 0.4, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0.62, 1.27 + bob, 0.42, 0.42, 0, 0, TAU); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0.55, 1.62 + bob); ctx.lineTo(1.32 + ext, 2.0 + bob); ctx.lineTo(1.55 + ext, 1.82 + bob); ctx.lineTo(0.95, 1.1 + bob);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(1.28 + ext, 2.06 + bob); ctx.lineTo(1.97 + ext, 1.64 + bob); ctx.lineTo(1.9 + ext, 1.5 + bob); ctx.lineTo(1.45 + ext, 1.74 + bob);
      ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(1.3 + ext, 2.04 + bob); ctx.lineTo(1.24 + ext, 2.22 + bob); ctx.lineTo(1.4 + ext, 2.06 + bob); ctx.fill();
      ctx.strokeStyle = mane; ctx.lineWidth = 0.09;
      ctx.beginPath(); ctx.moveTo(0.55, 1.66 + bob); ctx.lineTo(1.28 + ext, 2.04 + bob); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.beginPath(); ctx.ellipse(-0.1, 1.5 + bob, 0.8, 0.12, 0, 0, TAU); ctx.fill();
      legs.filter(l => l[4]).forEach(drawLeg);
      // ゼッケン・鞍
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-0.4, 1.18 + bob, 0.68, 0.42);
      ctx.fillStyle = '#222';
      ctx.fillRect(-0.3, 1.58 + bob, 0.5, 0.07);
      // 騎手(前傾。追い出しでは沈み込む)
      const jb = bob * 0.4 + (finalPush ? 0.05 * Math.sin(TAU * phase * 2) : 0);
      ctx.strokeStyle = '#f4f4f4'; ctx.lineWidth = 0.13; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-0.05, 1.96 + jb); ctx.lineTo(0.32, 1.8 + jb); ctx.lineTo(0.14, 1.5 + bob); ctx.stroke();
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(-0.12, 1.92 + jb); ctx.lineTo(0.1, 2.2 + jb); ctx.lineTo(0.56, 2.22 + jb); ctx.lineTo(0.52, 2.0 + jb);
      ctx.closePath(); ctx.clip();
      silkFill(h.silks, -0.15, 1.9 + jb, 0.6, 2.25 + jb);
      ctx.restore();
      ctx.strokeStyle = h.silks.sleeve; ctx.lineWidth = 0.1;
      const reach = finalPush ? 0.12 * Math.sin(TAU * phase) : 0;
      ctx.beginPath(); ctx.moveTo(0.5, 2.16 + jb); ctx.lineTo(0.78 + reach, 1.98 + jb); ctx.lineTo(1.0 + reach + ext * 0.5, 1.86 + bob); ctx.stroke();
      ctx.fillStyle = CAP[h.bracket];
      ctx.beginPath(); ctx.arc(0.68, 2.34 + jb, 0.135, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 0.025; ctx.stroke();
    }

    // 正面(こちらへ向かってくる)
    function horseFront(h, phase, moving) {
      const [coat, mane, sock] = COAT[h.coat] || COAT['鹿毛'];
      const bob = moving ? 0.075 * Math.sin(TAU * phase) : 0;
      const leg = (x, off, front) => {
        const lift = moving ? Math.max(0, Math.sin(TAU * (phase + off))) : 0;
        const dim = front ? 1 : 0.65;
        ctx.lineCap = 'round';
        ctx.strokeStyle = shade(coat, dim); ctx.lineWidth = 0.16;
        ctx.beginPath(); ctx.moveTo(x, 1.0 + bob); ctx.lineTo(x * 1.05, 0.55 + lift * 0.35); ctx.stroke();
        ctx.strokeStyle = shade(sock, dim); ctx.lineWidth = 0.1;
        ctx.beginPath(); ctx.moveTo(x * 1.05, 0.55 + lift * 0.35); ctx.lineTo(x, lift * 0.5); ctx.stroke();
      };
      leg(-0.24, 0.0, false); leg(0.24, 0.12, false);
      ctx.fillStyle = shade(coat, 0.8);
      ctx.beginPath(); ctx.ellipse(0, 1.32 + bob, 0.42, 0.36, 0, 0, TAU); ctx.fill();
      leg(-0.16, 0.42, true); leg(0.16, 0.54, true);
      ctx.fillStyle = coat;
      ctx.beginPath(); ctx.ellipse(0, 1.22 + bob, 0.34, 0.4, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, 1.62 + bob, 0.2, 0.3, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, 1.86 + bob, 0.14, 0.3, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = mane;
      ctx.beginPath(); ctx.moveTo(-0.1, 2.1 + bob); ctx.lineTo(-0.14, 2.28 + bob); ctx.lineTo(-0.02, 2.14 + bob); ctx.fill();
      ctx.beginPath(); ctx.moveTo(0.1, 2.1 + bob); ctx.lineTo(0.14, 2.28 + bob); ctx.lineTo(0.02, 2.14 + bob); ctx.fill();
      if (hash(h.no * 5.1) > 0.6) { ctx.fillStyle = '#f2efe8'; ctx.fillRect(-0.03, 1.66 + bob, 0.06, 0.4); }
      // 騎手
      const jb = bob * 0.4;
      ctx.save();
      ctx.beginPath(); ctx.ellipse(0, 2.28 + jb, 0.24, 0.22, 0, 0, TAU); ctx.clip();
      silkFill(h.silks, -0.25, 2.06 + jb, 0.25, 2.5 + jb);
      ctx.restore();
      ctx.strokeStyle = h.silks.sleeve; ctx.lineWidth = 0.09; ctx.lineCap = 'round';
      [-1, 1].forEach(sd => { ctx.beginPath(); ctx.moveTo(sd * 0.2, 2.3 + jb); ctx.lineTo(sd * 0.12, 2.0 + bob); ctx.stroke(); });
      ctx.fillStyle = CAP[h.bracket];
      ctx.beginPath(); ctx.arc(0, 2.58 + jb, 0.14, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 0.025; ctx.stroke();
      ctx.fillStyle = '#1b1b1b'; ctx.fillRect(-0.1, 2.55 + jb, 0.2, 0.05);
    }


    function horseObject(j, pos) {
      const h = race.horses[j];
      const s0 = pos[j] - 1.95, l = lane[j];
      const center = wp(s0, 1.3, l);
      return {
        z: toCam(...center).z, j, draw() {
          const g = proj(...wp(s0, 0, l));
          if (!g || g.x < -g.s * 4 || g.x > W + g.s * 4) return;
          const a = proj(...center), b = proj(...wp(s0 + 1, 1.3, l));
          if (!a || !b) return;
          const side = Math.abs(b.x - a.x) / a.s;
          const moving = speed[j] > 0.5;
          const phase = moving ? (pos[j] / 6.6 + stridePhase[j]) % 1 : 0;
          const finalPush = D - pos[j] < 400 && pos[j] < D;
          ctx.save();
          ctx.translate(g.x, g.y);
          if (side > 0.42) {
            const face = (b.x - a.x) > 0 ? 1 : -1;
            ctx.scale(g.s * face * Math.min(1, side), -g.s);
            horseSide(h, phase, moving, finalPush);
          } else {
            ctx.scale(g.s, -g.s);
            horseFront(h, phase, moving);
          }
          ctx.restore();
        },
      };
    }

    function drawShadow(j, pos) {
      const g = proj(...wp(pos[j] - 1.95, 0, lane[j]));
      if (!g) return;
      const rx = 1.5 * g.s, ry = rx * clamp(Math.abs(Math.sin(cam.pitch)) * 1.6 + 0.06, 0.08, 0.5);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath(); ctx.ellipse(g.x, g.y, rx, ry, 0, 0, TAU); ctx.fill();
    }

    function updateParticles(pos, dt) {
      if (dt <= 0) return;
      for (let j = 0; j < n; j++) {
        if (speed[j] < 8 || particles.length > 420 || Math.random() > dt * 14) continue;
        const f = frame(pos[j] - 2.6);
        const [x, , z] = wp(pos[j] - 2.6 + Math.random() * 0.6, 0, lane[j] + (Math.random() - 0.5) * 0.5);
        const along = -2 + Math.random() * 3, across = (Math.random() - 0.5) * 1.5;
        particles.push({ x, y: 0.1, z, vx: f.tx * along + f.nx * across, vy: 1.5 + Math.random() * 2.5, vz: f.tz * along + f.nz * across, life: 0, max: 0.5 + Math.random() * 0.5 });
      }
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += dt;
        if (p.life > p.max) { particles.splice(i, 1); continue; }
        p.x += p.vx * dt; p.y = Math.max(0, p.y + p.vy * dt); p.z += p.vz * dt; p.vy -= 9.8 * dt;
      }
    }
    function drawParticles() {
      for (const p of particles) {
        const q = proj(p.x, p.y, p.z);
        if (!q) continue;
        const a = 1 - p.life / p.max;
        ctx.fillStyle = turf ? `rgba(70,110,50,${a * 0.8})` : `rgba(140,105,70,${a * 0.55})`;
        const sz = Math.max(1, (turf ? 0.12 : 0.22) * q.s);
        ctx.fillRect(q.x, q.y, sz, sz);
      }
    }

    function drawRain(now) {
      const drops = race.weather === '雨' ? 260 : race.weather === '小雨' ? 110 : 0;
      if (!drops) return;
      ctx.strokeStyle = 'rgba(220,230,240,0.45)'; ctx.lineWidth = 1;
      ctx.beginPath();
      const t = now / 1000;
      for (let i = 0; i < drops; i++) {
        const x = (hash(i) * W + t * 60) % W;
        const y = (hash(i + 0.5) * H + t * (700 + hash(i + 0.7) * 300)) % H;
        ctx.moveTo(x, y); ctx.lineTo(x - 3, y + 14);
      }
      ctx.stroke();
    }

    function drawTags(pos, order) {
      const fs = 11;
      ctx.font = `bold ${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const j of order.slice().reverse()) {
        const h = race.horses[j];
        const p = proj(...wp(pos[j] - 1.6, 3.1, lane[j]));
        if (!p || p.s < 5 || p.x < 0 || p.x > W || p.y < 0) continue;
        const w = fs + 7, hh = fs + 4;
        ctx.fillStyle = CAP[h.bracket];
        ctx.strokeStyle = mine.has(h.no) ? '#ff2d55' : 'rgba(0,0,0,0.5)';
        ctx.lineWidth = mine.has(h.no) ? 2.5 : 1;
        ctx.fillRect(p.x - w / 2, p.y - hh, w, hh); ctx.strokeRect(p.x - w / 2, p.y - hh, w, hh);
        ctx.fillStyle = CAP_FG[h.bracket];
        ctx.fillText(h.no, p.x, p.y - hh / 2 + 0.5);
      }
    }

    // ---------- 1 フレーム ----------
    function render(T, pos, now = performance.now()) {
      if (!W) resize();
      const dt = lastT === null || T < lastT ? 0 : Math.min(0.5, T - lastT);
      lastT = T;
      if (dt > 0) for (let j = 0; j < n; j++) { speed[j] = (pos[j] - prevPos[j]) / dt; prevPos[j] = pos[j]; }
      const order = race.horses.map((_, j) => j).sort((a, b) => pos[b] - pos[a]);
      segment = T < 0.5 ? 'gate' : segmentOf(pos[order[0]]);
      updateLanes(pos, dt);
      chooseShot(T, pos, order, dt);
      updateParticles(pos, dt);
      setBasis();

      const hy = H / 2 - cam.f * Math.tan(cam.pitch);
      drawSky(hy);
      ctx.fillStyle = '#5f9e52';
      ctx.fillRect(0, Math.max(0, hy), W, H);
      drawGround();
      trees.map(t => ({ t, z: toCam(t.x, 0, t.z).z })).filter(o => o.z > 1).sort((a, b) => b.z - a.z).forEach(o => drawTree(o.t));
      drawTurfVision();
      drawGrandstand();
      drawRail(-0.2, 'all');
      const outsideCam = shot !== 'front';
      drawRail(TRACK_W + 0.2, outsideCam ? 'far' : 'all');

      const objs = [];
      for (let k = 1; 200 * k < Math.min(D + 60, lap - 60); k++) { // ハロン棒は 1 周ぶんまで
        const s = D - 200 * k;
        const c = toCam(...wp(s, 1, -0.9));
        if (c.z > 0.5 && c.z < 1500) objs.push({ z: c.z, draw: () => drawPole({ s, l: -0.9, label: String(2 * k) }) });
      }
      const gc = toCam(...wp(D, 2, -1.2));
      if (gc.z > 0.5) objs.push({ z: gc.z, draw: drawGoalPost });
      gateObjects(T, objs);
      for (let j = 0; j < n; j++) objs.push(horseObject(j, pos));
      for (let j = 0; j < n; j++) drawShadow(j, pos);
      objs.filter(o => o.z > 0.5).sort((a, b) => b.z - a.z).forEach(o => o.draw());
      drawParticles();
      if (outsideCam) drawRail(TRACK_W + 0.2, 'near');
      drawRain(now);
      drawTags(pos, order);
    }

    // 走行距離 s・高さ y・横位置 l の画面上の位置(テスト用)
    function screenOf(s, y, l) { setBasis(); return proj(...wp(s, y, l)); }

    return {
      render, resize, screenOf,
      get shot() { return shot; },
      get segment() { return segment; },
      get segmentLabel() { return SEG_LABEL[segment] || ''; },
      get camera() { return { ...cam }; },
      get size() { return { W, H }; },
      lanes: lane,
      geometry: { S, Ls, arc, R, lap, POST },
    };
  }

  root.KeibaTV = { createTV, CAP, TRACK_W, POST };
})(typeof self !== 'undefined' ? self : this);
