(function () {
  'use strict';
  const M = window.PCS800Model, T = window.THREE;
  const byId = id => document.getElementById(id);
  const get = key => byId('g800-' + key);
  const value = key => +get(key).value;
  const rates = ['200g', '800g', '1600g'];
  const tabs = rates.map(rate => byId('tab-' + rate));
  const panels = rates.map(rate => byId('lab-' + rate));
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const stages = [
    ['800GMII', 'MAC 提交一条 800 Gb/s 数据流。'],
    ['64B/66B 编码', '示例每 8 字节数据加上数据同步头 01，形成一个 66 位块。'],
    ['66b 分流', '偶数块进入 Flow 0，奇数块进入 Flow 1。标准要求逐块交替分配。'],
    ['256B/257B 转码', '每个 Flow 将四个纯数据 66 位块转码成一个 257 位块。'],
    ['加扰', '每个 Flow 使用独立的自同步加扰器，多项式为 x⁵⁸ + x³⁹ + 1。实现若采用固定初态，两个加扰器宜使用不同初态。'],
    ['AM / FEC', '两个 Flow 在原始 66b 序列的同一相对位置插入 AM 组，再按 10 位符号交替分配至 A、B 两个 RS(544,514) 码字。'],
    ['32 PCS lane', 'Flow 0 使用 PCS lane 0–15，Flow 1 使用 16–31；每条 lane 26.5625 Gb/s。'],
    ['32:8 PMA', 'TX 每条输出 lane 从 Flow 0 的两条 PCS lane 各取一位，再从 Flow 1 的两条 PCS lane 各取一位，按此顺序复用。'],
    ['8 路 PAM4', '8 条物理通道各为 106.25 Gb/s，PAM4 符号率 53.125 GBd。每条承载四条 PCS lane；若经过 8:8 PMA，映射还须保持 PAM4 Gray 符号序列或仅交换位对。'],
    ['RX 解复用', '32:8 PMA 在接收方向执行不受限的位级复用，将 8 条输入 lane 的数据送至 32 条输出 lane。PCS 使用 AM 识别 PCS lane 编号。'],
    ['锁定 / Deskew', 'PCS 通过 AM 的公共部分锁定，并用专用部分识别 lane ID。全部 32 条 lane 满足锁定及 152 ns Skew 预算后按 ID 重排。'],
    ['RX FEC / 移除 AM', '重排后，每个 Flow 先去交织重建 A/B 码字，再执行 RS 解码、FEC 后交织、AM 移除。每个码字最多纠正 15 个未知位置的错误符号。'],
    ['解扰', '每个 Flow 按相同多项式，用接收的加扰位恢复原始 257 位块。'],
    ['257b 逆转码', '恢复每个 Flow 的四个 66 位块及各自同步头。'],
    ['66b 合流', 'AM 组后的首个 Flow 0 块紧接首个 Flow 1 块，随后继续交替收集，恢复单条 66b 流。'],
    ['64B/66B 解码', '每个 66b 块还原一次 800GMII 传输的 64 位数据及 8 位控制指示。图中显示纯数据块的 8 字节。'],
    ['RX MAC', '接收端通过 800GMII 交付恢复的数据。']
  ];
  // Box names shown in the scene. The flow stages are duplicated for Flow 0/1.
  const modules = [
    [1, 15, 5, 'Scrambled Idle', -1, 0, 'idle'],
    [0, 0, 8, 'TX MAC'], [1, 0, 8, '64B/66B', -1, -0.25, 'encode'],
    [1, 0, 8, 'TX 速率匹配', -1, 0.25, 'txRate'], [2, 0, 24, '66b 分流'],
    [7, 0, 27, '32:8 PMA'], [8, 0, 27, '8× PAM4'],
    [7, 0, 27, 'PAM4 预编码（条件）', -1, 0.5, 'precode'],
    [8, 0, 27, '信号驱动（电接口）', -1, -0.39, 'driver'],
    [9, 15, 5, '逆预编码（条件）', -1, 0, 'inverse'],
    [9, 20, 5, 'PMA SIGNAL_OK', -1, 0, 'signal'],
    [7, 26, 5, 'PMA 图样发生', -1, 0, 'patternTx'],
    [9, 26, 5, 'PMA 图样检测', -1, 0, 'patternRx'],
    [8, -24, 5, '本地环回', -1, 0, 'localLoop'],
    [8, -31, 5, '远端环回', -1, 0, 'remoteLoop'],
    [9, 0, 27, 'CDR', -1, -0.33, 'cdr'],
    [9, 0, 27, 'Gray 解映射', -1, 0, 'gray'],
    [9, 0, 27, 'RX 解复用', -1, 0.33, 'demux'],
    [10, 0, 27, 'AM / Deskew'],
    [10, 0, 27, '按 UM 重排', -1, 0.43, 'reorder'],
    [14, 0, 8, '66b 合流'], [15, 0, 8, '64B/66B 解码', -1, -0.25, 'decode'],
    [15, 0, 8, 'RX 速率匹配', -1, 0.25, 'rxRate'], [16, 0, 8, 'RX MAC']
  ];
  for (const flow of [0, 1]) {
    const y = flow === 0 ? 10.8 : -10.8;
    modules.push(
      [3, y, 10, '257b 转码', flow], [4, y, 10, '加扰', flow],
      [5, y, 10, 'AM 插入', flow, -0.33, 'amInsert'],
      [5, y, 10, 'FEC 前分配', flow, 0, 'fecSplit'],
      [5, y, 10, 'RS 编码', flow, 0.33, 'rsEncode'],
      [6, y, 10, '16 lane', flow],
      [11, y, 10, '去交织', flow, -0.38, 'deinterleave'],
      [11, y, 10, 'RS 解码', flow, -0.13, 'rsDecode'],
      [11, y, 10, 'FEC 后交织', flow, 0.13, 'fecJoin'],
      [11, y, 10, 'AM 移除', flow, 0.38, 'amRemove'],
      [12, y, 10, '解扰', flow], [13, y, 10, '逆转码', flow]
    );
  }
  const pitch = 16;
  const x = stages.map((_, i) => (i - (stages.length - 1) / 2) * pitch);
  const SPAN = x[x.length - 1] - x[0];
  const ST = { lanes: 6, mux: 7, link: 8, demux: 9, align: 10, fec: 11, rx: 16 };
  const BAND = 16, FLOW_Y = 10.8, STEP_T = 1 / 56, STREAM = 40;
  const original = M.range(8);
  const flows = M.distribute(original);
  let stage = 14, progress = 0, recovery = 2;
  let idleMode = false;
  let active = false, playing = false, pending = 0, last = 0;
  let renderer, scene, camera, controls, resize;
  let cameraTouched = false;
  let zoomAnchor = null, zoomAnchorAt = 0;
  let focusMode = false, stageBand = null, stageBadge = null, focusBtn = null;
  let hoverStage = -1, hoverFlow = -1;
  let camTween = null, camTweenFrame = 0, camTweenTimer = 0;
  let inst, meta = [], count = 0;
  let tracks = [], curves = [], highlight = null, rings = [], bars = [], sheaths = [];
  let flowLines = [], aggLines = [];
  let buttons = [], tx = [], rx = [], lanes = [];
  let fault = { physical: 0, skew: 0, lane: 0, loss: false, am: false };
  let state, fecResults = [], words;
  let transportFailed = false;
  let linkGroup, theme = {};
  let labelHost, labelItems = [];
  let followActive = false, followBlock = 0, followU = 0, followInfo = null;
  let followTags = [], followTagHost, followTagEls = [], followPaper = null;
  let mapSelectedBlock = 0, mapSelectedChar = -1;
  let lensBlock = 0, lensOpen = false, lensZoom = 1;
  const MAX_FOLLOW_TAGS = 8;
  const moduleMeshes = [];

  function cssVar(name) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || '';
  }

  function readTheme() {
    theme = {
      bg: cssVar('--scene-bg') || '#eef1f5',
      paper: cssVar('--paper') || '#f3f5f7',
      ink: cssVar('--ink') || '#18202b',
      muted: cssVar('--muted') || '#687384',
      rule: cssVar('--rule') || '#d5dbe3',
      good: cssVar('--good') || '#2f8a4c',
      warn: cssVar('--warn') || '#c98a12',
      bad: cssVar('--bad') || '#cc2936',
      am: cssVar('--am') || '#e2a41f',
      box: cssVar('--scene-box') || '#dde3eb',
      edge: cssVar('--scene-edge') || '#8592a5'
    };
  }

  function faultInput() {
    return {
      physical: value('physical'), skew: value('skew'), lane: Math.max(0, value('lane')),
      loss: get('loss').checked, am: get('am').checked
    };
  }

  function stageT(index) { return index / (stages.length - 1); }
  function stageAtPath(t) {
    return Math.max(0, Math.min(stages.length - 1, Math.round(t * (stages.length - 1))));
  }

  // A MAC 66b block n is built from bytes n*8 .. n*8+7 of the cyclic payload.
  // Flow 0 takes even blocks, Flow 1 odd blocks; every four blocks in a flow
  // become one 257b transcoded block before AM/FEC.
  function blockInfo(n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    const text = payload();
    const bytes = M.range(8).map(i => text.charCodeAt((n * 8 + i) % text.length) & 127);
    return {
      n, flow: n % 2, local: Math.floor(n / 2),
      group: Math.floor(n / 8), pos: Math.floor(n / 2) % 4,
      bytes,
      hex: bytes.map(b => b.toString(16).padStart(2, '0')).join(' '),
      ascii: bytes.map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('')
    };
  }

  function followLaneList(flow) {
    return M.range(16).map(i => flow * 16 + i);
  }

  function followStageName(flow, u) {
    if (u < stageT(2)) return '800GMII · 66b 块';
    if (u < stageT(6)) return 'Flow ' + flow + ' · 转码 / 加扰 / AM / FEC';
    if (u < stageT(7)) return '32 条 PCS lane';
    if (u < stageT(9)) return '32:8 PMA / 8 路 PAM4';
    if (u < stageT(11)) return 'RX PMA / Deskew / 重排';
    if (u < stageT(14)) return 'RX Flow ' + flow + ' · FEC / 解扰 / 逆转码';
    if (u < stageT(15)) return '66b 合流 / 64B/66B 解码';
    return 'RX MAC / 800GMII';
  }

  function followBad(flow, u) {
    if (u > stageT(7) && fault.loss) return true;
    if (u > stageT(9) && state && !state.aligned) return true;
    if (u > stageT(11) && fecResults[flow] && !fecResults[flow].valid) return true;
    return false;
  }

  function followTag(position, text, color) {
    if (followTags.length >= MAX_FOLLOW_TAGS) return;
    followTags.push({ pos: position.clone(), text, color: color.getStyle() });
  }

  function initFollowTags(host) {
    followTagHost = document.createElement('div');
    followTagHost.className = 'follow-tags g800-follow-tags';
    followTagHost.hidden = true;
    followTagHost.setAttribute('aria-hidden', 'true');
    host.appendChild(followTagHost);
    for (let i = 0; i < MAX_FOLLOW_TAGS; i++) {
      const el = document.createElement('span');
      el.className = 'ftag g800-ftag';
      el.style.visibility = 'hidden';
      followTagHost.appendChild(el);
      followTagEls.push({ el, text: '', shown: false, w: 0 });
    }
  }

  function updateFollowBar() {
    const bar = byId('g800-follow-bar');
    if (!bar) return;
    bar.hidden = !followActive;
    if (!followActive || !followInfo) return;
    const flow = followInfo.flow;
    const label = byId('g800-follow-label');
    const where = byId('g800-follow-where');
    const labelText = 'MAC 66b 块 #' + followInfo.n;
    const whereText = 'F' + flow +
      ' · 257b #' + followInfo.group +
      ' · 组内 ' + (followInfo.pos + 1) + '/4' +
      ' · 字节 ' + followInfo.hex + ' “' + followInfo.ascii + '”' +
      ' · ' + followStageName(flow, followU);
    if (label.textContent !== labelText) label.textContent = labelText;
    if (where.textContent !== whereText) where.textContent = whereText;
  }

  function syncFollowUI() {
    const start = byId('g800-follow-start');
    if (start) {
      start.setAttribute('aria-pressed', String(followActive));
      start.textContent = followActive ? '重新追踪' : '追踪动画';
    }
    if (followTagHost) followTagHost.hidden = !followActive;
    updateFollowBar();
  }

  function startFollow(block) {
    followBlock = Math.max(0, Math.floor(Number(block) || 0));
    followU = 0;
    followActive = true;
    followInfo = blockInfo(followBlock);
    stage = 0;
    progress = 0;
    recovery = 2;
    const input = get('follow-block');
    if (input) input.value = followBlock;
    get('flow').value = -1;
    get('lane').value = -1;
    mapSelectedBlock = followBlock;
    mapSelectedChar = -1;
    markMapSelection();
    syncFollowUI();
    setPlaying(true);
    updateState();
    resetCamera();
  }

  function stopFollow() {
    followActive = false;
    followU = 0;
    followInfo = null;
    followTags = [];
    syncFollowUI();
    updateFollowTags();
    draw();
  }

  function escHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function byteHex(b) { return b.toString(16).padStart(2, '0').toUpperCase(); }

  function bitsHtml(bytes, focusByte) {
    let html = '';
    bytes.forEach((b, bi) => {
      M.range(8).forEach(bit => {
        const v = (b >> bit) & 1;
        html += '<span class="g800-bit' + (v ? ' is-one' : '') +
          (focusByte === bi ? ' is-focus' : '') +
          '" title="字节 ' + bi + ' · bit ' + bit + '">' + v + '</span>';
      });
    });
    return html;
  }

  function bitRowFromBits(bits, focusStart, focusLen) {
    let html = '';
    bits.forEach((bit, i) => {
      html += '<span class="g800-bit' + (bit ? ' is-one' : '') +
        (i === 0 ? ' is-header' : '') +
        (i >= focusStart && i < focusStart + focusLen ? ' is-focus' : '') +
        '" title="bit ' + i + '">' + bit + '</span>';
    });
    return html;
  }

  function b257RowsHtml(group, flow, activePos) {
    let html = '<div class="g800-b257-line">' +
      '<span class="g800-b257-label"><b>257b 头</b>（1 位）</span>' +
      '<div class="g800-b257-bits"><span class="g800-bit is-header">1</span></div></div>';
    M.range(4).forEach(r => {
      const child = blockInfo(group * 8 + flow + 2 * r);
      const active = r === activePos;
      html += '<div class="g800-b257-line' + (active ? ' is-active' : '') + '">' +
        '<span class="g800-b257-label"><b>块 ' + (r + 1) + ' · MAC #' + child.n + '</b>' +
        escHtml(child.ascii) + '</span>' +
        '<div class="g800-b257-bits">' + bitsHtml(child.bytes, -1) + '</div></div>';
    });
    return html;
  }

  function byteGroupsHtml(bytes, focusByte) {
    let html = '';
    bytes.forEach((b, i) => {
      const ch = b === 32 ? '·' : String.fromCharCode(b);
      html += '<div class="g800-bytegroup' + (focusByte === i ? ' is-focus' : '') + '">' +
        '<span class="g800-byte-label"><b>' + escHtml(ch) + '</b><span>0x' + byteHex(b) + '</span></span>' +
        '<div class="g800-bitrow">' + bitsHtml([b], focusByte === i ? 0 : -1) + '</div></div>';
    });
    return html;
  }

  function byteCardsHtml(bytes, focusByte, base) {
    let html = '';
    bytes.forEach((b, i) => {
      const ch = b === 32 ? '·' : String.fromCharCode(b);
      html += '<div class="g800-byte-card' + (focusByte === i ? ' is-focus' : '') + '">' +
        '<b>' + escHtml(ch) + '</b>' +
        '<span>#' + (base + i) + ' · 0x' + byteHex(b) + '</span>' +
        '<code>' + M.range(8).map(k => (b >> k) & 1).join('') + '</code></div>';
    });
    return html;
  }

  function dataKindForStage(index) {
    if (index <= 2 || index === 14) return 'b66';
    if (index === 3 || index === 13) return 'b257';
    if (index === 4) return 'scramble';
    if (index === 12) return 'descramble';
    if (index === 5 || index === 11) return 'amfec';
    if (index === 6) return 'lane';
    if (index === 7 || index === 8) return 'pma';
    if (index === 9 || index === 10) return 'lock';
    return 'bytes';
  }

  function stageDataNote(index) {
    if (index <= 1) return 'MAC/800GMII：每 8 字节编码为 1 个 66b 块（01 + 64 位数据）。';
    if (index === 2) return '66b 分流：偶数块进 Flow 0，奇数块进 Flow 1；每 4 个 66b 块转码为 1 个 257b 块。';
    if (index === 3) return '256B/257B 转码：4 个 66b 块重打包为 1 个 257b 块（1 位头 + 4×64 位）。';
    if (index === 4) return '加扰：每个 Flow 独立使用 x⁵⁸+x³⁹+1，输入/输出均为 257b 块。';
    if (index === 5) return 'AM/FEC：AM 组 8×257 位；每 Flow 生成 A/B 两个 RS(544,514) 码字。';
    if (index === 6) return '每个 Flow 将两个 RS 码字的 10 位符号分发到本 Flow 的 16 条 PCS lane。';
    if (index === 7) return '32:8 PMA：每物理通道按 F0、F0、F1、F1 复用四个 PCS 位。';
    if (index === 8) return '8 路 PAM4：每通道 106.25 Gb/s，Gray 映射 0,1,3,2。';
    if (index === 9) return 'RX PMA：不受限比特复用，起始槽相位可改变 RX lane 顺序。';
    if (index === 10) return 'AM 锁定/Deskew：全部 32 lane 锁定并满足 152 ns Skew 后按 ID 重排。';
    if (index === 11) return stages[index][1];
    if (index === 12) return '解扰：按相同多项式恢复 257b 块。';
    if (index === 13) return '257b 逆转码：恢复每 Flow 的四个 66b 块及同步头。';
    if (index === 14) return '66b 合流：按 Flow 0、Flow 1 交替恢复原始 66b 流。';
    if (index === 15) return '64B/66B 解码：由 66b 块还原 8 字节，经 800GMII 交付。';
    return 'RX MAC：接收端通过 800GMII 交付恢复的数据。';
  }

  function view66bHtml(block, note) {
    const bi = blockInfo(block);
    const start = bi.n * 8;
    return '<div class="g800-inspect-summary">' +
        '<span><b>MAC 66b 块</b> #' + bi.n + '</span>' +
        '<span><b>Flow</b> ' + bi.flow + '</span>' +
        '<span><b>257b 块</b> #' + bi.group + ' · 组内 ' + (bi.pos + 1) + '/4</span>' +
        '<span><b>字节</b> #' + start + '–#' + (start + 7) + '</span>' +
        '<span>“' + escHtml(bi.ascii) + '”</span></div>' +
      '<div class="g800-inspect-section"><h4>字符 ↔ 字节</h4>' +
        '<div class="g800-byte-row">' + byteCardsHtml(bi.bytes, -1, start) + '</div></div>' +
      '<div class="g800-inspect-section"><h4>66b 块 · 2 位同步头 + 64 位数据</h4>' +
        '<div class="g800-bitgrid">' +
          '<div class="g800-bytegroup"><span class="g800-byte-label"><b>SYNC</b><span>01</span></span>' +
            '<div class="g800-bitrow"><span class="g800-bit is-header">0</span><span class="g800-bit is-header">1</span></div></div>' +
          byteGroupsHtml(bi.bytes, -1) +
        '</div></div>' +
      (note ? '<p class="g800-inspect-note">' + note + '</p>' : '');
  }

  function viewBytesHtml(block, note) {
    const bi = blockInfo(block);
    const start = bi.n * 8;
    return '<div class="g800-inspect-summary">' +
        '<span><b>MAC 66b 块</b> #' + bi.n + '</span>' +
        '<span><b>Flow</b> ' + bi.flow + '</span>' +
        '<span><b>字节</b> #' + start + '–#' + (start + 7) + '</span></div>' +
      '<div class="g800-inspect-section"><h4>800GMII 交付字节</h4>' +
        '<div class="g800-byte-row">' + byteCardsHtml(bi.bytes, -1, start) + '</div>' +
        '<p class="g800-inspect-text">“' + escHtml(bi.ascii) + '”</p></div>' +
      (note ? '<p class="g800-inspect-note">' + note + '</p>' : '');
  }

  function view257bHtml(block, note) {
    const bi = blockInfo(block);
    return '<div class="g800-inspect-summary">' +
        '<span><b>Flow</b> ' + bi.flow + '</span>' +
        '<span><b>257b 块</b> #' + bi.group + '</span>' +
        '<span><b>选中 MAC 块</b> #' + bi.n + ' · 组内 ' + (bi.pos + 1) + '/4</span>' +
        '<span>“' + escHtml(bi.ascii) + '”</span></div>' +
      '<div class="g800-inspect-section"><h4>257b 块 · 1 位头 + 4 × 64 位</h4>' +
        '<div class="g800-b257">' + b257RowsHtml(bi.group, bi.flow, bi.pos) + '</div></div>' +
      '<div class="g800-inspect-section"><h4>选中 66b 块的字节</h4>' +
        '<div class="g800-byte-row">' + byteCardsHtml(bi.bytes, -1, bi.n * 8) + '</div></div>' +
      (note ? '<p class="g800-inspect-note">' + note + '</p>' : '');
  }

  function block257Bits(bi) {
    const bits = [1];
    M.range(4).forEach(r => {
      const child = blockInfo(bi.group * 8 + bi.flow + 2 * r);
      child.bytes.forEach(b => {
        M.range(8).forEach(k => bits.push((b >> k) & 1));
      });
    });
    return bits;
  }

  function viewScrambleHtml(block, rx) {
    if (rx) {
      const flow = block % 2;
      const result = fecResults[flow];
      if (!state.aligned || !result.valid) return '<p>对齐和 RS 解码成功后才有可用数据。</p>';
      const input = result.data.slice(0, 257);
      const output = M.scramble(input, flow, true);
      return '<p>Flow ' + flow + ' · 纠错并移除 AM 后的首个 257b 块</p>' +
        '<div class="g800-b257-bits">' + bitRowFromBits(input, 1, 64) + '</div>' +
        '<p>解扰输出</p><div class="g800-b257-bits">' + bitRowFromBits(output, 1, 64) + '</div>';
    }
    const bi = blockInfo(block);
    const plain = block257Bits(bi);
    const scrambled = M.scramble(plain, bi.flow);
    const focus = 1 + 64 * bi.pos;
    return '<div class="g800-inspect-summary">' +
        '<span><b>Flow</b> ' + bi.flow + '</span>' +
        '<span><b>257b 块</b> #' + bi.group + '</span>' +
        '<span><b>选中 MAC 块</b> #' + bi.n + ' · 组内 ' + (bi.pos + 1) + '/4</span>' +
        '<span>“' + escHtml(bi.ascii) + '”</span></div>' +
      '<div class="g800-inspect-section"><h4>输入 257b 块（未加扰）</h4>' +
        '<div class="g800-b257-bits">' + bitRowFromBits(plain, focus, 64) + '</div></div>' +
      '<div class="g800-inspect-section"><h4>加扰输出 257b 块</h4>' +
        '<div class="g800-b257-bits">' + bitRowFromBits(scrambled, focus, 64) + '</div></div>' +
      '<p class="g800-inspect-note">自同步加扰器 x⁵⁸+x³⁹+1；两个 Flow 独立运行。高亮为选中 66b 块对应的 64 位，bit 0 先发送。</p>';
  }

  function viewAmFecHtml(block) {
    const bi = blockInfo(block);
    const pair = words && words[bi.flow];
    const fec = fecResults[bi.flow];
    let symbols = '';
    if (pair) {
      symbols = pair[0].slice(0, 24).map((v, i) =>
        '<span class="g800-sym" title="F' + bi.flow + '-A 符号 #' + i + '">' +
        i + ':' + v.toString(16).toUpperCase().padStart(3, '0') + '</span>').join('');
    }
    return '<div class="g800-inspect-summary">' +
        '<span><b>Flow</b> ' + bi.flow + '</span>' +
        '<span><b>257b 块</b> #' + bi.group + '</span>' +
        '<span><b>选中 MAC 块</b> #' + bi.n + ' · 组内 ' + (bi.pos + 1) + '/4</span></div>' +
      '<div class="g800-inspect-section"><h4>257b 块 · 1 位头 + 4 × 64 位</h4>' +
        '<div class="g800-b257">' + b257RowsHtml(bi.group, bi.flow, bi.pos) + '</div></div>' +
      '<div class="g800-inspect-section"><h4>AM 组 / RS(544,514)</h4>' +
        '<p class="g800-inspect-note">AM 组为 8×257 位，标准每 163,840 个 257b 块插入一次；每 Flow 生成 A/B 两个码字，514 个数据符号 + 30 个校验符号，最多纠正 15 个符号。</p>' +
        '<div class="g800-sym-row"><span class="g800-sym">AM 组 · 8×257 位</span>' +
          '<span class="g800-sym">F' + bi.flow + '-A · 544 符号</span>' +
          '<span class="g800-sym">F' + bi.flow + '-B · 544 符号</span>' +
          (fec ? '<span class="g800-sym">' + (fec.valid ? (fec.corrected ? 'FEC 纠正 ' + fec.errors + ' 个符号' : 'FEC 正常') : 'FEC 不可纠正') + '</span>' : '') +
        '</div>' +
        '<p class="g800-inspect-note">A 码字前 24 个 10 位符号（十六进制）：</p>' +
        '<div class="g800-sym-row">' + symbols + '</div></div>';
  }

  function viewLaneHtml(lane, stageIndex) {
    const flow = Math.floor(lane / 16);
    const id = M.symbolAt(lane, 0);
    const symbol = (words && words[flow] && words[flow][id.word]) ? words[flow][id.word][id.index] : 0;
    const bits = M.range(10).map(k => (symbol >> k) & 1);
    const physical = lanes[lane];
    const channelLanes = physical != null && tx[physical] ? tx[physical] : [];
    const slot = channelLanes.indexOf(lane);
    const rxLane = rx.indexOf(lane);
    const locked = state ? state.locked[lane] : false;
    let pam = null;
    if (physical != null && tx[physical] && slot >= 0) {
      pam = M.pam4Pair(words, tx, physical, 0, 0, Math.floor(slot / 2));
    }
    const symbolHtml = bits.map((bit, i) =>
      '<span class="g800-bit' + (bit ? ' is-one' : '') + '" title="bit ' + i + '">' + bit + '</span>').join('');
    const pamHtml = pam
      ? '<div class="g800-inspect-section"><h4>32:8 PMA / PAM4</h4>' +
        '<p class="g800-inspect-note">物理通道 ' + physical + '，TX 时隙 ' + (slot + 1) + '/4。位对：PCS lane ' +
        pam.ids.join(' / ') + ' → ' + pam.bits.join('') + ' → PAM4 电平 ' + pam.level +
        '（Gray 映射 0,1,3,2）。</p></div>'
      : '';
    const rxHtml = stageIndex >= 9
      ? '<div class="g800-inspect-section"><h4>RX PMA / Deskew</h4>' +
        '<p class="g800-inspect-note">RX PMA lane ' + (rxLane < 0 ? '—' : rxLane) +
        ' → PCS lane ' + lane + '；AM 锁定 ' + (locked ? '✓' : '—') +
        '；align_status ' + (state && state.aligned ? 'true' : 'false') +
        '；Skew ' + fault.skew + ' / ' + M.deskewLimit + ' ns。</p></div>'
      : '';
    return '<div class="g800-inspect-summary">' +
        '<span><b>PCS lane</b> ' + lane + '</span>' +
        '<span><b>Flow</b> ' + flow + '</span>' +
        '<span><b>PAM4</b> ' + (physical == null ? '—' : physical) + '</span>' +
        '<span><b>TX 时隙</b> ' + (slot < 0 ? '—' : (slot + 1) + '/4') + '</span>' +
        '<span><b>RX PMA</b> ' + (rxLane < 0 ? '—' : rxLane) + '</span>' +
        '<span><b>AM 锁定</b> ' + (locked ? '✓' : '—') + '</span></div>' +
      '<div class="g800-inspect-section"><h4>10 位 PCS lane 符号</h4>' +
        '<div class="g800-bitrow">' + symbolHtml + '</div>' +
        '<p class="g800-inspect-note">F' + flow + '-' + ['A', 'B'][id.word] + ' 符号 #' + id.index +
        ' · 0x' + symbol.toString(16).toUpperCase().padStart(3, '0') +
        ' · 位 0→9：' + bits.join('') + '（bit 0 先发送）。</p></div>' +
      pamHtml + rxHtml;
  }

  function renderPayloadMap() {
    const strip = byId('g800-map-strip');
    if (!strip) return;
    const text = payload();
    const groups = Math.max(1, Math.ceil(text.length / 8));
    let html = '<div class="g800-map-groups">';
    for (let block = 0; block < groups; block++) {
      const flow = block % 2;
      const group = Math.floor(block / 8);
      const pos = Math.floor(block / 2) % 4;
      html += '<div class="g800-map-group" data-block="' + block + '" role="group" aria-label="MAC 66b 块 ' + block + '">' +
        '<span class="g800-map-block">B' + block + ' · F' + flow + ' · 257b #' + group +
        ' · ' + (pos + 1) + '/4</span>' +
        '<div class="g800-map-cells">';
      for (let i = 0; i < 8; i++) {
        const index = block * 8 + i;
        const ch = text[index % text.length];
        const wrapped = index >= text.length;
        const hex = byteHex(ch.charCodeAt(0) & 127);
        const glyph = ch === ' ' ? '·' : ch;
        html += '<button type="button" class="g800-ch' +
          (ch === ' ' ? ' is-space' : '') + (wrapped ? ' is-wrap' : '') +
          '" data-index="' + index + '" data-block="' + block +
          '" title="字节 #' + index + ' · 0x' + hex + ' · 块 #' + block +
          (wrapped ? '（字符串循环）' : '') + '">' +
          '<b>' + escHtml(glyph) + '</b><span>' + hex + '</span></button>';
      }
      html += '</div></div>';
    }
    html += '</div>';
    strip.innerHTML = html;
    markMapSelection();
  }

  function markMapSelection() {
    const strip = byId('g800-map-strip');
    const note = byId('g800-map-note');
    if (!strip) return;
    const groups = strip.querySelectorAll('.g800-map-group');
    groups.forEach(group => {
      group.classList.toggle('is-selected', +group.dataset.block === mapSelectedBlock);
    });
    strip.querySelectorAll('.g800-ch').forEach(cell => {
      cell.classList.toggle('is-focus', +cell.dataset.index === mapSelectedChar);
    });
    const selected = strip.querySelector('.g800-map-group.is-selected');
    if (selected) {
      const sr = strip.getBoundingClientRect();
      const gr = selected.getBoundingClientRect();
      if (gr.left < sr.left || gr.right > sr.right) {
        strip.scrollLeft += gr.left - sr.left - 12;
      }
    }
    if (note) {
      note.textContent = mapSelectedBlock >= groups.length
        ? '当前选择块 #' + mapSelectedBlock + ' 超出本段字符串的 B0–B' + (groups.length - 1) +
          '；放大视图仍按循环字符显示。'
        : '本段字符串覆盖 B0–B' + (groups.length - 1) +
          '；点击任意字符可放大查看对应 66b 块。字符按字节循环使用。';
    }
  }

  function setLensZoom(value) {
    lensZoom = Math.min(2.2, Math.max(0.65, Number(value) || 1));
    const body = byId('g800-lens-body');
    if (body) body.style.setProperty('--g800-lens-zoom', lensZoom);
    const label = byId('g800-lens-zoom-label');
    if (label) label.textContent = Math.round(lensZoom * 100) + '%';
  }

  function syncLensButtons() {
    const prev = byId('g800-lens-prev');
    if (prev) prev.disabled = lensBlock <= 0;
    const follow = byId('g800-lens-follow');
    if (follow) follow.textContent = followActive && followBlock === lensBlock ? '重新追踪此块' : '追踪此块';
  }

  function renderBlockLens() {
    const body = byId('g800-lens-body');
    const title = byId('g800-lens-title');
    const sub = byId('g800-lens-sub');
    if (!body || !title || !sub) return;
    const bi = blockInfo(lensBlock);
    const text = payload();
    const start = bi.n * 8;
    const wrapped = start + 7 >= text.length;
    const focusByte = mapSelectedChar >= start && mapSelectedChar < start + 8
      ? mapSelectedChar - start : -1;
    title.textContent = 'MAC 66b 块 #' + bi.n;
    sub.textContent = 'F' + bi.flow + ' · 257b 块 #' + bi.group +
      ' · 组内 ' + (bi.pos + 1) + '/4' +
      ' · 字节 #' + start + '–#' + (start + 7) +
      (wrapped ? '（循环）' : '') + ' · “' + bi.ascii + '”';

    const laneChips = M.range(16).map(i => {
      const lane = bi.flow * 16 + i;
      const physical = lanes[lane] == null ? '—' : lanes[lane];
      return '<span class="g800-lane-chip is-flow' + bi.flow + '">PCS ' + lane + ' → PMA ' + physical + '</span>';
    }).join('');
    const rxChips = M.range(16).map(i => {
      const lane = bi.flow * 16 + i;
      const receive = rx.indexOf(lane);
      return '<span class="g800-lane-chip">RX PMA ' + (receive < 0 ? '—' : receive) + '</span>';
    }).join('');
    const b257Rows = b257RowsHtml(bi.group, bi.flow, bi.pos);
    body.innerHTML =
      '<div class="g800-lens-summary">' +
        '<span><b>MAC 块</b> #' + bi.n + '</span>' +
        '<span><b>Flow</b> ' + bi.flow + '</span>' +
        '<span><b>257b 块</b> #' + bi.group + '</span>' +
        '<span><b>组内</b> ' + (bi.pos + 1) + '/4</span>' +
        '<span><b>字节</b> #' + start + '–#' + (start + 7) + '</span>' +
        (wrapped ? '<span>字符串循环补齐</span>' : '') +
      '</div>' +
      '<div class="g800-lens-section"><h4>字符 ↔ 字节（每字节 bit 0 先发送）</h4>' +
        '<div class="g800-byte-row">' + byteCardsHtml(bi.bytes, focusByte, start) + '</div></div>' +
      '<div class="g800-lens-section"><h4>66b 块 · 2 位同步头 + 64 位数据</h4>' +
        '<div class="g800-bitgrid">' +
          '<div class="g800-bytegroup"><span class="g800-byte-label"><b>SYNC</b><span>01</span></span>' +
            '<div class="g800-bitrow"><span class="g800-bit is-header">0</span><span class="g800-bit is-header">1</span></div></div>' +
          byteGroupsHtml(bi.bytes, focusByte) +
        '</div></div>' +
      '<div class="g800-lens-section"><h4>所在 257b 块 · 1 位头 + 4 × 64 位</h4>' +
        '<div class="g800-b257">' + b257Rows + '</div></div>' +
      '<div class="g800-lens-section"><h4>32 PCS lane / PAM4 映射</h4>' +
        '<p class="g800-lens-summary">Flow ' + bi.flow + ' 的 257b 块分布到 16 条 PCS lane，再经 32:8 PMA 到 8 条 PAM4 通道。</p>' +
        '<div class="g800-lane-row">' + laneChips + '</div>' +
        '<div class="g800-lane-row">' + rxChips + '</div></div>';
    setLensZoom(lensZoom);
    syncLensButtons();
  }

  function openBlockLens(block, focusChar) {
    lensBlock = Math.max(0, Math.floor(Number(block) || 0));
    mapSelectedBlock = lensBlock;
    mapSelectedChar = (focusChar != null && Math.floor(focusChar / 8) === lensBlock)
      ? focusChar : -1;
    if (!followActive) get('follow-block').value = lensBlock;
    markMapSelection();
    renderBlockLens();
    const dialog = byId('g800-lens');
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    lensOpen = true;
  }

  function closeBlockLens() {
    const dialog = byId('g800-lens');
    lensOpen = false;
    if (dialog && dialog.open) dialog.close();
  }

  const SHADES = [0.7, 0.84, 1.18, 0.68, 1, 0.76];

  function moduleColors() {
    const box = new T.Color(theme.box);
    return {
      neutral: box.clone().lerp(new T.Color(theme.ink), 0.22),
      flow0: box.clone().lerp(new T.Color('#268ec7'), 0.38),
      flow1: box.clone().lerp(new T.Color('#d97139'), 0.38),
      edge: new T.Color(theme.edge)
    };
  }

  function recolorModules() {
    const colors = moduleColors();
    moduleMeshes.forEach(({ box }) => {
      const flow = box.userData.flow;
      const base = flow === 0 ? colors.flow0 : flow === 1 ? colors.flow1 : colors.neutral;
      box.material.forEach((material, i) => {
        material.color.copy(base).multiplyScalar(SHADES[i]);
      });
      const edge = box.children[0];
      if (edge && edge.material) edge.material.color.copy(colors.edge);
    });
  }

  // The lane path in the scene has four visible zones: one aggregate stream,
  // two Flow streams, the 32 PCS lanes (including the PMA/channel stretch) and
  // the receive mirror. Only x/y/z geometry lives here; protocol state lives in
  // PCS800Model.
  function route(lane, index) {
    const flow = lane < 16 ? 0 : 1;
    const physical = lanes[lane] == null ? 0 : lanes[lane];
    const row = lane % 16;
    const receiveSlot = Math.max(0, rx.indexOf(lane));
    const spread = flow ? -(5.4 + row * 0.60) : (5.4 + row * 0.60);
    const slot = tx[physical]?.indexOf(lane) ?? 0;
    const physicalY = (3.5 - physical) * 2.55 + (slot - 1.5) * 0.42;
    const rxSpread = (15.5 - receiveSlot) * 0.84;
    const branch = flow ? -FLOW_Y : FLOW_Y;
    const y = [0, 0, branch, branch, branch, branch, spread, physicalY, physicalY,
      rxSpread, spread, branch, branch, branch, 0, 0, 0][index];
    let z = 0;
    if (index === 6) z = (row % 4 - 1.5) * 0.4 + (flow ? 0.12 : -0.12);
    else if (index === 9) z = (receiveSlot % 4 - 1.5) * 0.42;
    else if (index >= 10) z = (lane % 4 - 1.5) * 0.36;
    const delayed = physical === fault.physical && index === ST.demux ? fault.skew * 0.042 : 0;
    return new T.Vector3(x[index] - delayed, y, z);
  }

  function flowColor(i) {
    const base = new T.Color(i < 16 ? '#268ec7' : '#d97139');
    return base.multiplyScalar(0.8 + (i % 16) / 48);
  }

  function dimColor(color, on) {
    return on ? color : color.clone().lerp(new T.Color(theme.paper), 0.78);
  }

  function smooth(t) {
    t = Math.min(1, Math.max(0, t));
    return t * t * (3 - 2 * t);
  }

  function flowTxY(flow, t) {
    const y = flow ? -FLOW_Y : FLOW_Y;
    return y * smooth((t - stageT(2)) / (stageT(3) - stageT(2)));
  }

  function flowRxY(flow, t) {
    const y = flow ? -FLOW_Y : FLOW_Y;
    return y * (1 - smooth((t - stageT(13)) / (stageT(14) - stageT(13))));
  }

  function frameNeed(aspect) {
    const tanHalf = Math.tan(camera.fov * Math.PI / 360);
    return Math.max(90,
      (SPAN / 2 + 16) / (tanHalf * aspect),
      33 / tanHalf);
  }

  function fitCameraMin() {
    const host = get('scene');
    const aspect = Math.max(0.8, (host.clientWidth || 16) / (host.clientHeight || 9));
    const need = frameNeed(aspect);
    const offset = camera.position.clone().sub(controls.target);
    if (offset.length() < need) {
      offset.setLength(need);
      camera.position.copy(controls.target).add(offset);
    }
  }

  // Wheel zoom toward the point under the cursor, so a data block can fill
  // the view without first panning it to the centre.
  function wheelZoom(event) {
    if (!active || !camera || !controls || !inst) return;
    camTween = null;
    event.preventDefault();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    else event.stopPropagation();
    const host = get('scene');
    const rect = host.getBoundingClientRect();
    const pointer = new T.Vector2(
      (event.clientX - rect.left) / rect.width * 2 - 1,
      1 - (event.clientY - rect.top) / rect.height * 2);
    const ray = new T.Raycaster();
    const zoomIn = event.deltaY < 0;
    const scale = zoomIn ? 0.893 : 1 / 0.893;
    const now = performance.now();
    if (zoomIn) {
      if (!zoomAnchor || now - zoomAnchorAt > 400) {
        zoomAnchor = null;
        const offsets = [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6], [9, 9], [-9, 9], [9, -9], [-9, -9]];
        for (let i = 0; i < offsets.length && !zoomAnchor; i++) {
          ray.setFromCamera(new T.Vector2(
            pointer.x + offsets[i][0] / rect.width * 2,
            pointer.y - offsets[i][1] / rect.height * 2), camera);
          const hit = ray.intersectObject(inst, false)[0];
          if (hit) zoomAnchor = hit.point.clone();
        }
      }
      zoomAnchorAt = now;
      if (zoomAnchor) controls.target.lerp(zoomAnchor, 1 - scale);
    } else {
      zoomAnchor = null;
      zoomAnchorAt = 0;
    }
    const offset = camera.position.clone().sub(controls.target);
    offset.setLength(Math.min(520, Math.max(3, offset.length() * scale)));
    camera.position.copy(controls.target).add(offset);
    cameraTouched = true;
    controls.update();
    draw();
  }

  function resetCamera(closeUp = false) {
    laneView = closeUp;
    if (!camera) return;
    camTween = null;
    cameraTouched = false;
    zoomAnchor = null;
    zoomAnchorAt = 0;
    const host = get('scene');
    const aspect = Math.max(0.8, (host.clientWidth || 16) / (host.clientHeight || 9));
    const center = closeUp ? (x[5] + x[11]) / 2 : 0;
    const tanHalf = Math.tan(camera.fov * Math.PI / 360);
    const dist = closeUp ? Math.max((x[11] - x[5] + 20) / (2 * tanHalf * aspect), 35 / tanHalf)
      : frameNeed(aspect);
    camera.position.set(center + dist * 0.05, dist * 0.21, dist * 0.975);
    controls.target.set(center, 0, 0);
    controls.update();
    draw();
  }

  // 阶段聚焦：把相机平滑移到当前处理列，并只保留该阶段的模块标签。
  function focusStageCamera(index) {
    if (!camera || !controls) return;
    const host = get('scene');
    const aspect = Math.max(0.8, (host.clientWidth || 16) / (host.clientHeight || 9));
    const tanHalf = Math.tan(camera.fov * Math.PI / 360);
    const need = Math.max(96, (BAND + 18) / tanHalf, 32 / (tanHalf * aspect));
    const dir = new T.Vector3(0.05, 0.21, 0.975).normalize();
    const look = new T.Vector3(x[index], 0, 0);
    tweenCamera(look.clone().addScaledVector(dir, need), look);
  }

  function tweenCamera(toPos, toLook) {
    if (!camera || !controls) return;
    camTween = {
      fromPos: camera.position.clone(), fromLook: controls.target.clone(),
      toPos, toLook, start: performance.now(), dur: 420
    };
    // 动画帧在后台标签页可能被暂停，用定时器兜底保证最终机位生效。
    clearTimeout(camTweenTimer);
    camTweenTimer = setTimeout(() => {
      if (!camTween) return;
      camTween = null;
      camera.position.copy(toPos);
      controls.target.copy(toLook);
      controls.update();
      draw();
    }, 540);
    if (!camTweenFrame) camTweenFrame = requestAnimationFrame(stepTween);
  }

  function stepTween(now) {
    camTweenFrame = 0;
    if (!camTween || !camera || !controls) return;
    const k = Math.min(1, (now - camTween.start) / camTween.dur);
    const ease = k * k * (3 - 2 * k);
    camera.position.lerpVectors(camTween.fromPos, camTween.toPos, ease);
    controls.target.lerpVectors(camTween.fromLook, camTween.toLook, ease);
    controls.update();
    draw();
    if (k < 1) {
      camTweenFrame = requestAnimationFrame(stepTween);
    } else {
      camTween = null;
      clearTimeout(camTweenTimer);
    }
  }

  function setFocusMode(on) {
    focusMode = on;
    if (focusBtn) {
      focusBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      focusBtn.textContent = on ? '退出聚焦' : '聚焦阶段';
    }
    if (on) focusStageCamera(stage);
    else resetCamera();
    if (renderer) {
      buildLabels();
      draw();
    }
  }

  function buildStageBand() {
    if (stageBand) return;
    stageBand = new T.Mesh(new T.PlaneGeometry(3.6, BAND * 2 + 10),
      new T.MeshBasicMaterial({
        color: new T.Color(theme.ink), transparent: true, opacity: 0.05, depthWrite: false
      }));
    stageBand.position.set(x[stage], 0, -9);
    scene.add(stageBand);
  }

  function buildFlowArrows() {
    const color = new T.Color(theme.muted);
    const spots = [
      [x[0] + (x[1] - x[0]) / 2, 0],
      [x[13] + (x[14] - x[13]) / 2, 0],
      [x[15] + (x[16] - x[15]) / 2, 0]
    ];
    [0, 1].forEach(flow => {
      const y = flow ? -FLOW_Y : FLOW_Y;
      spots.push([x[3] + (x[4] - x[3]) / 2, y], [x[12] + (x[13] - x[12]) / 2, y]);
    });
    spots.forEach(([px, py]) => {
      const cone = new T.Mesh(new T.ConeGeometry(0.55, 1.7, 10),
        new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 }));
      cone.position.set(px, py, 1.4);
      cone.rotation.z = -Math.PI / 2;
      scene.add(cone);
    });
  }

  function buildStageBadge(host) {
    stageBadge = document.createElement('button');
    stageBadge.type = 'button';
    stageBadge.className = 'g800-stage-badge';
    stageBadge.setAttribute('aria-pressed', 'false');
    stageBadge.title = '点击切换聚焦模式：只显示当前阶段标签并把相机移到该列';
    stageBadge.setAttribute('aria-label', '当前阶段与聚焦开关');
    stageBadge.addEventListener('click', () => setFocusMode(!focusMode));
    host.appendChild(stageBadge);
  }

  function updateBadge() {
    if (!stageBadge) return;
    const sig = stage + ':' + focusMode;
    if (stageBadge.dataset.sig === sig) return;
    stageBadge.dataset.sig = sig;
    stageBadge.innerHTML = '<b>' + (stage + 1) + ' / ' + stages.length + '</b>' +
      '<span>' + stages[stage][0] + '</span>' + (focusMode ? '<i>聚焦</i>' : '');
    stageBadge.setAttribute('aria-pressed', focusMode ? 'true' : 'false');
    stageBadge.classList.toggle('is-focus', focusMode);
  }

  function addModule(index, y, height, title, color, flow = -1, offset = 0, operation) {
    const width = index === 11 ? 3.6 : operation ? 4.4 : 7.6;
    const geometry = new T.BoxGeometry(width, height, 5.4);
    const material = SHADES.map(shade =>
      new T.MeshLambertMaterial({
        color: color.clone().multiplyScalar(shade),
        transparent: true,
        opacity: 0.9
      }));
    const box = new T.Mesh(geometry, material);
    box.position.set(x[index] + offset * pitch, y, -4.3);
    box.userData.operation = operation;
    box.add(new T.LineSegments(new T.EdgesGeometry(geometry),
      new T.LineBasicMaterial({ color: moduleColors().edge })));
    box.userData.stage = index;
    box.userData.flow = flow;
    scene.add(box);
    moduleMeshes.push({ box, index });
  }

  function addModules() {
    scene.add(new T.HemisphereLight(0xffffff, 0x8291a8, 1.1));
    const light = new T.DirectionalLight(0xffffff, 0.55);
    light.position.set(-15, 25, 40);
    scene.add(light);
    const colors = moduleColors();
    [colors.flow0, colors.flow1].forEach((color, flow) => {
      modules.forEach(([index, y, height, title, f, offset, operation]) => {
        if (f === flow) addModule(index, y, height, title, color, flow, offset, operation);
      });
    });
    modules.forEach(([index, y, height, title, f, offset, operation]) => {
      if (f == null || f === -1) addModule(index, y, height, title, colors.neutral, -1, offset, operation);
    });
    const color = 0x8d72c9;
    for (const [y, from, to] of [[26, 7, 9], [-24, 7, 9], [-31, 9, 7]]) {
      const points = [[x[from], 0], [x[from], y], [x[to], y], [x[to], 0]]
        .map(([px, py]) => new T.Vector3(px, py, -7));
      scene.add(new T.Line(new T.BufferGeometry().setFromPoints(points), new T.LineBasicMaterial({ color })));
      const direction = Math.sign(to - from);
      scene.add(new T.ArrowHelper(new T.Vector3(direction, 0, 0),
        new T.Vector3(x[to] - direction * 8, y, -6.8), 6, color, 2, 1.2));
    }
  }

  function addGround() {
    const gy = -BAND - 2.1;
    const grid = new T.GridHelper(260, 52, theme.rule, theme.rule);
    grid.position.y = gy;
    grid.scale.z = 0.12;
    grid.material.transparent = true;
    grid.material.opacity = 0.28;
    scene.add(grid);
    [x[ST.mux] - 0.8, x[ST.demux] + 0.8].forEach(px => {
      const geometry = new T.BufferGeometry().setFromPoints([
        new T.Vector3(px, gy, 0), new T.Vector3(px, BAND + 1.2, 0)
      ]);
      const line = new T.Line(geometry, new T.LineDashedMaterial({
        color: theme.muted, dashSize: 0.45, gapSize: 0.35, transparent: true, opacity: 0.7
      }));
      line.computeLineDistances();
      scene.add(line);
    });
  }

  function disposeGroup(group) {
    if (!group) return;
    group.traverse(object => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) {
        const list = Array.isArray(object.material) ? object.material : [object.material];
        list.forEach(material => material.dispose());
      }
    });
    scene.remove(group);
  }

  function samplePath(curve, from, to, count) {
    const points = [];
    for (let i = 0; i <= count; i++) {
      points.push(curve.getPointAt(from + (to - from) * i / count));
    }
    return points;
  }

  function rebuildTracks() {
    if (!scene) return;
    disposeGroup(linkGroup);
    linkGroup = new T.Group();
    scene.add(linkGroup);
    curves = []; tracks = []; rings = []; bars = []; sheaths = [];
    flowLines = []; aggLines = []; highlight = null;

    const tracked = value('lane');
    for (let lane = 0; lane < 32; lane++) {
      const curve = new T.CatmullRomCurve3(
        stages.map((_, i) => route(lane, i)), false, 'centripetal', 0.35);
      curves[lane] = curve;
      laneSamples[lane] = curve.getSpacedPoints(curveSamples);
      const laneCurve = new T.CatmullRomCurve3(
        samplePath(curve, stageT(ST.lanes), stageT(ST.fec), 80));
      const line = new T.Mesh(new T.TubeGeometry(laneCurve, 100, 0.055, 5, false),
      new T.MeshBasicMaterial({
        color: flowColor(lane), transparent: true, depthWrite: false, opacity: tracked < 0 || tracked === lane ? 0.62 : 0.12
      }));
      line.frustumCulled = false;
      linkGroup.add(line);
      tracks[lane] = line;

      if (lane === tracked) {
        highlight = new T.Mesh(
          new T.TubeGeometry(laneCurve, 120, 0.075, 6, false),
          new T.MeshBasicMaterial({ color: flowColor(lane), transparent: true, opacity: 0.9 }));
        highlight.frustumCulled = false;
        linkGroup.add(highlight);
      }

      const ring = new T.Mesh(new T.TorusGeometry(0.46, 0.07, 8, 20),
        new T.MeshBasicMaterial({ color: theme.good }));
      ring.rotation.y = Math.PI / 2;
      const p = route(lane, ST.align);
      ring.position.set(p.x, p.y, p.z);
      linkGroup.add(ring);
      rings[lane] = ring;
    }

    for (let flow = 0; flow < 2; flow++) {
      const color = flowColor(flow * 16);
      const y = flow ? -FLOW_Y : FLOW_Y;
      const txLine = new T.Line(new T.BufferGeometry().setFromPoints([
        new T.Vector3(x[2], 0, 0), new T.Vector3(x[3], y, 0), new T.Vector3(x[6], y, 0)
      ]), new T.LineBasicMaterial({ color, transparent: true, opacity: 0.32 }));
      const rxLine = new T.Line(new T.BufferGeometry().setFromPoints([
        new T.Vector3(x[11], y, 0), new T.Vector3(x[13], y, 0), new T.Vector3(x[14], 0, 0)
      ]), new T.LineBasicMaterial({ color, transparent: true, opacity: 0.32 }));
      linkGroup.add(txLine, rxLine);
      flowLines[flow] = [txLine, rxLine];
    }
    [[x[0], x[2]], [x[14], x[16]]].forEach((range, i) => {
      const line = new T.Line(new T.BufferGeometry().setFromPoints([
        new T.Vector3(range[0], 0, 0), new T.Vector3(range[1], 0, 0)
      ]), new T.LineBasicMaterial({ color: theme.muted, transparent: true, opacity: 0.3 }));
      linkGroup.add(line);
      aggLines[i] = line;
    });

    // The physical interface: one PAM4 sheath around the four PCS lanes that
    // share an output lane between the 32:8 and 8:32 PMA functions.
    for (let s = 0; s < 8; s++) {
      const y = (3.5 - s) * 2.55;
      const curve = new T.LineCurve3(
        new T.Vector3(x[ST.mux] - 0.6, y, 0),
        new T.Vector3(x[ST.link] + 0.6, y, 0));
      const tube = new T.Mesh(
        new T.TubeGeometry(curve, 1, 0.78, 14, false),
        new T.MeshBasicMaterial({ color: theme.ink, transparent: true, opacity: 0.07, depthWrite: false }));
      linkGroup.add(tube);
      tube.renderOrder = 1;
      sheaths[s] = tube;
    }

    // One deskew bar per physical channel. Only the selected fault channel has
    // a visible hold time; the bar length follows the 152 ns budget.
    for (let s = 0; s < 8; s++) {
      const len = s === fault.physical
        ? Math.max(0.16, Math.min(1, fault.skew / M.deskewLimit)) * 6 : 0.16;
      const bar = new T.Mesh(new T.BoxGeometry(len, 0.18, 0.55),
        new T.MeshBasicMaterial({ color: theme.warn, transparent: true, opacity: 0.72 }));
      bar.position.set(x[ST.demux] + 1.2 + len / 2, (3.5 - s) * 2.55 - 1.1, 0.8);
      linkGroup.add(bar);
      bars[s] = bar;
    }
  }

  function setupScene() {
    if (renderer || transportFailed) return;
    const host = get('scene');
    let canvas;
    try {
      readTheme();
      renderer = new T.WebGLRenderer({ antialias: true });
      canvas = renderer.domElement;
      scene = new T.Scene();
      scene.background = new T.Color(theme.bg);
      addModules();
      addGround();
      camera = new T.PerspectiveCamera(36, 1, 0.1, 900);
      controls = new T.OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.12;
      controls.screenSpacePanning = true;
      controls.minDistance = 3;
      controls.maxDistance = 520;
      controls.zoomSpeed = 2.2;
      controls.maxPolarAngle = 1.52;
      controls.mouseButtons = {
        LEFT: T.MOUSE.PAN, MIDDLE: T.MOUSE.DOLLY, RIGHT: T.MOUSE.ROTATE
      };
      controls.touches = { ONE: T.TOUCH.PAN, TWO: T.TOUCH.DOLLY_ROTATE };
      controls.addEventListener('start', () => {
        cameraTouched = true;
        camTween = null;
        zoomAnchor = null;
        zoomAnchorAt = 0;
      });
      controls.addEventListener('end', () => {
        if (!dampingFrame) dampingFrame = requestAnimationFrame(settleCamera);
      });
      controls.addEventListener('change', draw);
      canvas.addEventListener('wheel', wheelZoom, { passive: false, capture: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      host.prepend(canvas);

      inst = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1),
        new T.MeshBasicMaterial({ color: 0xffffff }), 1600);
      inst.renderOrder = 2;
      inst.instanceMatrix.setUsage(T.DynamicDrawUsage);
      inst.setColorAt(0, new T.Color());
      inst.frustumCulled = false;
      inst.count = 0;
      scene.add(inst);
      meta = new Array(1600);

      labelHost = document.createElement('div');
      labelHost.className = 'scene-labels';
      labelHost.setAttribute('aria-hidden', 'true');
      labelHost.addEventListener('click', event => {
        const hit = event.target.closest('[data-stage]');
        if (hit) openModule(+hit.dataset.stage, +hit.dataset.flow, hit.dataset.operation);
      });
      host.appendChild(labelHost);
      initFollowTags(host);
      buildStageBand();
      buildFlowArrows();
      buildStageBadge(host);
      canvas.addEventListener('dblclick', () => focusStageCamera(stage));
      canvas.addEventListener('pointermove', event => {
        const rect = canvas.getBoundingClientRect();
        const ray = new T.Raycaster();
        ray.setFromCamera(new T.Vector2(
          (event.clientX - rect.left) / rect.width * 2 - 1,
          1 - (event.clientY - rect.top) / rect.height * 2), camera);
        const hit = ray.intersectObjects(moduleMeshes.map(module => module.box), false)[0];
        const nextStage = hit ? hit.object.userData.stage : -1;
        const nextFlow = hit ? (hit.object.userData.flow ?? -1) : -1;
        if (nextStage !== hoverStage || nextFlow !== hoverFlow) {
          hoverStage = nextStage;
          hoverFlow = nextFlow;
          labelItems.forEach(item => { item.w = 0; });
          buildLabels();
          updateLabels();
        }
        canvas.style.cursor = hit ? 'pointer' : '';
      });
      canvas.addEventListener('pointerleave', () => {
        if (hoverStage < 0) return;
        hoverStage = -1;
        hoverFlow = -1;
        labelItems.forEach(item => { item.w = 0; });
        buildLabels();
        updateLabels();
      });

      resize = () => {
        if (!active || !host.clientWidth || !host.clientHeight) return;
        camera.aspect = host.clientWidth / host.clientHeight;
        camera.updateProjectionMatrix();
        if (!cameraTouched && !laneView) fitCameraMin();
        renderer.setSize(host.clientWidth, host.clientHeight, false);
        draw();
        updateLabels();
      };
      new ResizeObserver(resize).observe(host);
      window.addEventListener('resize', resize);
      resize();
      resetCamera(true);
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
          labelItems.forEach(item => { item.w = 0; });
          followTagEls.forEach(tag => { tag.w = 0; });
          draw();
        });
      }

      let pointer;
      canvas.addEventListener('pointerdown', event => { pointer = [event.clientX, event.clientY]; });
      canvas.addEventListener('click', event => {
        if (!pointer || Math.hypot(event.clientX - pointer[0], event.clientY - pointer[1]) > 5) return;
        const rect = canvas.getBoundingClientRect();
        const ray = new T.Raycaster();
        ray.setFromCamera(new T.Vector2(
          (event.clientX - rect.left) / rect.width * 2 - 1,
          1 - (event.clientY - rect.top) / rect.height * 2), camera);
        const packetHit = ray.intersectObject(inst)[0];
        if (packetHit && packetHit.instanceId != null) {
          const info = meta[packetHit.instanceId];
          if (info) {
            if (info.seg === 'agg' && info.phase === 'tx') {
              openBlockLens(info.n);
              return;
            }
            if (info.seg === 'lane') {
              get('lane').value = info.lane;
              get('flow').value = info.lane < 16 ? 0 : 1;
              refresh();
              setStage(info.t != null ? stageAtPath(info.t) : stage);
              showData('lane');
              return;
            }
            if (info.seg === 'flow' || info.seg === 'agg') {
              get('lane').value = -1;
              get('flow').value = info.seg === 'agg' ? 0 : info.flow;
              refresh();
              setStage(info.t != null ? stageAtPath(info.t) : stage);
              const clickedBlock = info.n != null && info.n >= 0
                ? (info.seg === 'flow' ? info.n * 8 + info.flow : info.n) : undefined;
              showData(undefined, clickedBlock);
              return;
            }
          }
        }
        const moduleHit = ray.intersectObjects(moduleMeshes.map(module => module.box))[0];
        if (moduleHit) {
          const info = moduleHit.object.userData;
          openModule(info.stage, info.flow, info.operation);
        }
      });
    } catch (err) {
      if (renderer) renderer.dispose();
      renderer = null;
      transportFailed = true;
      if (canvas) canvas.remove();
      get('help').textContent = '浏览器无法启动 WebGL。仍可通过阶段按钮和映射表查看流程。';
    }
  }

  const curveSamples = 512;
  let laneSamples = [];
  let laneView = false;
  let dampingFrame = 0;
  const cubeMatrix = new T.Matrix4();
  const cubeRotation = new T.Quaternion();
  const cubeScale = new T.Vector3();
  const cubePosition = new T.Vector3();
  const cubeColor = new T.Color();
  const followColor = new T.Color();

  function sampleLane(lane, t, target) {
    const f = Math.max(0, Math.min(1, t)) * curveSamples;
    const i = Math.floor(f);
    const samples = laneSamples[lane];
    return target.lerpVectors(samples[i], samples[Math.min(i + 1, curveSamples)], f - i);
  }

  function settleCamera() {
    dampingFrame = 0;
    if (active && controls.update()) dampingFrame = requestAnimationFrame(settleCamera);
  }

  function pushCube(position, sx, sy, sz, color, info, marker) {
    if (count >= 1600) return;
    let shown = color;
    if (followActive && !marker) {
      if (!followPaper) followPaper = new T.Color(theme.paper);
      shown = followColor.copy(color).lerp(followPaper, 0.72);
    }
    cubeMatrix.compose(position, cubeRotation, cubeScale.set(sx, sy, sz));
    inst.setMatrixAt(count, cubeMatrix);
    inst.setColorAt(count, shown);
    meta[count] = info;
    count++;
  }

  function drawStreamSegment(from, to, y, z, color, info, flow, phase) {
    const front = motion.matches ? stageT(stage) : stageT(stage) + progress / (stages.length - 1);
    const base = Math.floor(stageT(stage) / STEP_T);
    for (let i = 0; i < STREAM; i++) {
      const t = front - i * STEP_T;
      if (t < from) break;
      if (t > to) continue;
      const am = i % 5 === 0;
      const px = x[0] + t * SPAN;
      const pos = cubePosition.set(px, typeof y === 'function' ? y(t) : y, z);
      const c = am ? cubeColor.set(theme.am).lerp(color, 0.22) : color;
      pushCube(pos, am ? 2.2 : 1.75, am ? 1.0 : 0.5, am ? 0.9 : 0.55,
        c, { seg: info, flow, n: base - i, phase, t });
    }
  }

  function drawLaneStream(lane, flow, color, front) {
    const base = Math.floor(stageT(stage) / STEP_T);
    const tracked = value('lane');
    const on = tracked < 0 || tracked === lane;
    const physical = lanes[lane];
    const loss = fault.loss && physical === fault.physical;
    const corruptAm = fault.am && lane === fault.lane;
    const fecError = fecResults[flow] && fecResults[flow].errors > 0 && lane === fault.lane;
    for (let i = 0; i < STREAM; i++) {
      const t = front - i * STEP_T;
      if (t < stageT(ST.lanes)) break;
      if (t > stageT(ST.fec)) continue;
      if (loss && t > stageT(ST.mux)) continue;
      const am = i % 5 === 0;
      if (!state.aligned && t > stageT(ST.align) && !(corruptAm && am)) continue;
      const pos = sampleLane(lane, t, cubePosition);
      const c = cubeColor.copy(color);
      if (!on) c.lerp(followPaper, 0.8);
      if (am) c.set(theme.am).lerp(color, 0.2);
      if (corruptAm && am && t > stageT(ST.demux)) c.set(theme.bad);
      if (fecError && t > stageT(10.4)) c.set(theme.bad);
      pushCube(pos, am ? 2.1 : 1.55, am ? 0.39 : 0.32, am ? 0.34 : 0.29,
        c, { seg: 'lane', lane, flow, n: base - i, phase: 'lane', t });
    }
  }

  function draw() {
    const position = followActive && !motion.matches ? followU * (stages.length - 1)
      : stage + (motion.matches ? 0 : progress);
    get('progress').value = Math.min(position, stages.length - 1);
    if (!active || !renderer || !state) return;
    followPaper = new T.Color(theme.paper);
    if (followActive) followTags = [];
    const filter = value('flow'), tracked = value('lane');
    const front = motion.matches ? stageT(stage) : stageT(stage) + progress / (stages.length - 1);
    const aligned = state.aligned;
    const bothFec = fecResults.every(result => result && result.valid);
    count = 0;

    // One aggregate 800GMII stream at each end.
    drawStreamSegment(0, stageT(2), 0, 0,
      new T.Color(theme.ink).lerp(new T.Color(theme.bg), 0.2),
      'agg', 0, 'tx');
    if (aligned && bothFec) {
      drawStreamSegment(stageT(14), 1, 0, 0,
        new T.Color(theme.ink).lerp(new T.Color(theme.bg), 0.2),
        'agg', 1, 'rx');
    }

    // Two independent Flow streams on either side of the 32-lane section.
    for (let flow = 0; flow < 2; flow++) {
      const color = dimColor(flowColor(flow * 16), filter < 0 || filter === flow);
      drawStreamSegment(stageT(2), stageT(ST.lanes), t => flowTxY(flow, t), 0,
        color, 'flow', flow, 'tx');
      if (aligned && fecResults[flow] && fecResults[flow].valid) {
        const rxColor = flow === filter || filter < 0 ? flowColor(flow * 16) : dimColor(flowColor(flow * 16), false);
        drawStreamSegment(stageT(ST.fec), stageT(14), t => flowRxY(flow, t), 0,
          rxColor, 'flow', flow, 'rx');
      }
    }

    // The 32 PCS lanes only exist between symbol distribution and FEC.
    for (let lane = 0; lane < 32; lane++) {
      if (filter >= 0 && lane < flowStart(filter)) continue;
      if (filter >= 0 && lane >= flowStart(filter) + 16) continue;
      drawLaneStream(lane, lane < 16 ? 0 : 1, flowColor(lane), front);
    }
    if (followActive) drawFollowMarker();

    inst.count = count;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;

    // Tracks, rings and physical sheaths follow the current selection and lock
    // state. This is the visual counterpart of align_status.
    tracks.forEach((line, lane) => {
      const on = tracked < 0 || tracked === lane;
      line.material.opacity = on ? 0.42 : 0.08;
    });
    if (highlight) highlight.visible = tracked >= 0;
    rings.forEach((ring, lane) => {
      ring.material.color.set(state.locked[lane] ? theme.good : theme.bad);
      ring.scale.setScalar(tracked < 0 || tracked === lane ? 1 : 0.72);
      ring.visible = aligned || state.locked[lane] || stage >= ST.align;
    });
    sheaths.forEach((sheath, s) => {
      const dead = fault.loss && fault.physical === s;
      const trackedHere = tracked >= 0 && lanes[tracked] === s;
      sheath.material.color.set(dead ? theme.bad : theme.ink);
      sheath.material.opacity = dead ? 0.16 : trackedHere ? 0.16 : 0.065;
    });
    bars.forEach((bar, s) => {
      const activeBar = s === fault.physical && fault.skew > 0;
      bar.visible = stage >= ST.demux;
      bar.material.color.set(fault.skew > M.deskewLimit && s === fault.physical
        ? theme.bad : activeBar ? theme.warn : theme.rule);
      bar.material.opacity = activeBar ? 0.85 : 0.35;
    });
    flowLines.forEach((pair, flow) => {
      const on = filter < 0 || filter === flow;
      pair.forEach(line => { line.material.opacity = on ? 0.32 : 0.07; });
    });
    aggLines.forEach(line => {
      line.material.opacity = aligned ? 0.3 : 0.12;
    });
    const viewDistance = camera.position.distanceTo(controls.target);
    const expose = Math.min(1, Math.max(0, (viewDistance - 12) / 60));
    const boxOpacity = 0.12 + 0.78 * expose;
    const edgeOpacity = 0.18 + 0.72 * expose;
    if (stageBand) {
      stageBand.position.x = x[stage];
      stageBand.material.opacity = focusMode ? 0.16 : 0.06;
    }
    moduleMeshes.forEach(({ box, index }) => {
      const dim = focusMode && index !== stage;
      for (const material of box.material) {
        material.emissive.setHex(index === stage ? 0x26719a : 0x000000);
        material.emissiveIntensity = 0.55;
        material.opacity = boxOpacity * (dim ? 0.3 : 1);
        material.depthWrite = false;
      }
      const edge = box.children[0];
      if (edge && edge.material) {
        edge.material.transparent = true;
        edge.material.opacity = edgeOpacity * (dim ? 0.5 : 1);
      }
    });
    renderer.render(scene, camera);
    updateLabels();
    updateFollowTags();
    updateFollowBar();
    updateBadge();
  }

  function flowStart(flow) { return flow * 16; }

  function setLabels(list) {
    const keep = {};
    list.forEach(item => { keep[item.id] = item; });
    labelItems = labelItems.filter(item => {
      if (keep[item.id]) return true;
      item.el.remove();
      return false;
    });
    list.forEach(data => {
      let item = labelItems.find(candidate => candidate.id === data.id);
      if (!item) {
        item = { id: data.id, el: document.createElement('div') };
        labelHost.appendChild(item.el);
        labelItems.push(item);
      }
      if (item.html !== data.html || item.cls !== data.cls) {
        item.el.innerHTML = data.html;
        item.el.className = 'lbl ' + (data.cls || '');
        item.html = data.html;
        item.cls = data.cls;
        item.w = 0;
      }
      item.pos = data.pos;
      item.pri = data.pri;
      item.anchor = data.anchor || 'c';
    });
    labelItems.sort((a, b) => b.pri - a.pri);
  }

  function buildLabels() {
    if (!labelHost) return;
    const list = [];
    const add = (id, html, cls, pos, pri, anchor) =>
      list.push({ id, html, cls, pos, pri, anchor });
    const top = BAND + 11;

    const primaryKey = {};
    modules.forEach(([index, y, height, title, flow, offset = 0]) => {
      if (Math.abs(y) > FLOW_Y + 2) return;
      const current = primaryKey[index];
      if (current == null || Math.abs(offset) < Math.abs(current.offset)) {
        primaryKey[index] = { offset, key: index + ':' + (flow == null ? -1 : flow) + ':' + offset + ':' + y };
      }
    });
    modules.forEach(([index, y, height, title, flow, offset = 0, operation]) => {
      // Alternate labels above and below the boxes: at 17 stages the
      // horizontal pitch is narrow, so a single row would overlap.
      const labelY = index === 16
        ? y + height / 2 + 12.5
        : index % 2 ? y - height / 2 - 0.95 : y + height / 2 + 0.95;
      const labelX = index === 0 ? x[index] + 6 : index === 16 ? x[index] - 12 : x[index];
      add('box' + index + ':' + flow + ':' + offset + ':' + y, '<span title="' +
        (flow >= 0 ? 'Flow ' + flow + ' · ' : '') + title + '" data-stage="' + index +
        '" data-operation="' + (operation || '') + '" data-flow="' + (flow ?? -1) + '">' +
        title + '</span>',
      'lbl-box op' + (flow >= 0 ? (flow ? ' f1' : ' f0') : ''),
      [labelX + offset * pitch, labelY + offset * 10, 0], 3,
      index === 0 ? 'l' : index === 16 ? 'r' : 'c');
      const selfFlow = flow == null ? -1 : flow;
      const key = index + ':' + selfFlow + ':' + offset + ':' + y;
      const item = list[list.length - 1];
      item.moduleStage = index;
      item.flow = selfFlow;
      item.minor = !(primaryKey[index] && primaryKey[index].key === key);
    });
    stages.forEach((_, index) => {
      add('stage' + index, '<b>' + (index + 1) + '</b>',
        'lbl-stage' + (index === stage ? ' on' : ''), [x[index], top, 0], 4);
    });

    for (let s = 0; s < 8; s++) {
      const carried = tx[s] || [];
      // Two short columns keep all eight PAM4 channels readable on a phone.
      add('pam' + s, '<span title="PCS lane ' + carried.join(' / ') + '">P' + s + '</span>',
        'lbl-serdes', [x[ST.link] + (s % 2 ? 8.5 : -8.5), (3.5 - s) * 2.55, 0], 5);
    }

    const locked = state.locked.filter(Boolean).length;
    add('align', 'align_status ' + (state.aligned ? 'true' : 'false'),
      'lbl-status ' + (state.aligned ? 'ok' : 'bad'), [x[ST.align], -BAND - 6.5, 0], 7);
    add('lock', 'AM 锁定 ' + locked + '/32 · Skew ' + fault.skew + ' / ' + M.deskewLimit + ' ns',
      'lbl-note', [x[ST.align], -BAND - 3, 0], 3);
    [['TRANSMIT', 1], ['CHANNEL', ST.link], ['RECEIVE', 15]].forEach(zone => {
      add('zone' + zone[0], zone[0] + (zone[0] === 'CHANNEL' ? '' : ' →'), 'lbl-zone',
        [x[zone[1]], -BAND - 10.5, 0], 2);
    });

    const track = value('lane');
    if (track >= 0) {
      const flow = track < 16 ? 0 : 1;
      add('lane-in', 'PCS lane ' + track,
        'lbl-lane f' + flow, [x[ST.lanes] - 4.2, route(track, ST.lanes).y, 0], 8, 'r');
      add('lane-out', 'PCS lane ' + track,
        'lbl-lane f' + flow, [x[ST.fec] + 4.2, route(track, ST.fec).y, 0], 8, 'l');
      if (stage <= ST.link) {
        add('lane-phy', 'PAM4 ' + lanes[track] + ' · 时隙 ' + (tx[lanes[track]].indexOf(track) + 1) + '/4',
          'lbl-callout', [x[ST.link] + 1.2, (3.5 - lanes[track]) * 2.55 - 1.6, 0], 9);
      }
      if (stage >= ST.demux) {
        add('lane-rx', 'RX PMA lane ' + rx.indexOf(track),
          'lbl-callout', [x[ST.demux] + 1.2, route(track, ST.demux).y - 0.85, 0], 9);
      }
      if (stage >= ST.align) {
        add('lane-re', 'reordered → PCS ' + track,
          'lbl-callout', [x[ST.align] + 1.2, route(track, ST.align).y + 0.85, 0], 9);
      }
    }
    setLabels(list.filter(item => {
      if (item.moduleStage == null) return true;
      if (focusMode) return item.moduleStage === stage;
      return !item.minor || item.moduleStage === stage || item.moduleStage === hoverStage;
    }));
  }

  function updateLabels() {
    if (!labelHost || !camera) return;
    const host = get('scene');
    const W = host.clientWidth, H = host.clientHeight;
    if (!W || !H) return;
    const placed = [];
    const v = new T.Vector3();
    labelItems.forEach(item => {
      v.set(item.pos[0], item.pos[1], item.pos[2]).project(camera);
      const force = hoverStage >= 0 && item.moduleStage === hoverStage;
      let show = v.z < 1 && v.x > -1.1 && v.x < 1.1 && v.y > -1.1 && v.y < 1.1;
      if (show) {
        if (!item.w) {
          item.w = item.el.offsetWidth || 40;
          item.h = item.el.offsetHeight || 14;
        }
        const sx = (v.x + 1) / 2 * W, sy = (1 - v.y) / 2 * H;
        const left = item.anchor === 'r' ? sx - item.w : item.anchor === 'l' ? sx : sx - item.w / 2;
        const rect = {
          x0: left - 2, y0: sy - item.h / 2 - 1,
          x1: left + item.w + 2, y1: sy + item.h / 2 + 1
        };
        show = rect.x0 > -4 && rect.x1 < W + 4 && (force || !placed.some(other =>
          rect.x0 < other.x1 && rect.x1 > other.x0 && rect.y0 < other.y1 && rect.y1 > other.y0));
        if (show) {
          placed.push(rect);
          const transform = 'translate(' + Math.round(left) + 'px,' + Math.round(sy - item.h / 2) + 'px)';
          if (transform !== item.t) {
            item.el.style.transform = transform;
            item.t = transform;
          }
          item.el.style.zIndex = force ? '5' : '';
        }
      }
      if (show !== item.shown) {
        item.el.style.visibility = show ? 'visible' : 'hidden';
        item.shown = show;
      }
    });
  }

  function drawFollowMarker() {
    if (!followActive || !followInfo) return;
    const flow = followInfo.flow, u = followU;
    const bad = followBad(flow, u);
    const color = new T.Color(bad ? theme.bad : theme.am);
    const suffix = bad ? ' · 错误' : '';
    const marker = (pos, sx, sy, sz, text) => {
      pushCube(pos, sx, sy, sz, color, { seg: 'follow', n: followInfo.n, flow }, true);
      followTag(pos, text, color);
    };

    if (u < stageT(2)) {
      marker(new T.Vector3(x[0] + u * SPAN, 0, 0), 4.2, 1.8, 1.5,
        'MAC 66b #' + followInfo.n + suffix);
    } else if (u < stageT(6)) {
      marker(new T.Vector3(x[0] + u * SPAN, flowTxY(flow, u), 0), 4.2, 1.8, 1.5,
        'F' + flow + ' 257b #' + followInfo.group + suffix);
    } else if (u < stageT(11)) {
      const avg = new T.Vector3();
      followLaneList(flow).forEach(lane => {
        const pos = curves[lane].getPointAt(u);
        pushCube(pos, 2.8, 1.25, 1.1,
          color, { seg: 'follow', lane, flow, n: followInfo.n }, true);
        avg.add(pos);
      });
      avg.multiplyScalar(1 / 16);
      followTag(avg, 'F' + flow + ' · 16 条 PCS lane' +
        (u < stageT(9) ? ' · PAM4 0–7' : '') +
        (bad ? ' · 失锁' : ''), color);
    } else if (u < stageT(14)) {
      marker(new T.Vector3(x[0] + u * SPAN, flowRxY(flow, u), 0), 4.2, 1.8, 1.5,
        'RX F' + flow + ' 257b #' + followInfo.group + suffix);
    } else {
      marker(new T.Vector3(x[0] + u * SPAN, 0, 0), 4.2, 1.8, 1.5,
        'RX 66b #' + followInfo.n + suffix);
    }
  }

  function updateFollowTags() {
    if (!followTagHost) return;
    followTagHost.hidden = !followActive;
    if (!followActive) {
      followTagEls.forEach(tag => {
        if (tag.shown) { tag.el.style.visibility = 'hidden'; tag.shown = false; }
      });
      return;
    }
    const host = get('scene');
    const W = host.clientWidth, H = host.clientHeight;
    if (!W || !H || !camera) return;
    const placed = [];
    const bar = byId('g800-follow-bar');
    if (bar && !bar.hidden) {
      const br = bar.getBoundingClientRect(), hr = get('scene').getBoundingClientRect();
      placed.push({
        x0: br.left - hr.left - 3, x1: br.right - hr.left + 3,
        y0: br.top - hr.top - 3, y1: br.bottom - hr.top + 3
      });
    }
    const v = new T.Vector3();
    let used = 0;
    followTags.forEach(item => {
      if (used >= MAX_FOLLOW_TAGS) return;
      v.copy(item.pos).project(camera);
      if (v.z > 1) return;
      const sx = (v.x + 1) / 2 * W;
      const sy = (1 - v.y) / 2 * H - 5;
      if (sx < 0 || sx > W || sy < 0 || sy > H) return;
      const tag = followTagEls[used];
      if (tag.text !== item.text) {
        tag.el.textContent = item.text;
        tag.text = item.text;
        tag.w = 0;
      }
      if (!tag.w) tag.w = tag.el.offsetWidth || 30;
      const h = tag.el.offsetHeight || 14;
      const rect = { x0: sx - tag.w / 2 - 2, x1: sx + tag.w / 2 + 2, y0: sy - h - 2, y1: sy + 2 };
      if (placed.some(other => rect.x0 < other.x1 && rect.x1 > other.x0 &&
        rect.y0 < other.y1 && rect.y1 > other.y0)) return;
      placed.push(rect);
      tag.el.style.setProperty('--lc', item.color);
      tag.el.style.transform = 'translate(' + Math.round(sx) + 'px,' + Math.round(sy) +
        'px) translate(-50%, -100%)';
      if (!tag.shown) { tag.el.style.visibility = 'visible'; tag.shown = true; }
      used++;
    });
    for (let i = used; i < followTagEls.length; i++) {
      const tag = followTagEls[i];
      if (tag.shown) { tag.el.style.visibility = 'hidden'; tag.shown = false; }
    }
  }

  function setPlaying(on) {
    playing = on;
    get('play').textContent = on ? '暂停' : '播放';
    get('play').setAttribute('aria-pressed', String(on));
    if (!on && pending) {
      cancelAnimationFrame(pending);
      pending = 0;
    }
    if (on && !pending) {
      last = 0;
      pending = requestAnimationFrame(tick);
    }
  }

  function tick(now) {
    pending = 0;
    if (!active || !playing) return;
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    if (followActive) {
      followU += dt * value('speed') / 9;
      if (followU >= 1) followU -= 1;
      const next = Math.min(stages.length - 1, Math.round(followU * (stages.length - 1)));
      if (next !== stage) {
        stage = next;
        progress = 0;
        if (stage === ST.align) recovery = 2;
        updateState();
      } else draw();
    } else {
      progress += dt * value('speed') / 0.85;
      if (progress >= 1) {
        progress = 0;
        advance();
      } else draw();
    }
    pending = requestAnimationFrame(tick);
  }

  function diagnostics() {
    const n = state.locked.filter(Boolean).length;
    const lock = state.aligned ? '已对齐' : '未对齐';
    const fec = fecResults.map((result, i) => 'F' + i + ' ' + (!state.aligned ? '等待对齐' :
      result.corrected ? '纠正 ' + result.errors + ' 个符号' : result.valid ? '正常' : '不可纠正'));
    get('diagnostics').textContent = 'PMA SIGNAL_OK ' + signalStatus().ok + ' · ' + lock + ' · AM 锁定 ' + n + '/32 · Skew ' + fault.skew +
      ' / ' + M.deskewLimit + ' ns · ' + fec.join(' · ');
    get('rows').replaceChildren(...tx.map((row, i) => {
      const tr = document.createElement('tr');
      [i, row.join(' / '), rx.slice(i * 4, i * 4 + 4).join(' / '),
        row.map(lane => state.locked[lane] ? '✓' : '—').join(' / ')].forEach(v => {
        const cell = tr.insertCell();
        cell.textContent = v;
      });
      return tr;
    }));
  }

  function signalStatus() {
    const inputs = fault.loss ? 7 : 8;
    const outputs = rx.filter((lane, slot) => lane !== undefined &&
      (!fault.loss || Math.floor(slot / 4) !== fault.physical)).length;
    const pmdOk = !get('pmd-fail').checked;
    return { inputs, outputs, pmdOk, ok: inputs === 8 && outputs === 32 && pmdOk ? 'OK' : 'FAIL' };
  }

  function pmaTestSample() {
    let register = 0x7fffffff;
    return M.range(48).map(() => {
      const bit = register >>> 30;
      const feedback = ((register >>> 30) ^ (register >>> 27)) & 1;
      register = ((register << 1) | feedback) & 0x7fffffff;
      return bit;
    }).join('');
  }

  function payload() {
    return get('payload').value.replace(/[^\x20-\x7E]/g, '?') ||
      'Visual PCS 800G: one character = one byte; eight bytes = one 66-bit block; four blocks per flow = one 257b block. ';
  }

  function inspectData(flow) {
    const detail = get('data');
    detail.hidden = ![0, 1, 3, 4, 12, 13, 15, 16].includes(stage);
    if (detail.hidden) return;
    if (idleMode) {
      get('bits').textContent = 'Scrambled Idle 模式 · 请在 PCS lane 模块查看测试符号。';
      return;
    }
    const sample = M.sample(flow, payload(), stage >= ST.fec ? fecResults[flow].data : undefined);
    const bits = value => value.join('').match(/.{1,64}/g).join('\n');
    const hex = blocks => blocks.map(block => block.map(byte =>
      byte.toString(16).padStart(2, '0')).join(' ')).join('\n');
    const lines = {
      0: () => '输入字节（十六进制）\n' + hex(sample.bytes),
      1: () => '首个 66 位数据块（发送顺序）\n' + bits(sample.encoded[0]),
      3: () => '转码后的 257 位块\n' + bits(sample.transcoded),
      4: () => '加扰输入\n' + bits(sample.transcoded) + '\n加扰输出\n' + bits(sample.scrambled),
      12: () => '接收的加扰块\n' + bits(sample.scrambled) + '\n解扰输出\n' + bits(sample.recovered),
      13: () => '恢复的首个 66 位块\n' + bits(sample.reverse[0]),
      15: () => '解码字节（十六进制）\n' + hex(sample.decoded),
      16: () => '恢复的 Flow 数据（十六进制）\n' + hex(sample.decoded)
    };
    get('bits').textContent = 'Flow ' + flow + '\n' +
      (stage >= ST.fec && (!state.aligned || !fecResults[flow].valid) ? '接收数据不可用' : lines[stage]());
  }

  function describeStage() {
    buttons.forEach((button, i) => button.setAttribute('aria-current', i === stage ? 'step' : 'false'));
    const label = '第 ' + (stage + 1) + ' / ' + stages.length + ' 阶段';
    get('progress-label').textContent = label;
    get('progress').setAttribute('aria-valuetext', label + ' · ' + stages[stage][0]);
    get('stage-title').textContent = (stage + 1) + ' · ' + stages[stage][0];
    get('stage-note').textContent = stages[stage][1];
    const track = value('lane');
    const i = track < 0 ? Math.max(0, value('flow')) * 16 : track;
    const flow = Math.floor(i / 16);
    let detail = 'PCS lane ' + i + ' · Flow ' + flow + ' · 原始块 ' + flows[flow].join(', ') +
      ' · PAM4 通道 ' + lanes[i] + ' / TX 槽 ' + (tx[lanes[i]].indexOf(i) + 1) +
      ' · RX PMA lane ' + rx.indexOf(i);
    const symbol = M.symbolAt(i, 0);
    detail += ' · F' + symbol.flow + '-' + ['A', 'B'][symbol.word] + ' 符号 #' + symbol.index;
    if (stage === ST.mux || stage === ST.link) {
      const channel = lanes[i];
      const pair = M.pam4Pair(words, tx, channel, 0, 0, Math.floor(tx[channel].indexOf(i) / 2));
      detail += ' · 32:8 时隙 ' + (tx[channel].indexOf(i) + 1) + '/4（' +
        (tx[channel].indexOf(i) < 2 ? 'Flow 0' : 'Flow 1') + '）' +
        ' · 位 0：lane ' + pair.ids.join(' / ') + ' → ' + pair.bits.join('') +
        ' → PAM4 电平 ' + pair.level;
    }
    if (stage === ST.align) {
      detail += ' · align_status ' + (state.aligned ? 'true' : 'false') +
        ' · Skew ' + fault.skew + ' / ' + M.deskewLimit + ' ns';
    }
    if (stage === ST.rx) {
      detail += state.aligned && fecResults.every(result => result.valid)
        ? ' · 收集顺序 ' + M.collect(flows).join(', ') : ' · 接收输出标记为错误';
    }
    get('inspect').textContent = detail;
    inspectData(flow);
  }

  function openModule(index, flow, operation) {
    if (flow >= 0) {
      get('flow').value = flow;
      if (value('lane') >= 0 && Math.floor(value('lane') / 16) !== flow) get('lane').value = -1;
    }
    setStage(index);
    showData(operation || undefined);
  }

  function operationDetail(operation, lane, flow) {
    const result = fecResults[flow];
    const pair = M.pam4Pair(words, tx, lanes[lane], 0, 0, Math.floor(tx[lanes[lane]].indexOf(lane) / 2));
    const symbols = word => word.slice(0, 4).map(v => v.toString(16).padStart(3, '0')).join(' ');
    const boundary = bits => bits.slice(0, 16).join('');
    switch (operation) {
      case 'idle': return '172.2.4.11 · 800GMII 持续输入 Idle 控制字符。用上方按钮切换，教学转码样本会重新经过加扰、AM、RS-FEC 及 lane 分发。当前 ' +
        (idleMode ? '测试模式' : '业务模式') + ' · 当前物理 lane 的第 14 行首个位对 ' +
        M.pam4Pair(words, tx, lanes[lane], 14, 0, Math.floor(tx[lanes[lane]].indexOf(lane) / 2)).bits
          .join('') + '。';
      case 'driver': return '173.5.6 · 实例化电接口时由驱动器输出电信号。800GAUI-8 C2C 与 C2M 的电气、抖动及时序分别见附录 120F、120G。';
      case 'inverse': return '173.5.7.2 · 适用接收 lane 的逆预编码可选。以前一接收电平为 1，本例编码电平 ' +
        ((pair.level + 3) % 4) + ' 加 1 取模 4 得 ' + pair.level + '。主通路旁路。';
      case 'signal': {
        const { inputs, outputs, pmdOk, ok } = signalStatus();
        return '173.5.8.1 · 输入 ' + inputs + '/8，输出 ' + outputs + '/32，下层 PMD 指示 ' +
          (pmdOk ? 'OK' : 'FAIL') + '。PMA SIGNAL_OK = ' + ok + '，PCS align_status = ' + state.aligned + '。';
      }
      case 'reorder': return 'RX 时隙 ' + rx.indexOf(lane) + ' → 教学 AM 中的 UM → PCS lane ' + lane +
        '。PCS 按 lane 编号排序，再分派到两个 Flow。';
      case 'deinterleave': return '每个 Flow 的 16 条 PCS lane 按符号序列重建 A/B 两个码字，再送入 RS 解码。';
      case 'localLoop': return '173.5.9 · 可选本地环回，MAC 侧 TX → PMA → MAC 侧 RX。正常 TX 同时继续发送。';
      case 'remoteLoop': return '173.5.10 · 可选远端环回，介质侧 RX → PMA → 介质侧 TX。正常 RX 同时继续交付。';
      case 'patternTx': return '173.5.11 · 可选。实例化接口的 PRBS31 教学样本前 48 位为 ' + pmaTestSample() + '。';
      case 'patternRx': return fault.loss
        ? '173.5.11 · 可选。物理输入丢失，检测器等待测试图样。'
        : '173.5.11 · 可选。已同步示例中检测到 ' + pmaTestSample() + '，与参考样本逐位一致。';
      case 'txRate': return '为补偿 AM 插入，TX PCS 可删除 Idle 控制字符或序列有序集。为补偿 800GMII 与 PMA 服务接口的时钟域差异，还可按规则删除上述内容或插入 Idle 控制字符。插删规则见 119.2.3.5 和 119.2.3.8。';
      case 'rxRate': return 'RX PCS 可插入 Idle 控制字符以补偿 AM 移除。为补偿 PMA 服务接口与 800GMII 的时钟域差异，可按规则删除 Idle 控制字符或序列有序集，也可插入 Idle 控制字符。插删规则见 119.2.3.5 和 119.2.3.8。';
      case 'amInsert': return '按图 172–3，Flow 0 在含 66b 块 k 的 257b 块之前插入 AM 组，Flow 1 则在含 k+1 的块之前插入。AM 编码见表 172–2、172–3。本演示缩短插入间隔并采用合成 AM。发送侧插入边界：' +
        boundary(M.messageBits(words[flow]));
      case 'fecSplit':
      case 'rsEncode': return '每 10 位交替分给 A/B。A 前四符号：' + symbols(words[flow][0]) +
        '；B 前四符号：' + symbols(words[flow][1]) + '。各附加 30 个校验符号。';
      case 'rsDecode':
      case 'fecJoin':
      case 'amRemove': {
        if (!state.aligned || !result.valid) return '对齐和 RS 解码成功后才有可用数据。';
        if (operation === 'rsDecode') return 'PCS 按 AM 的 UM0–UM5 识别 lane 编号并重排。每个 Flow 的 16 条 lane 去交织重建两个码字。RS 解码成功，本例注入 ' + result.errors + ' 个符号错误，每码字输出 514 个消息符号。';
        if (operation === 'fecJoin') return '交替取 A、B 的 10 位消息符号。前四个符号的位序列：' + result.interleaved.slice(0, 40).join('');
        return '移除前的 AM 起始位：' + boundary(result.interleaved) +
          '。移除后的首个数据位序列：' + boundary(result.data) + '，随后进入解扰器。';
      }
      case 'cdr': return fault.loss && lanes[lane] === fault.physical
        ? '该通道信号丢失，示例不输出判决。'
        : '接收 PMA 从输入信号恢复时钟和数据。本例的 PAM4 符号率为 53.125 GBd，教学判决电平为 ' + pair.level + '。';
      case 'gray': return fault.loss && lanes[lane] === fault.physical
        ? '该通道信号丢失，无法恢复位对。'
        : '判决电平 ' + pair.level + ' → Gray 位对 ' + pair.recovered.join('') + ' → RX 解复用。';
      case 'precode': return '接至 800GBASE‑CR8/KR8 PMD 服务接口或属于 800GAUI‑8 C2C 链路的 PMA，须逐发送 lane 支持 1/(1+D) mod 4 预编码，逐接收 lane 的解码能力可选。各端口逐 lane 独立启用，本动画采用旁路。开启示例：当前电平 ' +
        pair.level + '，前一预编码电平 1，模 4 差得到 ' + ((pair.level + 3) % 4) + '。';
      default: return '';
    }
  }

  const stageClauses = [
    '170', '172.2.4.1–2', '172.2.4.3', '172.2.4.4', '172.2.4.5',
    '172.2.4.6–8', '172.2.4.9–10', '173.5.2.1', '173.5.7.1',
    '173.5.1、173.5.2.1、173.5.7.1', '172.2.5.1–2', '172.2.5.2–5',
    '172.2.5.6', '172.2.5.7', '172.2.5.8', '172.2.5.9–10', '170'
  ];
  const operationClauses = {
    encode: '172.2.4.1', txRate: '172.2.4.2', decode: '172.2.5.9', rxRate: '172.2.5.10',
    amInsert: '172.2.4.6', fecSplit: '172.2.4.7', rsEncode: '172.2.4.8',
    rsDecode: '172.2.5.2–3', fecJoin: '172.2.5.4', amRemove: '172.2.5.5',
    cdr: '173.5.1', gray: '173.5.7.1', precode: '173.5.7.2', demux: '173.5.2.1',
    idle: '172.2.4.11', driver: '173.5.6', inverse: '173.5.7.2', signal: '173.5.8.1',
    reorder: '172.2.5.2', deinterleave: '172.2.5.2',
    localLoop: '173.5.9', remoteLoop: '173.5.10', patternTx: '173.5.11', patternRx: '173.5.11'
  };

  function showData(forceKind, blockOverride) {
    setPlaying(false);
    const tracked = value('lane');
    const lane = tracked < 0 ? Math.max(0, value('flow')) * 16 : tracked;
    const flow = Math.floor(lane / 16);
    let block = blockOverride != null ? blockOverride : (followActive ? followBlock : mapSelectedBlock);
    if (block % 2 !== flow) block = flow;
    const detail = operationDetail(forceKind, lane, flow);
    const kind = forceKind === 'lane'
      ? (stage === 7 || stage === 8 ? 'pma' : stage === 9 || stage === 10 ? 'lock' : 'lane')
      : dataKindForStage(stage);
    const note = stageDataNote(stage);
    let body = '';
    if (kind === 'b66') body = view66bHtml(block, note);
    else if (kind === 'bytes') body = viewBytesHtml(block, note);
    else if (kind === 'b257') body = view257bHtml(block, note);
    else if (kind === 'scramble' || kind === 'descramble') body = viewScrambleHtml(block, kind === 'descramble');
    else if (kind === 'amfec') body = viewAmFecHtml(block);
    else body = viewLaneHtml(lane, stage);
    if (idleMode && ['b66', 'bytes', 'b257', 'scramble', 'descramble'].includes(kind)) {
      body = '<p>当前为 Scrambled Idle 教学测试。可在 PCS lane 模块查看当前发送码字符号。</p>';
    }
    const labels = {
      b66: '66b 块', bytes: '字节 / MAC', b257: '257b 块',
      scramble: '加扰', descramble: '解扰', amfec: 'AM / FEC',
      lane: 'PCS lane 符号', pma: 'PAM4 时隙', lock: 'RX lane 锁定'
    };
    const module = modules.find(entry => forceKind && entry[6] === forceKind);
    get('popup-title').textContent = (stage + 1) + ' · ' + (module ? module[3] : stages[stage][0]) +
      (labels[kind] ? ' · ' + labels[kind] : '');
    get('popup-mapping').textContent = get('inspect').textContent;
    const clause = operationClauses[forceKind] || stageClauses[stage];
    get('popup-body').innerHTML = (detail
      ? '<p class="g800-inspect-note">' + escHtml(detail) + '</p>' : body) +
      '<p class="g800-inspect-note">IEEE Std 802.3df-2024 · ' + clause + '</p>';
    get('popup-bits').textContent = '';
    if (!get('popup').open) get('popup').showModal();
  }

  function updateState() {
    state = M.alignment(tx, fault, recovery);
    if (get('pmd-fail').checked) state = { locked: M.range(32).fill(false), aligned: false };
    diagnostics();
    describeStage();
    buildLabels();
    draw();
  }

  function refresh(reacquire) {
    fault = faultInput();
    if (reacquire) recovery = 0;
    tx = M.mapping(get('mapping').value);
    lanes = [];
    tx.forEach((row, physical) => row.forEach(lane => { lanes[lane] = physical; }));
    if (!words) words = M.codewords(window.PCS, payload(), idleMode);
    const reception = M.receive(window.PCS, words, tx, value('phase'), value('errors'), fault.lane);
    rx = reception.recovered;
    fecResults = reception.results;
    get('skew-value').textContent = fault.skew + ' ns';
    rebuildTracks();
    updateState();
  }

  function setStage(index) {
    setPlaying(false);
    stage = index;
    progress = 0;
    if (followActive) followU = stageT(index);
    if (index === ST.align) recovery = 2;
    if (focusMode) focusStageCamera(index);
    updateState();
  }

  function advance() {
    stage = (stage + 1) % stages.length;
    if (followActive) followU = stageT(stage);
    if (stage === ST.align) recovery = 2;
    updateState();
  }

  function openTab(index, historyMode) {
    const entering = index === 1;
    if (entering !== active) {
      if (entering) {
        if (window.PCS.setPlaying) window.PCS.setPlaying(false);
        window.PCS.state.stepTo = null;
      } else {
        setPlaying(false);
        closeBlockLens();
      }
    }
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    });
    active = entering;
    window.PCS1600View.setActive(index === 2);
    if (entering) {
      setupScene();
      refresh();
      if (resize) resize();
    }
    const hash = index === 0 ? '#lab' : '#' + panels[index].id;
    if (historyMode && location.hash !== hash) {
      history.pushState(null, '', hash);
    }
  }

  function syncHash() { openTab(Math.max(0, panels.findIndex(panel => '#' + panel.id === location.hash)), false); }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => openTab(i, true));
    tab.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1
        : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
    });
  });
  window.addEventListener('popstate', syncHash);
  window.addEventListener('hashchange', syncHash);
  document.querySelectorAll('.showme').forEach(button =>
    button.addEventListener('click', () => openTab(0, active), true));

  function fillOptions(key, count, label) {
    M.range(count).forEach(i => get(key).add(new Option(label + i, i)));
  }
  fillOptions('physical', 8, '通道 ');
  fillOptions('lane', 32, 'PCS lane ');
  get('progress').max = stages.length - 1;
  buttons = stages.map(([title, note], i) => {
    const button = document.createElement('button');
    button.className = 'btn';
    button.type = 'button';
    button.textContent = (i + 1) + ' · ' + title;
    button.title = note;
    button.onclick = () => setStage(i);
    get('stages').append(button);
    return button;
  });
  get('play').onclick = () => setPlaying(!playing);
  get('step').onclick = () => {
    setPlaying(false);
    progress = 0;
    advance();
    if (focusMode) focusStageCamera(stage);
  };
  get('idle').onclick = () => {
    idleMode = !idleMode;
    get('idle').setAttribute('aria-pressed', String(idleMode));
    words = null;
    refresh();
    setStage(1);
    showData('idle');
  };
  get('pmd-fail').onchange = () => refresh(true);
  get('reset').onclick = () => {
    setPlaying(false);
    stage = progress = recovery = 0;
    stopFollow();
    closeBlockLens();
    mapSelectedBlock = 0;
    mapSelectedChar = -1;
    get('follow-block').value = 0;
    ['flow', 'lane', 'mapping', 'phase', 'physical', 'skew', 'speed', 'errors'].forEach(key => {
      const control = get(key);
      if (control.tagName === 'SELECT') control.selectedIndex = key === 'speed' ? 1 : 0;
      else control.value = 0;
    });
    get('loss').checked = get('am').checked = false;
    get('pmd-fail').checked = false;
    idleMode = false;
    get('idle').setAttribute('aria-pressed', 'false');
    words = null;
    refresh();
    markMapSelection();
    setFocusMode(false);
  };
  focusBtn = get('focus');
  if (focusBtn) focusBtn.onclick = () => setFocusMode(!focusMode);
  get('camera').onclick = () => { setFocusMode(false); };
  get('open-data').onclick = () => showData();
  get('follow-start').onclick = () => startFollow(+get('follow-block').value || 0);
  get('follow-stop').onclick = stopFollow;
  get('follow-block').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    startFollow(+get('follow-block').value || 0);
  });
  get('lens-open').onclick = () => openBlockLens(mapSelectedBlock, mapSelectedChar);
  get('lens-close').onclick = closeBlockLens;
  get('lens-prev').onclick = () => openBlockLens(Math.max(0, lensBlock - 1), -1);
  get('lens-next').onclick = () => openBlockLens(lensBlock + 1, -1);
  get('lens-follow').onclick = () => {
    const block = lensBlock;
    closeBlockLens();
    startFollow(block);
  };
  get('lens-zoom-in').onclick = () => setLensZoom(lensZoom + 0.12);
  get('lens-zoom-out').onclick = () => setLensZoom(lensZoom - 0.12);
  get('lens-fit').onclick = () => setLensZoom(1);
  const lensDialog = byId('g800-lens');
  if (lensDialog) {
    lensDialog.addEventListener('click', event => {
      if (event.target === lensDialog) closeBlockLens();
    });
    lensDialog.addEventListener('close', () => { lensOpen = false; });
    lensDialog.addEventListener('keydown', event => {
      if (event.target.closest('input, textarea, select')) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        openBlockLens(Math.max(0, lensBlock - 1), -1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        openBlockLens(lensBlock + 1, -1);
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setLensZoom(lensZoom + 0.12);
      } else if (event.key === '-') {
        event.preventDefault();
        setLensZoom(lensZoom - 0.12);
      }
    });
  }
  const lensBody = byId('g800-lens-body');
  if (lensBody) {
    lensBody.addEventListener('wheel', event => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      setLensZoom(lensZoom + (event.deltaY > 0 ? -0.12 : 0.12));
    }, { passive: false });
  }
  const mapStrip = byId('g800-map-strip');
  if (mapStrip) {
    mapStrip.addEventListener('click', event => {
      const cell = event.target.closest('.g800-ch');
      if (!cell) return;
      openBlockLens(+cell.dataset.block, +cell.dataset.index);
    });
  }
  get('payload').oninput = () => {
    renderPayloadMap();
    if (followActive) {
      followInfo = blockInfo(followBlock);
      syncFollowUI();
    }
    if (lensOpen) renderBlockLens();
  };
  get('payload').onchange = () => {
    words = null;
    if (followActive) followInfo = blockInfo(followBlock);
    refresh();
    syncFollowUI();
    renderPayloadMap();
    if (lensOpen) renderBlockLens();
  };
  ['mapping', 'phase', 'physical', 'loss', 'am', 'lane', 'flow', 'errors'].forEach(key => {
    get(key).onchange = () => refresh(['mapping', 'phase', 'physical', 'loss', 'am'].includes(key) ||
      (key === 'lane' && get('am').checked));
  });
  get('skew').oninput = () => refresh();
  get('lane-camera').onclick = () => {
    if (focusMode) setFocusMode(false);
    resetCamera(true);
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) setPlaying(false); });

  function themeChanged() {
    requestAnimationFrame(() => {
      readTheme();
      if (scene) {
        scene.background.set(theme.bg);
        recolorModules();
        rebuildTracks();
        draw();
      }
    });
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeChanged);
  new MutationObserver(themeChanged).observe(document.documentElement,
    { attributes: true, attributeFilter: ['data-theme', 'class'] });

  renderPayloadMap();
  setLensZoom(1);
  syncHash();
})();
