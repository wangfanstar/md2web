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
    ['800GMII', '64B/66B 编码产生单一 66 位块流，MAC 速率为 800 Gb/s。'],
    ['分流', '偶数块进入 Flow 0，奇数块进入 Flow 1。每组四块转码为 257 位块，两个 Flow 独立加扰。'],
    ['AM / FEC', '两个 Flow 在对应的原始块边界插入各自的 8 × 257 位 AM 组，每 Flow 的标准周期为 163,840 个 257 位块。每个 Flow 独立生成 A、B 两个 RS(544,514) 码字。'],
    ['32 PCS lane', '每 Flow 将两个码字的符号分布到 16 条 PCS lane。Flow 0 使用 0–15，Flow 1 使用 16–31。'],
    ['32:8 PMA', '每条物理通道按 Flow 0、Flow 0、Flow 1、Flow 1 的顺序复用四个 PCS 比特。相邻两位组成 PAM4 位对。'],
    ['8 路 PAM4', '8 条物理通道各为 106.25 Gb/s。通道时延或信号丢失影响它承载的四条 PCS lane。'],
    ['RX 解复用', 'RX PMA 恢复 32 路。起始槽相位可改变接收端服务接口上的 lane 顺序。'],
    ['锁定 / Deskew', 'PCS 通过 AM 找到 lane ID。全部 32 条 lane 锁定并满足 152 ns Skew 预算后，按 ID 重排。'],
    ['RX FEC', '重排后分回两个 Flow，分别解交织、解码、移除 AM、解扰并逆转码。'],
    ['800GMII', '按 Flow 0、Flow 1 交替收集 66 位块，64B/66B 解码后交给接收 MAC。']
  ];
  const x = [-63, -49, -35, -21, -7, 7, 21, 35, 49, 63];
  const original = M.range(8);
  const flows = M.distribute(original);
  let selected = -1, stage = 0, progress = 0, recovery = 0;
  let active = false, playing = false, pending = 0, last = 0;
  let renderer, scene, camera, controls, resize;
  let packets = [], paths = [], buttons = [], tx, rx, lanes, fault, state, fecResults, words;
  let transportFailed = false;
  const modules = [];

  function faultInput() {
    return {
      physical: value('physical'), skew: value('skew'), lane: Math.max(0, value('lane')),
      loss: get('loss').checked, am: get('am').checked
    };
  }

  function route(lane, index) {
    const flow = Math.floor(lane / 16);
    const physical = lanes[lane];
    const row = lane % 16;
    const spread = (flow ? -1 : 1) * (5 + row * .37);
    const receiveSlot = rx.indexOf(lane);
    const rxSpread = (15.5 - receiveSlot) * .56;
    const y = [0, flow ? -7 : 7, flow ? -7 : 7, spread,
      (3.5 - physical) * 1.65, (3.5 - physical) * 1.65, rxSpread, spread, flow ? -7 : 7, 0];
    const delayed = physical === fault.physical && index === 6 ? fault.skew * .042 : 0;
    return new T.Vector3(x[index] - delayed, y[index], (row % 4 - 1.5) * .48);
  }

  function flowColor(i) {
    return new T.Color(i < 16 ? '#268ec7' : '#d97139').multiplyScalar(.77 + (i % 16) / 44);
  }

  function resetCamera() {
    if (!camera) return;
    camera.position.set(0, 25, 95);
    controls.target.set(0, 0, 0);
    controls.update();
    resize();
  }

  function addModule(index, y, height, title, color, width = 11) {
    const geometry = new T.BoxGeometry(width, height, 3.2);
    const material = new T.MeshLambertMaterial({ color });
    const box = new T.Mesh(geometry, material);
    box.position.set(x[index], y, -3);
    box.add(new T.LineSegments(new T.EdgesGeometry(geometry),
      new T.LineBasicMaterial({ color: 0x536576 })));
    box.userData.stage = index;
    scene.add(box);

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#14283c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 65px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, 256, 67, 472);
    const label = new T.Sprite(new T.SpriteMaterial({
      map: new T.CanvasTexture(canvas), depthTest: false
    }));
    label.scale.set(width, width / 4, 1);
    label.position.set(x[index], y + height / 2 + 1.9, .9);
    scene.add(label);
    modules.push({ box, index });
  }

  function addModules() {
    scene.add(new T.HemisphereLight(0xffffff, 0x8291a8, 1.1));
    const light = new T.DirectionalLight(0xffffff, .55);
    light.position.set(-15, 25, 40);
    scene.add(light);

    const neutral = 0x9dafc1;
    addModule(0, 0, 5, 'TX MAC', neutral);
    addModule(1, 0, 15, '66b 分流', neutral);
    [0x80bedf, 0xe8a984].forEach((color, flow) => {
      const y = flow ? -7 : 7;
      addModule(2, y, 5.5, 'F' + flow + ' AM / FEC', color);
      addModule(3, flow ? -8 : 8, 7, 'F' + flow + ' · 16 lane', color);
      addModule(8, y, 5.5, 'F' + flow + ' 解码', color);
    });
    addModule(4, 0, 15, '32:8 PMA', neutral);
    addModule(5, 0, 14, '8 路 PAM4', 0x8bbab4);
    addModule(6, 0, 19, 'RX 解复用', neutral);
    addModule(7, 0, 22, 'AM / Deskew', neutral);
    addModule(9, 0, 5, 'RX MAC', neutral);
  }

  function setupScene() {
    if (renderer || transportFailed) return;
    const host = get('scene');
    let canvas;
    try {
      renderer = new T.WebGLRenderer({ antialias: true });
      canvas = renderer.domElement;
      scene = new T.Scene();
      const grid = new T.GridHelper(136, 34, 0x667889, 0x667889);
      grid.position.y = -12;
      grid.scale.z = .16;
      grid.material.transparent = true;
      grid.material.opacity = .22;
      scene.add(grid);
      addModules();
      camera = new T.PerspectiveCamera(36, 1, .1, 500);
      controls = new T.OrbitControls(camera, canvas);
      controls.enablePan = true;
      controls.addEventListener('change', draw);
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      host.prepend(canvas);
      const box = new T.BoxGeometry(1.9, .55, .85);
      packets = M.range(32).map(i => {
        const mesh = new T.Mesh(box, new T.MeshBasicMaterial({ color: flowColor(i) }));
        mesh.userData.lane = i;
        scene.add(mesh);
        return mesh;
      });
      paths = M.range(32).map(i => {
        const geometry = new T.BufferGeometry();
        geometry.setAttribute('position', new T.BufferAttribute(new Float32Array(stages.length * 3), 3));
        const line = new T.Line(geometry, new T.LineBasicMaterial({
          color: flowColor(i), transparent: true, opacity: .37
        }));
        line.frustumCulled = false;
        scene.add(line);
        return line;
      });
      resize = () => {
        if (!active || !host.clientWidth) return;
        camera.aspect = host.clientWidth / host.clientHeight;
        camera.fov = Math.max(36, 2 * Math.atan(.76 / camera.aspect) * 180 / Math.PI);
        camera.updateProjectionMatrix();
        renderer.setSize(host.clientWidth, host.clientHeight, false);
        draw();
      };
      new ResizeObserver(resize).observe(host);
      resetCamera();
      let pointer;
      canvas.addEventListener('pointerdown', e => { pointer = [e.clientX, e.clientY]; });
      canvas.addEventListener('click', e => {
        if (!pointer || Math.hypot(e.clientX - pointer[0], e.clientY - pointer[1]) > 5) return;
        const r = canvas.getBoundingClientRect();
        const ray = new T.Raycaster();
        ray.setFromCamera(new T.Vector2((e.clientX - r.left) / r.width * 2 - 1, 1 - (e.clientY - r.top) / r.height * 2), camera);
        const hit = ray.intersectObjects(packets.filter(p => p.visible))[0];
        if (hit) {
          get('lane').value = hit.object.userData.lane;
          refresh();
        } else {
          const moduleHit = ray.intersectObjects(modules.map(module => module.box))[0];
          if (moduleHit) buttons[moduleHit.object.userData.stage].click();
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

  function draw() {
    if (!active || !renderer || !state) return;
    scene.background = new T.Color(getComputedStyle(get('scene')).backgroundColor);
    const filter = value('flow'), tracked = value('lane');
    const next = Math.min(stage + 1, stages.length - 1);
    packets.forEach((mesh, i) => {
      const laneFlow = Math.floor(i / 16);
      const blocked = stage >= 5 && fault.loss && lanes[i] === fault.physical;
      const gated = stage >= 8 && (!state.aligned || !fecResults[laneFlow].valid);
      const shown = (filter < 0 || laneFlow === filter) && (tracked < 0 || i === tracked);
      paths[i].material.opacity = shown ? .48 : .07;
      mesh.visible = shown && !blocked && !gated;
      const t = motion.matches ? 0 : progress;
      mesh.position.copy(route(i, stage)).lerp(route(i, next), t);
      const corruptAM = fault.am && i === fault.lane && stage >= 6 && stage <= 7;
      mesh.material.color.copy(corruptAM ? new T.Color('#c9313e') : flowColor(i));
    });
    modules.forEach(({ box, index }) => {
      box.material.emissive.setHex(index === stage ? 0x26719a : 0x000000);
      box.material.emissiveIntensity = .55;
    });
    renderer.render(scene, camera);
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
    progress += Math.min(.1, (now - (last || now)) / 1000) * value('speed') / .85;
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
    const fec = fecResults.map((r, i) => 'F' + i + ' ' + (!state.aligned ? '等待对齐' :
      r.corrected ? '纠正 ' + r.errors + ' 个符号' : r.valid ? '正常' : '不可纠正'));
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

  function describeStage() {
    buttons.forEach((b, i) => b.setAttribute('aria-current', i === stage ? 'step' : 'false'));
    get('stage-title').textContent = stages[stage][0];
    get('stage-note').textContent = stages[stage][1];
    const track = value('lane');
    const i = track < 0 ? Math.max(0, value('flow')) * 16 : track;
    const flow = Math.floor(i / 16);
    let detail = 'PCS lane ' + i + ' · Flow ' + flow + ' · 原始块 ' + flows[flow].join(', ') +
      ' · PAM4 通道 ' + lanes[i] + ' / TX 槽 ' + tx[lanes[i]].indexOf(i) + ' · RX PMA lane ' + rx.indexOf(i);
    const symbol = M.symbolAt(i, 0);
    detail += ' · F' + symbol.flow + '-' + ['A', 'B'][symbol.word] + ' 符号 #' + symbol.index;
    if (stage === 4 || stage === 5) {
      const td = tx[lanes[i]];
      const pair = M.pam4Pair(words, tx, lanes[i], 0, 0, Math.floor(td.indexOf(i) / 2));
      detail += ' · 位 0：lane ' + pair.ids.join(' / ') + ' → ' + pair.bits.join('') + ' → PAM4 电平 ' + pair.level;
    }
    if (stage === 9) {
      detail += state.aligned && fecResults.every(r => r.valid)
        ? ' · 收集顺序 ' + M.collect(flows).join(', ') : ' · 接收输出标记为错误';
    }
    get('inspect').textContent = detail;
  }

  function updateState() {
    state = M.alignment(tx, fault, recovery);
    diagnostics();
    describeStage();
    draw();
  }

  function refresh(reacquire) {
    fault = faultInput();
    if (reacquire) recovery = 0;
    tx = M.mapping(get('mapping').value);
    rx = M.receiveMap(tx, value('phase'));
    lanes = [];
    tx.forEach((row, physical) => row.forEach(lane => { lanes[lane] = physical; }));
    if (!words) words = M.codewords(window.PCS);
    fecResults = M.receive(window.PCS, words, rx, value('errors'), fault.lane);
    paths.forEach((line, lane) => {
      const p = line.geometry.attributes.position;
      stages.forEach((_, i) => {
        const v = route(lane, i);
        p.setXYZ(i, v.x, v.y, v.z);
      });
      p.needsUpdate = true;
    });
    get('skew-value').textContent = fault.skew + ' ns';
    updateState();
  }

  function advance() {
    stage = (stage + 1) % stages.length;
    if (stage === 7) recovery = Math.min(2, recovery + 1);
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
  document.querySelectorAll('.showme').forEach(b => b.addEventListener('click', () => openTab(0, active), true));
  function fillOptions(key, count, label) {
    M.range(count).forEach(i => get(key).add(new Option(label + i, i)));
  }
  fillOptions('physical', 8, '通道 ');
  fillOptions('lane', 32, 'PCS lane ');
  buttons = stages.map(([title], i) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.type = 'button';
    b.textContent = title;
    b.onclick = () => {
      setPlaying(false);
      stage = i;
      progress = 0;
      if (i === 7) recovery = Math.min(2, recovery + 1);
      updateState();
    };
    get('stages').append(b);
    return b;
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
  ['mapping', 'phase', 'physical', 'loss', 'am', 'lane', 'flow', 'errors'].forEach(key => {
    get(key).onchange = () => refresh(['mapping', 'phase', 'physical', 'loss', 'am'].includes(key) ||
      (key === 'lane' && get('am').checked));
  });
  get('skew').oninput = () => refresh();
  document.addEventListener('visibilitychange', () => { if (document.hidden) setPlaying(false); });
  syncHash();
})();
