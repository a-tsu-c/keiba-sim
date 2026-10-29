/* 競馬シミュレーション エンジン(DOM 非依存。ブラウザでは window.KeibaEngine) */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KeibaEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 乱数・ユーティリティ ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const rngFor = (...parts) => mulberry32(hashStr(parts.join('|')));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
  function weighted(rng, entries) {
    const total = entries.reduce((s, e) => s + e[1], 0);
    let r = rng() * total;
    for (const [v, w] of entries) if ((r -= w) < 0) return v;
    return entries[entries.length - 1][0];
  }
  function shuffle(rng, arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ---------- マスタ ----------
  const COURSES = [
    { venue: '東京', dir: '左', lap: 2083, straight: 525, turf: [1400, 1600, 1800, 2000, 2400], dirt: [1300, 1400, 1600, 2100] },
    { venue: '中山', dir: '右', lap: 1840, straight: 310, turf: [1200, 1600, 1800, 2000, 2500], dirt: [1200, 1800] },
    { venue: '京都', dir: '右', lap: 1894, straight: 404, turf: [1200, 1400, 1600, 1800, 2000, 2200, 2400, 3000], dirt: [1200, 1400, 1800, 1900] },
    { venue: '阪神', dir: '右', lap: 2089, straight: 474, turf: [1200, 1400, 1600, 1800, 2000, 2200, 2400], dirt: [1200, 1400, 1800, 2000] },
    { venue: '中京', dir: '左', lap: 1705, straight: 412, turf: [1200, 1400, 1600, 2000, 2200], dirt: [1200, 1400, 1800, 1900] },
    { venue: '新潟', dir: '左', lap: 2223, straight: 659, turf: [1400, 1600, 1800, 2000, 2200], dirt: [1200, 1800] },
  ];

  const CLASSES = {
    maiden: { key: 'maiden', name: '未勝利', level: 46, spread: 7.5 },
    c1: { key: 'c1', name: '1勝クラス', level: 52, spread: 6.5 },
    c2: { key: 'c2', name: '2勝クラス', level: 57, spread: 6 },
    c3: { key: 'c3', name: '3勝クラス', level: 61, spread: 5.5 },
    op: { key: 'op', name: 'オープン', level: 65, spread: 5 },
    g3: { key: 'g3', name: 'G3', level: 68, spread: 5, grade: true },
    g2: { key: 'g2', name: 'G2', level: 71, spread: 4.5, grade: true },
    g1: { key: 'g1', name: 'G1', level: 75, spread: 4, grade: true },
  };

  // JRA の控除率
  const BET_TYPES = [
    { key: 'win', label: '単勝', k: 1, ordered: false, takeout: 0.20 },
    { key: 'place', label: '複勝', k: 1, ordered: false, takeout: 0.20 },
    { key: 'bracket', label: '枠連', k: 2, ordered: false, takeout: 0.225, unit: 'bracket' },
    { key: 'quinella', label: '馬連', k: 2, ordered: false, takeout: 0.225 },
    { key: 'wide', label: 'ワイド', k: 2, ordered: false, takeout: 0.225 },
    { key: 'exacta', label: '馬単', k: 2, ordered: true, takeout: 0.25 },
    { key: 'trio', label: '3連複', k: 3, ordered: false, takeout: 0.25 },
    { key: 'trifecta', label: '3連単', k: 3, ordered: true, takeout: 0.275 },
  ];
  const BET = Object.fromEntries(BET_TYPES.map(b => [b.key, b]));

  const STYLES = ['逃げ', '先行', '差し', '追込'];
  const EARLY = { 逃げ: 1.011, 先行: 1.005, 差し: 0.996, 追込: 0.990 };
  const KICK_STYLE = { 逃げ: 0.6, 先行: 0.85, 差し: 1.1, 追込: 1.3 };
  const GOING = ['良', '稍重', '重', '不良'];

  // 馬名:歴史上の人物・故事・実在の言葉をもじったもの(JRA の馬名は 9 文字以内)
  const NAME_WITTY = [
    'リョウマノセンタク', 'ヒミコノウラナイ', 'ショウトクキキミミ', 'イエヤスマツゾ', 'ヒデヨシナカセル', 'ノブナガホトトギス',
    'ムサシニトウリュウ', 'コジロウツバメ', 'ヨシツネハッソウ', 'ベンケイタチオウ', 'マサムネドクガン', 'ユキムラアカゾナエ',
    'ケンシンシオオクル', 'シンゲンフウリン', 'ハルハアケボノ', 'ゲンジノヒカル', 'バショウフルイケ', 'イッキュウトンチ',
    'ゲンナイエレキテル', 'タダタカアルキ', 'セゴドンダッシュ', 'カイシュウムケツ', 'トシゾウマコト', 'ソウジサンダン',
    'ナポレオンジショ', 'カエサルサイコロ', 'クレオパトラノハナ', 'ニュートンリンゴ', 'ガリレイソレデモ', 'コロンブスタマゴ',
    'ジャンヌノハタ', 'ダヴィンチスケッチ', 'モーツァルトキブン', 'ベートーベンダイク', 'エジソンヒラメキ', 'リンカーンノコエ',
    'マゼランイッシュウ', 'ザビエルノカネ', 'ペリーノクロフネ', 'ハンニバルゾウ', 'ソクラテスムチ', 'アルキメデスユレカ',
    'サンコンノチャ', 'ショウインジュク', 'ラクイチラクザ', 'テンカフブ', 'セキガハラノキリ', 'オケハザマキシュウ',
    'ホンノウジノヒ', 'ダンノウラナミ', 'カマクラドノ', 'ムロマチノハナ', 'エドノフウリュウ', 'メイジノカネ',
    'タイカノカイシン', 'ケンズイシノフネ', 'ハニワノエガオ', 'ドグウスマイル', 'ヤマタイコク', 'キンインノハンコ',
  ];
  const NAME_A = ['ノブナガ', 'ヒデヨシ', 'イエヤス', 'リョウマ', 'ムサシ', 'ヨシツネ', 'マサムネ', 'ユキムラ', 'ケンシン', 'シンゲン',
    'ヒミコ', 'ショウトク', 'カイシュウ', 'トシゾウ', 'セゴドン', 'カエサル', 'ジャンヌ', 'ガリレイ', 'ザビエル', 'マゼラン',
    'ハンニバル', 'エジソン', 'バショウ', 'イッキュウ', 'ゲンナイ', 'ムラサキ', 'ナゴン', 'サムライ', 'ショウグン', 'ダイミョウ',
    'テンカ', 'シノビ', 'ハタモト', 'カブト', 'ミカド', 'ゲンジ', 'ヘイケ', 'ヤマト', 'ハヤテ', 'ミヤビ'];
  const NAME_B = ['ノユメ', 'ノカゼ', 'ノヒカリ', 'ノキセキ', 'ノホマレ', 'ノハナ', 'ノチカイ', 'ドリーム', 'ハート', 'ソウル',
    'ロード', 'ダンス', 'スター', 'ボルト', 'ブレイブ', 'ジャンプ', 'ラッシュ', 'クラウン', 'レガシー', 'ビート', 'マーチ',
    'ブルー', 'ゴールド', 'フブキ', 'イナズマ', 'カグラ', 'ミライ', 'エース', 'ウイング', 'ロマン'];
  // 騎手:歴史上の人物の名を一字変えたもの
  const JOCKEYS = [
    ['織田 信永', 88], ['坂元 龍真', 84], ['宮元 武蔵', 81], ['真田 雪村', 78], ['伊達 正宗', 76], ['上杉 謙心', 73],
    ['武田 心玄', 71], ['豊臣 秀好', 69], ['徳河 康家', 67], ['源 義恒', 65], ['土方 歳蔵', 63], ['沖田 総士', 61],
    ['明智 光英', 59], ['石田 三也', 57], ['西郷 隆守', 55], ['紫 式乃', 53], ['勝 海船', 51], ['平 清守', 49],
    ['北条 時旨', 47], ['清少 那言', 45], ['巴 御膳', 43], ['野口 英代', 41],
  ];
  const SILK_COLORS = ['#c8102e', '#0033a0', '#ffd100', '#00843d', '#ffffff', '#111111', '#7a2c8f', '#f28c28', '#e8618c', '#5bc2e7', '#8b4513', '#9ea2a2'];
  const SILK_PATTERNS = ['plain', 'hoops', 'stripes', 'sash', 'halves', 'dots', 'chevron'];
  const RACE_WORDS = ['オータム', '銀杏', '月光', '流星', '白鷺', '若葉', '紅梅', '朱雀', '青嵐', '飛燕', '霜月', '天狼', '鳳凰', '翠玉'];

  // ---------- 枠番(JRA 方式:頭数が 8 を超える分は 8 枠から順に 2 頭・3 頭に) ----------
  function bracketCounts(n) {
    const counts = Array(8).fill(0);
    if (n <= 8) { for (let i = 0; i < n; i++) counts[i] = 1; return counts; }
    counts.fill(1);
    let rem = n - 8, idx = 7;
    while (rem > 0) { counts[idx]++; rem--; idx = idx === 0 ? 7 : idx - 1; }
    return counts;
  }
  function bracketOf(no, n) {
    const counts = bracketCounts(n);
    let acc = 0;
    for (let b = 0; b < 8; b++) { acc += counts[b]; if (no <= acc) return b + 1; }
    throw new Error('馬番が範囲外です');
  }

  // ---------- 基準速度(m/s) ----------
  function baseSpeed(distance, surface, going) {
    const g = GOING.indexOf(going);
    if (surface === '芝') {
      const v = 17.62 - (distance - 1200) * 0.00068;
      return v * [1, 0.994, 0.985, 0.972][g];
    }
    const v = 17.0 - (distance - 1200) * 0.00105;
    return v * [1, 1.004, 1.008, 1.012][g];
  }

  // ---------- レース生成 ----------
  function classForRace(rng, raceNo) {
    if (raceNo <= 4) return CLASSES.maiden;
    if (raceNo <= 7) return CLASSES.c1;
    if (raceNo <= 9) return CLASSES.c2;
    if (raceNo === 10) return CLASSES.c3;
    if (raceNo === 11) return CLASSES[weighted(rng, [['op', 4], ['g3', 3], ['g2', 2], ['g1', 1]])];
    return rng() < 0.5 ? CLASSES.c1 : CLASSES.c2;
  }

  function horseName(rng, used) {
    for (let tries = 0; ; tries++) {
      const name = tries < 30 && rng() < 0.35 ? pick(rng, NAME_WITTY) : pick(rng, NAME_A) + pick(rng, NAME_B);
      if (name.length <= 9 && !used.has(name)) { used.add(name); return name; }
    }
  }

  function makeHorse(rng, cls, surface, distance, used) {
    const ability = clamp(cls.level + gauss(rng) * cls.spread, 25, 98);
    const sexR = rng();
    const sex = sexR < 0.55 ? '牡' : sexR < 0.9 ? '牝' : 'セ';
    const age = cls.key === 'maiden' ? 3 : 3 + Math.floor(rng() * rng() * 5); // 未勝利戦は 3 歳限定
    const ownSurface = rng() < 0.82 ? surface : (surface === '芝' ? 'ダート' : '芝');
    const body = Math.round(clamp(470 + gauss(rng) * 24, 400, 560) / 2) * 2;
    const diffR = rng();
    const bodyDiff = diffR < 0.08 ? Math.round(gauss(rng) * 8) * 2 : Math.round(gauss(rng) * 2.2) * 2;
    const form = clamp(gauss(rng), -2.5, 2.5);
    return {
      name: horseName(rng, used), sex, age, ability,
      sp: clamp(ability + gauss(rng) * 4, 15, 100),
      st: clamp(ability + gauss(rng) * 8, 15, 100),
      bu: clamp(ability + gauss(rng) * 8, 15, 100),
      gt: clamp(50 + gauss(rng) * 15, 5, 95),
      style: weighted(rng, [['逃げ', 1.2], ['先行', 3.2], ['差し', 3.4], ['追込', 2.2]]),
      surface: ownSurface, offSurface: 3 + rng() * 5,
      distBest: Math.round(clamp(distance + gauss(rng) * 350, 1000, 3400) / 100) * 100,
      distRange: Math.round((200 + rng() * 400) / 100) * 100,
      wetApt: clamp(gauss(rng), -2, 2),
      form,
      training: form + gauss(rng) * 0.8,
      bodyWeight: body, bodyDiff,
    };
  }

  function kinryoFor(h, cls, handicap, rng) {
    if (handicap) {
      const z = (h.ability - cls.level) / cls.spread;
      return clamp(Math.round((55 + z * 2 + gauss(rng) * 0.4) * 2) / 2, 50, 59);
    }
    let base = cls.grade ? 57 : (h.age === 3 ? 56 : 57);
    if (h.sex === '牝') base -= 2;
    return base;
  }

  // ---------- 戦績(馬柱) ----------
  const PROGRESSION = ['maiden', 'c1', 'c2', 'c3', 'op'];
  const DAY_MS = 86400000;
  const RACE_DATE0 = Date.UTC(2026, 9, 31); // 開催 1 日目(土曜)

  // 土日で 1 週。day=1 → 土、day=2 → 日、day=3 → 翌週土 …
  function raceDate(day) { return RACE_DATE0 + (Math.floor((day - 1) / 2) * 7 + ((day - 1) % 2)) * DAY_MS; }
  function fmtDate(t, long) {
    const d = new Date(t);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, dd = d.getUTCDate();
    return long ? `${y}年${m}月${dd}日(${'日月火水木金土'[d.getUTCDay()]})` : `${String(y).slice(2)}.${m}.${dd}`;
  }

  // 現クラスにいるための通算勝利数(1 勝ごとに 1 クラス上がる)
  function targetWins(rng, cls) {
    switch (cls.key) {
      case 'maiden': return 0;
      case 'c1': return 1;
      case 'c2': return 2;
      case 'c3': return 3;
      case 'op': return 4 + Math.floor(rng() * 2);
      case 'g3': return 4 + Math.floor(rng() * 3);
      default: return 5 + Math.floor(rng() * 3);
    }
  }
  function openClassFor(rng, cur) {
    const tbl = {
      op: [['op', 7], ['g3', 2]], g3: [['op', 4], ['g3', 4], ['g2', 1]],
      g2: [['op', 2], ['g3', 4], ['g2', 3], ['g1', 1]], g1: [['g3', 2], ['g2', 4], ['g1', 4]],
    };
    return CLASSES[weighted(rng, tbl[cur.key] || tbl.op)];
  }
  const nearest = (list, d) => list.reduce((a, b) => (Math.abs(b - d) < Math.abs(a - d) ? b : a));

  // 全戦績を新しい順に生成。着順は当日と同じ要素(適性・馬場・調子)から決まるので予想の材料になる
  function makeCareer(rng, h, cls, date, used) {
    const target = targetWins(rng, cls);
    const m = cls.key === 'maiden' ? 1 + Math.floor(rng() * 7)
      : clamp(target + 1 + Math.floor(rng() * (h.age - 2) * 6), target + 1, 32);
    let gaps = Array.from({ length: m }, () => (rng() < 0.08 ? 16 + Math.floor(rng() * 25)
      : weighted(rng, [[2, 2], [3, 3], [4, 4], [5, 3], [6, 2], [8, 2], [10, 1], [12, 1]])));
    // デビューは 2 歳の 6 月以降(馬齢は 1 月 1 日に加算)
    const year = new Date(date).getUTCFullYear();
    const debutMin = Date.UTC(year - (h.age - 2), 5, 1);
    const maxWeeks = Math.floor((date - debutMin) / (7 * DAY_MS));
    const total = gaps.reduce((a, b) => a + b, 0);
    if (total > maxWeeks) gaps = gaps.map(g => Math.max(2, Math.floor(g * maxWeeks / total)));
    const runs = [];
    let t = date;
    for (let i = 0; i < m; i++) {
      const weeks = gaps[i];
      if (i === 0) h.layoff = weeks;
      t -= weeks * 7 * DAY_MS;
      const course = pick(rng, COURSES);
      const surface = rng() < 0.82 ? h.surface : (h.surface === '芝' ? 'ダート' : '芝');
      const dist = nearest(course[surface === '芝' ? 'turf' : 'dirt'], h.distBest + gauss(rng) * 300);
      const going = weighted(rng, [['良', 70], ['稍重', 15], ['重', 10], ['不良', 5]]);
      const field = weighted(rng, [[8, 1], [10, 2], [11, 2], [12, 3], [13, 3], [14, 4], [15, 3], [16, 5], [17, 2], [18, 3]]);
      const r = { date: t, dateLabel: fmtDate(t), venue: course.venue, surface, dist, going, field, no: 1 + Math.floor(rng() * field) };
      let cp = h.sp;
      if (surface !== h.surface) cp -= h.offSurface;
      cp -= Math.max(0, Math.abs(dist - h.distBest) - h.distRange) / 100 * 1.5;
      cp += h.wetApt * GOING.indexOf(going) * 0.8;
      if (i < 2) cp += h.form * 2.2;
      const base = cp - cls.level;
      const toPos = (v, sd) => clamp(Math.round(1 + (1 - 1 / (1 + Math.exp(-1.7 * v / sd))) * (field - 1)), 1, field);
      r.pos = toPos(base + gauss(rng) * 11, 14);
      r.pop = toPos(base + gauss(rng) * 6, 12);
      runs.push(r);
    }
    // 勝利数をクラスと整合させる
    const wins = runs.filter(r => r.pos === 1);
    shuffle(rng, wins).slice(0, Math.max(0, wins.length - target)).forEach(r => { r.pos = 2; });
    let need = target - Math.min(wins.length, target);
    for (const r of runs.filter(x => x.pos !== 1).sort((a, b) => a.pos - b.pos)) {
      if (need <= 0) break;
      r.pos = 1; need--;
    }
    // 古い順にクラスを進める
    let ci = 0;
    for (let i = m - 1; i >= 0; i--) {
      const r = runs[i];
      r.cls = ci < 4 ? CLASSES[PROGRESSION[ci]] : openClassFor(rng, cls);
      const ageThen = h.age - (year - new Date(r.date).getUTCFullYear());
      r.raceName = i === m - 1 && ageThen === 2 ? '新馬'
        : (r.cls.grade || r.cls.key === 'op') ? `${pick(rng, RACE_WORDS)}S` : r.cls.name;
      if (r.pos === 1) ci = Math.min(ci + 1, 4);
    }
    const jockeyNames = JOCKEYS.map(j => j[0]);
    let w = h.bodyWeight - h.bodyDiff;
    for (const r of runs) {
      const lvl = r.cls.level;
      r.jockey = rng() < 0.7 ? h.jockey.name : pick(rng, jockeyNames);
      r.kinryo = clamp(h.kinryo + pick(rng, [-1, 0, 0, 0, 1]), 50, 59);
      r.weight = w;
      w += Math.round(gauss(rng) * 3) * 2;
      const winT = r.dist / (baseSpeed(r.dist, r.surface, r.going) * (1 + (lvl - 60) * 0.0012)) + 0.6 + gauss(rng) * 0.5;
      // diff: 勝ち馬とのタイム差(勝った時は 2 着馬との差をマイナスで)
      r.diff = r.pos === 1 ? -Math.round((0.05 + rng() * 0.4) * 10) / 10
        : Math.round(((r.pos - 1) * 0.13 + Math.abs(gauss(rng)) * 0.12 * Math.sqrt(r.pos - 1)) * 10) / 10;
      r.time = winT + Math.max(0, r.diff);
      r.rival = horseName(rng, used);
      const K = r.dist <= 1400 ? 2 : 4;
      const early = { 逃げ: 1 + rng() * 1.2, 先行: 2 + rng() * 3, 差し: r.field * (0.4 + rng() * 0.3), 追込: r.field * (0.75 + rng() * 0.25) }[h.style];
      r.passing = Array.from({ length: K }, (_, k) =>
        clamp(Math.round(early + (r.pos - early) * (k / K) + gauss(rng) * 0.8), 1, r.field)).join('-');
      const base3f = (r.surface === '芝' ? 34.3 : 36.8) + (r.dist - 1600) / 1000 * 0.6 + GOING.indexOf(r.going) * (r.surface === '芝' ? 0.5 : -0.2);
      r.last3f = Math.round((base3f - (h.bu - lvl) * 0.03 + { 逃げ: 0.5, 先行: 0.2, 差し: -0.2, 追込: -0.4 }[h.style] +
        (r.pos - 1) / r.field * 1.2 + gauss(rng) * 0.35) * 10) / 10;
      r.last3fRank = clamp(Math.round(1 + (r.last3f - (base3f - 1.0)) / 2.4 * (r.field - 1)), 1, r.field);
    }
    return runs;
  }

  // [1着, 2着, 3着, 着外]
  function record(runs, f = () => true) {
    const r = [0, 0, 0, 0];
    runs.filter(f).forEach(x => { r[Math.min(x.pos, 4) - 1]++; });
    return r;
  }

  // ---------- 開催(1 日 3 場) ----------
  // 週替わりで「東京・京都・新潟」と「中山・阪神・中京」。slot 0 から 10 分ずつ発走をずらす
  const MEET_SETS = [[0, 2, 5], [1, 3, 4]];
  const POST_MINUTES = [605, 635, 665, 695, 745, 775, 805, 835, 865, 900, 940, 980];
  function daySchedule(day) {
    const venues = MEET_SETS[Math.floor((day - 1) / 2) % MEET_SETS.length];
    const races = [];
    venues.forEach((venueIdx, slot) => {
      for (let raceNo = 1; raceNo <= 12; raceNo++) {
        races.push({ key: `${venueIdx}-${raceNo}`, venueIdx, slot, raceNo, minutes: POST_MINUTES[raceNo - 1] + slot * 10 });
      }
    });
    races.sort((a, b) => a.minutes - b.minutes);
    return { day, venues, races };
  }
  const fmtClock = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

  // light: オッズ(モンテカルロ)を省いた軽量版。出走馬・結果は通常版と同一
  function generateRace({ seed, raceNo = 11, venueIdx = 0, day = 1, slot = 0, light = false }) {
    const rng = rngFor(seed, 'race-gen');
    const course = COURSES[venueIdx % COURSES.length];
    const cls = classForRace(rng, raceNo);
    const turfP = cls.grade ? 0.85 : cls.key === 'maiden' || cls.key === 'c1' ? 0.5 : 0.65;
    const surface = rng() < turfP ? '芝' : 'ダート';
    const distance = pick(rng, surface === '芝' ? course.turf : course.dirt);
    const weather = weighted(rng, [['晴', 55], ['曇', 30], ['小雨', 10], ['雨', 5]]);
    const goingTable = {
      晴: [['良', 85], ['稍重', 12], ['重', 3]],
      曇: [['良', 70], ['稍重', 20], ['重', 8], ['不良', 2]],
      小雨: [['良', 25], ['稍重', 45], ['重', 25], ['不良', 5]],
      雨: [['稍重', 20], ['重', 45], ['不良', 35]],
    };
    const going = weighted(rng, goingTable[weather]);
    const n = cls.key === 'g1' ? 16 + Math.floor(rng() * 3)
      : cls.grade ? 12 + Math.floor(rng() * 7)
      : weighted(rng, [[8, 2], [9, 3], [10, 5], [11, 6], [12, 8], [13, 8], [14, 10], [15, 9], [16, 12], [17, 5], [18, 6]]);
    const handicap = (cls.key === 'c3' || cls.key === 'op' || cls.key === 'g3') && rng() < 0.3;

    const used = new Set();
    const date = raceDate(day);
    let horses = Array.from({ length: n }, () => makeHorse(rng, cls, surface, distance, used));

    // 騎手:実力馬ほど上位騎手が乗りやすい
    const jockeys = shuffle(rng, JOCKEYS.slice()).slice(0, n).sort((a, b) => b[1] - a[1]);
    const byAbility = horses.slice().sort((a, b) => (b.ability + gauss(rng) * 6) - (a.ability + gauss(rng) * 6));
    byAbility.forEach((h, i) => { h.jockey = { name: jockeys[i][0], skill: jockeys[i][1] }; });

    horses = shuffle(rng, horses);
    horses.forEach((h, i) => {
      h.no = i + 1;
      h.bracket = bracketOf(h.no, n);
      h.kinryo = kinryoFor(h, cls, handicap, rng);
      h.career = makeCareer(rng, h, cls, date, used);
      h.past = h.career.slice(0, 5);
      const near = x => Math.abs(x.dist - distance) <= 200;
      h.records = {
        all: record(h.career), turf: record(h.career, x => x.surface === '芝'), dirt: record(h.career, x => x.surface === 'ダート'),
        dist: record(h.career, x => x.surface === surface && near(x)), heavy: record(h.career, x => x.going === '重' || x.going === '不良'),
        venue: record(h.career, x => x.venue === course.venue),
      };
      h.trainingGrade = h.training > 1.0 ? 'A' : h.training > 0.2 ? 'B' : h.training > -0.7 ? 'C' : 'D';
    });

    // 毛色・勝負服(見た目だけ。乱数列を分けて他の生成に影響させない)
    const vis = rngFor(seed, 'visual');
    horses.forEach(h => {
      h.coat = weighted(vis, [['鹿毛', 38], ['黒鹿毛', 20], ['栗毛', 18], ['青鹿毛', 9], ['芦毛', 8], ['栃栗毛', 4], ['青毛', 3]]);
      const c1 = pick(vis, SILK_COLORS);
      let c2 = pick(vis, SILK_COLORS);
      if (c2 === c1) c2 = c1 === '#ffffff' ? '#111111' : '#ffffff';
      h.silks = { body: c1, accent: c2, sleeve: vis() < 0.5 ? c1 : c2, pattern: pick(vis, SILK_PATTERNS) };
    });

    const nige = horses.filter(h => h.style === '逃げ').length;
    const senko = horses.filter(h => h.style === '先行').length;
    const paceAdj = clamp((nige - 1) * 0.006 + (senko - 4) * 0.0015, -0.006, 0.02);

    const timeLabel = fmtClock(POST_MINUTES[raceNo - 1] + slot * 10);
    const name = raceNo === 11 && (cls.grade || cls.key === 'op')
      ? `${pick(rng, RACE_WORDS)}ステークス` : `${cls.key === 'maiden' ? '3歳' : '3歳以上'}${cls.name}`;

    const race = {
      seed, day, raceNo, venueIdx, course, date, dateLabel: fmtDate(date, true), venue: course.venue, dir: course.dir, cls, name, handicap,
      surface, distance, weather, going, n, horses, paceAdj, postTime: timeLabel,
      vbase: baseSpeed(distance, surface, going),
    };
    horses.forEach(h => { h.points = effectivePoints(h, race); });
    if (light) return race;
    race.probs = estimateProbs(race, 500);
    race.market = buildMarket(race);
    race._oddsCache = new Map();
    return race;
  }

  // 当日の実力値(隠しパラメータ)
  function effectivePoints(h, race) {
    let p = h.sp;
    if (h.surface !== race.surface) p -= h.offSurface;
    const over = Math.max(0, Math.abs(race.distance - h.distBest) - h.distRange);
    p -= over / 100 * 1.5;
    p += h.wetApt * GOING.indexOf(race.going) * 0.8;
    p += h.form * 2.2;
    p += (h.jockey.skill - 60) * 0.08;
    p -= (h.kinryo - 55) * 1.6;
    if (Math.abs(h.bodyDiff) >= 10) p -= 1.5;
    if (h.layoff >= 12) p -= 1.2; // 休み明け
    const g = (h.no - 1) / Math.max(1, race.n - 1);
    p += race.surface === '芝' ? 0.6 - g * 1.2 : -0.2 + g * 0.4;
    return p;
  }

  // ---------- レースシミュレーション ----------
  const DT = 0.5;
  const DAY_NOISE = 16; // 当日の出来のブレ(ポイント)
  const ABILITY_K = 0.00034; // 1 ポイントあたりの速度比

  function simulateRace(race, rng, record) {
    const D = race.distance, n = race.n;
    const kickStart = D - Math.min(600, D * 0.35);
    const straightF = 0.85 + race.course.straight / 1000 * 0.35;
    const T0 = D / race.vbase;
    const st = race.horses.map(h => {
      const day = gauss(rng) * DAY_NOISE;
      // クラス水準が絶対的な速さ、クラス内の能力差は小さめに効く
      const mult = 1 + (race.cls.level - 60) * 0.0012 + (h.points + day - race.cls.level) * ABILITY_K;
      let delay = clamp(0.05 + gauss(rng) * 0.08 + (50 - h.gt) * 0.003, 0, 0.5);
      let lateStart = false;
      if (rng() < 0.03 + (50 - h.gt) / 100 * 0.04) { delay += 0.6 + rng() * 1.0; lateStart = true; }
      const trouble = rng() < 0.07 ? { at: D * (0.4 + rng() * 0.5), len: 2 + rng() * 2 } : null;
      const early = EARLY[h.style] + (h.style === '逃げ' || h.style === '先行' ? race.paceAdj : 0);
      const cap = clamp(1.03 + (h.st - race.cls.level) / 100 * (D / 1600) * 0.3, 0.8, 1.3);
      const kick = clamp(0.035 + (h.bu - race.cls.level) / 100 * 0.05, 0.008, 0.075) * KICK_STYLE[h.style] * straightF;
      return { h, mult, delay, lateStart, trouble, troubleT: null, early, E: cap, kick, pos: 0, ar: 0, fin: null };
    });
    const frames = record ? [st.map(() => 0)] : null;
    let t = 0, done = 0, lastFin = 0;
    while (t < 600) {
      for (const s of st) {
        let v = 0;
        if (t >= s.delay) {
          const accel = Math.min(1, (t - s.delay + DT) / 3);
          const x = s.pos / D;
          let pm;
          if (s.pos >= kickStart) pm = 1 + s.kick * clamp(s.E / 0.25, 0, 1);
          else if (x < 0.55) pm = s.early;
          else if (x < 0.7) pm = s.early + (1 - s.early) * (x - 0.55) / 0.15;
          else pm = 1;
          const fatigue = s.E < 0 ? 1 - Math.min(0.05, -s.E * 0.15) : 1;
          s.ar = 0.85 * s.ar + 0.0035 * gauss(rng);
          let trouble = 1;
          if (s.trouble && s.pos >= s.trouble.at) {
            if (s.troubleT === null) s.troubleT = t;
            if (t - s.troubleT < s.trouble.len) trouble = 0.965;
          }
          v = race.vbase * s.mult * pm * fatigue * (1 + s.ar) * accel * trouble;
          if (s.fin === null) s.E -= Math.pow(pm, 4) / T0 * DT;
        }
        const np = s.pos + v * DT;
        if (s.fin === null && np >= D) {
          s.fin = t + DT * (D - s.pos) / (np - s.pos);
          done++;
          lastFin = Math.max(lastFin, s.fin);
        }
        s.pos = np;
      }
      t += DT;
      if (record) frames.push(st.map(s => Math.round(s.pos * 10) / 10));
      if (done === n && t > lastFin + 2) break;
    }
    const order = st.slice().sort((a, b) => a.fin - b.fin);
    return { st, order, frames, dt: DT };
  }

  function estimateProbs(race, sims) {
    const rng = rngFor(race.seed, 'mc');
    const n = race.n;
    const win = Array(n).fill(0), top3 = Array(n).fill(0);
    for (let i = 0; i < sims; i++) {
      const { order } = simulateRace(race, rng, false);
      win[order[0].h.no - 1]++;
      for (let k = 0; k < 3; k++) top3[order[k].h.no - 1]++;
    }
    return { win: win.map(c => c / sims), top3: top3.map(c => c / sims), sims };
  }

  // フレーム列からある地点の通過時刻を求める
  function timeAtDistance(frames, dt, idx, d) {
    for (let f = 1; f < frames.length; f++) {
      const a = frames[f - 1][idx], b = frames[f][idx];
      if (b >= d) return (f - 1) * dt + dt * (b === a ? 0 : (d - a) / (b - a));
    }
    return null;
  }

  function marginText(dtSec, v) {
    const L = dtSec * v / 2.4;
    if (L < 0.1) return 'ハナ';
    if (L < 0.2) return 'アタマ';
    if (L < 0.35) return 'クビ';
    const table = [[0.6, '1/2'], [0.85, '3/4'], [1.1, '1'], [1.4, '1.1/4'], [1.6, '1.1/2'], [1.85, '1.3/4'], [2.25, '2'],
      [2.75, '2.1/2'], [3.25, '3'], [3.75, '3.1/2'], [4.5, '4'], [5.5, '5'], [6.5, '6'], [7.5, '7'], [8.5, '8'], [9.5, '9'], [10.5, '10']];
    for (const [lim, s] of table) if (L < lim) return s;
    return '大差';
  }

  function runRace(race) {
    const rng = rngFor(race.seed, 'race-run');
    const sim = simulateRace(race, rng, true);
    const { frames, dt, order } = sim;
    const D = race.distance;
    const idxOf = s => s.h.no - 1;
    const passing = [0.25, 0.5, 0.75].map(r => {
      const d = D * r;
      const times = sim.st.map((s, i) => ({ no: s.h.no, t: timeAtDistance(frames, dt, i, d) }));
      times.sort((a, b) => a.t - b.t);
      const rank = {};
      times.forEach((x, k) => { rank[x.no] = k + 1; });
      return rank;
    });
    const rows = order.map((s, k) => {
      const t600 = timeAtDistance(frames, dt, idxOf(s), D - 600);
      const prev = order[k - 1];
      return {
        rank: k + 1, no: s.h.no, time: s.fin,
        margin: k === 0 ? '' : marginText(s.fin - prev.fin, D / s.fin),
        last3f: s.fin - t600,
        passing: passing.map(p => p[s.h.no]).join('-'),
        notes: [s.lateStart ? '出遅れ' : null, s.troubleT !== null ? '不利' : null].filter(Boolean),
      };
    });
    const leadAt600 = Math.min(...sim.st.map((s, i) => timeAtDistance(frames, dt, i, 600)));
    const leadAtLast = Math.min(...sim.st.map((s, i) => timeAtDistance(frames, dt, i, D - 600)));
    const first3f = leadAt600, final3f = order[0].fin - leadAtLast;
    const pace = first3f < final3f - 0.8 ? 'H' : first3f > final3f + 0.8 ? 'S' : 'M';
    return {
      order: rows.map(r => r.no), rows, frames, dt, first3f, final3f, pace,
      payouts: race.market ? settlePayouts(race, rows.map(r => r.no)) : null,
    };
  }

  // ---------- 市場(オッズ) ----------
  // 着順確率モデル(Harville を 2・3 着で割り引いた Henery/Benter 型)
  const PL_LAMBDA = [1, 0.81, 0.65];
  function strengths(q) {
    const pw = PL_LAMBDA.map(l => q.map(x => Math.pow(x, l)));
    return { pw, tot: pw.map(a => a.reduce((x, y) => x + y, 0)) };
  }
  function harville(pl, seq) {
    let p = 1;
    for (let k = 0; k < seq.length; k++) {
      const a = pl.pw[k];
      let den = pl.tot[k];
      for (let j = 0; j < k; j++) den -= a[seq[j]];
      p *= a[seq[k]] / den;
    }
    return p;
  }
  function harvilleTop3(pl) {
    const n = pl.pw[0].length, t = Array(n).fill(0);
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      if (b === a) continue;
      for (let c = 0; c < n; c++) {
        if (c === a || c === b) continue;
        const p = harville(pl, [a, b, c]);
        t[a] += p; t[b] += p; t[c] += p;
      }
    }
    return t;
  }

  function payFromOdds(o) {
    // 100 円あたり払戻(10 円未満切り捨て、最低 100 円)
    return Math.max(100, Math.floor(o * 100 / 10 + 1e-9) * 10);
  }

  function buildMarket(race) {
    const rng = rngFor(race.seed, 'market');
    const raw = race.horses.map((h, i) =>
      Math.pow(race.probs.win[i] + 0.003, 0.93) * Math.exp(gauss(rng) * 0.15) * (1 + (h.jockey.skill - 65) * 0.004));
    const sum = raw.reduce((a, b) => a + b, 0);
    const q = raw.map(r => r / sum);
    const winPay = q.map(x => payFromOdds((1 - BET.win.takeout) / x));
    const pl = strengths(q);
    const t3 = harvilleTop3(pl);
    const ps = t3.map(x => x / 3 * Math.exp(gauss(rng) * 0.12));
    const psSum = ps.reduce((a, b) => a + b, 0);
    const placeShare = ps.map(x => x / psSum);
    const pop = Array(race.n);
    q.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]).forEach(([, i], k) => { pop[i] = k + 1; });
    // 新聞の印(大衆の見立て + 記者の主観)
    const marks = Array(race.n).fill('');
    const press = q.map((x, i) => [x * Math.exp(gauss(rng) * 0.35), i]).sort((a, b) => b[0] - a[0]);
    ['◎', '○', '▲', '△', '△', '☆'].forEach((m, k) => { if (press[k]) marks[press[k][1]] = m; });
    return { q, pl, winPay, placeShare, pop, marks };
  }

  function placePay(race, no, winners) {
    const s = race.market.placeShare;
    const sumW = winners.reduce((a, w) => a + s[w - 1], 0);
    const surplus = (1 - BET.place.takeout) - sumW;
    return payFromOdds(Math.max(1, 1 + surplus / (winners.length * s[no - 1])));
  }

  function placeRange(race, no) {
    const s = race.market.placeShare;
    const others = race.horses.map(h => h.no).filter(x => x !== no).sort((a, b) => s[b - 1] - s[a - 1]);
    const hi = placePay(race, no, [no, others[others.length - 1], others[others.length - 2]]);
    const lo = placePay(race, no, [no, others[0], others[1]]);
    return { min: lo, max: hi };
  }

  function canonical(type, combo) {
    return BET[type].ordered ? combo.slice() : combo.slice().sort((a, b) => a - b);
  }
  const comboKey = combo => combo.join('-');

  function trioProb(q, a, b, c) {
    return harville(q, [a, b, c]) + harville(q, [a, c, b]) + harville(q, [b, a, c]) +
      harville(q, [b, c, a]) + harville(q, [c, a, b]) + harville(q, [c, b, a]);
  }

  function horsesInBracket(race, b) { return race.horses.filter(h => h.bracket === b).map(h => h.no - 1); }

  function comboProb(race, type, combo) {
    const q = race.market.pl;
    const ix = combo.map(x => x - 1);
    switch (type) {
      case 'win': return race.market.q[ix[0]];
      case 'exacta': return harville(q, ix);
      case 'quinella': return harville(q, ix) + harville(q, [ix[1], ix[0]]);
      case 'trifecta': return harville(q, ix);
      case 'trio': return trioProb(q, ix[0], ix[1], ix[2]);
      case 'wide': {
        let p = 0;
        for (let k = 0; k < race.n; k++) if (k !== ix[0] && k !== ix[1]) p += trioProb(q, ix[0], ix[1], k);
        return p;
      }
      case 'bracket': {
        const A = horsesInBracket(race, combo[0]), B = horsesInBracket(race, combo[1]);
        let p = 0;
        for (const i of A) for (const j of B) {
          if (i === j || (combo[0] === combo[1] && i > j)) continue;
          p += harville(q, [i, j]) + harville(q, [j, i]);
        }
        return p;
      }
    }
    throw new Error('未対応の券種: ' + type);
  }

  // 100 円あたりの払戻(=オッズ×100)。複勝は {min,max}
  function odds(race, type, combo) {
    if (type === 'place') return placeRange(race, combo[0]);
    if (type === 'win') return race.market.winPay[combo[0] - 1];
    const c = canonical(type, combo);
    const key = type + ':' + comboKey(c);
    const cache = race._oddsCache;
    if (cache && cache.has(key)) return cache.get(key);
    const noise = Math.exp(gauss(rngFor(race.seed, key)) * 0.12);
    const pay = payFromOdds((1 - BET[type].takeout) / (comboProb(race, type, c) * noise));
    if (cache) cache.set(key, pay);
    return pay;
  }

  function bracketSold(race) { return race.n >= 9; }

  function settlePayouts(race, order) {
    const [a, b, c] = order;
    const top3 = [a, b, c];
    const out = {
      win: [{ combo: [a], pay: odds(race, 'win', [a]) }],
      place: top3.map(x => ({ combo: [x], pay: placePay(race, x, top3) })),
      bracket: null,
      quinella: [{ combo: canonical('quinella', [a, b]), pay: odds(race, 'quinella', [a, b]) }],
      wide: [[a, b], [a, c], [b, c]].map(p => ({ combo: canonical('wide', p), pay: odds(race, 'wide', p) })),
      exacta: [{ combo: [a, b], pay: odds(race, 'exacta', [a, b]) }],
      trio: [{ combo: canonical('trio', top3), pay: odds(race, 'trio', top3) }],
      trifecta: [{ combo: top3, pay: odds(race, 'trifecta', top3) }],
    };
    if (bracketSold(race)) {
      const bc = canonical('bracket', [race.horses[a - 1].bracket, race.horses[b - 1].bracket]);
      out.bracket = [{ combo: bc, pay: odds(race, 'bracket', bc) }];
    }
    return out;
  }

  // ---------- 馬券 ----------
  function combinations(arr, k) {
    if (k === 0) return [[]];
    const res = [];
    arr.forEach((x, i) => { for (const rest of combinations(arr.slice(i + 1), k - 1)) res.push([x, ...rest]); });
    return res;
  }
  function permutations(arr, k) {
    if (k === 0) return [[]];
    const res = [];
    arr.forEach((x, i) => {
      for (const rest of permutations(arr.filter((_, j) => j !== i), k - 1)) res.push([x, ...rest]);
    });
    return res;
  }
  const uniq = arr => [...new Set(arr)];

  // method: normal | box | nagashi | formation
  function expandCombos(race, type, method, sel) {
    const bt = BET[type];
    if (!bt) throw new Error('券種が不正です');
    const isBracket = bt.unit === 'bracket';
    if (isBracket && !bracketSold(race)) throw new Error('8頭立て以下のため枠連は発売していません');
    const valid = x => Number.isInteger(x) && (isBracket ? x >= 1 && x <= 8 && race.horses.some(h => h.bracket === x) : x >= 1 && x <= race.n);
    const all = [
      ...(sel.picks || []), ...(sel.list || []), ...(sel.others || []),
      ...(sel.axis != null ? [sel.axis] : []), ...((sel.cols || []).flat()),
    ];
    if (!all.every(valid)) throw new Error('存在しない' + (isBracket ? '枠番' : '馬番') + 'が含まれています');
    const k = bt.k;
    let combos;
    if (method === 'normal') {
      const p = sel.picks || [];
      if (p.length !== k) throw new Error(`${k}つ選んでください`);
      combos = [p];
    } else if (method === 'box') {
      const l = uniq(sel.list || []);
      if (l.length < k) throw new Error(`ボックスは${k}つ以上選んでください`);
      combos = bt.ordered ? permutations(l, k) : combinations(l, k);
    } else if (method === 'nagashi') {
      if (k < 2) throw new Error('単勝・複勝にながしはありません');
      if (sel.axis == null) throw new Error('軸を選んでください');
      const others = uniq(sel.others || []).filter(x => x !== sel.axis);
      if (others.length < k - 1) throw new Error(`相手を${k - 1}つ以上選んでください`);
      combos = (bt.ordered ? permutations(others, k - 1) : combinations(others, k - 1)).map(r => [sel.axis, ...r]);
    } else if (method === 'formation') {
      const cols = sel.cols || [];
      if (cols.length !== k || cols.some(c => c.length === 0)) throw new Error(`${k}列すべて選んでください`);
      combos = [[]];
      for (const col of cols) {
        const next = [];
        for (const c of combos) for (const x of uniq(col)) next.push([...c, x]);
        combos = next;
      }
    } else throw new Error('買い方が不正です');

    const seen = new Set(), out = [];
    for (const c0 of combos) {
      const c = canonical(type, c0);
      const dupHorse = new Set(c).size !== c.length;
      if (dupHorse) {
        // 枠連のゾロ目は同枠に 2 頭以上いるときだけ成立
        if (!(isBracket && horsesInBracket(race, c[0]).length >= 2)) continue;
      }
      const key = comboKey(c);
      if (!seen.has(key)) { seen.add(key); out.push(c); }
    }
    if (out.length === 0) throw new Error('成立する組み合わせがありません');
    return out;
  }

  let ticketSeq = 0;
  function createTicket(race, { type, method, sel, stake }) {
    if (!Number.isInteger(stake) || stake < 100 || stake % 100 !== 0) throw new Error('金額は100円単位で指定してください');
    const combos = expandCombos(race, type, method, sel);
    return { id: `${Date.now().toString(36)}-${++ticketSeq}`, type, method, sel, combos, stake, cost: stake * combos.length };
  }

  function ticketReturn(ticket, payouts) {
    const list = payouts[ticket.type] || [];
    const hits = [];
    for (const c of ticket.combos) {
      const m = list.find(p => comboKey(p.combo) === comboKey(c));
      if (m) hits.push({ combo: c, pay: m.pay * ticket.stake / 100 });
    }
    return { hits, total: hits.reduce((s, h) => s + h.pay, 0) };
  }

  function formatTime(sec) {
    const t = Math.round(sec * 10) / 10;
    const m = Math.floor(t / 60);
    const s = (t - m * 60).toFixed(1).padStart(4, '0');
    return m > 0 ? `${m}:${s}` : s;
  }

  return {
    mulberry32, hashStr, gauss, COURSES, CLASSES, BET_TYPES, BET, STYLES, GOING,
    bracketCounts, bracketOf, baseSpeed, generateRace, runRace, simulateRace, estimateProbs,
    odds, placePay, placeRange, payFromOdds, settlePayouts, expandCombos, createTicket, ticketReturn,
    bracketSold, formatTime, fmtDate, daySchedule, fmtClock, NAME_WITTY, JOCKEYS, record, marginText, comboProb, canonical, comboKey, harvilleTop3,
  };
});
