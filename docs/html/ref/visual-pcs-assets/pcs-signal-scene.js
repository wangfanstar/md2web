(function (P, T) {
  'use strict';

  const get = id => document.getElementById('pcs-signal-' + id);
  const picker = get('mode'), controls = get('controls');
  const viewport = document.getElementById('viewport');
  const play = controls.querySelector('[data-signal-play]');
  const stages = controls.querySelector('[data-signal-steps]');
  const bytesPanel = controls.querySelector('[data-signal-bytes]');
  const formatDialog = document.getElementById('pcs-fault-format');
  const formatHeading = document.getElementById('pcs-fault-format-title');
  const formatBody = document.getElementById('pcs-fault-format-body');
  const labels = document.createElement('div');
  labels.className = 'pcs-signal-labels';
  labels.hidden = true;
  viewport.append(labels);

  // Node indices follow A RS, A PHY, B PHY, B RS from left to right.
  const scenarios = {
    fault: {
      reference: 'IEEE 802.3 · 46.3.4、表 46–5 和图 46–11。示例假设 A → B 故障，B → A 可用。LF 在本地 PHY 与 RS 之间上报，RF 由 RS 发往对端，均沿 IEEE RS / PCS 信令路径。200GMII 有序集与 PCS 块格式见 117、119.2.3 和图 82–5。',
      nodes: ['A · RS', 'A · PCS / PHY', 'B · PCS / PHY', 'B · RS'],
      steps: [
        ['检测故障', 'RX 故障', 1, 2, 'A → B 接收路径异常。B 的 PHY 检测失锁等故障。'],
        ['本地上报', 'Local Fault', 2, 3, 'B 的 PHY 经本地 200GMII 向 B 的 RS 上报 Local Fault。'],
        ['生成并发回 RF', 'Remote Fault', 3, 0, 'B 的 RS 确认 LF 后停发 MAC 数据，产生 RF。反向 TX PCS 编码并经链路送至 A。'],
        ['A 解码并确认 RF', 'RF 解码', 1, 0, 'A 的 RX PCS 恢复对齐并解码控制块，经本地 200GMII 将 Remote Fault 上报给 A 的 RS。'],
        ['对端响应', 'Idle', 0, 1, 'A 的 RS 确认 RF 后停止发送 MAC 数据并持续送 Idle。故障清除后，双方按 RS 状态机恢复。']
      ]
    },
    eee: {
      reference: 'IEEE 802.3 · 第 78 条、119.2.3.3 及适用 PHY 条款。示例假设两端已协商 EEE，展示一个方向及逻辑 LPI 状态。具体物理省电动作和唤醒时序取决于 PHY。',
      nodes: ['A · MAC / RS', 'A · PCS / PHY', 'B · PCS / PHY', 'B · RS / MAC'],
      steps: [
        ['请求 LPI', 'LPI 请求', 0, 1, 'A 暂无待发帧，MAC / RS 通过 200GMII 向本端 PHY 请求 Low Power Idle。'],
        ['进入 LPI', '进入 LPI', 1, 2, 'A 的 PCS / PHY 按适用 PHY 的 EEE 规则发送 LPI 信号。B 的 PHY 检测进入省电状态。'],
        ['接收端指示', 'LPI 指示', 2, 3, 'B 的 PHY 在 200GMII 侧指示接收 LPI。A → B 暂停用户数据，该方向维持 LPI。'],
        ['请求唤醒', '撤销 LPI', 0, 1, 'A 有新帧待发，撤销 LPI 请求。先完成唤醒流程，再发送新帧。'],
        ['唤醒对端', 'Wake', 1, 2, 'A 的 PHY 执行唤醒；B 的 PHY 恢复正常接收所需的功能。'],
        ['恢复传输', '恢复正常', 2, 3, 'B 的 PHY 退出接收 LPI 指示。满足适用 PHY 的唤醒要求后，A → B 恢复正常帧传输。']
      ]
    }
  };

  let mode = 'data', index = 0, playing = false, start = null;
  let scene, camera, nodes, token, faultToken, formatMarkers = [], formatSample;
  // Fault responses use the existing 200G drawing. The right-to-left route
  // represents the reverse link and its corresponding TX/RX PCS functions.
  const faultPositions = [[57, 108], [109, 116], [116, 7], [7, 0], [0, 9]];
  const faultBytes = [
    null,
    { value: '01', title: 'B · PHY → RS（200GMII RX）', note: '本地 xMII 上报，触发本端 RS 的故障状态机。' },
    { value: '02', title: 'B · RS → TX PCS（200GMII TX）', type: '4B',
      note: '64B/66B → 256B/257B → 加扰 → AM / RS-FEC → PCS lane / PMA。反向箭头表示 B → A；线上位流已重新编码。点击各模块上方的数据块，可沿图中的逻辑 TX → RX 顺序对照反向链路的格式。' },
    { value: '02', title: 'A · RX PCS → RS（200GMII RX）', type: '4B',
      note: 'RX PMA → AM 锁定与重排 → RS-FEC → AM 移除 → 解扰 → 逆转码 → 64B/66B 解码。恢复 /Q/ 并将 RXC[0] 置 1。' },
    { value: '07', title: 'A · RS → TX PCS（200GMII TX）', type: '1E', idle: true,
      note: 'RS 持续发送 Idle。八个 /I/ 形成全控制块。' }
  ];

  function renderFaultBytes() {
    const sample = faultBytes[index];
    if (!sample) {
      bytesPanel.textContent = '故障检测阶段尚未生成有序集。下一步查看 PHY 输出的 Local Fault。';
      return;
    }
    bytesPanel.innerHTML = faultOctets(sample);
  }

  function faultOctets(sample) {
    const bytes = sample.idle ? Array(8).fill('07') : ['9C', '00', '00', sample.value, '00', '00', '00', '00'];
    return '<h4>' + sample.title + '</h4><div class="pcs-rx-bytes">' + bytes.map((byte, lane) =>
      '<span>' + byte + '<small>Lane ' + lane + ' · C=' + Number(sample.idle || lane === 0) + '</small></span>').join('') + '</div>' +
      '<p>' + (sample.idle ? '控制掩码 0xFF' : '控制掩码 0x01 · 9C = /Q/ · Lane 4–7 为零数据') +
      (sample.type ? ' · 66b 同步头 10 · Block Type 0x' + sample.type + (sample.idle
        ? ' · 8 × 7 位 Idle 码 0x00'
        : ' · D1/D2/D3 = 00/00/02 · O-code 0x0 · 余位为零') : '') +
      '</p><p class="note">' + sample.note + '</p>';
  }
  const formats = {
    lfMii: ['Local Fault 本地上报', '200GMII', ''],
    b66: ['66b 编码', '66b', '同步头和 64 位控制载荷'],
    idleTx: ['TX 速率匹配', '66b', '样例保留故障有序集。只有满足规则的控制字符或有序集才可用于速率补偿。'],
    b257: ['256B/257B 转码', '257b', '四个同类控制块组合。首位及四个块类别位为 00000，首个块类型省去第二个半字节。'],
    scr: ['加扰', '加扰 257b', 'x⁵⁸ + x³⁹ + 1，使用固定教学初态。'],
    am: ['AM 插入', 'AM + 加扰块', '示例在码字对开头插入 1,028 位 AM。填充沿用 200G 主动画的教学值。'],
    prefec: ['FEC 前分配', 'A / B 消息', '连续 10 位依次分到 A、B，每条消息含 514 个符号。'],
    rs: ['RS 编码', 'A / B 码字', '每个码字有 514 个消息符号和 30 个校验符号。'],
    dist: ['符号分配', 'PCS lane', '按 PCS 的符号分配规则，将 A/B 码字符号分到 8 条 PCS lane。'],
    mux: ['TX PMA', '物理位流', '按当前 PMA 映射把多条 PCS lane 逐位复用。'],
    demux: ['RX PMA', 'PCS lane', '从物理位流恢复候选 PCS lane，AM 用于确定通道身份。'],
    lock: ['AM 锁定', 'PCS lane', '以 AM 的公共字段取得锁定。'],
    deskew: ['Deskew', 'PCS lane', '对齐各 lane 的 AM 边界。'],
    reorder: ['通道重排', 'PCS lane', '用 AM 的唯一字段确定 lane 编号。'],
    deint: ['去交织', 'A / B 码字', '按 lane 和符号索引重建码字。'],
    rsdec: ['RS 解码', 'A / B 消息', '本样例在可用方向无额外误码。解码输出 514 个消息符号。'],
    postfec: ['FEC 后交织', 'AM + 加扰块', '将 A/B 的 10 位消息符号交替还原成串行位流。'],
    amr: ['移除 AM', '加扰 257b', '移除 1,028 位 AM 组，保留后续加扰 257b 块。'],
    descr: ['解扰', '257b', '用连续接收的加扰位恢复转码块。'],
    r257: ['257b 逆转码', '66b', '恢复原来的四个控制块。'],
    d66: ['64B/66B 解码', '200GMII', '恢复 xMII 的八个字节与控制掩码。'],
    idleRx: ['RX 速率匹配', '200GMII', '按规则补偿 AM 移除；故障状态由 RS 识别。']
  };

  function bitArray(value, width) {
    return Array.from({ length: width }, (_, i) => (value >> i) & 1);
  }

  function buildFaultSample(idle) {
    const type = idle ? 0x1e : 0x4b;
    const payload = [type, 0, 0, idle ? 0 : 2, 0, 0, 0, 0].flatMap(value => bitArray(value, 8));
    const xcoded = [0, 0, 0, 0, 0].concat(payload.slice(0, 4), payload.slice(8), payload, payload, payload);
    const scrambled = window.PCS800Model.scramble(Array.from({length: 36}, () => xcoded).flat(), 0);
    const am = Array.from({length: P.AM_BITS}, (_, i) => P.pairBit(0, i).v);
    const stream = am.concat(scrambled);
    const messages = [0, 1].map(w => Array.from({length: 514}, (_, i) =>
      stream.slice(20 * i + 10 * w, 20 * i + 10 * w + 10).reduce((v, bit, k) => v | (bit << k), 0)));
    const words = messages.map(message => message.concat(P.rsParity(message)));
    return { type, payload, xcoded, scrambled, am, messages, words };
  }

  function formatMarkup(key) {
    const [, kind, note] = formats[key];
    const f = formatSample;
    const bitText = bits => bits.join('').match(/.{1,8}/g).join(' ');
    const wordText = values => values.map(n => n.toString(16).toUpperCase().padStart(3, '0')).join(' ');
    let value;
    if (kind === '66b') value = '10 | ' + bitText(f.payload);
    else if (kind === '257b') value = bitText(f.xcoded);
    else if (kind === '加扰 257b') value = bitText(f.scrambled.slice(0, 257));
    else if (kind === 'AM + 加扰块') value = 'AM[0…39] ' + bitText(f.am.slice(0, 40)) +
      ' | 加扰块[0…63] ' + bitText(f.scrambled.slice(0, 64));
    else if (kind.endsWith('消息') || kind.endsWith('码字')) {
      const words = kind.endsWith('消息') ? f.messages : f.words;
      value = words.map((word, i) => ['A', 'B'][i] + '[0…7] ' + wordText(word.slice(0, 8)) +
        (kind.endsWith('码字') ? ' | 校验[0…3] ' + wordText(word.slice(514, 518)) : '')).join('\n');
    } else if (kind === 'PCS lane' || kind === '物理位流') {
      const lanes = kind === 'PCS lane' ? [0] : P.lanesOnSerdes(P.state.link, 0);
      const ids = lanes.map(lane => typeof lane === 'number' ? lane : lane.pcs);
      const symbols = ids.map(lane => {
        const id = P.laneSymbolId(lane, 12);
        return bitArray(f.words[id.w][id.i], 10);
      });
      value = kind === 'PCS lane' ? 'PCS lane 0 · 符号 12 · ' + bitText(symbols[0])
        : 'SerDes 0 · PCS ' + ids.join(' / ') + ' · ' +
          bitText(Array.from({length: 10}, (_, i) => symbols.map(bits => bits[i])).flat());
    } else if (key === 'lfMii') return bytesPanel.innerHTML;
    else return faultOctets({
      value: '02', idle: f.type === 0x1e,
      title: f.type === 0x1e ? 'Idle · 200GMII 解码格式（参考）' : 'A · RX PCS → RS（Remote Fault）',
      note: note + ' 以下显示 PCS 交付给 RS 的逻辑接口格式。'
    });
    return '<p>' + note + '</p><p class="note">位串按发送顺序，10 位符号值以十六进制显示。</p>' +
      '<pre class="pcs-fault-bits">' + value + '</pre>';
  }

  function syncFormatMarkers() {
    const G = P.g;
    if (!G.scene) return;
    formatMarkers.forEach(marker => {
      G.scene.remove(marker);
      marker.geometry.dispose();
      marker.material.dispose();
    });
    formatMarkers = [];
    if (mode !== 'fault' || index === 0) return;
    if (index >= 2) formatSample = buildFaultSample(index === 4);
    G.boxes.forEach(box => {
      const key = index === 1 ? (box.def.name === 'B · RS' ? 'lfMii' : '')
        : box.def.view || ({ '加扰': 'scr', '解扰': 'descr' })[box.def.name];
      if (!formats[key] || (index === 4 && box.mesh.position.x > P.sceneX(57))) return;
      const kind = formats[key][1];
      const wide = kind.includes('257') || kind.includes('AM');
      const color = kind.includes('A / B') ? G.col.cwA : kind === 'PCS lane' ? G.col.lanes[1] : G.col.am;
      const marker = new T.Mesh(new T.BoxGeometry(wide ? 1.85 : 1.2, 0.64, 0.85),
        new T.MeshBasicMaterial({ color }));
      marker.position.copy(box.mesh.position);
      marker.position.y += box.h / 2 + 0.55;
      marker.userData.format = key;
      G.scene.add(marker);
      marker.updateMatrixWorld(true);
      formatMarkers.push(marker);
    });
  }

  function openFaultFormat(key) {
    if (mode !== 'fault') return;
    playing = false;
    renderStep();
    formatHeading.textContent = (key ? formats[key][0] : scenarios.fault.steps[index][1]) + ' · 数据格式';
    formatBody.innerHTML = key ? formatMarkup(key) : bytesPanel.innerHTML;
    if (!formatDialog.open) formatDialog.showModal();
  }

  const duration = 2050;
  const x = i => (i - 1.5) * 4;

  function buildScene() {
    labels.classList.add('is-projected');
    scene = new T.Scene();
    camera = new T.PerspectiveCamera(35, 1, 0.1, 160);
    scene.add(new T.HemisphereLight(0xffffff, 0x8793ab, 2));
    nodes = Array.from({ length: 4 }, (_, i) => {
      const mesh = new T.Mesh(new T.BoxGeometry(2.45, 1.35, 1.2), new T.MeshStandardMaterial());
      mesh.position.x = x(i);
      scene.add(mesh);
      return mesh;
    });
    const rail = new T.Mesh(new T.BoxGeometry(12, 0.075, 0.075), new T.MeshBasicMaterial({ color: 0x8090a8 }));
    scene.add(rail);
    token = new T.Mesh(new T.SphereGeometry(0.3, 16, 12), new T.MeshBasicMaterial());
    token.position.y = 1.1;
    scene.add(token);
  }

  function renderStep() {
    const scenario = scenarios[mode], step = scenario.steps[index];
    labels.querySelector('[data-signal-token]').textContent = step[1];
    controls.querySelector('[data-signal-detail]').textContent = step[4];
    Array.from(stages.querySelectorAll('button')).forEach((button, i) =>
      button.setAttribute('aria-current', i === index ? 'step' : 'false'));
    play.textContent = playing ? '暂停' : '播放';
    if (mode === 'fault') renderFaultBytes();
  }

  function select(next) {
    index = next;
    start = null;
    renderStep();
    syncFormatMarkers();
  }

  picker.onchange = function () {
    mode = picker.value;
    playing = false;
    viewport.classList.toggle('pcs-signaling', mode === 'eee');
    viewport.classList.toggle('pcs-fault-scene', mode === 'fault');
    viewport.closest('#lab-200g').classList.toggle('pcs-signal-mode', mode === 'eee');
    labels.hidden = controls.hidden = mode === 'data';
    bytesPanel.hidden = mode !== 'fault';
    labels.classList.toggle('is-projected', mode === 'eee' && Boolean(scene));
    if (P.g.inst) P.g.inst.visible = mode !== 'fault';
    if (faultToken) faultToken.visible = mode === 'fault';
    if (P.syncSceneOverlays) P.syncSceneOverlays();
    if (!P.g.failed && P.g.camera) {
      P.buildBoxes();
      P.buildLabels();
      if (mode !== 'eee') P.flyTo(P.framePose(-2, 118, 0.35), 0);
    }
    if (mode !== 'fault') syncFormatMarkers();
    if (mode === 'data') return;
    P.setPlaying(false);
    if (P.closeInspector) P.closeInspector();
    const scenario = scenarios[mode];
    labels.replaceChildren(...(mode === 'eee' ? scenario.nodes : []).map(name => {
      const label = document.createElement('span');
      label.textContent = name;
      return label;
    }));
    const badge = document.createElement(mode === 'fault' ? 'button' : 'strong');
    badge.dataset.signalToken = '';
    if (mode === 'fault') {
      badge.type = 'button';
      badge.title = '查看信号数据格式';
      badge.onclick = () => openFaultFormat();
    }
    labels.append(badge);
    stages.replaceChildren(...scenario.steps.map(([title], i) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.textContent = (i + 1) + ' · ' + title;
      button.onclick = () => { playing = false; select(i); };
      item.append(button);
      return item;
    }));
    controls.querySelector('[data-signal-source]').textContent = scenario.reference;
    select(0);
  };

  play.onclick = () => {
    playing = !playing;
    if (playing && elapsed >= duration && index === scenarios[mode].steps.length - 1) select(0);
    else renderStep();
  };
  controls.querySelector('[data-signal-next]').onclick = () => {
    playing = false;
    select((index + 1) % scenarios[mode].steps.length);
  };
  controls.querySelector('[data-signal-reset]').onclick = () => { playing = false; select(0); };

  P.isFaultScene = () => mode === 'fault';
  const ray = new T.Raycaster(), pointer = new T.Vector2();
  P.hitFaultSignal = function (sx, sy) {
    const G = P.g;
    if (mode !== 'fault' || !faultToken || !faultToken.visible || !G.w || !G.h) return false;
    pointer.set(2 * sx / G.w - 1, 1 - 2 * sy / G.h);
    ray.setFromCamera(pointer, G.camera);
    return ray.intersectObjects([faultToken, ...formatMarkers], false)[0]?.object || null;
  };
  P.pickFaultSignal = function (sx, sy) {
    const hit = P.hitFaultSignal(sx, sy);
    if (!hit) return false;
    openFaultFormat(hit.userData.format);
    return true;
  };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let elapsed = 0;
  P.renderSignalScene = function (now, visible) {
    if (mode === 'data') return false;
    const G = P.g;
    if (!visible) { if (playing) start = null; return true; }
    if (start === null) { start = now; elapsed = 0; }
    if (playing) {
      elapsed = now - start;
      if (elapsed >= duration) {
        if (index + 1 === scenarios[mode].steps.length) { playing = false; elapsed = duration; renderStep(); }
        else { select(index + 1); start = now; elapsed = 0; }
      }
    } else start = now - elapsed;

    if (!G.renderer || G.failed) return true;
    const fraction = reduced.matches || (elapsed === 0 && !playing) ? 1 : Math.min(1, elapsed / (duration * 0.72));
    if (mode === 'fault') {
      if (!faultToken) {
        faultToken = new T.Mesh(new T.SphereGeometry(1.15, 16, 12), new T.MeshBasicMaterial());
        faultToken.position.y = 3.4;
        G.scene.add(faultToken);
      }
      const [from, to] = faultPositions[index];
      faultToken.position.x = P.sceneX(from + (to - from) * fraction);
      faultToken.material.color.copy(G.col.bad);
      P.updateCamera(now);
      G.renderer.render(G.scene, G.camera);
      P.updateLabels();
      place(labels.lastElementChild, faultToken.position.clone().setY(5.2), G.camera);
      return true;
    }
    if (!scene) buildScene();
    const [, , from, to] = scenarios[mode].steps[index];
    camera.aspect = G.w / Math.max(1, G.h);
    const distance = Math.max(14, 24 / camera.aspect);
    camera.position.set(0, distance * 0.32, distance);
    camera.lookAt(0, 0.3, 0);
    camera.updateProjectionMatrix();
    scene.background = G.col.paper;
    nodes.forEach((node, i) => node.material.color.copy(i === Math.round(from + fraction * (to - from)) ? G.col.am : G.col.box));
    token.position.x = x(from) + fraction * (x(to) - x(from));
    token.material.color.copy(mode === 'fault' ? G.col.bad : G.col.good);
    G.renderer.render(scene, camera);

    nodes.forEach((node, i) => place(labels.children[i], node.position.clone().setY(-1.35), camera));
    place(labels.lastElementChild, token.position.clone().setY(1.85), camera);
    return true;
  };
  function place(element, point, view) {
    point.project(view);
    element.style.left = (point.x * 50 + 50) + '%';
    element.style.top = (50 - point.y * 50) + '%';
  }
})(globalThis.PCS, window.THREE);
