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
  let index = 0, running = false, lastFrameTime = null, elapsed = 0, frame = 0;
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
  const visibleStages = {
    main: [0, 2, 4, 7, 10, 13, 16, 17, 19],
    endpoint: [0, 19]
  };
  const wireFormats = [
    '发送 xMII 字节', '发送 xMII 字节', '66b 块', '66b 块',
    '257b 转码块', '加扰后的 257b 块', '含 AM 的块流', 'RS(544,514) 码字',
    'PCS lane 码流', 'PMA 物理通道比特', '物理线路信号', '解复用后的 PCS lane',
    '对齐后的 PCS lane', 'FEC 校验后的消息符号', '移除 AM 后的块流',
    '解扰后的 257b 块', '恢复后的 66b 块', '接收 xMII 字节',
    '接收 xMII 字节', 'LLR 接收处理'
  ];
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
  const stats = get('register-stats');
  stats.innerHTML = '<table><caption>截至所选步骤的累计快照 · — 表示当前场景无统计</caption>' +
    '<thead><tr><th scope="col">统计寄存器</th><th scope="col">A 端</th><th scope="col">B 端</th></tr></thead><tbody>' +
    counterNames.map(name => '<tr><th scope="row"><code>' + name + '</code></th><td>—</td><td>—</td></tr>').join('') +
    '</tbody></table>';
  const statsRows = Array.from(stats.querySelectorAll('tbody tr'));
  function updatePorts() {
    const sender = get('register-direction').value;
    const receiver = sender === 'A' ? 'B' : 'A';
    const view = get('register-port').value;
    get('lldp-options').hidden = get('preset').value !== 'lldp';
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
  let refreshTimer;
  function refreshOnInput(event) {
    if (event.target === get('register-port')) return;
    clearTimeout(refreshTimer);
    updatePorts();
    if (event.target.type === 'number') {
      refreshTimer = setTimeout(() => applyRegisters(false), 180);
    } else {
      applyRegisters(false);
    }
  }
  form.oninput = refreshOnInput;
  get('register-direction').onchange = refreshOnInput;
  get('preset').onchange = refreshOnInput;
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

  function simulate(preset = get('preset').value, test = null) {
    const sender = test?.sender || get('register-direction').value;
    const receiver = sender === 'A' ? 'B' : 'A';
    const settings = endpoint => Object.fromEntries(controls[endpoint].map(input =>
      [input.name, input.type === 'number' ? input.valueAsNumber : input.value]));
    const defaults = Object.fromEntries(registerFields.map(([key, , value]) =>
      [key, Array.isArray(value) ? value[0] : value]));
    const tx = test ? { ...defaults, ...test.tx } : settings(sender);
    const rx = test ? { ...defaults, ...test.rx } : settings(receiver);
    const frameCount = test?.frameCount ?? 2;
    const eventLimit = test?.eventLimit ?? 80;
    const reverse = sender === 'B';
    const capacity = Math.min(tx.outstanding_seq_max, Math.ceil(tx.outstanding_data_max / 512), Math.floor((test?.bufferBytes ?? Infinity) / 512));
    const mod = value => value & 0xfffff;
    const timeline = [], queue = [], buffer = [];
    let now = 0, txState = 'ADVANCE', rxState = 'SEND_ACKS';
    let txSeq = test?.start ?? (preset === 'wrap' ? 0xfffff : 10);
    let expected = test?.expected ?? txSeq, acknowledged = mod(txSeq - 1), retries = 0;
    let replayAt = Infinity, ageAt = Infinity, pcsAt = Infinity;
    let feedbackPending = false, nextCtlSlot = 0, nackDuringReplay = false;
    let creditSent = 0, creditReceived = 0, creditReturned = 0;
    const cbfc = preset === 'cbfc';
    const packetType = test?.packetType || 'D';

    const lossless = cbfc && packetType === 'D';
    let newFrames = 0;
    const counters = (endpoint, ...names) => names.map(name => endpoint + ' ' + name);
    const schedule = (time, run) => queue.push({ time, run });
    function step(title, note, event = {}) {
      const { wire, backward, type = 0, seq = 0, data = 0, counts = [] } = event;
      timeline.push([title, event.name || title, reverse !== Boolean(backward),
        now + ' ns · ' + note, type, seq, data, txState,
        rxState + ' · next_rx_seq=' + expected, buffer.map(frame => frame.seq).join('、') || '空',
        { ...event, time: now, sender, receiver, wire, txState, rxState, retries, txSeq, expected, acknowledged,
          replayAt, ageAt, pcsAt, cbfc, creditSent, creditReceived, creditReturned, counter: counts.join('|') }]);
    }

    function resetSession() {
      queue.length = buffer.length = 0;
      ageAt = replayAt = pcsAt = Infinity;
      txState = 'LLR_OFF';
      rxState = 'OFF';
      retries = txSeq = expected = 0;
      acknowledged = mod(-1);
      step('管理复位', '结束本次链路会话。');
    }
    let initAttempts = 0;
    function init() {
      initAttempts++;
      const initTime = now;
      const fault = initAttempts === 1 ? test?.initFault : '';
      txState = 'INIT';
      if (preset === 'init' || preset === 'init-fail') {
        step('进入 INIT', policyText[tx.llr_init_behavior],
          { counts: tx.llr_init_behavior === 'DISCARD' ? counters(sender, 'tx_discard') : [] });
      }
      if (test?.resetState === 'INIT') {
        resetSession();
        return false;
      }
      const receivesInit = (preset === 'lldp' || rx.llr_mode_local === 'ON') && preset !== 'init-fail' && fault !== 'init-lost';
      if (receivesInit) expected = txSeq;
      step('发送 INIT', sender + ' 通告当前 tx_seq。',
        { wire: true, type: 3, seq: txSeq, data: 0x4de1, name: 'INIT', lost: preset === 'init-fail' || fault === 'init-lost',
          counts: [...counters(sender, 'tx_init_ctl_os'), ...(receivesInit ? counters(receiver, 'rx_init_ctl_os') : [])] });
      if (!receivesInit && fault === 'init-lost' && rx.llr_mode_local === 'ON') {
        now = initTime + Math.ceil(tx.ctlos_target_spacing * 4 / 25);
        init();
        return;
      }
      if (!receivesInit) {
        step('等待 INIT_ECHO', '接收端未返回有效回显，发送端保持 INIT。');
        return;
      }
      now += 40;
      rxState = 'SEND_ACKS';
      if (fault === 'echo-lost' || fault === 'echo-mismatch') {
        const lost = fault === 'echo-lost';
        step('INIT_ECHO 异常', lost ? '回显在链路中丢失。' : '回显序号不匹配，保持 INIT。',
          { wire: true, backward: true, type: 4, seq: lost ? txSeq : mod(txSeq + 1), data: 0x4de1, lost,
            counts: [...counters(receiver, 'tx_init_echo_ctl_os'), ...(lost ? [] : counters(sender, 'rx_init_echo_ctl_os'))] });
        now = Math.max(now + 1, initTime + Math.ceil(tx.ctlos_target_spacing * 4 / 25));
        init();
        return;
      }
      step('回显 INIT_ECHO', receiver + ' 原样返回序号和 init_data。',
        { wire: true, backward: true, type: 4, seq: expected, data: 0x4de1, name: 'INIT_ECHO',
          counts: [...counters(receiver, 'tx_init_echo_ctl_os'), ...counters(sender, 'rx_init_echo_ctl_os')] });
      now += 40;
      txState = 'ADVANCE';
      acknowledged = mod(txSeq - 1);
      step('进入 ADVANCE', '有效回显已到达，发送窗口可用。');
    }

    function flush(reason) {
      const pcsDown = Number.isFinite(pcsAt);
      queue.length = buffer.length = 0;
      replayAt = ageAt = pcsAt = Infinity;
      txState = 'FLUSH';
      step('FLUSH', reason + '。释放重放缓冲。');
      const policy = tx.llr_flush_behavior;
      step('FLUSH 期间上层来帧', policyText[policy] +
        (policy === 'BEST_EFFORT' && pcsDown ? '，PCS 仍未锁定，链路无法承载该帧。' : '。'),
        { upperFrame: policy, name: 'FLUSH · 上层来帧', wire: policy === 'BEST_EFFORT' && !pcsDown,
          counts: policy === 'DISCARD' ? counters(sender, 'tx_discard') : [] });
      if (test?.resetState === 'FLUSH') {
        resetSession();
        return;
      }
      if (tx.re_init_on_discard === 'TRUE') {
        now++;
        retries = 0;
        init();
      }
    }

    function scheduleFeedback() {
      if (feedbackPending || rxState === 'NACK_SENT') return;
      feedbackPending = true;
      // Teaching scheduler uses an aligned idle CtlOS opportunity on the reverse stream.
      let candidate = Math.max(now * 25 + rx.ctlos_target_spacing, nextCtlSlot);
      const stream = test?.reverseFrame;
      if (stream && candidate >= stream.start && candidate < stream.end) {
        candidate = Math.max(candidate, stream.start + 256);
        if (stream.previous !== undefined) candidate = Math.max(candidate, stream.previous + 2048);
        candidate = Math.min(candidate, stream.end);
      }
      const byte = Math.ceil(candidate / 8) * 8;
      schedule(Math.ceil(byte / 25), () => sendFeedback(byte));
    }

    function sendFeedback(byte) {
      feedbackPending = false;
      const nack = rxState === 'SEND_NACK';
      if (rxState !== 'SEND_ACKS' && !nack) return;
      const type = nack ? 2 : 1;
      const name = nack ? 'NACK' : 'ACK';
      const seq = mod(expected - 1);
      const lost = preset === 'timeout' || (test?.dropFeedback || []).includes(seq);
      nextCtlSlot = byte + 400;
      if (nack) rxState = 'NACK_SENT';
      const frame = test?.reverseFrame;
      const inFrame = frame && byte >= frame.start && byte < frame.end;
      step('插入 ' + name, inFrame ? '反向帧内插入，距帧首 ' + (byte - frame.start) + ' B。' : '接收端在反向空闲槽插入 8 B CtlOS。',
        { wire: true, backward: true, type, seq, name, lost, inFrame, ctlByte: byte,
          counts: counters(receiver, 'tx_' + name.toLowerCase() + '_ctl_os') });
      if (!lost) schedule(now + 80, () => receiveFeedback(type, seq, byte, inFrame));
    }

    function receiveFeedback(type, seq, byte, inFrame) {
      const nack = type === 2;
      const name = nack ? 'NACK' : 'ACK';
      const counts = counters(sender, 'rx_' + name.toLowerCase() + '_ctl_os');
      const position = buffer.findIndex(frame => frame.seq === seq);
      const legal = mod(txSeq - 1 - seq) <= 524288 && mod(seq - acknowledged) < 524288;
      if (!legal) {
        counts.push(...counters(sender, 'rx_ack_nack_seq_error'));
      } else if (position >= 0) {
        buffer.splice(0, position + 1);
        acknowledged = seq;
        retries = 0;
        ageAt = buffer.length ? now + tx.data_age_timer_max : Infinity;
        replayAt = buffer.length ? now + tx.replay_timer_max : Infinity;
      }
      if (nack) {
        retries = 0;
        replayAt = Infinity;
        nackDuringReplay = txState === 'REPLAY';
      }
      step(nack ? '收到 NACK' : '累计 ACK 与释放',
        '发送端收到反馈。累计确认序号字段为 ' + seq + '。',
        { backward: true, type, seq, name, inFrame, ctlByte: byte, counts });
      if (nack && buffer.length && txState === 'ADVANCE') beginReplay();
      else if (!nack && newFrames < frameCount && txState === 'ADVANCE') schedule(now + 21, sendNew);
    }

    function transmit(frame, replay) {
      const counts = counters(sender, 'tx_ok');
      const fault = replay && frame.fault !== 'poisoned' ? '' : frame.fault;
      if (lossless && !replay) creditSent++;
      if (fault === 'poisoned') counts[0] = sender + ' tx_poisoned';
      if (replayAt === Infinity) replayAt = now + tx.replay_timer_max;
      let rxResult = '按序交付';
      if (fault === 'lost') {
        rxResult = '接收端未收到';
      } else {
        const distance = mod(frame.seq - expected);
        const badFcs = fault === 'bad-fcs';
        const poisoned = fault === 'poisoned';
        counts.push(...counters(receiver, badFcs ? 'rx_bad' : poisoned ? 'rx_poisoned' : 'rx_ok'));
        if (test?.rxValid === false) {
          rxResult = '期望序号无效 · 丢弃';
        } else if (distance === 0 && !badFcs) {
          counts.push(...counters(receiver, poisoned ? 'rx_expected_seq_poisoned' : 'rx_expected_seq_good'));
          if (poisoned) rxResult = '按序接收 · 标记 frame_bad';
          if (lossless) {
            creditReceived++;
            schedule(now + 100, () => {
              creditReturned++;
              step('CF_Update · 信用归还', '教学示例中接收队列出队，归还一个信用。', { backward: true });
            });
          }
          if (rxState === 'NACK_SENT') counts.push(...counters(receiver, 'rx_replay'));
          expected = mod(expected + 1);
          rxState = 'SEND_ACKS';
        } else {
          rxResult = badFcs ? 'FCS 错误 · 丢弃' : distance < 0x80000 ? '序号缺口 · 丢弃' : '重复帧 · 丢弃';
          counts.push(...counters(receiver, distance === 0 ? 'rx_expected_seq_bad' :
            distance < 0x80000 ? 'rx_missing_seq' : 'rx_duplicate_seq'));
          if (rxState === 'SEND_ACKS' && distance < 0x80000) rxState = 'SEND_NACK';
        }
        scheduleFeedback();
      }
      const title = replay ? '重放帧 ' + frame.seq : '发送帧 ' + frame.seq;
      step(title, receiver + ' · ' + rxResult,
        { wire: true, seq: frame.seq, name: (replay ? 'Replay' : 'DATA') + ' · seq ' + frame.seq,
          lost: fault === 'lost', badFcs: fault === 'bad-fcs', replay, rxResult, counts });
    }

    function sendNew() {
      if (newFrames >= frameCount || buffer.length >= capacity || txState !== 'ADVANCE') return;
      const fault = newFrames === 0 ? { nack: 'lost', cbfc: 'lost', 'bad-fcs': 'bad-fcs', poisoned: 'poisoned' }[preset] : '';
      const frame = { seq: txSeq, fault: test?.faults?.[newFrames] ?? fault };
      txSeq = mod(txSeq + 1);
      newFrames++;
      buffer.push(frame);
      if (ageAt === Infinity) ageAt = now + tx.data_age_timer_max;
      transmit(frame, false);
      if (newFrames < frameCount) schedule(now + 21, sendNew);
    }

    function beginReplay() {
      txState = 'REPLAY';
      nackDuringReplay = false;
      replayAt = Infinity;
      step('进入 REPLAY', '从未确认队首开始，保留原始序号。');
      const frames = buffer.slice();
      frames.forEach((frame, i) => schedule(now + 21 * (i + 1), () => {
        if (!nackDuringReplay && buffer.includes(frame)) transmit(frame, true);
      }));
      schedule(now + 21 * frames.length, () => {
        if (!nackDuringReplay) retries++;
        txState = 'ADVANCE';
        step('重放完成', 'TX 退出 REPLAY。', { counts: counters(sender, 'tx_replay') });
        if (nackDuringReplay && buffer.length) beginReplay();
        else if (newFrames < frameCount && buffer.length < capacity) schedule(now + 21, sendNew);
      });
    }

    if (tx.outstanding_seq_max > 524288 || tx.outstanding_seq_max < 0 || (cbfc && packetType === 'B')) {
      txState = 'LLR_OFF';
      rxState = 'OFF';
      step('配置无效', cbfc ? 'Type B 无法与 LLR 联合使用。' : 'outstanding_seq_max 超出范围。');
      return timeline;
    }
    if (preset === 'duplex') {
      const left = simulate(test.forward, { ...test, sender });
      const right = simulate(test.backward, { ...test, sender:receiver });
      return left.concat(right).sort((a,b) => a[10].time - b[10].time);
    }
    if (preset === 'arbitration') {
      // ACK and NACK are mutually exclusive. Run against one pending feedback type.
      const llr = [4, 3, test.nack ? 2 : 1];
      let cfPending = true;
      for (let slot = 0; llr.length || cfPending; slot++) {
        const byte = 2048 * (slot + 1);
        now = Math.ceil(byte / 25);
        if (slot % 2 && cfPending) {
          cfPending = false;
          step('CF_Update', '轮询仲裁授权 CBFC。', { backward:true, ctlByte:byte });
        } else {
          const type = llr.shift();
          const name = ['','ACK','NACK','INIT','INIT_ECHO'][type];
          step(name, '轮询仲裁授权 LLR，按表 5-12 选出当前最高优先级。', { backward:true, wire:true, type, seq:10, name, ctlByte:byte });
        }
      }
      return timeline;
    }
    if (cbfc && packetType === 'A') {
      step('接收 Type A', '丢弃窗口内仍交付 LLR-ineligible 的最佳努力帧。', { rxResult:'普通帧交付' });
      return timeline;
    }
    if (preset === 'lldp') {
      const versions = test?.versions || Object.fromEntries(['A', 'B'].map(endpoint =>
        [endpoint, get('lldp-' + endpoint.toLowerCase()).value]));
      const wanted = value => value === 'v0' || value === 'v1';
      const enabled = wanted(versions.A) && wanted(versions.B);
      const advertise = (endpoint, confirmed) => {
        const version = versions[endpoint];
        if (version === 'none') return '无 UE Options TLV';
        const e = confirmed && enabled ? (version === 'v0' ? 1 : 3) : 0;
        const w = version.startsWith('reserved') ? Number(version.slice(-1)) : wanted(version) ? 3 : 0;
        return (wanted(version) ? version : 'v1') + ' · W=' + w + ' · E=' + e;
      };
      txState = 'LLR_OFF';
      rxState = 'OFF';
      step('交换 LLDP 意愿', 'A ' + advertise('A', false) + ' ｜ B ' + advertise('B', false));
      now += 80;
      step('交换 LLDP 启用状态', 'A ' + advertise('A', true) + ' ｜ B ' + advertise('B', true));
      now += 80;
      if (enabled) {
        txSeq = expected = 0;
        init();
      } else {
        step('继续普通以太网', '双方未同时启用 LLR。');
      }
      return timeline;
    }
    if (tx.llr_mode_remote === 'OFF') {
      txState = 'LLR_OFF';
      rxState = rx.llr_mode_local === 'OFF' ? 'OFF' : '—';
      step('LLR_OFF', '发送端使用普通以太网流程。');
      return timeline;
    }
    if (preset === 'init' || preset === 'init-fail' || rx.llr_mode_local === 'OFF') {
      txSeq = expected = 0;
      rxState = 'OFF';
      init();
      return timeline;
    }
    if (preset === 'pcs') {
      pcsAt = tx.pcs_lost_status_timer_max;
      step('PCS_status = FALSE', '链路持续失锁。');
    } else if (!capacity) {
      step('等待窗口可用', '未确认窗口容不下一帧 512 B。');
    } else {
      sendNew();
      if (capacity === 1) step('等待窗口可用', '下一帧等待累计确认释放窗口。');
    }
    for (const injection of test?.injections || []) {
      schedule(injection.time, () => {
        if (injection.kind === 'pcs-up') {
          pcsAt = Infinity;
          step('恢复锁定', 'PCS_status=TRUE');
        } else if (injection.kind === 'CF_Update' || injection.kind === 'CC_Update') {
          const discard = injection.kind === 'CC_Update' && rxState !== 'SEND_ACKS';
          step(injection.kind, discard ? '丢弃窗口内过滤信用计数更新帧。' : '接收信用控制消息。',
            { rxResult:discard ? '丢弃' : '接收' });
        } else if (injection.kind === 'pcs-down') {
          pcsAt = now + tx.pcs_lost_status_timer_max;
          step('PCS 失锁', '启动失锁计时器。');
        } else if (injection.kind === 'reset') {
          resetSession();
        } else receiveFeedback(injection.kind === 'nack' ? 2 : 1, injection.seq);
      });
    }
    // The event budget limits the preview only. It never triggers FLUSH.
    while (timeline.length < eventLimit) {
      queue.sort((a, b) => a.time - b.time);
      const job = queue[0];
      const timer = txState === 'ADVANCE' ? Math.max(now, replayAt) : Infinity;
      now = Math.min(job?.time ?? Infinity, timer, ageAt, pcsAt);
      if (!Number.isFinite(now)) break;
      if (now === pcsAt || now === ageAt) {
        flush(now === pcsAt ? 'PCS 失锁定时器到期' : '数据驻留定时器到期');
        break;
      }
      if (job?.time === now) {
        queue.shift().run();
      } else if (tx.replay_ct_max !== 255 && retries >= tx.replay_ct_max) {
        flush('重放定时器到期且已达到连续重放上限');
        break;
      } else {
        step('重放定时器到期', '发送端仍有未确认帧。');
        beginReplay();
      }
    }
    if (timeline.length >= eventLimit) step('预览结束', '已达到动画事件显示上限。');
    return timeline;
  }

  const caseGroups = [
    ['D', '常用收发与故障'],
    ['N', 'LLDP 协商'],
    ['I', '初始化与回显'],
    ['R', '确认与重放'],
    ['F', 'INIT / FLUSH 处理策略'],
    ['B01 B02 B03', '序号与窗口判定'],
    ['B04', '缓冲与发送准入'],
    ['B05 B06 B07', '定时器与重放上限'],
    ['B08', 'CtlOS 插入与仲裁'],
    ['B09', 'CBFC 信用'],
    ['B10', '双向收发与复位'],
    ['组合回归', '组合回归']
  ];
  function caseMatches(result, prefixes) {
    const code = result.name.split(' ')[0];
    return prefixes.split(' ').some(prefix =>
      prefix.length === 1 ? code.startsWith(prefix) : code === prefix);
  }
  const runCases = (play = true) => {
    const list = get('case-list');
    const category = get('case-category');
    const selectedName = list.value;
    const results = window.LLRVerification.run(simulate);
    category.replaceChildren(...caseGroups.map(([key, title]) =>
      new Option(title + '（' + results.filter(result => caseMatches(result, key)).length + '）', key)));
    category.disabled = false;
    const selectedResult = () => results.find(result => result.name === list.value);
    function filterCases(preferredName) {
      const filtered = results.filter(result => caseMatches(result, category.value));
      list.replaceChildren(...filtered.map(result =>
        new Option((result.error ? '失败' : '通过') + ' · ' + result.name, result.name)));
      if (filtered.some(result => result.name === preferredName)) list.value = preferredName;
      list.disabled = filtered.length === 0;
      get('case-export').disabled = list.disabled;
    }
    const failures = results.filter(result => result.error);
    get('case-status').textContent = (results.length - failures.length) + ' / ' + results.length +
      ' 通过' + (failures.length ? ' · ' + failures[0].name + ' · ' + failures[0].error : '');
    const display = () => {
      const result = selectedResult();
      if (!result) return;
      clearTimeout(refreshTimer);
      const scenario = get('scenario');
      const replayOption = scenario.querySelector('[value="verification"]');
      const status = get('register-status');
      get('case-description').textContent = result.name + ' · ' + result.check +
        (result.error ? ' · ' + result.error : '');
      if (!result.trace?.length) {
        if (scenario.value === 'verification') {
          scenario.value = 'registers';
          reset();
        }
        replayOption?.remove();
        status.textContent = '此用例没有可回放的事件。';
        return;
      }
      steps.verification = result.trace;
      const replayLabel = '用例回放 · ' + result.name;
      if (replayOption) replayOption.textContent = replayLabel;
      else scenario.add(new Option(replayLabel, 'verification'));
      scenario.value = 'verification';
      status.textContent = '正在回放 ' + result.name + ' · ' + result.trace.length + ' 个事件';
      reset();
    };
    const normal = results.findIndex(result => result.preset === 'normal' && result.name.startsWith('D01 '));
    const selected = results.findIndex(result => result.name === selectedName);
    const fallback = failures.length ? results.indexOf(failures[0]) : Math.max(0, normal);
    const initial = results[selected >= 0 ? selected : fallback];
    category.value = caseGroups.find(([key]) => caseMatches(initial, key))[0];
    filterCases(initial.name);
    category.onchange = () => {
      filterCases();
      display();
    };
    get('case-export').onclick = () => {
      const result = selectedResult();
      if (!result) return;
      const report = { specification: 'UE 1.1', assumptions: '200 Gb/s，512 B，80 ns 反馈传输；同拍驻留/失锁到期优先，其次队列事件，最后重放超时。',
        results: results.map(({ trace, ...summary }) => summary), selected: result.name, trace: result.trace || [] };
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type:'application/json'}));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'llr-verification.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    list.onchange = display;
    display();
    if (play && get('scenario').value === 'verification') startPlayback();
  };
  function loadCases(play) {
    const status = get('case-status');
    try {
      if (!window.LLRVerification?.run) {
        status.textContent = '用例脚本加载失败。请重新加载页面，离线使用时请保留 visual-pcs-assets 目录。';
        return;
      }
      runCases(play);
    } catch (error) {
      status.textContent = '用例运行失败 · ' + error.message;
      console.error(error);
    }
  }
  get('run-cases').onclick = () => loadCases(true);
  get('case-picker').addEventListener('toggle', () => {
    if (!get('case-picker').open) return;
    if (get('case-category').disabled) loadCases(false);
    else if (get('scenario').value !== 'verification') get('case-list').onchange();
  });
  steps.registers = simulate();
  function applyRegisters(restart) {
    clearTimeout(refreshTimer);
    const invalid = ['A', 'B'].map(endpoint => ({
      endpoint, input: controls[endpoint].find(input => !input.validity.valid)
    })).find(entry => entry.input);
    const status = get('register-status');
    if (invalid) {
      status.textContent = invalid.endpoint + ' 端 · ' + invalid.input.name + ' · ' +
        invalid.input.validationMessage + ' 仿真仍显示上次有效结果。';
      return;
    }
    const previous = get('scenario').value === 'registers' && !restart ? index : 0;
    const title = steps.registers[previous][0];
    steps.registers = simulate();
    const sameStep = steps.registers[previous]?.[0] === title
      ? previous : steps.registers.findIndex(row => row[0] === title);
    const next = restart ? 0 : sameStep >= 0 ? sameStep : Math.min(previous, steps.registers.length - 1);
    get('scenario').value = 'registers';
    status.textContent = '仿真已更新 · ' + (get('register-direction').value === 'A' ? 'A → B' : 'B → A') +
      ' · ' + steps.registers.length + ' 个事件';
    reset(next);
  }
  form.onsubmit = event => {
    event.preventDefault();
    applyRegisters(true);
  };
  form.onreset = () => {
    queueMicrotask(() => {
      updatePorts();
      applyRegisters(true);
    });
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
    get('view-mode').onchange = get('fit').onclick;
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
    signal.visible = !simulation || Boolean(simulation.wire || simulation.upperFrame);
    signal.position.set((reverse ? 1 : -1) * extent * (1 - 2 * progress), reverse ? -10 : 10, 1.8);
    if (simulation?.upperFrame && !simulation.wire) {
      signal.position.x = reverse ? extent : -extent;
      signal.position.y += (1 - progress) * 12;
      signal.material.color.setHex(simulation.upperFrame === 'DISCARD' ? 0xd65a51 : 0xe2a41f);
    } else if (isLostStep()) {
      const lossX = lossPosition(reverse);
      signal.position.x = reverse ? Math.max(lossX, signal.position.x) : Math.min(lossX, signal.position.x);
      signal.material.color.setHex(0xd65a51);
    } else {
      const result = current()[10];
      const discarded = result?.rxResult?.includes('丢弃');
      signal.material.color.setHex(discarded ? 0xd65a51 : result?.replay ? 0x8c67d4 : reverse ? 0xe2a41f : 0x22a579);
    }
    const viewMode = get('view-mode').value;
    const selection = visibleStages[viewMode];
    const summaries = stageSummaries();
    modules.forEach(({ mesh, label, summary }) => {
      const { stage, x } = mesh.userData;
      const slot = selection ? selection.indexOf(stage) : stage;
      mesh.visible = slot !== -1;
      label.hidden = !mesh.visible;
      if (!mesh.visible) return;
      mesh.position.x = selection
        ? extent * (2 * slot / (selection.length - 1) - 1) * (mesh.userData.reverse ? -1 : 1)
        : x;
      const enabled = mesh.userData.reverse === reverse;
      mesh.material.color.setHex(mesh.userData.color);
      mesh.material.color.multiplyScalar(enabled ? 1 : .55);
      label.classList.toggle('is-inactive', !enabled);
      const p = mesh.position.clone().project(camera);
      label.style.left = (p.x * 50 + 50) + '%';
      label.classList.toggle('llr-hop-below', slot % 2 === 1);
      const summaryIndex = visibleStages.main.indexOf(stage);
      summary.textContent = selection && enabled && signal.visible ? summaries[summaryIndex] : '';
      label.style.top = (50 - p.y * 50) + '%';
    });
    get('scene').querySelectorAll('.llr-labels b').forEach((label, i) => {
      const point = new T.Vector3([-extent, 0, extent][i % 3], i < 3 ? 19 : -19, 0).project(camera);
      label.style.left = (50 + 50 * point.x) + '%';
      label.style.top = (50 - 50 * point.y) + '%';
    });
    updatePacketCallout(viewMode, selection, summaries);
    renderer.render(scene, camera);

  }

  function updatePacketCallout(viewMode, selection, summaries) {
    const callout = get('packet-callout');
    const point = signal.position.clone().project(camera);
    callout.hidden = !signal.visible || Math.abs(point.x) > 1 || Math.abs(point.y) > 1;
    if (callout.hidden) return;
    const [, name, reverse] = current();
    const travel = (1 + signal.position.x / extent * (reverse ? -1 : 1)) / 2;
    const slot = Math.min((selection || stages).length - 1,
      Math.floor(travel * ((selection || stages).length - 1) + 1e-6));
    const stage = selection ? selection[slot] : slot;
    const preview = summaries[visibleStages.main.indexOf(stage)];
    let format = stages[stage][0] + ' · ' + wireFormats[stage];
    if (viewMode === 'endpoint') {
      format = travel >= 1 ? '接收处理 · ' + summaries.at(-1) : '发送 LLR 数据 · ' + summaries[0];
    } else if (preview) {
      format = stages[stage][0] + ' · ' + preview;
    }
    if (isLostStep() && Math.abs(signal.position.x - lossPosition(reverse)) < .01) {
      format = current()[4] ? 'CtlOS 在链路中丢失' : '帧在链路中丢失';
    }
    if (current()[10]?.rxResult && travel >= 1) format = '接收处理 · ' + current()[10].rxResult;
    const upperFrame = current()[10]?.upperFrame;
    if (upperFrame) {
      format = policyText[upperFrame];
      if (upperFrame === 'BEST_EFFORT' && !current()[10].wire) format += ' · PCS 未锁定';
    }
    const title = get('packet-name');
    const detail = get('packet-format');
    if (title.textContent !== name) title.textContent = name;
    if (detail.textContent !== format) detail.textContent = format;
    const sequence = get('packet-seq');
    const sequenceText = negotiating() || upperFrame ? '' : sequenceLabel(current());
    if (sequence.textContent !== sequenceText) sequence.textContent = sequenceText;
    callout.style.setProperty('--llr-packet-x', (50 + 50 * point.x) + '%');
    callout.style.top = (50 - 50 * point.y) + '%';
    callout.classList.toggle('llr-packet-below', point.y > .62);
  }

  const bits = (value, width = 8) => Array.from({ length: width }, (_, i) => (value >> i) & 1).join('');
  const ctlBytes = (type, seq, data) =>
    [0x5c, type, seq >> 12, (seq >> 4) & 255, ((seq & 15) << 4) | 6, data >> 8, data & 255, 0];
  const preamble = seq => [0xfb, ((seq >> 16) << 4) | 7, (seq >> 8) & 255, seq & 255, 0x55, 0x55, 0x55, 0xd5];
  const sequenceHex = seq => '0x' + hex(seq).padStart(5, '0');
  const sequenceField = type => type >= 3 ? 'init_seq' : type ? 'ack_nack_seq' : 'frame_seq';
  const sequenceLabel = ([, , , , type, seq]) => sequenceField(type) + '=' + sequenceHex(seq) + ' (' + seq + ')';

  function wireData(type, seq, data) {
    const bytes = type ? ctlBytes(type, seq, data) : preamble(seq);
    const blockType = type ? 0x4b : 0x78;
    const payload = bytes.map(value => bits(value)).slice(1);
    if (type) payload[3] = bits(bytes[4] & 15, 4) + bits(bytes[4] >> 4, 4);
    return { bytes, blockType, blockBits: ['10', bits(blockType), ...payload] };
  }

  function fieldDetails(type, seq, data) {
    const field = sequenceField(type);
    const locations = type
      ? ['D2[7:0] = [19:12]', 'D3[7:0] = [11:4]', 'D4[7:4] = [3:0]']
      : ['D1[7:4] = [19:16]', 'D2[7:0] = [15:8]', 'D3[7:0] = [7:0]'];
    let text = '<p><code>' + field + '=' + sequenceHex(seq) + '</code> · ' + seq +
      '（十进制） · 20 位 · ' + seq.toString(2).padStart(20, '0') + '</p>' +
      '<p>' + locations.join(' ｜ ') + '</p>';
    if (type >= 3) {
      text += '<p>D5–D6 · <code>init_data=0x' + hex(data).padStart(4, '0') + '</code> ｜ D7=0x00</p>';
    } else if (type) {
      text += '<p>确认序号表示最近成功接收的帧。D5–D7 均为 0x00。</p>';
    } else {
      text += '<p>D1[3:0]=0x7 ｜ D4–D6=55 55 55 ｜ D7=0xD5（SFD）。显示范围为起始块。</p>';
    }
    return text;
  }

  function lossPosition(reverse) {
    return get('view-mode').value === 'all' ? (10 * spacing - extent) * (reverse ? -1 : 1) : 0;
  }

  function isLostStep() {
    return Boolean(current()[10]?.lost) || (get('scenario').value === 'replay' && index === 0);
  }

  function stageSummaries() {
    const [, , , , type, seq, data] = current();
    const upperFrame = current()[10]?.upperFrame;
    if (upperFrame) {
      return current()[10].wire
        ? ['普通帧', '66b 块', '257b 块', 'RS(544,514)', '线路信号', '恢复数据', '还原 66b', 'xMII 字节', '普通帧']
        : [policyText[upperFrame], '—', '—', '—', '—', '—', '—', '—', '—'];
    }
    if (negotiating()) {
      return ['LLDP Options TLV', '66b 块', '257b 块', 'RS(544,514)', '线路信号',
        '已恢复符号', '还原 66b', 'xMII 字节', '解析 LLDP'];
    }
    const { bytes, blockType } = wireData(type, seq, data);
    const start = bytes.slice(0, 4).map(hex).join(' ');
    const block = '10 · 0x' + hex(blockType);
    const lost = isLostStep();
    return [start + ' …', block, '4 × 66b → 257b', '514 + 30 符号',
      lost ? '帧在此丢失' : '线路信号',
      ...(lost ? ['未收到', '—', '—', '—']
        : ['恢复 514 符号', block, start + ' …', current()[10]?.rxResult || sequenceField(type) + '=' + sequenceHex(seq)])];
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
    const result = current()[10]?.rxResult;
    if (result && (!target || target.stage > 10)) {
      detail += '<p><strong>RX 结果 · ' + result + '</strong></p>';
      if (result !== '按序交付') detail += '<p>以下编码为发送端参考。</p>';
    }
    if (current()[10]?.upperFrame) {
      if (current()[10].wire) {
        detail += '<p>普通帧使用标准前导码。</p>' + byteView([0xfb, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0xd5]);
      }
    } else if (current()[10] && !current()[10].wire) {
      detail += '<p>本步显示本地状态转换。</p>';
    } else if (target && target.reverse !== reverse) {
      detail += '<p>该方向在本步没有演示信号。</p>';
    } else if (negotiating()) {
      detail += '<p>LLDP 的 UE Link Negotiation Options TLV 随 MAC 帧传送。查看下方步骤说明中的 LLR-W 和 LLR-E。</p>' +
        '<p>' + current()[7] + '（A） ｜ ' + current()[8] + '（B）</p>';
    } else {
      const { bytes, blockType, blockBits } = wireData(type, seq, data);
      detail += fieldDetails(type, seq, data);
      if (isLostStep() && target?.stage > 10) {
        detail += '<p>接收端未收到该信号。</p>';
        get('format-body').innerHTML = detail;
        if (!formatDialog.open) formatDialog.showModal();
        return;
      }
      const showOctets = !target || target.format === 0;
      if (showOctets) detail += '<h4>' + (type ? 'xMII CtlOS 字节' : 'xMII 修改后的前导码') + '</h4>' + byteView(bytes);
      if (target?.format === 1 || (!target && get('view-mode').value !== 'endpoint')) {
        detail += '<h4>64B/66B 控制块</h4>' +
          '<p>同步头 10 · 块类型 0x' + hex(blockType) + (type ? ' · O-code 0x6' : ' · 20 位 frame_seq') + '</p>' +
          '<pre class="pcs-fault-bits">' + blockBits.join(' ') + '</pre>';
      }
      if (target && (target.format === 2 || target.format === 3 || target.format === 4 || target.format === 5)) {
        const transcoded = transcodeSample(blockBits.slice(1));
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
              i + ' 消息[0…513] ' + symbols(message) +
              ' | 校验[0…29] ' + symbols(parity)).join(String.fromCharCode(10)) + '</pre>' +
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
        cell.textContent = simulation ? entry?.count || 0 : '—';
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

  function updateStateOverlays(tx, simulation) {
    const sender = simulation?.sender || 'A';
    const receiver = simulation?.receiver || 'B';
    const scenario = get('scenario').value;
    const isNegotiation = negotiating();
    const txStates = { '等待回显': 'INIT', '收到 NACK': 'ADVANCE' };
    const history = active().slice(0, index + 1);
    const startsWithInit = scenario === 'init' || history[0][7] === 'INIT';
    let rxState = startsWithInit ? 'OFF' : 'SEND_ACKS';
    if (tx === 'LLR_OFF') rxState = '—';
    for (const step of history) {
      const type = step[4];
      if (type === 4 || type === 1) rxState = 'SEND_ACKS';
      else if (type === 2) rxState = 'NACK_SENT';
      else if ((step[8] === '期望 10' && step[5] === 11) || step[10]?.badFcs) rxState = 'SEND_NACK';
      else if (step[7] === 'REPLAY' && (!step[10] || step[10].wire)) rxState = 'SEND_ACKS';
    }
    const portStates = {};
    if (simulation) {
      for (const row of history) {
        const event = row[10];
        (portStates[event.sender] ??= {}).tx = event.txState;
        (portStates[event.receiver] ??= {}).rx = event.rxState;
      }
    }
    for (const endpoint of ['A', 'B']) {
      const prefix = 'state-' + endpoint.toLowerCase();
      const states = simulation ? {
        tx: portStates[endpoint]?.tx ?? '—',
        rx: portStates[endpoint]?.rx ?? '—'
      } : {
        tx: isNegotiation ? 'LLR_OFF' : endpoint === sender ? txStates[tx] || tx : '—',
        rx: isNegotiation ? 'OFF' : endpoint === receiver ? rxState : '—'
      };
      for (const [path, state] of Object.entries(states)) {
        const cell = get(prefix + '-' + path);
        cell.textContent = state;
        cell.removeAttribute('title');
        cell.closest('span').classList.toggle('is-current', state !== '—');
      }
    }
  }

  function ctlSlotView(byte, inFrame) {
    if (byte === undefined) return '';
    return '<figure class="llr-ctl-slot"><figcaption>反向 PCS 流 · 字节偏移</figcaption>' +
      '<div><span>… ' + (inFrame ? 'Data' : 'Idle') + '</span><strong>CtlOS · ' + byte + '–' + (byte + 7) +
      ' B</strong><span>' + (byte + 8) + ' B · ' + (inFrame ? 'Data' : 'Idle') + ' …</span></div></figure>';
  }

  function update() {
    const [title, signalName, reverse, note, type, seq, data, tx, rx, buffer] = current();
    const bytes = type ? wireData(type, seq, data).bytes : [];
    const simulation = current()[10];
    get('format').disabled = Boolean(simulation && !simulation.wire);
    renderCounters(simulation);
    updateStateOverlays(tx, simulation);
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
      ctlSlotView(simulation?.ctlByte, simulation?.inFrame) +
      (simulation?.cbfc ? '<p>CBFC（单 VC 教学计数） · S_VC_CC=' + simulation.creditSent +
        ' ｜ R_VC_CC=' + simulation.creditReceived + ' ｜ 已归还=' + simulation.creditReturned + '</p>' : '') +
      (simulation?.txSeq === undefined ? '' : '<p>tx_seq=' + simulation.txSeq +
        ' ｜ next_rx_seq=' + simulation.expected + ' ｜ acked_seq=' + simulation.acknowledged +
        ' ｜ replay_ct=' + simulation.retries + '</p><p>到期时间（ns） · 重放 ' +
        (Number.isFinite(simulation.replayAt) ? simulation.replayAt : '—') + ' ｜ 驻留 ' +
        (Number.isFinite(simulation.ageAt) ? simulation.ageAt : '—') + ' ｜ PCS ' +
        (Number.isFinite(simulation.pcsAt) ? simulation.pcsAt : '—') + '</p>') +
      (type ? '<div class="pcs-rx-bytes">' + bytes.map((b, i) => '<span>' + hex(b) + '<small>D' + i + '</small></span>').join('') +
        '</div>' + fieldDetails(type, seq, data) + '<p class="note">xMII：Lane 0 为控制字符 0x5C，D1 为消息类型。PCS：同步头 10，块类型 0x4B，O-code 0x6。</p>'
        : simulation && (!simulation.wire || simulation.upperFrame) ? '' : '<p class="note">LLR-eligible 数据帧的 20 位 frame_seq 位于修改后的前导码。此步序号为 ' + sequenceLabel(current()) + '。</p>'));
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
    lastFrameTime = null;
    update();
  }
  function select(i) { index = i; elapsed = 0; lastFrameTime = null; update(); }
  function tick(now) {
    if (!running || panel.hidden) return;
    if (lastFrameTime !== null) {
      elapsed += (now - lastFrameTime) * Number(get('speed').value);
    }
    lastFrameTime = now;
    if (elapsed >= duration) {
      if (index + 1 === active().length) { pause(); return; }
      select(index + 1);
    }
    draw();
    frame = requestAnimationFrame(tick);
  }
  function reset(step = 0) {
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
    select(step);
  }
  get('scenario').onchange = () => {
    clearTimeout(refreshTimer);
    if (get('scenario').value === 'registers') {
      updatePorts();
      applyRegisters(true);
    }
    reset();
  };
  get('reset').onclick = () => reset();
  get('prev').onclick = () => { pause(); select(Math.max(0, index - 1)); };
  get('next').onclick = () => { pause(); select(Math.min(index + 1, active().length - 1)); };
  function startPlayback() {
    if (elapsed >= duration) select(0);
    running = true;
    update();
    frame = requestAnimationFrame(tick);
  }
  get('play').onclick = () => {
    if (running) pause();
    else startPlayback();
  };
  new MutationObserver(() => {
    if (panel.hidden) pause();
    else { setup(); draw(); }
  }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  if (!panel.hidden) setup();
  reset();
})(window.THREE);
