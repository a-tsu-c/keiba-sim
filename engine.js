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
  const EARLY = { 逃げ: 1.013, 先行: 1.005, 差し: 0.996, 追込: 0.990 };
  const KICK_STYLE = { 逃げ: 0.6, 先行: 0.85, 差し: 1.15, 追込: 1.2 };
  const GOING = ['良', '稍重', '重', '不良'];

  // 馬名:実在の命名パターン(冠名・外国語の組み合わせ・和名・文章型・故事のもじり)を参考にした架空の名前。
  // JRA の馬名は 9 文字以内。著名馬の名前は FAMOUS_HORSES で除外する。
  // 冠名(馬主の固定プレフィックス)はすべて架空のもの
  const CROWNS = ['トキワ', 'ミナモ', 'カザハナ', 'アオバ', 'ツクヨ', 'オボロ', 'コハク', 'ナギサ', 'カスミ',
    'ホムラ', 'イブキ', 'タマユラ', 'ルリ', 'アカネ', 'ハヤセ', 'キララ', 'ミソラ', 'サザナミ',
    'シズク', 'ヒスイ', 'ツバキ', 'マホロ', 'アヤメ', 'スバル', 'ハルカ', 'ユウヒ', 'カナデ', 'イロハ', 'トワ', 'アマネ'];
  const CROWN_WORDS = ['ラプソディ', 'セレナーデ', 'アリア', 'フォルテ', 'カデンツァ', 'エトワール', 'ソレイユ', 'ミラージュ',
    'テンペスト', 'ノクターン', 'カノン', 'ブリーズ', 'ヴェール', 'ルミナス', 'フィエスタ', 'ボヌール', 'プリマ', 'ドルチェ',
    'ヴィータ', 'アモーレ', 'ルーチェ', 'ステラ', 'ノヴァ', 'オリオン', 'シリウス', 'ベガ', 'アトラス', 'パッション',
    'クエスト', 'タクト', 'リズム', 'ビバーチェ', 'レガート', 'ロンド', 'ワルツ', 'ポルカ', 'タンゴ', 'ボレロ', 'サンバ', 'エール',
    'ブーケ', 'シエル', 'リアン', 'ミュゼ', 'ラルム', 'ノエル', 'ソラーレ', 'アステル', 'ルナ', 'セーラ', 'ティアラ', 'ジェンマ',
    'アルテ', 'ポエタ', 'カンタータ', 'メヌエット', 'フーガ', 'ガヴォット', 'マーチ', 'エチュード', 'ララバイ', 'オペラ',
    'クラウン', 'ブレイズ', 'グロリア', 'ヴェルデ', 'ロッソ', 'ビアンカ', 'ネロ', 'アズーロ', 'ドーロ', 'ステップ'];
  // 外国語の形容詞+名詞
  const FOREIGN_A = ['ブライト', 'ワイルド', 'ラッキー', 'ミスティ', 'ノーブル', 'スウィート', 'クール', 'エターナル', 'グラン',
    'ロイヤル', 'サニー', 'ゴールデン', 'クリスタル', 'ハッピー', 'アンバー', 'コバルト', 'ジェイド', 'フライング', 'ダンシング',
    'ラピッド', 'ヴィヴィッド', 'ジェントル', 'マジカル', 'フェアリー', 'ブルーム', 'ミスター', 'リトル', 'ハイランド',
    'スカイ', 'シルバー', 'ルビー', 'ブルー', 'レッド', 'グリーン', 'ホワイト', 'ダーク', 'ソニック', 'ダイナ', 'ハイパー', 'スーパー',
    'ネオ', 'プライム', 'トップ', 'ベスト', 'ファイン', 'スマート', 'ストロング', 'ビッグ', 'ゴールド', 'ムーン', 'サン', 'スター', 'ワンダー'];
  const FOREIGN_B = ['ストーム', 'メロディ', 'ハーバー', 'キャンドル', 'ランタン', 'コンパス', 'ミラクル', 'ジャーニー', 'トレイル',
    'パレード', 'カーニバル', 'コメット', 'ファルコン', 'アンセム', 'ベル', 'ステップ', 'リーフ', 'ブーケ', 'ティアラ',
    'ウィスパー', 'ソナタ', 'ヒーロー', 'レディ', 'ナイト', 'アロー', 'フェザー', 'ハニー', 'ポエム', 'ジュエル', 'ロケット',
    'ウイング', 'ボルト', 'フレア', 'ゲイル', 'ウェーブ', 'リバー', 'レイク', 'ヒル', 'ピーク', 'ロード', 'ゲート', 'タワー', 'キャッスル',
    'ダンサー', 'ランナー', 'シーカー', 'ドリーマー', 'キング', 'クイーン', 'プリンス', 'エンペラー', 'ナイツ', 'ハート', 'ソウル',
    'ライト', 'ファイア', 'スノー', 'レイン', 'ブリザード', 'サンダー', 'ジェット', 'ダッシュ'];
  // 和名(季語・自然・花鳥風月)
  const NAME_JP = ['ユキアカリ', 'ツキミソウ', 'ハナフブキ', 'アサツユ', 'ホシカゲ', 'カゼマチ', 'アキアカネ', 'ウミツバメ', 'ヒグラシ',
    'ナツゾラ', 'ミカヅキ', 'シグレ', 'コガラシ', 'ハルガスミ', 'ユウヅキ', 'アマノガワ', 'カゲロウ', 'ホタルビ', 'ヨイヤミ',
    'ツユクサ', 'ナデシコ', 'キキョウ', 'リンドウ', 'ヤマブキ', 'スズラン', 'ワスレナグサ', 'シラナミ', 'オキツカゼ', 'イカヅチ',
    'ムラクモ', 'ユウダチ', 'サミダレ', 'ハツユキ', 'コナユキ', 'オボロヅキ', 'イザヨイ', 'マチヨイグサ', 'カワセミ', 'ツバクロ',
    'ミズバショウ', 'コモレビ', 'ユウバエ', 'アカツキ', 'ヨアケマエ', 'ハツヒノデ', 'オオゾラ', 'ハルイチバン', 'キタカゼ',
    'カチドキ', 'ハレノヒ', 'アオアラシ', 'ホシマツリ', 'ナツマツリ', 'ユキゲシキ'];
  // 和名の組み合わせ(○○ノ○○)
  const JP_A = ['ハルノ', 'ナツノ', 'アキノ', 'フユノ', 'ユメノ', 'ホシノ', 'ツキノ', 'ソラノ', 'ウミノ', 'モリノ', 'カワノ', 'ヤマノ', 'ハナノ', 'カゼノ', 'ヨルノ', 'アサノ'];
  const JP_B = ['カゼ', 'ソラ', 'ヒカリ', 'ウタ', 'ミチ', 'オト', 'ハナ', 'ユキ', 'アメ', 'ニジ', 'ツバサ', 'トビラ', 'シズク', 'ホムラ', 'イブキ', 'ササヤキ', 'カオリ', 'ナミ'];
  // 文章型(実在の馬にも多い、ひとこと風の名前)
  const NAME_PHRASE = ['マタアシタネ', 'イマダケヲミテ', 'ゴハンオカワリ', 'ネコノテモカリタイ', 'アシタハハレ', 'キョウモゲンキ',
    'オトナノジジョウ', 'ハヤクオウチニ', 'モウイッカイ', 'ナイショノハナシ', 'ヨソミシナイデ', 'オサキニシツレイ', 'ヒルネシタイ',
    'ノンビリイコウ', 'マケルキナイ', 'ワスレモノナイ', 'カギシメタッケ', 'コンヤハカレー', 'ゴールハアッチ', 'マクッテマクッテ',
    'ゼンリョクシッソウ', 'ワタシマツワ', 'アトデヤル', 'チョットマッテ', 'ソレデイイノダ', 'ナントカナル', 'ヤルトキハヤル',
    'オヤツハサンビャク', 'カミダノミ', 'ウンモジツリョク'];
  // 著名な実在馬(JRA でも G1 馬などの名前は再使用できない)。生成された名前がこれと一致したら作り直す
  const FAMOUS_HORSES = ['シンザン', 'ハイセイコー', 'テンポイント', 'トウショウボーイ', 'ミスターシービー', 'シンボリルドルフ',
    'オグリキャップ', 'トウカイテイオー', 'メジロマックイーン', 'ミホノブルボン', 'ライスシャワー', 'ナリタブライアン',
    'ビワハヤヒデ', 'サイレンススズカ', 'スペシャルウィーク', 'エルコンドルパサー', 'グラスワンダー', 'テイエムオペラオー',
    'マンハッタンカフェ', 'ハルウララ', 'マヤノトップガン', 'サクラバクシンオー', 'タイキシャトル', 'キングカメハメハ',
    'ステイゴールド', 'ゼンノロブロイ', 'ウオッカ', 'ダイワスカーレット', 'ブエナビスタ', 'オルフェーヴル', 'ゴールドシップ',
    'ジェンティルドンナ', 'ロードカナロア', 'キタサンブラック', 'サトノダイヤモンド', 'モーリス', 'ドゥラメンテ', 'アーモンドアイ',
    'コントレイル', 'デアリングタクト', 'グランアレグリア', 'クロノジェネシス', 'リスグラシュー', 'ラッキーライラック',
    'エフフォーリア', 'タイトルホルダー', 'イクイノックス', 'ドウデュース', 'リバティアイランド', 'ソダシ', 'スターズオンアース',
    'ジャスティンミラノ', 'ダノンデサイル', 'クロフネ', 'カネヒキリ', 'ヴァーミリアン', 'スマートファルコン', 'コパノリッキー',
    'ホッコータルマエ', 'ゴールドアリュール', 'ゴールドドリーム', 'レモンポップ', 'ウシュバテソーロ', 'フォーエバーヤング',
    'パンサラッサ', 'ジャックドール', 'ソングライン', 'シーザリオ', 'ヴィクトワールピサ', 'ジャスタウェイ', 'ブラストワンピース',
    'ワグネリアン', 'レイデオロ', 'マカヒキ', 'ナミュール', 'セリフォス', 'ブローザホーン', 'ミッキーアイル', 'ストレイトガール',
    'ハッピーグリン', 'マジカルスペル', 'フライングアップル', 'リトルアマポーラ'];
  // 歴史上の人物・故事のもじり
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
  // 騎手:架空の名前が中心。短期免許の外国人騎手と、歴史上の人物を一字変えた名前も少し混ぜる
  const JOCKEYS = [
    ['高梨 颯太', 88], ['F.ロッシーニ', 86], ['桐生 拓海', 83], ['織田 信永', 80], ['神崎 遼', 78], ['早瀬 蓮', 76],
    ['K.シュタイン', 74], ['白石 圭吾', 72], ['坂元 龍真', 70], ['成瀬 一輝', 68], ['朝倉 湊', 66], ['篠原 航', 64],
    ['真田 雪村', 62], ['三条 悠真', 60], ['水原 葵', 58], ['須藤 光', 56], ['宮城 理央', 54], ['小宮山 翔', 52],
    ['勝 海船', 50], ['久遠 千尋', 48], ['藤森 陽向', 46], ['巴 御膳', 44], ['野々村 大地', 42], ['柏木 樹', 40],
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

  // 名前の作り方と出現比率。故事・人物のもじりは合わせて 2 割程度に抑える
  const NAME_KINDS = [
    ['crown', 26, rng => pick(rng, CROWNS) + pick(rng, rng() < 0.55 ? CROWN_WORDS : FOREIGN_B)],
    ['foreign', 24, rng => pick(rng, FOREIGN_A) + pick(rng, rng() < 0.6 ? FOREIGN_B : CROWN_WORDS)],
    ['jp', 18, rng => (rng() < 0.4 ? pick(rng, NAME_JP) : pick(rng, JP_A) + pick(rng, JP_B))],
    ['phrase', 12, rng => pick(rng, NAME_PHRASE)],
    ['witty', 12, rng => pick(rng, NAME_WITTY)],
    ['history', 8, rng => pick(rng, NAME_A) + pick(rng, NAME_B)],
  ];
  const NAME_KIND_TOTAL = NAME_KINDS.reduce((a, k) => a + k[1], 0);
  const FAMOUS_SET = new Set(FAMOUS_HORSES);

  function horseNameKind(rng, used) {
    for (let tries = 0; ; tries++) {
      if (tries > 400) { // 語彙を使い切った時の保険:3 語の組み合わせ(実際にはほぼ起きない)
        for (;;) { const nm = pick(rng, JP_A) + pick(rng, CROWNS); if (!used.has(nm) && nm.length <= 9 && !FAMOUS_SET.has(nm)) { used.add(nm); return { name: nm, kind: 'jp' }; } }
      }
      let r = rng() * NAME_KIND_TOTAL, kind = NAME_KINDS[0];
      for (const k of NAME_KINDS) { if ((r -= k[1]) < 0) { kind = k; break; } }
      const name = kind[2](rng);
      if (name.length <= 9 && !used.has(name) && !FAMOUS_SET.has(name)) { used.add(name); return { name, kind: kind[0] }; }
    }
  }
  function horseName(rng, used) { return horseNameKind(rng, used).name; }

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

  // ---------- レース名 ----------
  // 重賞は固定のカタログ(名前・競馬場・距離・条件が毎回同じ)。実在の重賞をもじった架空の名前
  const GRADED_G1 = [
    ['天翔賞(秋)', '東京', '芝', 2000, '3+'], ['ジャパングランドカップ', '東京', '芝', 2400, '3+'], ['東都ダービー', '東京', '芝', 2400, '3'],
    ['レディースダービー', '東京', '芝', 2400, '3', '牝'], ['クイーンマイル', '東京', '芝', 1600, '4+', '牝'], ['関東マイルチャンピオン', '東京', '芝', 1600, '3+'],
    ['ダートキングカップ', '東京', 'ダート', 1600, '4+'], ['有明記念', '中山', '芝', 2500, '3+'], ['卯月賞', '中山', '芝', 2000, '3'],
    ['スプリントキングS', '中山', '芝', 1200, '3+'], ['紅葉賞', '京都', '芝', 3000, '3'], ['ロイヤルクイーンカップ', '京都', '芝', 2200, '3+', '牝'],
    ['古都マイルチャンピオン', '京都', '芝', 1600, '3+'], ['桃花賞', '阪神', '芝', 1600, '3', '牝'], ['宝山記念', '阪神', '芝', 2200, '3+'],
    ['阪神ジュニアクイーンズ', '阪神', '芝', 1600, '2', '牝'], ['朝陽杯ジュニアS', '阪神', '芝', 1600, '2'], ['高砂宮記念', '中京', '芝', 1200, '4+'],
    ['ダートチャンピオンズカップ', '中京', 'ダート', 1800, '3+'],
  ];
  // 競馬場ゆかりの地名(G2・G3 や特別戦の名前に使う)
  const VENUE_WORDS = {
    東京: ['府中', '多摩', '武蔵', '調布', '青梅'], 中山: ['房総', '下総', '成田', '印旛', '九十九里'], 京都: ['洛北', '嵐山', '鴨川', '比叡', '宇治'],
    阪神: ['六甲', '摩耶', '武庫', '芦屋', '甲山'], 中京: ['尾張', '名城', '熱田', '知多', '木曽'], 新潟: ['越後', '弥彦', '信濃', '妙高', '寺泊'],
  };
  const FLOWERS = ['こぶし', 'ひなげし', 'かたくり', 'ふじばかま', 'おみなえし', 'やまぶき', 'かきつばた', 'ねむのき', 'あせび', 'みずき', 'さくらそう', 'はまなす'];
  const GRADED = (() => {
    const list = GRADED_G1.map(([name, venue, surface, dist, age, sex]) => ({ name, grade: 'g1', venue, surface, dist, age, sex: sex || null }));
    for (const c of COURSES) {
      const W = VENUE_WORDS[c.venue], t = c.turf, d = c.dirt, mid = t[Math.floor(t.length / 2)];
      const add = (name, grade, surface, dist, age, sex = null) => list.push({ name, grade, venue: c.venue, surface, dist, age, sex });
      add(`${W[0]}記念`, 'g2', '芝', t[t.length - 1], '3+');
      add(`${W[1]}大賞典`, 'g2', '芝', mid, '3+');
      add(`${W[2]}カップ`, 'g2', '芝', t[1], '3');
      add(`${W[3]}ステークス`, 'g3', '芝', t[0], '3+');
      add(`${W[1]}日報杯`, 'g3', '芝', t[2], '3+');
      add(`${W[4]}牝馬ステークス`, 'g3', '芝', t[1], '3+', '牝');
      add(`${W[2]}ジュニアステークス`, 'g3', '芝', t[1], '2');
      add(`${W[4]}ステークス`, 'g3', 'ダート', d[d.length - 1], '3+');
      add(`${W[0]}ダートカップ`, 'g3', 'ダート', d[0], '3');
      add(`${W[4]}賞`, 'g2', '芝', t[Math.max(0, t.length - 2)], '3+');
      add(`${W[3]}記念`, 'g3', '芝', mid, '3+');
      add(`${W[0]}スプリント`, 'g3', '芝', t[0] <= 1400 ? t[0] : t[1], '3+');
      add(`${W[2]}ステークス`, 'g3', 'ダート', d[Math.min(1, d.length - 1)], '3+');
      add(`${W[1]}カップ`, 'g3', '芝', t[t.length - 1], '3+');
      add(`${W[3]}牝馬カップ`, 'g3', 'ダート', d[d.length - 1], '3+', '牝');
      add(`${W[4]}ジュニアカップ`, 'g3', 'ダート', d[0], '2');
      add(`${W[2]}トライアル`, 'g2', '芝', mid, '3');
    }
    return list;
  })();
  const ageOk = (cond, age) => (cond === '2' ? age === 2 : cond === '3' ? age === 3 : cond === '4+' ? age >= 4 : age >= 3);
  function gradedFor(rng, grade, { surface, dist, age, sex, venue }) {
    let c = GRADED.filter(e => e.grade === grade && ageOk(e.age, age) && (!e.sex || e.sex === sex));
    if (venue) c = c.filter(e => e.venue === venue && !e.sex && e.age === '3+');
    const sameSurf = c.filter(e => e.surface === surface);
    if (sameSurf.length) c = sameSurf;
    if (!c.length) return null;
    // 距離が近いものほど選ばれやすい
    return weighted(rng, c.map(e => [e, 1 / (1 + Math.abs(e.dist - dist) / 200)]));
  }
  // 平場・特別戦の名前
  function plainName(rng, cls, venue, debut) {
    if (debut) return '新馬';
    const W = VENUE_WORDS[venue];
    switch (cls.key) {
      case 'maiden': return '未勝利';
      case 'c1': case 'c2': {
        const r = rng();
        return r < 0.35 ? `${pick(rng, W)}特別` : r < 0.55 ? `${pick(rng, FLOWERS)}賞` : cls.name;
      }
      case 'c3': return rng() < 0.7 ? `${pick(rng, rng() < 0.5 ? W : RACE_WORDS)}ステークス` : cls.name;
      default: return `${pick(rng, RACE_WORDS)}ステークス`;
    }
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

  // ======================================================================
  // ---------- 競走馬データベース(ワールド) ----------
  // 約 5,600 頭の馬(2017〜2024 年生まれ)を持ち、2024 年 6 月から毎週末 3 場 × 12R を
  // 実際に出走馬を集めて走らせる。着順は各馬の能力(年齢による成長・衰え、適性、調子)+ 当日のブレで決まり、
  // 勝てばクラスが上がる。プレイ中のレースもこの世界の続きとして記録される。
  // ======================================================================
  const WEEK_MS = 7 * DAY_MS;
  const WORLD_START = Date.UTC(2024, 5, 1); // 2024-06-01(土)
  const CROPS = { 2017: 180, 2018: 420, 2019: 750, 2020: 1100, 2021: 1500, 2022: 1500, 2023: 1500, 2024: 1500 };
  const CLS_BY_WINS = ['maiden', 'c1', 'c2', 'c3', 'op'];
  // 能力 1 ポイントあたりの速さの差(タイムと能力の換算)と、スタートなどで失う時間
  const SPEED = { k: 0.001, lag: 1.3 };
  // 過去のレースを速く計算する時の当日のブレ(ポイント)と、出遅れ・不利の率
  const QUICK = { noise: 3.5, trouble: 0.06, late: 0.03, pace: 60 };
  // 過去の期間は 1 日の番組のうち一部だけ走らせる(この世界の頭数で、1 頭あたりの出走間隔が実際に近くなるように)
  const HISTORY_SHARE = 0.3;
  const yearOf = t => new Date(t).getUTCFullYear();
  const monthOf = t => new Date(t).getUTCMonth();
  const mod = (a, m) => ((a % m) + m) % m;
  // 整数 2 つから [0,1) の値(馬ごと・週ごとの決まった乱数)
  function hash01(a, b) {
    let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  const meetSetFor = date => MEET_SETS[mod(Math.floor((date - RACE_DATE0) / WEEK_MS), 2)];
  function timeFromPerf(perf, dist, surface, going) {
    return dist / (baseSpeed(dist, surface, going) * (1 + (perf - 60) * SPEED.k)) + SPEED.lag;
  }
  function perfFromTime(time, dist, surface, going) {
    return 60 + (dist / (time - SPEED.lag) / baseSpeed(dist, surface, going) - 1) / SPEED.k;
  }

  // ---------- 馬 ----------
  function newWorldHorse(rng, id, born, used) {
    const sexR = rng();
    const sex = sexR < 0.52 ? '牡' : sexR < 0.92 ? '牝' : 'セ';
    const stOff = gauss(rng) * 6;
    const vis = rngFor('visual', id);
    const c1 = pick(vis, SILK_COLORS);
    let c2 = pick(vis, SILK_COLORS);
    if (c2 === c1) c2 = c1 === '#ffffff' ? '#111111' : '#ffffff';
    return {
      id, born, sex, name: horseName(rng, used),
      // 完成時の能力(ポイント)。ごく一部に飛び抜けた馬
      peak: 49 + gauss(rng) * 7.5 + (rng() < 0.03 ? 5 + rng() * 5 : 0),
      growth: 0.8 + rng() * 0.4, early: gauss(rng) * 1.5,
      spOff: gauss(rng) * 2, stOff, buOff: gauss(rng) * 6, gt: clamp(50 + gauss(rng) * 15, 5, 95),
      style: weighted(rng, [['逃げ', 1.2], ['先行', 3.2], ['差し', 3.4], ['追込', 2.2]]),
      surface: rng() < 0.55 ? '芝' : 'ダート', offSurface: 3 + rng() * 5,
      distBest: Math.round(clamp(1600 + stOff * 60 + gauss(rng) * 380, 1000, 3200) / 100) * 100,
      distRange: Math.round((200 + rng() * 400) / 100) * 100,
      wetApt: clamp(gauss(rng), -2, 2),
      weightBase: Math.round(clamp(470 + gauss(rng) * 24, 400, 560) / 2) * 2,
      coat: weighted(vis, [['鹿毛', 38], ['黒鹿毛', 20], ['栗毛', 18], ['青鹿毛', 9], ['芦毛', 8], ['栃栗毛', 4], ['青毛', 3]]),
      silks: { body: c1, accent: c2, sleeve: vis() < 0.5 ? c1 : c2, pattern: pick(vis, SILK_PATTERNS) },
      jockeyPref: rng(),
      runs: [], wins: 0, gradeWins: 0, last: null, lastWeight: null, retired: false, pre: null, losing: 0,
    };
  }
  const ageOn = (h, date) => yearOf(date) - h.born;
  // 年齢による成長と衰え(2 歳は未完成、4〜5 歳がピーク)
  function abilityAt(h, date) {
    const t = (date - Date.UTC(h.born, 0, 1)) / (365.25 * DAY_MS);
    let def;
    if (t < 3) def = 10 - (t - 2) * 5 + h.early;
    else if (t < 4) def = 5 - (t - 3) * 5;
    else if (t < 5.5) def = 0;
    else def = (t - 5.5) * 3;
    return h.peak - Math.max(0, def) * h.growth;
  }
  // ゆっくり変わる調子(5 週ごとの値をなめらかにつなぐ。おおむね -2〜2)
  function formAt(h, date) {
    const w = (date - WORLD_START) / WEEK_MS / 5, k = Math.floor(w), f = w - k;
    const g = x => (hash01(h.id, x) + hash01(h.id + 99991, x) + hash01(h.id + 7777, x) - 1.5) * 2;
    return clamp(g(k) * (1 - f) + g(k + 1) * f, -2.5, 2.5);
  }

  // ---------- 重賞の年間日程 ----------
  // G1 はおおよその実施日、G2・G3 は条件に合う月の中で名前から決まる日。その週に開催している競馬場で行う
  const G1_DATES = {
    ダートキングカップ: [1, 20], 高砂宮記念: [2, 25], 桃花賞: [3, 8], 卯月賞: [3, 15], クイーンマイル: [4, 13], レディースダービー: [4, 20],
    東都ダービー: [4, 27], 関東マイルチャンピオン: [5, 3], 宝山記念: [5, 24], スプリントキングS: [8, 30], 紅葉賞: [9, 21], '天翔賞(秋)': [9, 28],
    ロイヤルクイーンカップ: [10, 11], 古都マイルチャンピオン: [10, 18], ジャパングランドカップ: [10, 25], ダートチャンピオンズカップ: [11, 2],
    阪神ジュニアクイーンズ: [11, 9], 朝陽杯ジュニアS: [11, 16], 有明記念: [11, 23],
  };
  const gradedYears = new Map();
  function gradedSchedule(year) {
    if (gradedYears.has(year)) return gradedYears.get(year);
    const map = new Map(), perDay = new Map();
    const key = (t, v) => `${t}|${v}`;
    const order = GRADED.slice().sort((a, b) => ({ g1: 0, g2: 1, g3: 2 }[a.grade] - { g1: 0, g2: 1, g3: 2 }[b.grade]));
    for (const e of order) {
      const vi = COURSES.findIndex(c => c.venue === e.venue);
      let target;
      if (G1_DATES[e.name]) target = Date.UTC(year, G1_DATES[e.name][0], G1_DATES[e.name][1]);
      else {
        const hv = hashStr(e.name) / 4294967296;
        const range = e.age === '2' ? [8, 11] : e.age === '3' ? [1, 8] : [0, 11];
        target = Date.UTC(year, range[0], 1) + Math.floor(hv * ((range[1] - range[0] + 1) * 30.4 - 7)) * DAY_MS;
      }
      // 近い週末(G1・G2 は日曜、G3 は名前で土日)で、その週に開催している競馬場
      // 近い週末(G1 は日曜)のうち、その週に開催している競馬場で、まだ重賞の少ない日を選ぶ(毎開催日に重賞があるように)
      let best = null, bestScore = Infinity;
      for (let dd = -28; dd <= 28; dd++) {
        const t = target + dd * DAY_MS, wd = new Date(t).getUTCDay();
        if ((e.grade === 'g1' ? wd !== 0 : wd !== 0 && wd !== 6) || yearOf(t) !== year) continue;
        if (!meetSetFor(t).includes(vi) || map.has(key(t, vi))) continue;
        const sc = (perDay.get(t) || 0) * 30 + Math.abs(dd);
        if (sc < bestScore) { bestScore = sc; best = t; }
      }
      if (best) { map.set(key(best, vi), e); perDay.set(best, (perDay.get(best) || 0) + 1); }
    }
    gradedYears.set(year, map);
    return map;
  }
  const gradedOn = (date, vi) => gradedSchedule(yearOf(date)).get(`${date}|${vi}`) || null;

  // ---------- 番組(その日・その場の 12 レースの条件) ----------
  // cond: 2歳 / 3歳 / 3歳以上 / 4歳以上。debut: 新馬戦
  function programFor(date, vi, raceNo, rng) {
    const m = monthOf(date), late = m >= 5; // 6〜12 月は 2 歳戦と 3 歳以上の混合戦
    const C = CLASSES, olderCond = late ? '3歳以上' : '4歳以上';
    const pr = (cls, cond, debut = false) => ({ cls, cond, debut });
    const g = gradedOn(date, vi);
    if (raceNo === 11 && g) {
      const cond = g.age === '2' ? '2歳' : g.age === '3' ? '3歳' : g.age === '4+' ? '4歳以上' : olderCond;
      return { cls: C[g.grade], cond, debut: false, graded: g, sexOnly: g.sex };
    }
    if (late) {
      switch (raceNo) {
        case 1: return m <= 8 ? pr(C.maiden, '3歳') : pr(C.maiden, '2歳');
        case 2: return m === 5 ? pr(C.maiden, '3歳') : pr(C.maiden, '2歳');
        case 3: return m <= 8 ? pr(C.maiden, '3歳') : pr(C.maiden, '2歳');
        case 4: return pr(C.maiden, '2歳', true);
        case 5: return m >= 8 && rng() < 0.4 ? pr(C.c1, '2歳') : pr(C.maiden, '2歳', m <= 6);
        case 6: case 7: return pr(C.c1, olderCond);
        case 8: return pr(C.c2, olderCond);
        case 9: return pr(rng() < 0.5 ? C.c1 : C.c2, olderCond);
        case 10: return pr(rng() < 0.55 ? C.c3 : C.c2, olderCond);
        case 11: return m >= 8 && rng() < 0.25 ? pr(C.op, '2歳') : pr(rng() < 0.6 ? C.op : C.c3, olderCond);
        default: return pr(rng() < 0.5 ? C.c1 : C.c2, olderCond);
      }
    }
    switch (raceNo) {
      case 1: case 2: case 3: return pr(C.maiden, '3歳');
      case 4: return pr(C.maiden, '3歳', m <= 2);
      case 5: return pr(C.c1, '3歳');
      case 6: case 7: return pr(C.c1, olderCond);
      case 8: return pr(C.c2, olderCond);
      case 9: return rng() < 0.5 ? pr(C.c1, '3歳') : pr(C.c2, olderCond);
      case 10: return rng() < 0.4 ? pr(C.op, '3歳') : pr(rng() < 0.5 ? C.c3 : C.c2, olderCond);
      case 11: return pr(rng() < 0.6 ? C.op : C.c3, olderCond);
      default: return pr(rng() < 0.5 ? C.c1 : C.c2, olderCond);
    }
  }
  const condOk = (cond, age) => (cond === '2歳' ? age === 2 : cond === '3歳' ? age === 3 : cond === '4歳以上' ? age >= 4 : age >= 3);
  // クラスの出走資格(勝利数)。2・3 歳のオープン・重賞は 1 勝馬から
  function classOk(cls, cond, debut, h) {
    const starts = h.runs.length + (h.pre ? h.pre.starts : 0);
    if (cls.key === 'maiden') return h.wins === 0 && (debut ? starts === 0 : starts > 0 || cond === '3歳');
    if (cls.key === 'op' || cls.grade) return (cond === '2歳' || cond === '3歳') ? h.wins >= 1 : h.wins >= 4;
    return h.wins === CLS_BY_WINS.indexOf(cls.key) && !(cond === '2歳' && cls.key !== 'c1');
  }

  function createWorld(seed) {
    const W = { seed, horses: [], races: [], date: WORLD_START, cards: new Map(), used: new Set() };
    const rng = rngFor('world', seed);
    let id = 0;
    for (const [born, cnt] of Object.entries(CROPS)) {
      for (let i = 0; i < cnt; i++) W.horses.push(newWorldHorse(rng, id++, +born, W.used));
    }
    initPreHistory(W, rng);
    // 2024-06-01 から開催日の前週まで、毎週末を走らせる
    for (let t = WORLD_START; t < RACE_DATE0; t += (new Date(t).getUTCDay() === 6 ? 1 : 6) * DAY_MS) {
      const defs = dayCard(W, t, `${seed}|${t}`, HISTORY_SHARE);
      const qr = rngFor('quick', seed, t);
      for (const def of defs) recordRace(W, def, quickRun(W, def, qr));
    }
    return W;
  }

  // 2024 年 6 月より前の戦績(3 歳以上の馬):能力から勝ち数と通算成績の概数を決める
  function initPreHistory(W, rng) {
    for (const h of W.horses) {
      const age = ageOn(h, WORLD_START);
      if (age < 3) continue;
      if (age >= 8) { h.retired = true; continue; }
      const z = abilityAt(h, WORLD_START) + gauss(rng) * 3;
      const steps = [47, 53, 58, 62, 65, 68, 71];
      let wins = steps.filter(x => z >= x).length;
      if (age === 3) wins = Math.min(wins, 2);
      if (wins === 0 && age >= 4) { h.retired = true; continue; } // 勝てないまま 4 歳 → 地方へ
      const starts = clamp(Math.round((age - 2.5) * 5 + wins + gauss(rng) * 2), wins + 1, 32);
      const p2 = Math.min(starts - wins, Math.round(starts * (0.1 + rng() * 0.08)));
      const p3 = Math.min(starts - wins - p2, Math.round(starts * (0.08 + rng() * 0.08)));
      h.pre = { starts, w: wins, p2, p3, out: starts - wins - p2 - p3 };
      h.wins = wins;
      h.gradeWins = wins >= 6 ? 1 : 0;
      h.last = WORLD_START - (2 + Math.floor(rng() * 8)) * WEEK_MS;
      h.pre.last = h.last;
      h.lastWeight = h.weightBase;
    }
  }

  // 世論の見立て(近走の内容を中心に。新馬は調教・血統の評判)
  function publicEstimate(h, date, def, rng) {
    let est;
    const runs = priorRuns(h, date);
    const fr = runs.length ? formRatingRuns(runs.slice(-5).reverse(), def) : null;
    if (fr != null) est = fr;
    else if (h.pre) est = abilityAt(h, date) + gauss(rng) * 4;
    else est = 46 + (abilityAt(h, date) - 46) * 0.45 + gauss(rng) * 4;
    return est + gauss(rng) * 2.5;
  }
  // 近走の評価(条件が今回に近い走り・最近の走りほど重く、いちばん悪い 1 走は度外視。出遅れ・不利は割り引き)
  function formRatingRuns(runs, cond) {
    const list = runs.map((x, k) => ({
      v: x.rating + (x.note ? 3 : 0),
      w: ((x.surface ?? x.race.surface) === cond.surface ? 1 : 0.3) * Math.exp(-Math.abs((x.dist ?? x.race.dist) - cond.distance) / 500) * (1 - k * 0.12),
    }));
    if (!list.length) return null;
    if (list.length > 2) list.splice(list.indexOf(list.reduce((a, b) => (b.v < a.v ? b : a))), 1);
    const W = list.reduce((a, b) => a + b.w, 0);
    return list.reduce((a, b) => a + b.v * b.w, 0) / W;
  }

  // 週ごとの引退(未勝利のまま 3 歳秋、高齢、連敗続き、ごく稀な故障)
  function weeklyUpkeep(W, date, rng) {
    const m = monthOf(date);
    for (const h of W.horses) {
      if (h.retired || date < Date.UTC(h.born + 2, 5, 1)) continue;
      const age = ageOn(h, date);
      if ((h.wins === 0 && age === 3 && m >= 9) || age >= 8 || (age === 7 && m === 11 && rng() < 0.3)
        || (h.losing >= 14 && age >= 5) || rng() < 0.0015) h.retired = true;
    }
  }

  // その日の 3 場 × 12R の出馬表(出走馬・馬番・騎手・斤量・馬体重・馬場まで)。1 日 1 回だけ作る
  function dayCard(W, date, seedStr, share = 1) {
    if (W.cards.has(date)) return W.cards.get(date);
    const rng = rngFor('card', seedStr);
    if (new Date(date).getUTCDay() === 6) weeklyUpkeep(W, date, rng);
    // 出走できる馬(引退していない・前走から 2 週以上・デビュー可能な月)を年齢別に
    const year = yearOf(date), debutFrom = monthOf(date) >= 5 ? year - 2 : year - 3;
    const avail = { 2: [], 3: [], old: [] };
    for (const h of W.horses) {
      if (h.retired || h.born > debutFrom || (h.last != null && date - h.last < 13 * DAY_MS)) continue;
      const age = year - h.born;
      (age === 2 ? avail[2] : age === 3 ? avail[3] : avail.old).push(h);
    }
    avail.year = year;
    const usedToday = new Set();
    const venues = meetSetFor(date);
    const defs = [];
    const weather = weighted(rng, [['晴', 55], ['曇', 30], ['小雨', 10], ['雨', 5]]);
    for (const [slot, vi] of venues.entries()) {
      const course = COURSES[vi];
      const goingTable = {
        晴: [['良', 85], ['稍重', 12], ['重', 3]], 曇: [['良', 70], ['稍重', 20], ['重', 8], ['不良', 2]],
        小雨: [['良', 25], ['稍重', 45], ['重', 25], ['不良', 5]], 雨: [['稍重', 20], ['重', 45], ['不良', 35]],
      };
      const goingByS = { 芝: weighted(rng, goingTable[weather]), ダート: weighted(rng, goingTable[weather]) };
      for (let raceNo = 1; raceNo <= 12; raceNo++) {
        if (share < 1 && raceNo !== 11 && hash01(hashStr(seedStr), vi * 100 + raceNo) > share) continue;
        let prog = programFor(date, vi, raceNo, rng);
        let def = null;
        for (let attempt = 0; attempt < 4 && !def; attempt++) {
          def = buildDef(W, date, vi, slot, raceNo, prog, avail, usedToday, rng, goingByS, weather);
          if (!def) prog = fallbackProgram(prog, attempt, date);
        }
        if (def) { def.key = `${vi}-${raceNo}`; defs.push(def); def.entrants.forEach(hid => usedToday.add(hid)); }
      }
    }
    W.cards.set(date, defs);
    return defs;
  }
  // 頭数が集まらない時の代わりの条件
  function fallbackProgram(prog, attempt, date) {
    const olderCond = monthOf(date) >= 5 ? '3歳以上' : '4歳以上';
    const list = [
      { cls: CLASSES.c1, cond: olderCond }, { cls: CLASSES.c2, cond: olderCond }, { cls: CLASSES.maiden, cond: monthOf(date) >= 6 ? '2歳' : '3歳' }, { cls: CLASSES.c1, cond: olderCond },
    ];
    return { ...list[attempt], debut: false };
  }

  function buildDef(W, date, vi, slot, raceNo, prog, avail, usedToday, rng, goingByS, weather) {
    const course = COURSES[vi], { cls, cond, debut, graded } = prog;
    let surface, dist;
    if (graded) { surface = graded.surface; dist = graded.dist; }
    else {
      const turfP = cls.key === 'maiden' ? 0.5 : 0.6;
      surface = rng() < turfP ? '芝' : 'ダート';
      let list = course[surface === '芝' ? 'turf' : 'dirt'];
      if (cond === '2歳') list = list.filter(d => d <= 2000);
      dist = pick(rng, list.length ? list : course[surface === '芝' ? 'turf' : 'dirt']);
    }
    const pool = cond === '2歳' ? avail[2] : cond === '3歳' ? avail[3] : cond === '4歳以上' ? avail.old : avail[3].concat(avail.old);
    const cands = pool.filter(h => !usedToday.has(h.id) && (!prog.sexOnly || h.sex === prog.sexOnly) && classOk(cls, cond, debut, h));
    const minField = cls.grade ? 8 : 6;
    if (cands.length < minField) return null;
    const open = cls.key === 'op' || cls.grade;
    // 出走したい度合い:適性(馬場・距離)+ 間隔(4〜8 週が理想)。オープン・重賞は格(近走と重賞勝ち)が上の馬から
    const scored = cands.map(h => {
      const weeks = h.last == null ? 20 : (date - h.last) / WEEK_MS;
      let sc = -(h.surface !== surface ? 1.3 : 0) - Math.abs(h.distBest - dist) / 450 + (weeks < 3 ? -1.6 : weeks < 4 ? -0.7 : weeks <= 8 ? 0.2 : 0.4) + gauss(rng) * 0.9;
      if (open) sc += (publicEstimate(h, date, { surface, distance: dist }, rng) - 60) / 4 + h.gradeWins * (cls.key === 'g1' ? 1.5 : 0.5);
      return [sc, h];
    }).sort((a, b) => b[0] - a[0]);
    const target = cls.key === 'g1' ? 18 : cls.grade ? 12 + Math.floor(rng() * 5) : weighted(rng, [[8, 1], [10, 2], [11, 3], [12, 4], [13, 4], [14, 5], [15, 4], [16, 5], [18, 2]]);
    const chosen = scored.slice(0, Math.min(target, 18, scored.length)).map(x => x[1]);
    // 馬番は抽選
    const gate = shuffle(rng, chosen.slice());
    const n = gate.length;
    const handicap = !graded && (cls.key === 'c3' || cls.key === 'op') && rng() < 0.25;
    // 騎手:評判の高い馬ほど上位騎手
    const jk = shuffle(rng, JOCKEYS.map((j, i) => i)).slice(0, n).sort((a, b) => JOCKEYS[b][1] - JOCKEYS[a][1]);
    const byEst = gate.map(h => [publicEstimate(h, date, { surface, distance: dist }, rng) + gauss(rng) * 2, h]).sort((a, b) => b[0] - a[0]);
    const jockeyOf = new Map(byEst.map(([, h], i) => [h.id, jk[i]]));
    const olderSuffix = cond;
    const name = graded ? graded.name
      : cls.key === 'op' ? `${pick(rng, RACE_WORDS)}ステークス`
      : debut ? `${cond}新馬`
      : (cls.key === 'c1' || cls.key === 'c2' || cls.key === 'c3') && raceNo >= 9 && rng() < 0.65 ? plainName(rng, cls, course.venue, false).replace(/^(\d)勝クラス$/, `${olderSuffix}$1勝クラス`)
      : `${cond}${cls.name}`;
    return {
      date, vi, venueIdx: vi, slot, raceNo, cls, cond, debut: !!debut, graded: graded || null, sexOnly: prog.sexOnly || null,
      surface, distance: dist, going: goingByS[surface], weather, handicap, name,
      entrants: gate.map(h => h.id),
      jockeys: gate.map(h => jockeyOf.get(h.id)),
      weights: gate.map(h => {
        const grow = ageOn(h, date) === 2 ? -10 + (monthOf(date) - 5) * 1.5 : 0;
        return Math.round((h.weightBase + grow + gauss(rng) * 4) / 2) * 2;
      }),
    };
  }

  // 出走馬の当日の姿(レースで使う属性と、馬柱用の戦績)
  function raceHorseFrom(W, def, i, rng) {
    const h = W.horses[def.entrants[i]], date = def.date;
    const ab = abilityAt(h, date), form = formAt(h, date);
    const j = JOCKEYS[def.jockeys[i]];
    // 当日より前の走りだけを見る(結果を書き込んだ後に見直しても同じ姿になるように)
    const prior = priorRuns(h, date), lastRun = prior[prior.length - 1];
    const lastDate = lastRun ? lastRun.race.date : h.pre ? h.pre.last : null;
    const prevW = lastRun ? lastRun.weight : h.pre ? h.weightBase : def.weights[i];
    const rh = {
      id: h.id, name: h.name, sex: h.sex, age: ageOn(h, date), ability: ab,
      sp: ab + h.spOff, st: ab + h.stOff, bu: ab + h.buOff, gt: h.gt, style: h.style,
      surface: h.surface, offSurface: h.offSurface, distBest: h.distBest, distRange: h.distRange, wetApt: h.wetApt,
      form, training: form + gauss(rng) * 0.8,
      bodyWeight: def.weights[i], bodyDiff: def.weights[i] - prevW,
      jockey: { name: j[0], skill: j[1] }, no: i + 1,
      coat: h.coat, silks: h.silks,
      layoff: lastDate == null ? 0 : Math.max(1, Math.round((date - lastDate) / WEEK_MS)),
    };
    return rh;
  }

  // 過去のレースを速く走らせる(能力 + 展開 + 当日のブレ。出遅れ・不利あり)
  function quickRun(W, def, rng) {
    const n = def.entrants.length;
    const race = { surface: def.surface, distance: def.distance, going: def.going, n, cls: def.cls };
    const hs = def.entrants.map((hid, i) => {
      const rh = raceHorseFrom(W, def, i, rng);
      rh.kinryo = kinryoFor(rh, def.cls, def.handicap, rng);
      return rh;
    });
    const nige = hs.filter(h => h.style === '逃げ').length, senko = hs.filter(h => h.style === '先行').length;
    const pace = clamp((nige - PACE.nigeRef) * PACE.nige + (senko - PACE.senkoRef) * PACE.senko + gauss(rng) * PACE.noise, PACE.min, PACE.max);
    const res = hs.map((h, i) => {
      let perf = effectivePoints(h, race) + gauss(rng) * QUICK.noise;
      const front = h.style === '逃げ' || h.style === '先行';
      perf += (front ? -1 : 0.8) * pace * QUICK.pace; // 速い展開は差し有利・遅い展開は前有利
      let note = null;
      if (rng() < QUICK.late + (50 - h.gt) / 100 * 0.03) { note = '出遅れ'; perf -= 3 + rng() * 4; }
      else if (rng() < QUICK.trouble) { note = '不利'; perf -= 3 + rng() * 5; }
      return { i, perf, note, h };
    }).sort((a, b) => b.perf - a.perf);
    const est = hs.map((h, i) => [publicEstimate(W.horses[def.entrants[i]], def.date, def, rng) + (h.jockey.skill - 65) * 0.05, i]).sort((a, b) => b[0] - a[0]);
    const pops = []; est.forEach(([, i], k) => { pops[i] = k + 1; });
    const base3f = (def.surface === '芝' ? 34.3 : 36.8) + (def.distance - 1600) / 1000 * 0.6 + GOING.indexOf(def.going) * (def.surface === '芝' ? 0.5 : -0.2);
    return res.map((x, k) => {
      const h = x.h, pos = k + 1;
      const time = timeFromPerf(x.perf, def.distance, def.surface, def.going);
      const K = def.distance <= 1400 ? 2 : 4;
      const early = { 逃げ: 1 + rng() * 1.2, 先行: 2 + rng() * 3, 差し: n * (0.4 + rng() * 0.3), 追込: n * (0.75 + rng() * 0.25) }[h.style];
      const passing = Array.from({ length: K }, (_, q) => clamp(Math.round(early + (pos - early) * (q / K) + gauss(rng) * 0.8), 1, n)).join('-');
      const l3f = base3f - (h.bu - 60) * 0.03 + { 逃げ: 0.5, 先行: 0.2, 差し: -0.2, 追込: -0.4 }[h.style] + (pos - 1) / n * 1.2 + gauss(rng) * 0.35;
      return { i: x.i, pos, time, l3f, passing, pop: pops[x.i], note: x.note, kinryo: h.kinryo };
    });
  }

  // レース結果をデータベースへ(着順・タイム・人気・クラスの昇級)。rows は馬ごと(i = 出馬表の並び)
  function recordRace(W, def, rows) {
    const race = {
      id: W.races.length, date: def.date, venueIdx: def.vi, raceNo: def.raceNo, name: def.name, cls: def.cls, cond: def.cond,
      debut: def.debut, surface: def.surface, dist: def.distance, going: def.going, field: def.entrants.length, e: [],
    };
    const sorted = rows.slice().sort((a, b) => a.pos - b.pos);
    const l3sorted = rows.map(r => r.l3f).sort((a, b) => a - b);
    for (const r of sorted) {
      const h = W.horses[def.entrants[r.i]];
      const entry = {
        race, hid: h.id, no: r.i + 1, pos: r.pos, pop: r.pop, time: r.time, l3f: Math.round(r.l3f * 10) / 10,
        l3rank: l3sorted.indexOf(r.l3f) + 1, passing: r.passing, note: r.note || null,
        jockey: JOCKEYS[def.jockeys[r.i]][0], kinryo: r.kinryo, weight: def.weights[r.i],
        rating: perfFromTime(r.time, def.distance, def.surface, def.going),
      };
      race.e.push(entry);
      h.runs.push(entry);
      h.last = def.date;
      h.lastWeight = def.weights[r.i];
      if (r.pos === 1) { h.wins++; h.losing = 0; if (def.cls.grade) h.gradeWins++; } else h.losing++;
    }
    W.races.push(race);
    return race;
  }

  const priorRuns = (h, date) => { let k = h.runs.length; while (k > 0 && h.runs[k - 1].race.date >= date) k--; return h.runs.slice(0, k); };
  // 馬柱用の戦績(新しい順)。今回の出走馬との対戦も付ける
  function careerOf(W, h, def) {
    const today = new Set(def.entrants);
    return priorRuns(h, def.date).reverse().map(x => {
      const r = x.race, win = r.e[0], second = r.e[1];
      const isWin = x.pos === 1;
      return {
        date: r.date, dateLabel: fmtDate(r.date), venue: COURSES[r.venueIdx].venue, surface: r.surface, dist: r.dist, going: r.going,
        field: r.field, no: x.no, pos: x.pos, pop: x.pop, cls: r.cls, raceName: r.debut ? '新馬' : raceLabelPast(r),
        jockey: x.jockey, kinryo: x.kinryo, weight: x.weight, time: x.time,
        diff: isWin ? -(second ? Math.round((second.time - x.time) * 10) / 10 : 0) || 0 : Math.round((x.time - win.time) * 10) / 10,
        rival: isWin ? (second ? W.horses[second.hid].name : '') : W.horses[win.hid].name,
        passing: x.passing, last3f: x.l3f, last3fRank: x.l3rank, note: x.note, rating: x.rating, raceId: r.id,
        sharedWith: r.e.filter(y => y !== x && today.has(y.hid)).map(y => ({ name: W.horses[y.hid].name, no: def.entrants.indexOf(y.hid) + 1, pos: y.pos })),
      };
    });
  }
  // 過去走のレース名(平場はクラス名、特別戦・重賞は名前)
  function raceLabelPast(r) {
    if (r.cls.grade || r.cls.key === 'op') return r.name;
    if (/新馬$/.test(r.name)) return '新馬';
    if (/未勝利$/.test(r.name)) return '未勝利';
    if (/勝クラス$/.test(r.name)) return r.cls.name;
    return r.name;
  }
  function recordsOf(h, careerRuns, surface, distance, venue) {
    const near = x => Math.abs(x.dist - distance) <= 200;
    const pre = h.pre;
    const add = (a, b) => a.map((v, k) => v + (b ? b[k] : 0));
    const preAll = pre ? [pre.w, pre.p2, pre.p3, pre.out] : null;
    return {
      all: add(record(careerRuns), preAll),
      turf: add(record(careerRuns, x => x.surface === '芝'), h.surface === '芝' ? preAll : null),
      dirt: add(record(careerRuns, x => x.surface === 'ダート'), h.surface === 'ダート' ? preAll : null),
      dist: record(careerRuns, x => x.surface === surface && near(x)),
      heavy: record(careerRuns, x => x.going === '重' || x.going === '不良'),
      venue: record(careerRuns, x => x.venue === venue),
    };
  }

  // 開催日(プレイ中)の出馬表。前日までの結果を反映済みの世界から作る
  function meetCard(W, day, seedBase) { return dayCard(W, raceDate(day), `${W.seed}|meet|${seedBase}|${day}`); }

  // テスト・較正用:世界の馬から条件に合う馬を集めた 1 レース(出馬表とは別に、シードごとに違うメンバー)
  function adhocDef(W, { seed, raceNo = 11, venueIdx = 0, day = 1, slot = 0 }) {
    const rng = rngFor('adhoc', W.seed, seed, raceNo, venueIdx, day);
    const date = raceDate(day);
    const year = yearOf(date), debutFrom = monthOf(date) >= 5 ? year - 2 : year - 3;
    const avail = { 2: [], 3: [], old: [], year };
    for (const h of W.horses) {
      if (h.retired || h.born > debutFrom) continue;
      const age = year - h.born;
      (age === 2 ? avail[2] : age === 3 ? avail[3] : avail.old).push(h);
    }
    const going = { 芝: weighted(rng, [['良', 75], ['稍重', 15], ['重', 7], ['不良', 3]]), ダート: weighted(rng, [['良', 70], ['稍重', 17], ['重', 9], ['不良', 4]]) };
    const weather = going['芝'] === '良' ? (rng() < 0.65 ? '晴' : '曇') : rng() < 0.5 ? '小雨' : '雨';
    let prog = programFor(date, venueIdx, raceNo, rng);
    // 番組表にない重賞も試せるよう、11R は時々重賞にする
    if (raceNo === 11 && !prog.graded && rng() < 0.45) {
      const g = pick(rng, GRADED.filter(e => e.venue === COURSES[venueIdx].venue && !e.sex && e.age === '3+'));
      if (g) prog = { cls: CLASSES[g.grade], cond: '3歳以上', debut: false, graded: g, sexOnly: null };
    }
    let def = null;
    for (let attempt = 0; attempt < 4 && !def; attempt++) {
      def = buildDef(W, date, venueIdx, slot, raceNo, prog, avail, new Set(), rng, going, weather);
      if (!def) prog = fallbackProgram(prog, attempt, date);
    }
    def.key = `${venueIdx}-${raceNo}`;
    return def;
  }

  let defaultWorldCache = null;
  function defaultWorld() { return defaultWorldCache || (defaultWorldCache = createWorld(1)); }

  // light: オッズ(モンテカルロ)を省いた軽量版。出走馬・結果は通常版と同一
  // def(出馬表の 1 レース)と world を渡すとその出走馬で、渡さなければ既定の世界から条件に合う馬を集める
  function generateRace(opts) {
    const { seed, light = false } = opts;
    let { def, world } = opts;
    world = world || defaultWorld();
    if (!def) def = adhocDef(world, opts);
    const W = world, rng = rngFor(seed, 'race-gen');
    const course = COURSES[def.vi];
    const { cls, surface, distance, going, weather, handicap } = def;
    const n = def.entrants.length;
    const horses = def.entrants.map((hid, i) => {
      const h = W.horses[hid];
      const rh = raceHorseFrom(W, def, i, rngFor(seed, 'train', hid));
      rh.bracket = bracketOf(rh.no, n);
      rh.kinryo = kinryoFor(rh, cls, handicap, rng);
      rh.career = careerOf(W, h, def);
      rh.past = rh.career.slice(0, 5);
      rh.records = recordsOf(h, rh.career, surface, distance, course.venue);
      rh.trainingGrade = rh.training > 1.0 ? 'A' : rh.training > 0.2 ? 'B' : rh.training > -0.7 ? 'C' : 'D';
      rh.debut = rh.career.length === 0 && !h.pre;
      rh.preStarts = h.pre ? h.pre.starts : 0; // 2024 年 6 月より前の出走数(通算成績にだけ含む)
      rh.formRating = formRatingRuns(rh.past, { surface, distance }) ?? publicEstimate(h, def.date, def, rngFor(seed, 'est', hid));
      return rh;
    });
    const nige = horses.filter(h => h.style === '逃げ').length;
    const senko = horses.filter(h => h.style === '先行').length;
    const paceAdj = clamp((nige - PACE.nigeRef) * PACE.nige + (senko - PACE.senkoRef) * PACE.senko + gauss(rngFor(seed, 'pace')) * PACE.noise, PACE.min, PACE.max);
    const race = {
      seed, day: opts.day ?? 1, raceNo: def.raceNo, venueIdx: def.vi, course, date: def.date, dateLabel: fmtDate(def.date, true),
      venue: course.venue, dir: course.dir, cls, cond: def.cond, name: def.name, handicap, surface, distance, weather, going, n, horses, paceAdj,
      postTime: fmtClock(POST_MINUTES[def.raceNo - 1] + (def.slot || 0) * 10), vbase: baseSpeed(distance, surface, going), def, world: W,
      // 出走馬の平均的な力(スタミナ・瞬発力はこれとの差で効く)
      ref: horses.reduce((a, h) => a + h.ability, 0) / n,
    };
    horses.forEach(h => { h.points = effectivePoints(h, race); });
    if (light) return race;
    race.probs = estimateProbs(race, 500);
    race.market = buildMarket(race);
    race._oddsCache = new Map();
    return race;
  }

  // 走ったレースの結果をデータベースに書き込む(プレイ中の開催)。人気はオッズがあればそれ、なければ世論の見立て
  function resultRows(race, result) {
    const W = race.world, def = race.def;
    let pops = race.market ? race.market.pop : null;
    if (!pops) {
      const r = rngFor(race.seed, 'pops');
      const est = race.horses.map((h, i) => [publicEstimate(W.horses[h.id], def.date, def, r) + (h.jockey.skill - 65) * 0.05, i]).sort((a, b) => b[0] - a[0]);
      pops = []; est.forEach(([, i], k) => { pops[i] = k + 1; });
    }
    return result.rows.map(row => {
      const i = row.no - 1;
      return { i, pos: row.rank, time: Math.round(row.time * 10) / 10, l3f: Math.round(row.last3f * 10) / 10, passing: row.passing, pop: pops[i],
        note: row.notes.includes('出遅れ') ? '出遅れ' : row.notes.includes('不利') ? '不利' : null, kinryo: race.horses[i].kinryo };
    });
  }
  // 保存用に詰める / 戻す
  const packRows = rows => rows.map(r => [r.i, r.pos, Math.round(r.time * 10), Math.round(r.l3f * 10), r.passing, r.pop, r.note === '出遅れ' ? 1 : r.note === '不利' ? 2 : 0, r.kinryo]);
  const unpackRows = rows => rows.map(([i, pos, t, l, passing, pop, nt, kinryo]) => ({ i, pos, time: t / 10, l3f: l / 10, passing, pop, note: nt === 1 ? '出遅れ' : nt === 2 ? '不利' : null, kinryo }));

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
  // 展開の効き方(較正値)。前半が速いほど前の馬がバテて差しが届き、遅いと前残り
  // 較正(240R・競走馬データベース):勝ち馬の脚質 逃げ10%・先行35%・差し40%・追込15%。遅い展開は前が55%、速い展開は差し・追込が7割
  const PACE = { nigeRef: 1.6, senkoRef: 4.4, nige: 0.007, senko: 0.002, noise: 0.006, min: -0.02, max: 0.03, follow: 0.6, drainExp: 15, kickE: 0.55, tire: 1.0, tireMax: 0.11, slowKick: 150 };
  const SIM = { DAY_NOISE: 7 }; // 当日の出来のブレ(ポイント)

  function simulateRace(race, rng, record) {
    const D = race.distance, n = race.n;
    const kickStart = D - Math.min(600, D * 0.35);
    const straightF = 0.85 + race.course.straight / 1000 * 0.35;
    const T0 = D / race.vbase;
    const st = race.horses.map(h => {
      const day = gauss(rng) * SIM.DAY_NOISE;
      // 各馬の能力がそのまま速さになる(1 ポイント = SPEED.k)
      const mult = 1 + (h.points + day - 60) * SPEED.k;
      let delay = clamp(0.05 + gauss(rng) * 0.08 + (50 - h.gt) * 0.003, 0, 0.5);
      let lateStart = false;
      if (rng() < 0.03 + (50 - h.gt) / 100 * 0.04) { delay += 0.6 + rng() * 1.0; lateStart = true; }
      const trouble = rng() < 0.07 ? { at: D * (0.4 + rng() * 0.5), len: 2 + rng() * 2 } : null;
      // 速いペースでは前の馬だけが飛ばし(後ろは一部ついていく)、遅いペースでは全体が落として馬群が詰まる
      const fr = h.style === '逃げ' || h.style === '先行';
      const early = EARLY[h.style] + race.paceAdj * (fr || race.paceAdj < 0 ? 1 : PACE.follow);
      const cap = clamp(1.03 + (h.st - race.ref) / 100 * (D / 1600) * 0.3, 0.8, 1.3);
      // スローペースでは前の馬も余力があり、直線でもう一伸びする
      const front = h.style === '逃げ' || h.style === '先行';
      const kick = clamp(0.035 + (h.bu - race.ref) / 100 * 0.05, 0.008, 0.075) * KICK_STYLE[h.style] * straightF
        * (front ? 1 + Math.max(0, -race.paceAdj) * PACE.slowKick : 1);
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
          if (s.pos >= kickStart) pm = 1 + s.kick * clamp(s.E / PACE.kickE, 0, 1);
          else if (x < 0.55) pm = s.early;
          else if (x < 0.7) pm = s.early + (1 - s.early) * (x - 0.55) / 0.15;
          else pm = 1;
          const fatigue = s.E < 0 ? 1 - Math.min(PACE.tireMax, -s.E * PACE.tire) : 1;
          s.ar = 0.85 * s.ar + 0.0035 * gauss(rng);
          let trouble = 1;
          if (s.trouble && s.pos >= s.trouble.at) {
            if (s.troubleT === null) s.troubleT = t;
            if (t - s.troubleT < s.trouble.len) trouble = 0.965;
          }
          v = race.vbase * s.mult * pm * fatigue * (1 + s.ar) * accel * trouble;
          if (s.fin === null) s.E -= Math.pow(pm, PACE.drainExp) / T0 * DT;
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
    // 展開(逃げ・先行の数と駆け引きで決まる前半の速さ)。概ね 3 分の 1 ずつ
    const pace = race.paceAdj > 0.011 ? 'H' : race.paceAdj < 0.001 ? 'S' : 'M';
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

  const MARKET = { truthExp: 0.85, formW: 0.3 };
  function payFromOdds(o) {
    // 100 円あたり払戻(10 円未満切り捨て、最低 100 円)
    return Math.max(100, Math.floor(o * 100 / 10 + 1e-9) * 10);
  }

  function buildMarket(race) {
    const rng = rngFor(race.seed, 'market');
    // 大衆は真の勝率をノイズ込みで見積もり、さらに近走の成績(見た目のデータ)を重く見る
    const form = race.horses.map(h => h.formRating);
    const fm = form.reduce((a, b) => a + b, 0) / form.length;
    const fsd = Math.sqrt(form.reduce((a, b) => a + (b - fm) ** 2, 0) / form.length) || 1;
    const raw = race.horses.map((h, i) =>
      Math.pow(race.probs.win[i] + 0.003, MARKET.truthExp) * Math.exp(MARKET.formW * (form[i] - fm) / fsd) * Math.exp(gauss(rng) * 0.15) * (1 + (h.jockey.skill - 65) * 0.004));
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
    const tips = tipsterMarks(race, q, pop);
    return { q, pl, winPay, placeShare, pop, tips };
  }

  // ---------- 予想家の印 ----------
  // 予想家ごとに見るところが違う(人気・妙味・能力指数・調教・適性)。乱数列は市場と分ける
  const TIPSTERS = [
    { id: 'katata', name: '堅田 守', short: '堅田', style: '本命党', desc: '人気どころを素直に評価する本紙の顔' },
    { id: 'anai', name: '穴井 一発', short: '穴井', style: '穴党', desc: '人気薄の妙味を狙う万馬券ハンター' },
    { id: 'kazumi', name: '数見 理', short: '数見', style: 'データ派', desc: '独自の能力指数で淡々と序列をつける' },
    { id: 'hanro', name: '坂路 走', short: '坂路', style: '調教派', desc: '追い切りの動きを最重視するトラックマン' },
    { id: 'doi', name: '土井 芝夫', short: '土井', style: '適性派', desc: 'コース・距離・馬場の実績にこだわる' },
  ];
  const MARK_ORDER = ['◎', '○', '▲', '△', '△'];
  function fitRate(r) { const runs = r.reduce((a, b) => a + b, 0); return (r[0] + (r[1] + r[2]) * 0.5 + 0.4) / (runs + 2); }
  function tipsterMarks(race, q, pop) {
    const rng = rngFor(race.seed, 'tips');
    const p = race.probs.win, heavy = race.going === '重' || race.going === '不良';
    const TRAIN = { A: 2.2, B: 1.4, C: 1.0, D: 0.6 };
    const score = {
      katata: i => q[i] * Math.exp(gauss(rng) * 0.25),
      anai: i => Math.pow(p[i], 0.9) / Math.pow(q[i], 0.55) * Math.exp(gauss(rng) * 0.35),
      kazumi: i => p[i] * Math.exp(gauss(rng) * 0.2),
      hanro: i => Math.pow(p[i], 0.6) * TRAIN[race.horses[i].trainingGrade] * Math.exp(gauss(rng) * 0.35),
      doi: i => {
        const r = race.horses[i].records;
        const surf = race.surface === '芝' ? r.turf : r.dirt;
        return Math.pow(p[i], 0.6) * (0.5 + fitRate(surf)) * (0.5 + fitRate(r.dist)) * (heavy ? 0.5 + fitRate(r.heavy) : 1) * Math.exp(gauss(rng) * 0.3);
      },
    };
    return TIPSTERS.map(t => {
      const ranked = race.horses.map((h, i) => [score[t.id](i), i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
      const marks = Array(race.n).fill('');
      MARK_ORDER.forEach((m, k) => { if (ranked[k] != null) marks[ranked[k]] = m; });
      // ☆は 6 番人気以下で最上位の馬(穴の一頭)
      const star = ranked.find(i => !marks[i] && pop[i] >= 6);
      if (star != null) marks[star] = '☆';
      return { id: t.id, marks };
    });
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
    PACE, EARLY, KICK_STYLE, SIM, MARKET, SPEED, QUICK, createWorld, defaultWorld, meetCard, adhocDef, recordRace, resultRows, packRows, unpackRows, timeFromPerf, perfFromTime, abilityAt, gradedOn, bracketCounts, bracketOf, baseSpeed, generateRace, runRace, simulateRace, estimateProbs,
    odds, placePay, placeRange, payFromOdds, settlePayouts, expandCombos, createTicket, ticketReturn,
    bracketSold, formatTime, fmtDate, daySchedule, fmtClock, TIPSTERS, GRADED, NAME_WITTY, NAME_JP, NAME_PHRASE, FAMOUS_HORSES, horseNameKind, JOCKEYS, record, marginText, comboProb, canonical, comboKey, harvilleTop3,
  };
});
