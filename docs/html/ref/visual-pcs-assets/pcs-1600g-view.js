(function () {
  'use strict';
  const T = window.THREE;
  const M = window.PCS800Model;
  const get = name => document.getElementById('g1600-' + name);
  const steps = [
    ['1.6TMII', '174、175.2.1', '每次传输包含 8 个数据字节和 8 位控制指示。'],
    ['64B/66B · 速率匹配', '175.2.4.1–2', '编码后在转码之前执行速率匹配，可按规则调整 Idle 或序列有序集。'],
    ['256B/257B', '175.2.4.3', '四个连续 66b 块先转码为一个 257b 块。'],
    ['257b 分流', '175.2.4.4', '转码后的 257b 块交替送入 Flow 0、Flow 1。'],
    ['加扰 · AM', '175.2.4.5–6', '两流独立加扰。每流每 327,680 个 257b 块插入 1,028 位 AM。带 AM 的组由 AM 和 36 个加扰块组成。'],
    ['RS(544,514)', '175.2.4.7–8', '每流按 10 位符号交替分配到两个码字。Flow 0 生成 A/B，Flow 1 生成 C/D。'],
    ['16 PCS lane', '175.2.4.9', '每条 PCS lane 为 106.25 Gb/s，按 10 位符号循环交织 A、B、C、D 四个码字。'],
    ['16:8 SM-PMA', '176.4.2.3.3、176.4.2.5.2', '先对齐到 40 位边界，再将两条 PCS lane 的四元组交替送入一条输出 lane。本例采用相邻配对。'],
    ['8 × PAM4', '176.4.2、176.4.3.1', 'SM-PMA 输出每 lane 为 212.5 Gb/s（106.25 GBd），以 PAM4 传送符号四元组。介质和内层 FEC 由具体 PHY 决定。'],
    ['RX 四元组解复用', '176.4.3.2.2–3', '接收方向按 40 位四元组恢复 16 条 lane，通过 AM 锁定确定边界。'],
    ['AM 锁定 · 重排', '175.2.5.1–2', 'PCS 对 16 条 lane 执行 AM 锁定、deskew 和重排。PCS 最大 Skew 为 152 ns。'],
    ['RS 解码 · 后交织', '175.2.5.3–4', '去交织重建 A/B/C/D，逐码字纠错。各 Flow 将两个 514 符号消息交替拼回 10,280 位。'],
    ['AM 移除 · 解扰', '175.2.5.5–6', '每流移除 AM，再用自同步解扰器恢复 257b 块。'],
    ['257b 合流', '175.2.5.7', '先收集 Flow 0 的首块，再取 Flow 1 的首块，随后交替收集。'],
    ['逆转码 · 解码', '175.2.5.8–10', '合流后才进行逆转码、64B/66B 解码和 RX 速率匹配，还原 1.6TMII 传输。']
  ];
  const palette = [0x256ec8, 0xbd4f1c];
  const lanes = M.range(16);
  const hex = n => n.toString(16).toUpperCase().padStart(3, '0');
  const bytes = (flow, block) => M.range(32).map(i => (17 + (block * 2 + flow) * 32 + i) % 256);
  const blocks = [0, 1].map(flow => M.range(36).flatMap(block =>
    [1].concat(bytes(flow, block).flatMap(byte => M.range(8).map(bit => (byte >> bit) & 1)))));
  const streams = blocks.map((data, flow) => M.range(1028).map(i => (i + flow) % 2)
    .concat(M.scramble(data, flow)));
  const codewords = streams.flatMap(stream => [0, 1].map(word => {
    const msg = M.range(514).map(i => M.range(10).reduce((n, bit) =>
      n | (stream[20 * i + 10 * word + bit] << bit), 0));
    return msg.concat(window.PCS.rsParity(msg));
  }));
  const laneSymbols = lanes.map(lane => M.range(34).flatMap(row => codewords.map(word => word[16 * row + lane])));
  let decoded, stage = 0, active = false, playing = false, frame = 0, started = null;
  let renderer, camera, scene, cursor, tracks = [];
  const boxes = [];
  let webglFailed = false;
  const host = get('scene');
  const stepButtons = steps.map(([name], index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = (index + 1) + ' · ' + name;
    button.onclick = () => { pause(); select(index); };
    get('stages').append(button);
    return button;
  });
  get('progress').max = steps.length - 1;
  lanes.forEach(i => get('lane').add(new Option('PCS lane ' + i, i)));

  function decode() {
    const lane = Number(get('lane').value);
    const count = Number(get('errors').value);
    const received = lanes.map(i => laneSymbols[i].slice());
    for (let i = 0; i < count; i++) received[lane][4 * i] ^= i + 1;
    const words = M.range(4).map(word => {
      const message = M.range(544).map(i => received[i % 16][4 * Math.floor(i / 16) + word]);
      const result = window.PCS.rsDecode(message);
      return result.ok && result.cw.every((n, i) => n === codewords[word][i]) ? result.cw : null;
    });
    decoded = [0, 1].map(flow => {
      const pair = words.slice(2 * flow, 2 * flow + 2);
      if (pair.some(word => !word)) return null;
      const stream = M.range(514).flatMap(i => pair.flatMap(word =>
        M.range(10).map(bit => (word[i] >> bit) & 1)));
      return M.scramble(stream.slice(1028), flow, true);
    });
  }

  function stageData(index, flow) {
    const lane = Number(get('lane').value);
    const first = lane - lane % 2;
    const quartet = i => laneSymbols[i].slice(0, 4).map((n, word) => 'ABCD'[word] + '=' + hex(n)).join(' ');
    if (index >= 6 && index <= 10) {
      return '本例物理 lane ' + (first / 2) + '。PCS ' + first + ' [' + quartet(first) +
        '] → PCS ' + (first + 1) + ' [' + quartet(first + 1) + ']，之后交替发送下一组。十六进制，每符号 10 位。';
    }
    if (index === 5) {
      return 'Flow ' + flow + ' · ' + (flow ? 'C / D' : 'A / B') + '。每码字 514 个消息符号 + 30 个校验符号。';
    }
    if (index >= 11) {
      const count = Number(get('errors').value);
      if (index === 11) return decoded[0] ? '码字 A 已纠正 ' + count + ' 个注入错误，B/C/D 正常。'
        : '码字 A 超出纠错能力，Flow 0 输出不可用，B/C/D 正常。';
      if (!decoded[flow] || (index >= 13 && decoded.some(data => !data))) return '示例输出不可用。';
      const data = decoded[flow];
      if (index === 12) return 'Flow ' + flow + ' · 解扰后首个 257b 块的前 33 位 ' + data.slice(0, 33).join('');
      const output = M.range(8).map(i => M.range(8).reduce((n, bit) => n | (data[1 + i * 8 + bit] << bit), 0));
      return 'Flow ' + flow + ' · 首个恢复的 66b 数据块对应字节 ' + output.map(n => hex(n).slice(1)).join(' ');
    }
    if (index === 4) return 'Flow ' + flow + ' · 演示以 1,028 位合成 AM 开头，随后是 36 个加扰数据块。';
    return '纯数据示例 · Flow ' + flow + ' 的第一个 257b 块源自 MAC 块 ' +
      M.range(4).map(i => flow * 4 + i).join('、') + '。首组字节 ' + bytes(flow, 0).slice(0, 8).map(n => hex(n).slice(1)).join(' ');
  }

  const x = index => (index - 7) * 9;
  function select(index) {
    stage = index;
    const [name, clause, note] = steps[index];
    get('title').textContent = name + ' · ' + clause;
    get('note').textContent = note;
    get('data').textContent = stageData(index, 0);
    get('count').textContent = (index + 1) + ' / ' + steps.length;
    stepButtons.forEach((button, i) => button.setAttribute('aria-current', i === index ? 'step' : 'false'));
    render(index);
  }

  function render(position = stage) {
    get('progress').value = position;
    if (!renderer || !active) return;
    const lane = Number(get('lane').value);
    tracks.forEach((line, i) => line.material.opacity = lane === i ? 1 : 0.24);
    boxes.forEach(box => box.material.emissive.setHex(box.userData.index === stage ? 0x27517a : 0));
    let y = 0;
    if (position >= 6 && position <= 10) {
      const points = tracks[lane].userData.path;
      const end = points.findIndex(point => point.x >= x(position));
      if (end > 0) {
        const a = points[end - 1], b = points[end];
        y = a.y + (b.y - a.y) * (x(position) - a.x) / (b.x - a.x);
      } else y = points[0].y;
    }
    cursor.position.set(x(position), y, 1.5);
    renderer.render(scene, camera);
  }

  function setup() {
    if (renderer || webglFailed) return;
    try {
      renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
    } catch (error) {
      webglFailed = true;
      host.textContent = 'WebGL 不可用。可用下方阶段按钮查看全部流程和数据。';
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    host.append(renderer.domElement);
    scene = new T.Scene();
    camera = new T.PerspectiveCamera(42, 1, 1, 1600);
    camera.position.set(0, 40, 155);
    const controls = new T.OrbitControls(camera, renderer.domElement);
    controls.minDistance = 15;
    controls.addEventListener('change', () => render(Number(get('progress').value)));
    scene.add(new T.HemisphereLight(0xffffff, 0x728398, 1.2));
    const light = new T.DirectionalLight(0xffffff, 0.65);
    light.position.set(-25, 28, 40);
    scene.add(light);
    const point = (i, y, z = 0) => new T.Vector3(x(i), y, z);
    function line(points, color, transparent = false) {
      const object = new T.Line(new T.BufferGeometry().setFromPoints(points),
        new T.LineBasicMaterial({ color, transparent }));
      scene.add(object);
      return object;
    }
    for (const flow of [0, 1]) {
      const y = flow === 0 ? 6 : -6;
      line([point(0, 0), point(3, 0), point(4, y), point(5, y), point(6, 0)], palette[flow]);
      line([point(10, 0), point(11, y), point(12, y), point(13, 0), point(14, 0)], palette[flow]);
    }
    tracks = lanes.map(lane => {
      const y = (7.5 - lane) * 0.9;
      const muxY = (3.5 - Math.floor(lane / 2)) * 1.45;
      const path = [point(6, y), point(6.5, y), point(7.25, muxY), point(8.75, muxY),
        point(9.5, y), point(10, y)];
      const track = line(path, 0x26878c, true);
      track.userData.path = path;
      return track;
    });
    steps.forEach(([name], index) => {
      const split = [4, 5, 11, 12].includes(index);
      for (const flow of split ? [0, 1] : [-1]) {
        const box = new T.Mesh(new T.BoxGeometry(7.5, split ? 4 : 6, 3.5),
          new T.MeshLambertMaterial({ color: split ? palette[flow] : 0x526582 }));
        box.position.set(x(index), split ? (flow ? -6 : 6) : 0, -2.4);
        box.userData = { index, flow };
        scene.add(box);
        boxes.push(box);
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 96;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = split ? (flow ? '#9b3c16' : '#174d94') : '#34455e';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.font = 'bold 39px sans-serif';
        ctx.fillText((split ? 'F' + flow + ' ' : '') + name, 256, 62, 490);
        const label = new T.Mesh(new T.PlaneGeometry(7.35, 1.38),
          new T.MeshBasicMaterial({ map: new T.CanvasTexture(canvas) }));
        label.position.z = 1.78;
        box.add(label);
      }
    });
    cursor = new T.Mesh(new T.BoxGeometry(1.8, 1.35, 1.4), new T.MeshBasicMaterial({ color: 0xe9a31d }));
    scene.add(cursor);
    const ray = new T.Raycaster();
    let pointerStart;
    renderer.domElement.addEventListener('pointerdown', event => { pointerStart = [event.clientX, event.clientY]; });
    renderer.domElement.addEventListener('click', event => {
      if (!pointerStart || Math.hypot(event.clientX - pointerStart[0], event.clientY - pointerStart[1]) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new T.Vector2(2 * (event.clientX - rect.left) / rect.width - 1,
        1 - 2 * (event.clientY - rect.top) / rect.height), camera);
      const hit = ray.intersectObjects(boxes, false)[0];
      if (!hit) return;
      const { index, flow } = hit.object.userData;
      pause();
      select(index);
      get('popup-title').textContent = steps[index][0] + (flow < 0 ? '' : ' · Flow ' + flow);
      get('popup-note').textContent = steps[index][1] + ' · ' + steps[index][2];
      get('popup-data').textContent = stageData(index, Math.max(0, flow));
      get('popup').showModal();
    });
    new ResizeObserver(resize).observe(host);
  }

  function resize() {
    if (!active || !renderer || !host.clientWidth || !host.clientHeight) return;
    camera.aspect = host.clientWidth / host.clientHeight;
    const distance = Math.max(155, 185 / camera.aspect);
    if (camera.position.length() < distance) camera.position.setLength(distance);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight);
    render();
  }

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
    const t = (now - started) / 850;
    if (t >= 1) {
      select(stage + 1);
      started = now;
      if (stage === steps.length - 1) { pause(); return; }
    } else if (!reduced.matches) render(stage + t);
    frame = requestAnimationFrame(tick);
  }

  get('play').onclick = () => {
    if (playing) { pause(); return; }
    if (stage === steps.length - 1) select(0);
    playing = true;
    get('play').textContent = '暂停';
    get('play').setAttribute('aria-pressed', 'true');
    frame = requestAnimationFrame(tick);
  };
  get('step').onclick = () => { pause(); select((stage + 1) % steps.length); };
  get('reset').onclick = () => { pause(); select(0); };
  get('errors').onchange = get('lane').onchange = () => { decode(); select(stage); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  window.PCS1600View = {
    setActive(on) {
      if (active === on) return;
      active = on;
      if (!on) { pause(); if (get('popup').open) get('popup').close(); return; }
      setup();
      decode();
      resize();
      select(stage);
    }
  };
})();
