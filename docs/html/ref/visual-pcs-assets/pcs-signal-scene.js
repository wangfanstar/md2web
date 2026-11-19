(function (P, T) {
  'use strict';

  const get = id => document.getElementById('pcs-signal-' + id);
  const picker = get('mode'), controls = get('controls');
  const viewport = document.getElementById('viewport');
  const play = controls.querySelector('[data-signal-play]');
  const stages = controls.querySelector('[data-signal-steps]');
  const labels = document.createElement('div');
  labels.className = 'pcs-signal-labels';
  labels.hidden = true;
  viewport.append(labels);

  // Node indices follow A RS, A PHY, B PHY, B RS from left to right.
  const scenarios = {
    fault: {
      reference: 'IEEE 802.3 · 46.3.4、表 46–5 和图 46–11。示例假设 A → B 故障，B → A 可用。LF/RF 的有序集分别为 Sequence、00、00、01 和 Sequence、00、00、02。',
      nodes: ['A · RS', 'A · PCS / PHY', 'B · PCS / PHY', 'B · RS'],
      steps: [
        ['检测故障', 'RX 故障', 1, 2, 'A → B 接收路径异常。B 的 PHY 检测失锁等故障。'],
        ['本地上报', 'Local Fault', 2, 3, 'B 的 PHY 经本地 200GMII 向 B 的 RS 上报 Local Fault。'],
        ['生成并发回 RF', 'Remote Fault', 3, 0, 'B 的 RS 确认 LF 后停止发送 MAC 数据，持续生成 RF。B 的 PCS 编码并沿 B → A 发送，A 的 PCS 解码后经 200GMII 交给 A 的 RS。'],
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
  let scene, camera, nodes, token;
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
  }

  function select(next) {
    index = next;
    start = null;
    renderStep();
  }

  picker.onchange = function () {
    mode = picker.value;
    playing = false;
    viewport.classList.toggle('pcs-signaling', mode !== 'data');
    viewport.closest('#lab-200g').classList.toggle('pcs-signal-mode', mode !== 'data');
    labels.hidden = controls.hidden = mode === 'data';
    if (mode === 'data') return;
    P.setPlaying(false);
    if (P.closeInspector) P.closeInspector();
    const scenario = scenarios[mode];
    labels.replaceChildren(...scenario.nodes.map(name => {
      const label = document.createElement('span');
      label.textContent = name;
      return label;
    }));
    const badge = document.createElement('strong');
    badge.dataset.signalToken = '';
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
    if (!scene) buildScene();
    const [, , from, to] = scenarios[mode].steps[index];
    const fraction = reduced.matches || (elapsed === 0 && !playing) ? 1 : Math.min(1, elapsed / (duration * 0.72));
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

    function place(element, point) {
      point.project(camera);
      element.style.left = (point.x * 50 + 50) + '%';
      element.style.top = (50 - point.y * 50) + '%';
    }
    nodes.forEach((node, i) => place(labels.children[i], node.position.clone().setY(-1.35)));
    place(labels.lastElementChild, token.position.clone().setY(1.85));
    return true;
  };
})(globalThis.PCS, window.THREE);
