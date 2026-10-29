// 効果音:重賞のファンファーレ(オリジナルの旋律)と観客の歓声。Web Audio で合成し、音源ファイルは使わない
(function (root) {
  'use strict';
  let ac = null, master = null, crowdGain = null, crowdSrc = null, enabled = true;
  const live = []; // 鳴っている音(停止用)

  function ctx() {
    if (ac) return ac;
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    try {
      ac = new AC();
      master = ac.createGain();
      master.gain.value = enabled ? 0.8 : 0;
      master.connect(ac.destination);
    } catch (e) { ac = null; }
    return ac;
  }

  const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function freq(name) {
    const m = /^([A-G])(#|b)?(\d)$/.exec(name);
    const semis = NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (+m[3] - 4) * 12 - 9;
    return 440 * Math.pow(2, semis / 12);
  }

  // 金管風の音(ノコギリ波 2 本 + フィルターの開きで「パッ」とした立ち上がり)
  function brass(t, f, dur, vol = 0.16) {
    const g = ac.createGain(), lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 2;
    lp.frequency.setValueAtTime(f * 1.5, t);
    lp.frequency.linearRampToValueAtTime(f * 6, t + 0.04);
    lp.frequency.exponentialRampToValueAtTime(f * 3.2, t + Math.min(dur, 0.35));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.03);
    g.gain.linearRampToValueAtTime(vol * 0.72, t + 0.12);
    g.gain.setValueAtTime(vol * 0.72, t + Math.max(0.12, dur - 0.06));
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.05);
    lp.connect(g); g.connect(master);
    [-5, 5].forEach(cents => {
      const o = ac.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = cents;
      if (dur > 0.6) { // 長い音にはビブラート
        const lfo = ac.createOscillator(), lg = ac.createGain();
        lfo.frequency.value = 5.5; lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(f * 0.006, t + dur);
        lfo.connect(lg); lg.connect(o.frequency); lfo.start(t); lfo.stop(t + dur + 0.1); live.push(lfo);
      }
      o.connect(lp); o.start(t); o.stop(t + dur + 0.1); live.push(o);
    });
  }

  // ティンパニ風(低いサイン波が少し下がる)
  function timpani(t, f, vol = 0.35) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(f * 1.08, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 1); live.push(o);
  }

  let noiseBuf = null;
  function noise() {
    if (!noiseBuf) {
      noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      let b = 0;
      for (let i = 0; i < d.length; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = b * 6 + (Math.random() * 2 - 1) * 0.25; }
    }
    return noiseBuf;
  }
  // 手拍子(観客がファンファーレに合わせて叩く)
  function clap(t, vol = 0.12) {
    for (let k = 0; k < 3; k++) {
      const s = ac.createBufferSource(), hp = ac.createBiquadFilter(), g = ac.createGain();
      s.buffer = noise(); hp.type = 'bandpass'; hp.frequency.value = 1400 + k * 500; hp.Q.value = 0.8;
      const tt = t + k * 0.012 + Math.random() * 0.01;
      g.gain.setValueAtTime(vol, tt); g.gain.exponentialRampToValueAtTime(0.001, tt + 0.09);
      s.connect(hp); hp.connect(g); g.connect(master);
      s.start(tt, Math.random()); s.stop(tt + 0.12); live.push(s);
    }
  }

  // 旋律:[音名 or 和音, 拍]。null は休符。G1 は長く、G2/G3 は短い版
  const T3 = 1 / 3;
  const SCORES = {
    g1: {
      bpm: 132,
      notes: [
        ['D4', T3], ['D4', T3], ['D4', T3], ['A4', 1.5], [null, 0.5],
        ['A4', T3], ['A4', T3], ['A4', T3], ['D5', 1.5], [null, 0.5],
        ['F#5', 0.5], ['E5', 0.5], ['D5', 0.5], ['E5', 0.5], ['F#5', 1], ['A5', 1],
        ['G5', 0.5], ['F#5', 0.5], ['E5', 0.5], ['F#5', 0.5], ['D5', 1.5], [null, 0.5],
        ['A4', 0.5], ['D5', 0.5], ['F#5', 0.5], ['A5', 1], ['B5', 0.5], [['A5', 'F#5', 'D5', 'A4'], 3.5],
      ],
      clapFrom: 9.5, // 何拍目から手拍子
    },
    g2: {
      bpm: 138,
      notes: [
        ['Bb4', T3], ['Bb4', T3], ['Bb4', T3], ['F5', 1.5], [null, 0.5],
        ['D5', 0.5], ['Eb5', 0.5], ['F5', 0.5], ['G5', 0.5], ['F5', 1], ['D5', 1],
        ['Eb5', 0.5], ['F5', 0.5], ['G5', 0.5], ['A5', 0.5], [['Bb5', 'F5', 'D5', 'Bb4'], 3],
      ],
      clapFrom: 3,
    },
  };

  function scoreFor(grade) { return SCORES[grade === 'g1' ? 'g1' : 'g2']; }
  function fanfareLength(grade) {
    const sc = scoreFor(grade);
    return sc.notes.reduce((a, n) => a + n[1], 0) * 60 / sc.bpm;
  }

  function fanfare(grade) {
    if (!ctx()) return;
    if (ac.state === 'suspended') ac.resume();
    const sc = scoreFor(grade), beat = 60 / sc.bpm;
    let t = ac.currentTime + 0.15, b = 0;
    for (const [nm, len] of sc.notes) {
      const dur = len * beat;
      if (nm) {
        const list = Array.isArray(nm) ? nm : [nm];
        list.forEach((x, i) => brass(t, freq(x), Math.max(0.09, dur * (len < 0.4 ? 0.8 : 0.95)), i ? 0.09 : 0.16));
        if (Array.isArray(nm)) { for (let k = 0; k < 8; k++) timpani(t + k * beat * 0.25, freq('D2') * (grade === 'g1' ? 1 : 0.94), 0.12 + k * 0.02); }
      }
      t += dur; b += len;
    }
    // 手拍子(拍の頭)と、終わりの歓声
    const total = sc.notes.reduce((a, n) => a + n[1], 0);
    for (let k = Math.ceil(sc.clapFrom); k < total - 2; k++) clap(ac.currentTime + 0.15 + k * beat, 0.07);
    crowd(0.05);
    swell(ac.currentTime + 0.15 + total * beat - 0.3, 0.32, 3.5);
  }

  // 観客のざわめき(連続音)。level 0〜1
  function crowd(level) {
    if (!ctx()) return;
    if (!crowdSrc) {
      crowdSrc = ac.createBufferSource(); crowdSrc.buffer = noise(); crowdSrc.loop = true;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.6;
      crowdGain = ac.createGain(); crowdGain.gain.value = 0;
      crowdSrc.connect(bp); bp.connect(crowdGain); crowdGain.connect(master);
      crowdSrc.start();
    }
    crowdGain.gain.setTargetAtTime(Math.max(0, level) * 0.5, ac.currentTime, 0.4);
  }
  // 歓声の盛り上がり(ゴール・ファンファーレの後)
  function swell(t, peak, len) {
    const s = ac.createBufferSource(), bp = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noise(); s.loop = true; bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.5;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + 0.6); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    s.connect(bp); bp.connect(g); g.connect(master); s.start(t); s.stop(t + len + 0.1); live.push(s);
  }
  function cheer() { if (ctx()) swell(ac.currentTime, 0.4, 4); }

  function stop() {
    while (live.length) { try { live.pop().stop(); } catch (e) { /* 既に停止 */ } }
    if (crowdGain) crowdGain.gain.setTargetAtTime(0, ac.currentTime, 0.2);
  }
  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) hush();
    if (master) master.gain.setTargetAtTime(enabled ? 0.8 : 0, ac.currentTime, 0.05);
  }

  // ---------- 実況の声(ブラウザの音声合成) ----------
  const synth = root.speechSynthesis || null;
  let voice = null, speaking = false, pending = null, voiceOn = true, rateBoost = 0;
  function pickVoice() {
    if (!synth) return;
    const ja = synth.getVoices().filter(v => /^ja/i.test(v.lang));
    // 男性のアナウンサー風の声を優先(macOS: Otoya / Hattori、Chrome: Google 日本語)
    const pref = ['Otoya', 'Hattori', 'Ichiro', 'Google 日本語', 'Kyoko', 'O-ren'];
    voice = pref.map(p => ja.find(v => v.name.includes(p))).find(Boolean) || ja[0] || null;
  }
  if (synth) { pickVoice(); try { synth.addEventListener('voiceschanged', pickVoice); } catch (e) { /* 古いブラウザ */ } }

  // 読み上げ用に表記を直す(数字・記号・距離など)
  function toSpeech(text) {
    return text
      .replace(/(\d+):(\d{2})\.(\d)/g, '$1分$2秒$3')
      .replace(/(\d+)m/g, '$1メートル')
      .replace(/G1/g, 'ジーワン').replace(/G2/g, 'ジーツー').replace(/G3/g, 'ジースリー')
      .replace(/(\d)\.1\/2馬身/g, '$1馬身半')
      .replace(/!/g, '!').replace(/、/g, '、 ');
  }
  function speakNow(item) {
    const u = new SpeechSynthesisUtterance(toSpeech(item.text));
    u.lang = 'ja-JP';
    if (voice) u.voice = voice;
    const excited = /!/.test(item.text);
    u.rate = Math.min(2, 1.12 + rateBoost + (excited ? 0.12 : 0));
    u.pitch = excited ? 1.15 : 1.0;
    u.volume = 1;
    speaking = true;
    u.onend = u.onerror = () => { speaking = false; if (pending) { const p = pending; pending = null; speakNow(p); } };
    synth.speak(u);
  }
  // urgent: 直線の攻防やゴールなど、今しゃべっている途中でも切り替える台詞
  function speak(text, urgent = false) {
    if (!synth || !voiceOn || !enabled) return;
    const item = { text };
    if (speaking && urgent) { pending = null; synth.cancel(); speaking = false; speakNow(item); return; }
    if (speaking) { pending = item; return; } // 溜めずに最新の 1 本だけ待たせる
    speakNow(item);
  }
  function hush() { pending = null; speaking = false; if (synth) synth.cancel(); }
  function setVoice(on) { voiceOn = !!on; if (!voiceOn) hush(); }
  // 再生速度が上がるほど早口に
  function setPace(speed) { rateBoost = speed >= 4 ? 0.45 : speed >= 2 ? 0.2 : 0; }

  root.KeibaSound = {
    fanfare, fanfareLength, crowd, cheer, stop, setEnabled, speak, hush, setVoice, setPace,
    get enabled() { return enabled; }, get canSpeak() { return !!synth; },
  };
})(typeof self !== 'undefined' ? self : this);
