(function (T) {
  'use strict';
  const get = id => document.getElementById('llr-' + id);
  const panel = document.getElementById('lab-llr');
  const steps = {
    init: [
      ['A 进入 INIT', 'INIT · seq 0x12345', false, 'A 以当前 tx_seq 作为 init_seq，发送 LLR_INIT。若未收到有效回显，仍在 INIT，并按规范间隔重发。', 3, 0x12345, 0x4de1, 'INIT', '等待 INIT', '空'],
      ['B 建立接收状态', 'INIT · 接收', false, 'B 收到 INIT，将 next_rx_seq 设为 0x12345 并置有效，安排发送 INIT_ECHO。', 3, 0x12345, 0x4de1, '等待回显', '期望 0x12345', '空'],
      ['B 回显', 'INIT_ECHO · seq 0x12345', true, 'B 原样回传 init_seq 和 init_data。init_data 可由 A 用于测量往返时延。', 4, 0x12345, 0x4de1, '等待回显', '期望 0x12345', '空'],
      ['A 进入 ADVANCE', '首帧 · seq 0x12345', false, 'A 核对回显序号与 tx_seq 相等后退出 INIT，开始发送并保留首个 LLR-eligible 帧的副本。', 0, 0x12345, 0, 'ADVANCE', '期望 0x12345', '0x12345']
    ],
    replay: [
      ['保留未确认帧', '帧 10 丢失', false, 'B 已正确接收至帧 9。A 发送帧 10，副本留在重放缓冲。示例让帧 10 在链路上丢失。', 0, 10, 0, 'ADVANCE', '期望 10', '10'],
      ['检测序号缺口', '帧 11 到达', false, 'B 收到帧 11，但仍期望 10，因此丢弃这帧，不推进 next_rx_seq。', 0, 11, 0, 'ADVANCE', '期望 10', '10、11'],
      ['B 发送 NACK', 'NACK · seq 9', true, 'B 在下一个合规 CtlOS 机会发送一次 NACK。载荷是最近成功序号 9，之后等待期望帧 10。', 2, 9, 0, '收到 NACK', 'NACK_SENT', '10、11'],
      ['重放帧 10', 'Replay · 10', false, 'A 完成当前正在发送的帧后进入 REPLAY，从首个未确认帧 10 开始重放。B 接收后期望 11。', 0, 10, 0, 'REPLAY', '期望 11', '10、11'],
      ['重放帧 11', 'Replay · 11', false, 'A 按顺序继续重放帧 11，B 接收后期望 12。副本等待累计确认后释放。', 0, 11, 0, 'REPLAY', '期望 12', '10、11'],
      ['累计 ACK 与释放', 'ACK · seq 11', true, 'B 返回累计 ACK(11)，A 释放已确认帧 10 和 11 的副本，恢复新帧发送。', 1, 11, 0, 'ADVANCE', '期望 12', '空']
    ]
  };
  let index = 0, running = false, started = null, elapsed = 0, frame = 0;
  let renderer, scene, camera, signal;
  const duration = 1900, motion = matchMedia('(prefers-reduced-motion: reduce)');
  const hex = n => n.toString(16).toUpperCase().padStart(2, '0');
  const active = () => steps[get('scenario').value];
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
    camera.position.set(0, 6, 50);
    camera.lookAt(0, 0, 0);
    scene.add(new T.HemisphereLight(0xffffff, 0x788aaf, 1.5));
    function block(width, height, depth, x, y, color) {
      const mesh = new T.Mesh(new T.BoxGeometry(width, height, depth), new T.MeshLambertMaterial({ color }));
      mesh.position.set(x, y, 0);
      scene.add(mesh);
      return mesh;
    }
    for (const y of [-4.5, 4.5]) {
      block(37, .17, .3, 0, y, 0x8694ad);
      for (const x of [-18, -6, 6, 18]) block(4.2, 1.45, 2.2, x, y, 0x58729a);
    }
    signal = block(2.8, 1, 1.5, 0, 0, 0x22a579);
    new ResizeObserver(() => {
      if (!host.clientWidth) return;
      renderer.setSize(host.clientWidth, host.clientHeight, false);
      draw();
    }).observe(host);
  }

  function draw() {
    if (!renderer || panel.hidden) return;
    const reverse = current()[2];
    const progress = motion.matches || (!running && elapsed === 0) ? 1 : Math.min(1, elapsed / (duration * .8));
    signal.position.set((reverse ? 1 : -1) * (18 - 36 * progress), reverse ? -4.5 : 4.5, 1.8);
    if (get('scenario').value === 'replay' && index === 0) {
      signal.position.x = Math.min(0, signal.position.x);
      signal.material.color.setHex(0xd65a51);
    } else signal.material.color.setHex(reverse ? 0xe2a41f : 0x22a579);
    renderer.render(scene, camera);
  }

  function update() {
    const [title, signalName, reverse, note, type, seq, data, tx, rx, buffer] = current();
    const bytes = type ? [0x5c, type, seq >> 12, (seq >> 4) & 255, ((seq & 15) << 4) | 6, data >> 8, data & 255, 0] : [];
    get('detail').innerHTML = '<strong>' + signalName + ' · ' + (reverse ? 'B → A' : 'A → B') + '</strong><p>' + note + '</p>' +
      '<p>A · TX ' + tx + ' ｜ B · RX ' + rx + ' ｜ A · 重放缓冲 ' + buffer + '</p>' +
      (type ? '<div class="pcs-rx-bytes">' + bytes.map((b, i) => '<span>' + hex(b) + '<small>D' + i + '</small></span>').join('') +
        '</div><p class="note">xMII：Lane 0 为控制字符 0x5C，D1 为消息类型。PCS：同步头 10，块类型 0x4B，O-code 0x6。</p>'
        : '<p class="note">LLR-eligible 数据帧的 20 位 frame_seq 位于修改后的前导码。此步序号为 ' + seq + '。</p>');
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
