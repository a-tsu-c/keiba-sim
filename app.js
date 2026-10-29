/* 競馬シミュレーション UI */
(() => {
  'use strict';
  const E = KeibaEngine;
  const $ = (s, el = document) => el.querySelector(s);
  const yen = v => (v < 0 ? '-¥' : '¥') + Math.abs(Math.round(v)).toLocaleString('ja-JP');
  const signedYen = v => (v > 0 ? '+' : '') + yen(v);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const odds1 = pay => (pay / 100).toFixed(1);

  // 保存はモードごと(12R・重賞のみ)。マルチプレイはルームの間だけ。総成績はこのブラウザの全モード通算
  const SLOT_KEY = { normal: 'keiba-sim-v1', graded: 'keiba-sim-graded-v1' };
  const MODE_KEY = 'keiba-sim-mode';
  const PROFILE_KEY = 'keiba-sim-profile';
  const MODE_LABEL = { normal: '12R(3場)', graded: '重賞のみ', multi: 'マルチ' };
  const PREF_FIELDS = ['speed', 'view', 'sound', 'voice', 'side', 'voiceName'];
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
  const START_MONEY = 100000;
  const BRACKET_COLORS = {
    1: ['#ffffff', '#111'], 2: ['#222222', '#fff'], 3: ['#e53935', '#fff'], 4: ['#1e6fd9', '#fff'],
    5: ['#f6d000', '#111'], 6: ['#1a9b4b', '#fff'], 7: ['#f08a00', '#111'], 8: ['#f49ac1', '#111'],
  };
  const METHOD_LABEL = { normal: '通常', box: 'ボックス', nagashi: 'ながし', formation: 'フォーメーション' };

  // ---------- 保存 ----------
  // meet: その日の開催(3 場 × 12R)。races[key] = { tickets, done, skipped, winnerNo, winner }
  function defaultSave() {
    return { v: 2, bankroll: START_MONEY, topups: 0, speed: 4, view: 'paper', stats: { wagered: 0, returned: 0, races: 0, hitRaces: 0 }, history: [], meet: null, sel: null,
      sound: true, voice: true, side: true, tipsters: {}, worldSeed: newSeed(), worldLog: [] };
  }
  function load(key) {
    try {
      const s = JSON.parse(lsGet(key));
      if (s && s.v === 2) return { sound: true, voice: true, side: true, tipsters: {}, worldSeed: newSeed(), worldLog: [], ...s };
      if (s && s.v === 1) {
        // 旧形式(1 場ずつ):未精算の馬券は払い戻して引き継ぐ
        const refund = s.cur && s.cur.status !== 'done' ? s.cur.tickets.reduce((a, t) => a + t.cost, 0) : 0;
        return { ...defaultSave(), bankroll: s.bankroll + refund, topups: s.topups, speed: s.speed, view: s.view || 'paper',
          stats: { ...s.stats, wagered: s.stats.wagered - refund }, history: s.history };
      }
    } catch (e) { /* 保存領域が使えない場合は新規 */ }
    return defaultSave();
  }
  function persist() {
    if (save && SLOT_KEY[mode]) lsSet(SLOT_KEY[mode], JSON.stringify(save));
  }

  const newSeed = () => (Math.random() * 0xffffffff) >>> 0;
  let mode = lsGet(MODE_KEY) === 'graded' ? 'graded' : 'normal';
  let save = load(SLOT_KEY[mode]);
  let race = null, result = null, cart = [], anim = null, showHistory = false, showStats = false;
  const ui = { type: 'win', method: 'normal', rows: [[]], stake: 100, mpStyle: 'normal', lobbyError: '', busy: '' };
  // 遊び方:12R(3 場 36 レース)か重賞のみか。マルチはルームを作った人が決める
  const style = () => (mode === 'multi' ? (room ? room.style : ui.mpStyle) : mode);
  const graded = () => style() === 'graded';
  let room = null; // マルチプレイのルーム(下の「マルチプレイ」)

  // ---------- 総成績(このブラウザの全モード通算。モードのリセットでは消えない) ----------
  const blankRec = () => ({ w: 0, r: 0, n: 0, hit: 0 });
  function loadProfile() {
    try { const p = JSON.parse(lsGet(PROFILE_KEY)); if (p && p.v === 1) return p; } catch (e) { /* 新規 */ }
    const p = { v: 1, name: '', since: Date.now(), total: blankRec(), byMode: {}, byType: {}, best: null, bestOdds: null, topups: 0, resets: 0, curve: [] };
    // 総成績を始める前の 12R モードの成績を引き継ぐ
    try {
      const s = JSON.parse(lsGet(SLOT_KEY.normal));
      if (s && s.stats && s.stats.wagered > 0) {
        const bet = (s.history || []).filter(h => h.wagered > 0);
        const rec = { w: s.stats.wagered, r: s.stats.returned, n: Math.max(bet.length, s.stats.hitRaces), hit: s.stats.hitRaces };
        p.total = { ...rec }; p.byMode.normal = { ...rec }; p.topups = s.topups || 0;
        let pl = (s.stats.returned - s.stats.wagered) - bet.reduce((a, h) => a + h.returned - h.wagered, 0);
        p.curve = bet.slice().reverse().map(h => (pl += h.returned - h.wagered));
        const top = bet.reduce((a, h) => (!a || h.returned > a.returned ? h : a), null);
        if (top && top.returned > 0) p.best = { ret: top.returned, spent: top.wagered, label: `${MODE_LABEL.normal} ${top.label}`, name: top.name, at: Date.now() };
      }
    } catch (e) { /* 引き継ぎなし */ }
    return p;
  }
  let profile = loadProfile();
  const saveProfile = () => lsSet(PROFILE_KEY, JSON.stringify(profile));
  // 馬券を買ったレースが確定したら総成績へ
  function addLifetime(tickets, label, name) {
    const spent = tickets.reduce((a, t) => a + t.cost, 0), back = tickets.reduce((a, t) => a + (t.ret || 0), 0);
    if (!spent) return;
    const P = profile, full = `${MODE_LABEL[mode]}${mode === 'multi' ? `(${MODE_LABEL[style()]})` : ''} ${label}`;
    for (const rec of [P.total, P.byMode[mode] ||= blankRec()]) { rec.w += spent; rec.r += back; rec.n++; if (back) rec.hit++; }
    for (const t of tickets) {
      const b = P.byType[t.type] ||= blankRec();
      b.w += t.cost; b.r += t.ret || 0; b.n++;
      if (t.ret) {
        b.hit++;
        const x = t.ret / t.cost;
        if (!P.bestOdds || x > P.bestOdds.x) P.bestOdds = { x, type: t.type, sel: `${METHOD_LABEL[t.method]} ${selText(t.type, t.method, t.sel)}`, cost: t.cost, ret: t.ret, label: full, name, at: Date.now() };
      }
    }
    if (back && (!P.best || back > P.best.ret)) P.best = { ret: back, spent, label: full, name, at: Date.now() };
    P.curve.push(Math.round(P.total.r - P.total.w));
    if (P.curve.length > 500) P.curve.shift();
    saveProfile();
  }

  const raceLabel = r => `${r.venue} ${r.day}日目 ${r.raceNo}R`;

  // ---------- 開催 ----------
  const headerCache = new Map();
  let scheduleCache = null;
  // 出走馬の生成方式を変えたら上げる(同じシードでも別の馬になるため、古い開催は作り直す)
  const MEET_GEN = 6;
  // 競走馬データベース(約 8,500 頭・過去 2 年半の全レース)。開いた時に作り、これまでの開催の結果を順に書き込む
  let world = null;
  function buildWorld() {
    world = E.createWorld(save.worldSeed);
    for (const log of save.worldLog) {
      applyResults(log.day, log.races);
      if (log.q) quickRest(log.day, log.races);
    }
    if (save.meet) applyResults(save.meet.day, meetResults());
    scheduleCache = null; headerCache.clear();
  }
  function applyResults(day, races) {
    for (const def of E.meetCard(world, day, 0)) if (races[def.key]) E.recordRace(world, def, E.unpackRows(races[def.key]));
  }
  const meetResults = () => Object.fromEntries(Object.entries(save.meet.races).filter(([, st]) => st.res).map(([k, st]) => [k, st.res]));
  // 重賞のみ:遊ばなかった平場は速い計算で確定(シードで決まるので保存しない。作り直しても同じ結果)
  function quickRest(day, races) {
    for (const def of E.meetCard(world, day, 0)) if (!races[def.key]) E.quickResolve(world, def, `${save.worldSeed}|q|${day}|${def.key}`);
  }
  // その日を締めて記録し、翌開催日へ。重賞のみでは重賞のない日を飛ばす
  function closeDay() {
    const day = save.meet.day, races = meetResults();
    if (graded()) { quickRest(day, races); save.worldLog.push({ day, races, q: 1 }); }
    else save.worldLog.push({ day, races });
  }
  function advanceDay() {
    closeDay();
    newMeet(save.meet.day + 1);
    skipEmptyDays();
  }
  function skipEmptyDays() {
    while (graded() && !schedule().races.length) { closeDay(); newMeet(save.meet.day + 1); }
  }
  // レースが確定したらデータベースへ(以降の出馬表・馬柱に反映)
  function finishRace(key, r, res) {
    const rows = E.resultRows(r, res);
    E.recordRace(world, r.def, rows);
    rstate(key).res = E.packRows(rows);
  }
  function newMeet(day) {
    save.meet = { gen: MEET_GEN, day, races: {} };
    save.sel = null;
    headerCache.clear();
  }
  // その日の番組:データベースの出馬表(3 場 × 12R)に発走時刻を付けたもの
  function schedule() {
    if (!scheduleCache || scheduleCache.day !== save.meet.day) {
      const base = E.daySchedule(save.meet.day);
      const defs = new Map(E.meetCard(world, save.meet.day, 0).map(d => [d.key, d]));
      const g = graded();
      scheduleCache = { ...base, races: base.races.filter(r => defs.has(r.key) && (!g || defs.get(r.key).cls.grade)).map(r => ({ ...r, def: defs.get(r.key) })) };
    }
    return scheduleCache;
  }
  const infoOf = key => schedule().races.find(r => r.key === key);
  const rstate = key => (save.meet.races[key] ||= { tickets: [], done: false });
  const raceOpts = info => ({ seed: E.hashStr(`${save.worldSeed}|${save.meet.day}|${info.key}`), def: info.def, world, day: save.meet.day });
  // 番組表・自動スキップ用の軽量版(オッズなし。出走馬と結果は通常版と同じ)
  function header(info) {
    if (!headerCache.has(info.key)) headerCache.set(info.key, E.generateRace({ ...raceOpts(info), light: true }));
    return headerCache.get(info.key);
  }
  const openRaces = () => schedule().races.filter(r => !rstate(r.key).done);
  const nextKey = () => (openRaces()[0] || {}).key || null;
  // 発走させるレース:馬券を買った最も早いレース。なければ次のレース
  const targetKey = () => { const o = openRaces(); return (o.find(r => rstate(r.key).tickets.length) || o[0] || {}).key || null; };
  const curState = () => rstate(save.sel);

  const myHorses = () => {
    const s = new Set();
    if (!save.sel || !race) return s;
    for (const t of curState().tickets) {
      if (E.BET[t.type].unit === 'bracket') {
        t.combos.flat().forEach(b => race.horses.filter(h => h.bracket === b).forEach(h => s.add(h.no)));
      } else t.combos.flat().forEach(no => s.add(no));
    }
    return s;
  };

  function selectRace(key) {
    save.sel = key;
    persist();
    cart = [];
    setType('win');
    if (!key) { race = null; result = null; render(); return; }
    race = E.generateRace(raceOpts(infoOf(key)));
    result = curState().done ? E.runRace(race) : null;
    render();
  }

  function init() {
    if (save.meet && save.meet.gen !== MEET_GEN) {
      // 旧方式の開催:未発走レースの馬券は払い戻し、新しいデータベースで 1 日目から
      const refund = Object.values(save.meet.races).filter(r => !r.done).flatMap(r => r.tickets).reduce((a, t) => a + t.cost, 0);
      save.bankroll += refund;
      save.stats.wagered -= refund;
      save.worldSeed = newSeed(); save.worldLog = [];
      save.meet = null;
    }
    startWorld(() => selectRace(save.sel && infoOf(save.sel) ? save.sel : nextKey()));
  }
  // データベースを作る間(1 秒ほど)は案内を出す
  function showLoading(msg = '競走馬データベースを作成中…', sub = '約 8,500 頭・過去 2 年半のレースを再現しています') {
    $('#app').innerHTML = `<div class="loading"><div class="spinner"></div><p>${msg}${sub ? `<br><small>${sub}</small>` : ''}</p></div>`;
  }
  function startWorld(after) {
    showLoading();
    race = null; result = null; cart = [];
    setTimeout(() => {
      if (!save.meet) newMeet(1);
      buildWorld();
      skipEmptyDays();
      persist();
      after();
    }, 30);
  }
  // モードの切り替え(12R・重賞のみ・マルチ)。それぞれ別の所持金・開催・データベース
  function switchMode(m) {
    if (anim || m === mode || !MODE_LABEL[m]) return;
    const prefs = save ? Object.fromEntries(PREF_FIELDS.filter(k => save[k] !== undefined).map(k => [k, save[k]])) : lastPrefs;
    if (room && !leaveRoom(true)) return;
    persist();
    lastPrefs = prefs;
    mode = m;
    showHistory = false;
    if (m === 'multi') { save = null; world = null; race = null; result = null; cart = []; render(); return; }
    lsSet(MODE_KEY, m);
    save = { ...load(SLOT_KEY[m]), ...prefs };
    init();
  }
  let lastPrefs = {};

  // ---------- 投票パネルの状態 ----------
  function methodsFor(type) { return E.BET[type].k === 1 ? ['normal', 'box'] : ['normal', 'box', 'nagashi', 'formation']; }
  function rowSpec() {
    const bt = E.BET[ui.type], k = bt.k;
    switch (ui.method) {
      case 'normal': return bt.ordered ? Array.from({ length: k }, (_, i) => ({ label: `${i + 1}着`, single: true })) : [{ label: k === 1 ? '選択' : `${k}頭選択`, max: k }];
      case 'box': return [{ label: '選択' }];
      case 'nagashi': return [{ label: bt.ordered ? '1着(軸)' : '軸', single: true }, { label: '相手' }];
      case 'formation': return Array.from({ length: k }, (_, i) => ({ label: bt.ordered ? `${i + 1}着` : `${i + 1}頭目` }));
    }
  }
  function setType(type) {
    ui.type = type;
    if (!methodsFor(type).includes(ui.method)) ui.method = 'normal';
    ui.rows = rowSpec().map(() => []);
  }
  function setMethod(m) { ui.method = m; ui.rows = rowSpec().map(() => []); }
  function buildSel() {
    const bt = E.BET[ui.type];
    switch (ui.method) {
      case 'normal': return { picks: bt.ordered ? ui.rows.map(r => r[0]).filter(x => x != null) : ui.rows[0].slice() };
      case 'box': return { list: ui.rows[0].slice() };
      case 'nagashi': return { axis: ui.rows[0][0], others: ui.rows[1].slice() };
      case 'formation': return { cols: ui.rows.map(r => r.slice()) };
    }
  }
  function selText(type, method, sel) {
    const sep = E.BET[type].ordered ? '→' : '-';
    switch (method) {
      case 'normal': return sel.picks.join(sep);
      case 'box': return sel.list.slice().sort((a, b) => a - b).join(',');
      case 'nagashi': return `軸${sel.axis} ⇒ ${sel.others.slice().sort((a, b) => a - b).join(',')}`;
      case 'formation': return sel.cols.map(c => c.slice().sort((a, b) => a - b).join(',')).join(' / ');
    }
  }
  function preview() {
    try {
      const combos = E.expandCombos(race, ui.type, ui.method, buildSel());
      let min = Infinity, max = 0, inv = 0;
      for (const c of combos) {
        const o = E.odds(race, ui.type, c);
        const lo = typeof o === 'number' ? o : o.min, hi = typeof o === 'number' ? o : o.max;
        min = Math.min(min, lo); max = Math.max(max, hi);
        inv += 100 / lo;
      }
      return { ok: true, combos, min, max, synth: 100 / inv };
    } catch (e) {
      return { ok: false, msg: e.message };
    }
  }

  // ---------- 描画 ----------
  function waku(b, extra = '') {
    const [bg, fg] = BRACKET_COLORS[b];
    return `<span class="waku ${extra}" style="background:${bg};color:${fg}">${b}</span>`;
  }

  function renderHeader() {
    const modes = `<nav class="modes" aria-label="モード">${Object.keys(MODE_LABEL).map(m =>
      `<button class="chip small ${mode === m ? 'on' : ''}" data-mode="${m}" ${anim ? 'disabled' : ''}>${MODE_LABEL[m]}</button>`).join('')}</nav>`;
    if (!save) {
      return `<header class="top"><div class="brand">🏇 <b>KEIBA SIM</b><span class="sub">競馬シミュレーター</span></div>${modes}
        <div class="money"><div class="btns"><button class="ghost" data-act="stats">総成績</button></div></div></header>`;
    }
    const st = save.stats;
    // 再生中はゴールまで払戻を伏せる
    const hidden = anim ? anim.hiddenReturn : 0;
    const returned = st.returned - hidden;
    const pl = returned - st.wagered;
    const roi = st.wagered ? (returned / st.wagered * 100).toFixed(1) + '%' : '—';
    return `
      <header class="top">
        <div class="brand">🏇 <b>KEIBA SIM</b><span class="sub">競馬シミュレーター</span></div>
        ${modes}
        <div class="money">
          <div><span class="lbl">所持金</span><b id="bankroll">${yen(save.bankroll - hidden)}</b></div>
          <div><span class="lbl">${mode === 'multi' ? 'ルーム収支' : 'このモードの収支'}</span><b class="${pl >= 0 ? 'plus' : 'minus'}">${signedYen(pl)}</b></div>
          <div><span class="lbl">回収率</span><b>${roi}</b></div>
          <div class="btns">
            <button class="ghost" data-act="stats">総成績</button>
            <button class="ghost" data-act="history">履歴</button>
            ${mode === 'multi' ? '' : '<button class="ghost" data-act="reset">リセット</button>'}
          </div>
        </div>
      </header>`;
  }

  function renderRaceInfo() {
    const r = race;
    const grade = r.cls.grade ? `<span class="grade g${r.cls.key.slice(1)}">${r.cls.name}</span>` : `<span class="cls">${r.cls.name}</span>`;
    return `
      <section class="raceinfo">
        <div class="rno">${r.raceNo}<small>R</small></div>
        <div class="rmain">
          <div class="rname">${esc(r.name)} ${grade}${r.handicap ? '<span class="cls">ハンデ</span>' : ''}</div>
          <div class="rmeta">
            <span>${r.dateLabel}</span>
            <span>${r.venue} ${r.day}日目</span>
            <span class="surf ${r.surface === '芝' ? 'turf' : 'dirt'}">${r.surface} ${r.distance}m</span>
            <span>${r.dir}回り</span>
            <span>天候:${r.weather}</span>
            <span>馬場:${r.going}</span>
            <span>${r.n}頭</span>
            <span>${r.postTime} 発走</span>
          </div>
        </div>
      </section>`;
  }

  const circled = n => '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱'[n - 1] || n;
  const rec = r => r.join('-');
  const interval = w => (w >= 12 ? `休み明け(中${w - 1}週)` : `中${w - 1}週`);
  const surfShort = s => (s === '芝' ? '芝' : 'ダ');
  const classTag = c => (c.grade ? `<span class="grade g${c.key.slice(1)}">${c.name}</span>` : c.key === 'op' ? '<span class="cls">OP</span>' : '');

  // 勝ち馬のタイム(自分が勝った時は自分のタイム)
  const winTime = p => p.time - Math.max(0, p.diff);
  function pastHtml(h) {
    return h.past.map(p => {
      const cls = p.pos === 1 ? 'p1' : p.pos === 2 ? 'p2' : p.pos === 3 ? 'p3' : p.pos <= 5 ? 'p5' : '';
      return `<span class="past ${cls}" title="${p.dateLabel} ${p.venue} ${esc(p.raceName)} ${p.surface}${p.dist}m ${p.going} ${p.field}頭 ${p.pop}人気 ${p.pos}着 タイム${E.formatTime(p.time)}(勝ち${E.formatTime(winTime(p))})">${p.pos}</span>`;
    }).join('');
  }

  // 予想家の印
  const TIPS = E.TIPSTERS;
  const tipMarks = i => race.market.tips.map(t => t.marks[i]);
  function tipsCells(i) { return tipMarks(i).map((m, k) => `<td class="tip m${markClass(m)}" title="${TIPS[k].name}(${TIPS[k].style})">${m}</td>`).join(''); }
  function tipsRow(i) {
    return `<div class="tips">${tipMarks(i).map((m, k) => `<span class="tip m${markClass(m)}" title="${TIPS[k].name}(${TIPS[k].style})"><small>${TIPS[k].short[0]}</small>${m || '・'}</span>`).join('')}</div>`;
  }
  function markClass(m) { return { '◎': 1, '○': 2, '▲': 3, '△': 4, '☆': 5 }[m] || 0; }
  // 予想家の成績(◎の単勝成績。このブラウザで再生したレースが対象)
  function tipsterBoard() {
    const rows = TIPS.map(t => {
      const r = save.tipsters[t.id] || { n: 0, win: 0, top3: 0, ret: 0 };
      const pct = (a, b) => (b ? Math.round(a / b * 100) + '%' : '—');
      return `<div class="tipster" title="${esc(t.desc)}"><b>${t.name}</b><span class="sub">${t.style}</span>
        <span class="tstat">◎ 勝率 ${pct(r.win, r.n)} / 複勝率 ${pct(r.top3, r.n)} / 単回収 ${pct(r.ret, r.n * 100)}<span class="sub">(${r.n}R)</span></span></div>`;
    }).join('');
    return `<details class="tipboard"><summary>予想家 5 人の印<span class="sub">(${TIPS.map(t => `${t.short[0]}=${t.short}・${t.style}`).join(' / ')})</span></summary><div class="tiplist">${rows}</div></details>`;
  }
  function recordTipsters() {
    const top3 = result.order.slice(0, 3);
    race.market.tips.forEach((t, k) => {
      const i = t.marks.indexOf('◎');
      if (i < 0) return;
      const r = save.tipsters[TIPS[k].id] ||= { n: 0, win: 0, top3: 0, ret: 0 };
      r.n++;
      if (result.order[0] === i + 1) { r.win++; r.ret += race.market.winPay[i]; }
      if (top3.includes(i + 1)) r.top3++;
    });
  }

  function silkSwatch(s) {
    const b = s.body, a = s.accent;
    const bg = {
      plain: b,
      hoops: `linear-gradient(180deg, ${b} 0 36%, ${a} 36% 64%, ${b} 64%)`,
      stripes: `repeating-linear-gradient(90deg, ${b} 0 3px, ${a} 3px 6px)`,
      sash: `linear-gradient(135deg, ${b} 0 38%, ${a} 38% 62%, ${b} 62%)`,
      halves: `linear-gradient(90deg, ${b} 0 50%, ${a} 50%)`,
      dots: `radial-gradient(${a} 28%, transparent 30%) 0 0 / 6px 6px, ${b}`,
      chevron: `linear-gradient(160deg, ${b} 0 40%, ${a} 40% 55%, ${b} 55%)`,
    }[s.pattern] || b;
    return `<span class="silk" style="background:${bg}" title="勝負服"></span>`;
  }

  function viewTabs() {
    return `<div class="viewtabs">${[['paper', '馬柱(近5走詳細)'], ['simple', '出馬表']].map(([k, l]) =>
      `<button class="chip small ${save.view === k ? 'on' : ''}" data-view="${k}">${l}</button>`).join('')}</div>`;
  }

  function renderCard() {
    return save.view === 'simple' ? renderSimpleCard() : renderPaper();
  }

  function renderSimpleCard() {
    const m = race.market, mine = myHorses();
    const rows = race.horses.map((h, i) => {
      const pr = E.placeRange(race, h.no);
      const pop = m.pop[i];
      const diff = h.bodyDiff === 0 ? '±0' : (h.bodyDiff > 0 ? '+' : '') + h.bodyDiff;
      const last = h.past[0] || null;
      return `
        <tr class="${mine.has(h.no) ? 'mine' : ''}">
          <td>${waku(h.bracket)}</td>
          <td class="no">${h.no}</td>
          ${tipsCells(i)}
          <td class="hn"><div class="name">${silkSwatch(h.silks)}${esc(h.name)}</div><div class="sub">${h.sex}${h.age} ${h.coat}</div></td>
          <td>${h.kinryo.toFixed(1)}</td>
          <td class="jk">${esc(h.jockey.name)}</td>
          <td>${h.bodyWeight}<span class="sub">(${diff})</span></td>
          <td><span class="style">${h.style}</span></td>
          <td><span class="train t${h.trainingGrade}">${h.trainingGrade}</span></td>
          <td class="sub">${interval(h.layoff)}</td>
          <td>${rec(h.records.all)}</td>
          <td class="lastrun">${last ? `${last.venue} ${esc(last.raceName)} ${surfShort(last.surface)}${last.dist} <b>${last.pos}着</b> ${E.formatTime(last.time)}<span class="sub">(${last.pop}人)</span>` : '<span class="sub">初出走</span>'}</td>
          <td class="pasts">${pastHtml(h)}</td>
          <td class="odds ${pop <= 3 ? 'hot' : ''}">${odds1(m.winPay[i])}</td>
          <td class="pop">${pop}</td>
          <td class="podds">${odds1(pr.min)}-${odds1(pr.max)}</td>
        </tr>`;
    }).join('');
    return `
      <section class="card">
        <h2>出馬表 <small>オッズは締切時点(確定)/近走は左が前走</small></h2>
        ${viewTabs()}
        ${tipsterBoard()}
        <div class="tablewrap">
          <table class="entries">
            <thead><tr><th>枠</th><th>馬番</th>${TIPS.map(t => `<th class="tip" title="${t.name}(${t.style})">${t.short[0]}</th>`).join('')}<th>馬名</th><th>斤量</th><th>騎手</th><th>馬体重</th><th>脚質</th><th>調教</th><th>間隔</th><th>通算</th><th>前走</th><th>近5走</th><th>単勝</th><th>人気</th><th>複勝</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>`;
  }

  function runCell(r) {
    if (!r) return '<td class="run none"></td>';
    const same = r.surface === race.surface && Math.abs(r.dist - race.distance) <= 200;
    return `
      <td class="run ${r.pos <= 3 ? 'r' + r.pos : ''}">
        <div class="rl"><span>${r.dateLabel} ${r.venue}</span><span>${r.pop}人気</span></div>
        <div class="rn">${esc(r.raceName)}${classTag(r.cls)}</div>
        <div class="rp"><b class="pos">${r.pos}</b><span class="sub">着/${r.field}頭</span>${r.note ? '<span class="excuse-mark" title="' + r.note + '">⚠</span>' : ''}</div>
        <div class="rt"><span class="sub">走破</span><b>${E.formatTime(r.time)}</b><span class="sub">勝ち ${E.formatTime(winTime(r))}</span></div>
        <div class="rc ${same ? 'same' : ''}">${surfShort(r.surface)}${r.dist} ${r.going} ${r.no}番</div>
        <div class="sub">${esc(r.jockey)} ${r.kinryo.toFixed(1)} ${r.weight}kg</div>
        <div>${r.passing} <span class="sub">上</span>${r.last3f.toFixed(1)}${r.last3fRank <= 3 ? `<b class="l3">${circled(r.last3fRank)}</b>` : ''}</div>
        <div class="rv">${esc(r.rival)} <span>(${r.diff.toFixed(1)})</span></div>
        ${r.note ? `<div class="excuse">⚠ ${r.note}</div>` : ''}
        ${r.sharedWith && r.sharedWith.length ? `<div class="vs" title="今回の出走馬と同じレース">対戦 ${r.sharedWith.map(v => `${v.no}番${v.pos}着`).join('・')}</div>` : ''}
      </td>`;
  }

  function renderPaper() {
    const m = race.market, mine = myHorses();
    const rows = race.horses.map((h, i) => {
      const pop = m.pop[i];
      const diff = h.bodyDiff === 0 ? '±0' : (h.bodyDiff > 0 ? '+' : '') + h.bodyDiff;
      const r = h.records;
      return `
        <tr class="${mine.has(h.no) ? 'mine' : ''}">
          <td class="info">
            <div class="ih">${waku(h.bracket)}<b class="no">${h.no}</b>
              <span class="odds ${pop <= 3 ? 'hot' : ''}">${odds1(m.winPay[i])}</span><span class="sub">${pop}人気</span></div>
            ${tipsRow(i)}
            <div class="name">${silkSwatch(h.silks)}${esc(h.name)}</div>
            <div class="sub">${h.sex}${h.age} ${h.coat} / ${h.style} / 調教<b class="train t${h.trainingGrade}">${h.trainingGrade}</b></div>
            <div>${esc(h.jockey.name)} ${h.kinryo.toFixed(1)}</div>
            <div>${h.bodyWeight}kg<span class="sub">(${diff})</span> <span class="${h.layoff >= 12 ? 'hotsub' : 'sub'}">${interval(h.layoff)}</span></div>
            <table class="recs">
              <tr><th>通算</th><td>${rec(r.all)}</td><th>当場</th><td>${rec(r.venue)}</td></tr>
              <tr><th>芝</th><td>${rec(r.turf)}</td><th>ダ</th><td>${rec(r.dirt)}</td></tr>
              <tr><th>同距離</th><td>${rec(r.dist)}</td><th>重不良</th><td>${rec(r.heavy)}</td></tr>
            </table>
          </td>
          ${h.past.length ? [0, 1, 2, 3, 4].map(k => runCell(h.past[k])).join('') : '<td class="run none debut" colspan="5"><b>初出走</b><span class="sub">(調教 ' + h.trainingGrade + ')</span></td>'}
        </tr>`;
    }).join('');
    return `
      <section class="card">
        <h2>馬柱 <small>${race.surface}${race.distance}m と同条件(同じ馬場で±200m)の走りは<span class="same">緑</span>/走破=その馬のタイム・勝ち=勝ち馬のタイム/⚠=出遅れ・不利(実力より着順が悪く出た走り)/対戦=今回の出走馬と同じレース/上がり3F の順位1〜3位は①②③/成績は 1着-2着-3着-着外/(タイム差)は勝ち馬との差・勝った時は2着馬との差</small></h2>
        ${viewTabs()}
        ${tipsterBoard()}
        <div class="tablewrap">
          <table class="paper">
            <thead><tr><th>馬</th><th>前走</th><th>2走前</th><th>3走前</th><th>4走前</th><th>5走前</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>`;
  }

  function renderBetPanel() {
    // マルチ:馬券を買えるのは発走対象のレースだけ
    if (room && save.sel !== room.target) {
      const t = targetOpen() && infoOf(room.target);
      return `
        <section class="card bet">
          <h2>投票</h2>
          <p class="hint">マルチプレイでは、ホストが選んだ「発走対象」のレースだけ馬券を買えます。</p>
          ${t ? `<button class="primary" data-race="${room.target}">発走対象 ${E.COURSES[t.venueIdx].venue}${t.raceNo}R へ</button>` : '<p class="hint">ホストが次の発走対象を選ぶのを待っています…</p>'}
          ${room.host && !rstate(save.sel).done ? '<button class="ghost settarget" data-act="mptarget">このレースを次の発走対象にする</button><p class="note">全員の「賭け終えた」が取り消されます</p>' : ''}
        </section>`;
    }
    const locked = room && myPlayer() && myPlayer().ready;
    const bt = E.BET[ui.type];
    const isBracket = bt.unit === 'bracket';
    const units = isBracket ? [...new Set(race.horses.map(h => h.bracket))] : race.horses.map(h => h.no);
    const typeBtns = E.BET_TYPES.map(b => {
      const disabled = b.unit === 'bracket' && !E.bracketSold(race);
      return `<button class="chip ${ui.type === b.key ? 'on' : ''}" data-type="${b.key}" ${disabled ? 'disabled title="8頭立て以下は発売なし"' : ''}>${b.label}</button>`;
    }).join('');
    const methodBtns = methodsFor(ui.type).map(m =>
      `<button class="chip small ${ui.method === m ? 'on' : ''}" data-method="${m}">${METHOD_LABEL[m]}</button>`).join('');
    const spec = rowSpec();
    const rows = spec.map((s, r) => `
      <div class="selrow">
        <div class="sellbl">${s.label}</div>
        <div class="selbtns">${units.map(u => {
          const on = ui.rows[r].includes(u);
          const b = isBracket ? u : race.horses[u - 1].bracket;
          const [bg] = BRACKET_COLORS[b];
          return `<button class="num ${on ? 'on' : ''}" data-row="${r}" data-val="${u}" style="--wc:${bg}">${u}</button>`;
        }).join('')}</div>
      </div>`).join('');
    const pv = preview();
    let pvHtml;
    if (!pv.ok) pvHtml = `<span class="hint">${esc(pv.msg)}</span>`;
    else {
      const n = pv.combos.length;
      const oddsTxt = n === 1 && pv.min === pv.max ? `${odds1(pv.min)}倍`
        : `${odds1(pv.min)}〜${odds1(pv.max)}倍` + (n > 1 ? ` <span class="sub">合成 ${(pv.synth / 100).toFixed(1)}倍</span>` : '');
      pvHtml = `<b>${n}点</b> × ${yen(ui.stake)} = <b>${yen(n * ui.stake)}</b><span class="sep">|</span>オッズ ${oddsTxt}`;
    }
    const cartTotal = cart.reduce((s, c) => s + c.cost, 0);
    const cartHtml = cart.length ? cart.map((t, i) => `
        <li><span class="tt">${E.BET[t.type].label}</span> ${METHOD_LABEL[t.method]} ${esc(selText(t.type, t.method, t.sel))}
          <span class="sub">${t.combos.length}点×${yen(t.stake)}</span><b>${yen(t.cost)}</b>
          <button class="x" data-rm="${i}" aria-label="削除">×</button></li>`).join('')
      : '<li class="empty">カートは空です</li>';
    const bought = curState().tickets;
    const boughtTotal = bought.reduce((s, t) => s + t.cost, 0);
    const boughtHtml = bought.length ? `
      <div class="bought">
        <h3>購入済み <small>${bought.length}件 / ${yen(boughtTotal)}</small></h3>
        <ul>${bought.map(t => `<li><span class="tt">${E.BET[t.type].label}</span> ${METHOD_LABEL[t.method]} ${esc(selText(t.type, t.method, t.sel))}
          <span class="sub">${t.combos.length}点×${yen(t.stake)}</span><b>${yen(t.cost)}</b></li>`).join('')}</ul>
      </div>` : '';
    const broke = save.bankroll < 100 && bought.length === 0 && cart.length === 0;
    return `
      <section class="card bet">
        <h2>投票</h2>
        <div class="types">${typeBtns}</div>
        <div class="methods">${methodBtns}</div>
        <div class="selrows">${rows}</div>
        <div class="stake">
          <label>1点あたり <input id="stake" type="number" min="100" step="100" value="${ui.stake}"> 円</label>
          <button class="chip small" data-stake="100">+100</button>
          <button class="chip small" data-stake="1000">+1,000</button>
          <button class="chip small" data-stake="10000">+10,000</button>
          <button class="chip small" data-stake="0">100円に戻す</button>
        </div>
        <div class="preview">${pvHtml}</div>
        <button class="primary" data-act="add" ${pv.ok && !locked ? '' : 'disabled'}>カートに追加</button>
        <div class="cart">
          <h3>カート <small>合計 ${yen(cartTotal)}</small></h3>
          <ul>${cartHtml}</ul>
          <button class="primary buy" data-act="buy" ${cart.length && !locked ? '' : 'disabled'}>購入する(${yen(cartTotal)})</button>
          <p class="note">※ 購入後の取消はできません(実際の馬券と同じ)</p>
        </div>
        ${boughtHtml}
        ${broke ? `<div class="broke">所持金が尽きました。<button class="primary" data-act="topup">追加入金 ${yen(START_MONEY)}</button></div>` : ''}
        ${room ? '' : otherBoughtHtml()}
        ${room ? `<div id="mpready">${mpReadyInner()}</div>` : postButtonHtml()}
      </section>`;
  }

  // 他のレースで買った馬券
  function otherBoughtHtml() {
    const others = openRaces().filter(r => r.key !== save.sel && rstate(r.key).tickets.length);
    if (!others.length) return '';
    return `<div class="others"><h3>ほかのレースの購入済み</h3><ul>${others.map(r => {
      const t = rstate(r.key).tickets;
      return `<li><button class="link" data-race="${r.key}">${E.COURSES[r.venueIdx].venue}${r.raceNo}R</button> <span class="sub">${E.fmtClock(r.minutes)}</span> ${t.length}件 <b>${yen(t.reduce((a, x) => a + x.cost, 0))}</b></li>`;
    }).join('')}</ul></div>`;
  }

  function postButtonHtml() {
    const tgt = targetKey();
    if (!tgt) return '';
    const info = infoOf(tgt), st = rstate(tgt);
    const skipN = openRaces().filter(r => r.minutes < info.minutes).length;
    const label = `${E.COURSES[info.venueIdx].venue}${info.raceNo}R`;
    return `<button class="post" data-act="post">🏁 ${label} 発走${st.tickets.length ? '' : '(見送り)'}</button>
      ${skipN ? `<p class="note center">馬券を買っていない前の ${skipN} レースは自動スキップします</p>` : ''}
      ${tgt !== save.sel ? `<p class="note center">いま表示中のレースではなく、時刻順で次に${st.tickets.length ? '馬券を買った' : '発走する'}レースが走ります</p>` : ''}`;
  }

  function renderProgram() {
    const sch = schedule(), next = nextKey();
    const rows = sch.venues.map(v => {
      const list = sch.races.filter(r => r.venueIdx === v).sort((a, b) => a.raceNo - b.raceNo);
      if (!list.length) return '';
      return `<div class="prow"><span class="pvn">${E.COURSES[v].venue}</span><div class="pchips">${list.map(r => {
        const st = rstate(r.key), hd = header(r);
        const cls = [st.done ? 'done' : '', st.tickets.length ? 'bought' : '', r.key === save.sel ? 'sel' : '', r.key === next ? 'next' : '', room && r.key === room.target ? 'target' : ''].join(' ');
        const title = `${E.fmtClock(r.minutes)} ${hd.name}(${hd.cls.name}) ${hd.surface}${hd.distance}m ${hd.n}頭` + (st.done ? ` / 1着 ${st.winnerNo}番 ${st.winner}${st.skipped ? '(自動スキップ)' : ''}` : '');
        const mark = hd.cls.grade ? `<i class="g g${hd.cls.key.slice(1)}">${hd.cls.name}</i>` : '';
        return `<button class="pc ${cls}" data-race="${r.key}" title="${esc(title)}"><b>${r.raceNo}R</b>${mark}<small>${st.done ? `1着 ${st.winnerNo}` : E.fmtClock(r.minutes)}</small></button>`;
      }).join('')}</div></div>`;
    }).join('');
    const done = sch.races.filter(r => rstate(r.key).done).length;
    return `
      <section class="card program">
        <div class="ph"><h2>${header(sch.races[0]).dateLabel} <small>${graded() ? `重賞のみ(${sch.venues.map(v => E.COURSES[v].venue).join('・')}開催の重賞)` : `${sch.venues.map(v => E.COURSES[v].venue).join('・')} 3場開催`} / ${done}/${sch.races.length} レース確定</small></h2>
          <div class="legend">${room ? '<span class="pc target">発走対象</span>' : '<span class="pc next">次</span>'}<span class="pc bought">購入済</span><span class="pc done">確定</span><span class="pc sel">表示中</span></div></div>
        ${rows}
      </section>`;
  }

  function renderDayEnd() {
    const sch = schedule();
    const played = save.history.filter(h => h.day === save.meet.day);
    const spent = played.reduce((a, h) => a + h.wagered, 0), back = played.reduce((a, h) => a + h.returned, 0);
    return `
      <section class="card dayend">
        <h2>本日の${graded() ? '重賞' : ''}全 ${sch.races.length} レースが終了しました</h2>
        <p>購入したレース ${played.filter(h => h.wagered > 0).length} / 購入 ${yen(spent)} / 払戻 ${yen(back)} / 収支 <b class="${back - spent >= 0 ? 'plus' : 'minus'}">${signedYen(back - spent)}</b></p>
        ${!room || room.host || room.pendingDay > save.meet.day ? '<button class="primary" data-act="nextday">翌開催日へ ▶</button>'
          : '<p class="hint">ホストが翌開催日へ進めるのを待っています…</p>'}
      </section>`;
  }

  function renderResult() {
    const mine = myHorses();
    const fastest = Math.min(...result.rows.map(r => r.last3f));
    const rows = result.rows.map(r => {
      const h = race.horses[r.no - 1];
      return `
        <tr class="${mine.has(r.no) ? 'mine' : ''} ${r.rank <= 3 ? 'top' + r.rank : ''}">
          <td class="rk">${r.rank}</td><td>${waku(h.bracket)}</td><td class="no">${r.no}</td>
          <td class="hn"><div class="name">${esc(h.name)}</div><div class="sub">${h.sex}${h.age} ${esc(h.jockey.name)}</div></td>
          <td>${E.formatTime(r.time)}</td><td>${r.margin}</td><td>${r.passing}</td>
          <td class="${Math.abs(r.last3f - fastest) < 0.05 ? 'fast' : ''}">${r.last3f.toFixed(1)}</td>
          <td>${odds1(race.market.winPay[r.no - 1])}</td><td>${race.market.pop[r.no - 1]}</td>
          <td class="sub">${r.notes.join(' ')}</td>
        </tr>`;
    }).join('');
    const p = result.payouts;
    const payRows = E.BET_TYPES.map(b => {
      const list = p[b.key];
      if (!list) return `<tr><th>${b.label}</th><td colspan="2" class="sub">発売なし</td></tr>`;
      return list.map((x, i) => `<tr>${i === 0 ? `<th rowspan="${list.length}">${b.label}</th>` : ''}
        <td>${x.combo.join(b.ordered ? '→' : '-')}</td><td class="pay">${yen(x.pay)}</td></tr>`).join('');
    }).join('');
    const st = curState();
    const tickets = st.tickets;
    const spent = tickets.reduce((s, t) => s + t.cost, 0);
    const back = tickets.reduce((s, t) => s + (t.ret || 0), 0);
    const tHtml = tickets.length ? tickets.map(t => `
      <li class="${t.ret ? 'hit' : ''}"><span class="tt">${E.BET[t.type].label}</span> ${METHOD_LABEL[t.method]} ${esc(selText(t.type, t.method, t.sel))}
        <span class="sub">${t.combos.length}点×${yen(t.stake)}</span>
        ${t.ret ? `<b class="hitlbl">的中 ${yen(t.ret)}</b>` : '<span class="sub">不的中</span>'}</li>`).join('')
      : `<li class="empty">${st.skipped ? 'このレースは自動スキップしました(馬券なし)' : 'このレースは見送りました'}</li>`;
    const winner = race.horses[result.order[0] - 1];
    return `
      <section class="card result">
        <h2>確定 <small>${raceLabel(race)} ${esc(race.name)} / 勝ち馬 ${esc(winner.name)}</small></h2>
        <div class="laps">前半3F <b>${result.first3f.toFixed(1)}</b> ― 後半3F <b>${result.final3f.toFixed(1)}</b>
          <span class="pace p${result.pace}">${{ H: 'ハイペース', M: '平均ペース', S: 'スローペース' }[result.pace]}</span></div>
        <div class="tablewrap">
          <table class="entries">
            <thead><tr><th>着</th><th>枠</th><th>馬番</th><th>馬名</th><th>タイム</th><th>着差</th><th>通過</th><th>上り</th><th>単勝</th><th>人気</th><th>備考</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>
      <div class="cols">
        <section class="card">
          <h2>払戻金 <small>100円あたり</small></h2>
          <table class="payouts">${payRows}</table>
        </section>
        <section class="card">
          <h2>あなたの馬券</h2>
          <ul class="mytickets">${tHtml}</ul>
          <div class="settle">購入 ${yen(spent)} / 払戻 <b>${yen(back)}</b> / 収支
            <b class="${back - spent >= 0 ? 'plus' : 'minus'}">${signedYen(back - spent)}</b></div>
          <div class="actions">
            <button class="ghost" data-act="replay">リプレイ</button>
            <button class="primary" data-act="next">次のレースへ ▶</button>
          </div>
        </section>
      </div>
      ${room ? `<section class="card mpresult"><h2>プレイヤーの成績</h2><div id="mpresult">${mpResultInner()}</div></section>` : ''}`;
  }

  function renderHistory() {
    if (!showHistory) return '';
    const rows = save.history.map(h => `
      <tr><td>${esc(h.label)}</td><td>${esc(h.name)}</td><td>${esc(h.winner)}</td><td>${yen(h.wagered)}</td><td>${yen(h.returned)}</td>
      <td class="${h.returned - h.wagered >= 0 ? 'plus' : 'minus'}">${signedYen(h.returned - h.wagered)}</td></tr>`).join('');
    const st = save.stats;
    return `
      <div class="modal" data-act="closehist">
        <div class="modalbox" role="dialog" aria-label="履歴">
          <h2>履歴 <small>${st.races}レース / 的中 ${st.hitRaces}レース / 追加入金 ${save.topups}回</small></h2>
          <div class="tablewrap"><table class="entries">
            <thead><tr><th>レース</th><th>レース名</th><th>勝ち馬</th><th>購入</th><th>払戻</th><th>収支</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="6" class="sub">まだありません</td></tr>'}</tbody>
          </table></div>
          <button class="primary" data-act="closehist">閉じる</button>
        </div>
      </div>`;
  }

  function renderRaceView() {
    const r = race;
    return `
      <section class="card raceview ${save.side ? 'withside' : ''}" id="raceview">
        <div class="rvmain">
          <div class="tv">
            <canvas id="tv"></canvas>
            <div class="tv-top">
              <div class="tv-title"><span class="tv-venue">${r.venue}${r.raceNo}R</span>${esc(r.name)}<span class="tv-cond">${r.surface}${r.distance}m ${r.going}</span></div>
              <div class="tv-clock" id="rvTime">0.0</div>
            </div>
            <div class="tv-seg" id="tvSeg"></div>
            <div class="tv-remain" id="rvRemain"></div>
            <canvas id="oval" class="tv-map"></canvas>
            <div class="tv-board" id="tvBoard" hidden></div>
            <div class="tv-fanfare" id="tvFan" hidden>
              <div class="fan-grade g${r.cls.grade ? r.cls.key.slice(1) : ''}">${r.cls.name}</div>
              <div class="fan-name">${esc(r.name)}</div>
              <div class="fan-cond">${r.venue} ${r.surface}${r.distance}m ${r.n}頭 / ${r.postTime} 発走</div>
              <div class="fan-note">♪ ファンファーレ</div>
            </div>
            <div class="tv-sub" id="tvSub"></div>
            <div class="tv-ticker" id="tvTicker"></div>
          </div>
          <div class="rvtop">
            <div class="speed">${[1, 2, 4, 8].map(s => `<button class="chip small ${save.speed === s ? 'on' : ''}" data-speed="${s}">×${s}</button>`).join('')}
              <button class="chip small" data-act="skip">スキップ ⏭</button></div>
            <div class="rvbtns">
              <button class="chip small ${save.sound ? 'on' : ''}" data-act="sound" id="soundBtn">${save.sound ? '🔊 音あり' : '🔇 音なし'}</button>
              ${KeibaSound.canSpeak ? `<button class="chip small ${save.voice ? 'on' : ''}" data-act="voice" id="voiceBtn">${save.voice ? '🎙 実況の声あり' : '🎙 実況の声なし'}</button>` : ''}
              ${voiceSelectHtml()}
              <button class="chip small ${save.side ? 'on' : ''}" data-act="side" id="sideBtn">出馬表</button>
              <span class="sub">カメラ: <span id="tvShot"></span></span>
            </div>
          </div>
          <div class="rvbottom">
            <ol id="rank" class="rank"></ol>
            <ul id="comment" class="comment"></ul>
          </div>
        </div>
        <aside class="rvside">${sideCardHtml()}</aside>
      </section>`;
  }

  // 実況の声の選択(この端末で使える日本語の声。人の声に近いものが既定)
  function voiceSelectHtml() {
    const list = KeibaSound.canSpeak ? KeibaSound.voices() : [];
    if (list.length < 2) return '';
    const cur = KeibaSound.voiceName;
    return `<select id="voiceSel" class="voicesel" title="実況の声">${list.map(n => `<option ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  }

  // レース中に横で見る出馬表(印・オッズ・現在の順位・自分の馬券)
  function sideCardHtml() {
    const m = race.market, mine = myHorses();
    const rows = race.horses.map((h, i) => `
      <tr class="${mine.has(h.no) ? 'mine' : ''}">
        <td>${waku(h.bracket, 'mini')}</td><td class="no">${h.no}</td>
        <td class="tipsmini">${tipMarks(i).map((mk, k) => `<i class="m${markClass(mk)}" title="${TIPS[k].name}">${mk || '・'}</i>`).join('')}</td>
        <td class="hn"><div class="name">${esc(h.name)}</div><div class="sub jk">${esc(h.jockey.name)} ${h.style}</div></td>
        <td class="odds ${m.pop[i] <= 3 ? 'hot' : ''}">${odds1(m.winPay[i])}<div class="sub">${m.pop[i]}人気</div></td>
        <td class="now" id="sc-now-${h.no}">—</td>
      </tr>`).join('');
    const tickets = save.sel ? curState().tickets : [];
    const tk = tickets.length
      ? tickets.map(t => `<li>${E.BET[t.type].label}${t.method !== 'normal' ? ' ' + METHOD_LABEL[t.method] : ''} <b>${esc(selText(t.type, t.method, t.sel))}</b> <span class="sub">${t.combos.length}点 ${yen(t.cost)}</span></li>`).join('')
      : '<li class="sub">馬券なし(見送り)</li>';
    return `
      <div class="side-h">出馬表 <span class="sub">印:${TIPS.map(t => t.short[0]).join('')}=${TIPS.map(t => t.short).join('・')}</span></div>
      <div class="side-scroll"><table class="sidecard">
        <thead><tr><th>枠</th><th>番</th><th>印</th><th>馬名/騎手</th><th>単勝</th><th>位置</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <div class="side-h">購入した馬券</div>
      <ul class="side-tickets">${tk}</ul>`;
  }

  function skipNoteHtml() {
    const list = save.sel ? curState().skippedBefore : null;
    if (!list || !list.length) return '';
    return `<div class="skipnote">⏭ 馬券を買っていない ${list.length} レースを自動スキップしました:${list.join('・')}<span class="sub">(結果は番組表から見られます)</span></div>`;
  }

  function render() {
    const app = $('#app');
    if (mode === 'multi' && !room) {
      app.innerHTML = `<div class="shell">${renderHeader()}<div class="fill"><div class="scrollpane">${renderLobby()}</div></div></div>` + renderStats();
      return;
    }
    if (!save || !save.meet || !world) return;
    // デスクトップでは画面の高さにぴったり収め、長い中身(馬柱・投票・結果)はそれぞれの枠の中でスクロールする
    let body;
    if (anim) body = `<div class="fill race-mode">${renderRaceInfo()}${skipNoteHtml()}${renderRaceView()}</div>`;
    else if (!race) body = renderProgram() + `<div class="fill">${renderDayEnd()}</div>`;
    else if (curState().done) body = renderProgram() + `<div class="fill result-mode">${renderRaceInfo()}${skipNoteHtml()}<div class="scrollpane">${renderResult()}</div></div>`;
    else body = renderProgram() + `<div class="fill card-mode">${renderRaceInfo()}<div class="layout">${renderCard()}${renderBetPanel()}</div></div>`;
    const bar = room && !anim ? `<div class="mpbar" id="mpbar">${mpBarInner()}</div>` : '';
    app.innerHTML = `<div class="shell">${renderHeader()}${bar}${body}</div>` + renderHistory() + renderStats();
    if (anim) setupCanvases();
  }

  // ---------- 操作 ----------
  function addToCart() {
    try {
      const t = E.createTicket(race, { type: ui.type, method: ui.method, sel: buildSel(), stake: ui.stake });
      cart.push(t);
      ui.rows = rowSpec().map(() => []);
    } catch (e) { alert(e.message); }
    render();
  }
  function buy() {
    const total = cart.reduce((s, c) => s + c.cost, 0);
    if (total > save.bankroll) { alert(`所持金が足りません(必要 ${yen(total)} / 所持 ${yen(save.bankroll)})`); return; }
    save.bankroll -= total;
    save.stats.wagered += total;
    curState().tickets.push(...cart.map(t => ({ id: t.id, type: t.type, method: t.method, sel: t.sel, combos: t.combos, stake: t.stake, cost: t.cost })));
    cart = [];
    persist();
    render();
  }
  // 馬券の精算(所持金・このモードの成績・履歴・総成績)
  function settle(st, r, res) {
    let back = 0, spent = 0;
    for (const t of st.tickets) {
      t.ret = E.ticketReturn(t, res.payouts).total;
      back += t.ret; spent += t.cost;
    }
    const winner = r.horses[res.order[0] - 1].name;
    save.bankroll += back;
    save.stats.returned += back;
    save.stats.races++;
    if (back > 0) save.stats.hitRaces++;
    save.history.unshift({ day: r.day, label: raceLabel(r), name: r.name, winner, wagered: spent, returned: back });
    save.history = save.history.slice(0, 200);
    addLifetime(st.tickets, `${r.dateLabel} ${raceLabel(r)}`, r.name);
    return { spent, back, winner };
  }
  // 発走。forceKey はマルチで全員そろった時に走らせるレース(それ以外は馬券を買った最も早いレース)
  function post(forceKey) {
    if (!forceKey && cart.length && !confirm('カートに未購入の馬券があります。破棄して発走しますか?')) return;
    cart = [];
    const tgt = forceKey || targetKey();
    if (!tgt || !infoOf(tgt) || rstate(tgt).done) return;
    const tinfo = infoOf(tgt);
    // 時刻順でそれより前の未発走レースは結果だけ確定させて飛ばす(馬券があれば精算する)
    const skipped = [];
    for (const r of schedule().races) {
      if (r.minutes >= tinfo.minutes) break;
      const st = rstate(r.key);
      if (st.done) continue;
      const lr = st.tickets.length ? E.generateRace(raceOpts(r)) : header(r), res = E.runRace(lr);
      finishRace(r.key, lr, res);
      if (st.tickets.length) settle(st, lr, res);
      Object.assign(st, { done: true, skipped: true, winnerNo: res.order[0], winner: lr.horses[res.order[0] - 1].name });
      skipped.push(`${lr.venue}${r.raceNo}R`);
    }
    if (tgt !== save.sel || !race) {
      save.sel = tgt;
      race = E.generateRace(raceOpts(tinfo));
    }
    const st = curState();
    st.skippedBefore = skipped;
    result = E.runRace(race);
    finishRace(tgt, race, result);
    const { spent, back, winner } = settle(st, race, result);
    Object.assign(st, { done: true, winnerNo: result.order[0], winner });
    recordTipsters();
    persist();
    if (room) reportScore(tgt, spent, back);
    startAnim(back);
  }

  document.addEventListener('click', e => {
    const el = e.target.closest('button, .modal');
    if (!el || el.disabled) return;
    if (el.classList.contains('modal') && e.target !== el) return;
    const d = el.dataset;
    if (d.mode) { switchMode(d.mode); return; }
    if (d.mpstyle) { ui.mpStyle = d.mpstyle; render(); return; }
    if (d.race) { if (!anim) selectRace(d.race); return; }
    if (d.view) { save.view = d.view; persist(); render(); return; }
    if (d.type) { setType(d.type); render(); return; }
    if (d.method) { setMethod(d.method); render(); return; }
    if (d.row != null) {
      const r = +d.row, v = +d.val, spec = rowSpec()[r], row = ui.rows[r];
      const i = row.indexOf(v);
      if (i >= 0) row.splice(i, 1);
      else if (spec.single) ui.rows[r] = [v];
      else {
        if (spec.max && row.length >= spec.max) row.shift();
        row.push(v);
      }
      render();
      return;
    }
    if (d.stake != null) { ui.stake = +d.stake === 0 ? 100 : Math.min(ui.stake + +d.stake, 1000000); render(); return; }
    if (d.rm != null) { cart.splice(+d.rm, 1); render(); return; }
    if (d.speed) { save.speed = +d.speed; persist(); KeibaSound.setPace(save.speed); document.querySelectorAll('[data-speed]').forEach(b => b.classList.toggle('on', +b.dataset.speed === save.speed)); return; }
    switch (d.act) {
      case 'add': addToCart(); break;
      case 'buy': buy(); break;
      case 'post': post(); break;
      case 'skip': if (anim) { anim.skipped = true; anim.T = anim.endT; KeibaSound.stop(); KeibaSound.hush(); step(performance.now()); } break;
      case 'sound':
        save.sound = !save.sound; persist(); KeibaSound.setEnabled(save.sound);
        el.classList.toggle('on', save.sound); el.textContent = save.sound ? '🔊 音あり' : '🔇 音なし';
        break;
      case 'voice':
        save.voice = !save.voice; persist(); KeibaSound.setVoice(save.voice);
        el.classList.toggle('on', save.voice); el.textContent = save.voice ? '🎙 実況の声あり' : '🎙 実況の声なし';
        break;
      case 'side': {
        save.side = !save.side; persist();
        el.classList.toggle('on', save.side);
        const rv = $('#raceview');
        if (rv) { rv.classList.toggle('withside', save.side); if (tv) { tv.resize(); setupOval(); } }
        break;
      }
      case 'replay': startAnim(); break;
      case 'next':
        if (room) nextInRoom();
        else selectRace(nextKey());
        break;
      case 'nextday':
        // その日の結果を記録して翌日へ(データベースは記録済み。次の出馬表は翌日の分から作る)
        if (room) nextDayInRoom();
        else { advanceDay(); persist(); selectRace(nextKey()); }
        break;
      case 'history': showHistory = true; render(); break;
      case 'closehist': showHistory = false; render(); break;
      case 'stats': showStats = true; render(); break;
      case 'closestats': showStats = false; render(); break;
      case 'export': exportData(); break;
      case 'import': $('#importFile').click(); break;
      case 'resetstats':
        if (confirm('総成績(全モード通算)をリセットしますか?各モードの所持金・開催はそのままです。')) {
          const name = profile.name;
          lsSet(PROFILE_KEY, JSON.stringify({ v: 1, name, since: Date.now(), total: blankRec(), byMode: {}, byType: {}, best: null, bestOdds: null, topups: 0, resets: 0, curve: [] }));
          profile = loadProfile(); render();
        }
        break;
      case 'topup': save.bankroll += START_MONEY; save.topups++; profile.topups++; saveProfile(); persist(); if (room) reportScore(); render(); break;
      case 'reset':
        if (confirm(`${MODE_LABEL[mode]}モードの所持金・履歴・開催をリセットしますか?(総成績は残ります)`)) {
          const prefs = Object.fromEntries(PREF_FIELDS.filter(k => save[k] !== undefined).map(k => [k, save[k]]));
          save = { ...defaultSave(), ...prefs };
          profile.resets++; saveProfile();
          startWorld(() => selectRace(nextKey()));
        }
        break;
      case 'mpcreate': createRoom(); break;
      case 'mpjoin': joinRoom(($('#mpCode') || {}).value); break;
      case 'mpleave': if (leaveRoom(true)) render(); break;
      case 'mpready': setReady(true); break;
      case 'mpunready': setReady(false); break;
      case 'mpforce': if (room && room.host && confirm('準備ができていないプレイヤーを待たずに発走しますか?')) startRoomRace(); break;
      case 'mptarget': if (room && room.host) setTarget(save.sel); break;
      case 'copycode':
        try { navigator.clipboard.writeText(room.code); el.textContent = 'コピーしました'; } catch (err) { /* 表示だけ */ }
        break;
    }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'importFile') { importData(e.target.files[0]); e.target.value = ''; return; }
    if (e.target.classList.contains('pname')) {
      profile.name = cleanName(e.target.value); saveProfile();
      const p = myPlayer();
      if (p && room.host && profile.name) { p.name = profile.name; syncPlayers(); }
      return;
    }
    if (e.target.id === 'voiceSel') {
      save.voiceName = e.target.value; persist(); KeibaSound.setVoiceName(save.voiceName);
      KeibaSound.speak('この声で実況します。');
      return;
    }
    if (e.target.id === 'stake') {
      const v = Math.floor((+e.target.value || 0) / 100) * 100;
      ui.stake = Math.max(100, Math.min(v, 1000000));
      render();
    }
  });

  // ---------- 総成績(このブラウザの全モード通算) ----------
  const pct = (a, b, d = 0) => (b ? (a / b * 100).toFixed(d) + '%' : '—');
  const man = v => (Math.abs(v) >= 10000 ? (v > 0 ? '+' : v < 0 ? '-' : '') + (Math.abs(v) / 10000).toFixed(Math.abs(v) >= 1e6 ? 0 : 1) + '万' : signedYen(v));
  function recRow(label, x) {
    x = x || blankRec();
    const pl = x.r - x.w;
    return `<tr><th>${label}</th><td>${x.n.toLocaleString()}</td><td>${pct(x.hit, x.n)}</td><td>${yen(x.w)}</td><td>${yen(x.r)}</td>
      <td class="${!x.n ? '' : pl >= 0 ? 'plus' : 'minus'}">${signedYen(pl)}</td><td>${pct(x.r, x.w, 1)}</td></tr>`;
  }
  // 通算収支の推移(馬券を買ったレースごと。ホバーで値)
  let curveState = null;
  function curveSvg(c) {
    if (c.length < 2) { curveState = null; return '<p class="hint">馬券を買ったレースが 2 つ以上になると、通算収支の推移を表示します。</p>'; }
    const W = 900, H = 170, pad = { l: 58, r: 12, t: 12, b: 12 };
    const lo = Math.min(0, ...c), hi = Math.max(0, ...c), span = hi - lo || 1;
    const x = i => pad.l + i / (c.length - 1) * (W - pad.l - pad.r);
    const y = v => pad.t + (hi - v) / span * (H - pad.t - pad.b);
    const n0 = profile.total.n - c.length;
    curveState = { c, x, y, n0, W, pad };
    const last = c[c.length - 1];
    return `
      <div class="curve" id="curve">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="通算収支の推移(直近 ${c.length} レース、最新 ${signedYen(last)})">
          <line class="zero" x1="${pad.l}" x2="${W - pad.r}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>
          <text class="ax" x="${pad.l - 6}" y="${(y(hi) + 4).toFixed(1)}" text-anchor="end">${man(hi)}</text>
          ${lo < 0 && hi > 0 ? `<text class="ax" x="${pad.l - 6}" y="${(y(0) + 4).toFixed(1)}" text-anchor="end">0</text>` : ''}
          <text class="ax" x="${pad.l - 6}" y="${(y(lo) + 4).toFixed(1)}" text-anchor="end">${man(lo)}</text>
          <polyline class="ln" points="${c.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>
          <line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
          <circle class="dot" r="4" cx="${x(c.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}"/>
        </svg>
        <div class="ctip" hidden></div>
      </div>
      <p class="note">直近 ${c.length} レース(馬券を買ったレース)の通算収支。最新 <b class="${last >= 0 ? 'plus' : 'minus'}">${signedYen(last)}</b></p>`;
  }
  function curveHover(e) {
    const box = e.target.closest && e.target.closest('#curve');
    if (!curveState) return;
    const all = document.getElementById('curve');
    if (!all) return;
    const cross = all.querySelector('.cross'), dot = all.querySelector('.dot'), tip = all.querySelector('.ctip');
    const { c, x, y, n0, W, pad } = curveState;
    if (!box) { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; dot.setAttribute('cx', x(c.length - 1)); dot.setAttribute('cy', y(c[c.length - 1])); return; }
    const r = all.querySelector('svg').getBoundingClientRect();
    const vx = (e.clientX - r.left) / r.width * W;
    const i = Math.max(0, Math.min(c.length - 1, Math.round((vx - pad.l) / (W - pad.l - pad.r) * (c.length - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(c[i]));
    tip.hidden = false;
    tip.innerHTML = `${(n0 + i + 1).toLocaleString()}レース目<br><b class="${c[i] >= 0 ? 'plus' : 'minus'}">${signedYen(c[i])}</b>`;
    const px = x(i) / W * r.width;
    tip.style.left = Math.min(r.width - 120, Math.max(0, px + 10)) + 'px';
  }
  document.addEventListener('mousemove', curveHover);

  function renderStats() {
    if (!showStats) return '';
    const P = profile, t = P.total, pl = t.r - t.w;
    const tile = (lbl, val, cls = '') => `<div class="tile"><span class="lbl">${lbl}</span><b class="${cls}">${val}</b></div>`;
    const best = P.best ? `<b>${yen(P.best.ret)}</b> <span class="sub">${esc(P.best.label)} ${esc(P.best.name)}(購入 ${yen(P.best.spent)})</span>` : '<span class="sub">まだありません</span>';
    const bo = P.bestOdds ? `<b>${P.bestOdds.x.toFixed(1)}倍</b> <span class="sub">${E.BET[P.bestOdds.type].label} ${esc(P.bestOdds.sel)} ${yen(P.bestOdds.cost)} → ${yen(P.bestOdds.ret)} / ${esc(P.bestOdds.label)}</span>` : '<span class="sub">まだありません</span>';
    const head = k => `<thead><tr><th></th><th>${k}</th><th>的中率</th><th>購入</th><th>払戻</th><th>収支</th><th>回収率</th></tr></thead>`;
    return `
      <div class="modal" data-act="closestats">
        <div class="modalbox stats" role="dialog" aria-label="総成績">
          <h2>総成績 <small>このブラウザでの全モード通算(${new Date(P.since).toLocaleDateString('ja-JP')} から)。モードのリセットでは消えません</small></h2>
          <label class="pname-l">プレイヤー名 <input class="pname" id="pName" maxlength="12" value="${esc(P.name)}" placeholder="マルチプレイで表示する名前"></label>
          <div class="tiles">
            ${tile('収支', signedYen(pl), pl >= 0 ? 'plus' : 'minus')}
            ${tile('回収率', pct(t.r, t.w, 1))}
            ${tile('的中率', pct(t.hit, t.n))}
            ${tile('購入レース', t.n.toLocaleString())}
            ${tile('購入合計', yen(t.w))}
            ${tile('払戻合計', yen(t.r))}
          </div>
          <div class="bests">
            <div><span class="lbl">最高払戻(1 レース)</span> ${best}</div>
            <div><span class="lbl">最高倍率の的中(払戻÷購入)</span> ${bo}</div>
            <div class="sub">追加入金 ${P.topups} 回 / モードのリセット ${P.resets} 回</div>
          </div>
          <h3>通算収支の推移</h3>
          ${curveSvg(P.curve)}
          <div class="cols2">
            <div><h3>モード別</h3><div class="tablewrap"><table class="entries rec">${head('レース')}<tbody>
              ${Object.keys(MODE_LABEL).map(m => recRow(MODE_LABEL[m], P.byMode[m])).join('')}</tbody></table></div></div>
            <div><h3>券種別</h3><div class="tablewrap"><table class="entries rec">${head('件数')}<tbody>
              ${E.BET_TYPES.map(b => recRow(b.label, P.byType[b.key])).join('')}</tbody></table></div></div>
          </div>
          <h3>セーブデータ</h3>
          <p class="note">所持金・開催・総成績はこのブラウザに自動で保存されています。別のブラウザやパソコンに移すときや、控えを取るときは書き出してください。</p>
          <div class="savebtns">
            <button class="ghost" data-act="export">⬇ セーブデータを書き出す</button>
            <button class="ghost" data-act="import">⬆ セーブデータを読み込む</button>
            <button class="ghost danger" data-act="resetstats">総成績をリセット</button>
            <input type="file" id="importFile" accept="application/json,.json" hidden>
          </div>
          <button class="primary" data-act="closestats">閉じる</button>
        </div>
      </div>`;
  }

  // ---------- セーブデータの書き出し・読み込み ----------
  function collectData() {
    persist(); saveProfile();
    const data = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('keiba-sim')) data[k] = localStorage.getItem(k);
      }
    } catch (e) { /* 保存領域が使えない */ }
    return { app: 'keiba-sim', v: 1, exported: new Date().toISOString(), data };
  }
  function exportData() {
    const j = collectData();
    const d = new Date(), ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(j)], { type: 'application/json' }));
    a.download = `keiba-sim-save-${ymd}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return j;
  }
  function importData(file) {
    if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
      let j;
      try { j = JSON.parse(rd.result); } catch (e) { j = null; }
      if (!j || j.app !== 'keiba-sim' || !j.data || typeof j.data !== 'object') { alert('KEIBA SIM のセーブデータではありません'); return; }
      if (!confirm('読み込むと、このブラウザのセーブデータ(全モードと総成績)を置き換えます。よろしいですか?')) return;
      applyImport(j);
    };
    rd.readAsText(file);
  }
  function applyImport(j) {
    if (room) leaveRoom(false);
    try {
      const old = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('keiba-sim')) old.push(k); }
      old.forEach(k => localStorage.removeItem(k));
      for (const [k, v] of Object.entries(j.data)) if (k.startsWith('keiba-sim') && typeof v === 'string') localStorage.setItem(k, v);
    } catch (e) { alert('保存領域に書き込めませんでした'); return; }
    save = null; // 読み込んだデータを上書きしないように
    location.reload();
  }

  // ---------- マルチプレイ ----------
  // ホストが発走させるレース(発走対象)を選び、全員が「賭け終えた」を押すと全員の画面で同時に発走する。
  // 結果はシードで決まるので、送るのは「どのレースを走らせるか」だけ。各自の画面で同じ着順になる。
  // 参加した時は、ホストの開催の記録(過去の開催日の結果と今日の確定分)を受け取ってデータベースを作り直す。
  const cleanName = v => String(v || '').replace(/[<>&"'`]/g, '').trim().slice(0, 12);
  const playerName = () => profile.name || 'ゲスト';
  const myPlayer = () => room && room.players.find(p => p.id === room.me);
  const targetOpen = () => room && room.target && infoOf(room.target) && !rstate(room.target).done;

  function renderLobby() {
    const st = ui.mpStyle;
    return `
      <section class="card lobby">
        <h2>マルチプレイ</h2>
        <p>同じレースに全員で賭けて、全員が「賭け終えた」を押すと一斉に発走します。所持金は各自 ${yen(START_MONEY)} から。成績は総成績の「マルチ」にも記録されます。</p>
        <label class="pname-l">あなたの名前 <input class="pname" id="mpName" maxlength="12" value="${esc(profile.name)}" placeholder="例:たろう"></label>
        ${ui.busy ? `<p class="busy"><span class="spinner small"></span>${esc(ui.busy)}</p>` : ''}
        ${ui.lobbyError ? `<p class="error">${esc(ui.lobbyError)}</p>` : ''}
        <div class="lobbycols">
          <div class="lobbybox">
            <h3>ルームを作る</h3>
            <div class="types">${['normal', 'graded'].map(m => `<button class="chip ${st === m ? 'on' : ''}" data-mpstyle="${m}">${MODE_LABEL[m]}</button>`).join('')}</div>
            <p class="note">${st === 'graded' ? '重賞レースだけを順に遊びます(1 日 1〜3 レース)。' : '1 日 3 場 36 レース。発走させるレースはホストが選びます。'}</p>
            <button class="primary" data-act="mpcreate" ${ui.busy ? 'disabled' : ''}>ルームを作る</button>
            <p class="note">作るとルームコード(英数字 5 文字)が出ます。参加する人に伝えてください。</p>
          </div>
          <div class="lobbybox">
            <h3>ルームに参加</h3>
            <input id="mpCode" class="code" maxlength="5" placeholder="ABCDE" autocomplete="off" spellcheck="false">
            <button class="primary" data-act="mpjoin" ${ui.busy ? 'disabled' : ''}>参加する</button>
            <p class="note">ホストから聞いたルームコードを入れてください。</p>
          </div>
        </div>
        <p class="note">※ ${KeibaNet.LOCAL ? 'テスト用:同じブラウザ内のタブ同士でつなぎます' : '接続の仲介に PeerJS の公開サーバーを使い、つながった後はブラウザ同士で直接やりとりします。会社や学校のネットワークでは接続できないことがあります'}。ホストがページを閉じるとルームは終わります。</p>
      </section>`;
  }

  function mpBarInner() {
    const ps = room.players.slice().sort((a, b) => b.bankroll - a.bankroll);
    const t = room.target && infoOf(room.target);
    return `
      <span class="mpcode">ルーム <b>${room.code}</b><button class="chip small" data-act="copycode">コピー</button></span>
      <span class="sub">${MODE_LABEL[room.style]}${room.host ? '・あなたがホスト' : ''}${t && targetOpen() ? `・発走対象 ${E.COURSES[t.venueIdx].venue}${t.raceNo}R` : ''}</span>
      ${room.closed ? '<b class="minus">ホストとの接続が切れました</b>' : ''}
      <span class="mplist">${ps.map(p => `<span class="mpp ${p.ready ? 'ready' : ''} ${p.id === room.me ? 'me' : ''}" title="${p.ready ? '賭け終えた' : '検討中'}">${p.ready ? '✅' : '⏳'} ${esc(p.name)} <b>${yen(p.bankroll)}</b> <small class="${p.pl >= 0 ? 'plus' : 'minus'}">${signedYen(p.pl)}</small></span>`).join('')}</span>
      <button class="ghost" data-act="mpleave">${room.host ? 'ルームを閉じる' : '退出'}</button>`;
  }
  function mpReadyInner() {
    const p = myPlayer();
    if (!p || room.closed) return '<p class="hint">ホストとの接続が切れました。上の「退出」からロビーに戻れます。</p>';
    const n = room.players.length, k = room.players.filter(x => x.ready).length, bought = curState().tickets.length;
    return `${p.ready
      ? '<button class="post ready" data-act="mpunready">✅ 賭け終えました(取り消す)</button>'
      : `<button class="post" data-act="mpready">🏁 賭け終えた${bought ? '' : '(見送り)'}</button>`}
      <p class="note center">${k}/${n} 人が賭け終えました。全員そろうと発走します</p>
      ${room.host && k < n ? '<button class="ghost wide" data-act="mpforce">待たずに発走</button>' : ''}`;
  }
  function mpResultInner() {
    const ps = room.players.slice().sort((a, b) => b.bankroll - a.bankroll);
    return `<table class="entries mpres"><thead><tr><th>順位</th><th>プレイヤー</th><th>このレース(購入→払戻)</th><th>所持金</th><th>ルーム収支</th></tr></thead><tbody>${ps.map((p, i) => {
      const l = p.last && p.last.key === save.sel && p.last.day === save.meet.day ? p.last : null;
      const now = l ? (l.spent ? `${yen(l.spent)} → <b class="${l.back - l.spent >= 0 ? 'plus' : 'minus'}">${yen(l.back)}</b>` : '<span class="sub">見送り</span>') : '<span class="sub">—</span>';
      return `<tr class="${p.id === room.me ? 'mine' : ''}"><td>${i + 1}</td><td>${esc(p.name)}</td><td>${now}</td><td>${yen(p.bankroll)}</td><td class="${p.pl >= 0 ? 'plus' : 'minus'}">${signedYen(p.pl)}</td></tr>`;
    }).join('')}</tbody></table>`;
  }
  // 中継中以外の画面にある参加者の表示だけを書き換える(馬柱のスクロール位置などを保つ)
  function updateMp() {
    if (!room) return;
    const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    set('mpbar', mpBarInner());
    if (save && save.meet && world) { set('mpready', mpReadyInner()); set('mpresult', mpResultInner()); }
  }
  // 中継が終わるまで待つ処理(発走の合図など)
  function flushRoom() {
    while (room && !anim && room.queue.length) room.queue.shift()();
  }

  async function createRoom() {
    if (ui.busy) return;
    const nm = $('#mpName');
    if (nm) { profile.name = cleanName(nm.value); saveProfile(); }
    ui.busy = 'ルームを作成中…'; ui.lobbyError = ''; render();
    let net;
    try { net = await KeibaNet.host({ onJoin: () => {}, onMsg: hostMsg, onLeave: hostLeave }); }
    catch (e) { ui.busy = ''; ui.lobbyError = e.message; render(); return; }
    ui.busy = '';
    if (mode !== 'multi' || room) { net.close(); return; }
    room = { code: net.code, host: true, style: ui.mpStyle, me: 'host', net, queue: [], pendingDay: 0, target: null,
      players: [{ id: 'host', name: playerName(), ready: false, bankroll: START_MONEY, pl: 0, last: null }] };
    save = { ...defaultSave(), ...lastPrefs };
    startWorld(() => { room.target = nextKey(); selectRace(room.target); syncPlayers(); });
  }
  async function joinRoom(code) {
    if (ui.busy) return;
    const nm = $('#mpName');
    if (nm) { profile.name = cleanName(nm.value); saveProfile(); }
    ui.busy = 'ルームに接続中…'; ui.lobbyError = ''; render();
    let net;
    try { net = await KeibaNet.join(code, { onMsg: guestMsg, onClose: hostGone }); }
    catch (e) { ui.busy = ''; ui.lobbyError = e.message; render(); return; }
    ui.busy = '';
    if (mode !== 'multi' || room) { net.close(); return; }
    room = { code: String(code).trim().toUpperCase(), host: false, style: 'normal', me: null, net, queue: [], pendingDay: 0, target: null, players: [] };
    showLoading('ルームの情報を受信中…', '');
    net.send({ t: 'hello', name: playerName() });
  }
  function leaveRoom(ask) {
    if (!room) return true;
    if (ask && !confirm(room.host ? 'ルームを閉じますか?参加者との接続も切れます。' : 'ルームから退出しますか?')) return false;
    try { if (room.host) room.net.broadcast({ t: 'bye' }); room.net.close(); } catch (e) { /* 切断済み */ }
    clearTimeout(room.startTimer);
    if (save) lastPrefs = Object.fromEntries(PREF_FIELDS.filter(k => save[k] !== undefined).map(k => [k, save[k]]));
    if (anim) { clearInterval(anim.timer); anim = null; KeibaSound.stop(); KeibaSound.hush(); KeibaSound.crowd(0); }
    room = null; save = null; world = null; race = null; result = null; cart = [];
    return true;
  }
  function hostGone() {
    if (!room || room.host || room.closed) return;
    room.closed = true;
    room.queue = [];
    if (!anim && save && world) render();
    else if (!save) { leaveRoom(false); ui.lobbyError = 'ホストとの接続が切れました'; render(); }
  }

  // ホスト側:参加者からの連絡
  function hostMsg(id, m) {
    if (!room || !room.host || !m) return;
    if (!world || !save.meet) { setTimeout(() => hostMsg(id, m), 300); return; }
    const p = room.players.find(x => x.id === id);
    if (m.t === 'hello') {
      if (!p) room.players.push({ id, name: cleanName(m.name) || 'ゲスト', ready: false, bankroll: START_MONEY, pl: 0, last: null });
      // 今日の確定分(結果だけ。馬券は各自のもの)
      const races = Object.fromEntries(Object.entries(save.meet.races).filter(([, st]) => st.done && st.res)
        .map(([k, st]) => [k, { tickets: [], done: true, skipped: !!st.skipped, winnerNo: st.winnerNo, winner: st.winner, res: st.res }]));
      room.net.send(id, { t: 'welcome', id, style: room.style, worldSeed: save.worldSeed, worldLog: save.worldLog, day: save.meet.day, races, target: room.target, players: room.players });
      syncPlayers();
      return;
    }
    if (!p) return;
    if (m.t === 'ready') { p.ready = !!m.ready && m.key === room.target && targetOpen(); syncPlayers(); maybeStart(); }
    else if (m.t === 'score') { Object.assign(p, { bankroll: +m.bankroll || 0, pl: +m.pl || 0, last: m.last || null }); syncPlayers(); }
  }
  function hostLeave(id) {
    if (!room || !room.host) return;
    room.players = room.players.filter(p => p.id !== id);
    syncPlayers(); maybeStart();
  }
  function syncPlayers() {
    if (!room || !room.host || !save || !save.meet) return;
    room.net.broadcast({ t: 'players', players: room.players, target: room.target, day: save.meet.day });
    updateMp();
  }
  function maybeStart() {
    if (!room || !room.host || !targetOpen() || !room.players.every(p => p.ready)) return;
    clearTimeout(room.startTimer);
    room.startTimer = setTimeout(() => { if (room && targetOpen() && room.players.every(p => p.ready)) startRoomRace(); }, 800);
  }
  function startRoomRace() {
    if (!targetOpen()) return;
    const key = room.target, day = save.meet.day;
    room.players.forEach(p => { p.ready = false; });
    room.net.broadcast({ t: 'start', key, day });
    syncPlayers();
    room.queue.push(() => runRoomRace(key, day));
    flushRoom();
  }
  function setTarget(key) {
    if (!room || !room.host || !key || !infoOf(key) || rstate(key).done) return;
    room.target = key;
    room.players.forEach(p => { p.ready = false; });
    syncPlayers();
    selectRace(key);
  }

  // 参加者側:ホストからの連絡
  function guestMsg(m) {
    if (!room || room.host || !m) return;
    switch (m.t) {
      case 'welcome':
        Object.assign(room, { me: m.id, style: m.style, players: m.players, target: m.target, pendingDay: m.day });
        save = { ...defaultSave(), ...lastPrefs, worldSeed: m.worldSeed, worldLog: m.worldLog };
        save.meet = { gen: MEET_GEN, day: m.day, races: m.races };
        showLoading();
        setTimeout(() => {
          if (!room) return;
          buildWorld();
          selectRace(targetOpen() ? room.target : nextKey());
          flushRoom();
        }, 30);
        break;
      case 'players': {
        const prev = room.target;
        room.players = m.players; room.target = m.target;
        room.pendingDay = Math.max(room.pendingDay, m.day);
        if (!world) break;
        if (m.target !== prev) followTarget();
        updateMp();
        break;
      }
      case 'start':
        room.queue.push(() => runRoomRace(m.key, m.day));
        if (world) flushRoom();
        break;
      case 'bye': hostGone(); break;
    }
  }
  // ホストが進めた開催日まで追いつく(結果は同じシードで決まるので、自分の画面で同じように確定させる)
  function catchUp() {
    while (room && room.pendingDay > save.meet.day) advanceDay();
  }
  // 発走対象が変わったら移動する(結果を見ている途中なら、「次のレースへ」を押した時に移動)
  function followTarget() {
    if (anim || !world) return;
    if (race && save.sel && rstate(save.sel).done) { updateMp(); return; }
    catchUp();
    if (targetOpen()) selectRace(room.target);
    else render();
  }
  function runRoomRace(key, day) {
    if (day > save.meet.day) { room.pendingDay = Math.max(room.pendingDay, day); catchUp(); }
    if (!infoOf(key) || rstate(key).done) return;
    const p = myPlayer();
    if (p) p.ready = false;
    showHistory = false; showStats = false;
    post(key);
  }
  function setReady(v) {
    const p = myPlayer();
    if (!p || room.closed) return;
    if (v && (save.sel !== room.target || !targetOpen())) return;
    if (v && cart.length && !confirm('カートに未購入の馬券があります。破棄して「賭け終えた」にしますか?')) return;
    if (v) cart = [];
    p.ready = v;
    if (room.host) { syncPlayers(); maybeStart(); } else room.net.send({ t: 'ready', ready: v, key: room.target });
    render();
  }
  function reportScore(key, spent = 0, back = 0) {
    const p = myPlayer();
    if (!p) return;
    p.bankroll = save.bankroll;
    p.pl = save.stats.returned - save.stats.wagered;
    if (key) p.last = { day: save.meet.day, key, spent, back };
    if (room.host) syncPlayers();
    else room.net.send({ t: 'score', bankroll: p.bankroll, pl: p.pl, last: p.last });
  }
  function nextInRoom() {
    if (room.host) {
      const k = nextKey();
      if (k && k !== room.target) { room.target = k; room.players.forEach(p => { p.ready = false; }); syncPlayers(); }
      selectRace(k);
      return;
    }
    catchUp();
    selectRace(targetOpen() ? room.target : nextKey());
  }
  function nextDayInRoom() {
    if (room.host) {
      advanceDay();
      room.target = nextKey();
      room.players.forEach(p => { p.ready = false; });
      syncPlayers();
      selectRace(room.target);
      return;
    }
    catchUp();
    selectRace(targetOpen() ? room.target : nextKey());
  }
  window.addEventListener('beforeunload', () => { if (room) leaveRoom(false); });

  // ---------- レース再生 ----------
  const PRE_ROLL = 3; // ゲートイン完了から発走までの秒数
  const INTRO = 6;    // 重賞のレース紹介(ファンファーレの前)の秒数
  const SHOT_LABEL = { stands: 'スタンド', gate: 'ゲート', side: 'サイド', corner: 'コーナー', high: '俯瞰', front: '直線正面', stretch: '直線(スタンド屋上)', goal: 'ゴール前' };

  // 先頭が距離 d を通過した時刻(フレーム間は線形補間)
  function passTime(d) {
    const f = result.frames, dt = result.dt;
    for (let i = 1; i < f.length; i++) {
      const a = Math.max(...f[i - 1]), b = Math.max(...f[i]);
      if (b >= d) return (i - 1 + (d - a) / Math.max(1e-6, b - a)) * dt;
    }
    return null;
  }

  function startAnim(hiddenReturn = 0) {
    const endT = (result.frames.length - 1) * result.dt;
    if (anim) clearInterval(anim.timer);
    KeibaSound.stop();
    KeibaSound.hush();
    KeibaSound.setEnabled(save.sound);
    KeibaSound.setVoice(save.voice);
    KeibaSound.setVoiceName(save.voiceName);
    KeibaSound.setPace(save.speed);
    // 重賞は発走前にレース紹介 → ファンファーレ(G1 は長い版)
    const graded = !!race.cls.grade;
    const fanLen = graded ? INTRO + KeibaSound.fanfareLength(race.cls.key) + 2.8 : 0;
    const T0 = -PRE_ROLL - fanLen;
    anim = {
      T: T0, endT, last: performance.now(), lastSayAt: performance.now(), fill: 0, said: new Set(), mentioned: new Set(), hist: [], lastRank: 0, done: false, hiddenReturn, skipped: false, boardAt: null,
      prelude: graded ? -PRE_ROLL : null, preludeStart: T0, cheered: false, fanfareAt: graded ? T0 + INTRO : null,
    };
    // requestAnimationFrame が止まる環境(非表示タブなど)でも進むよう、タイマーで補助する
    anim.timer = setInterval(() => { if (anim && performance.now() - anim.last > 150) step(performance.now()); }, 100);
    render();
    if (graded) {
      $('#tvFan').hidden = false;
      say(`${race.venue}競馬場、本日のメインレース。${race.cls.name}、${race.name}。${race.surface}${race.distance}m、${race.n}頭立て。間もなくファンファーレです。`, 'intro');
      KeibaSound.crowd(0.05);
    } else {
      say('各馬順調にゲートイン。態勢完了。');
      KeibaSound.crowd(0.06);
    }
    requestAnimationFrame(tick);
  }

  let tv = null, ctxO, geo;
  function setupCanvases() {
    tv = KeibaTV.createTV($('#tv'), race, { mine: myHorses(), prelude: anim && anim.prelude, preludeStart: anim && anim.preludeStart });
    tv.resize();
    setupOval();
  }
  function setupOval() {
    const dpr = window.devicePixelRatio || 1;
    const o = $('#oval');
    const w = o.clientWidth, h = Math.round(w * 0.55);
    o.style.height = h + 'px';
    o.width = w * dpr; o.height = h * dpr;
    ctxO = o.getContext('2d'); ctxO.setTransform(dpr, 0, 0, dpr, 0, 0);
    const u = h / 300, r = h * 0.34, a = w - 2 * r - 24 * u;
    // ゴール板から 1 コーナーまでの割合は映像(tv.js)と同じ
    const post = KeibaTV.POST / (race.course.straight + KeibaTV.POST);
    geo = { w, h, u, cx: w / 2, cy: h / 2, r, a, post, P: 2 * a + 2 * Math.PI * r };
  }

  // ゴール地点からの走行距離(px)をコース上の座標へ
  function pointAt(d, off) {
    const { cx, cy, r, a, P, post } = geo;
    let s = ((d % P) + P) % P;
    const R = r + off;
    let x, y;
    const seg = [post * a, Math.PI * r, a, Math.PI * r, (1 - post) * a];
    if (s < seg[0]) { x = cx + a / 2 - post * a + s; y = cy + R; }
    else if ((s -= seg[0]) < seg[1]) { const t = Math.PI / 2 - s / r; x = cx + a / 2 + R * Math.cos(t); y = cy + R * Math.sin(t); }
    else if ((s -= seg[1]) < seg[2]) { x = cx + a / 2 - s; y = cy - R; }
    else if ((s -= seg[2]) < seg[3]) { const t = -Math.PI / 2 - s / r; x = cx - a / 2 + R * Math.cos(t); y = cy + R * Math.sin(t); }
    else { s -= seg[3]; x = cx - a / 2 + s; y = cy + R; }
    if (race.dir === '右') x = 2 * cx - x;
    return [x, y];
  }

  function positionsAt(T) {
    const f = result.frames, dt = result.dt;
    const t = Math.max(0, T);
    const i = Math.min(f.length - 2, Math.floor(t / dt));
    const fr = Math.min(1, t / dt - i);
    return race.horses.map((_, j) => f[i][j] + (f[i + 1][j] - f[i][j]) * fr);
  }

  // 右下の小窓(コース全体図)
  function drawOval(pos) {
    if (!geo || geo.w < 20) return; // 小窓を表示しない幅
    const ctx = ctxO, { w, h, u, P } = geo;
    ctx.clearRect(0, 0, w, h);
    const D = race.distance, k = P / race.course.lap;
    ctx.lineWidth = 30 * u; ctx.strokeStyle = race.surface === '芝' ? '#3f9a4f' : '#b88a5a'; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let d = 0; d <= P; d += 3) { const [x, y] = pointAt(d, 10 * u); d === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.closePath(); ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    for (let d = 0; d <= P; d += 3) { const [x, y] = pointAt(d, -5 * u); d === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.closePath(); ctx.stroke();
    const mark = (dm, color) => {
      const [x1, y1] = pointAt(dm * k, -6 * u), [x2, y2] = pointAt(dm * k, 26 * u);
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    };
    mark(-D, '#3d8bfd');
    mark(0, '#ff3b6b');
    const mine = myHorses();
    const rad = Math.max(3, 7 * u);
    const order = race.horses.map((hh, j) => j).sort((x, y) => pos[x] - pos[y]);
    for (const j of order) {
      const hh = race.horses[j];
      const lane = (2 + ((hh.no * 7) % 6) * 3.5) * u;
      const [x, y] = pointAt((Math.min(pos[j], D + 40) - D) * k, lane);
      const [bg] = BRACKET_COLORS[hh.bracket];
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fillStyle = bg; ctx.fill();
      ctx.lineWidth = mine.has(hh.no) ? 2 : 0.8; ctx.strokeStyle = mine.has(hh.no) ? '#ff2d55' : 'rgba(0,0,0,.6)'; ctx.stroke();
    }
  }

  // 直線の攻防・ゴールなどは、しゃべっている途中でも切り替えて読む
  const URGENT = new Set(['start', '400', '200', '100', 'goal', 'final']);
  function say(text, key = '', heat) {
    KeibaSound.speak(text, URGENT.has(key), heat);
    if (anim) anim.lastSayAt = performance.now();
    const sub = $('#tvSub');
    if (sub) sub.textContent = text;
    const ul = $('#comment');
    if (!ul) return;
    const li = document.createElement('li');
    li.textContent = `${E.formatTime(Math.max(0, anim.T))}  ${text}`;
    ul.prepend(li);
  }

  // ---------- 実況 ----------
  // 実際の競馬中継の型(先行争い → 隊列 → 1000m 通過とペース → 3〜4 角の動き → 直線の攻防 → ゴール)に沿って話す
  const LEN = 2.4; // 1 馬身(m)
  function lenText(m) {
    const L = m / LEN;
    if (L < 0.3) return 'クビ差';
    if (L < 0.7) return '半馬身';
    if (L < 1.3) return '1馬身';
    if (L < 1.8) return '1馬身半';
    return `${Math.round(L)}馬身`;
  }
  // 合間の実況の台詞(順番に回し、その時の状況から作る)
  function fillerLine(order, pos, nm, mover, gap, rem) {
    const a = anim, n = race.n, H = j => race.horses[j];
    const rankOf = j => order.indexOf(j) + 1;
    const mine = [...myHorses()].map(no => no - 1);
    const lanes = tv ? tv.lanes : [];
    const side = (x, y) => (lanes[x] != null && lanes[y] != null ? (lanes[x] < lanes[y] ? '内' : '外') : 'その後ろ');
    const r100 = Math.max(100, Math.ceil(rem / 100) * 100);
    const inStretch = rem <= race.course.straight;
    let cands;
    if (inStretch) {
      const m = mover(4, 8);
      cands = [
        () => `${nm(order[0])}先頭!リードは${lenText(gap(0, 1))}!`,
        () => `${nm(order[1])}が${gap(0, 1) < LEN ? '並びかける' : '懸命に追う'}!`,
        () => (m != null && m !== order[0] ? `外から${nm(m)}!${nm(m)}が伸びてくる!` : `${nm(order[2])}も脚を伸ばしている!`),
        () => `残り${r100}!`,
        () => (mine.length ? `${nm(mine[0])}は${rankOf(mine[0])}番手!` : null),
        () => `内で${nm(order.slice(0, 4).reduce((x, y) => (lanes[y] < lanes[x] ? y : x)))}が粘っている!`,
      ];
    } else {
      const mid = Math.floor(n / 2), fav = race.market.pop.indexOf(1), m = mover(8, n);
      cands = [
        () => (gap(0, 1) > LEN * 3 ? `先頭は${nm(order[0])}、後続を${lenText(gap(0, 1))}離して軽快に飛ばしています。` : `先頭は${nm(order[0])}、リードは${lenText(gap(0, 1))}。`),
        () => `2番手に${nm(order[1])}、${side(order[2], order[1])}に${nm(order[2])}が続きます。`,
        () => `中団には${nm(order[mid - 1])}、${nm(order[mid])}${n > 9 ? `、${nm(order[mid + 1])}` : ''}。`,
        () => `後方グループ、${nm(order[n - 3])}、${nm(order[n - 2])}、最後方に${nm(order[n - 1])}。`,
        () => (m != null ? `${nm(m)}、じわじわと位置を上げてきました。` : null),
        () => { const k = rankOf(fav); return `1番人気の${nm(fav)}は${k}番手${k <= 3 ? '、いい位置' : k > n * 0.6 ? '、まだ後ろ' : ''}。`; },
        () => (mine.length ? `注目の${nm(mine[a.fill % mine.length])}は現在${rankOf(mine[a.fill % mine.length])}番手。` : null),
        () => `残り${r100}メートル${tv && tv.segmentLabel ? `、${tv.segmentLabel}` : ''}。`,
        () => `${nm(order[0])}の鞍上${H(order[0]).jockey.name}、${gap(0, 1) < LEN ? '後ろを気にしながら' : 'マイペースに持ち込んで'}います。`,
        () => (a.said.has('split') ? `前半は${{ H: '速い流れ', M: '淀みのない流れ', S: 'ゆったりとした流れ' }[result.pace]}です。` : null),
      ];
    }
    for (let k = 0; k < cands.length; k++) {
      const t = cands[a.fill++ % cands.length]();
      if (t) return { text: t, heat: inStretch ? 1 : 0 };
    }
    return null;
  }

  function commentary(pos) {
    const D = race.distance, a = anim, T = a.T;
    const order = race.horses.map((h, j) => j).sort((x, y) => pos[y] - pos[x]);
    const H = j => race.horses[j];
    // 初めて呼ぶ馬は馬番つき
    const nm = j => { const h = H(j); if (a.mentioned.has(h.no)) return h.name; a.mentioned.add(h.no); return `${h.no}番${h.name}`; };
    const once = (key, fn) => { if (!a.said.has(key)) { a.said.add(key); const t = fn(); if (t) say(t, key); } };
    const lead = pos[order[0]], rem = D - lead;
    const gap = (x, y) => pos[order[x]] - pos[order[y]];
    // 順位の履歴(1 秒ごと)から、直近で順位を上げている馬を探す
    if (T > 0 && (!a.hist.length || T - a.hist[a.hist.length - 1].T >= 1)) {
      const rank = []; order.forEach((j, k) => { rank[j] = k; });
      a.hist.push({ T, rank });
    }
    const mover = (secs, within) => {
      const past = a.hist.find(x => x.T >= T - secs);
      if (!past || T - past.T < secs * 0.6) return null;
      let best = null, bestGain = 2;
      order.slice(1, within).forEach((j, k) => { const g = past.rank[j] - (k + 1); if (g > bestGain) { best = j; bestGain = g; } });
      return best;
    };

    if (a.fanfareAt != null && T >= a.fanfareAt) once('fanfare', () => { KeibaSound.fanfare(race.cls.key); return ''; });
    if (a.prelude != null && T >= a.prelude) once('gatein', () => { $('#tvFan').hidden = true; return '各馬ゲートイン完了。態勢整いました。'; });
    if (T > 0.5) once('start', () => {
      KeibaSound.crowd(0.12);
      const late = result.rows.filter(r => r.notes.includes('出遅れ')).map(r => nm(r.no - 1));
      return late.length ? `スタートしました!あっと、${late.join('、')}は出遅れました!` : 'スタートしました!各馬そろった綺麗なスタートです。';
    });
    if (T > 5 && lead > 90) once('lead', () => {
      if (gap(0, 1) < 1.2) {
        const [inn, out] = [order[0], order[1]].sort((x, y) => tv.lanes[x] - tv.lanes[y]);
        return `さあ先行争い。内から${nm(inn)}、外から${nm(out)}、2頭が並んでハナを争います。`;
      }
      return `ハナを切ったのは${nm(order[0])}。${lenText(gap(0, 1))}ほど離れて${nm(order[1])}が2番手。`;
    });
    // 隊列(先頭グループ → 中団 → 後方 → 1番人気の位置)
    const formAt = Math.max(D * 0.32, 420);
    if (T > 12 && lead > formAt && rem > 600) {
      once('form1', () => `隊列を確認しましょう。先頭は${nm(order[0])}、${lenText(gap(0, 1))}離れて${nm(order[1])}、その後ろに${nm(order[2])}。`);
      if (lead > formAt + 70) once('form2', () => {
        const mid = Math.floor(race.n / 2);
        return `中団に${nm(order[mid - 1])}、${nm(order[mid])}。後方から${nm(order[race.n - 2])}、最後方に${nm(order[race.n - 1])}。`;
      });
      if (lead > formAt + 140) once('fav', () => {
        const fav = race.market.pop.indexOf(1), k = order.indexOf(fav) + 1;
        const where = k === 1 ? '先頭' : k <= 3 ? `${k}番手の好位` : k <= race.n * 0.6 ? `${k}番手、中団で脚をためる形` : `${k}番手、後方からの競馬`;
        return `1番人気の${nm(fav)}は${where}。`;
      });
    }
    // 1000m(短距離は 600m)通過タイムとペース
    const mark = D >= 1400 ? 1000 : 600;
    if (lead >= mark && rem > 200) once('split', () => {
      const t = passTime(mark);
      const pace = { H: 'ハイペース', M: '平均ペース', S: 'スローペース' }[result.pace];
      const tail = pace === 'ハイペース' ? '。先行勢には厳しい流れ、差し馬の出番があるか' : pace === 'スローペース' ? '。ゆったりとした流れ、前の馬に有利な展開' : '。淀みのない流れです';
      return `${mark}m通過は${(t).toFixed(1).replace('.', '秒')}、${pace}${tail}。`;
    });
    const seg = tv && T > 6 ? tv.segment : '';
    if (seg === 'c3' && rem > 380) once('c3', () => {
      const m = mover(8, race.n);
      if (m != null) return `3コーナー、外から${nm(m)}が早めに進出!先頭との差を詰めていきます。`;
      return `3コーナーカーブ、依然として先頭は${nm(order[0])}、リードは${lenText(gap(0, 1))}。`;
    });
    if (seg === 'c4' && rem > 300) once('c4', () => `4コーナーを回って直線コースへ!${nm(order[0])}先頭、${nm(order[1])}が${gap(0, 1) < 1.5 ? '並びかける' : '追いかける'}、${nm(order[2])}も差を詰めてくる!`);
    if (seg === 'straight' && rem < race.course.straight - 60 && rem > 330) once('str', () => {
      const m = mover(6, 8);
      const head = gap(0, 1) > 3 ? `${nm(order[0])}、リードを広げる!` : `${nm(order[0])}、先頭で粘る!`;
      return m != null && m !== order[0] ? `${head}外から${nm(m)}が飛んでくる!` : `${head}${nm(order[1])}も懸命に追う!`;
    });
    if (rem <= 400 && rem > 220) once('400', () => {
      KeibaSound.crowd(0.35);
      if (gap(0, 2) < LEN) return `残り400!${nm(order[0])}、${nm(order[1])}、${nm(order[2])}、横一線の追い比べ!`;
      return `残り400を切った!鞭が入る!${nm(order[0])}先頭、追う${nm(order[1])}!`;
    });
    if (rem <= 200 && rem > 80) once('200', () => {
      KeibaSound.crowd(0.55);
      if (gap(0, 1) < LEN * 0.5) return `残り200!${nm(order[0])}と${nm(order[1])}、激しい叩き合い!`;
      if (gap(0, 1) > LEN * 3) return `残り200!${nm(order[0])}、後続を突き放す!これは強い!`;
      const m = mover(5, 6);
      return `残り200!${nm(order[0])}先頭、${nm(order[1])}が迫る!${m != null && m !== order[1] && m !== order[0] ? `さらに${nm(m)}!` : ''}`;
    });
    if (rem <= 80 && rem > 0 && gap(0, 1) < LEN * 0.6) once('100', () => `${H(order[0]).name}か!${H(order[1]).name}か!`);
    // 合間の実況:要所の台詞のあいだも途切れずに状況を伝える(声があるなら読み終わり次第、なければ数秒ごと)
    if (T > 2.5 && rem > 6 && !a.said.has('goal')) {
      const now = performance.now();
      const live = KeibaSound.canSpeak && save.voice && save.sound;
      if (live ? !KeibaSound.busy && now - a.lastSayAt > 300 : now - a.lastSayAt > 2000) {
        const line = fillerLine(order, pos, nm, mover, gap, rem);
        if (line) say(line.text, 'fill', line.heat);
      }
    }
    if (lead >= D) once('goal', () => {
      if (!a.cheered) { a.cheered = true; KeibaSound.cheer(); KeibaSound.crowd(0.15); }
      const r0 = result.rows[0], r1 = result.rows[1];
      if (['同着', 'ハナ', 'アタマ'].includes(r1.margin)) return 'ほとんど並んでゴールイン!これは写真判定です!';
      const w = r0.no - 1;
      const big = r1.margin === '大差' ? '大差の圧勝!' : parseFloat(r1.margin) >= 3 ? `${r1.margin.replace('.', ' ')}馬身差の圧勝!` : '';
      return `${nm(w)}、1着でゴールイン!${big}`;
    });
    // 着順掲示が出たら確定の実況
    if (a.boardAt !== null && T - a.boardAt > 0.8) once('final', () => {
      const r = result.rows, w = race.horses[r[0].no - 1], pop = race.market.pop[r[0].no - 1];
      const praise = pop === 1 ? '1番人気に応えました!' : pop >= 7 ? `${pop}番人気の伏兵が大金星!` : '';
      const title = race.cls.grade ? `${race.cls.name}制覇!` : '見事な騎乗でした。';
      return `1着は${w.no}番${w.name}、2着${r[1].no}番、3着${r[2].no}番。勝ちタイム${E.formatTime(r[0].time)}。${praise}鞍上${w.jockey.name}、${title}`;
    });
  }

  function currentOrder(pos) {
    const finished = new Map(result.rows.filter(r => r.time <= anim.T).map(r => [r.no, r.rank]));
    const order = race.horses.map((h, j) => j).sort((x, y) => {
      const fx = finished.get(x + 1), fy = finished.get(y + 1);
      if (fx && fy) return fx - fy;
      if (fx) return -1;
      if (fy) return 1;
      return pos[y] - pos[x];
    });
    return { order, finished };
  }

  function updateOverlay(pos) {
    const D = race.distance;
    const { order, finished } = currentOrder(pos);
    const lead = pos[order[0]], mine = myHorses();
    $('#rank').innerHTML = order.map((j, k) => {
      const h = race.horses[j];
      const gap = finished.has(h.no) || k === 0 || anim.T <= 0 ? '' : `${((Math.min(lead, D) - pos[j]) / 2.4).toFixed(1)}馬身`;
      return `<li class="${mine.has(h.no) ? 'mine' : ''}">${waku(h.bracket, 'mini')}<b>${h.no}</b> ${esc(h.name)} <span class="sub">${gap}</span></li>`;
    }).join('');
    order.forEach((j, k) => { const c = document.getElementById(`sc-now-${race.horses[j].no}`); if (c) c.textContent = anim.T > 0 ? `${k + 1}位` : '—'; });
    $('#tvTicker').innerHTML = '<span class="lbl">順位</span>' + order.map(j => {
      const h = race.horses[j];
      const [bg, fg] = BRACKET_COLORS[h.bracket];
      return `<span class="tk ${mine.has(h.no) ? 'mine' : ''}" style="background:${bg};color:${fg}">${h.no}</span>`;
    }).join('');
    const remain = Math.max(0, D - lead);
    $('#rvTime').textContent = E.formatTime(Math.max(0, anim.T));
    $('#rvRemain').textContent = anim.T < 0 ? '発走前' : remain > 0 ? `残り ${Math.ceil(remain / 100) * 100}m` : 'ゴール';
    $('#tvSeg').textContent = tv.segmentLabel;
    $('#tvShot').textContent = SHOT_LABEL[tv.shot] || '';
    // 着順掲示板(上位 5 頭がゴールしたら表示、少し置いて「確定」)
    const top = result.rows.slice(0, Math.min(5, race.n));
    if (anim.T >= top[top.length - 1].time) {
      const board = $('#tvBoard');
      if (anim.boardAt === null) {
        anim.boardAt = anim.T;
        board.hidden = false;
        board.innerHTML = `<div class="bh"><span>着順</span><span class="kakutei" id="kakutei">確定</span></div>` +
          top.map(r => `<div class="row"><span class="rk">${r.rank}</span><span class="no">${r.no}</span><span class="mg">${r.margin}</span></div>`).join('');
      }
      if (anim.T - anim.boardAt > 1.5 || anim.skipped) $('#kakutei').classList.add('on');
    }
  }

  function tick(now) {
    if (anim && !anim.done) { step(now); requestAnimationFrame(tick); }
  }

  function step(now) {
    if (!anim || anim.done) return;
    const dtReal = Math.min(0.25, Math.max(0, now - anim.last) / 1000);
    anim.last = now;
    // 発走前は等速、レース中は選択した倍速
    anim.T = Math.min(anim.endT, anim.T + dtReal * (anim.T < 0 ? 1 : save.speed));
    const pos = positionsAt(anim.T);
    if (tv && $('#tv')) {
      tv.render(anim.T, pos, now);
      drawOval(pos);
      commentary(pos);
      if (now - anim.lastRank > 120 || anim.T >= anim.endT) { updateOverlay(pos); anim.lastRank = now; }
    }
    if (anim.T >= anim.endT) {
      anim.done = true;
      clearInterval(anim.timer);
      const finished = anim;
      setTimeout(() => { if (anim === finished) { anim = null; KeibaSound.crowd(0); render(); flushRoom(); } }, finished.skipped ? 700 : 4200);
    }
  }

  window.addEventListener('resize', () => { if (anim && tv) { tv.resize(); setupOval(); } });

  // テストからの操作用
  window.__keiba = {
    get race() { return race; }, get result() { return result; }, get save() { return save; }, get anim() { return anim; }, get tv() { return tv; }, ui,
    get cur() { return curState(); }, get world() { return world; }, schedule, nextKey, targetKey, rstate, header,
    get mode() { return mode; }, get room() { return room; }, get profile() { return profile; }, switchMode, collectData, applyImport, setReady,
  };

  init();
})();
