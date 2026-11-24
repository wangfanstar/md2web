(() => {
  'use strict';
  const el = id => document.getElementById('cb-' + id);
  // UE 1.1 §5.2.5.3：CC/CU/CL 为 20 位循环计数器，CF 为 15 位。
  const CC_MOD = 1 << 20;
  const CF_MOD = 1 << 15;
  const wrapCC = v => ((v % CC_MOD) + CC_MOD) % CC_MOD;
  const wrapCF = v => ((v % CF_MOD) + CF_MOD) % CF_MOD;
  const hex = (v, width) => v.toString(16).toUpperCase().padStart(width || 2, '0');
  const hexCC = v => hex(wrapCC(v), 5);
  const hexCF = v => hex(wrapCF(v), 4);

  const cases = {
    '初始化与状态': [
      {
        name: '端口复位与初始 TLV',
        desc: '5.2.8.3：端口复位后所有 VC 为尽力而为；接收端随后写入 R_NumVCs、R_TotalCredits、R_CellSize、R_PktOvhd 和 R_VC_Want。',
        ops: ['rst', 'rxinit:1', 'lldp1']
      },
      {
        name: '完整无损 VC 上线（LLDP 7 步）',
        desc: '5.2.8.4：Want → LLDP → 发送端 RTS → LLDP → 接收端 RTR → LLDP → 启用无损发送，最后验证一帧。',
        ops: ['rst', 'rxinit:1', 'lldp1', 'txinit:1', 'lldp2', 'rxready:1', 'lldp3', 'enable:1',
          'tx:1', 'rx:1', 'drain:1', 'cf:1']
      },
      {
        name: '握手未完成就发帧',
        desc: '发送端在 S_VC_RTS[x] 与 R_VC_RTR[x] 同时为 1 前不得使用信用发送；本用例停在发送端初始化之后。',
        ops: ['rst', 'rxinit:1', 'lldp1', 'txinit:1', 'tx:1']
      },
      {
        name: '端口复位清空计数',
        desc: '端口复位把全部 VC 恢复为尽力而为并清零；注意 S_P_CU 只在端口复位时清零（5.2.8.4 脚注 17）。',
        ops: ['up:1', 'tx:1', 'rx:1', 'drain:1', 'cf:1', 'rst']
      }
    ],
    '正常传输': [
      {
        name: '单帧与信用归还',
        desc: '5.2.5.6–5.2.5.7：发送端扣减 CC/CU，接收端累计 CC，排空后累计 CF，CF_Update 归还原信用。',
        ops: ['up:1', 'tx:1', 'rx:1', 'drain:1', 'cf:1']
      },
      {
        name: '连续两帧',
        desc: '同一 VC 连续发送两帧，每帧按 pktCredits = roundup((frame + PktOvhd) / CreditSize) 扣除。',
        ops: ['up:1', 'tx:1', 'rx:1', 'tx:1', 'rx:1', 'drain:1', 'cf:1']
      },
      {
        name: '尽力而为 VC',
        desc: '尽力而为 VC 不参与信用检查、不消耗信用，也不更新 CBFC 计数器（5.2.5.6.1、5.2.7.3 注 1）。',
        ops: ['up:1', 'be:0']
      },
      {
        name: '32 个 VC 轮流收发',
        desc: 'NumVCs = 32 时逐 VC 独立计数；本用例让 32 个 VC 各发一帧，观察端口与 VC 计数保持一致。',
        ops: ['upall'].concat(Array.from({ length: 32 }, (_, i) =>
          ['tx:' + i, 'rx:' + i, 'drain:' + i, 'cf:' + i]).flat())
      }
    ],
    '准入与背压': [
      {
        name: '额度恰好耗尽',
        desc: '5.2.5.6.1：S_VC_CU[x] + pktCredits ≤ S_VC_CL[x] 才允许发送；额度用尽后调度器必须等待信用归还。',
        setup: { mode: 'vc', limit: 3 },
        ops: ['up:1', 'tx:1', 'rx:1', 'tx:1', 'rx:1']
      },
      {
        name: '端口共享额度竞争',
        desc: 'TotalCredits 模式下只检查 S_P_CU + pktCredits ≤ S_P_CL；两个 VC 共享同一端口额度。',
        setup: { mode: 'port', limit: 4 },
        ops: ['upall', 'tx:1', 'rx:1', 'tx:2', 'rx:2', 'tx:1']
      },
      {
        name: '信用不足等待重试',
        desc: '被准入阻塞的帧留在队列中；收到 CF_Update 后重试同一帧应通过检查。',
        ops: ['up:1', 'tx:1', 'rx:1', 'tx:1', 'rx:1', 'retry:1', 'drain:1', 'cf:1', 'retry:1']
      }
    ],
    '定时器与反馈': [
      {
        name: 'CF_min_timer 合并更新',
        desc: '5.2.5.7.3：R_VC_CF 更新后需等 CF_min_timer 到期才发送；期间新的释放量合并到下一次通告。',
        ops: ['up:1', 'tx:1', 'rx:1', 'drain:1', 'cfwait:1', 'drain:1', 'cf:1']
      },
      {
        name: 'CF_Update 丢失与 CF_max_timer',
        desc: 'CF_Update 丢失后信用不会归还；CF_max_timer 到期时重发累计 R_VC_CF，自动补齐丢失的更新。',
        ops: ['up:1', 'tx:1', 'rx:1', 'drain:1', 'cflost:1', 'cfmax:1']
      },
      {
        name: 'CC_Update 周期回收',
        desc: '5.2.5.6.4：CC_Update 按 CC_msg_timer 周期发送，每个包覆盖 16 个 VC（VC 0–15 或 16–31）。',
        ops: ['up:1', 'tx:1', 'rx:1', 'drain:1', 'ccgen', 'ccrx']
      }
    ],
    '异常恢复': [
      {
        name: '数据帧丢失与信用回收',
        desc: '链路错误丢弃数据帧后接收端从未累计该帧 CC，形成信用泄漏；CC_Update 让接收端按发送端 CC 补齐差额。',
        ops: ['up:1', 'tx:1', 'loss:1', 'ccgen', 'ccrx', 'drain:1', 'cf:1']
      },
      {
        name: 'CC_Update 在 LLR 丢弃窗被丢弃',
        desc: '5.2.9：CC_Update 必须标记为 LLR-eligible；在 LLR 丢弃窗内被丢弃时不改动 R_VC_CC，等待重放。',
        ops: ['up:1', 'tx:1', 'loss:1', 'ccdrop', 'ccgen', 'ccrx']
      },
      {
        name: 'LostCredits 超范围上报',
        desc: '5.2.5.7.4：LostCredits 小于 0 或大于 2^14−1 属严重错误，应向管理实体上报而不是修正计数器。',
        ops: ['up:1', 'ccbad:1', 'ccgen', 'ccrx']
      },
      {
        name: '20 位 CC 与 15 位 CF 回绕',
        desc: '5.2.4.2：计数器按模数回绕，比较时差值必须小于计数器最大值的一半；回绕后信用差仍应正确。',
        ops: ['up:1', 'wrap:1', 'tx:1', 'rx:1', 'drain:1', 'cf:1']
      }
    ],
    'VC 变更': [
      {
        name: '在线新增第二个无损 VC',
        desc: '5.2.8.4：链路运行时可为新 VC 重启初始化流程；R_CellSize 与 R_PktOvhd 不得改变，信用上限分配方式沿用原有 VC。',
        ops: ['up:1', 'add:2', 'tx:2', 'rx:2', 'drain:2', 'cf:2']
      },
      {
        name: '移除无损 VC（7 步）',
        desc: '5.2.8.5：Want=0 → 发送端停止入队并排空 → RTS=0 → 接收端排空缓冲并归还信用 → RTR=0 → VC 转为尽力而为。',
        ops: ['up:1', 'rmwant:1', 'rmlldp1', 'rmdrain:1', 'rmrts:1', 'rmlldp2',
          'rmreturn:1', 'rmlldp3', 'rmdone:1']
      }
    ]
  };

  let S, R, V, inflight, dirty, phase, events, index, timer, activeVC;
  let lastCC, cfDirty, cfWait, cfMaxDue, ccDue;

  const activeInput = () => el('vc');

  function cfg() {
    return {
      unit: +el('unit').value,
      over: +el('over').value,
      size: +el('size').value,
      limit: +el('limit').value,
      mode: el('mode').value
    };
  }
  function pktCredits() {
    const c = cfg();
    return Math.max(1, Math.ceil((c.size + c.over) / c.unit));
  }
  function mark(key, delta) {
    if (key) dirty.set(key, delta || '');
  }
  function phaseOf() { return phase; }

  function blank() {
    S = {
      pcl: 0, pcu: 0,
      cl: Array(32).fill(0), cu: Array(32).fill(0),
      cc: Array(32).fill(0), cf: Array(32).fill(0)
    };
    R = { cc: Array(32).fill(0), cf: Array(32).fill(0), buf: Array(32).fill(0), total: 0 };
    V = Array.from({ length: 32 }, () => ({ want: 0, rts: 0, rtr: 0, lossless: 0 }));
    inflight = Array(32).fill(0);
    dirty = new Map();
    lastCC = null;
    cfDirty = false;
    cfWait = false;
    cfMaxDue = false;
    ccDue = false;
  }

  function vcState(v) {
    if (v.lossless) return 'll';
    if (v.rtr) return 'rtr';
    if (v.rts) return 'rts';
    if (v.want) return 'want';
    return 'be';
  }
  const stateLabel = { ll: '无损', rtr: 'RTR', rts: 'RTS', want: 'Want', be: 'BE' };


  function stop() {
    clearInterval(timer);
    timer = null;
    el('play').textContent = '播放';
  }

  function phaseChips() {
    const map = {
      reset: '端口复位', init: '初始化交换', active: '正常运行',
      wait: '等待信用', recover: '异常恢复', remove: 'VC 移除'
    };
    const host = el('phase');
    if (!host) return;
    host.replaceChildren(...Object.entries(map).map(([key, label]) => {
      const chip = document.createElement('span');
      chip.className = key === phaseOf() ? 'is-on' : '';
      chip.textContent = label;
      return chip;
    }));
  }

  function tokenBox(text, dir) {
    const box = el('token');
    if (!box) return;
    box.textContent = 'VC ' + activeVC + ' · ' + text;
    box.dataset.dir = dir > 0 ? 'out' : dir < 0 ? 'back' : '';
    box.dispatchEvent(new CustomEvent('cb-transfer', { detail: dir }));
  }

  function describeTx(event) {
    if (!V[activeVC].lossless && event !== 'be') return 'VC 未启用无损';
    if (event === 'cf') return '处理信用反馈';
    if (event === 'cfmax') return '重发累计释放值';
    if (event === 'cfwait') return '等待 CF_min_timer';
    if (event === 'ccgen') return '生成 CC_Update';
    if (event === 'cflost') return 'CF_Update 丢失';
    if (event === 'rst') return '端口复位';
    if (event === 'be') return '尽力发送';
    if (phase === 'wait') return '等待信用';
    return '就绪';
  }
  function describeRx(event) {
    const map = {
      drain: '释放缓冲', cf: '通告信用', cfmax: '周期通告', cfwait: '暂不发送',
      cflost: '反馈丢失', ccgen: '发送同步', cc: '校正计数', be: '接收数据',
      rx: '接收数据', rst: '链路复位'
    };
    return map[event] || (R.buf[activeVC] ? '缓存有帧' : '等待数据');
  }

  function registerPanel() {
    const c = cfg();
    const vc = activeVC;
    const delta = key => dirty.get(key) || '';
    const panel = el('registers');
    panel.replaceChildren();

    const table = (title, rows, cls) => {
      const t = document.createElement('table');
      t.className = 'cb-table' + (cls ? ' ' + cls : '');
      const cap = document.createElement('caption');
      cap.textContent = title;
      t.appendChild(cap);
      const head = document.createElement('tr');
      head.className = 'cb-head';
      ['寄存器', '值', '变化'].forEach(text => {
        const th = document.createElement('th');
        th.textContent = text;
        head.appendChild(th);
      });
      t.appendChild(head);
      rows.forEach(row => {
        const [name, value, width, key] = row;
        const tr = document.createElement('tr');
        if (key && dirty.has(key)) tr.className = 'cb-changed';
        tr.innerHTML = '<th>' + name + (width ? ' <small class="cb-w">' + width + '</small>' : '') +
          '</th><td>' + value + '</td><td class="cb-d">' + delta(key) + '</td>';
        t.appendChild(tr);
      });
      return t;
    };

    panel.append(
      table('配置与端口', [
        ['CreditSize', c.unit + ' B', '—'],
        ['PktOvhd', c.over + ' B', '—'],
        ['NumVCs', '32（2 ≤ NumVCs ≤ 32）', '—'],
        ['TotalCredits', c.mode === 'port' ? c.limit : '未指定（逐 VC）', '20b', 'R.total'],
        ['额度模式', c.mode === 'port' ? 'S_P_CL（端口共享）' : 'S_VC_CL[x]（逐 VC）', '—'],
        ['S_P_CL', S.pcl, '20b', 'S.pcl'],
        ['S_P_CU', S.pcu, '20b', 'S.pcu']
      ]),
      table('发送端 VC[' + vc + ']', [
        ['S_VC_CL[' + vc + ']', S.cl[vc], '20b', 'S.cl'],
        ['S_VC_CU[' + vc + ']', S.cu[vc], '20b', 'S.cu'],
        ['S_VC_CC[' + vc + ']', S.cc[vc] + ' · 0x' + hexCC(S.cc[vc]), '20b', 'S.cc'],
        ['S_VC_CF[' + vc + ']', S.cf[vc] + ' · 0x' + hexCF(S.cf[vc]), '15b', 'S.cf']
      ]),
      table('接收端 VC[' + vc + ']', [
        ['R_VC_CC[' + vc + ']', R.cc[vc] + ' · 0x' + hexCC(R.cc[vc]), '20b', 'R.cc'],
        ['R_VC_CF[' + vc + ']', R.cf[vc] + ' · 0x' + hexCF(R.cf[vc]), '15b', 'R.cf'],
        ['缓冲占用', R.buf[vc] + ' credit', '—', 'R.buf']
      ]),
      table('VC 状态与定时器', [
        ['R_VC_Want[' + vc + ']', V[vc].want ? '1' : '0', '1b', 'V.want'],
        ['S_VC_RTS[' + vc + ']', V[vc].rts ? '1' : '0', '1b', 'V.rts'],
        ['R_VC_RTR[' + vc + ']', V[vc].rtr ? '1' : '0', '1b', 'V.rtr'],
        ['CF_min_timer', cfWait ? '未到期，合并更新' : '空闲', '≥800 B 线速'],
        ['CF_max_timer', cfMaxDue ? '到期，需重发' : '运行中', '16 KB–1 MB'],
        ['CC_msg_timer', ccDue ? '到期，生成 CC_Update' : '运行中', '1 µs–250 ms']
      ])
    );

    // CF_Update 的 CtlOS 字段按 Table 5-20/5-21 编码。
    const vc2 = (vc + 1) % 16;
    const cf1 = wrapCF(R.cf[vc]);
    const cf2 = wrapCF(R.cf[vc2]);
    const d2 = ((vc & 0x1F) << 3) | ((cf1 >> 12) & 0x07);
    const d3 = (cf1 >> 4) & 0xFF;
    const d4 = ((cf1 & 0x0F) << 4) | 0x06;
    const d5 = ((vc2 & 0x1F) << 3) | ((cf2 >> 12) & 0x07);
    const d6 = (cf2 >> 4) & 0xFF;
    const d7 = (cf2 & 0x0F) << 4;
    const message = table('CF_Update CtlOS（8 B）', [
      ['Lane 0', '0x5C', '8b'],
      ['Lane 1', '0x10（CF_Update）', '8b'],
      ['D2', '0x' + hex(d2) + ' · VC ' + (d2 >> 3), '8b'],
      ['D3', '0x' + hex(d3) + '（CF1 低 8 位）', '8b'],
      ['D4', '0x' + hex(d4) + '（CF1[3:0] + 0x6）', '8b'],
      ['D5', '0x' + hex(d5) + ' · VC ' + (d5 >> 3), '8b'],
      ['D6', '0x' + hex(d6) + '（CF2 低 8 位）', '8b'],
      ['D7', '0x' + hex(d7) + '（CF2[3:0] + 保留）', '8b']
    ]);
    message.classList.add('cb-msg');
    panel.appendChild(message);

    // CC_Update 的 MAC 帧字段按 Table 5-22 展示，计数只列前 4 个。
    const half = lastCC ? lastCC.half : (vc < 16 ? 0 : 1);
    const counts = lastCC ? lastCC.values.slice(0, 4) : S.cc.slice(half * 16, half * 16 + 4);
    const cc = table('CC_Update 报文（64 B）', [
      ['Msg Type', '0x0' + (half + 1) + ' · VC ' + (half * 16) + '–' + (half * 16 + 15), '8b'],
      ['EtherType / Opcode', '0x8808 / 0xFFFE', '16b'],
      ['CID', 'FA-7A-CB（UEC）', '24b'],
      ['S_VC_CC[' + (half * 16) + ']', counts[0] + ' · 0x' + hexCC(counts[0] || 0), '20b'],
      ['S_VC_CC[' + (half * 16 + 1) + ']', counts[1] + ' · 0x' + hexCC(counts[1] || 0), '20b'],
      ['S_VC_CC[' + (half * 16 + 2) + ']', counts[2] + ' · 0x' + hexCC(counts[2] || 0), '20b'],
      ['S_VC_CC[' + (half * 16 + 3) + ']', counts[3] + ' · 0x' + hexCC(counts[3] || 0), '20b'],
      ['其余 12 个 VC', '同包携带，未使用/尽力而为 VC 置 0', '20b×12']
    ]);
    cc.classList.add('cb-msg');
    panel.appendChild(cc);
  }

  function render(note, token, dir) {
    el('step').textContent = index + ' / ' + events.length + ' · ' + note;
    const current = events[index - 1] ? events[index - 1].split(':')[0] : '';
    el('tx-state').textContent = describeTx(current);
    el('rx-state').textContent = describeRx(current);
    phaseChips();
    const desc = el('desc');
    if (desc) desc.textContent = currentCase ? currentCase.desc : '';
    const map = el('map');
    map.replaceChildren(...V.map((v, i) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cb-vc is-' + vcState(v) + (i === activeVC ? ' cb-current' : '');
      cell.dataset.vc = i;
      cell.innerHTML = '<b>VC ' + i + '</b><span>' + stateLabel[vcState(v)] + '</span><i>' + S.cu[i] + '</i>';
      return cell;
    }));
    el('active-vc').textContent = 'VC ' + activeVC;
    registerPanel();
    tokenBox(token, dir);
    el('next').disabled = index >= events.length;
    if (activeInput()) activeInput().value = activeVC;
    const world = document.getElementById('cb-world');
    if (world) {
      const c = cfg();
      lastDetail = {
          op: current || 'view',
          vc: activeVC,
          phase,
          token,
          dir,
          used: S.cu[activeVC],
          limit: c.mode === 'port' ? S.pcl : S.cl[activeVC],
          portUsed: c.mode === 'port' ? S.pcu : null,
          portLimit: c.mode === 'port' ? S.pcl : null,
          buf: R.buf[activeVC],
          cc: S.cc[activeVC],
          cfS: S.cf[activeVC],
          cfR: R.cf[activeVC],
        inflight: !!inflight[activeVC],
        blocked: phase === 'wait'
      };
      world.dispatchEvent(new CustomEvent('cb-step', { detail: lastDetail }));
    }
  }

  function reset() {
    stop();
    index = 0;
    events = currentCase ? currentCase.ops.slice() : [];
    blank();
    phase = 'reset';
    activeVC = activeInput() ? Math.max(0, Math.min(31, Number(activeInput().value) || 0)) : 1;
    const valid = ['limit', 'size', 'over', 'unit', 'vc'].every(id => !el(id) ||
      (el(id).value !== '' && el(id).validity.valid));
    render(valid ? '已复位。按“下一步”逐步执行用例。' : '请输入范围内的整数。', '复位', 0);
    el('play').disabled = el('next').disabled = !valid;
  }

  function creditCheck(vc, n) {
    const c = cfg();
    if (c.mode === 'port') return S.pcu + n <= S.pcl;
    return S.cu[vc] + n <= S.cl[vc];
  }
  function checkText(vc, n) {
    const c = cfg();
    return c.mode === 'port'
      ? 'S_P_CU ' + S.pcu + ' + ' + n + (S.pcu + n <= S.pcl ? ' ≤ ' : ' > ') + 'S_P_CL ' + S.pcl
      : 'S_VC_CU[' + vc + '] ' + S.cu[vc] + ' + ' + n + (S.cu[vc] + n <= S.cl[vc] ? ' ≤ ' : ' > ') +
        'S_VC_CL[' + vc + '] ' + S.cl[vc];
  }

  function initCounters(vc) {
    S.cc[vc] = 0;
    S.cf[vc] = 0;
    S.cu[vc] = 0;
    R.cc[vc] = 0;
    R.cf[vc] = 0;
    R.buf[vc] = 0;
    inflight[vc] = 0;
  }

  function enableVC(vc) {
    V[vc].want = 1;
    V[vc].rts = 1;
    V[vc].rtr = 1;
    V[vc].lossless = 1;
    initCounters(vc);
    const c = cfg();
    if (c.mode === 'vc') S.cl[vc] = c.limit;
    else S.pcl = c.limit;
  }

  function run(event) {
    const parts = event.split(':');
    const op = parts[0];
    const hasVcArg = parts[1] != null && op !== 'ccgen' && op !== 'ccrx';
    const vc = hasVcArg ? Number(parts[1]) : activeVC;
    activeVC = Math.max(0, Math.min(31, vc));
    const n = pktCredits();
    const c = cfg();
    let note = '', token = '', dir = 0;
    dirty = new Map();

    switch (op) {
      case 'rst':
        blank();
        phase = 'reset';
        note = '端口复位：所有 VC 回到尽力而为，S_P_CU 与全部 VC 计数器清零。';
        token = '复位';
        break;
      case 'rxinit':
        V[vc].want = 1;
        V[vc].rtr = 0;
        initCounters(vc);
        R.total = c.mode === 'port' ? c.limit : 0;
        mark('V.want', '0→1');
        phase = 'init';
        note = '接收端初始化 TLV：R_NumVCs=32，R_CellSize=' + c.unit + ' B，R_PktOvhd=' + c.over +
          ' B，R_VC_Want[' + vc + ']=1；R_VC_CC/CF 清零。';
        token = 'R TLV';
        break;
      case 'lldp1':
        phase = 'init';
        note = 'LLDP 接收端→发送端：携带 R_NumVCs、R_TotalCredits=' +
          (c.mode === 'port' ? c.limit : 0) + '、R_CellSize、R_PktOvhd 与 R_VC_Want。';
        token = 'LLDP r→s';
        break;
      case 'txinit':
        if (c.mode === 'vc') S.cl[vc] = c.limit;
        else S.pcl = c.limit;
        initCounters(vc);
        V[vc].rts = 1;
        mark('S.cl', '=' + (c.mode === 'vc' ? c.limit : '—'));
        mark('V.rts', '0→1');
        phase = 'init';
        note = '发送端初始化：S_CreditSize=' + c.unit + ' B，S_PktOvhd=' + c.over + ' B，S_VC_RTS[' +
          vc + ']=1；关闭该 VC 发送并清零 S_VC_CC/CF/CU。';
        token = 'S TLV';
        break;
      case 'lldp2':
        phase = 'init';
        note = 'LLDP 发送端→接收端：通告 S_VC_RTS[' + vc + ']=1 与 S_CreditSize / S_PktOvhd。';
        token = 'LLDP s→r';
        break;
      case 'rxready':
        V[vc].rtr = 1;
        mark('V.rtr', '0→1');
        phase = 'init';
        note = '接收端完成配置：本地 R_VC_RTR[' + vc + ']=1，表示可按信用接收。';
        token = 'RTR';
        break;
      case 'lldp3':
        phase = 'init';
        note = 'LLDP 接收端→发送端：通告 R_VC_RTR[' + vc + ']=1，双方握手完成。';
        token = 'LLDP r→s';
        break;
      case 'enable':
        V[vc].lossless = 1;
        mark('V.want', '无损');
        phase = 'active';
        note = '启用无损发送：RTS 与 RTR 同时为 1，VC[' + vc + '] 可消耗信用发帧。';
        token = '启用';
        break;
      case 'up':
        enableVC(vc);
        phase = 'active';
        note = '已完成 LLDP 握手：VC[' + vc + '] 为无损，' +
          (c.mode === 'port' ? 'S_P_CL=' + c.limit : 'S_VC_CL[' + vc + ']=' + c.limit) + '。';
        token = '上线';
        break;
      case 'upall':
        for (let i = 0; i < 32; i++) enableVC(i);
        phase = 'active';
        note = '32 个 VC 全部完成无损初始化；端口额度 ' + (c.mode === 'port' ? c.limit : '逐 VC') + '。';
        token = '全部上线';
        break;
      case 'add':
        enableVC(vc);
        phase = 'init';
        note = '链路运行中新增无损 VC[' + vc + ']：沿用 R_CellSize / R_PktOvhd 与信用上限分配方式，' +
          '仅对该 VC 执行初始化并清零计数。';
        token = '新增 VC';
        break;
      case 'tx':
      case 'retry': {
        if (!V[vc].lossless) {
          phase = 'wait';
          note = 'VC[' + vc + '] 尚未完成无损初始化，发送被禁止。';
          token = '未启用';
          break;
        }
        if (op === 'retry' && inflight[vc]) {
          note = '该 VC 已有在途帧，先等待接收完成。';
          token = '跳过';
          break;
        }
        const check = checkText(vc, n);
        if (!creditCheck(vc, n)) {
          phase = 'wait';
          note = '准入失败：' + check + '；帧留在队列等待信用。';
          token = '等待信用';
          break;
        }
        S.pcu = wrapCC(S.pcu + n);
        S.cc[vc] = wrapCC(S.cc[vc] + n);
        S.cu[vc] = wrapCC(S.cu[vc] + n);
        inflight[vc] = 1;
        mark('S.pcu', '+' + n);
        mark('S.cc', '+' + n);
        mark('S.cu', '+' + n);
        phase = 'active';
        note = '准入通过：' + check + '；更新 S_P_CU、S_VC_CC 与 S_VC_CU。';
        token = '数据帧';
        dir = 1;
        break;
      }
      case 'be':
        phase = 'active';
        note = 'VC[' + vc + '] 为尽力而为：跳过信用检查，不更新任何 CBFC 计数器。';
        token = 'BE 数据';
        dir = 1;
        break;
      case 'rx':
        if (!inflight[vc]) {
          note = 'A 未发送帧，B 没有可接收的数据。';
          token = '等待';
          break;
        }
        R.cc[vc] = wrapCC(R.cc[vc] + n);
        R.buf[vc] = wrapCC(R.buf[vc] + n);
        inflight[vc] = 0;
        mark('R.cc', '+' + n);
        mark('R.buf', '+' + n);
        note = 'B 接收有效帧：R_VC_CC[' + vc + '] 与缓冲占用各加 ' + n + '。';
        token = '已接收';
        break;
      case 'loss':
        inflight[vc] = 0;
        phase = 'recover';
        note = '数据帧在链路上丢失：发送端已累计 CC，接收端从未累计，形成 ' + n + ' credit 泄漏。';
        token = '帧丢失';
        break;
      case 'drain':
        if (R.buf[vc]) {
          R.cf[vc] = wrapCF(R.cf[vc] + R.buf[vc]);
          mark('R.cf', '+' + R.buf[vc]);
          mark('R.buf', '-' + R.buf[vc]);
          note = 'B 排空缓冲：R_VC_CF[' + vc + '] 增加 ' + R.buf[vc] + '，等待发送 CF_Update。';
          R.buf[vc] = 0;
        } else {
          note = 'B 缓冲为空，没有新的释放量。';
        }
        cfDirty = true;
        cfWait = true;
        phase = 'active';
        token = '释放';
        break;
      case 'cfwait':
        cfWait = true;
        phase = 'active';
        note = 'CF_min_timer 尚未到期：暂不发送 CF_Update，释放量在下次通告中合并。';
        token = '暂缓';
        break;
      case 'cf':
      case 'cfmax': {
        const delta = wrapCF(R.cf[vc] - S.cf[vc]);
        if (!V[vc].lossless) {
          note = 'VC 尚未启用无损，忽略 CF_Update。';
          token = '忽略';
          break;
        }
        if (!delta) {
          note = 'R_VC_CF 与 S_VC_CF 相同，没有需要归还的信用。';
          token = '无变化';
          break;
        }
        S.pcu = Math.max(0, S.pcu - delta);
        S.cu[vc] = Math.max(0, S.cu[vc] - delta);
        S.cf[vc] = R.cf[vc];
        mark('S.pcu', '-' + delta);
        mark('S.cu', '-' + delta);
        mark('S.cf', '=' + hexCF(R.cf[vc]));
        cfDirty = false;
        cfWait = false;
        cfMaxDue = false;
        phase = 'active';
        note = (op === 'cfmax' ? 'CF_max_timer 到期，重发累计值 ' : 'A 收到 CF_Update：R_VC_CF=') +
          R.cf[vc] + '，归还 ' + delta + ' credit。';
        token = 'CF_Update';
        dir = -1;
        break;
      }
      case 'cflost':
        phase = 'recover';
        cfMaxDue = true;
        note = 'CF_Update 在链路上丢失：A 未归还信用，等待 CF_max_timer 重发累计值。';
        token = '反馈丢失';
        break;
      case 'ccgen': {
        const half = activeVC < 16 ? 0 : 1;
        const start = half ? 16 : 0;
        lastCC = { half, values: S.cc.slice(start, start + 16) };
        ccDue = false;
        phase = 'active';
        note = '生成 CC_Update（VC ' + start + '–' + (start + 15) + '）：携带 16 个 S_VC_CC 值，' +
          '不超过 CC_msg_timer 周期。';
        token = 'CC_Update';
        dir = 1;
        break;
      }
      case 'ccrx': {
        if (!lastCC) {
          note = '没有在途 CC_Update。';
          token = '等待';
          break;
        }
        const start = lastCC.half ? 16 : 0;
        let corrected = 0, lost = 0, error = false;
        for (let i = 0; i < 16; i++) {
          const id = start + i;
          const diff = wrapCC(S.cc[id] - R.cc[id]);
          if (diff === 0) continue;
          if (diff > 16383) {
            error = true;
            note = 'LostCredits[' + id + '] 超出 2^14−1（' + diff + '），属严重错误：上报管理实体，不修改计数器。';
            break;
          }
          R.cf[id] = wrapCF(R.cf[id] + diff);
          R.cc[id] = S.cc[id];
          corrected++;
          lost += diff;
        }
        phase = error ? 'recover' : 'active';
        if (!error) {
          note = '接收 CC_Update：修正 ' + corrected + ' 个 VC，补回 ' + lost +
            ' credit 泄漏；R_VC_CC 与 S_VC_CC 同步。';
        }
        token = error ? '严重错误' : 'CC_Update';
        break;
      }
      case 'ccdrop':
        phase = 'recover';
        note = 'CC_Update 在 LLR 丢弃窗内被丢弃：不改动 R_VC_CC，等待 LLR 重放；重放后比较仍然正确。';
        token = '丢弃';
        break;
      case 'ccbad':
        S.cc[vc] = wrapCC(R.cc[vc] - 4);
        mark('S.cc', '注入异常');
        phase = 'recover';
        note = '注入异常 S_VC_CC[' + vc + ']（比接收端小 4），下一次 CC_Update 将检测到 LostCredits 回绕越界。';
        token = '注入';
        break;
      case 'wrap':
        S.cc[vc] = CC_MOD - 2;
        S.cu[vc] = 0;
        S.cf[vc] = CF_MOD - 2;
        R.cf[vc] = CF_MOD - 2;
        S.pcu = 0;
        mark('S.cc', '≈2^20');
        mark('S.cf', '≈2^15');
        phase = 'recover';
        note = '把计数器置于回绕边界：S_VC_CC 接近 2^20−1，S_VC_CF/R_VC_CF 接近 2^15−1。';
        token = '回绕';
        break;
      case 'rmwant':
        V[vc].want = 0;
        mark('V.want', '1→0');
        phase = 'remove';
        note = '接收端请求移除 VC[' + vc + ']：R_VC_Want=0，R_VC_RTR 保持不变。';
        token = 'Want=0';
        break;
      case 'rmlldp1':
        phase = 'remove';
        note = 'LLDP 接收端→发送端：通告 R_VC_Want[' + vc + ']=0，其余端口参数不变。';
        token = 'LLDP r→s';
        break;
      case 'rmdrain':
        phase = 'remove';
        note = '发送端停止向 VC[' + vc + '] 入队并等待队列排空；期间不得引入新的信用使用。';
        token = '排空';
        break;
      case 'rmrts':
        V[vc].rts = 0;
        mark('V.rts', '1→0');
        phase = 'remove';
        note = '发送端更新 S_VC_RTS[' + vc + ']=0，并按剩余无损 VC 重新分配信用上限。';
        token = 'RTS=0';
        break;
      case 'rmlldp2':
        phase = 'remove';
        note = 'LLDP 发送端→接收端：通告 S_VC_RTS[' + vc + ']=0。';
        token = 'LLDP s→r';
        break;
      case 'rmreturn':
        if (R.buf[vc]) {
          const freed = R.buf[vc];
          R.cf[vc] = wrapCF(R.cf[vc] + freed);
          R.buf[vc] = 0;
          mark('R.cf', '+' + freed);
          mark('R.buf', '-' + freed);
        }
        phase = 'remove';
        note = '接收端等待 VC[' + vc + '] 缓冲排空，并通过 CF_Update 归还全部信用。';
        token = '归还';
        break;
      case 'rmlldp3':
        V[vc].rtr = 0;
        mark('V.rtr', '1→0');
        phase = 'remove';
        note = '接收端更新 R_VC_RTR[' + vc + ']=0，并通过 LLDP 通告对端。';
        token = 'RTR=0';
        break;
      case 'rmdone':
        V[vc].lossless = 0;
        phase = 'remove';
        note = 'VC[' + vc + '] 已移除无损属性，可继续作为尽力而为 VC 使用。';
        token = '完成';
        break;
      default:
        note = '未识别的操作：' + event;
        token = '—';
    }
    render(note, token, dir);
    if (index === events.length) stop();
  }

  let currentCase = null;
  let lastDetail = null;

  function next() {
    if (index >= events.length) return;
    const event = events[index++];
    run(event);
  }

  function applySetup(item) {
    const setup = (item && item.setup) || {};
    // 每个用例从默认参数开始，避免继承上一个用例的覆盖值。
    el('mode').value = setup.mode || 'vc';
    el('limit').value = setup.limit || 4;
    el('size').value = setup.size || 192;
    el('over').value = setup.over != null ? setup.over : 0;
    el('unit').value = setup.unit || 64;
  }

  function preset() {
    const group = el('group').value;
    const list = cases[group] || [];
    const item = list.find(entry => entry.name === el('case').value) || list[0];
    currentCase = item || null;
    applySetup(item);
    reset();
  }

  function categories() {
    el('case').replaceChildren();
    (cases[el('group').value] || []).forEach(item => el('case').add(new Option(item.name, item.name)));
    preset();
  }

  function build() {
    const world = document.getElementById('cb-world');
    if (world) {
      world.addEventListener('cb-sync', () => {
        if (lastDetail) world.dispatchEvent(new CustomEvent('cb-step', { detail: lastDetail }));
      });
    }
    Object.keys(cases).forEach(name => el('group').add(new Option(name, name)));
    el('group').onchange = categories;
    el('case').onchange = preset;
    ['mode', 'limit', 'size', 'over', 'unit'].forEach(id => { el(id).oninput = reset; });
    if (el('vc')) el('vc').oninput = () => {
      activeVC = Math.max(0, Math.min(31, Number(el('vc').value) || 0));
      render('已切换观察 VC[' + activeVC + ']，用例不前进。', events[index - 1] || '就绪', 0);
    };
    el('map').addEventListener('click', event => {
      const cell = event.target.closest('[data-vc]');
      if (!cell) return;
      activeVC = Number(cell.dataset.vc);
      render('已切换观察 VC[' + activeVC + ']，用例不前进。', events[index - 1] || '就绪', 0);
    });
    el('next').onclick = () => { stop(); next(); };
    el('reset').onclick = reset;
    el('play').onclick = () => {
      if (timer) { stop(); return; }
      if (index === events.length) reset();
      timer = setInterval(next, 1600);
      el('play').textContent = '暂停';
      next();
    };
    categories();
  }

  build();

  const panel = document.getElementById('lab-cbfc');
  if (panel) {
    new MutationObserver(() => { if (panel.hidden) stop(); }).observe(panel, {
      attributes: true, attributeFilter: ['hidden']
    });
  }
})();
