/* マルチプレイの通信(ルームを作る人=ホストに、参加者がつながる星型)
 * 通常は PeerJS(WebRTC)でブラウザ同士を直接つなぐ。接続の仲介だけ PeerJS の公開サーバーを使う。
 * URL に ?net=local を付けると、同じブラウザ内のタブ・iframe 同士を BroadcastChannel でつなぐ(テスト用)。
 */
const KeibaNet = (() => {
  'use strict';
  const PREFIX = 'keibasim-';
  const PEER_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
  const LOCAL = /[?&]net=local\b/.test(location.search);
  // 読み間違えやすい文字(0/O・1/I など)を除いたルームコード
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const newCode = () => Array.from({ length: 5 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
  const randId = () => Math.random().toString(36).slice(2, 10);

  let peerLoading = null;
  function loadPeer() {
    if (window.Peer) return Promise.resolve();
    return peerLoading ||= new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = PEER_URL;
      s.onload = () => res();
      s.onerror = () => { peerLoading = null; rej(new Error('通信ライブラリを読み込めませんでした(インターネット接続を確認してください)')); };
      document.head.appendChild(s);
    });
  }
  const errText = e => ({
    'peer-unavailable': 'ルームが見つかりません。コードを確かめてください',
    network: 'サーバーにつながりません。インターネット接続を確かめてください',
    'server-error': 'サーバーにつながりません。しばらくしてからもう一度お試しください',
    'browser-incompatible': 'このブラウザはマルチプレイに対応していません',
  }[e && e.type] || (e && e.message) || '接続できませんでした');

  // ---------- ホスト ----------
  // h: { onJoin(id), onMsg(id, msg), onLeave(id) }。戻り値: { code, send(id, msg), broadcast(msg), close() }
  async function host(h) {
    if (LOCAL) return localHost(h);
    await loadPeer();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      try { return await peerHost(code, h); } catch (e) { if (e.type !== 'unavailable-id') throw new Error(errText(e)); }
    }
    throw new Error('ルームを作れませんでした。もう一度お試しください');
  }
  function peerHost(code, h) {
    return new Promise((res, rej) => {
      const peer = new window.Peer(PREFIX + code);
      const conns = new Map();
      let opened = false;
      const api = {
        code,
        send(id, msg) { const c = conns.get(id); if (c && c.open) c.send(msg); },
        broadcast(msg) { for (const c of conns.values()) if (c.open) c.send(msg); },
        close() { for (const c of conns.values()) c.close(); peer.destroy(); },
      };
      peer.on('open', () => { opened = true; res(api); });
      peer.on('error', e => { if (!opened) { peer.destroy(); rej(e); } });
      // 仲介サーバーとの接続が切れても、つながっている参加者とはそのまま続けられる。新しい参加のために再接続する
      peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch (e) { /* ignore */ } }, 1500); });
      peer.on('connection', conn => {
        conn.on('open', () => { conns.set(conn.peer, conn); h.onJoin(conn.peer); });
        conn.on('data', d => h.onMsg(conn.peer, d));
        conn.on('close', () => { if (conns.delete(conn.peer)) h.onLeave(conn.peer); });
        conn.on('error', () => { if (conns.delete(conn.peer)) h.onLeave(conn.peer); });
      });
    });
  }

  // ---------- 参加 ----------
  // h: { onMsg(msg), onClose() }。戻り値: { send(msg), close() }
  async function join(code, h) {
    code = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) throw new Error('ルームコードは英数字 5 文字です');
    if (LOCAL) return localJoin(code, h);
    await loadPeer();
    return new Promise((res, rej) => {
      const peer = new window.Peer();
      let done = false;
      const fail = e => { if (!done) { done = true; peer.destroy(); rej(new Error(errText(e))); } };
      const timer = setTimeout(() => fail({ message: 'ホストに接続できませんでした(時間切れ)' }), 15000);
      peer.on('error', e => { if (!done) fail(e); });
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code, { reliable: true });
        conn.on('open', () => {
          done = true; clearTimeout(timer);
          res({ send(msg) { if (conn.open) conn.send(msg); }, close() { conn.close(); peer.destroy(); } });
        });
        conn.on('data', d => h.onMsg(d));
        conn.on('close', () => { if (done) h.onClose(); });
        conn.on('error', () => { if (done) h.onClose(); });
      });
    });
  }

  // ---------- テスト用(同じブラウザ内) ----------
  function localHost(h) {
    const code = newCode(), ch = new BroadcastChannel(PREFIX + code), ids = new Set();
    ch.onmessage = ({ data: m }) => {
      if (m.to !== 'host') return;
      if (m.kind === 'open') { ids.add(m.from); ch.postMessage({ to: m.from, kind: 'ack' }); h.onJoin(m.from); }
      else if (m.kind === 'close') { if (ids.delete(m.from)) h.onLeave(m.from); }
      else if (ids.has(m.from)) h.onMsg(m.from, m.data);
    };
    return Promise.resolve({
      code,
      send(id, data) { ch.postMessage({ to: id, kind: 'msg', data }); },
      broadcast(data) { for (const id of ids) ch.postMessage({ to: id, kind: 'msg', data }); },
      close() { for (const id of ids) ch.postMessage({ to: id, kind: 'close' }); ch.close(); },
    });
  }
  function localJoin(code, h) {
    return new Promise((res, rej) => {
      const me = randId(), ch = new BroadcastChannel(PREFIX + code);
      const timer = setTimeout(() => { ch.close(); rej(new Error('ルームが見つかりません。コードを確かめてください')); }, 2000);
      ch.onmessage = ({ data: m }) => {
        if (m.to !== me) return;
        if (m.kind === 'ack') {
          clearTimeout(timer);
          res({ send(data) { ch.postMessage({ to: 'host', from: me, kind: 'msg', data }); }, close() { ch.postMessage({ to: 'host', from: me, kind: 'close' }); ch.close(); } });
        } else if (m.kind === 'msg') h.onMsg(m.data);
        else if (m.kind === 'close') { ch.close(); h.onClose(); }
      };
      ch.postMessage({ to: 'host', from: me, kind: 'open' });
    });
  }

  return { host, join, LOCAL };
})();
