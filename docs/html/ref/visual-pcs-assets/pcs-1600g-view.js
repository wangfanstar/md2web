(function () {
  'use strict';
  const T = window.THREE;
  const M = window.PCS800Model;
  const get = name => document.getElementById('g1600-' + name);
  const range = M.range;

  // Clause references and display notes for the 15-stage 1.6TBASE-R picture.
  const steps = [
    ['1.6TMII', '174、175.2.1', '每次传输 8 个数据字节和 8 位控制指示，速率 1.6 Tb/s。'],
    ['64B/66B · 速率匹配', '175.2.4.1–2', '每 8 字节编码为一个 66b 块（2 位同步头 + 64 位数据）；转码前按规则删除或插入 Idle。'],
    ['256B/257B', '175.2.4.3', '四个连续 66b 块先转码为一个 257b 块（1 位头 + 4×64 位）。'],
    ['257b 分流', '175.2.4.4', '257b 块交替送入 Flow 0、Flow 1；注意分流发生在转码之后，不是 66b 块分流。'],
    ['加扰 · AM', '175.2.4.5–6', '两流独立加扰。每流每 327,680 个 257b 块插入 1,028 位 AM；带 AM 的组 = AM + 36 个加扰数据块。'],
    ['RS(544,514)', '175.2.4.7–8', '每流把 10,280 位分成两个 5140 位消息并编码：Flow 0 生成 A/B，Flow 1 生成 C/D。'],
    ['16 PCS lane', '175.2.4.9', 'A/B/C/D 四个码字按 10 位符号以 A,B,C,D 循环交织到 16 条 PCS lane；每 lane 106.25 Gb/s。'],
    ['16:8 SM-PMA', '176.4.2.3.3、176.4.2.5.2', '先按 40 位符号四元组边界对齐，再由 8 个四元组复用器把两条 PCS lane 交替送到一条输出 lane。'],
    ['8 × PAM4', '176.4.2、176.4.3.1', '8 条输出 lane，每条 212.5 Gb/s（106.25 GBd），以 PAM4 传送 40 位符号四元组。'],
    ['RX 四元组解复用', '176.4.3.2.2–3', '接收方向按 40 位四元组恢复 16 条 lane；AM 锁定确认四元组边界和 PCS lane 身份。'],
    ['AM 锁定 · 重排', '175.2.5.1–2', '16 条 lane 执行 AM 锁定、deskew 与重排；PCS 最大 Skew 为 152 ns。'],
    ['RS 解码 · 后交织', '175.2.5.3–4', '去交织重建 A/B/C/D，逐码字纠错；每个 RS(544,514) 码字最多纠正 15 个符号。'],
    ['AM 移除 · 解扰', '175.2.5.5–6', '每流移除 AM，再用相同的自同步解扰器恢复 257b 块。'],
    ['257b 合流', '175.2.5.7', '先收集 Flow 0 的首块，再取 Flow 1 的首块，随后交替收集。'],
    ['逆转码 · 解码', '175.2.5.8–10', '合流后进行 257b 逆转码、64B/66B 解码和 RX 速率匹配，恢复 1.6TMII 传输。']
  ];
  const STEP = steps.length - 1;
  const SPACING = 12;
  const x = steps.map((_, i) => (i - STEP / 2) * SPACING);
  const SPAN = x[STEP] - x[0];
  const FLOW_Y = 13, BAND = 18;
  const FLOW0 = '#268ec7', FLOW1 = '#d97139';
  const CODE_COLORS = ['#2f9fd8', '#8ac9e8', '#d97139', '#f0b07a'];
  const PAYLOAD = '1.6TBASE-R: 16 PCS lanes, A/B/C/D quartets, 16:8 SM-PMA, 8 PAM4 lanes, 152 ns skew. ';

  let stage = 13, progress = 0, active = false, playing = false, frame = 0, started = null;
  let renderer, scene, camera, controls, inst, meta = [], count = 0;
  let modules = [], moduleMeshes = [], curves = [], tracks = [], tubes = [], rings = [], sheaths = [];
  let linkGroup, labelHost, labelItems = [], theme = {};
  let cameraTouched = false, zoomAnchor = null, zoomAnchorAt = 0;
  let webglFailed = false;
  let decoded = [null, null];
  let locks;
  const MAX_INST = 2600, STEP_T = 1 / 72, STREAM = 72;

  // ------------------------------------------------------------------ data
  function byteAt(block, i) {
    return PAYLOAD.charCodeAt(((block * 32 + i) % PAYLOAD.length)) & 127;
  }
  function flowBytes(flow, block) {
    return range(32).map(i => byteAt(block * 2 + flow, i));
  }
  function flowBlockBits(flow, block) {
    return [1].concat(flowBytes(flow, block).flatMap(b =>
      range(8).map(k => (b >> k) & 1)));
  }
  const blocks = [0, 1].map(flow => range(36).map(block => flowBlockBits(flow, block)));
  function amBits(flow) {
    return range(1028).map(i => (((i * 13 + flow * 7) % 17) < 8 ? 1 : 0));
  }
  const streams = blocks.map((data, flow) => amBits(flow).concat(M.scramble(data, flow)));
  const codewords = streams.flatMap(stream => [0, 1].map(word => {
    const message = range(514).map(i => range(10).reduce((n, bit) =>
      n | (stream[20 * i + 10 * word + bit] << bit), 0));
    return message.concat(window.PCS.rsParity(message));
  }));
  const laneSymbols = range(16).map(lane =>
    range(34).flatMap(row => codewords.map(word => word[16 * row + lane])));

  function decode() {
    const lane = Math.max(0, Number(get('lane').value));
    const errorCount = Number(get('errors').value);
    const physical = range(8).map(channel => range(34).flatMap(row =>
      quartet(2 * channel, row).concat(quartet(2 * channel + 1, row))));
    const lost = get('loss').checked ? Math.floor(lane / 2) : -1;
    const skew = Number(get('skew').value);
    const phase = Number(get('phase').value);
    const slots = [];
    let symbolLocks = 0;
    physical.forEach((symbols, channel) => {
      if (channel === lost) return;
      const offset = channel === Math.floor(lane / 2) ? phase : 0;
      const input = symbols.slice(offset).concat(symbols.slice(0, offset));
      const expected = symbols.slice(0, 8);
      const boundary = input.findIndex((_, i) => expected.every((value, j) =>
        value === input[(i + j) % input.length]));
      if (boundary < 0) return;
      symbolLocks++;
      const aligned = input.slice(boundary).concat(input.slice(0, boundary));
      for (const side of [0, 1]) {
        const id = 2 * channel + side;
        slots[rxSlot(id)] = range(34).flatMap(row =>
          aligned.slice(8 * row + 4 * side, 8 * row + 4 * side + 4));
      }
    });
    const received = [];
    slots.forEach(symbols => {
      const id = range(16).find(i => quartet(i, 0).every((symbol, j) => symbol === symbols[j]));
      if (id !== undefined) received[id] = symbols;
    });
    const amCount = received.filter(Boolean).length;
    locks = { physical: symbolLocks, amCount, skew, aligned: amCount === 16 && skew <= 152,
      lanes: range(16).map(i => Boolean(received[i])) };
    if (!locks.aligned) {
      decoded = [null, null];
      return;
    }
    for (let i = 0; i < errorCount; i++) received[lane][4 * i] ^= i + 1;
    const words = range(4).map(word => {
      const message = range(544).map(i => received[i % 16][4 * Math.floor(i / 16) + word]);
      const result = window.PCS.rsDecode(message);
      return result.ok && result.cw.every((n, i) => n === codewords[word][i]) ? result.cw : null;
    });
    decoded = [0, 1].map(flow => {
      const pair = words.slice(2 * flow, 2 * flow + 2);
      if (pair.some(word => !word)) return null;
      const stream = range(514).flatMap(i => pair.flatMap(word =>
        range(10).map(bit => (word[i] >> bit) & 1)));
      return M.scramble(stream.slice(1028), flow, true);
    });
  }

  function quartet(lane, row) {
    return laneSymbols[lane].slice(4 * row, 4 * row + 4);
  }
  function hex(n, width) { return n.toString(16).toUpperCase().padStart(width || 3, '0'); }
  let selectedFlow = 0;
  function laneY(lane) { return (7.5 - lane) * 1.35; }
  function pmaY(s) { return (3.5 - s) * 2.8; }
  function rxSlot(lane) { return (lane * 5 + 3) % 16; }
  function rxY(lane) { return (7.5 - rxSlot(lane)) * 1.35; }
  function flowY(flow) { return flow ? -FLOW_Y : FLOW_Y; }
  function stageT(i) { return i / STEP; }
  function stageAtPath(t) { return Math.max(0, Math.min(STEP, Math.round(t * STEP))); }
  function smooth(t) {
    t = Math.min(1, Math.max(0, t));
    return t * t * (3 - 2 * t);
  }
  function flowTxY(flow, t) {
    return flowY(flow) * smooth((t - stageT(3)) / (stageT(4) - stageT(3)));
  }
  function flowRxY(flow, t) {
    return flowY(flow) * (1 - smooth((t - stageT(12.5)) / (stageT(13) - stageT(12.5))));
  }

  // --------------------------------------------------------------- theme/3D
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
      box: cssVar('--scene-box') || '#dde3eb',
      edge: cssVar('--scene-edge') || '#8592a5',
      am: cssVar('--am') || '#e2a41f',
      bad: cssVar('--bad') || '#cc2936',
      good: cssVar('--good') || '#2f8a4c'
    };
  }
  const SHADES = [0.7, 0.84, 1.18, 0.68, 1, 0.76];
  function moduleColors() {
    const box = new T.Color(theme.box);
    return {
      neutral: box.clone().lerp(new T.Color(theme.ink), 0.22),
      flow0: box.clone().lerp(new T.Color(FLOW0), 0.42),
      flow1: box.clone().lerp(new T.Color(FLOW1), 0.42),
      edge: new T.Color(theme.edge)
    };
  }
  function recolorModules() {
    const colors = moduleColors();
    moduleMeshes.forEach(box => {
      const flow = box.userData.flow;
      const base = flow === 0 ? colors.flow0 : flow === 1 ? colors.flow1 : colors.neutral;
      box.material.forEach((material, i) => {
        material.color.copy(base).multiplyScalar(SHADES[i]);
      });
      const edge = box.children[0];
      if (edge && edge.material) edge.material.color.copy(colors.edge);
    });
  }

  function frameNeed(aspect) {
    const tanHalf = Math.tan(camera.fov * Math.PI / 360);
    return Math.max(90, (SPAN / 2 + 18) / (tanHalf * aspect), 38 / tanHalf);
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
  function resetCamera() {
    if (!camera) return;
    cameraTouched = false;
    zoomAnchor = null;
    zoomAnchorAt = 0;
    const host = get('scene');
    const aspect = Math.max(0.8, (host.clientWidth || 16) / (host.clientHeight || 9));
    const dist = frameNeed(aspect);
    camera.position.set(dist * 0.05, dist * 0.21, dist * 0.975);
    controls.target.set(0, 0, 0);
    controls.update();
    draw();
  }
  function wheelZoom(event) {
    if (!active || !camera || !controls || !inst) return;
    event.preventDefault();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    else event.stopPropagation();
    const host = get('scene');
    const rect = host.getBoundingClientRect();
    const pointer = new T.Vector2(
      (event.clientX - rect.left) / rect.width * 2 - 1,
      1 - (event.clientY - rect.top) / rect.height * 2);
    const zoomIn = event.deltaY < 0;
    const scale = zoomIn ? 0.893 : 1 / 0.893;
    const now = performance.now();
    const ray = new T.Raycaster();
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

  function addModule(index, y, height, title, color, flow, offset = 0, narrow = false) {
    const width = narrow ? 3.6 : 8.4;
    const geometry = new T.BoxGeometry(width, height, 5.2);
    const material = SHADES.map(shade =>
      new T.MeshLambertMaterial({
        color: color.clone().multiplyScalar(shade),
        transparent: true,
        opacity: 0.9
      }));
    const box = new T.Mesh(geometry, material);
    box.position.set(x[index] + offset, y, -4.2);
    box.add(new T.LineSegments(new T.EdgesGeometry(geometry),
      new T.LineBasicMaterial({ color: moduleColors().edge })));
    box.userData = { stage: index, flow: flow == null ? -1 : flow, title };
    scene.add(box);
    modules.push({ box, index, title, flow: flow == null ? -1 : flow });
    moduleMeshes.push(box);
  }
  function buildModules() {
    const colors = moduleColors();
    const layout = [
      [0, 0, 10, '1.6TMII', null], [1, 0, 10, '64B/66B', null],
      [2, 0, 30, '257b 转码', null],
      [3, 0, 24, '257b 分流', null],
      [4, FLOW_Y, 9.5, '加扰/AM', 0], [4, -FLOW_Y, 9.5, '加扰/AM', 1],
      [5, FLOW_Y, 9.5, 'RS-FEC', 0], [5, -FLOW_Y, 9.5, 'RS-FEC', 1],
      [6, 0, 34, '16 PCS lane', null], [7, 0, 34, '16:8 PMA', null],
      [8, 0, 34, '8×PAM4', null], [9, 0, 34, 'RX 解复用', null],
      [10, 0, 34, '锁定/Deskew', null],
      [11, FLOW_Y, 9.5, 'RS 解码', 0], [11, -FLOW_Y, 9.5, 'RS 解码', 1],
      [12, FLOW_Y, 9.5, '解扰', 0], [12, -FLOW_Y, 9.5, '解扰', 1],
      [13, 0, 10, '257b 合流', null], [14, 0, 10, '逆转码/解码', null]
    ];
    layout.forEach(([index, y, height, title, flow]) => {
      const color = flow === 0 ? colors.flow0 : flow === 1 ? colors.flow1 : colors.neutral;
      const parts = {
        1: ['64B/66B', 'TX 速率匹配'],
        4: ['加扰', 'AM 映射/插入'],
        5: ['FEC 前分配', 'RS 编码'],
        7: ['TX AM 锁定', '40 位对齐', '四元组复用'],
        8: ['PAM4 编码', 'PAM4 解码'],
        9: ['四元组锁定', '1:2 解复用', 'PCSL AM 锁定'],
        10: ['PCS AM/Deskew', '按 UM 重排'],
        11: ['去交织/RS 解码', 'FEC 后交织'],
        12: ['AM 移除', '解扰'],
        14: ['逆转码', '64B/66B 解码', 'RX 速率匹配']
      }[index] || [title];
      parts.forEach((part, i) => addModule(index, y, height, part, color, flow,
        (i - (parts.length - 1) / 2) * 4, parts.length > 1));
    });
  }

  function disposeGroup(group) {
    if (!group) return;
    group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const list = Array.isArray(o.material) ? o.material : [o.material];
        list.forEach(m => m.dispose());
      }
    });
    scene.remove(group);
  }
  function samplePath(curve, from, to, n) {
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(curve.getPointAt(from + (to - from) * i / n));
    return pts;
  }
  function lanePoint(lane, index) {
    const y = [0, 0, 0, 0, 0, 0, laneY(lane), pmaY(Math.floor(lane / 2)),
      pmaY(Math.floor(lane / 2)), rxY(lane), laneY(lane), 0, 0, 0, 0][index];
    let z = 0;
    if (index === 6 || index === 10) z = (lane % 4 - 1.5) * 0.32;
    else if (index === 7 || index === 8) z = (lane % 2 - 0.5) * 0.55;
    else if (index === 9) z = (rxSlot(lane) % 4 - 1.5) * 0.36;
    return new T.Vector3(x[index], y, z);
  }
  function buildLink() {
    disposeGroup(linkGroup);
    linkGroup = new T.Group();
    scene.add(linkGroup);
    curves = []; tracks = []; tubes = []; rings = []; sheaths = [];
    const selected = Number(get('lane').value);

    [0, 1].forEach(flow => {
      const y = flowY(flow);
      linkGroup.add(new T.Line(new T.BufferGeometry().setFromPoints([
        new T.Vector3(x[3], 0, 0), new T.Vector3(x[4], y, 0), new T.Vector3(x[6], y, 0)
      ]), new T.LineBasicMaterial({ color: flow ? FLOW1 : FLOW0, transparent: true, opacity: 0.3 })));
      linkGroup.add(new T.Line(new T.BufferGeometry().setFromPoints([
        new T.Vector3(x[11], y, 0), new T.Vector3(x[12], y, 0), new T.Vector3(x[13], 0, 0)
      ]), new T.LineBasicMaterial({ color: flow ? FLOW1 : FLOW0, transparent: true, opacity: 0.3 })));
    });
    linkGroup.add(new T.Line(new T.BufferGeometry().setFromPoints([
      new T.Vector3(x[0], 0, 0), new T.Vector3(x[3], 0, 0)
    ]), new T.LineBasicMaterial({ color: theme.muted, transparent: true, opacity: 0.3 })));
    linkGroup.add(new T.Line(new T.BufferGeometry().setFromPoints([
      new T.Vector3(x[13], 0, 0), new T.Vector3(x[14], 0, 0)
    ]), new T.LineBasicMaterial({ color: theme.muted, transparent: true, opacity: 0.3 })));

    range(16).forEach(lane => {
      const curve = new T.CatmullRomCurve3(
        range(6).map(i => lanePoint(lane, i + 6)), false, 'centripetal', 0.35);
      curves[lane] = curve;
      const line = new T.Line(new T.BufferGeometry().setFromPoints(
        samplePath(curve, stageT(6), stageT(11), 120)),
      new T.LineBasicMaterial({
        color: new T.Color(CODE_COLORS[lane % 4]), transparent: true, opacity: 0.34
      }));
      line.frustumCulled = false;
      linkGroup.add(line);
      tracks[lane] = line;
      const tubeCurve = new T.CatmullRomCurve3(samplePath(curve, stageT(6), stageT(11), 80));
      const tube = new T.Mesh(new T.TubeGeometry(tubeCurve, 100, 0.07, 6, false),
        new T.MeshBasicMaterial({
          color: new T.Color(CODE_COLORS[lane % 4]), transparent: true, opacity: 0.9
        }));
      tube.visible = lane === selected;
      tube.frustumCulled = false;
      linkGroup.add(tube);
      tubes[lane] = tube;

      const ring = new T.Mesh(new T.TorusGeometry(0.45, 0.07, 8, 20),
        new T.MeshBasicMaterial({ color: theme.good }));
      ring.rotation.y = Math.PI / 2;
      ring.position.copy(lanePoint(lane, 10));
      linkGroup.add(ring);
      rings[lane] = ring;
    });

    range(8).forEach(s => {
      const y = pmaY(s);
      const curve = new T.LineCurve3(
        new T.Vector3(x[7] - 0.5, y, 0), new T.Vector3(x[8] + 0.5, y, 0));
      const tube = new T.Mesh(new T.TubeGeometry(curve, 1, 0.9, 14, false),
        new T.MeshBasicMaterial({
          color: new T.Color(theme.ink), transparent: true, opacity: 0.07, depthWrite: false
        }));
      linkGroup.add(tube);
      sheaths[s] = tube;
    });
  }

  function buildGround() {
    const gy = -BAND - 2.1;
    const grid = new T.GridHelper(280, 56, theme.rule, theme.rule);
    grid.position.y = gy;
    grid.scale.z = 0.12;
    grid.material.transparent = true;
    grid.material.opacity = 0.28;
    scene.add(grid);
    [x[3] - 0.6, x[11] + 0.6].forEach(px => {
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

  // ---------------------------------------------------------------- labels
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
    const top = BAND + 9;

    modules.forEach(module => {
      const { index, flow, title } = module;
      const y = module.box.position.y;
      const height = module.box.geometry.parameters.height;
      const px = module.box.position.x;
      const labelY = y + (px < x[index] || (px === x[index] && index % 2) ? -1 : 1) * (height / 2 + 1);
      add('box' + index + ':' + flow + ':' + px, '<span data-stage="' + index + '">' +
        (flow < 0 ? '' : 'F' + flow + ' ') + title + '</span>',
        'lbl-box op', [px, labelY, 0], 3);
    });
    steps.forEach((_, index) => {
      add('stage' + index, '<b>' + (index + 1) + '</b>',
        'lbl-stage' + (index === stage ? ' on' : ''), [x[index], top, 0], 4);
    });
    range(8).forEach(s => {
      add('pma' + s, 'P' + s, 'lbl-serdes',
        [x[8] + (s % 2 ? 8.5 : -8.5), pmaY(s), 0], 5);
    });
    const sel = Number(get('lane').value);
    const lane = sel < 0 ? 0 : sel;
    const quartetText = quartet(lane, 0).map((n, i) => 'ABCD'[i] + '=' + hex(n)).join(' ');
    if (sel >= 0) {
      add('lane-in', 'PCS lane ' + lane, 'lbl-lane',
        [x[6] - 4.2, laneY(lane), 0], 8, 'r');
      add('lane-q', quartetText, 'lbl-callout',
        [x[8] + 1.2, pmaY(Math.floor(lane / 2)) - 1.4, 0], 9);
      add('lane-rx', 'RX PMA ' + rxSlot(lane) + ' → PCS ' + lane, 'lbl-callout',
        [x[9] + 1.2, rxY(lane) - 0.9, 0], 9);
    }
    add('align', lockText(),
      'lbl-status ok',
      [x[10], -BAND - 7, 0], 7);
    add('quartet-note', '40 位符号四元组：每条输出 lane 交替接收两条 PCS lane 的四元组',
      'lbl-note', [x[7], -BAND - 3.2, 0], 2);
    [['TRANSMIT', 1], ['CHANNEL', 7], ['RECEIVE', 13]].forEach(zone => {
      add('zone' + zone[0], zone[0] + (zone[0] === 'CHANNEL' ? '' : ' →'), 'lbl-zone',
        [x[zone[1]], -BAND - 11, 0], 2);
    });
    setLabels(list);
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
        show = rect.x0 > -4 && rect.x1 < W + 4 && !placed.some(other =>
          rect.x0 < other.x1 && rect.x1 > other.x0 && rect.y0 < other.y1 && rect.y1 > other.y0);
        if (show) {
          placed.push(rect);
          const transform = 'translate(' + Math.round(left) + 'px,' + Math.round(sy - item.h / 2) + 'px)';
          if (transform !== item.t) {
            item.el.style.transform = transform;
            item.t = transform;
          }
        }
      }
      if (show !== item.shown) {
        item.el.style.visibility = show ? 'visible' : 'hidden';
        item.shown = show;
      }
    });
  }
  function initOverlay() {
    const legend = document.createElement('div');
    legend.className = 'legend g800-legend';
    legend.innerHTML =
      '<span><i class="lg-cube"></i>数据单元</span>' +
      '<span><i class="lg-am"></i>AM 组</span>' +
      '<span><i class="lg-ring"></i>AM 锁定</span>' +
      '<span><i class="lg-sheath"></i>PAM4 通道</span>' +
      '<span><i class="lg-quartet"></i>A/B/C/D 四元组</span>' +
      '<span><i class="lg-bad"></i>错误</span>' +
      '<span class="g800-lg-flow0"><i></i>Flow 0 · A/B</span>' +
      '<span class="g800-lg-flow1"><i></i>Flow 1 · C/D</span>';
    labelHost.parentNode.insertBefore(legend, labelHost.nextSibling);
    const help = document.createElement('span');
    help.className = 'g800-help';
    help.textContent = '拖动平移 · 右键拖动旋转 · 滚轮朝光标缩放 · 点击模块/数据块查看格式';
    hostAppend(help);
  }
  function hostAppend(node) {
    const host = get('scene');
    if (host) host.appendChild(node);
  }

  // ------------------------------------------------------------- draw data
  function pushCube(position, sx, sy, sz, color, info) {
    if (count >= MAX_INST) return;
    const matrix = new T.Matrix4();
    matrix.compose(position, new T.Quaternion(), new T.Vector3(sx, sy, sz));
    inst.setMatrixAt(count, matrix);
    inst.setColorAt(count, color);
    meta[count] = info;
    count++;
  }
  function drawSegment(from, to, y, z, color, flow, phase) {
    const front = (stage + progress) / STEP;
    const base = Math.floor(front / STEP_T);
    for (let i = 0; i < STREAM; i++) {
      const t = front - i * STEP_T;
      if (t < from) break;
      if (t > to) continue;
      const am = (base - i) % 5 === 0;
      const px = x[0] + t * SPAN;
      const py = typeof y === 'function' ? y(t) : y;
      const c = am ? new T.Color(theme.am).lerp(color, 0.22) : color.clone();
      pushCube(new T.Vector3(px, py, z), am ? 2.2 : 1.75, am ? 1.0 : 0.5,
        am ? 0.9 : 0.55, c, { seg: phase, flow, n: base - i, t });
    }
  }
  function drawLanes() {
    const front = (stage + progress) / STEP;
    const selected = Number(get('lane').value);
    for (let lane = 0; lane < 16; lane++) {
      const base = Math.floor(front / STEP_T);
      const on = selected < 0 || selected === lane;
      for (let i = 0; i < STREAM; i++) {
        const t = front - i * STEP_T;
        if (t < stageT(6)) break;
        if (t > stageT(11)) continue;
        const pos = curves[lane].getPointAt(Math.max(0, Math.min(1, t)));
        const symbol = Math.floor((t - stageT(6)) / (stageT(11) - stageT(6)) * 136);
        const am = symbol > 0 && symbol % 32 === 0;
        let c = new T.Color(CODE_COLORS[((symbol % 4) + 4) % 4]);
        if (!on) c.lerp(new T.Color(theme.paper), 0.72);
        if (am) c = new T.Color(theme.am).lerp(c, 0.2);
        const bad = Number(get('errors').value) > 15 && lane === selected && t > stageT(10);
        if (bad) c = new T.Color(theme.bad);
        pushCube(pos, am ? 2.0 : 1.4, am ? 0.9 : 0.42, am ? 0.82 : 0.48,
          c, { seg: 'lane', lane, flow: -1, n: symbol, t });
      }
    }
  }
  function draw() {
    if (!active || !renderer) return;
    const hostBg = getComputedStyle(get('scene')).backgroundColor;
    if (scene.background.getStyle() !== hostBg) scene.background.set(hostBg);
    const front = (stage + progress) / STEP;
    count = 0;
    const agg = new T.Color(theme.ink).lerp(new T.Color(theme.bg), 0.2);
    drawSegment(0, stageT(3), 0, 0, agg, 0, 'agg');
    for (let flow = 0; flow < 2; flow++) {
      const color = new T.Color(flow ? FLOW1 : FLOW0);
      drawSegment(stageT(3), stageT(6), t => flowTxY(flow, t), 0, color, flow, 'flow');
      if (decoded[flow]) {
        drawSegment(stageT(11), stageT(13), t => flowRxY(flow, t), 0,
          new T.Color(flow ? FLOW1 : FLOW0), flow, 'flow');
      }
    }
    drawLanes();
    drawSegment(stageT(13), 1, 0, 0,
      decoded[0] && decoded[1] ? agg : new T.Color(theme.bad), 0, 'agg');

    inst.count = count;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;

    const selected = Number(get('lane').value);
    const viewDistance = camera.position.distanceTo(controls.target);
    const expose = Math.min(1, Math.max(0, (viewDistance - 12) / 60));
    const boxOpacity = 0.12 + 0.78 * expose;
    moduleMeshes.forEach(box => {
      for (const material of box.material) {
        material.emissive.setHex(box.userData.stage === stage ? 0x26719a : 0x000000);
        material.emissiveIntensity = 0.55;
        material.opacity = boxOpacity;
        material.depthWrite = boxOpacity > 0.82;
      }
      const edge = box.children[0];
      if (edge && edge.material) {
        edge.material.transparent = true;
        edge.material.opacity = 0.18 + 0.72 * expose;
      }
    });
    tracks.forEach((line, lane) => {
      line.material.opacity = selected < 0 ? 0.4 : selected === lane ? 0.7 : 0.18;
    });
    tubes.forEach((tube, lane) => { tube.visible = selected >= 0 && lane === selected; });
    rings.forEach((ring, lane) => {
      ring.material.color.set(theme.good);
      ring.scale.setScalar(selected < 0 || selected === lane ? 1 : 0.75);
      ring.visible = stage >= 10 && locks.lanes[lane];
    });
    sheaths.forEach((sheath, s) => {
      sheath.material.opacity = selected >= 0 && Math.floor(selected / 2) === s ? 0.18 : 0.085;
    });
    renderer.render(scene, camera);
    updateLabels();
  }

  // ---------------------------------------------------------------- popup
  function escHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }
  function byteHex(b) { return b.toString(16).padStart(2, '0').toUpperCase(); }
  function bitsHtml(bytes, focusByte) {
    let html = '';
    bytes.forEach((b, bi) => {
      range(8).forEach(bit => {
        const v = (b >> bit) & 1;
        html += '<span class="g800-bit' + (v ? ' is-one' : '') +
          (focusByte === bi ? ' is-focus' : '') +
          '" title="字节 ' + bi + ' · bit ' + bit + '">' + v + '</span>';
      });
    });
    return html;
  }
  function byteCardsHtml(bytes, base) {
    let html = '';
    bytes.forEach((b, i) => {
      const ch = b === 32 ? '·' : String.fromCharCode(b);
      html += '<div class="g800-byte-card"><b>' + escHtml(ch) + '</b>' +
        '<span>#' + (base + i) + ' · 0x' + byteHex(b) + '</span>' +
        '<code>' + range(8).map(k => (b >> k) & 1).join('') + '</code></div>';
    });
    return html;
  }
  function bitRowFromBits(bits, focusStart, focusLen, headerFirst) {
    let html = '';
    bits.forEach((bit, i) => {
      html += '<span class="g800-bit' + (bit ? ' is-one' : '') +
        (headerFirst !== false && i === 0 ? ' is-header' : '') +
        (i >= focusStart && i < focusStart + focusLen ? ' is-focus' : '') +
        '" title="bit ' + i + '">' + bit + '</span>';
    });
    return html;
  }
  function b257Html(flow, block, activePos) {
    let html = '<div class="g800-b257-line"><span class="g800-b257-label"><b>257b 头</b>（1 位）</span>' +
      '<div class="g800-b257-bits"><span class="g800-bit is-header">1</span></div></div>';
    const bytes = flowBytes(flow, block);
    range(4).forEach(r => {
      const child = bytes.slice(8 * r, 8 * r + 8);
      const active = r === activePos;
      html += '<div class="g800-b257-line' + (active ? ' is-active' : '') + '">' +
        '<span class="g800-b257-label"><b>块 ' + (r + 1) + '</b>' +
        escHtml(child.map(b => b === 32 ? '·' : String.fromCharCode(b)).join('')) + '</span>' +
        '<div class="g800-b257-bits">' + bitsHtml(child, -1) + '</div></div>';
    });
    return html;
  }
  function asciiOf(bytes) {
    return bytes.map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('');
  }
  function view66(flow, block, pos) {
    const bytes = flowBytes(flow, block).slice(pos * 8, pos * 8 + 8);
    const base = (block * 2 + flow) * 32 + pos * 8;
    return '<div class="g800-inspect-summary">' +
      '<span><b>66b 块</b> · Flow ' + flow + '</span>' +
      '<span><b>字节</b> #' + base + '–#' + (base + 7) + '</span>' +
      '<span>“' + escHtml(asciiOf(bytes)) + '”</span></div>' +
      '<div class="g800-inspect-section"><h4>字符 ↔ 字节</h4><div class="g800-byte-row">' +
      byteCardsHtml(bytes, base) + '</div></div>' +
      '<div class="g800-inspect-section"><h4>66b 块 · 2 位同步头 + 64 位数据</h4>' +
      '<div class="g800-bitgrid">' +
      '<div class="g800-bytegroup"><span class="g800-byte-label"><b>SYNC</b><span>01</span></span>' +
      '<div class="g800-bitrow"><span class="g800-bit is-header">0</span><span class="g800-bit is-header">1</span></div></div>' +
      bytes.map((b, i) => '<div class="g800-bytegroup"><span class="g800-byte-label"><b>' +
        escHtml(b === 32 ? '·' : String.fromCharCode(b)) + '</b><span>0x' + byteHex(b) + '</span></span>' +
        '<div class="g800-bitrow">' + bitsHtml([b], -1) + '</div></div>').join('') +
      '</div></div>';
  }
  function view257(flow, block, note) {
    return '<div class="g800-inspect-summary"><span><b>Flow</b> ' + flow +
      '</span><span><b>257b 块</b> #' + block + '</span></div>' +
      '<div class="g800-inspect-section"><h4>257b 块 · 1 位头 + 4×64 位</h4>' +
      '<div class="g800-b257">' + b257Html(flow, block, -1) + '</div></div>' +
      (note ? '<p class="g800-inspect-note">' + note + '</p>' : '');
  }
  function viewAM(flow, block) {
    const am = amBits(flow).slice(0, 160);
    return '<div class="g800-inspect-summary"><span><b>Flow</b> ' + flow +
      '</span><span><b>AM 组</b> 1,028 位</span><span><b>数据</b> 36×257 位</span></div>' +
      '<div class="g800-inspect-section"><h4>AM 组前 160 位（共 1,028 位）</h4>' +
      '<div class="g800-b257-bits">' + bitRowFromBits(am, -1, 0, false) + '</div></div>' +
      '<div class="g800-inspect-section"><h4>紧随 AM 的 257b 数据块</h4>' +
      '<div class="g800-b257">' + b257Html(flow, block, -1) + '</div></div>' +
      '<p class="g800-inspect-note">AM 组在加扰后插入，不参与加扰；每 Flow 每 327,680 个 257b 块插入一次。带 AM 的组 = 1,028 位 AM + 36 个加扰数据块。</p>';
  }
  function viewFEC(flow, block) {
    const wordA = codewords[2 * flow], wordB = codewords[2 * flow + 1];
    const labels = flow ? ['C', 'D'] : ['A', 'B'];
    const syms = (word, label) => word.slice(0, 12).map((n, i) =>
      '<span class="g800-sym" title="' + label + ' 符号 #' + i + '">' + label + i + ':' +
      hex(n) + '</span>').join('');
    return '<div class="g800-inspect-summary"><span><b>Flow</b> ' + flow +
      '</span><span><b>码字</b> ' + labels.join(' / ') + '</span>' +
      '<span><b>FEC</b> ' + (decoded[flow] ? (Number(get('errors').value) ? '已纠正/正常' : '正常') : '不可纠正') + '</span></div>' +
      '<div class="g800-inspect-section"><h4>257b 块</h4><div class="g800-b257">' +
      b257Html(flow, block, -1) + '</div></div>' +
      '<div class="g800-inspect-section"><h4>RS(544,514) 码字前 12 个 10 位符号</h4>' +
      '<p class="g800-inspect-note">' + labels[0] + '：</p><div class="g800-sym-row">' + syms(wordA, labels[0]) + '</div>' +
      '<p class="g800-inspect-note">' + labels[1] + '：</p><div class="g800-sym-row">' + syms(wordB, labels[1]) + '</div></div>' +
      '<p class="g800-inspect-note">每码字 514 个数据符号 + 30 个校验符号；可纠正最多 15 个符号错误。</p>';
  }
  function viewLane(lane, index) {
    const q = quartet(lane, 0);
    const bits = q.flatMap(n => range(10).map(k => (n >> k) & 1));
    return '<div class="g800-inspect-summary"><span><b>PCS lane</b> ' + lane +
      '</span><span><b>Flow</b> ' + flow + '</span>' +
      '<span><b>PMA lane</b> ' + Math.floor(lane / 2) + '</span>' +
      '<span><b>RX PMA lane</b> ' + rxSlot(lane) + '</span>' +
      '<span>' + lockText() + '</span></div>' +
      '<div class="g800-inspect-section"><h4>40 位符号四元组（4 × 10 位）</h4>' +
      '<div class="g800-sym-row">' + q.map((n, i) =>
        '<span class="g800-sym">' + 'ABCD'[i] + '=0x' + hex(n) + '</span>').join('') + '</div>' +
      '<div class="g800-bitrow">' + bitRowFromBits(bits, -1, 0, false) + '</div></div>' +
      (index === 8 ? '<p>首个位对 ' + bits.slice(0, 2).join('') + ' → Gray 电平 ' +
        [0, 1, 3, 2][2 * bits[0] + bits[1]] + ' → 接收位对 ' +
        (locks.physical === 8 || !get('loss').checked ? bits.slice(0, 2).join('') : '按 lane 锁定状态判定') + '。</p>' : '') +
      '<div class="g800-inspect-section"><h4>16:8 SM-PMA</h4>' +
      '<p class="g800-inspect-note">PCS lane ' + (2 * Math.floor(lane / 2)) + ' 与 ' +
      (2 * Math.floor(lane / 2) + 1) + ' 的四元组交替送到 PMA lane ' + Math.floor(lane / 2) +
      '；输出 212.5 Gb/s（106.25 GBd）PAM4。</p></div>' +
      (index >= 9 ? '<div class="g800-inspect-section"><h4>AM 锁定 / Deskew</h4>' +
        '<p class="g800-inspect-note">RX PMA lane ' + rxSlot(lane) + ' → PCS lane ' + lane +
        '；' + lockText() + '。</p></div>' : '');
  }
  function viewBytes(flow, block, pos) {
    const merged = decoded.every(Boolean) && range(36).flatMap(i =>
      [receivedBlock(0, i), receivedBlock(1, i)]);
    if (!merged) return '<p>RX 1.6TMII 示例输出不可用。</p>';
    const bits = merged[2 * block + flow];
    const bytes = range(8).map(i => range(8).reduce((byte, bit) =>
      byte | (bits[1 + pos * 64 + 8 * i + bit] << bit), 0));
    const base = (block * 2 + flow) * 32 + pos * 8;
    return '<div class="g800-inspect-summary"><span><b>1.6TMII 交付</b> 8 字节</span>' +
      '<span><b>字节</b> #' + base + '–#' + (base + 7) + '</span></div>' +
      '<div class="g800-inspect-section"><h4>字符 ↔ 字节</h4>' +
      '<div class="g800-byte-row">' + byteCardsHtml(bytes, base) + '</div>' +
      '<p class="g800-inspect-text">“' + escHtml(asciiOf(bytes)) + '”</p></div>';
  }
  function stageKind(index) {
    if (index <= 1) return 'b66';
    if (index === 2 || index === 3 || index === 12 || index === 13) return 'b257';
    if (index === 4) return 'am';
    if (index === 5 || index === 11) return 'fec';
    if (index === 6) return 'lane';
    if (index === 7 || index === 8) return 'pma';
    if (index === 9 || index === 10) return 'rx';
    return 'bytes';
  }
  function showPopup(index, flow, lane, title) {
    flow = flow === 1 ? 1 : 0;
    lane = Math.max(0, Math.min(15, Number(lane) || 0));
    const kind = stageKind(index);
    const label = {
      b66: '66b 块', b257: '257b 块', am: 'AM 组', fec: 'A/B/C/D 码字',
      lane: 'PCS lane 四元组', pma: 'PMA 四元组', rx: 'RX lane / Deskew', bytes: '8 字节'
    }[kind] || '';
    get('popup-title').textContent = (title || steps[index][0]) + ' · ' + label;
    get('popup-note').textContent = steps[index][1] + ' · ' + steps[index][2];
    let body = '';
    if (kind === 'b66') body = view66(flow, 0, 0);
    else if (kind === 'b257' && index >= 12) {
      const streams = index === 13 ? [receivedBlock(0, 0), receivedBlock(1, 0)] : [receivedBlock(flow, 0)];
      body = streams.every(Boolean) ? streams.map((bits, i) =>
        '<p>Flow ' + (index === 13 ? i : flow) + ' · 首个恢复的 257b 块</p><div class="g800-bitrow">' +
        bitRowFromBits(bits, -1, 0, false) + '</div>').join('') : '<p>接收输出不可用。</p>';
    } else if (kind === 'b257') body = view257(flow, 0, steps[index][2]);
    else if (kind === 'am') body = viewAM(flow, 0);
    else if (kind === 'fec') body = viewFEC(flow, 0);
    else if (kind === 'bytes') body = viewBytes(flow, 0, 0);
    else body = viewLane(lane, index);
    if (title === 'TX 速率匹配' || title === 'RX 速率匹配') {
      body = title === 'TX 速率匹配'
        ? '<p>补偿 AM 插入可按规则删除 Idle 控制字符或序列有序集。时钟域补偿还允许插入 Idle。</p><p>示意　数据 A · Idle · 数据 B → 数据 A · 数据 B</p>'
        : '<p>补偿 AM 移除可插入 Idle。时钟域补偿另按 119.2.3.5 和 119.2.3.8 的插删规则处理。</p><p>示意　数据 A · 数据 B → 数据 A · Idle · 数据 B</p>' + body;
    }
    const moduleNotes = {
      'TX AM 锁定': '176.4.2.2 · 教学输入已提供合成 AM 边界。',
      '40 位对齐': '176.4.2.3.3 · 各 PCS lane 对齐到相对于 AM 起点的 40 位边界。',
      '四元组锁定': '176.4.3.2.2 · 用合成 AM 样本搜寻起點。可改变选中物理 lane 的起始符号偏移，再观察锁定结果。',
      'PCSL AM 锁定': '176.4.3.2.3 · 在解复用得到的 PCS lane 上识别合成 AM。',
      '按 UM 重排': '175.2.5.2 · PCS 按 AM 的 UM 识别 lane 号。教学模型按收到的合成标记识别并恢复顺序。',
      'FEC 前分配': '175.2.4.7 · 每流把 10 位符号依次交替送入两条消息。',
      'FEC 后交织': '175.2.5.4 · 每流依次交替取纠错后的两条消息各一个 10 位符号。',
      'AM 移除': '175.2.5.5 · 从纠错并后交织的数据移除开头 1,028 位 AM，余下位进入解扰。'
    };
    if (moduleNotes[title]) body = '<p>' + moduleNotes[title] + '</p>' + body;
    get('popup-data').innerHTML = body;
    if (!get('popup').open) get('popup').showModal();
  }

  // -------------------------------------------------------------- stage/detail
  function lockText() {
    return 'TX PMA AM 16/16 · RX PMA 四元组锁定 ' + locks.physical + '/8 · PCSL AM ' + locks.amCount +
      '/16 · PCS align_status ' + locks.aligned + ' · ' + locks.skew + ' ns';
  }

  function receivedBlock(flow, block) {
    return decoded[flow]?.slice(block * 257, (block + 1) * 257);
  }

  function stageData(index, flow) {
    const lane = Math.max(0, Number(get('lane').value));
    const q = quartet(lane, 0).map((n, i) => 'ABCD'[i] + '=' + hex(n)).join(' ');
    const pma = Math.floor(lane / 2);
    if (index === 0) return '1.6TMII：每次 8 字节 + 8 位控制；示例字节 “' +
      asciiOf(flowBytes(0, 0).slice(0, 8)) + '”。';
    if (index === 1) return '64B/66B：01 同步头 + 64 位数据。示例 Flow ' + flow +
      ' 字节 “' + asciiOf(flowBytes(flow, 0).slice(0, 8)) + '”。';
    if (index === 2) return '256B/257B：四个 66b 块重打包为 257b 块；1 位头 + 4×64 位。';
    if (index === 3) return '257b 块交替分配到 Flow 0/1；Flow ' + flow + ' 的第 0 个 257b 块包含原始块 ' +
      range(4).map(i => (2 * 0 + flow) * 4 + i).join('、') + '。';
    if (index === 4) return 'Flow ' + flow + '：AM 组 1,028 位 + 36×257 位加扰数据；每 327,680 个 257b 块插入一次。';
    if (index === 5 || index === 11) return 'Flow ' + flow + ' 的 ' + (flow ? 'C/D' : 'A/B') +
      ' 码字：514 数据符号 + 30 校验符号；' +
      (decoded[flow] ? '当前 FEC 正常/已纠正。' : '当前码字不可纠正。');
    if (index >= 9 && index <= 10) return lockText();
    if (index >= 6 && index <= 8) return 'PCS lane ' + lane + ' 的四元组 [' + q +
      ']；PMA lane ' + pma + '，RX PMA lane ' + rxSlot(lane) + '；每输出 lane 212.5 Gb/s（106.25 GBd）PAM4。';
    if (index === 12) return 'Flow ' + flow + ' 解扰后恢复 257b 块；' +
      (decoded[flow] ? '首块前 33 位 ' + decoded[flow].slice(0, 33).join('') : '输出不可用。');
    if (index === 13) return '257b 合流：先取 Flow 0 首块，再取 Flow 1 首块，随后交替。';
    return '逆转码与 64B/66B 解码后，通过 1.6TMII 交付 8 字节。';
  }
  function select(index) {
    stage = Math.max(0, Math.min(STEP, index));
    progress = 0;
    const [name, clause, note] = steps[stage];
    get('title').textContent = (stage + 1) + ' · ' + name + ' · ' + clause;
    get('note').textContent = note;
    get('data').textContent = stageData(stage, selectedFlow);
    get('count').textContent = (stage + 1) + ' / ' + steps.length;
    get('progress').value = stage;
    stepButtons.forEach((button, i) => button.setAttribute('aria-current', i === stage ? 'step' : 'false'));
    if (renderer && active) {
      buildLabels();
      draw();
    }
    if (get('popup').open) showPopup(stage, selectedFlow, Number(get('lane').value));
  }

  // ----------------------------------------------------------------- controls
  const stepButtons = steps.map(([name], index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = (index + 1) + ' · ' + name;
    button.onclick = () => { pause(); select(index); };
    get('stages').append(button);
    return button;
  });
  get('progress').max = STEP;
  get('lane').add(new Option('全部 lane', -1));
  range(16).forEach(i => get('lane').add(new Option('PCS lane ' + i, i)));
  get('lane').value = -1;
  decode();
  select(stage);

  function pause() {
    playing = false;
    cancelAnimationFrame(frame);
    started = null;
    get('play').textContent = '播放';
    get('play').setAttribute('aria-pressed', 'false');
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  function tick(now) {
    if (!playing) return;
    if (started === null) started = now;
    const p = (now - started) / 850;
    if (p >= 1) {
      select((stage + 1) % steps.length);
      started = now;
      if (stage === STEP) { pause(); return; }
    } else {
      progress = reduced.matches ? 0 : p;
      if (renderer && active) {
        get('progress').value = stage + p;
        draw();
      }
    }
    frame = requestAnimationFrame(tick);
  }
  get('play').onclick = () => {
    if (playing) { pause(); return; }
    if (stage === STEP) select(0);
    playing = true;
    started = null;
    get('play').textContent = '暂停';
    get('play').setAttribute('aria-pressed', 'true');
    frame = requestAnimationFrame(tick);
  };
  get('step').onclick = () => { pause(); select((stage + 1) % steps.length); };
  get('reset').onclick = () => {
    pause();
    get('lane').value = -1;
    get('errors').value = '0';
    get('skew').value = '0';
    get('phase').value = '0';
    get('loss').checked = false;
    selectedFlow = 0;
    decode();
    select(0);
    resetCamera();
  };
  get('loss').onchange = get('phase').onchange = get('skew').onchange =
    get('errors').onchange = get('lane').onchange = () => {
    decode();
    select(stage);
  };
  get('test-pattern').onclick = () => {
    pause();
    get('popup-title').textContent = 'Scrambled Idle 测试模式';
    get('popup-note').textContent = '175.2.4.11 · tx_test_mode = 1 时，PCS 输出等同于 1.6TMII 持续输入 Idle 控制字符时的结果。';
    get('popup-data').textContent = '全 Idle 控制字符 → 64B/66B 控制块 → 257b 转码 → 双 Flow 加扰 → AM 和 RS-FEC → PCS lane。此入口展示测试路径。';
    get('popup').showModal();
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  // ---------------------------------------------------------------- scene setup
  function setup() {
    if (renderer || webglFailed) return;
    const host = get('scene');
    try {
      readTheme();
      renderer = new T.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      host.prepend(renderer.domElement);
      scene = new T.Scene();
      scene.background = new T.Color(theme.bg);
      scene.add(new T.HemisphereLight(0xffffff, 0x8291a8, 1.1));
      const light = new T.DirectionalLight(0xffffff, 0.55);
      light.position.set(-20, 28, 40);
      scene.add(light);
      buildModules();
      buildGround();
      camera = new T.PerspectiveCamera(36, 1, 0.1, 900);
      controls = new T.OrbitControls(camera, renderer.domElement);
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
        zoomAnchor = null;
        zoomAnchorAt = 0;
      });
      controls.addEventListener('change', () => draw());
      renderer.domElement.addEventListener('wheel', wheelZoom, { passive: false, capture: true });

      inst = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1),
        new T.MeshBasicMaterial({ color: 0xffffff }), MAX_INST);
      inst.instanceMatrix.setUsage(T.DynamicDrawUsage);
      inst.setColorAt(0, new T.Color());
      inst.frustumCulled = false;
      inst.count = 0;
      scene.add(inst);
      meta = new Array(MAX_INST);

      labelHost = document.createElement('div');
      labelHost.className = 'scene-labels';
      labelHost.setAttribute('aria-hidden', 'true');
      labelHost.addEventListener('click', event => {
        const hit = event.target.closest('[data-stage]');
        if (hit) { pause(); select(+hit.dataset.stage); }
      });
      host.appendChild(labelHost);
      initOverlay();
      buildLink();
      new ResizeObserver(resize).observe(host);
      window.addEventListener('resize', resize);
      resize();
      resetCamera();
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
          labelItems.forEach(item => { item.w = 0; });
          draw();
        });
      }

      let pointer;
      renderer.domElement.addEventListener('pointerdown', event => {
        pointer = [event.clientX, event.clientY];
      });
      renderer.domElement.addEventListener('click', event => {
        if (!pointer || Math.hypot(event.clientX - pointer[0], event.clientY - pointer[1]) > 5) return;
        const rect = renderer.domElement.getBoundingClientRect();
        const ray = new T.Raycaster();
        ray.setFromCamera(new T.Vector2(
          (event.clientX - rect.left) / rect.width * 2 - 1,
          1 - (event.clientY - rect.top) / rect.height * 2), camera);
        const packet = ray.intersectObject(inst)[0];
        if (packet && packet.instanceId != null) {
          const info = meta[packet.instanceId];
          if (info) {
            if (info.seg === 'lane') get('lane').value = info.lane;
            decode();
            pause();
            select(stageAtPath(info.t));
            showPopup(stage, info.flow, info.seg === 'lane' ? info.lane : Number(get('lane').value));
            return;
          }
        }
        const module = ray.intersectObjects(moduleMeshes, false)[0];
        if (module) {
          const info = module.object.userData;
          if (info.flow >= 0) selectedFlow = info.flow;
          decode();
          pause();
          select(info.stage);
          showPopup(info.stage, info.flow >= 0 ? info.flow : selectedFlow,
            Number(get('lane').value), info.title);
        }
      });
      const observer = new MutationObserver(() => {
        readTheme();
        scene.background.set(theme.bg);
        recolorModules();
        buildLink();
        draw();
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    } catch (error) {
      webglFailed = true;
      if (renderer) renderer.dispose();
      renderer = null;
      host.textContent = 'WebGL 不可用。可用下方阶段按钮查看全部流程和数据。';
    }
  }

  function resize() {
    if (!active || !renderer || !get('scene').clientWidth || !get('scene').clientHeight) return;
    const host = get('scene');
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
    if (!cameraTouched) fitCameraMin();
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    draw();
    updateLabels();
  }

  // ------------------------------------------------------------------- tab API
  window.PCS1600View = {
    setActive(on) {
      if (active === on) return;
      active = on;
      if (!on) {
        pause();
        if (get('popup').open) get('popup').close();
        return;
      }
      setup();
      decode();
      resize();
      select(stage);
    }
  };
})();
