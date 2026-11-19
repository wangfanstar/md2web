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
  let modules = [], moduleMeshes = [], tracks = [], tubes = [], rings = [], sheaths = [];
  let linkGroup, labelHost, labelItems = [], theme = {};
  let cameraTouched = false, zoomAnchor = null, zoomAnchorAt = 0;
  let webglFailed = false;
  let focusMode = false, stageBand = null, stageBadge = null, focusBtn = null;
  let hoverStage = -1, hoverFlow = -1;
  let camTween = null, camTweenFrame = 0, camTweenTimer = 0;
  let decoded = [null, null];
  let decodedWords = [null, null, null, null];
  let locks;
  let lastPopup = null;
  let stateHost = null;
  let testMode = false;
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
  const dataBits = blocks.map(list => list.flat());
  // 图 175-3 的 am_x<119:0> 字段布局；octets 取表 175-2 中 PCS lane 0 的实测值。
  const AM_FIELDS = [
    { name: 'CM0–CM2', from: 0, bits: 24, octets: 3, note: '码字标记低位' },
    { name: 'UP0', from: 24, bits: 8, octets: 1, note: '保留' },
    { name: 'CM3–CM5', from: 32, bits: 24, octets: 3, note: '码字标记高位' },
    { name: 'UP1', from: 56, bits: 8, octets: 1, note: '保留' },
    { name: 'UM0–UM2', from: 64, bits: 24, octets: 3, note: 'lane 号低位' },
    { name: 'UP2', from: 88, bits: 8, octets: 1, note: '保留' },
    { name: 'UM3–UM5', from: 96, bits: 24, octets: 3, note: 'lane 号高位' }
  ];
  const AM_OCTET_NAMES = ['CM0', 'CM1', 'CM2', 'UP0', 'CM3', 'CM4', 'CM5',
    'UP1', 'UM0', 'UM1', 'UM2', 'UP2', 'UM3', 'UM4', 'UM5'];
  const AM_LANE0 = [0x9A, 0x4A, 0x26, 0xB6, 0x65, 0xB5, 0xD9, 0xD9,
    0xFE, 0x8E, 0x0C, 0x26, 0x01, 0x71, 0xF3];
  function octetBits(octets) {
    return octets.flatMap(value => range(8).map(bit => (value >> bit) & 1));
  }
  const amSuffixes = [
    'B6 D9 FE 8E 0C 26 01 71 F3', '04 67 A5 21 81 98 5A DE 7E',
    '46 FE C1 0C A9 01 3E F3 56', '5A 84 79 7F 2F 7B 86 80 D0',
    'E1 19 D5 AE 0D E6 2A 51 F2', 'F2 4E ED B0 2E B1 12 4F D1',
    '3D EE BD 63 5E 11 42 9C A1', '22 32 29 89 A4 CD D6 76 5B',
    '60 9F 1E 8C 8A 60 E1 73 75', '6B A2 8E 3B C3 5D 71 C4 3C',
    'FA 04 6A 14 27 FB 95 EB D8', '6C 71 DD 99 C7 8E 22 66 38',
    '18 5B 5D 09 6A A4 A2 F6 95', '14 CC CE 68 3C 33 31 97 C3',
    'D0 B1 35 04 59 4E CA FB A6', 'B4 56 59 45 86 A9 A6 BA 79'
  ];
  const markers = amSuffixes.map(suffix => {
    const [up0, ...tail] = suffix.split(' ').map(octet => parseInt(octet, 16));
    return octetBits([...AM_LANE0.slice(0, 3), up0, ...AM_LANE0.slice(4, 7), ...tail]);
  });
  let receivedAmStatus = null;
  function amBits(flow) {
    let state = 0x1ff;
    const pad = range(flow ? 65 : 68).map(() => {
      const bit = state & 1;
      state = (state >> 1) | (((state ^ (state >> 5)) & 1) << 8);
      return bit;
    });
    const mapped = range(3).flatMap(row => markers.flatMap(bits =>
      bits.slice(40 * row + 20 * flow, 40 * row + 20 * flow + 20)));
    return mapped.concat(pad, flow ? [0, 0, 0] : []);
  }
  // Teaching representation of a run of all-Idle control blocks.
  const idleBlock = octetBits([0x1e, ...range(7).map(() => 0)]);
  const idleBits = range(36).flatMap(() => [0].concat(idleBlock, idleBlock, idleBlock, idleBlock));
  let streams, codewords, laneSymbols;

  function buildTransmit() {
    streams = dataBits.map((bits, flow) => amBits(flow).concat(M.scramble(testMode ? idleBits : bits, flow)));
    // RS 编码器按发送顺序接收消息；码字按草案符号序号存储。
    codewords = streams.flatMap(stream => [0, 1].map(word => {
      const message = range(514).map(k => range(10).reduce((n, bit) =>
        n | (stream[20 * k + 10 * word + bit] << bit), 0));
      return message.concat(window.PCS.rsParity(message)).reverse();
    }));
    // 175.2.4.9：每条 lane 按 A/B/C/D 交替发送 cX<543-16j-i>。
    laneSymbols = range(16).map(lane =>
      range(34).flatMap(j => codewords.map(word => word[543 - 16 * j - lane])));
  }
  buildTransmit();

  function decode() {
    const lane = Math.max(0, Number(get('lane').value));
    const errorCount = Number(get('errors').value);
    const physical = range(8).map(channel => range(34).flatMap(row =>
      quartet(2 * channel, row).concat(quartet(2 * channel + 1, row))));
    const lost = get('loss').checked ? Math.floor(lane / 2) : -1;
    const skew = Number(get('skew').value);
    const phase = Number(get('phase').value);
    receivedAmStatus = null;
    const slots = [];
    let symbolLocks = 0;
    physical.forEach((symbols, channel) => {
      if (channel === lost) return;
      const offset = channel === Math.floor(lane / 2) ? phase : 0;
      const input = symbols.slice(offset).concat(symbols.slice(0, offset));
      const expected = symbols.slice(0, 24);
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
      const um = symbols.slice(0, 12).flatMap(symbol => range(10).map(bit => (symbol >> bit) & 1));
      const id = markers.findIndex(marker => [64, 96].every(start =>
        marker.slice(start, start + 24).every((bit, i) => bit === um[start + i])));
      if (id < 0) return;
      received[id] = symbols;
    });
    const amCount = received.filter(Boolean).length;
    locks = { physical: symbolLocks, amCount, skew, aligned: amCount === 16 && skew <= 152,
      lanes: range(16).map(i => Boolean(received[i])) };
    if (!locks.aligned) {
      decoded = [null, null];
      decodedWords = [null, null, null, null];
      return;
    }
    for (let i = 0; i < errorCount; i++) received[lane][4 * i] ^= i + 1;
    const words = range(4).map(word => {
      const message = range(544).map(i => received[i % 16][4 * Math.floor(i / 16) + word]);
      const result = window.PCS.rsDecode(message);
      return result.ok && result.cw.every((n, i) => n === codewords[word][543 - i]) ? result.cw.reverse() : null;
    });
    decodedWords = words;
    decoded = [0, 1].map(flow => {
      const pair = words.slice(2 * flow, 2 * flow + 2);
      if (pair.some(word => !word)) return null;
      const stream = range(514).flatMap(i => pair.flatMap(word =>
        range(10).map(bit => (word[543 - i] >> bit) & 1)));
      if (flow === 1) receivedAmStatus = stream.slice(1025, 1028).reverse().join('');
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
      [x[13] + (x[14] - x[13]) / 2, 0]
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
    stageBadge.innerHTML = '<b>' + (stage + 1) + ' / ' + steps.length + '</b>' +
      '<span>' + steps[stage][0] + '</span>' + (focusMode ? '<i>聚焦</i>' : '');
    stageBadge.setAttribute('aria-pressed', focusMode ? 'true' : 'false');
    stageBadge.classList.toggle('is-focus', focusMode);
  }
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
        8: ['PAM4 编码', '预编码/逆预编码', 'PAM4 解码'],
        9: ['四元组锁定', '1:2 解复用', 'PCSL AM 锁定'],
        10: ['PCS AM/Deskew', '按 UM 重排'],
        11: ['去交织', 'RS 解码', 'FEC 后交织'],
        12: ['AM 移除', '解扰'],
        14: ['逆转码', '64B/66B 解码', 'RX 速率匹配']
      }[index] || [title];
      parts.forEach((part, i) => addModule(index, y, height, part, color, flow,
        (i - (parts.length - 1) / 2) * (parts.length === 2 ? 5.2 : 4), parts.length > 1));
    });
    const branchColor = new T.Color(0x8d72c9);
    const branches = [
      { y: 23, from: 7, to: 9, nodes: [[7, '图样发生器'], [9, '图样检测器']] },
      { y: -23, from: 7, to: 9, nodes: [[8, '本地环回']] },
      { y: -30, from: 9, to: 7, nodes: [[8, '远端环回']] }
    ];
    for (const { y, from, to, nodes } of branches) {
      for (const [index, title] of nodes) addModule(index, y, 4, title, branchColor, null);
      const points = [[x[from], 0], [x[from], y], [x[to], y], [x[to], 0]]
        .map(([px, py]) => new T.Vector3(px, py, -7));
      scene.add(new T.Line(new T.BufferGeometry().setFromPoints(points),
        new T.LineBasicMaterial({ color: branchColor })));
      const direction = Math.sign(to - from);
      scene.add(new T.ArrowHelper(new T.Vector3(direction, 0, 0),
        new T.Vector3(x[to] - direction * 7, y, -6.8), 5, branchColor.getHex(), 2, 1.2));
    }
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
  function lanePoint(lane, index) {
    const y = [0, 0, 0, 0, 0, 0, laneY(lane), pmaY(Math.floor(lane / 2)) + (lane % 2 - 0.5) * 0.56,
      pmaY(Math.floor(lane / 2)) + (lane % 2 - 0.5) * 0.56, rxY(lane), laneY(lane), 0, 0, 0, 0][index];
    let z = 0;
    if (index === 6 || index === 10) z = (lane % 4 - 1.5) * 0.32;
    else if (index === 9) z = (rxSlot(lane) % 4 - 1.5) * 0.36;
    return new T.Vector3(x[index], y, z);
  }
  function buildLink() {
    disposeGroup(linkGroup);
    linkGroup = new T.Group();
    scene.add(linkGroup);
    tracks = []; tubes = []; rings = []; sheaths = [];
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
      laneSamples[lane] = curve.getSpacedPoints(curveSamples);
      const line = new T.Mesh(new T.TubeGeometry(curve, 100, 0.055, 5, false),
      new T.MeshBasicMaterial({
        color: new T.Color(CODE_COLORS[lane % 4]), transparent: true, depthWrite: false, opacity: 0.55
      }));
      line.frustumCulled = false;
      linkGroup.add(line);
      tracks[lane] = line;
      const tube = new T.Mesh(new T.TubeGeometry(curve, 100, 0.07, 6, false),
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
      tube.renderOrder = 1;
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

    const primaryKey = {};
    modules.forEach(module => {
      if (Math.abs(module.box.position.y) > FLOW_Y + 2) return;
      const offset = module.box.position.x - x[module.index];
      const current = primaryKey[module.index];
      if (current == null || Math.abs(offset) < Math.abs(current.offset)) {
        primaryKey[module.index] = {
          offset,
          key: module.index + ':' + module.flow + ':' + module.box.position.x
        };
      }
    });
    modules.forEach((module, moduleIndex) => {
      const { index, flow, title } = module;
      const y = module.box.position.y;
      const height = module.box.geometry.parameters.height;
      const px = module.box.position.x;
      const labelY = y + (px < x[index] || (px === x[index] && index % 2) ? -1 : 1) * (height / 2 + 1);
      add('box' + moduleIndex, '<span title="' + (flow < 0 ? '' : 'Flow ' + flow + ' · ') +
        title + '" data-module="' + moduleIndex + '">' + title + '</span>',
        'lbl-box op' + (flow < 0 ? '' : (flow ? ' f1' : ' f0')),
        [px, labelY + (px - x[index]) * 0.55, 0], 3);
      const key = index + ':' + flow + ':' + px;
      const item = list[list.length - 1];
      item.moduleStage = index;
      item.flow = flow;
      item.minor = !(primaryKey[index] && primaryKey[index].key === key);
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
    if (testMode) {
      add('testmode', 'tx_test_mode = 1 · Scrambled Idle', 'lbl-status ok',
        [x[1], BAND + 4, 0], 9);
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
    stateHost = document.createElement('div');
    stateHost.className = 'g1600-states';
    stateHost.setAttribute('role', 'status');
    stateHost.setAttribute('aria-label', 'PCS 与 PMA 状态变量');
    stateHost.addEventListener('click', () => {
      pause();
      get('popup-title').textContent = 'PCS / PMA 状态机';
      get('popup-note').textContent = '175.2.6、176.4.4 · 变量随 lane 选择、失锁、偏差与错误注入变化';
      get('popup-data').innerHTML = viewStates();
      lastPopup = { index: stage, flow: selectedFlow, lane: Number(get('lane').value), title: null, view: 'states' };
      if (!get('popup').open) get('popup').showModal();
    });
    hostAppend(stateHost);
    updateStates();
  }
  function updateStates() {
    if (!stateHost || !locks) return;
    const values = stateValues();
    const rows = [
      ['align_status', values.align_status],
      ['hi_ser', values.hi_ser],
      ['FEC_degraded_SER', values.FEC_degraded_SER],
      ['tx_am_sf', values.tx_am_sf],
      ['rx_am_sf', values.rx_am_sf],
      ['PMA align_status_mux', values.align_status_mux],
      ['PMA all_locked_demux', values.all_locked_demux]
    ].map(row => {
      const value = row[1];
      const text = typeof value === 'boolean' ? '' : '=' + value;
      const on = value === true || (typeof value === 'string' && value !== '' &&
        value !== '\u2014' && !/^0+$/.test(value));
      return '<span class="st' + (on ? ' on' : '') + '">' + row[0] + text + '</span>';
    }).join('');
    const html = '<b>状态变量</b>' + rows;
    if (stateHost.dataset.sig !== html) {
      stateHost.innerHTML = html;
      stateHost.dataset.sig = html;
    }
  }
  function hostAppend(node) {
    const host = get('scene');
    if (host) host.appendChild(node);
  }

  // ------------------------------------------------------------- draw data
  const curveSamples = 512;
  let laneSamples = [];
  let laneView = false;
  let dampingFrame = 0;
  const cubeMatrix = new T.Matrix4();
  const cubeRotation = new T.Quaternion();
  const cubeScale = new T.Vector3();
  const cubePosition = new T.Vector3();
  const cubeColor = new T.Color();

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

  function pushCube(position, sx, sy, sz, color, info) {
    if (count >= MAX_INST) return;
    cubeMatrix.compose(position, cubeRotation, cubeScale.set(sx, sy, sz));
    inst.setMatrixAt(count, cubeMatrix);
    inst.setColorAt(count, color);
    meta[count] = info;
    count++;
  }
  function drawSegment(from, to, y, z, color, flow, phase, amBoundary) {
    const front = (stage + progress) / STEP;
    const base = Math.floor(stageT(stage) / STEP_T);
    for (let i = 0; i < STREAM; i++) {
      const t = front - i * STEP_T;
      if (t < from) break;
      if (t > to) continue;
      const am = i < 4 && amBoundary !== undefined &&
        (amBoundary === 4 ? t >= stageT(amBoundary) : t < stageT(amBoundary));
      const px = x[0] + t * SPAN;
      const py = typeof y === 'function' ? y(t) : y;
      const c = am ? cubeColor.set(theme.am).lerp(color, 0.22) : color;
      pushCube(cubePosition.set(px, py, z), am ? 2.2 : 1.75, am ? 1.0 : 0.5,
        am ? 0.9 : 0.55, c, { seg: phase, flow, n: base - i, t });
    }
  }
  function drawLanes() {
    const front = (stage + progress) / STEP;
    const selected = Number(get('lane').value);
    const paper = new T.Color(theme.paper);
    const amColor = new T.Color(theme.am);
    for (let lane = 0; lane < 16; lane++) {
      const on = selected < 0 || selected === lane;
      for (let i = 0; i < STREAM; i++) {
        const t = front - i * STEP_T;
        if (t < stageT(6)) break;
        if (t > stageT(11)) continue;
        const pos = sampleLane(lane, (t - stageT(6)) / (stageT(11) - stageT(6)), cubePosition);
        const symbol = i % 136;
        const am = symbol < 12;
        const c = cubeColor.set(CODE_COLORS[symbol % 4]);
        if (!on) c.lerp(paper, 0.72);
        if (am) c.lerp(amColor, 0.8);
        const bad = Number(get('errors').value) > 15 && lane === selected && t > stageT(10);
        if (bad) c.set(theme.bad);
        pushCube(pos, am ? 2.0 : 1.4, am ? 0.44 : 0.34, am ? 0.39 : 0.31,
          c, { seg: 'lane', lane, flow: -1, n: symbol, t });
      }
    }
  }
  function draw() {
    if (!active || !renderer) return;
    const front = (stage + progress) / STEP;
    count = 0;
    const agg = new T.Color(theme.ink).lerp(new T.Color(theme.bg), 0.2);
    drawSegment(0, stageT(3), 0, 0, agg, 0, 'agg');
    for (let flow = 0; flow < 2; flow++) {
      const color = new T.Color(flow ? FLOW1 : FLOW0);
      drawSegment(stageT(3), stageT(6), t => flowTxY(flow, t), 0, color, flow, 'flow', 4);
      if (decoded[flow]) {
        drawSegment(stageT(11), stageT(13), t => flowRxY(flow, t), 0,
          new T.Color(flow ? FLOW1 : FLOW0), flow, 'flow', 12);
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
    if (stageBand) {
      stageBand.position.x = x[stage];
      stageBand.material.opacity = focusMode ? 0.16 : 0.06;
    }
    moduleMeshes.forEach(box => {
      const dim = focusMode && box.userData.stage !== stage;
      for (const material of box.material) {
        const glow = box.userData.stage === stage ? 0x26719a
          : testMode && box.userData.stage <= 7 ? 0x8a6a12 : 0x000000;
        material.emissive.setHex(glow);
        material.emissiveIntensity = 0.55;
        material.opacity = boxOpacity * (dim ? 0.3 : 1);
        material.depthWrite = false;
      }
      const edge = box.children[0];
      if (edge && edge.material) {
        edge.material.transparent = true;
        edge.material.opacity = (0.18 + 0.72 * expose) * (dim ? 0.5 : 1);
      }
    });
    tracks.forEach((line, lane) => {
      line.material.opacity = selected < 0 ? 0.55 : selected === lane ? 0.7 : 0.18;
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
    updateStates();
    updateBadge();
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
  function amFieldRowsHtml(octets) {
    let html = '';
    let octet = 0;
    AM_FIELDS.forEach(field => {
      const bits = octetBits(octets.slice(octet, octet + field.octets));
      octet += field.octets;
      html += '<div class="g800-b257-line">' +
        '<span class="g800-b257-label"><b>' + field.name + '</b>bit ' + field.from + '–' +
        (field.from + field.bits - 1) + ' · ' + field.bits + ' 位 · ' + field.note + '</span>' +
        '<div class="g800-b257-bits">' + bitRowFromBits(bits, -1, 0, false) + '</div></div>';
    });
    return html;
  }
  function amOctetsHtml(octets) {
    return octets.map((value, i) =>
      '<span class="g800-sym" title="' + AM_OCTET_NAMES[i] + '">' + AM_OCTET_NAMES[i] +
      '=0x' + byteHex(value) + '</span>').join('');
  }
  function viewAM(flow, block) {
    const lane = Math.max(0, Number(get('lane').value));
    const octets = AM_OCTET_NAMES.map((_, i) =>
      markers[lane].slice(8 * i, 8 * i + 8).reduce((value, bit, k) => value | (bit << k), 0));
    return '<div class="g800-inspect-summary"><span><b>Flow</b> ' + flow +
      '</span><span><b>AM 组</b> 1,028 位</span>' +
      '<span><b>组成</b> 16×120 + 133 pad + 3 状态 = 2,056 位</span>' +
      '<span><b>数据</b> 36×257 位</span></div>' +
      '<div class="g800-inspect-section"><h4>AM 组组成（175.2.4.6.1）</h4>' +
      '<div class="g800-sym-row">' +
      '<span class="g800-sym">16 条 lane × am_x&lt;119:0&gt; = 1,920 位</span>' +
      '<span class="g800-sym">PRBS9 pad 133 位</span>' +
      '<span class="g800-sym">状态字段 3 位</span>' +
      '<span class="g800-sym">合计 2,056 位 → A/B 1,028 + C/D 1,028</span></div></div>' +
      '<div class="g800-inspect-section"><h4>am_x&lt;119:0&gt; 字段（图 175-3，15 octets，每 octet LSB 先发）</h4>' +
      '<div class="g800-b257">' + amFieldRowsHtml(octets) + '</div>' +
      '<div class="g800-sym-row">' + amOctetsHtml(octets) + '</div>' +
      '<p class="g800-inspect-note">当前选中 PCS lane ' + lane +
      '；各 lane 的 CM/UM/UP 取值见 Table 175–2，此处展示所选 lane 的字段与发送位序。UM0–UM5 承载 lane 号，接收端据此重排；rx_am_sf&lt;2:0&gt; = am_rx&lt;1027:1025&gt;（仅 Flow 1）。</p></div>' +
      '<div class="g800-inspect-section"><h4>紧随 AM 的 257b 数据块</h4>' +
      '<div class="g800-b257">' + b257Html(flow, block, -1) + '</div></div>' +
      '<p class="g800-inspect-note">AM 在加扰后插入，不参与加扰；每 Flow 每 327,680 个 257b 块插入一次。带 AM 的组 = 1,028 位 AM + 36 个加扰数据块。三维场景按表 175-2 构造标记，按图 175-4 映射，状态字段演示值为 000。</p>';
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
  function viewSymbols(lane) {
    const bits = quartet(lane, 0).flatMap(n => range(10).map(k => (n >> k) & 1));
    const rows = range(3).map(j => {
      const cells = ['A', 'B', 'C', 'D'].map((label, word) => {
        const index = 543 - 16 * j - lane;
        return '<td><b>' + label + '</b><span>c' + label + '&lt;' + index +
          '&gt;</span><code>0x' + hex(codewords[word][index]) + '</code></td>';
      }).join('');
      return '<tr><th scope="row">j=' + j + '</th>' + cells + '</tr>';
    }).join('');
    return '<div class="g800-inspect-summary"><span><b>PCS lane</b> ' + lane +
      '</span><span><b>每 40 位</b> A,B,C,D 各一个 10 位符号</span>' +
      '<span><b>每套码字</b> 34×40 = 1,360 位</span></div>' +
      '<div class="g800-inspect-section"><h4>符号分配（175.2.4.9）</h4>' +
      '<p class="g800-inspect-note">pcsl_' + lane + '&lt;40j+39:40j&gt; ← cA/cB/cC/cD&lt;543−16j−' +
      lane + '&gt;，bit&lt;0&gt; 先发；同一 j 的 16 条 lane 并行取符号。</p>' +
      '<table class="g1600-mini"><thead><tr><th>j</th><th>A</th><th>B</th><th>C</th><th>D</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>' +
      '<div class="g800-inspect-section"><h4>pcsl_' + lane + '&lt;39:0&gt;（j = 0）</h4>' +
      '<div class="g800-b257-bits">' + bits.map((bit, i) =>
        '<span class="g800-bit' + (bit ? ' is-one' : '') + (i === 0 ? ' is-header' : '') +
        '" title="bit ' + i + (i === 0 ? ' · 首发位' : '') + '">' + bit + '</span>').join('') +
      '</div>' +
      '<div class="g800-sym-row">' + ['A', 'B', 'C', 'D'].map((label, word) =>
        '<span class="g800-sym">' + label + ' &lt;' + (10 * word) + '–' + (10 * word + 9) +
        '&gt;</span>').join('') + '</div></div>' +
      '<p class="g800-inspect-note">175.2.4.10：pcsl_i 经 inst:IS_UNITDATA_i.request 发送，bit&lt;0&gt; 为该 lane 的首发位。本实验的码字数组按 message/parity 存放，与 Annex 175A 向量逐符号比对时需按上式换算索引。</p>';
  }
  function viewPreFec(flow) {
    const stream = streams[flow];
    const rows = range(3).map(i => {
      const a = range(10).reduce((n, bit) => n | (stream[20 * i + bit] << bit), 0);
      const b = range(10).reduce((n, bit) => n | (stream[20 * i + 10 + bit] << bit), 0);
      return '<tr><th scope="row">i=' + i + '</th><td>m' + (flow ? 'C' : 'A') + '&lt;' + (513 - i) +
        '&gt;</td><td>0x' + hex(a) + '</td><td>' + (20 * i) + '–' + (20 * i + 9) + '</td><td>m' +
        (flow ? 'D' : 'B') + '&lt;' + (513 - i) + '&gt;</td><td>0x' + hex(b) + '</td><td>' +
        (20 * i + 10) + '–' + (20 * i + 19) + '</td></tr>';
    }).join('');
    return '<div class="g800-inspect-summary"><span><b>Flow</b> ' + flow +
      '</span><span><b>输入</b> 10,280 位</span><span><b>输出</b> 两条 514×10 位消息</span></div>' +
      '<div class="g800-inspect-section"><h4>10 位符号轮询分配（175.2.4.7）</h4>' +
      '<table class="g1600-mini"><thead><tr><th>i</th><th>消息</th><th>符号</th><th>来源位</th>' +
      '<th>消息</th><th>符号</th><th>来源位</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="g800-inspect-note">m' + (flow ? 'C' : 'A') + '&lt;513−i&gt; 取输入的第 20i…20i+9 位，m' +
      (flow ? 'D' : 'B') + '&lt;513−i&gt; 取第 20i+10…20i+19 位；513 为最先发送的符号，0 为最后发送。</p></div>';
  }
  function viewFecDecode(flow) {
    const labels = flow ? ['C', 'D'] : ['A', 'B'];
    const wordA = decodedWords[2 * flow], wordB = decodedWords[2 * flow + 1];
    const pairs = range(3).map(k => {
      const a = wordA ? wordA[543 - k] : null, b = wordB ? wordB[543 - k] : null;
      return '<tr><th scope="row">k=' + k + '</th><td>' + labels[0] + '&lt;' + (543 - k) + '&gt;</td><td>' +
        (a == null ? '—' : '0x' + hex(a)) + '</td><td>' + labels[1] + '&lt;' + (543 - k) + '&gt;</td><td>' +
        (b == null ? '—' : '0x' + hex(b)) + '</td></tr>';
    }).join('');
    return '<div class="g800-inspect-summary"><span><b>Flow</b> ' + flow +
      '</span><span><b>码字</b> ' + labels.join(' / ') + '</span>' +
      '<span><b>FEC</b> ' + (wordA && wordB ? '已纠正/正常' : '不可纠正') + '</span></div>' +
      '<div class="g800-inspect-section"><h4>去交织（175.2.5.2）</h4>' +
      '<p class="g800-inspect-note">按 lane 号重排后，把 16 条 lane 的 A,B,C,D 四元组按 10 位符号轮询拆回四条码字流，再逐条送入 RS 解码器。</p></div>' +
      '<div class="g800-inspect-section"><h4>RS 解码结果（175.2.5.3）</h4>' +
      '<table class="g1600-mini"><thead><tr><th>k</th><th>消息</th><th>符号</th><th>消息</th><th>符号</th></tr></thead>' +
      '<tbody>' + pairs + '</tbody></table>' +
      '<p class="g800-inspect-note">当前注入 ' + Number(get('errors').value) + ' 个符号错误：' +
      (Number(get('errors').value) > 15 ? '超出 15 个符号的纠错上限，判为不可纠正。'
        : '在 15 个符号的纠错能力内，输出已纠正的消息。') + '</p></div>';
  }
  function viewPostFec(flow) {
    const labels = flow ? ['C', 'D'] : ['A', 'B'];
    const wordA = decodedWords[2 * flow], wordB = decodedWords[2 * flow + 1];
    if (!wordA || !wordB) {
      return '<p>当前码字不可纠正，后交织输出无效：数据流在阶段 13 之后标红。</p>';
    }
    const rows = range(3).map(k => {
      const a = wordA[543 - k], b = wordB[543 - k];
      const bits = range(10).map(bit => (a >> bit) & 1)
        .concat(range(10).map(bit => (b >> bit) & 1));
      return '<div class="g800-b257-line"><span class="g800-b257-label"><b>轮次 ' + k + '</b>' +
        labels[0] + '&lt;' + (543 - k) + '&gt; 0x' + hex(a) + '<br>' + labels[1] + '&lt;' +
        (543 - k) + '&gt; 0x' + hex(b) + '</span>' +
        '<div class="g800-b257-bits">' + bitRowFromBits(bits, -1, 0, false) + '</div></div>';
    }).join('');
    return '<div class="g800-inspect-summary"><span><b>Flow</b> ' + flow +
      '</span><span><b>输出</b> rx_scrambled_am 40×257 位</span></div>' +
      '<div class="g800-inspect-section"><h4>两路消息按 10 位交替（175.2.5.4）</h4>' +
      '<div class="g800-b257">' + rows + '</div>' +
      '<p class="g800-inspect-note">' + labels[0] + '/' + labels[1] +
      ' 从最先发送的符号起按 10 位交替拼成 10,280 位，重组成 40 个 257b 块（rx_scrambled_am）后再进入 AM 移除。' +
      '上表每行为一轮：先取 ' + labels[0] + ' 的 10 位，再取 ' + labels[1] + ' 的 10 位，依次交错。</p></div>';
  }
  function viewPma(lane, index) {
    const q = quartet(lane, 0);
    const bits = q.flatMap(n => range(10).map(k => (n >> k) & 1));
    const pma = Math.floor(lane / 2);
    return '<div class="g800-inspect-summary"><span><b>PCS lane</b> ' + lane +
      '</span><span>Flow 0 · A/B ｜ Flow 1 · C/D</span>' +
      '<span><b>PMA lane</b> ' + pma + '</span>' +
      '<span><b>' + (index === 8 ? 'PAM4 通道' : '40 位四元组') + '</b></span></div>' +
      '<div class="g800-inspect-section"><h4>40 位符号四元组（4 × 10 位）</h4>' +
      '<div class="g800-sym-row">' + q.map((n, i) =>
        '<span class="g800-sym">' + 'ABCD'[i] + '=0x' + hex(n) + '</span>').join('') + '</div>' +
      '<div class="g800-bitrow">' + bitRowFromBits(bits, -1, 0, false) + '</div></div>' +
      (index === 8 ? '<div class="g800-inspect-section"><h4>PAM4 编解码（176.4.2.6 / 176.4.3.1）</h4>' +
        '<p class="g800-inspect-note">首个位对 ' + bits.slice(0, 2).join('') + ' → Gray 电平 ' +
        [0, 1, 3, 2][2 * bits[0] + bits[1]] + ' → 回读位对 ' +
        (locks.physical === 8 || !get('loss').checked ? bits.slice(0, 2).join('') : '按 lane 锁定状态判定') +
        '；每符号 10 位 = 5 个 PAM4 符号，40 位四元组 = 20 个 PAM4 符号。</p></div>' : '') +
      '<div class="g800-inspect-section"><h4>16:8 SM-PMA（176.4.2.5.2）</h4>' +
      '<p class="g800-inspect-note">PCS lane ' + (2 * pma) + ' 与 ' + (2 * pma + 1) +
      ' 的四元组交替送到 PMA lane ' + pma + '；输出 212.5 Gb/s（106.25 GBd）PAM4。相邻配对是本实验实例，标准允许任选两条 PCSL。</p></div>';
  }

  function precodingSequence(lane, enabled) {
    const bits = quartet(lane, 0).flatMap(symbol => range(10).map(i => (symbol >> i) & 1));
    const levels = range(bits.length / 2).map(i => [0, 1, 3, 2][2 * bits[2 * i] + bits[2 * i + 1]]);
    let previous = 0;
    const tx = levels.map(level => {
      previous = enabled ? (level - previous + 4) % 4 : level;
      return previous;
    });
    const rx = tx.map((level, i) => enabled ? (level + (tx[i - 1] ?? 0)) % 4 : level);
    return { levels, tx, rx };
  }

  function pmaPattern(flip) {
    let state = 0x7fffffff;
    const tx = range(64).map(() => {
      const bit = (state >>> 30) & 1;
      const feedback = ((state >>> 30) ^ (state >>> 27)) & 1;
      state = ((state << 1) | feedback) & 0x7fffffff;
      return bit;
    });
    const rx = tx.map((bit, i) => flip && i === 35 ? bit ^ 1 : bit);
    return { tx, rx, errors: rx.filter((bit, i) => bit !== tx[i]).length };
  }

  function renderPmaSample(kind, lane, enabled) {
    let text;
    if (kind === 'precoding') {
      const { levels, tx, rx } = precodingSequence(lane, enabled);
      text = ['Gray     ' + levels.join(' '), 'TX       ' + tx.join(' '), 'RX       ' + rx.join(' ')].join('\n');
    } else {
      const { tx, rx, errors } = pmaPattern(enabled);
      text = 'TX ' + tx.join('') + '\nRX ' + rx.join('') + '\n错误位数 ' + errors;
    }
    get('pma-sample').textContent = text;
  }
  function viewPcsRx(lane, index) {
    const chips = range(16).map(i =>
      '<span class="g800-sym' + (locks.lanes[i] ? ' is-parity' : '') + '">PCS ' + i +
      (locks.lanes[i] ? ' ✓' : ' ✗') + '</span>').join('');
    const rows = range(16).map(i => {
      const slot = rxSlot(i);
      return '<tr><th scope="row">' + i + '</th><td>' + slot + '</td><td>' +
        (slot === i ? '同序' : '跨 lane') + '</td><td>' +
        (locks.lanes[i] ? '✓' : '✗') + '</td></tr>';
    }).join('');
    return '<div class="g800-inspect-summary"><span><b>PCS AM</b> ' + locks.amCount + '/16</span>' +
      '<span><b>Skew</b> ' + locks.skew + ' / 152 ns</span>' +
      '<span><b>align_status</b> ' + locks.aligned + '</span>' +
      '<span><b>选中 lane</b> ' + lane + '</span></div>' +
      '<div class="g800-inspect-section"><h4>' + (index === 10 ? 'PCS 对齐锁定与 deskew（175.2.5.1）' : '解复用后的 PCSL AM 锁定（176.4.3.2.3）') + '</h4>' +
      '<div class="g800-sym-row">' + chips + '</div>' +
      '<p class="g800-inspect-note">接收端在每条 lane 上查找 AM；16 条全部锁定且 Skew ≤ 152 ns 时 align_status 为 true。取消某条物理 lane 的锁定会使其对应两条 PCS lane 失去 AM。</p></div>' +
      '<div class="g800-inspect-section"><h4>按 UM 重排（175.2.5.2）</h4>' +
      '<table class="g1600-mini"><thead><tr><th>PCS lane</th><th>RX PMA lane</th><th>关系</th><th>AM 锁定</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<p class="g800-inspect-note">lane 号由 AM 的 UM0–UM5 唯一确定；本实验采用 (5·lane+3) mod 16 的教学置换，标准允许接收 lane 任意排列。</p></div>';
  }
  function viewRateMatch(kind) {
    const tx = kind === 'tx';
    const chips = (items, cls) => items.map(text =>
      '<span class="g800-sym' + (cls ? ' ' + cls : '') + '">' + text + '</span>').join('');
    const before = tx
      ? ['数据 A', 'Idle', 'Idle', '数据 B']
      : ['数据 A', '数据 B'];
    const after = tx
      ? ['数据 A', '数据 B']
      : ['数据 A', 'Idle', '数据 B'];
    return '<p class="g800-inspect-note">' + (tx
      ? '175.2.4.2：补偿 AM 插入，按规则删除 Idle 控制字符或序列有序集；时钟域补偿还允许插入 Idle。'
      : '175.2.5.10：补偿 AM 移除，可插入 Idle；时钟域补偿按 119.2.3.5 与 119.2.3.8 的插删规则处理。') + '</p>' +
      '<div class="g800-inspect-section"><h4>调整前</h4><div class="g800-sym-row">' + chips(before, 'is-parity') + '</div></div>' +
      '<div class="g800-inspect-section"><h4>调整后</h4><div class="g800-sym-row">' + chips(after) + '</div></div>';
  }
  function stateValues() {
    const errors = Number(get('errors').value);
    return {
      align_status: locks.aligned,
      hi_ser: errors >= 16,
      FEC_degraded_SER: errors > 0 && errors < 16,
      tx_am_sf: '000',
      rx_am_sf: receivedAmStatus ?? '—',
      align_status_mux: true,
      all_locked_demux: locks.physical === 8 && locks.amCount === 16
    };
  }
  function viewStates() {
    const values = stateValues();
    const rows = [
      ['PCS', 'align_status', '175.2.6：16 条 lane 已完成对齐锁定与 deskew'],
      ['PCS', 'hi_ser', '175.2.5.3：连续码字块中检测到的符号错误超门限'],
      ['PCS', 'FEC_degraded_SER', '175.2.5.3：符号错误率高于降级门限但仍在纠错能力内'],
      ['PCS', 'tx_am_sf', '发送 AM 状态字段（教学：选中物理 lane 失锁时置位）'],
      ['PCS', 'rx_am_sf', 'am_rx<1027:1025>，仅 Flow 1；16 条 lane 未全锁时置位'],
      ['PMA', 'align_status_mux', '176.4.4：TX 复用器输入已对齐，本例预先对齐'],
      ['PMA', 'all_locked_demux', '176.4.4：解复用后 16 条 PCSL 全部取得 AM 锁定']
    ].map(row => '<tr><th scope="row">' + row[0] + '</th><td>' + row[1] + '</td><td>' +
      (values[row[1]] ? 'true' : 'false') + '</td><td>' + row[2] + '</td></tr>').join('');
    return '<div class="g800-inspect-summary"><span><b>PCS</b> align_status=' + values.align_status +
      '</span><span><b>PMA</b> align_status_mux=' + values.align_status_mux + '</span></div>' +
      '<div class="g800-inspect-section"><h4>状态变量（175.2.6 / 176.4.4）</h4>' +
      '<table class="g1600-mini"><thead><tr><th>层</th><th>变量</th><th>当前值</th><th>判定依据</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<p class="g800-inspect-note">本实验把「错误符号数」映射为 hi_ser / FEC_degraded_SER：1–15 个符号错误判为降级，≥16 个判为 hi_ser；失锁与偏差驱动 align_status 和 PMA 状态。标准的状态迁移与计数器门限见 175.2.6、176.4.4。</p></div>';
  }
  function viewTestPattern() {
    if (!testMode) return '<p>已恢复正常业务数据。可在 PCS lane 模块中查看更新后的四元组。</p>';
    return '<p class="g800-inspect-note">175.2.4.11：tx_test_mode = 1 时，PCS 输出等同于 1.6TMII 持续输入 idle 控制字符时的结果（scrambled idle test pattern）。</p>' +
      '<div class="g800-inspect-section"><h4>测试图样路径</h4>' +
      '<div class="g800-sym-row">' + ['全 Idle', '64B/66B 控制块', '257b 转码', '双 Flow 加扰',
        'AM + RS-FEC', '16 PCS lane', '16:8 PMA', '8×PAM4'].map(text =>
        '<span class="g800-sym">' + text + '</span>').join('') + '</div></div>' +
      '<div class="g800-inspect-section"><h4>测试图样首块（示意）</h4>' +
      '<div class="g800-b257-bits">' + bitRowFromBits(streams[0].slice(1028, 1094), -1, 0, false) + '</div>' +
      '<p>PCS lane 0 · A/B/C/D = ' + quartet(0, 0).map(n => hex(n)).join(' / ') +
      '。Idle 转码使用教学样本，随后实际执行加扰、RS 编码和 lane 分发。</p>' +
      '<p class="g800-inspect-note">启用后发送链模块以琥珀色高亮，图中其余阶段仍可点击查看；再次点击按钮退出测试模式。</p></div>';
  }
  function viewBytes(flow, block, pos) {
    if (testMode) return '<p>当前输入为 Scrambled Idle 测试序列，1.6TMII 显示 Idle 控制字符而无业务字节。</p>';
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
    if (index === 6) return 'symbols';
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
      symbols: '符号分配', pma: 'PMA 四元组', rx: 'PCS lane 锁定 / 重排', bytes: '8 字节'
    }[kind] || '';
    get('popup-title').textContent = (title || steps[index][0]) + ' · ' + label;
    get('popup-note').textContent = steps[index][1] + ' · ' + steps[index][2];
    let body;
    if (title === 'TX 速率匹配') body = viewRateMatch('tx');
    else if (title === 'RX 速率匹配') body = viewRateMatch('rx');
    else if (title === 'FEC 前分配') body = viewPreFec(flow);
    else if (title === 'FEC 后交织') body = viewPostFec(flow);
    else if (title === '去交织' || title === 'RS 解码') body = viewFecDecode(flow);
    else if (title === 'RS 编码') body = viewFEC(flow, 0);
    else if (title === 'AM 移除') {
      const pair = decodedWords.slice(2 * flow, 2 * flow + 2);
      const bits = pair.every(Boolean) && range(514).flatMap(i => pair.flatMap(word =>
        range(10).map(bit => (word[543 - i] >> bit) & 1))).slice(1028, 1285);
      body = bits ? '<p>移除 1,028 位 AM 后的首个加扰 257b 块</p><div class="g800-bitrow">' +
        bitRowFromBits(bits, -1, 0, false) + '</div>' : '<p>接收输出不可用。</p>';
    }
    else if (kind === 'b66') body = view66(flow, 0, 0);
    else if (kind === 'b257' && index >= 12) {
      const streams = index === 13 ? [receivedBlock(0, 0), receivedBlock(1, 0)] : [receivedBlock(flow, 0)];
      body = streams.every(Boolean) ? streams.map((bits, i) =>
        '<p>Flow ' + (index === 13 ? i : flow) + ' · 首个恢复的 257b 块</p><div class="g800-bitrow">' +
        bitRowFromBits(bits, -1, 0, false) + '</div>').join('') : '<p>接收输出不可用。</p>';
    } else if (kind === 'b257') body = view257(flow, 0, steps[index][2]);
    else if (kind === 'am') body = viewAM(flow, 0);
    else if (kind === 'fec') body = viewFEC(flow, 0);
    else if (kind === 'symbols') body = viewSymbols(lane);
    else if (kind === 'pma') body = viewPma(lane, index);
    else if (kind === 'rx') body = viewPcsRx(lane, index);
    else body = viewBytes(flow, 0, 0);
    const moduleNotes = {
      'TX AM 锁定': '176.4.2.2 · 教学输入已提供AM 边界。',
      '40 位对齐': '176.4.2.3.3 · 各 PCS lane 对齐到相对于 AM 起点的 40 位边界。',
      '四元组锁定': '176.4.3.2.2 · 用AM 样本搜寻起点。可改变选中物理 lane 的起始符号偏移，再观察锁定结果。',
      'PCSL AM 锁定': '176.4.3.2.3 · 在解复用得到的 PCS lane 上识别AM。',
      '按 UM 重排': '175.2.5.2 · PCS 按 AM 的 UM 识别 lane 号。教学模型按收到的UM 字段识别并恢复顺序。',
      'FEC 前分配': '175.2.4.7 · 每流把 10 位符号依次交替送入两条消息。',
      'FEC 后交织': '175.2.5.4 · 每流依次交替取纠错后的两条消息各一个 10 位符号。',
      'AM 移除': '175.2.5.5 · 从纠错并后交织的数据移除开头 1,028 位 AM，余下位进入解扰。'
    };
    if (moduleNotes[title]) body = '<p>' + moduleNotes[title] + '</p>' + body;
    if (title === '预编码/逆预编码') {
      body = '<p>176.7.1.2 · 适用于连接 KR、CR、DR、FRn-500 PMD 的接口，或 AUI C2C/C2M 链路。' +
        '适用输出 lane 须具备预编码能力，输入 lane 的逆预编码能力可选，逐 lane 独立使能。</p>' +
        '<p>选中 PCS lane 的首个四元组提供位对。TX 按模 4 减去前一输出，RX 加上前一接收电平。此开关作用于当前示例。</p>' +
        '<label><input id="g1600-pma-sample-toggle" type="checkbox">启用预编码与逆预编码</label><pre id="g1600-pma-sample"></pre>';
    }
    if (title === '图样发生器' || title === '图样检测器') {
      body = '<p>176.7.4.1 · PRBS31 发生器将图样送往接口，对端检测器比较接收位。下方展示同种子同步的 64 位样本。</p>' +
        '<label><input id="g1600-pma-sample-toggle" type="checkbox">翻转一个接收位</label><pre id="g1600-pma-sample"></pre>';
    }
    if (title === '本地环回') body = '<p>176.7.2 · MAC 侧 TX → 本地 PMA 环回 → MAC 侧 RX。TX 同时继续向链路发送。</p>';
    if (title === '远端环回') body = '<p>176.7.3 · 介质侧 RX → 远端 PMA 环回 → 介质侧 TX。RX 同时继续向 MAC 交付。</p>';
    if (['图样发生器', '图样检测器', '本地环回', '远端环回'].includes(title)) {
      get('popup-title').textContent = title;
      get('popup-note').textContent = 'PMA 测试与环回支路';
    }
    get('popup-data').innerHTML = body;
    const toggle = get('pma-sample-toggle');
    if (toggle) {
      const kind = title === '预编码/逆预编码' ? 'precoding' : 'pattern';
      toggle.onchange = () => renderPmaSample(kind, lane, toggle.checked);
      toggle.onchange();
    }
    lastPopup = { index, flow, lane, title };
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
    if (!locks.aligned || !decoded[0] || !decoded[1]) {
      return 'PCS align_status 为 false 或码字不可纠正，RX 1.6TMII 输出无效：逆转码与解码不交付数据，数据流在阶段 13 之后标红。';
    }
    return '逆转码与 64B/66B 解码后，通过 1.6TMII 交付 8 字节。';
  }
  function select(index, frame) {
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
    if (focusMode && frame && camera) focusStageCamera(stage);
    if (get('popup').open) {
      if (lastPopup && lastPopup.view === 'states') {
        get('popup-data').innerHTML = viewStates();
      } else {
        showPopup(stage, selectedFlow, Number(get('lane').value),
          lastPopup && lastPopup.index === stage ? lastPopup.title : null);
      }
    }
  }

  function openModule({ stage: index, flow, title }) {
    pause();
    if (flow >= 0) selectedFlow = flow;
    select(index, true);
    showPopup(index, selectedFlow, Number(get('lane').value), title);
  }

  // ----------------------------------------------------------------- controls
  const stepButtons = steps.map(([name], index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = (index + 1) + ' · ' + name;
    button.onclick = () => { pause(); select(index, true); };
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
  get('step').onclick = () => { pause(); select((stage + 1) % steps.length, true); };
  get('reset').onclick = () => {
    pause();
    get('lane').value = -1;
    get('errors').value = '0';
    get('skew').value = '0';
    get('phase').value = '0';
    get('loss').checked = false;
    get('test-pattern').setAttribute('aria-pressed', 'false');
    testMode = false;
    buildTransmit();
    selectedFlow = 0;
    decode();
    select(0);
    setFocusMode(false);
  };
  focusBtn = get('focus');
  if (focusBtn) focusBtn.onclick = () => setFocusMode(!focusMode);
  get('loss').onchange = get('phase').onchange = get('skew').onchange =
    get('errors').onchange = get('lane').onchange = () => {
    decode();
    select(stage);
  };
  get('test-pattern').onclick = () => {
    pause();
    testMode = !testMode;
    buildTransmit();
    decode();
    select(stage);
    get('test-pattern').setAttribute('aria-pressed', testMode ? 'true' : 'false');
    get('popup-title').textContent = 'Scrambled Idle 测试模式';
    get('popup-note').textContent = '175.2.4.11 · tx_test_mode = ' + (testMode ? '1' : '0');
    get('popup-data').innerHTML = viewTestPattern();
    lastPopup = { index: stage, flow: selectedFlow, lane: Number(get('lane').value), title: null };
    if (!get('popup').open) get('popup').showModal();
    if (renderer && active) {
      buildLabels();
      draw();
    }
  };
  get('pma-tests').onclick = () => {
    pause();
    get('popup-title').textContent = 'PMA 测试与环回';
    get('popup-note').textContent = 'IEEE P802.3dj/D2.0 · 176.7.2–4';
    get('popup-data').innerHTML =
      '<h4>测试图样</h4><p>图样发生器 → 实例化接口 → 对端图样检测器。根据 AUI、Inner FEC 或 PMD 接口选择适用图样。</p>' +
      '<h4>本地环回（可选）</h4><p>MAC 侧 TX → PMA → MAC 侧 RX。正常 TX 继续向下发送。</p>' +
      '<h4>远端环回（可选）</h4><p>介质侧 RX → PMA → 介质侧 TX。正常 RX 继续向 MAC 交付。</p>';
    if (!get('popup').open) get('popup').showModal();
  };
  get('camera').onclick = () => resetCamera();
  get('lane-camera').onclick = () => resetCamera(true);
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
        camTween = null;
        zoomAnchor = null;
        zoomAnchorAt = 0;
      });
      controls.addEventListener('end', () => {
        if (!dampingFrame) dampingFrame = requestAnimationFrame(settleCamera);
      });
      controls.addEventListener('change', () => draw());
      renderer.domElement.addEventListener('wheel', wheelZoom, { passive: false, capture: true });

      inst = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1),
        new T.MeshBasicMaterial({ color: 0xffffff }), MAX_INST);
      inst.renderOrder = 2;
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
        const hit = event.target.closest('.lbl-box.op')?.querySelector('[data-module]');
        if (hit) openModule(modules[Number(hit.dataset.module)].box.userData);
      });
      host.appendChild(labelHost);
      initOverlay();
      buildLink();
      buildStageBand();
      buildFlowArrows();
      buildStageBadge(host);
      renderer.domElement.addEventListener('dblclick', () => focusStageCamera(stage));
      renderer.domElement.addEventListener('pointermove', event => {
        const rect = renderer.domElement.getBoundingClientRect();
        const ray = new T.Raycaster();
        ray.setFromCamera(new T.Vector2(
          (event.clientX - rect.left) / rect.width * 2 - 1,
          1 - (event.clientY - rect.top) / rect.height * 2), camera);
        const hit = ray.intersectObjects(moduleMeshes, false)[0];
        const nextStage = hit ? hit.object.userData.stage : -1;
        const nextFlow = hit ? (hit.object.userData.flow ?? -1) : -1;
        if (nextStage !== hoverStage || nextFlow !== hoverFlow) {
          hoverStage = nextStage;
          hoverFlow = nextFlow;
          labelItems.forEach(item => { item.w = 0; });
          buildLabels();
          updateLabels();
        }
        renderer.domElement.style.cursor = hit ? 'pointer' : '';
      });
      renderer.domElement.addEventListener('pointerleave', () => {
        if (hoverStage < 0) return;
        hoverStage = -1;
        hoverFlow = -1;
        labelItems.forEach(item => { item.w = 0; });
        buildLabels();
        updateLabels();
      });
      new ResizeObserver(resize).observe(host);
      window.addEventListener('resize', resize);
      resize();
      resetCamera(true);
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
        const module = ray.intersectObjects(moduleMeshes, false)[0];
        if (module) {
          openModule(module.object.userData);
          return;
        }
        const packet = ray.intersectObject(inst)[0];
        if (packet && packet.instanceId != null) {
          const info = meta[packet.instanceId];
          if (info) {
            if (info.seg === 'lane') get('lane').value = info.lane;
            if (info.flow >= 0) selectedFlow = info.flow;
            decode();
            pause();
            select(stageAtPath(info.t), true);
            showPopup(stage, selectedFlow, Number(get('lane').value));
            return;
          }
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
    if (!cameraTouched && !laneView) fitCameraMin();
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
