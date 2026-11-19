(function (P) {
  'use strict';

  const dialog = document.getElementById('pcs-ue-demo');
  const picker = document.getElementById('pcs-ue-scenario');
  const body = document.getElementById('pcs-ue-body');
  const scenarios = {
    ack: {
      name: 'LLR_ACK',
      bytes: [0x5c, 0x01, 0, 0, 0x96, 0, 0, 0],
      tx: 'A 的 CBFC 允许新帧发送后，LLR 分配序号 9，并保存到重放缓冲区。',
      detection: 'B 的 LLR 按序接收且校验通过，向上交给 CBFC，并准备确认序号 9。',
      arrival: 'A 收到 ACK(9)，释放已确认的重放缓冲。'
    },
    nack: {
      name: 'LLR_NACK',
      bytes: [0x5c, 0x02, 0, 0, 0x96, 0, 0, 0],
      tx: 'A 的 CBFC 对序号 10 的帧首次发送计入信用消耗，LLR 保存该帧供重放。',
      detection: 'B 的 LLR 检出序号 10 的帧 FCS 错误并丢弃，CBFC 不增加接收信用消耗计数 R_VC_CC。NACK 携带最近成功接收的序号 9。',
      arrival: 'A 完成正在发送的帧，然后从首个未确认的序号 10 开始重放。两种功能同时启用时，重放不重复扣减发送信用。'
    },
    credit: {
      name: 'CF_Update',
      bytes: [0x5c, 0x10, 0x20, 0x07, 0xb6, 0x5b, 0x77, 0xb0],
      tx: 'A 的 CBFC 先比较当前已用信用加本帧所需信用与信用上限，满足后才放行新帧给 LLR。',
      detection: 'B 的 LLR 接收有效帧后交给 CBFC。CBFC 在释放接收缓冲后，回报 VC 4 和 VC 11 的累计 Credit Freed 计数 123 与 14203。',
      arrival: 'A 更新对应 VC 的信用状态，额度允许时继续发送。CF_Update 可在 LLR 丢弃窗口内独立处理。CC_Update 是独立的 MAC 帧，两种功能同时启用时应标为 LLR-eligible。'
    }
  };

  function hex(value) {
    return value.toString(16).toUpperCase().padStart(2, '0');
  }

  function lsb(value, width) {
    return Array.from({ length: width }, (_, bit) => (value >> bit) & 1).join('');
  }

  function showScenario() {
    const { name, bytes, tx, detection, arrival } = scenarios[picker.value];
    const [, d1, d2, d3, d4, d5, d6, d7] = bytes;
    const wire = ['10', lsb(0x4b, 8), lsb(d1, 8), lsb(d2, 8), lsb(d3, 8),
      lsb(d4 & 15, 4) + lsb(d4 >> 4, 4), lsb(d5, 8), lsb(d6, 8), lsb(d7, 8)].join('_');

    body.innerHTML = `
      <section class="pcs-ue-demo" aria-label="双端链路控制数据流">
        <div class="pcs-ue-endpoints"><b>端口 A · 数据发送方</b><b>端口 B · 数据接收方</b></div>
        <div class="pcs-ue-forward" aria-label="正向数据流"><span>A：CBFC → LLR → 链路 → LLR → CBFC：B</span></div>
        <div class="pcs-ue-return" aria-label="反向 CtlOS 流">
          <span class="pcs-ue-token">← ${name}</span>
        </div>
        <p class="pcs-ue-status" aria-live="polite"></p>
        <div class="pcs-ue-encoding">
          <h4>200GMII：一个 8 字节 CtlOS</h4>
          <div class="pcs-rx-bytes">${bytes.map((byte, lane) =>
            '<span>' + hex(byte) + '<small>Lane ' + lane + (lane === 0 ? ' · 控制' : '') + '</small></span>').join('')}</div>
          <h4>PCS：一个 66b 控制块</h4>
          <p>同步头 <code>10</code> · Block Type <code>0x4B</code> · O-code <code>0x6</code> · D1 <code>0x${hex(d1)}</code></p>
          <code class="pcs-ue-wire">${wire}</code>
          <h4>插入到反向数据流</h4>
          <div class="pcs-ue-insert">
            <span>帧内已传 ≥256 B</span><strong>${name}</strong><span>原帧继续发送 →</span>
          </div>
          <p class="note">CtlOS 以 8 字节对齐插入，第一处不能落在帧首 256 字节内。同一帧内两个 CtlOS 至少间隔 2 KB 数据，通用连续 CtlOS 间隔至少 400 B。分组位串按各字段 LSB 先发送。</p>
        </div>
      </section>`;
    const view = body.querySelector('.pcs-ue-demo');
    const messages = [tx + ' ' + detection,
      'B 在反向流插入 ' + name + '。PCS 编码后随链路传送，A 解码并将 CtlOS 分派给相应控制模块。',
      arrival];
    P.mountModuleDemo(dialog, body, ['B 生成 ' + name, 'B → A 传输 CtlOS', 'A 处理控制消息'],
      messages[1], step => {
        view.dataset.step = step;
        view.querySelector('.pcs-ue-status').textContent = messages[step];
      });
  }

  picker.onchange = showScenario;
  P.openUeDemo = function (view) {
    const defaults = {
      ueLlr: 'nack', ueCbfc: 'credit', ueCtl: 'ack',
      ueLlrRx: 'nack', ueCbfcRx: 'credit', ueCtlRx: 'ack'
    };
    if (!Object.prototype.hasOwnProperty.call(defaults, view)) return false;
    if (P.state.playing) P.setPlaying(false);
    const side = view.endsWith('Rx') ? 'B' : 'A';
    document.getElementById('pcs-ue-title').textContent = 'UE 1.1 · 端口 ' + side + ' · LLR / CBFC / CtlOS';
    picker.value = defaults[view];
    showScenario();
    if (!dialog.open) dialog.showModal();
    return true;
  };
})(globalThis.PCS);
