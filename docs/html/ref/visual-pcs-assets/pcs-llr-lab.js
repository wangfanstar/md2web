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
  const mainStages = [0, 2, 4, 7, 10, 13, 16, 17, 19];
  const spacing = 5.6;
  const extent = (stages.length - 1) * spacing / 2;
  const endpointColors = { a: 0x357fc8, b: 0xb46529, link: 0x62748c };
  const ray = new T.Raycaster(), pointer = new T.Vector2();
  const formatDialog = get('format-dialog');
  const duration = 1900, motion = matchMedia('(prefers-reduced-motion: reduce)');
  const hex = n => n.toString(16).toUpperCase().padStart(2, '0');
  const registerFields = [
    ['llr_mode_remote', 'TX 发起 INIT 许可', ['ON', 'OFF']],
    ['llr_mode_local', 'RX 接收 INIT 许可', ['ON', 'OFF']],
    ['outstanding_seq_max', '未确认序号跨度', 2, 0, 524288],
    ['outstanding_data_max', '未确认数据量（B）', 2048, 0, 4294967295],
    ['replay_timer_max', '重放超时（ns）', 800, 0, 65535],
    ['replay_ct_max', '连续重放上限（255 为不限）', 2, 0, 255],
    ['pcs_lost_status_timer_max', 'PCS 失锁超时（ns）', 1600, 0, 4294967295],
    ['data_age_timer_max', '数据驻留上限（ns）', 4000, 0, 4294967295],
    ['llr_init_behavior', 'INIT 期间上层来帧', ['BEST_EFFORT', 'BLOCK', 'DISCARD']],
    ['llr_flush_behavior', 'FLUSH 期间上层来帧', ['DISCARD', 'BLOCK', 'BEST_EFFORT']],
    ['re_init_on_discard', '清空后重新初始化', ['TRUE', 'FALSE']],
    ['ctlos_target_spacing', 'CtlOS 目标间隔（B）', 2048, 400, 16384],
    ['preamble_CRC_mode', '前导码 CRC4（扩展）', ['OFF', 'ON']],
    ['CtlOS_CRC_mode', 'CtlOS CRC4（扩展）', ['OFF', 'ON']],
    ['NACK_enhancement', '增强 NACK（扩展）', ['OFF', 'ON']]
  ];
  const form = get('register-form');
  const parameterGroups = [
    ['运行模式', 0, 2], ['窗口与定时器', 2, 8], ['异常策略与信令', 8, 12], ['扩展', 12, 15]
  ];
  for (const endpoint of ['a', 'b']) {
    const fieldset = get('register-' + endpoint);
    parameterGroups.forEach(([title, start], i) => {
      const section = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = title;
      section.open = i < 2;
      section.dataset.start = start;
      section.append(summary);
      fieldset.append(section);
    });
  }
  const controls = Object.fromEntries(['A', 'B'].map(endpoint => [endpoint, registerFields.map(([name, caption, values, min, max], index) => {
    const label = document.createElement('label');
    const title = document.createElement('code');
    title.textContent = name;
    const input = document.createElement(Array.isArray(values) ? 'select' : 'input');
    if (Array.isArray(values)) {
      values.forEach(value => input.add(new Option(value, value)));
    } else {
      Object.assign(input, { type: 'number', min, max, defaultValue: values, required: true });
    }
    input.name = name;
    label.append(title, document.createTextNode(caption), input);
    const [, start] = parameterGroups.find(([, first, last]) => index >= first && index < last);
    get('register-' + endpoint.toLowerCase()).querySelector('[data-start="' + start + '"]').append(label);
    return input;
  })]));
  const counterNames = (
    'tx_init_ctl_os tx_init_echo_ctl_os tx_ack_ctl_os tx_nack_ctl_os tx_discard tx_ok tx_poisoned tx_replay ' +
    'rx_init_ctl_os rx_init_echo_ctl_os rx_ack_ctl_os rx_nack_ctl_os rx_ack_nack_seq_error rx_ok rx_poisoned rx_bad ' +
    'rx_expected_seq_good rx_expected_seq_poisoned rx_expected_seq_bad rx_missing_seq rx_duplicate_seq rx_replay'
  ).split(' ');
  const unavailableCounters = new Set([
    'tx_poisoned', 'rx_ack_nack_seq_error', 'rx_poisoned', 'rx_bad', 'rx_expected_seq_poisoned',
    'rx_expected_seq_bad', 'rx_duplicate_seq'
  ]);
  const stats = get('register-stats');
  stats.innerHTML = '<table><caption>截至所选步骤的累计快照 · — 表示当前仿真未建模</caption>' +
    '<thead><tr><th scope="col">统计寄存器</th><th scope="col">A 端</th><th scope="col">B 端</th></tr></thead><tbody>' +
    counterNames.map(name => '<tr><th scope="row"><code>' + name + '</code></th><td>—</td><td>—</td></tr>').join('') +
    '</tbody></table>';
  const statsRows = Array.from(stats.querySelectorAll('tbody tr'));
  function updatePorts() {
    const sender = get('register-direction').value;
    const receiver = sender === 'A' ? 'B' : 'A';
    const view = get('register-port').value;
    const selected = view === 'auto' ? sender : view;
    ['A', 'B'].forEach(endpoint => {
      get('register-' + endpoint.toLowerCase()).hidden = selected !== 'both' && selected !== endpoint;
    });
    const value = name => controls[receiver].find(input => input.name === name).value;
    get('peer-summary').textContent = '接收端 ' + receiver + ' · INIT 许可 ' + value('llr_mode_local') +
      ' · CtlOS 间隔 ' + value('ctlos_target_spacing') + ' B';
  }
  function showStats(show) {
    form.hidden = show;
    get('stats-panel').hidden = !show;
    get('show-params').setAttribute('aria-pressed', String(!show));
    get('show-stats').setAttribute('aria-pressed', String(show));
  }
  get('register-port').onchange = updatePorts;
  get('show-params').onclick = () => showStats(false);
  get('show-stats').onclick = () => showStats(true);
  function markPending() {
    get('register-status').textContent = '参数有修改，等待应用。';
    updatePorts();
  }
  form.oninput = event => {
    if (event.target !== get('register-port')) markPending();
  };
  get('register-direction').onchange = markPending;
  get('preset').onchange = markPending;
  form.addEventListener('invalid', event => {
    const fieldset = event.target.closest('fieldset');
    if (!fieldset) return;
    showStats(false);
    get('register-port').value = fieldset.id.endsWith('-a') ? 'A' : 'B';
    event.target.closest('details').open = true;
    updatePorts();
  }, true);
  updatePorts();
  const policyText = {
    BLOCK: '阻塞上层来帧', DISCARD: '丢弃上层来帧', BEST_EFFORT: '以普通非 LLR 帧发送'
  };

  function simulate() {
    const sender = get('register-direction').value;
    const receiver = sender === 'A' ? 'B' : 'A';
    const settings = endpoint => Object.fromEntries(controls[endpoint].map(input =>
      [input.name, input.type === 'number' ? input.valueAsNumber : input.value]));
    const tx = settings(sender);
    const rx = settings(receiver);
    const config = { ...tx, llr_mode_local: rx.llr_mode_local, ctlos_target_spacing: rx.ctlos_target_spacing };
    const reverse = sender === 'B';
    const orient = text => reverse ? text.replace(/\b[AB]\b/g, letter => letter === 'A' ? 'B' : 'A') : text;
    const preset = get('preset').value;
    const timeline = [];
    const state = (title, time, note, tx, buffer = '空', counter = '') =>
      timeline.push([title, title, reverse, time + ' ns · ' + orient(note), 0, 0, 0, tx, '—', buffer, { sender, receiver, counter: orient(counter) }]);
    const signalStep = (row, time, counter) =>
      timeline.push([orient(row[0]), row[1], row[2] !== reverse, time + ' ns · ' + orient(row[3]), ...row.slice(4), { sender, receiver, wire: true, counter: orient(counter), lost: row === steps.replay[0] }]);
    const policy = mode => policyText[mode] + '（' + mode + '）。';
    const init = time => {
      state('进入 INIT', time, policy(config.llr_init_behavior), 'INIT', '空',
        config.llr_init_behavior === 'DISCARD' ? 'A tx_discard' : '');
      signalStep(steps.init[0], time, config.llr_mode_local === 'ON' ? 'A tx_init_ctl_os|B rx_init_ctl_os' : 'A tx_init_ctl_os');
      if (config.llr_mode_local === 'OFF') {
        state('等待 INIT_ECHO', time, 'B 的 llr_mode_local 为 OFF，示例停在等待回显。', 'INIT');
        return false;
      }
      signalStep(steps.init[2], time + 40, 'B tx_init_echo_ctl_os|A rx_init_echo_ctl_os');
      state('进入 ADVANCE', time + 80, 'A 收到有效回显。', 'ADVANCE');
      return true;
    };
    if (config.llr_mode_remote === 'OFF') {
      state('LLR_OFF', 0, 'A 的 llr_mode_remote 为 OFF，按普通以太网运行。', 'LLR_OFF');
      return timeline;
    }
    if (preset === 'init' || config.llr_mode_local === 'OFF') {
      init(0);
      return timeline;
    }
    const capacity = Math.min(config.outstanding_seq_max, Math.floor(config.outstanding_data_max / 512));
    if (capacity < 2) {
      state('等待窗口可用', 0, capacity === 0 ? '窗口容不下一帧 512 B。' :
        '窗口只容得下一帧。帧 11 等待，无法用跳号触发 NACK。', 'ADVANCE',
        capacity === 0 ? '空' : '10');
      if (!capacity) return timeline;
    }
    const age = config.data_age_timer_max;
    const wait = config.replay_timer_max;
    const feedback = 80 + Math.ceil(config.ctlos_target_spacing / 25);
    const flush = (time, reason) => {
      state('FLUSH', time, reason + '。清空重放缓冲；' + policy(config.llr_flush_behavior), 'FLUSH', '空',
        config.llr_flush_behavior === 'DISCARD' ? 'A tx_discard' : '');
      if (config.re_init_on_discard === 'TRUE') init(time + 1);
    };
    const pcsLost = preset === 'pcs';
    if (pcsLost) {
      state('PCS_status = FALSE', 0, '链路失锁，缓冲中仍有未确认帧。', 'ADVANCE', capacity === 1 ? '10' : '10、11');
    } else {
      signalStep(steps.replay[0], 0, 'A tx_ok');
      if (capacity > 1) signalStep(steps.replay[1], 21, 'A tx_ok|B rx_ok|B rx_missing_seq');
    }
    const deadline = pcsLost ? Math.min(age, config.pcs_lost_status_timer_max) : age;
    const canNack = !pcsLost && preset === 'nack' && capacity > 1;
    const firstOpportunity = !pcsLost && capacity > 1 ? 21 : 0;
    let time = Math.max(firstOpportunity, canNack ? Math.min(wait, feedback) : wait);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (time >= deadline) {
        flush(deadline, pcsLost && deadline === config.pcs_lost_status_timer_max ? 'PCS 失锁定时器到期' : '数据驻留定时器到期');
        return timeline;
      }
      const nack = attempt === 0 && canNack && feedback <= wait;
      if (!nack && config.replay_ct_max !== 255 && attempt >= config.replay_ct_max) {
        flush(time, '重放定时器到期且已达到连续重放上限');
        return timeline;
      }
      if (nack) signalStep(steps.replay[2], time, 'B tx_nack_ctl_os|A rx_nack_ctl_os');
      else state('重放定时器到期', time, '未及时收到反馈，启动重放。', 'REPLAY', capacity === 1 ? '10' : '10、11');
      if (!pcsLost) {
        signalStep(steps.replay[3], time, 'A tx_ok|B rx_ok|B rx_expected_seq_good|B rx_replay' +
          (capacity === 1 ? '|A tx_replay' : ''));
        if (capacity > 1 && time + 21 < deadline) signalStep(steps.replay[4], time + 21, 'A tx_ok|A tx_replay|B rx_ok|B rx_expected_seq_good');
      }
      if (!pcsLost && preset === 'nack' && time + feedback < age) {
        if (capacity > 1) signalStep(steps.replay[5], time + feedback, 'B tx_ack_ctl_os|A rx_ack_ctl_os');
        else state('收到累计 ACK(10)', time + feedback, '释放帧 10，发送窗口重新可用。', 'ADVANCE', '空', 'A rx_ack_ctl_os');
        return timeline;
      }
      time += Math.max(wait, 42);
    }
    if (deadline <= time) flush(deadline, pcsLost && deadline === config.pcs_lost_status_timer_max ? 'PCS 失锁定时器到期' : '数据驻留定时器到期');
    else if (config.replay_ct_max === 3) flush(time, '重放定时器到期且已达到连续重放上限');
    else state('仿真预览结束', time, '已显示前三轮重放机会。', 'ADVANCE', '未确认');
    return timeline;
  }

  steps.registers = simulate();
  form.onsubmit = event => {
    event.preventDefault();
    steps.registers = simulate();
    get('scenario').value = 'registers';
    get('register-status').textContent = '已应用参数 · ' + (get('register-direction').value === 'A' ? 'A → B' : 'B → A') +
      ' · ' + ['A', 'B'].map(endpoint => endpoint + ' 扩展开关 ' +
        controls[endpoint].slice(-3).map(input => input.name + '=' + input.value).join(' / ')).join(' ｜ ') +
      ' · ' + steps.registers.length + ' 个事件';
    reset();
  };
  form.onreset = () => {
    get('register-status').textContent = '默认参数已恢复，点击应用重新计算。';
    queueMicrotask(updatePorts);
  };
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
        mesh.userData = { name, format, description, reverse, color, stage: i, x };
        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'btn llr-hop-label llr-endpoint-' + side;
        label.textContent = name;
        const summary = document.createElement('small');
        summary.className = 'llr-stage-format';
        label.append(summary);
        label.onclick = () => openFormat(mesh.userData);
        host.append(label);
        modules.push({ mesh, label, summary });
      });
    }
    signal = block(2.8, 1, 1.5, 0, 0, 0x22a579);
    const canvas = renderer.domElement;
    function hit(event) {
      const r = canvas.getBoundingClientRect();
      pointer.set(2 * (event.clientX - r.left) / r.width - 1, 1 - 2 * (event.clientY - r.top) / r.height);
      ray.setFromCamera(pointer, camera);
      return ray.intersectObjects([...(signal.visible ? [signal] : []), ...modules.filter(entry => entry.mesh.visible).map(entry => entry.mesh)], false)[0]?.object;
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
    get('main-only').onchange = get('fit').onclick;
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
    const simulation = current()[10];
    signal.visible = !simulation || Boolean(simulation.wire);
    signal.position.set((reverse ? 1 : -1) * extent * (1 - 2 * progress), reverse ? -10 : 10, 1.8);
    if (isLostStep()) {
      signal.position.x = reverse ? Math.max(0, signal.position.x) : Math.min(0, signal.position.x);
      signal.material.color.setHex(0xd65a51);
    } else signal.material.color.setHex(reverse ? 0xe2a41f : 0x22a579);
    const mainOnly = get('main-only').checked;
    const summaries = mainOnly ? stageSummaries() : null;
    modules.forEach(({ mesh, label, summary }) => {
      const { stage, x } = mesh.userData;
      const slot = mainStages.indexOf(stage);
      mesh.visible = !mainOnly || slot !== -1;
      label.hidden = !mesh.visible;
      if (!mesh.visible) return;
      mesh.position.x = mainOnly
        ? extent * (2 * slot / (mainStages.length - 1) - 1) * (mesh.userData.reverse ? -1 : 1)
        : x;
      const enabled = mesh.userData.reverse === reverse;
      mesh.material.color.setHex(mesh.userData.color);
      mesh.material.color.multiplyScalar(enabled ? 1 : .55);
      label.classList.toggle('is-inactive', !enabled);
      const p = mesh.position.clone().project(camera);
      label.style.left = (p.x * 50 + 50) + '%';
      label.classList.toggle('llr-hop-below', (mainOnly ? slot : stage) % 2 === 1);
      summary.textContent = mainOnly && enabled && signal.visible ? summaries[slot] : '';
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
  function isLostStep() {
    return Boolean(current()[10]?.lost) || (get('scenario').value === 'replay' && index === 0);
  }

  function stageSummaries() {
    const [, , , , type, seq, data] = current();
    if (negotiating()) {
      return ['LLDP Options TLV', '66b 块', '257b 块', 'RS(544,514)', '线路信号',
        '已恢复符号', '还原 66b', 'xMII 字节', '解析 LLDP'];
    }
    const bytes = type ? ctlBytes(type, seq, data) : preamble(seq);
    const start = bytes.slice(0, 4).map(hex).join(' ');
    const block = type ? '10 · 0x4B' : '10 · 0x78';
    const lost = isLostStep();
    return [start + ' …', block, '4 × 66b → 257b', '514 + 30 符号',
      lost ? '帧在此丢失' : '线路信号',
      ...(lost ? ['未收到', '—', '—', '—']
        : ['恢复 514 符号', block, start + ' …', (type ? 'CtlOS' : '帧') + ' · Seq ' + seq])];
  }
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
    if (current()[10] && !current()[10].wire) {
      detail += '<p>本步显示本地状态转换。</p>';
    } else if (target && target.reverse !== reverse) {
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

  function renderCounters(simulation) {
    const counts = new Map();
    const scope = get('counter-scope').value;
    const search = get('counter-search').value.trim().toLowerCase();
    if (simulation) active().slice(0, index + 1).forEach((step, i) => {
      if (!step[10].counter) return;
      step[10].counter.split('|').forEach(name => {
        const entry = counts.get(name) || { count: 0, last: -1, delta: 0 };
        entry.count++;
        entry.last = i;
        if (i === index) entry.delta++;
        counts.set(name, entry);
      });
    });
    statsRows.forEach((row, i) => {
      const name = counterNames[i];
      let changed = false;
      ['A', 'B'].forEach((endpoint, column) => {
        const cell = row.cells[column + 1];
        const entry = counts.get(endpoint + ' ' + name);
        cell.textContent = simulation && !unavailableCounters.has(name) ? entry?.count || 0 : '—';
        if (!entry) return;
        changed = changed || entry.delta > 0;
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'linkbtn';
        link.textContent = entry.delta ? ' (+' + entry.delta + ')' : ' ↗';
        link.title = '跳到最近一次增量 · 第 ' + (entry.last + 1) + ' 步';
        link.setAttribute('aria-label', endpoint + ' ' + name + ' · ' + link.title);
        link.onclick = () => {
          pause();
          select(entry.last);
          get('steps').querySelector('[aria-current="step"]').focus();
        };
        cell.append(link);
      });
      row.classList.toggle('llr-counter-changed', changed);
      row.hidden = !name.includes(search) || (scope === 'changed' && !changed) ||
        (['tx', 'rx'].includes(scope) && !name.startsWith(scope + '_'));
    });
    const empty = get('counter-empty');
    empty.hidden = statsRows.some(row => !row.hidden);
    empty.textContent = simulation ? '没有符合条件的计数器。' : '应用仿真参数后可查看计数变化。';
  }
  get('counter-scope').onchange = () => renderCounters(current()[10]);
  get('counter-search').oninput = () => renderCounters(current()[10]);

  function update() {
    const [title, signalName, reverse, note, type, seq, data, tx, rx, buffer] = current();
    const bytes = type ? ctlBytes(type, seq, data) : [];
    const simulation = current()[10];
    get('format').disabled = Boolean(simulation && !simulation.wire);
    renderCounters(simulation);
    get('event').textContent = (index + 1) + ' / ' + active().length + ' · ' + (simulation ? note.split(' · ')[0] + ' · ' : '') + title;
    get('prev').disabled = index === 0;
    get('next').disabled = index === active().length - 1;
    get('format').textContent = signalName + ' · 查看格式';
    get('detail').innerHTML = '<strong>' + signalName + ' · ' + (reverse ? 'B → A' : 'A → B') + '</strong><p>' + note + '</p>' +
      (negotiating() ? '<p>A · ' + tx + ' ｜ B · ' + rx + '</p><p>' + buffer + '</p>' +
        '<p class="note">本图按 TLV 版本 0 展示。W=3 表示双向意愿，1 和 2 保留。UE 1.1 的 TLV 版本 1 使用两位 E，双向启用为 3，与版本 0 的 E=1 互通。</p>' +
        (get('scenario').value === 'negotiation' && index === active().length - 1
          ? '<button type="button" class="btn" data-llr-init>进入 LLR 初始化</button>' : '')
      : '<p>' + (simulation?.sender || 'A') + ' · TX ' + tx + ' ｜ ' +
        (simulation?.receiver || 'B') + ' · RX ' + rx + ' ｜ ' + (simulation?.sender || 'A') + ' · 重放缓冲 ' + buffer + '</p>' +
      (type ? '<div class="pcs-rx-bytes">' + bytes.map((b, i) => '<span>' + hex(b) + '<small>D' + i + '</small></span>').join('') +
        '</div><p class="note">xMII：Lane 0 为控制字符 0x5C，D1 为消息类型。PCS：同步头 10，块类型 0x4B，O-code 0x6。</p>'
        : simulation && !simulation.wire ? '' : '<p class="note">LLR-eligible 数据帧的 20 位 frame_seq 位于修改后的前导码。此步序号为 ' + seq + '。</p>'));
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
  get('scenario').onchange = () => {
    if (get('scenario').value === 'registers') updatePorts();
    reset();
  };
  get('reset').onclick = reset;
  get('prev').onclick = () => { pause(); select(Math.max(0, index - 1)); };
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
