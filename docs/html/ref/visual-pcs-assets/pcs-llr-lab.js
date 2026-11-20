(function (T) {
  'use strict';
  const get = id => document.getElementById('llr-' + id);
  const panel = document.getElementById('lab-llr');
  const steps = {
    negotiation: [
      ['A 通告意愿', 'LLDP · W=3 / E=0', false, 'A 发送 IEEE 802.1AB LLDP 帧，在 UE Link Negotiation Options TLV 中通告希望使用双向 LLR。', 0, 0, 0, 'W=3 / E=0', 'W=3 / E=0', 'A 尚未收到启用通告'],
      ['B 启用并通告', 'LLDP · W=3 / E=1', true, 'B 收到 A 的 W=3，与本地 W=3 一致，于是设置本地 E=1，并将它发给 A。B 仍需看到 A 的 E=1。', 0, 0, 0, 'W=3 / E=0', 'W=3 / E=1', 'B 等待 A 的 E=1'],
      ['A 启用并通告', 'LLDP · W=3 / E=1', false, 'A 收到 B 的 W=3 和 E=1，设置本地 E=1，并向 B 通告。B 收到后也确认对端已启用。', 0, 0, 0, 'W=3 / E=1', 'W=3 / E=1', '双方均已启用'],
      ['转入 LLR 初始化', 'Operational', false, '本例双方均已看到对端启用，llr_mode_local 与 llr_mode_remote 均为 ON。可进入 LLR_INIT / INIT_ECHO 握手，再开始发送 LLR-eligible 帧。', 0, 0, 0, 'W=3 / E=1', 'W=3 / E=1', '双方均已确认']
    ],
    unsupported: [
      ['A 通告意愿', 'LLDP · W=3 / E=0', false, 'A 通过 UE Options TLV 表达双向 LLR 意愿。', 0, 0, 0, 'W=3 / E=0', '无 UE Options TLV', '等待对端通告'],
      ['B 回传普通 LLDP', 'LLDP · 无 UE TLV', true, 'A 收到对端 LLDP，但其中没有 UE Options TLV，因此保持 E=0。远端 W=0、1、2 时也应禁用 LLR。', 0, 0, 0, 'W=3 / E=0', '无 UE Options TLV', 'LLR 保持关闭'],
      ['保持普通以太网', 'LLR 未启用', false, '自动协商分支维持普通以太网运行。规范允许通过管理配置覆盖协商，本示例按自动协商展示。', 0, 0, 0, 'W=3 / E=0', '无 UE Options TLV', '不进入 INIT']
    ],
    init: [
      ['A 进入 INIT', 'INIT · seq 0x00000', false, '首次启用后 tx_seq 为 0。A 以当前 tx_seq 作为 init_seq，发送 LLR_INIT。若未收到有效回显，仍在 INIT，并按规范间隔重发。', 3, 0x00000, 0x4de1, 'INIT', '等待 INIT', '空'],
      ['B 建立接收状态', 'INIT · 接收', false, 'B 收到 INIT，将 next_rx_seq 设为 0x00000 并置有效，安排发送 INIT_ECHO。', 3, 0x00000, 0x4de1, '等待回显', '期望 0x00000', '空'],
      ['B 回显', 'INIT_ECHO · seq 0x00000', true, 'B 原样回传 init_seq 和 init_data。init_data 可由 A 用于测量往返时延。', 4, 0x00000, 0x4de1, '等待回显', '期望 0x00000', '空'],
      ['A 进入 ADVANCE', '首帧 · seq 0x00000', false, 'A 核对回显序号与 tx_seq 相等后退出 INIT，开始发送并保留首个 LLR-eligible 帧的副本。', 0, 0x00000, 0, 'ADVANCE', '期望 0x00000', '0x00000']
    ],
    replay: [
      ['保留未确认帧', '帧 10 丢失', false, 'B 已正确接收至帧 9。A 发送帧 10，副本留在重放缓冲。示例让帧 10 在链路上丢失。', 0, 10, 0, 'ADVANCE', '期望 10', '10'],
      ['检测序号缺口', '帧 11 到达', false, 'B 收到帧 11，但仍期望 10，因此丢弃这帧，不推进 next_rx_seq。', 0, 11, 0, 'ADVANCE', '期望 10', '10、11'],
      ['B 发送 NACK', 'NACK · seq 9', true, 'B 在下一个合规 CtlOS 机会发送一次 NACK。载荷是最近成功序号 9，之后等待期望帧 10。', 2, 9, 0, '收到 NACK', 'NACK_SENT', '10、11'],
      ['重放帧 10', 'Replay · 10', false, 'A 完成当前正在发送的帧后进入 REPLAY，从首个未确认帧 10 开始重放。B 接收后期望 11。', 0, 10, 0, 'REPLAY', '期望 11', '10、11'],
      ['重放帧 11', 'Replay · 11', false, 'A 按顺序继续重放帧 11，B 接收后期望 12。副本等待累计确认后释放。', 0, 11, 0, 'REPLAY', '期望 12', '10、11'],
      ['累计 ACK 与释放', 'ACK · seq 11', true, 'A 完成重放即返回 ADVANCE。B 返回累计 ACK(11)，A 收到后释放已确认帧 10 和 11 的副本。', 1, 11, 0, 'ADVANCE', '期望 12', '空']
    ]
  };
  let index = 0, running = false, started = null, elapsed = 0, frame = 0;
  let renderer, scene, camera, signal;
  const modules = [];
  // Each row is a complete transmit → receive path, mirrored for B → A.
  const stages = [
    ['MAC / TX LLR', 0, '发送端选择 LLR-eligible 帧、分配序号并保存重放副本，或生成 LLR CtlOS。'],
    ['发送 xMII', 0, 'RS 向 PCS 提交数据、帧起始符或控制有序集。'],
    ['64B/66B 编码', 1, '将 xMII 字节与控制位编码为 66 位块。'],
    ['Idle 调整', 1, '在 66 位块流中调整空闲，为插入对齐标记留出带宽。'],
    ['256B/257B 转码', 2, '把四个 66 位块组合为一个 257 位块。'],
    ['加扰', 5, '对 257 位块连续加扰，供后续 AM 插入和 FEC 编码。'],
    ['AM 插入', null, '按周期插入对齐标记，供远端识别、排序和对齐 PCS lane。'],
    ['RS-FEC 编码', 3, '分配 10 位符号并生成 RS(544,514) 校验。'],
    ['PCS lane 分配', 4, '将码字分配到 PCS lane，交给发送 PMA。'],
    ['TX PMA', 4, '按接口映射将 PCS lane 复用到物理通道。'],
    ['物理链路', null, '物理通道将信号送往远端。丢包场景中的帧 10 在此丢失。'],
    ['RX PMA', null, '从接收信号恢复并解复用 PCS lane。'],
    ['AM 锁定 / 对齐', null, '识别 AM 后完成 PCS lane 排序与去偏斜。'],
    ['RS-FEC 解码', 3, '重组接收码字，检查并纠正可纠正的符号错误。'],
    ['AM 删除', null, '在恢复的块流中移除对齐标记。'],
    ['解扰', 2, '恢复转码后的 257 位块。'],
    ['257B/256B 逆转码', 1, '从 257 位块恢复四个 66 位块。'],
    ['64B/66B 解码', 0, '还原 xMII 字节和控制位。'],
    ['接收 xMII', 0, 'PCS 向 RS 交付还原的帧起始符和有序集。'],
    ['RX LLR / MAC', 0, '接收端处理 CtlOS、检查序号及 FCS，并向 MAC 交付通过检查的帧。']
  ];
  const spacing = 5.6;
  const extent = (stages.length - 1) * spacing / 2;
  const endpointColors = { a: 0x357fc8, b: 0xb46529, link: 0x62748c };
  const ray = new T.Raycaster(), pointer = new T.Vector2();
  const formatDialog = get('format-dialog');
  const duration = 1900, motion = matchMedia('(prefers-reduced-motion: reduce)');
  const hex = n => n.toString(16).toUpperCase().padStart(2, '0');
  const active = () => steps[get('scenario').value];
  const negotiating = () => ['negotiation', 'unsupported'].includes(get('scenario').value);
  const current = () => active()[index];

  function setup() {
    if (renderer) return;
    try { renderer = new T.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { return; }
    const host = get('scene');
    host.prepend(renderer.domElement);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    scene = new T.Scene();
    camera = new T.OrthographicCamera(-24, 24, 10, -10, 0.1, 150);
    camera.position.set(2, 15, 50);
    camera.lookAt(0, 0, 0);
    const key = new T.DirectionalLight(0xffffff, .95);
    key.position.set(-8, 14, 10);
    scene.add(key);
    scene.add(new T.HemisphereLight(0xffffff, 0x788aaf, 1.5));
    function block(width, height, depth, x, y, color) {
      const mesh = new T.Mesh(new T.BoxGeometry(width, height, depth), new T.MeshLambertMaterial({ color }));
      mesh.position.set(x, y, 0);
      scene.add(mesh);
      return mesh;
    }
    for (const [side, sign] of [['a', -1], ['b', 1]]) {
      const board = block(extent - 2, 31, .35, sign * (extent / 2 + 3.9), 0, endpointColors[side]);
      board.position.z = -2;
      board.material.transparent = true;
      board.material.opacity = .19;
      board.material.depthWrite = false;
    }
    for (const y of [-10, 10]) {
      block(2 * extent, .16, .3, 0, y, 0x8694ad);
      const reverse = y < 0;
      stages.forEach(([name, format, description], i) => {
        const x = (i * spacing - extent) * (reverse ? -1 : 1);
        const side = i === 10 ? 'link' : x < 0 ? 'a' : 'b';
        const color = endpointColors[side];
        const mesh = block(4.1, 1.45, 2.2, x, y, color);
        mesh.userData = { name, format, description, reverse, color, lowerLabel: i % 2 === 1 };
        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'btn llr-hop-label llr-endpoint-' + side;
        label.textContent = name;
        label.onclick = () => openFormat(mesh.userData);
        host.append(label);
        modules.push({ mesh, label });
      });
    }
    signal = block(2.8, 1, 1.5, 0, 0, 0x22a579);
    const canvas = renderer.domElement;
    function hit(event) {
      const r = canvas.getBoundingClientRect();
      pointer.set(2 * (event.clientX - r.left) / r.width - 1, 1 - 2 * (event.clientY - r.top) / r.height);
      ray.setFromCamera(pointer, camera);
      return ray.intersectObjects([signal, ...modules.map(entry => entry.mesh)], false)[0]?.object;
    }
    let panX = 0, panY = 0, zoom = 1, drag = null;
    function view() {
      const aspect = host.clientWidth / host.clientHeight;
      if (!aspect) return;
      const halfWidth = Math.max(extent + 6, 24 * aspect) / zoom;
      const halfHeight = halfWidth / aspect;
      panX = Math.max(-extent, Math.min(extent, panX));
      panY = Math.max(-24, Math.min(24, panY));
      camera.left = panX - halfWidth;
      camera.right = panX + halfWidth;
      camera.top = panY + halfHeight;
      camera.bottom = panY - halfHeight;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      get('scale').textContent = Math.round(zoom * 100) + '%';
      draw();
    }
    function scale(factor, x = 0, y = 0) {
      const next = Math.max(.6, Math.min(4, zoom * factor));
      panX += x * (camera.right - camera.left) * (1 - zoom / next);
      panY += y * (camera.top - camera.bottom) * (1 - zoom / next);
      zoom = next;
      view();
    }
    get('larger').onclick = () => scale(1.25);
    get('smaller').onclick = () => scale(.8);
    get('fit').onclick = () => { panX = panY = 0; zoom = 1; view(); };
    host.addEventListener('wheel', event => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      scale(Math.exp(-Math.sign(event.deltaY) * .12),
        (event.clientX - rect.left) / rect.width - .5, .5 - (event.clientY - rect.top) / rect.height);
    }, { passive: false });
    host.onpointerdown = event => {
      if (event.button || !event.isPrimary) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX, panY, moved: false };
    };
    host.onpointermove = event => {
      if (!drag || event.pointerId !== drag.id || !(event.buttons & 1)) {
        canvas.style.cursor = hit(event) ? 'pointer' : 'grab';
        return;
      }
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < 4) return;
        drag.moved = true;
        host.setPointerCapture(event.pointerId);
        host.classList.add('is-panning');
      }
      panX = drag.panX - dx * (camera.right - camera.left) / host.clientWidth;
      panY = drag.panY + dy * (camera.top - camera.bottom) / host.clientHeight;
      view();
    };
    function finishDrag(event) {
      if (!drag || event.pointerId !== drag.id) return;
      const mesh = event.type === 'pointerup' && !drag.moved && event.target === canvas && hit(event);
      drag = null;
      host.classList.remove('is-panning');
      if (mesh) openFormat(mesh === signal ? null : mesh.userData);
    }
    host.onpointerup = finishDrag;
    host.onpointercancel = finishDrag;
    host.addEventListener('lostpointercapture', event => {
      if (event.target === host) finishDrag(event);
    });
    new ResizeObserver(() => {
      if (!host.clientWidth) return;
      renderer.setSize(host.clientWidth, host.clientHeight, false);
      view();
    }).observe(host);
  }

  function draw() {
    if (!renderer || panel.hidden) return;
    const reverse = current()[2];
    const progress = motion.matches || (!running && elapsed === 0) ? 1 : Math.min(1, elapsed / (duration * .8));
    signal.position.set((reverse ? 1 : -1) * extent * (1 - 2 * progress), reverse ? -10 : 10, 1.8);
    if (get('scenario').value === 'replay' && index === 0) {
      signal.position.x = Math.min(0, signal.position.x);
      signal.material.color.setHex(0xd65a51);
    } else signal.material.color.setHex(reverse ? 0xe2a41f : 0x22a579);
    modules.forEach(({ mesh, label }) => {
      const enabled = mesh.userData.reverse === reverse;
      mesh.material.color.setHex(mesh.userData.color);
      mesh.material.color.multiplyScalar(enabled ? 1 : .55);
      label.classList.toggle('is-inactive', !enabled);
      const p = mesh.position.clone().project(camera);
      label.style.left = (p.x * 50 + 50) + '%';
      label.classList.toggle('llr-hop-below', mesh.userData.lowerLabel);
      label.style.top = (50 - p.y * 50) + '%';
    });
    get('scene').querySelectorAll('.llr-labels b').forEach((label, i) => {
      const point = new T.Vector3([-extent, 0, extent][i % 3], i < 3 ? 19 : -19, 0).project(camera);
      label.style.left = (50 + 50 * point.x) + '%';
      label.style.top = (50 - 50 * point.y) + '%';
    });
    renderer.render(scene, camera);

  }

  const bits = (value, width = 8) => Array.from({ length: width }, (_, i) => (value >> i) & 1).join('');
  const ctlBytes = (type, seq, data) =>
    [0x5c, type, seq >> 12, (seq >> 4) & 255, ((seq & 15) << 4) | 6, data >> 8, data & 255, 0];
  const preamble = seq => [0xfb, ((seq >> 16) << 4) | 7, (seq >> 8) & 255, seq & 255, 0x55, 0x55, 0x55, 0xd5];
  const byteView = bytes => '<div class="pcs-rx-bytes">' + bytes.map((value, i) =>
    '<span>' + hex(value) + '<small>Lane ' + i + ' · C=' + Number(i === 0) + '</small></span>').join('') + '</div>';

  function transcodeSample(payload) {
    // One LLR control/start block followed by three all-zero data blocks.
    const first = payload.join('');
    return '00111' + first.slice(0, 4) + first.slice(8) + '0'.repeat(192);
  }

  function fecSample(transcoded) {
    // One complete pair between AM groups. Remaining blocks are data samples.
    const dataBlock = '1' + '0'.repeat(256);
    const input = Array.from(transcoded + dataBlock.repeat(39), Number);
    const scrambled = window.PCS800Model.scramble(input, 0);
    return [0, 1].map(w => {
      const message = Array.from({ length: 514 }, (_, i) =>
        scrambled.slice(20 * i + 10 * w, 20 * i + 10 * w + 10)
          .reduce((word, bit, k) => word | (bit << k), 0));
      return { message, parity: window.PCS.rsParity(message) };
    });
  }

  function openFormat(target) {
    pause();
    const [, signalName, reverse, note, type, seq, data] = current();
    const hop = target ? target.name : '当前信号';
    get('format-title').textContent = signalName + ' · ' + hop;
    const path = reverse ? 'B → A' : 'A → B';
    let detail = '<p><b>当前方向 ' + path + '</b> · ' + note + '</p>';
    if (target) detail += '<p>' + target.description + '</p>';
    if (target && target.reverse !== reverse) {
      detail += '<p>该方向在本步没有演示信号。</p>';
    } else if (negotiating()) {
      detail += '<p>LLDP 的 UE Link Negotiation Options TLV 随 MAC 帧传送。查看下方步骤说明中的 LLR-W 和 LLR-E。</p>' +
        '<p>' + current()[7] + '（A） ｜ ' + current()[8] + '（B）</p>';
    } else {
      const bytes = type ? ctlBytes(type, seq, data) : preamble(seq);
      const payload = type
        ? [bits(type), bits(bytes[2]), bits(bytes[3]), bits(6, 4) + bits(bytes[4] >> 4, 4), ...bytes.slice(5).map(value => bits(value))]
        : bytes.slice(1).map(value => bits(value));
      const blockType = type ? 0x4b : 0x78;
      const showOctets = !target || target.format === 0;
      if (showOctets) detail += '<h4>' + (type ? 'xMII CtlOS 字节' : 'xMII 修改后的前导码') + '</h4>' + byteView(bytes);
      if (!target || target.format === 1) {
        detail += '<h4>64B/66B 控制块</h4>' +
          '<p>同步头 10 · 块类型 0x' + hex(blockType) + (type ? ' · O-code 0x6' : ' · 20 位 frame_seq') + '</p>' +
          '<pre class="pcs-fault-bits">' + ['10', bits(blockType), ...payload].join(' ') + '</pre>';
      }
      if (target && (target.format === 2 || target.format === 3 || target.format === 4 || target.format === 5)) {
        const transcoded = transcodeSample([bits(blockType), ...payload]);
        if (target.format === 5) {
          const scrambled = window.PCS800Model.scramble(Array.from(transcoded, Number), 0).slice(0, 257).join('');
          detail += '<h4>加扰输出 · 257 位</h4><pre class="pcs-fault-bits">' +
            scrambled.match(/.{1,8}/g).join(' ') + '</pre>';
        } else if (target.format === 2) {
          detail += '<h4>257b 块参考样例</h4>' +
            '<p>样例取当前 LLR 控制块或起始块，再接三个填零的数据块。块分类按发送顺序为 <code>0 | 0111</code>，省略第一个控制块类型的第二个半字节。</p>' +
            '<pre class="pcs-fault-bits">' + transcoded.match(/.{1,8}/g).join(' ') + '</pre>';
        } else {
          const words = fecSample(transcoded);
          const symbols = values => values.map(value => '0x' + hex(value).padStart(3, '0')).join(' ');
          detail += '<h4>' + (target.format === 3 ? 'RS(544,514) 码字' : '进入 PCS lane 分配与 PMA 的码字') + '</h4>' +
            '<p>40 个 257b 块连续加扰，每 10 位交替分配到码字 0、1。每个码字含 514 个消息符号和 30 个校验符号。</p>' +
            '<pre class="pcs-fault-bits">' + words.map(({ message, parity }, i) =>
              i + ' 消息[0…7] ' + symbols(message.slice(0, 8)) +
              ' | 校验[0…7] ' + symbols(parity.slice(0, 8))).join(String.fromCharCode(10)) + '</pre>' +
            '<p class="note">样例使用固定加扰初态，演示 AM 组之间的一对码字，剩余块使用教学填充。PMA 后的线路位序取决于 lane 映射。</p>';
        }
      }
    }
    get('format-body').innerHTML = detail;
    if (!formatDialog.open) formatDialog.showModal();
  }
  get('format').onclick = () => openFormat();

  function update() {
    const [title, signalName, reverse, note, type, seq, data, tx, rx, buffer] = current();
    const bytes = type ? ctlBytes(type, seq, data) : [];
    get('format').textContent = signalName + ' · 查看格式';
    get('detail').innerHTML = '<strong>' + signalName + ' · ' + (reverse ? 'B → A' : 'A → B') + '</strong><p>' + note + '</p>' +
      (negotiating() ? '<p>A · ' + tx + ' ｜ B · ' + rx + '</p><p>' + buffer + '</p>' +
        '<p class="note">本图按 TLV 版本 0 展示。W=3 表示双向意愿，1 和 2 保留。UE 1.1 的 TLV 版本 1 使用两位 E，双向启用为 3，与版本 0 的 E=1 互通。</p>' +
        (get('scenario').value === 'negotiation' && index === active().length - 1
          ? '<button type="button" class="btn" data-llr-init>进入 LLR 初始化</button>' : '')
      : '<p>A · TX ' + tx + ' ｜ B · RX ' + rx + ' ｜ A · 重放缓冲 ' + buffer + '</p>' +
      (type ? '<div class="pcs-rx-bytes">' + bytes.map((b, i) => '<span>' + hex(b) + '<small>D' + i + '</small></span>').join('') +
        '</div><p class="note">xMII：Lane 0 为控制字符 0x5C，D1 为消息类型。PCS：同步头 10，块类型 0x4B，O-code 0x6。</p>'
        : '<p class="note">LLR-eligible 数据帧的 20 位 frame_seq 位于修改后的前导码。此步序号为 ' + seq + '。</p>'));
    const init = get('detail').querySelector('[data-llr-init]');
    if (init) init.onclick = () => { get('scenario').value = 'init'; reset(); };
    Array.from(get('steps').querySelectorAll('button')).forEach((button, i) =>
      button.setAttribute('aria-current', i === index ? 'step' : 'false'));
    get('play').textContent = running ? '暂停' : index === active().length - 1 && elapsed >= duration ? '重播' : '播放';
    draw();
  }

  function pause() {
    running = false;
    cancelAnimationFrame(frame);
    started = null;
    update();
  }
  function select(i) { index = i; elapsed = 0; started = null; update(); }
  function tick(now) {
    if (!running || panel.hidden) return;
    if (started === null) started = now - elapsed;
    elapsed = now - started;
    if (elapsed >= duration) {
      if (index + 1 === active().length) { pause(); return; }
      select(index + 1);
    }
    draw();
    frame = requestAnimationFrame(tick);
  }
  function reset() {
    cancelAnimationFrame(frame);
    running = false;
    get('steps').replaceChildren(...active().map(([title], i) => {
      const li = document.createElement('li'), button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.textContent = (i + 1) + ' · ' + title;
      button.onclick = () => { pause(); select(i); };
      li.append(button);
      return li;
    }));
    select(0);
  }
  get('scenario').onchange = reset;
  get('reset').onclick = reset;
  get('next').onclick = () => { pause(); select(Math.min(index + 1, active().length - 1)); };
  get('play').onclick = () => {
    if (running) { pause(); return; }
    if (elapsed >= duration) select(0);
    running = true;
    update();
    frame = requestAnimationFrame(tick);
  };
  new MutationObserver(() => {
    if (panel.hidden) pause();
    else { setup(); draw(); }
  }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  if (!panel.hidden) setup();
  reset();
})(window.THREE);
