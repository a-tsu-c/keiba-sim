/* 競馬シミュレーション UI */
(() => {
  'use strict';
  const E = KeibaEngine;
  const $ = (s, el = document) => el.querySelector(s);
  const yen = v => (v < 0 ? '-¥' : '¥') + Math.abs(Math.round(v)).toLocaleString('ja-JP');
  const signedYen = v => (v > 0 ? '+' : '') + yen(v);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const odds1 = pay => (pay / 100).toFixed(1);

  const KEY = 'keiba-sim-v1';
  const START_MONEY = 100000;
  const BRACKET_COLORS = {
    1: ['#ffffff', '#111'], 2: ['#222222', '#fff'], 3: ['#e53935', '#fff'], 4: ['#1e6fd9', '#fff'],
    5: ['#f6d000', '#111'], 6: ['#1a9b4b', '#fff'], 7: ['#f08a00', '#111'], 8: ['#f49ac1', '#111'],
  };
  const METHOD_LABEL = { normal: '通常', box: 'ボックス', nagashi: 'ながし', formation: 'フォーメーション' };

  // ---------- 保存 ----------
  // meet: その日の開催(3 場 × 12R)。races[key] = { tickets, done, skipped, winnerNo, winner }
  function defaultSave() {
    return { v: 2, bankroll: START_MONEY, topups: 0, speed: 4, view: 'paper', stats: { wagered: 0, returned: 0, races: 0, hitRaces: 0 }, history: [], meet: null, sel: null };
  }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.v === 2) return s;
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
    try { localStorage.setItem(KEY, JSON.stringify(save)); } catch (e) { /* ignore */ }
  }

  let save = load();
  let race = null, result = null, cart = [], anim = null, showHistory = false;
  const ui = { type: 'win', method: 'normal', rows: [[]], stake: 100 };

  const newSeed = () => (Math.random() * 0xffffffff) >>> 0;
  const raceLabel = r => `${r.venue} ${r.day}日目 ${r.raceNo}R`;

  // ---------- 開催 ----------
  const headerCache = new Map();
  let scheduleCache = null;
  // 出走馬の生成方式を変えたら上げる(同じシードでも別の馬になるため、古い開催は作り直す)
  const MEET_GEN = 3;
  function newMeet(day) {
    save.meet = { gen: MEET_GEN, day, seedBase: newSeed(), races: {} };
    save.sel = null;
    headerCache.clear();
  }
  function schedule() {
    if (!scheduleCache || scheduleCache.day !== save.meet.day) scheduleCache = E.daySchedule(save.meet.day);
    return scheduleCache;
  }
  const infoOf = key => schedule().races.find(r => r.key === key);
  const rstate = key => (save.meet.races[key] ||= { tickets: [], done: false });
  const raceOpts = info => ({ seed: E.hashStr(`${save.meet.seedBase}|${save.meet.day}|${info.key}`), raceNo: info.raceNo, venueIdx: info.venueIdx, slot: info.slot, day: save.meet.day });
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
      // 旧方式の開催:未発走レースの馬券は払い戻して同じ日を作り直す
      const refund = Object.values(save.meet.races).filter(r => !r.done).flatMap(r => r.tickets).reduce((a, t) => a + t.cost, 0);
      save.bankroll += refund;
      save.stats.wagered -= refund;
      newMeet(save.meet.day);
    }
    if (!save.meet) newMeet(1);
    selectRace(save.sel && infoOf(save.sel) ? save.sel : nextKey());
  }

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
    const st = save.stats;
    // 再生中はゴールまで払戻を伏せる
    const hidden = anim ? anim.hiddenReturn : 0;
    const returned = st.returned - hidden;
    const pl = returned - st.wagered;
    const roi = st.wagered ? (returned / st.wagered * 100).toFixed(1) + '%' : '—';
    return `
      <header class="top">
        <div class="brand">🏇 <b>KEIBA SIM</b><span class="sub">競馬シミュレーター</span></div>
        <div class="money">
          <div><span class="lbl">所持金</span><b id="bankroll">${yen(save.bankroll - hidden)}</b></div>
          <div><span class="lbl">通算収支</span><b class="${pl >= 0 ? 'plus' : 'minus'}">${signedYen(pl)}</b></div>
          <div><span class="lbl">回収率</span><b>${roi}</b></div>
          <div class="btns">
            <button class="ghost" data-act="history">履歴</button>
            <button class="ghost" data-act="reset">リセット</button>
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

  function pastHtml(h) {
    return h.past.map(p => {
      const cls = p.pos === 1 ? 'p1' : p.pos === 2 ? 'p2' : p.pos === 3 ? 'p3' : p.pos <= 5 ? 'p5' : '';
      return `<span class="past ${cls}" title="${p.dateLabel} ${p.venue} ${esc(p.raceName)} ${p.surface}${p.dist}m ${p.going} ${p.field}頭 ${p.pop}人気 ${p.pos}着">${p.pos}</span>`;
    }).join('');
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
      const last = h.past[0];
      return `
        <tr class="${mine.has(h.no) ? 'mine' : ''}">
          <td>${waku(h.bracket)}</td>
          <td class="no">${h.no}</td>
          <td class="mark">${m.marks[i]}</td>
          <td class="hn"><div class="name">${silkSwatch(h.silks)}${esc(h.name)}</div><div class="sub">${h.sex}${h.age} ${h.coat}</div></td>
          <td>${h.kinryo.toFixed(1)}</td>
          <td class="jk">${esc(h.jockey.name)}</td>
          <td>${h.bodyWeight}<span class="sub">(${diff})</span></td>
          <td><span class="style">${h.style}</span></td>
          <td><span class="train t${h.trainingGrade}">${h.trainingGrade}</span></td>
          <td class="sub">${interval(h.layoff)}</td>
          <td>${rec(h.records.all)}</td>
          <td class="lastrun">${last.venue} ${esc(last.raceName)} ${surfShort(last.surface)}${last.dist} <b>${last.pos}着</b><span class="sub">(${last.pop}人)</span></td>
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
        <div class="tablewrap">
          <table class="entries">
            <thead><tr><th>枠</th><th>馬番</th><th>印</th><th>馬名</th><th>斤量</th><th>騎手</th><th>馬体重</th><th>脚質</th><th>調教</th><th>間隔</th><th>通算</th><th>前走</th><th>近5走</th><th>単勝</th><th>人気</th><th>複勝</th></tr></thead>
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
        <div class="rp"><b class="pos">${r.pos}</b><span class="sub">着/${r.field}頭</span><span class="tm">${E.formatTime(r.time)}</span></div>
        <div class="rc ${same ? 'same' : ''}">${surfShort(r.surface)}${r.dist} ${r.going} ${r.no}番</div>
        <div class="sub">${esc(r.jockey)} ${r.kinryo.toFixed(1)} ${r.weight}kg</div>
        <div>${r.passing} <span class="sub">上</span>${r.last3f.toFixed(1)}${r.last3fRank <= 3 ? `<b class="l3">${circled(r.last3fRank)}</b>` : ''}</div>
        <div class="rv">${esc(r.rival)} <span>(${r.diff.toFixed(1)})</span></div>
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
            <div class="ih">${waku(h.bracket)}<b class="no">${h.no}</b><span class="mark">${m.marks[i]}</span>
              <span class="odds ${pop <= 3 ? 'hot' : ''}">${odds1(m.winPay[i])}</span><span class="sub">${pop}人気</span></div>
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
          ${[0, 1, 2, 3, 4].map(k => runCell(h.past[k])).join('')}
        </tr>`;
    }).join('');
    return `
      <section class="card">
        <h2>馬柱 <small>${race.surface}${race.distance}m と同条件(同じ馬場で±200m)の走りは<span class="same">緑</span>/上がり3F の順位1〜3位は①②③/成績は 1着-2着-3着-着外/(タイム差)は勝ち馬との差・勝った時は2着馬との差</small></h2>
        ${viewTabs()}
        <div class="tablewrap">
          <table class="paper">
            <thead><tr><th>馬</th><th>前走</th><th>2走前</th><th>3走前</th><th>4走前</th><th>5走前</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>`;
  }

  function renderBetPanel() {
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
        <button class="primary" data-act="add" ${pv.ok ? '' : 'disabled'}>カートに追加</button>
        <div class="cart">
          <h3>カート <small>合計 ${yen(cartTotal)}</small></h3>
          <ul>${cartHtml}</ul>
          <button class="primary buy" data-act="buy" ${cart.length ? '' : 'disabled'}>購入する(${yen(cartTotal)})</button>
          <p class="note">※ 購入後の取消はできません(実際の馬券と同じ)</p>
        </div>
        ${boughtHtml}
        ${broke ? `<div class="broke">所持金が尽きました。<button class="primary" data-act="topup">追加入金 ${yen(START_MONEY)}</button></div>` : ''}
        ${otherBoughtHtml()}
        ${postButtonHtml()}
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
      return `<div class="prow"><span class="pvn">${E.COURSES[v].venue}</span><div class="pchips">${list.map(r => {
        const st = rstate(r.key), hd = header(r);
        const cls = [st.done ? 'done' : '', st.tickets.length ? 'bought' : '', r.key === save.sel ? 'sel' : '', r.key === next ? 'next' : ''].join(' ');
        const title = `${E.fmtClock(r.minutes)} ${hd.name}(${hd.cls.name}) ${hd.surface}${hd.distance}m ${hd.n}頭` + (st.done ? ` / 1着 ${st.winnerNo}番 ${st.winner}${st.skipped ? '(自動スキップ)' : ''}` : '');
        const mark = hd.cls.grade ? `<i class="g g${hd.cls.key.slice(1)}">${hd.cls.name}</i>` : '';
        return `<button class="pc ${cls}" data-race="${r.key}" title="${esc(title)}"><b>${r.raceNo}R</b>${mark}<small>${st.done ? `1着 ${st.winnerNo}` : E.fmtClock(r.minutes)}</small></button>`;
      }).join('')}</div></div>`;
    }).join('');
    const done = sch.races.filter(r => rstate(r.key).done).length;
    return `
      <section class="card program">
        <div class="ph"><h2>${header(sch.races[0]).dateLabel} <small>${sch.venues.map(v => E.COURSES[v].venue).join('・')} 3場開催 / ${done}/${sch.races.length} レース確定</small></h2>
          <div class="legend"><span class="pc next">次</span><span class="pc bought">購入済</span><span class="pc done">確定</span><span class="pc sel">表示中</span></div></div>
        ${rows}
      </section>`;
  }

  function renderDayEnd() {
    const sch = schedule();
    const played = save.history.filter(h => h.day === save.meet.day);
    const spent = played.reduce((a, h) => a + h.wagered, 0), back = played.reduce((a, h) => a + h.returned, 0);
    return `
      <section class="card dayend">
        <h2>本日の全 ${sch.races.length} レースが終了しました</h2>
        <p>購入したレース ${played.filter(h => h.wagered > 0).length} / 購入 ${yen(spent)} / 払戻 ${yen(back)} / 収支 <b class="${back - spent >= 0 ? 'plus' : 'minus'}">${signedYen(back - spent)}</b></p>
        <button class="primary" data-act="nextday">翌開催日へ ▶</button>
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
      </div>`;
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
      <section class="card raceview">
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
          <div class="tv-sub" id="tvSub"></div>
          <div class="tv-ticker" id="tvTicker"></div>
        </div>
        <div class="rvtop">
          <div class="speed">${[1, 2, 4, 8].map(s => `<button class="chip small ${save.speed === s ? 'on' : ''}" data-speed="${s}">×${s}</button>`).join('')}
            <button class="chip small" data-act="skip">スキップ ⏭</button></div>
          <div class="sub">カメラ: <span id="tvShot"></span></div>
        </div>
        <div class="rvbottom">
          <ol id="rank" class="rank"></ol>
          <ul id="comment" class="comment"></ul>
        </div>
      </section>`;
  }

  function skipNoteHtml() {
    const list = save.sel ? curState().skippedBefore : null;
    if (!list || !list.length) return '';
    return `<div class="skipnote">⏭ 馬券を買っていない ${list.length} レースを自動スキップしました:${list.join('・')}<span class="sub">(結果は番組表から見られます)</span></div>`;
  }

  function render() {
    const app = $('#app');
    let main;
    if (anim) main = skipNoteHtml() + renderRaceView();
    else if (!race) main = renderProgram() + renderDayEnd();
    else if (curState().done) main = renderProgram() + renderRaceInfo() + skipNoteHtml() + renderResult();
    else main = renderProgram() + renderRaceInfo() + `<div class="layout">${renderCard()}${renderBetPanel()}</div>`;
    app.innerHTML = renderHeader() + (anim ? renderRaceInfo() : '') + main + renderHistory();
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
  function post() {
    if (cart.length && !confirm('カートに未購入の馬券があります。破棄して発走しますか?')) return;
    cart = [];
    const tgt = targetKey();
    if (!tgt) return;
    const tinfo = infoOf(tgt);
    // 時刻順でそれより前の未購入レースは結果だけ確定させて飛ばす
    const skipped = [];
    for (const r of schedule().races) {
      if (r.minutes >= tinfo.minutes) break;
      const st = rstate(r.key);
      if (st.done) continue;
      const lr = header(r), res = E.runRace(lr);
      Object.assign(st, { done: true, skipped: true, winnerNo: res.order[0], winner: lr.horses[res.order[0] - 1].name });
      skipped.push(`${lr.venue}${r.raceNo}R`);
    }
    if (tgt !== save.sel) {
      save.sel = tgt;
      race = E.generateRace(raceOpts(tinfo));
    }
    const st = curState();
    st.skippedBefore = skipped;
    result = E.runRace(race);
    let back = 0, spent = 0;
    for (const t of st.tickets) {
      t.ret = E.ticketReturn(t, result.payouts).total;
      back += t.ret; spent += t.cost;
    }
    save.bankroll += back;
    save.stats.returned += back;
    save.stats.races++;
    if (back > 0) save.stats.hitRaces++;
    save.history.unshift({
      day: race.day, label: raceLabel(race), name: race.name, winner: race.horses[result.order[0] - 1].name, wagered: spent, returned: back,
    });
    save.history = save.history.slice(0, 200);
    Object.assign(st, { done: true, winnerNo: result.order[0], winner: race.horses[result.order[0] - 1].name });
    persist();
    startAnim(back);
  }

  document.addEventListener('click', e => {
    const el = e.target.closest('button, .modal');
    if (!el || el.disabled) return;
    if (el.classList.contains('modal') && e.target !== el) return;
    const d = el.dataset;
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
    if (d.speed) { save.speed = +d.speed; persist(); document.querySelectorAll('[data-speed]').forEach(b => b.classList.toggle('on', +b.dataset.speed === save.speed)); return; }
    switch (d.act) {
      case 'add': addToCart(); break;
      case 'buy': buy(); break;
      case 'post': post(); break;
      case 'skip': if (anim) { anim.skipped = true; anim.T = anim.endT; step(performance.now()); } break;
      case 'replay': startAnim(); break;
      case 'next': selectRace(nextKey()); break;
      case 'nextday': newMeet(save.meet.day + 1); selectRace(nextKey()); break;
      case 'history': showHistory = true; render(); break;
      case 'closehist': showHistory = false; render(); break;
      case 'topup': save.bankroll += START_MONEY; save.topups++; persist(); render(); break;
      case 'reset':
        if (confirm('所持金・履歴をすべてリセットしますか?')) {
          save = defaultSave(); newMeet(1); selectRace(nextKey());
        }
        break;
    }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'stake') {
      const v = Math.floor((+e.target.value || 0) / 100) * 100;
      ui.stake = Math.max(100, Math.min(v, 1000000));
      render();
    }
  });

  // ---------- レース再生 ----------
  const PRE_ROLL = 3; // ゲートイン完了から発走までの秒数
  const SHOT_LABEL = { gate: 'ゲート', side: 'サイド', corner: 'コーナー', high: '俯瞰', front: '直線正面', goal: 'ゴール前' };

  function startAnim(hiddenReturn = 0) {
    const endT = (result.frames.length - 1) * result.dt;
    if (anim) clearInterval(anim.timer);
    anim = { T: -PRE_ROLL, endT, last: performance.now(), said: new Set(), lastRank: 0, done: false, hiddenReturn, skipped: false, boardAt: null };
    // requestAnimationFrame が止まる環境(非表示タブなど)でも進むよう、タイマーで補助する
    anim.timer = setInterval(() => { if (anim && performance.now() - anim.last > 150) step(performance.now()); }, 100);
    render();
    say('各馬ゲートイン完了。');
    requestAnimationFrame(tick);
  }

  let tv = null, ctxO, geo;
  function setupCanvases() {
    tv = KeibaTV.createTV($('#tv'), race, { mine: myHorses() });
    tv.resize();
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

  function say(text) {
    const sub = $('#tvSub');
    if (sub) sub.textContent = text;
    const ul = $('#comment');
    if (!ul) return;
    const li = document.createElement('li');
    li.textContent = `${E.formatTime(Math.max(0, anim.T))}  ${text}`;
    ul.prepend(li);
  }

  function commentary(pos) {
    const D = race.distance, s = anim.said;
    const order = race.horses.map((h, j) => j).sort((x, y) => pos[y] - pos[x]);
    const nm = j => `${race.horses[j].no}番 ${race.horses[j].name}`;
    const lead = pos[order[0]];
    const once = (key, text) => { if (!s.has(key)) { s.add(key); say(text); } };
    if (anim.T > 0.6) {
      const late = result.rows.filter(r => r.notes.includes('出遅れ')).map(r => `${r.no}番`);
      once('start', `スタートしました!${late.length ? ` ${late.join('、')}が出遅れ。` : ' 揃ったスタート。'}`);
    }
    if (lead > Math.min(400, D * 0.25)) once('early', `先手を取ったのは${nm(order[0])}、2番手に${nm(order[1])}。`);
    const seg = tv && anim.T > 6 ? tv.segment : ''; // 発走直後は位置の実況をしない
    if (seg === 'back') once('seg:back', `向正面。先頭${nm(order[0])}、後方に${race.horses[order[order.length - 1]].no}番。`);
    if (seg === 'c3') once('seg:c3', `3コーナーカーブ。先頭は${nm(order[0])}、${race.horses[order[1]].no}番が続く。`);
    if (seg === 'c4') once('seg:c4', `4コーナーを回って、直線コースへ!`);
    if (lead > D / 2) once('half', `${D / 2}m 通過。先頭${nm(order[0])}。`);
    if (lead > D - 600) once('600', `残り600m!各馬スパート。先頭${nm(order[0])}、${race.horses[order[1]].no}番、${race.horses[order[2]].no}番。`);
    if (lead > D - 200) once('200', `残り200m!${nm(order[0])}先頭、${nm(order[1])}が迫る!`);
    if (lead >= D) {
      const w = race.horses[result.order[0] - 1];
      once('goal', `${w.no}番 ${w.name}、1着でゴールイン!`);
    }
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
      const gap = finished.has(h.no) ? '' : k === 0 ? '' : `${((Math.min(lead, D) - pos[j]) / 2.4).toFixed(1)}馬身`;
      return `<li class="${mine.has(h.no) ? 'mine' : ''}">${waku(h.bracket, 'mini')}<b>${h.no}</b> ${esc(h.name)} <span class="sub">${gap}</span></li>`;
    }).join('');
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
      setTimeout(() => { if (anim === finished) { anim = null; render(); } }, finished.skipped ? 700 : 2600);
    }
  }

  window.addEventListener('resize', () => { if (anim && tv) { tv.resize(); setupCanvases(); } });

  // テストからの操作用
  window.__keiba = {
    get race() { return race; }, get result() { return result; }, get save() { return save; }, get anim() { return anim; }, get tv() { return tv; }, ui,
    get cur() { return curState(); }, schedule, nextKey, targetKey, rstate,
  };

  init();
})();
