(() => {
  'use strict';
  const host = document.getElementById('cb-world');
  const panel = document.getElementById('lab-cbfc');
  if (!host || !panel || !window.THREE) return;
  const T = window.THREE;
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const AX = -7.2;
  const BX = 7.2;
  const RAIL_Z = 1.7;
  const FB_Z = -1.7;
  const DATA = '#2f9fd8';
  const FEEDBACK = '#2f8a4c';
  const CONTROL = '#8d72c9';

  let renderer, scene, camera, controls, ready = false;
  let packet, labelHost, packetLabel;
  let senderMesh, receiverMesh;
  let slots = [], credit = [], cells = [], beats = [];
  let labels = [];
  let theme = {};
  let pending = null;
  let state = null;
  let animation = 0, pulseFrame = 0;

  function readTheme() {
    theme = {
      bg: css('--scene-bg') || '#eef1f5',
      panel: css('--panel') || '#f3f5f7',
      ink: css('--ink') || '#18202b',
      muted: css('--muted') || '#687384',
      rule: css('--rule') || '#d5dbe3',
      box: css('--scene-box') || '#dde3eb',
      edge: css('--scene-edge') || '#8592a5',
      am: css('--am') || '#e2a41f',
      good: css('--good') || '#2f8a4c',
      bad: css('--bad') || '#cc2936'
    };
  }

  function mix(hex, target, amount) {
    return new T.Color(hex).lerp(new T.Color(target), amount);
  }

  function box(w, h, d, color, opacity) {
    const geometry = new T.BoxGeometry(w, h, d);
    const material = new T.MeshLambertMaterial({
      color, transparent: opacity != null, opacity: opacity == null ? 1 : opacity
    });
    const mesh = new T.Mesh(geometry, material);
    mesh.add(new T.LineSegments(new T.EdgesGeometry(geometry),
      new T.LineBasicMaterial({ color: theme.edge, transparent: true, opacity: 0.7 })));
    scene.add(mesh);
    return mesh;
  }

  function makeLabel(text, cls) {
    const node = document.createElement('div');
    node.className = 'cb3d-lbl' + (cls ? ' ' + cls : '');
    node.textContent = text;
    labelHost.appendChild(node);
    return { node, text, pos: new T.Vector3(), shown: true, w: 0, h: 0 };
  }

  function build() {
    readTheme();
    renderer = new T.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(new T.Color(theme.bg), 1);
    host.appendChild(renderer.domElement);
    scene = new T.Scene();
    scene.background = new T.Color(theme.bg);
    scene.add(new T.HemisphereLight(0xffffff, 0x8291a8, 1.15));
    const light = new T.DirectionalLight(0xffffff, 0.6);
    light.position.set(-8, 14, 18);
    scene.add(light);

    const grid = new T.GridHelper(30, 30, theme.rule, theme.rule);
    grid.position.set(0, -1.9, 0);
    grid.scale.z = 0.2;
    grid.material.transparent = true;
    grid.material.opacity = 0.3;
    scene.add(grid);

    // 两端机箱：A 发送端、B 接收端。
    senderMesh = box(3.2, 4.4, 5.2, mix(theme.box, DATA, 0.32).getHex());
    senderMesh.position.set(AX, 0.9, 0);
    receiverMesh = box(3.2, 4.4, 5.2, mix(theme.box, FEEDBACK, 0.32).getHex());
    receiverMesh.position.set(BX, 0.9, 0);

    // 发送队列：4 个槽位，显示当前 VC 的排队/在途状态。
    for (let i = 0; i < 4; i++) {
      const slot = box(2.3, 0.42, 0.7, mix(theme.box, DATA, 0.1).getHex(), 0.16);
      slot.position.set(AX, 2.75 - i * 0.58, 3.05);
      slots.push(slot);
    }

    // 发送端信用表：8 段竖条，已用为琥珀色、可用为绿色。
    for (let i = 0; i < 8; i++) {
      const seg = box(0.5, 0.3, 1.1, theme.good, 0.95);
      seg.position.set(AX - 2.2, 0.55 + i * 0.36, 0);
      credit.push(seg);
    }

    // 接收缓冲：4×2 个单元，按 R_VC_CF/缓冲占用点亮。
    for (let i = 0; i < 8; i++) {
      const cell = box(0.72, 0.4, 0.72, theme.box, 0.16);
      cell.position.set(BX - 1.65 + (i % 4) * 1.1, 3.45 + Math.floor(i / 4) * 0.52, 2.4);
      cells.push(cell);
    }

    // 两条轨：蓝轨 A→B 承载数据/CC_Update，绿轨 B→A 承载 CF_Update/LLDP。
    [[RAIL_Z, DATA, 1], [FB_Z, FEEDBACK, -1]].forEach(([z, color, dir]) => {
      const rail = box(10.9, 0.08, 0.16, color, 0.5);
      rail.position.set(0, 0.35, z);
      for (let x = -4.4; x <= 4.6; x += 2.2) {
        const head = new T.Mesh(new T.ConeGeometry(0.18, 0.6, 8),
          new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 }));
        head.position.set(x, 0.35, z);
        head.rotation.z = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
        scene.add(head);
      }
    });

    // 报文：数据帧 / CF_Update / CC_Update / LLDP 共用，按类型改色。
    packet = box(1.15, 0.55, 0.7, DATA, 1);
    packet.visible = false;

    labelHost = document.createElement('div');
    labelHost.className = 'cb3d-labels';
    host.appendChild(labelHost);
    labels = [
      Object.assign(makeLabel('A · 发送端', 'is-title'), { pos: new T.Vector3(AX, 4.6, 0) }),
      Object.assign(makeLabel('B · 接收端', 'is-title'), { pos: new T.Vector3(BX, 4.6, 0) }),
      Object.assign(makeLabel('队列', ''), { pos: new T.Vector3(AX, -0.85, 3.1), id: 'queue' }),
      Object.assign(makeLabel('信用', ''), { pos: new T.Vector3(AX - 3.7, 0.2, 0), id: 'credit' }),
      Object.assign(makeLabel('缓冲', ''), { pos: new T.Vector3(BX - 3.7, 2.8, 0), id: 'buffer' })
    ];
    packetLabel = document.createElement('div');
    packetLabel.className = 'cb3d-lbl is-packet';
    packetLabel.hidden = true;
    labelHost.appendChild(packetLabel);

    camera = new T.PerspectiveCamera(34, 1, 0.1, 200);
    controls = new T.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;
    controls.minDistance = 6;
    controls.maxDistance = 42;
    controls.maxPolarAngle = 1.5;
    controls.mouseButtons = { LEFT: T.MOUSE.PAN, MIDDLE: T.MOUSE.DOLLY, RIGHT: T.MOUSE.ROTATE };
    controls.touches = { ONE: T.TOUCH.PAN, TWO: T.TOUCH.DOLLY_ROTATE };
    controls.addEventListener('change', paint);
    renderer.domElement.addEventListener('wheel', wheelZoom, { passive: false, capture: true });
    renderer.domElement.addEventListener('dblclick', event => {
      const rect = renderer.domElement.getBoundingClientRect();
      const ray = new T.Raycaster();
      ray.setFromCamera(new T.Vector2(
        (event.clientX - rect.left) / rect.width * 2 - 1,
        1 - (event.clientY - rect.top) / rect.height * 2), camera);
      const hit = ray.intersectObjects([senderMesh, receiverMesh], false)[0];
      if (hit && hit.object === senderMesh) focus(AX);
      else if (hit && hit.object === receiverMesh) focus(BX);
      else home();
    });
    new ResizeObserver(resize).observe(host);
    window.addEventListener('resize', resize);

    const reset = document.getElementById('cb-camera');
    if (reset) reset.onclick = home;

    ready = true;
    home();
    resize();
    if (pending) apply(pending);
    paints();
    // 请求实验脚本重发当前步骤，补齐初始化时的状态。
    host.dispatchEvent(new CustomEvent('cb-sync'));
  }

  function paints() {
    paint();
    setTimeout(paint, 80);
  }

  // 滚轮以光标位置为锚点缩放，行为与 200G/800G 三维通道一致。
  function wheelZoom(event) {
    if (!ready) return;
    event.preventDefault();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    else event.stopPropagation();
    const rect = host.getBoundingClientRect();
    const pointer = new T.Vector2(
      (event.clientX - rect.left) / rect.width * 2 - 1,
      1 - (event.clientY - rect.top) / rect.height * 2);
    const scale = event.deltaY < 0 ? 0.88 : 1 / 0.88;
    const ray = new T.Raycaster();
    ray.setFromCamera(pointer, camera);
    const plane = new T.Plane(new T.Vector3(0, 0, 1), 0);
    const hit = new T.Vector3();
    if (ray.ray.intersectPlane(plane, hit)) controls.target.lerp(hit, 1 - scale);
    const offset = camera.position.clone().sub(controls.target);
    offset.setLength(Math.min(42, Math.max(6, offset.length() * scale)));
    camera.position.copy(controls.target).add(offset);
    controls.update();
    paint();
  }

  function home() {
    if (!camera || !controls) return;
    camera.position.set(0, 8.4, 19);
    controls.target.set(0, 0.6, 0);
    controls.update();
    paint();
  }

  // 双击端点时把相机移近该端，便于查看队列或缓冲单元。
  function focus(x) {
    if (!camera || !controls) return;
    camera.position.set(x + Math.sign(x || 1) * 2, 5.2, 12.5);
    controls.target.set(x, 1.0, 0);
    controls.update();
    paint();
  }

  function resize() {
    if (!ready || panel.hidden) return;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    paint();
  }

  function paint() {
    if (!ready || !renderer) return;
    // 画布铺满宿主，宿主背景是透明的，不能用它覆盖场景背景。
    const bg = css('--scene-bg');
    if (bg && '#' + scene.background.getHexString() !== bg.toLowerCase()) {
      scene.background.set(bg);
      renderer.setClearColor(new T.Color(bg), 1);
    }
    renderer.render(scene, camera);
    updateLabels();
  }

  function updateLabels() {
    if (!labelHost) return;
    const W = host.clientWidth, H = host.clientHeight;
    if (!W || !H) return;
    const v = new T.Vector3();
    labels.forEach(label => {
      v.copy(label.pos).project(camera);
      const show = v.z < 1 && v.x > -1.05 && v.x < 1.05 && v.y > -1.05 && v.y < 1.05;
      if (show) {
        if (!label.w) {
          label.w = label.node.offsetWidth || 40;
          label.h = label.node.offsetHeight || 14;
        }
        const x = (v.x + 1) / 2 * W - label.w / 2;
        const y = (1 - v.y) / 2 * H - label.h / 2;
        label.node.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
      }
      if (show !== label.shown) {
        label.node.style.visibility = show ? 'visible' : 'hidden';
        label.shown = show;
      }
    });
    if (packet.visible && packetLabel && !packetLabel.hidden) {
      v.copy(packet.position).project(camera);
      const x = (v.x + 1) / 2 * W;
      const y = (1 - v.y) / 2 * H;
      packetLabel.style.transform = 'translate(' + Math.round(x + 10) + 'px,' +
        Math.round(y - 26) + 'px)';
    }
  }

  function setLabel(id, text) {
    const label = labels.find(item => item.id === id);
    if (!label) return;
    if (label.text !== text) {
      label.text = text;
      label.node.textContent = text;
      label.w = 0;
    }
  }

  function apply(detail) {
    pending = detail;
    if (!ready) return;
    state = detail;
    if (detail.op === 'rst') {
      packet.visible = false;
      if (packetLabel) packetLabel.hidden = true;
      cancelAnimationFrame(animation);
    }

    const limit = Math.max(1, Math.min(8, detail.limit || 1));
    const used = Math.max(0, Math.min(limit, detail.used || 0));
    credit.forEach((seg, i) => {
      seg.visible = i < limit;
      seg.material.color.set(i < used ? theme.am : theme.good);
      seg.material.opacity = i < limit ? 0.95 : 0.15;
    });

    const buf = Math.max(0, Math.min(8, detail.buf || 0));
    cells.forEach((cell, i) => {
      cell.material.color.set(i < buf ? theme.good : theme.box);
      cell.material.opacity = i < buf ? 0.95 : 0.16;
    });

    const queued = detail.blocked ? 2 : detail.inflight ? 1 : 0;
    slots.forEach((slot, i) => {
      const on = i < queued;
      slot.material.color.set(detail.blocked ? theme.am : DATA);
      slot.material.opacity = on ? 0.92 : 0.14;
    });

    setLabel('queue', 'VC ' + detail.vc + ' · ' + (detail.blocked ? '等待信用' : detail.inflight ? '在途' : '空闲'));
    setLabel('credit', 'S_VC_CU ' + detail.used + ' / ' + detail.limit +
      (detail.portUsed != null ? ' · 端口 ' + detail.portUsed + '/' + detail.portLimit : ''));
    setLabel('buffer', '缓冲 ' + detail.buf + ' · R_VC_CF ' + detail.cfR + ' · S_VC_CC ' + detail.cc);
    animateFor(detail);
    paint();
  }

  function kindColor(kind) {
    if (kind === 'cf') return theme.am;
    if (kind === 'cc' || kind === 'lldp') return CONTROL;
    if (kind === 'bad') return theme.bad;
    if (kind === 'loss') return theme.bad;
    return DATA;
  }

  function fly(kind, dir, text, lostAt) {
    if (!ready) return;
    cancelAnimationFrame(animation);
    readTheme();
    packet.material.color.set(kindColor(kind));
    packet.material.opacity = 1;
    packet.visible = true;
    packetLabel.hidden = false;
    packetLabel.textContent = text;
    packetLabel.dataset.kind = kind;
    const from = dir > 0 ? AX + 1.8 : BX - 1.8;
    const to = dir > 0 ? BX - 1.8 : AX + 1.8;
    const z = kind === 'cf' ? FB_Z : RAIL_Z;
    const start = performance.now();
    const duration = 900;
    const step = now => {
      const t = Math.min(1, (now - start) / duration);
      const ease = t * t * (3 - 2 * t);
      const x = from + (to - from) * ease;
      const y = 0.55 + Math.sin(t * Math.PI) * 0.22;
      if (lostAt && t >= lostAt) {
        packet.visible = false;
        packetLabel.hidden = true;
        burst(x, y, z);
        animation = 0;
        paint();
        return;
      }
      packet.position.set(x, y, z);
      paint();
      if (t < 1) {
        animation = requestAnimationFrame(step);
      } else {
        packet.visible = false;
        packetLabel.hidden = true;
        animation = 0;
        pulse(dir > 0 ? 1 : -1);
        paint();
      }
    };
    animation = requestAnimationFrame(step);
  }

  function burst(x, y, z) {
    const spark = new T.Mesh(new T.SphereGeometry(0.32, 10, 10),
      new T.MeshBasicMaterial({ color: theme.bad, transparent: true, opacity: 0.9 }));
    spark.position.set(x, y, z);
    scene.add(spark);
    const start = performance.now();
    const step = now => {
      const t = Math.min(1, (now - start) / 420);
      spark.scale.setScalar(1 + t * 1.8);
      spark.material.opacity = 0.9 * (1 - t);
      paint();
      if (t < 1) requestAnimationFrame(step);
      else { scene.remove(spark); spark.geometry.dispose(); spark.material.dispose(); paint(); }
    };
    requestAnimationFrame(step);
  }

  function pulse(dir) {
    const target = dir > 0
      ? cells[Math.min(cells.length - 1, Math.max(0, (state && state.buf || 1) - 1))]
      : credit[0];
    if (!target) return;
    const base = target.scale.x;
    const start = performance.now();
    cancelAnimationFrame(pulseFrame);
    const step = now => {
      const t = Math.min(1, (now - start) / 380);
      const k = 1 + Math.sin(t * Math.PI) * 0.45;
      target.scale.setScalar(k);
      paint();
      if (t < 1) pulseFrame = requestAnimationFrame(step);
      else target.scale.setScalar(base);
    };
    pulseFrame = requestAnimationFrame(step);
  }

  function animateFor(detail) {
    const op = detail.op;
    const dir = detail.dir || 0;
    const vc = detail.vc;
    switch (op) {
      case 'tx':
      case 'retry':
        if (detail.blocked) {
          pulse(1);
          setLabel('queue', 'VC ' + vc + ' · 等待信用');
        } else {
          fly('data', 1, '数据帧 VC ' + vc);
        }
        break;
      case 'rx':
        pulse(1);
        break;
      case 'drain':
        pulse(1);
        break;
      case 'cf':
      case 'cfmax':
        fly('cf', -1, (op === 'cfmax' ? 'CF_Update 重发' : 'CF_Update') + ' VC ' + vc);
        break;
      case 'cflost':
        fly('cf', -1, 'CF_Update 丢失', 0.62);
        break;
      case 'ccgen':
        fly('cc', 1, 'CC_Update ' + (vc < 16 ? 'VC 0–15' : 'VC 16–31'));
        break;
      case 'ccrx':
        pulse(1);
        break;
      case 'ccdrop':
        fly('cc', 1, 'CC_Update 丢弃', 0.52);
        break;
      case 'loss':
        fly('loss', 1, '数据帧丢失 VC ' + vc, 0.58);
        break;
      case 'lldp1':
      case 'lldp3':
        fly('lldp', -1, 'LLDP 接收端 → 发送端');
        break;
      case 'lldp2':
        fly('lldp', 1, 'LLDP 发送端 → 接收端');
        break;
      case 'rxinit':
        pulse(-1);
        break;
      case 'rst':
        pulse(-1);
        break;
      case 'be':
        fly('data', 1, '尽力而为帧 VC ' + vc);
        break;
      case 'add':
      case 'enable':
      case 'up':
      case 'upall':
      case 'txinit':
      case 'rxready':
        pulse(-1);
        break;
      case 'rmwant':
      case 'rmlldp1':
      case 'rmlldp3':
        fly('lldp', -1, 'LLDP VC ' + vc + ' 移除');
        break;
      case 'rmlldp2':
        fly('lldp', 1, 'LLDP VC ' + vc + ' 移除');
        break;
      case 'rmreturn':
        fly('cf', -1, 'CF_Update 归还 VC ' + vc);
        break;
      case 'rmdone':
        pulse(1);
        break;
      default:
        if (dir) fly(dir > 0 ? 'data' : 'cf', dir, 'VC ' + vc);
    }
  }

  function boot() {
    if (!panel.hidden && !ready) build();
    if (!panel.hidden && ready) {
      resize();
      if (pending) apply(pending);
      paint();
    }
  }

  host.addEventListener('cb-step', event => apply(event.detail));
  new MutationObserver(boot).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) paint(); });
  if (!panel.hidden) boot();
})();
