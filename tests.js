/* エンジンのテスト。test.html をブラウザ(ヘッドレス可)で開くと実行される */
(function () {
  const E = KeibaEngine;
  const results = [];
  function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, msg: e.message }); }
  }
  function eq(a, b, msg) {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || ''} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
  }
  function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function throws(fn, re) {
    try { fn(); } catch (e) { if (re && !re.test(e.message)) throw new Error('unexpected error: ' + e.message); return; }
    throw new Error('should throw');
  }
  function raceWithN(n, seed0 = 1) {
    for (let s = seed0; s < seed0 + 5000; s++) {
      const r = E.generateRace({ seed: s, raceNo: 1 + (s % 12), venueIdx: s % 6 });
      if (r.n === n) return r;
    }
    throw new Error('no race with n=' + n);
  }

  // --- 枠番 ---
  test('枠番の割り当て(JRA 方式)', () => {
    eq(E.bracketCounts(8), [1, 1, 1, 1, 1, 1, 1, 1]);
    eq(E.bracketCounts(10), [1, 1, 1, 1, 1, 1, 2, 2]);
    eq(E.bracketCounts(16), [2, 2, 2, 2, 2, 2, 2, 2]);
    eq(E.bracketCounts(18), [2, 2, 2, 2, 2, 2, 3, 3]);
    eq(E.bracketOf(1, 18), 1);
    eq(E.bracketOf(15, 18), 7);
    eq(E.bracketOf(16, 18), 8);
    eq(E.bracketOf(9, 10), 8);
    eq(E.bracketOf(8, 10), 7);
  });

  // --- 払戻計算 ---
  test('払戻は10円未満切り捨て・最低100円', () => {
    eq(E.payFromOdds(0.888), 100);
    eq(E.payFromOdds(3.456), 340);
    eq(E.payFromOdds(12.0), 1200);
    eq(E.payFromOdds(1.0), 100);
  });

  test('タイム表記', () => {
    eq(E.formatTime(93.44), '1:33.4');
    eq(E.formatTime(68.96), '1:09.0');
    eq(E.formatTime(59.94), '59.9');
  });

  // --- 決定性 ---
  test('同じシードなら同じレース・同じ結果', () => {
    const a = E.generateRace({ seed: 42, raceNo: 11, venueIdx: 0 });
    const b = E.generateRace({ seed: 42, raceNo: 11, venueIdx: 0 });
    eq(a.horses.map(h => h.name), b.horses.map(h => h.name));
    eq(a.market.winPay, b.market.winPay);
    eq(E.runRace(a).order, E.runRace(b).order);
    const c = E.generateRace({ seed: 43, raceNo: 11, venueIdx: 0 });
    ok(JSON.stringify(c.horses.map(h => h.name)) !== JSON.stringify(a.horses.map(h => h.name)), '別シードは別レース');
  });

  test('出馬表の整合性', () => {
    for (let s = 1; s <= 30; s++) {
      const r = E.generateRace({ seed: s, raceNo: 1 + (s % 12), venueIdx: s % 6 });
      ok(r.n >= 8 && r.n <= 18, '頭数');
      eq(r.horses.map(h => h.no), Array.from({ length: r.n }, (_, i) => i + 1));
      ok(new Set(r.horses.map(h => h.name)).size === r.n, '馬名重複');
      ok(new Set(r.horses.map(h => h.jockey.name)).size === r.n, '騎手重複');
      ok(r.horses.every(h => h.name.length <= 9), '馬名は9文字以内');
      ok(r.horses.every(h => h.kinryo >= 50 && h.kinryo <= 59), '斤量');
      const sumP = r.probs.win.reduce((a, b) => a + b, 0);
      ok(Math.abs(sumP - 1) < 1e-9, '勝率の合計=1');
      const sumQ = r.market.q.reduce((a, b) => a + b, 0);
      ok(Math.abs(sumQ - 1) < 1e-9, '支持率の合計=1');
      eq([...r.market.pop].sort((a, b) => a - b), Array.from({ length: r.n }, (_, i) => i + 1), '人気順');
    }
  });

  // --- 戦績(馬柱) ---
  test('戦績はクラスと整合(勝利数・クラス昇級・日付・数値範囲)', () => {
    const need = { maiden: 0, c1: 1, c2: 2, c3: 3 };
    for (let s = 200; s < 260; s++) {
      const race = E.generateRace({ seed: s, raceNo: 1 + (s % 12), venueIdx: s % 6, day: 1 + (s % 5) });
      for (const h of race.horses) {
        const c = h.career;
        ok(c.length >= 1 && h.past.length === Math.min(5, c.length), '戦績数');
        const wins = h.records.all[0];
        if (race.cls.key in need) eq(wins, need[race.cls.key], `${race.cls.name} の勝利数`);
        else ok(wins >= 4, 'オープン以上は4勝以上');
        eq(h.records.all.reduce((a, b) => a + b, 0), c.length, '通算成績の合計');
        // 新しい順・当日より前
        ok(c[0].date < race.date, '前走は当日より前');
        for (let k = 1; k < c.length; k++) ok(c[k].date < c[k - 1].date, '日付は新しい順');
        // 未勝利馬は未勝利(新馬)戦のみ、条件馬は最後の勝利以降は現クラス
        if (race.cls.key in need) {
          const lastWin = c.findIndex(r => r.pos === 1);
          const since = lastWin === -1 ? c : c.slice(0, lastWin);
          ok(since.every(r => r.cls.key === race.cls.key), '勝利後は現クラスで走る');
        }
        // 新馬戦は 2 歳時のデビュー戦だけ。デビューは 2 歳の 6 月以降
        const debut = c[c.length - 1], y = new Date(race.date).getUTCFullYear();
        const ageAt = r => h.age - (y - new Date(r.date).getUTCFullYear());
        ok(ageAt(debut) >= 2 && debut.date >= Date.UTC(y - (h.age - 2), 5, 1), `デビュー時期 ${debut.dateLabel} ${h.age}歳`);
        eq(debut.raceName === '新馬', ageAt(debut) === 2, '新馬戦は2歳デビューのみ');
        ok(c.slice(0, -1).every(r => r.raceName !== '新馬'), '新馬戦はデビュー戦だけ');
        if (race.cls.key === 'maiden') eq(h.age, 3, '未勝利戦は3歳限定');
        for (const r of c) {
          ok(r.pos >= 1 && r.pos <= r.field && r.pop >= 1 && r.pop <= r.field && r.no <= r.field, '着順・人気・馬番');
          ok(r.passing.split('-').every(x => +x >= 1 && +x <= r.field), '通過順 ' + r.passing);
          ok(r.last3f > 31 && r.last3f < 42, '上がり ' + r.last3f);
          ok((r.pos === 1) === (r.diff < 0) || (r.pos > 1 && r.diff === 0), 'タイム差の符号');
          const course = E.COURSES.find(x => x.venue === r.venue);
          ok(course[r.surface === '芝' ? 'turf' : 'dirt'].includes(r.dist), '実在する距離 ' + r.venue + r.surface + r.dist);
        }
        eq(c[0].weight, h.bodyWeight - h.bodyDiff, '前走馬体重 + 増減 = 当日馬体重');
      }
    }
  });

  test('近走成績は予想の材料になる(近走上位の馬ほど勝ちやすい)', () => {
    let best = 0, worst = 0;
    for (let s = 300; s < 380; s++) {
      const race = E.generateRace({ seed: s, raceNo: 1 + (s % 12), venueIdx: s % 6 });
      const score = h => h.past.reduce((a, r) => a + r.pos / r.field, 0) / h.past.length;
      const sorted = race.horses.slice().sort((a, b) => score(a) - score(b));
      best += race.probs.win[sorted[0].no - 1];
      worst += race.probs.win[sorted[sorted.length - 1].no - 1];
    }
    ok(best > worst * 3, `近走最上位の平均勝率 ${(best / 80).toFixed(3)} vs 最下位 ${(worst / 80).toFixed(3)}`);
  });

  test('開催日', () => {
    eq(E.fmtDate(E.generateRace({ seed: 1, day: 1 }).date, true), '2026年10月31日(土)');
    eq(E.generateRace({ seed: 1, day: 2 }).dateLabel, '2026年11月1日(日)');
    eq(E.generateRace({ seed: 1, day: 3 }).dateLabel, '2026年11月7日(土)');
  });

  test('馬名・騎手名(作り方の多様さ・著名馬と不一致・9文字以内・重複なし)', () => {
    const fixed = [...E.NAME_WITTY, ...E.NAME_JP, ...E.NAME_PHRASE];
    ok(fixed.every(nm => nm.length <= 9), '9文字超: ' + fixed.filter(nm => nm.length > 9).join(','));
    eq(new Set(fixed).size, fixed.length, '固定名リストの重複');
    const famous = new Set(E.FAMOUS_HORSES);
    ok(!fixed.some(nm => famous.has(nm)), '固定名に著名馬: ' + fixed.filter(nm => famous.has(nm)).join(','));
    eq(new Set(E.JOCKEYS.map(j => j[0])).size, E.JOCKEYS.length, '騎手名の重複');
    // 大量に生成して、作り方の比率と著名馬との不一致を確認
    const rng = E.mulberry32(7), used = new Set(), kinds = {};
    for (let i = 0; i < 1500; i++) {
      if (used.size > 600) used.clear();
      const { name, kind } = E.horseNameKind(rng, used);
      ok(name.length <= 9 && !famous.has(name), '馬名: ' + name);
      kinds[kind] = (kinds[kind] || 0) + 1;
    }
    eq(Object.keys(kinds).length, 6, '作り方が6種類とも出る');
    const hist = ((kinds.witty || 0) + (kinds.history || 0)) / 1500;
    ok(hist > 0.1 && hist < 0.3, `人物・故事系の割合 ${hist.toFixed(2)}`);
    // 実際のレースでも人物・故事系に偏っていない
    let total = 0, histN = 0;
    for (let s = 1; s <= 40; s++) {
      const r = E.generateRace({ seed: s, raceNo: 1 + (s % 12), venueIdx: s % 6, light: true });
      r.horses.forEach(h => { total++; if (E.NAME_WITTY.includes(h.name)) histN++; });
    }
    ok(histN / total < 0.25, `レース内のもじり名の割合 ${(histN / total).toFixed(2)}`);
  });

  test('予想家の印(各自 ◎○▲△△☆・見立ての違い)', () => {
    eq(E.TIPSTERS.length, 5);
    const expWin = {}, favHonmei = {};
    E.TIPSTERS.forEach(t => { expWin[t.id] = 0; favHonmei[t.id] = 0; });
    let differ = 0;
    for (let s = 400; s < 440; s++) {
      const r = E.generateRace({ seed: s, raceNo: 1 + (s % 12), venueIdx: s % 6 });
      const tips = r.market.tips;
      eq(tips.length, 5);
      for (const [k, t] of tips.entries()) {
        const cnt = m => t.marks.filter(x => x === m).length;
        eq([cnt('◎'), cnt('○'), cnt('▲'), cnt('△')], [1, 1, 1, 2], '印の数 ' + E.TIPSTERS[k].name);
        ok(cnt('☆') <= 1, '☆は1頭まで');
        const star = t.marks.indexOf('☆');
        if (star >= 0) ok(r.market.pop[star] >= 6, '☆は6番人気以下');
        const h = t.marks.indexOf('◎');
        expWin[t.id] += r.probs.win[h];
        if (r.market.pop[h] === 1) favHonmei[t.id]++;
      }
      if (new Set(tips.map(t => t.marks.indexOf('◎'))).size > 1) differ++;
    }
    ok(differ >= 20, `予想家で◎が分かれる ${differ}/40`);
    ok(expWin.kazumi > expWin.anai, `データ派の◎は穴党より勝ちやすい ${expWin.kazumi.toFixed(2)} > ${expWin.anai.toFixed(2)}`);
    ok(favHonmei.katata > favHonmei.anai, `本命党は1番人気に◎を打ちやすい ${favHonmei.katata} > ${favHonmei.anai}`);
  });

  // --- 馬券の展開 ---
  test('ボックス・ながし・フォーメーションの点数', () => {
    const r = raceWithN(16);
    const n = (type, method, sel) => E.expandCombos(r, type, method, sel).length;
    eq(n('quinella', 'box', { list: [1, 2, 3, 4, 5] }), 10);
    eq(n('exacta', 'box', { list: [1, 2, 3, 4] }), 12);
    eq(n('trifecta', 'box', { list: [1, 2, 3, 4] }), 24);
    eq(n('trio', 'box', { list: [1, 2, 3, 4, 5] }), 10);
    eq(n('win', 'box', { list: [3, 7, 9] }), 3);
    eq(n('exacta', 'nagashi', { axis: 1, others: [2, 3, 4] }), 3);
    eq(n('trio', 'nagashi', { axis: 1, others: [2, 3, 4, 5] }), 6);
    eq(n('trifecta', 'nagashi', { axis: 1, others: [2, 3, 4] }), 6);
    eq(n('trifecta', 'formation', { cols: [[1], [2, 3], [2, 3, 4]] }), 4);
    eq(n('quinella', 'formation', { cols: [[1, 2], [1, 2, 3]] }), 3);
    eq(E.expandCombos(r, 'quinella', 'normal', { picks: [5, 2] }), [[2, 5]]);
    eq(E.expandCombos(r, 'exacta', 'normal', { picks: [5, 2] }), [[5, 2]]);
  });

  test('枠連:ゾロ目は同枠2頭以上のときだけ、8頭以下は発売なし', () => {
    const r10 = raceWithN(10);
    throws(() => E.expandCombos(r10, 'bracket', 'normal', { picks: [1, 1] }), /成立/);
    eq(E.expandCombos(r10, 'bracket', 'normal', { picks: [7, 7] }), [[7, 7]]);
    eq(E.expandCombos(r10, 'bracket', 'normal', { picks: [8, 3] }), [[3, 8]]);
    const r8 = raceWithN(8);
    ok(!E.bracketSold(r8));
    throws(() => E.expandCombos(r8, 'bracket', 'normal', { picks: [1, 2] }), /発売/);
    eq(E.runRace(r8).payouts.bracket, null);
  });

  test('不正な投票はエラー', () => {
    const r = raceWithN(12);
    throws(() => E.createTicket(r, { type: 'win', method: 'normal', sel: { picks: [1] }, stake: 150 }), /100円単位/);
    throws(() => E.createTicket(r, { type: 'win', method: 'normal', sel: { picks: [1] }, stake: 0 }), /100円単位/);
    throws(() => E.createTicket(r, { type: 'win', method: 'normal', sel: { picks: [13] }, stake: 100 }), /存在しない/);
    throws(() => E.createTicket(r, { type: 'quinella', method: 'normal', sel: { picks: [1] }, stake: 100 }), /2つ/);
    throws(() => E.createTicket(r, { type: 'quinella', method: 'normal', sel: { picks: [3, 3] }, stake: 100 }), /成立/);
    throws(() => E.createTicket(r, { type: 'trio', method: 'box', sel: { list: [1, 2] }, stake: 100 }), /3つ以上/);
    throws(() => E.createTicket(r, { type: 'win', method: 'nagashi', sel: { axis: 1, others: [2] }, stake: 100 }), /ながし/);
    const t = E.createTicket(r, { type: 'trio', method: 'box', sel: { list: [1, 2, 3, 4] }, stake: 300 });
    eq(t.cost, 1200);
  });

  // --- 精算 ---
  test('払戻表と的中判定', () => {
    for (let s = 100; s < 130; s++) {
      const race = E.generateRace({ seed: s, raceNo: 1 + (s % 12), venueIdx: s % 6 });
      const res = E.runRace(race);
      const [a, b, c] = res.order;
      const p = res.payouts;
      eq(p.win[0].pay, race.market.winPay[a - 1], '単勝払戻');
      eq(p.place.map(x => x.combo[0]), [a, b, c], '複勝対象');
      ok(p.place.every(x => x.pay >= 100 && x.pay % 10 === 0), '複勝金額');
      eq(p.wide.length, 3, 'ワイドは3組');
      eq(p.trifecta[0].combo, [a, b, c]);
      ok(Object.values(p).every(list => !list || list.every(x => x.pay >= 100 && x.pay % 10 === 0)), '全払戻が10円単位で100円以上');
      // 3連単 全通りボックス → ちょうど1点的中
      const all = race.horses.map(h => h.no);
      const t = E.createTicket(race, { type: 'trifecta', method: 'box', sel: { list: all.slice(0, Math.min(all.length, 8)) }, stake: 100 });
      const inTop = [a, b, c].every(x => x <= 8);
      eq(E.ticketReturn(t, p).hits.length, inTop ? 1 : 0);
      // 金額比例
      const w = E.createTicket(race, { type: 'win', method: 'normal', sel: { picks: [a] }, stake: 500 });
      eq(E.ticketReturn(w, p).total, p.win[0].pay * 5);
      const lose = E.createTicket(race, { type: 'win', method: 'normal', sel: { picks: [res.order[race.n - 1]] }, stake: 100 });
      eq(E.ticketReturn(lose, p).total, 0);
      // ワイドは 1-3 着のどの 2 頭でも的中
      const wd = E.createTicket(race, { type: 'wide', method: 'normal', sel: { picks: [c, a] }, stake: 100 });
      eq(E.ticketReturn(wd, p).hits.length, 1);
    }
  });

  test('複勝:人気薄ほど払戻が高く、範囲は min ≤ max', () => {
    const race = raceWithN(16);
    const fav = race.market.pop.indexOf(1) + 1, last = race.market.pop.indexOf(16) + 1;
    const rf = E.placeRange(race, fav), rl = E.placeRange(race, last);
    ok(rf.min <= rf.max && rl.min <= rl.max);
    ok(rl.min > rf.max, '最低人気の複勝は1番人気より高い');
  });

  test('オッズは控除率と整合(大衆の確率で期待値=1-控除率)', () => {
    const race = raceWithN(14);
    const nos = race.horses.map(h => h.no);
    for (const type of ['quinella', 'exacta', 'wide', 'trio']) {
      const bt = E.BET[type];
      // 全通り買い 1 点あたりの期待回収率
      const combos = E.expandCombos(race, type, 'box', { list: nos });
      let ev = 0;
      for (const c of combos) ev += E.comboProb(race, type, c) * E.odds(race, type, c) / 100;
      ev /= combos.length;
      const target = 1 - bt.takeout;
      ok(ev > target - 0.06 && ev < target + 0.06, `${type} EV ${ev.toFixed(3)} vs ${target}`);
    }
    let evWin = 0;
    nos.forEach(no => { evWin += race.market.q[no - 1] * race.market.winPay[no - 1] / 100; });
    evWin /= nos.length;
    ok(evWin > 0.77 && evWin < 0.83, '単勝 EV ' + evWin.toFixed(3));
  });

  // --- シミュレーションの現実味 ---
  test('統計的な現実味(1番人気勝率・タイム・上がり)', () => {
    const N = 150;
    let fav = 0, favTop3 = 0;
    const mile = [];
    for (let s = 5000; s < 5000 + N; s++) {
      const race = E.generateRace({ seed: s, raceNo: 1 + (s % 12), venueIdx: s % 6 });
      const res = E.runRace(race);
      const popOf = no => race.market.pop[no - 1];
      if (popOf(res.order[0]) === 1) fav++;
      if (res.order.slice(0, 3).some(no => popOf(no) === 1)) favTop3++;
      for (let k = 1; k < res.rows.length; k++) ok(res.rows[k].time >= res.rows[k - 1].time, 'タイム順');
      ok(res.rows.every(r => r.last3f > 31 && r.last3f < 42), '上がり3F ' + res.rows.map(r => r.last3f.toFixed(1)));
      if (race.surface === '芝' && race.distance === 1600) mile.push(res.rows[0].time);
    }
    const fw = fav / N, ft = favTop3 / N;
    ok(fw > 0.25 && fw < 0.45, '1番人気勝率 ' + fw);
    ok(ft > 0.55 && ft < 0.78, '1番人気複勝率 ' + ft);
    mile.sort((a, b) => a - b);
    const med = mile[mile.length >> 1];
    ok(med > 90 && med < 96, '芝1600 勝ちタイム中央値 ' + med);
  });

  test('着差表記', () => {
    eq(E.marginText(0.005, 16.5), 'ハナ');
    eq(E.marginText(0.15, 16.5), '1');
    eq(E.marginText(5, 16.5), '大差');
  });

  // --- 中継映像 ---
  test('中継映像:カメラワークの順序・先頭馬が画面内・横位置がコース内', () => {
    const cv = document.createElement('canvas');
    cv.style.cssText = 'width:960px;height:540px;position:absolute;left:-9999px';
    document.body.appendChild(cv);
    const checked = new Set();
    for (let s = 900; s < 940 && checked.size < 6; s++) {
      const race = E.generateRace({ seed: s, raceNo: 1 + (s % 12), venueIdx: s % 6 });
      if (checked.has(race.venue)) continue;
      checked.add(race.venue);
      const res = E.runRace(race);
      // 1 場目は重賞のファンファーレ(スタンド撮り)から始める
      const fan = checked.size === 1;
      const tv = KeibaTV.createTV(cv, race, fan ? { prelude: -3, preludeStart: -12 } : {});
      tv.resize();
      const shots = [];
      const endT = (res.frames.length - 1) * res.dt;
      let offscreen = 0, frames = 0, overlaps = 0, pairs = 0, stretchFrames = 0, stretchMiss = 0;
      for (let T = fan ? -12 : -3; T <= endT; T += 0.1) {
        const t = Math.max(0, T), i = Math.min(res.frames.length - 2, Math.floor(t / res.dt)), fr = Math.min(1, t / res.dt - i);
        const pos = race.horses.map((_, j) => res.frames[i][j] + (res.frames[i + 1][j] - res.frames[i][j]) * fr);
        tv.render(T, pos, 0);
        if (shots[shots.length - 1] !== tv.shot) shots.push(tv.shot);
        const lead = pos.indexOf(Math.max(...pos));
        if (['side', 'goal', 'high', 'corner'].includes(tv.shot) && T > 3) {
          frames++;
          const p = tv.screenOf(pos[lead] - 1, 1.3, tv.lanes[lead]);
          if (!p || p.x < 0 || p.x > tv.size.W) offscreen++;
        }
        if (tv.shot === 'stretch') {
          // 斜め上からの直線映像:上位 5 頭が画面内に収まり、順位が見て分かる
          const top = race.horses.map((_, j) => j).sort((a, b) => pos[b] - pos[a]).slice(0, 5);
          for (const j of top) {
            stretchFrames++;
            const p = tv.screenOf(pos[j] - 1, 1.3, tv.lanes[j]);
            if (!p || p.x < 0 || p.x > tv.size.W || p.y < 0 || p.y > tv.size.H) stretchMiss++;
          }
          ok(tv.camera.y >= 20 && tv.camera.pitch > 0.2, `直線は高い位置から見下ろす ${race.venue}`);
        }
        ok(tv.lanes.every(l => l >= 0 && l <= KeibaTV.TRACK_W), '横位置がコース内');
        // すり抜け(体が重なる)がないか:前後 3m 以内で横 0.9m 未満に並ぶ組
        for (let x = 0; x < race.n; x++) for (let y = x + 1; y < race.n; y++) {
          if (pos[x] > 30 && pos[y] > 30) { pairs++; if (Math.abs(pos[x] - pos[y]) < 3 && Math.abs(tv.lanes[x] - tv.lanes[y]) < 0.9) overlaps++; }
        }
      }
      const label = `${race.venue}${race.surface}${race.distance}: ${shots.join('→')}`;
      if (fan) eq(shots.slice(0, 2), ['stands', 'gate'], 'ファンファーレ(スタンド)→ ゲート ' + label);
      else eq(shots[0], 'gate', 'ゲートから始まる ' + label);
      ok(shots.includes('corner'), 'コーナーのカットあり ' + label);
      ok(shots.indexOf('stretch') > 0 && shots.indexOf('stretch') < shots.lastIndexOf('goal'), '直線(斜め上)→ ゴール前 ' + label);
      ok(stretchMiss / Math.max(1, stretchFrames) < 0.02, `直線映像で上位5頭が画面外 ${stretchMiss}/${stretchFrames} ${label}`);
      eq(shots[shots.length - 1], 'goal', 'ゴール前で終わる ' + label);
      ok(offscreen / frames < 0.01, `先頭馬が画面外 ${offscreen}/${frames} ${label}`);
      ok(overlaps === 0, `馬同士の重なり ${overlaps}/${pairs} ${label}`);
    }
    cv.remove();
    ok(checked.size >= 4, '複数の競馬場で確認');
  });

  window.__testResults = results;
  const pass = results.filter(r => r.ok).length;
  const el = document.getElementById('out');
  el.textContent = `RESULT ${pass}/${results.length} passed\n` +
    results.map(r => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ' :: ' + r.msg}`).join('\n');
})();
