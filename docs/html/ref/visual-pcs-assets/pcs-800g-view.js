(function () {
  'use strict';
  const M = window.PCS800Model, T = window.THREE;
  const byId = id => document.getElementById(id);
  const get = key => byId('g800-' + key);
  const value = key => +get(key).value;
  const tabs = ['200g', '800g'].map(rate => byId('tab-' + rate));
  const panels = ['200g', '800g'].map(rate => byId('lab-' + rate));
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const stages = [
    ['800GMII', 'MAC 提交一条 800 Gb/s 数据流。'],
    ['64B/66B 编码', '示例每 8 字节数据加上数据同步头 01，形成一个 66 位块。'],
    ['66b 分流', '偶数块进入 Flow 0，奇数块进入 Flow 1。标准要求逐块交替分配。'],
    ['256B/257B 转码', '每个 Flow 将四个纯数据 66 位块转码成一个 257 位块。'],
    ['加扰', '每个 Flow 单独运行自同步加扰器，采用 x⁵⁸ + x³⁹ + 1。建议两个 Flow 使用不同初值。'],
    ['AM / FEC', '每 Flow 插入 AM 组（8 × 257 位），再进行 FEC 前分配并生成 A、B 两个 RS(544,514) 码字。标准 AM 周期为 163,840 个 257 位块。'],
    ['32 PCS lane', 'Flow 0 使用 PCS lane 0–15，Flow 1 使用 16–31；每条 lane 26.5625 Gb/s。'],
    ['32:8 PMA', '每条物理通道按 Flow 0、Flow 0、Flow 1、Flow 1 的顺序复用四个 PCS 比特；接收方向为不受限比特复用。'],
    ['8 路 PAM4', '8 条物理通道各为 106.25 Gb/s，PAM4 符号率 53.125 GBd。每条承载四条 PCS lane；若经过 8:8 PMA，映射还须保持 PAM4 Gray 符号序列或仅交换位对。'],
    ['RX 解复用', 'RX PMA 恢复 32 路。起始槽相位可改变接收端 lane 顺序，PCS 依靠 AM 识别真实编号。'],
    ['锁定 / Deskew', 'PCS 通过 AM 的公共部分锁定，并用专用部分识别 lane ID。全部 32 条 lane 满足锁定及 152 ns Skew 预算后按 ID 重排。'],
    ['RX FEC / 移除 AM', '两个 Flow 分别解交织、解码、移除 AM。RS(544,514) 每码字最多纠正 15 个错误符号。'],
    ['解扰', '每个 Flow 按相同多项式，用接收的加扰位恢复原始 257 位块。'],
    ['257b 逆转码', '恢复每个 Flow 的四个 66 位块及各自同步头。'],
    ['66b 合流', '按 Flow 0、Flow 1 交替收集 66 位块，与发送端的分流互逆。'],
    ['64B/66B 解码', '由 66 位纯数据块读取同步头，并还原 8 字节。'],
    ['RX MAC', '接收端通过 800GMII 交付恢复的数据。']
  ];
  // Box names shown in the scene. The flow stages are duplicated for Flow 0/1.
  const modules = [
    [0, 0, 8, 'TX MAC'], [1, 0, 8, '64B/66B'], [2, 0, 24, '66b 分流'],
    [3, 10.8, 10, '257b 转码', 0], [4, 10.8, 10, '加扰', 0],
    [5, 10.8, 10, 'AM / FEC', 0], [6, 10.8, 10, '16 lane', 0],
    [7, 0, 27, '32:8 PMA'], [8, 0, 27, '8× PAM4'], [9, 0, 27, 'RX 解复用'],
    [10, 0, 27, 'AM / Deskew'],
    [11, -10.8, 10, 'RX FEC', 1], [12, -10.8, 10, '解扰', 1], [13, -10.8, 10, '逆转码', 1],
    [14, 0, 8, '66b 合流'], [15, 0, 8, '64B/66B 解码'], [16, 0, 8, 'RX MAC']
  ];
  const x = stages.map((_, i) => (i - (stages.length - 1) / 2) * 9.5);
  const SPAN = x[x.length - 1] - x[0];
  const ST = { lanes: 6, mux: 7, link: 8, demux: 9, align: 10, fec: 11, rx: 16 };
  const BAND = 16, FLOW_Y = 10.8, STEP_T = 1 / 56, STREAM = 40;
  const original = M.range(8);
  const flows = M.distribute(original);
  let stage = 14, progress = 0, recovery = 2;
  let active = false, playing = false, pending = 0, last = 0;
  let renderer, scene, camera, controls, resize;
  let inst, meta = [], count = 0;
  let tracks = [], curves = [], highlight = null, rings = [], bars = [], sheaths = [];
  let flowLines = [], aggLines = [];
  let buttons = [], tx = [], rx = [], lanes = [];
  let fault = { physical: 0, skew: 0, lane: 0, loss: false, am: false };
  let state, fecResults = [], words;
  let transportFailed = false;
  let linkGroup, theme = {};
  let labelHost, labelItems = [];
  let lastHostBackground = '';
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
    const spread = flow ? -(6.3 + row * 0.34) : (6.3 + row * 0.34);
    const physicalY = (3.5 - physical) * 2.55;
    const rxSpread = (15.5 - receiveSlot) * 0.84;
    const branch = flow ? -FLOW_Y : FLOW_Y;
    const y = [0, 0, branch, branch, branch, branch, spread, physicalY, physicalY,
      rxSpread, spread, branch, branch, branch, 0, 0, 0][index];
    let z = 0;
    if (index === 6) z = (row % 4 - 1.5) * 0.4 + (flow ? 0.12 : -0.12);
    else if (index === 7 || index === 8) z = (row % 2 - 0.5) * 0.62 + (flow ? 0.28 : -0.28);
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

  function resetCamera() {
    if (!camera) return;
    const host = get('scene');
    const aspect = Math.max(0.8, (host.clientWidth || 16) / (host.clientHeight || 9));
    const dist = frameNeed(aspect);
    camera.position.set(dist * 0.05, dist * 0.21, dist * 0.975);
    controls.target.set(0, 0, 0);
    controls.update();
    draw();
  }

  function addModule(index, y, height, title, color, flow = -1) {
    const width = 7.6;
    const geometry = new T.BoxGeometry(width, height, 5.4);
    const material = SHADES.map(shade =>
      new T.MeshLambertMaterial({ color: color.clone().multiplyScalar(shade) }));
    const box = new T.Mesh(geometry, material);
    box.position.set(x[index], y, -4.3);
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
      modules.forEach(([index, y, height, title, f]) => {
        if (f === flow) addModule(index, y, height, title, color, flow);
      });
    });
    modules.forEach(([index, y, height, title, f]) => {
      if (f == null) addModule(index, y, height, title, colors.neutral);
    });
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
      const line = new T.Line(new T.BufferGeometry().setFromPoints(
        samplePath(curve, stageT(ST.lanes), stageT(ST.fec), 100)),
      new T.LineBasicMaterial({
        color: flowColor(lane), transparent: true, opacity: tracked < 0 || tracked === lane ? 0.42 : 0.09
      }));
      line.frustumCulled = false;
      linkGroup.add(line);
      tracks[lane] = line;

      if (lane === tracked) {
        const laneCurve = new T.CatmullRomCurve3(
          samplePath(curve, stageT(ST.lanes), stageT(ST.fec), 80));
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
      controls.minDistance = 70;
      controls.maxDistance = 520;
      controls.maxPolarAngle = 1.52;
      controls.addEventListener('change', draw);
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      host.prepend(canvas);

      inst = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1),
        new T.MeshBasicMaterial({ color: 0xffffff }), 1600);
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
        if (hit) setStage(+hit.dataset.stage);
      });
      host.appendChild(labelHost);

      resize = () => {
        if (!active || !host.clientWidth || !host.clientHeight) return;
        camera.aspect = host.clientWidth / host.clientHeight;
        camera.updateProjectionMatrix();
        fitCameraMin();
        renderer.setSize(host.clientWidth, host.clientHeight, false);
        draw();
        updateLabels();
      };
      new ResizeObserver(resize).observe(host);
      window.addEventListener('resize', resize);
      resize();
      resetCamera();
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => { labelItems.forEach(item => { item.w = 0; }); draw(); });
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
            if (info.seg === 'lane') {
              get('lane').value = info.lane;
              get('flow').value = info.lane < 16 ? 0 : 1;
            } else {
              get('lane').value = -1;
              get('flow').value = info.flow;
            }
            refresh();
            showData();
            return;
          }
        }
        const moduleHit = ray.intersectObjects(moduleMeshes.map(module => module.box))[0];
        if (moduleHit) {
          const info = moduleHit.object.userData;
          if (info.flow >= 0) {
            get('flow').value = info.flow;
            if (value('lane') >= 0 && Math.floor(value('lane') / 16) !== info.flow) get('lane').value = -1;
          }
          setStage(info.stage);
          showData();
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

  function pushCube(position, sx, sy, sz, color, info) {
    if (count >= 1600) return;
    const matrix = new T.Matrix4();
    matrix.compose(position, new T.Quaternion(), new T.Vector3(sx, sy, sz));
    inst.setMatrixAt(count, matrix);
    inst.setColorAt(count, color);
    meta[count] = info;
    count++;
  }

  function drawStreamSegment(from, to, y, z, color, info, flow) {
    const front = motion.matches ? stageT(stage) : stageT(stage) + progress / (stages.length - 1);
    const base = Math.floor(front / STEP_T);
    for (let i = 0; i < STREAM; i++) {
      const t = front - i * STEP_T;
      if (t < from) break;
      if (t > to) continue;
      const am = (base - i) % 5 === 0;
      const px = x[0] + t * SPAN;
      const pos = new T.Vector3(px, typeof y === 'function' ? y(t) : y, z);
      const c = am ? new T.Color(theme.am).lerp(color, 0.22) : color.clone();
      pushCube(pos, am ? 2.2 : 1.75, am ? 1.0 : 0.5, am ? 0.9 : 0.55,
        c, { seg: info, flow });
    }
  }

  function drawLaneStream(lane, flow, color, front) {
    const base = Math.floor(front / STEP_T);
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
      const am = (base - i) % 5 === 0;
      if (!state.aligned && t > stageT(ST.align) && !(corruptAm && am)) continue;
      const pos = curves[lane].getPointAt(Math.max(0, Math.min(1, t)));
      let c = on ? color.clone() : color.clone().lerp(new T.Color(theme.paper), 0.8);
      if (am) c = new T.Color(theme.am).lerp(color, 0.2);
      if (corruptAm && am && t > stageT(ST.demux)) c = new T.Color(theme.bad);
      if (fecError && t > stageT(10.4)) c = new T.Color(theme.bad);
      pushCube(pos, am ? 2.1 : 1.55, am ? 0.95 : 0.44, am ? 0.85 : 0.5,
        c, { seg: 'lane', lane, flow });
    }
  }

  function draw() {
    if (!active || !renderer || !state) return;
    const hostBackground = getComputedStyle(get('scene')).backgroundColor;
    if (hostBackground !== lastHostBackground) {
      lastHostBackground = hostBackground;
      readTheme();
      recolorModules();
      rebuildTracks();
    }
    if (scene.background.getStyle() !== hostBackground) scene.background.set(hostBackground);
    const filter = value('flow'), tracked = value('lane');
    const front = motion.matches ? stageT(stage) : stageT(stage) + progress / (stages.length - 1);
    const aligned = state.aligned;
    const bothFec = fecResults.every(result => result && result.valid);
    count = 0;

    // One aggregate 800GMII stream at each end.
    drawStreamSegment(0, stageT(2), 0, 0,
      new T.Color(theme.ink).lerp(new T.Color(theme.bg), 0.2),
      'agg', 0);
    if (aligned && bothFec) {
      drawStreamSegment(stageT(14), 1, 0, 0,
        new T.Color(theme.ink).lerp(new T.Color(theme.bg), 0.2),
        'agg', 1);
    }

    // Two independent Flow streams on either side of the 32-lane section.
    for (let flow = 0; flow < 2; flow++) {
      const color = dimColor(flowColor(flow * 16), filter < 0 || filter === flow);
      drawStreamSegment(stageT(2), stageT(ST.lanes), t => flowTxY(flow, t), 0,
        color, 'flow', flow);
      if (aligned && fecResults[flow] && fecResults[flow].valid) {
        const rxColor = flow === filter || filter < 0 ? flowColor(flow * 16) : dimColor(flowColor(flow * 16), false);
        drawStreamSegment(stageT(ST.fec), stageT(14), t => flowRxY(flow, t), 0,
          rxColor, 'flow', flow);
      }
    }

    // The 32 PCS lanes only exist between symbol distribution and FEC.
    for (let lane = 0; lane < 32; lane++) {
      if (filter >= 0 && lane < flowStart(filter)) continue;
      if (filter >= 0 && lane >= flowStart(filter) + 16) continue;
      drawLaneStream(lane, lane < 16 ? 0 : 1, flowColor(lane), front);
    }

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
    moduleMeshes.forEach(({ box, index }) => {
      for (const material of box.material) {
        material.emissive.setHex(index === stage ? 0x26719a : 0x000000);
        material.emissiveIntensity = 0.55;
      }
    });
    renderer.render(scene, camera);
    updateLabels();
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

    modules.forEach(([index, y, height, title, flow]) => {
      // Alternate labels above and below the boxes: at 17 stages the
      // horizontal pitch is narrow, so a single row would overlap.
      const labelY = index === 16
        ? y + height / 2 + 12.5
        : index % 2 ? y - height / 2 - 0.95 : y + height / 2 + 0.95;
      const labelX = index === 0 ? x[index] + 6 : index === 16 ? x[index] - 12 : x[index];
      add('box' + index, '<span data-stage="' + index + '">' +
        (flow >= 0 ? 'F' + flow + ' ' : '') + title + '</span>',
      'lbl-box op', [labelX, labelY, 0], 3,
      index === 0 ? 'l' : index === 16 ? 'r' : 'c');
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
    progress += Math.min(0.1, (now - (last || now)) / 1000) * value('speed') / 0.85;
    last = now;
    if (progress >= 1) {
      progress = 0;
      advance();
    } else draw();
    pending = requestAnimationFrame(tick);
  }

  function diagnostics() {
    const n = state.locked.filter(Boolean).length;
    const lock = state.aligned ? '已对齐' : '未对齐';
    const fec = fecResults.map((result, i) => 'F' + i + ' ' + (!state.aligned ? '等待对齐' :
      result.corrected ? '纠正 ' + result.errors + ' 个符号' : result.valid ? '正常' : '不可纠正'));
    get('diagnostics').textContent = lock + ' · AM 锁定 ' + n + '/32 · Skew ' + fault.skew +
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

  function payload() {
    return get('payload').value.replace(/[^ -~]/g, '') || 'Visual PCS 800G ';
  }

  function inspectData(flow) {
    const detail = get('data');
    detail.hidden = ![0, 1, 3, 4, 12, 13, 15, 16].includes(stage);
    if (detail.hidden) return;
    const sample = M.sample(flow, payload());
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

  function showData() {
    setPlaying(false);
    const tracked = value('lane');
    const lane = tracked < 0 ? Math.max(0, value('flow')) * 16 : tracked;
    const id = M.symbolAt(lane, 0);
    const symbol = words[id.flow][id.word][id.index];
    const bits = M.range(10).map(i => (symbol >> i) & 1).join('');
    get('popup-title').textContent = (stage + 1) + ' · ' + stages[stage][0];
    get('popup-mapping').textContent = get('inspect').textContent;
    const decoded = stage >= ST.fec;
    let data = '发送侧示例 · F' + id.flow + '-' + ['A', 'B'][id.word] + ' 符号 #' + id.index +
      ' · 位 0 → 9：' + bits + ' · 0x' + symbol.toString(16).padStart(3, '0').toUpperCase();
    if (decoded && (!state.aligned || !fecResults[id.flow].valid)) data += '\n接收数据不可用。';
    if (!get('data').hidden) data += '\n\n' + get('bits').textContent;
    get('popup-bits').textContent = data;
    if (!get('popup').open) get('popup').showModal();
  }

  function updateState() {
    state = M.alignment(tx, fault, recovery);
    diagnostics();
    describeStage();
    buildLabels();
    draw();
  }

  function refresh(reacquire) {
    fault = faultInput();
    if (reacquire) recovery = 0;
    tx = M.mapping(get('mapping').value);
    rx = M.receiveMap(tx, value('phase'));
    lanes = [];
    tx.forEach((row, physical) => row.forEach(lane => { lanes[lane] = physical; }));
    if (!words) words = M.codewords(window.PCS, payload());
    fecResults = M.receive(window.PCS, words, rx, value('errors'), fault.lane);
    get('skew-value').textContent = fault.skew + ' ns';
    rebuildTracks();
    updateState();
  }

  function setStage(index) {
    setPlaying(false);
    stage = index;
    progress = 0;
    if (index === ST.align) recovery = 2;
    updateState();
  }

  function advance() {
    stage = (stage + 1) % stages.length;
    if (stage === ST.align) recovery = 2;
    updateState();
  }

  function openTab(index, historyMode) {
    const entering = index === 1;
    if (entering !== active) {
      if (entering) {
        if (window.PCS.setPlaying) window.PCS.setPlaying(false);
        window.PCS.state.stepTo = null;
      } else setPlaying(false);
    }
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    });
    active = entering;
    if (entering) {
      setupScene();
      refresh();
      if (resize) resize();
    }
    if (historyMode && location.hash !== (entering ? '#lab-800g' : '#lab')) {
      history.pushState(null, '', entering ? '#lab-800g' : '#lab');
    }
  }

  function syncHash() { openTab(location.hash === '#lab-800g' ? 1 : 0, false); }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => openTab(i, true));
    tab.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      tabs[e.key === 'Home' ? 0 : e.key === 'End' ? 1 : 1 - i].focus();
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
  get('step').onclick = () => { setPlaying(false); progress = 0; advance(); };
  get('reset').onclick = () => {
    setPlaying(false);
    stage = progress = recovery = 0;
    ['flow', 'lane', 'mapping', 'phase', 'physical', 'skew', 'speed', 'errors'].forEach(key => {
      const control = get(key);
      if (control.tagName === 'SELECT') control.selectedIndex = key === 'speed' ? 1 : 0;
      else control.value = 0;
    });
    get('loss').checked = get('am').checked = false;
    refresh();
    resetCamera();
  };
  get('camera').onclick = resetCamera;
  get('open-data').onclick = showData;
  get('payload').onchange = () => { words = null; refresh(); };
  ['mapping', 'phase', 'physical', 'loss', 'am', 'lane', 'flow', 'errors'].forEach(key => {
    get(key).onchange = () => refresh(['mapping', 'phase', 'physical', 'loss', 'am'].includes(key) ||
      (key === 'lane' && get('am').checked));
  });
  get('skew').oninput = () => refresh();
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

  syncHash();
})();
