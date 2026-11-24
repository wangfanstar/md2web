/* 流控链路数据：手工整理自 sdk/doc/docs/flowcontrol_pzz.md
 * 节点：name/sub/group/坐标；链路：from/to/type/label
 * type: data | stat | pfc | cbfc | credit | ecn
 */
window.PZZ_FLOW_TYPES = [
  { id: 'all',    name: '全部',        color: '#2b4bd6' },
  { id: 'data',   name: '数据面',      color: '#2b4bd6' },
  { id: 'stat',   name: '统计 / 通知', color: '#8e5bd0' },
  { id: 'pfc',    name: 'PFC',         color: '#e07a2e' },
  { id: 'cbfc',   name: 'CBFC',        color: '#18a999' },
  { id: 'credit', name: '内部 credit', color: '#0ea5e9' },
  { id: 'ecn',    name: 'ECN / WRED',  color: '#d9981f' }
];

window.PZZ_FLOW_NODES = [
  {
    id: 'up', name: '上游设备', sub: 'PFC / CBFC 对端', group: 'ext', x: -88, z: -34,
    cli: ['macw show chip 0 chiplet 0 port 0 pfc-cnt', 'macw show chip 0 chiplet 0 port 0 link-status'],
    info: [
      '接收本端 PFC，按 priority 暂停对应发送队列；CBFC 场景维护对端 credit 账本。',
      'CF_Update / CC_Update 在本端 MACW 与对端 ETH-CBFC 之间闭环。'
    ]
  },
  {
    id: 'macw_rx', name: 'MACW RX', sub: 'ETH-CBFC-RX · MAC IP RX', group: 'ingress', x: -64, z: -34,
    cli: ['macw show chip 0 chiplet 0 port 0 ingress count', 'macw show chip 0 chiplet 0 port 0 pfc-cnt', 'cbfc show chip 0 chiplet 0 pipe 0 reg eth_rx channel 0 vc 0 credit'],
    info: [
      'R_VC_CC 20bit / R_VC_CF 15bit；按包顺序等待 MACI 的 EOP CC 消息（VC + length）。',
      '解析对端 PFC、CF_Update、CC_Update；CC_Update 依赖严格保序。'
    ]
  },
  {
    id: 'maci_rx', name: 'MACI RX / FCU', sub: 'ICU · FlexFIFO · FCU', group: 'ingress', x: -40, z: -34,
    cli: ['maci show chip 0 chiplet 0 pipe 0 rx cnt', 'maci show chip 0 chiplet 0 pipe 0 fcu cfg', 'maci show chip 0 chiplet 0 pipe 0 pfc-ddlk status'],
    info: [
      'ICU 按 VLAN/DSCP/流规则映射 VCID；FlexFIFO 释放产生 CF 原始事件。',
      'FCU 把 AQM 的 8ch×8pri 状态与本地 FIFO 反压合成 PFC 发帧触发。',
      '通道停读：masked_pfc 全部为 1 才停，并在包边界处理。'
    ]
  },
  {
    id: 'pirx', name: 'PIRX / PITX', sub: 'HPP 入口 · 队列确定', group: 'ingress', x: -16, z: -34,
    cli: ['pirx show chip 0 chiplet 0 pipe 0 cnt', 'pirx show chip 0 chiplet 0 pipe 0 sts'],
    info: [
      '接收适配与转发分类；确定目标 DIE/TM/QID，执行 AQM 的 GUR/SH/HR、drop/trim 决策。',
      '与 MACI RX 之间是整体接收 credit + 分通道反压。'
    ]
  },
  {
    id: 'mirx', name: 'MIRX / SPAQM', sub: '入队 · 快慢通路选择', group: 'buffer', x: 8, z: -34,
    cli: ['mirx show chiplet 0 spaqmsb block 0', 'mirx show chiplet 0 fcstatus block 0', 'mirx show chiplet 0 pkt-cnt block all'],
    info: [
      'SPAQM 按来源端口 × PG/VC × 目的 DIE 统计 GUR/SH/HR，阈值或超时触发上报。',
      '快速通路按包选择目标 TM，每 flit 扣 credit，由 TM 经 ESN 返还。'
    ]
  },
  {
    id: 'xmmu', name: 'XMMU / MCBM', sub: '慢速缓存 · MCFM', group: 'buffer', x: 32, z: -34,
    cli: ['mcbm show chiplet 0 total-buffer', 'mcbm show chiplet 0 aqm-cnt', 'tlsbc show chiplet 0 spaqm-counter'],
    info: [
      '目标 DIE 的慢速报文缓存；MCBM/MCFM 管理分配与释放。',
      '缓存占用经 SBC/MTLN 汇总为 DIE 资源视图。'
    ]
  },
  {
    id: 'sbc', name: 'SBC / MTLN', sub: 'DIE 资源汇总', group: 'buffer', x: 32, z: -54,
    cli: ['tlsbc show chiplet 0 spaqm-counter', 'tlsbc show chiplet 0 scoreboard', 'tlsbc show chiplet 0 config'],
    info: [
      '汇总各 MIRX 的资源使用，形成 DIE total / shared / headroom 视图。',
      '经 AQMN 广播给 AQM 与 TM-POL，用于 Alpha 与全局保护。'
    ]
  },
  {
    id: 'aqm', name: 'AQM', sub: 'PFC · CBFC 调速 · WRED/ECN', group: 'aqm', x: -16, z: -6,
    cli: ['mcbm show chiplet 0 aqm-cnt', 'paqm show chiplet 0 src_db block 0', 'paqm show chiplet 0 egr_db block 0', 'paqm show chiplet 0 egr_profile block 0'],
    info: [
      '解析 SPAQM、TM/MCE 队列、SBC 总量；按来源 PG/QID/port/color 读 profile。',
      '无损流：XOFF/XON 状态机 + 准入；慢速 CBFC：VC 占用映射为 8bit 返回比例。',
      '有损流：WRED；按配置生成 TRIM/ECN；响应携带原 context 返回 PITX。'
    ]
  },
  {
    id: 'aqmn', name: 'AQMN / NOC', sub: '统计与反压消息网络', group: 'aqm', x: 8, z: -6,
    cli: ['paqm show chiplet 0 src_db block 0', 'paqm show chiplet 0 egr_db block 0'],
    info: [
      '广播出口队列/端口深度、SBC 汇总、TM POL 快速 SPORT/SVC/TOTAL 状态。',
      '消息传输和排队延迟必须计入 Headroom 预算。'
    ]
  },
  {
    id: 'bwli', name: 'BWLI / UCIe', sub: '跨 DIE 链路 credit', group: 'buffer', x: 56, z: -44,
    cli: ['bwli show chiplet 0 pkt-cnt tx-in-cnt block 0', 'bwli show chiplet 0 pkt-cnt rx-out-cnt block 0'],
    info: [
      '跨 DIE 数据经 RN→BWLI→MIRX；BWLI 维护链路级 credit，MIRX 提供接收侧 FC。',
      '控制/释放消息走 OOB/AQMN/ESN 等独立通路，避免与受控数据互相等待。'
    ]
  },
  {
    id: 'mce', name: 'MCE', sub: '组播 Phase1 队列', group: 'buffer', x: 32, z: -6,
    cli: ['paqm show chiplet 0 egr_db block 0', 'display mce dropinfo', 'display mcg status'],
    info: [
      '维护组播 Phase1 队列；AQM 生成 queue / MCE / DIE 级反压（示例 72/36/4 bit）。',
      '跨 DIE 复制前检查反压状态，避免复制放大缓存占用。'
    ]
  },
  {
    id: 'tm_qc', name: 'TM-QC / OQ', sub: '队列 / FD · QID→VC', group: 'tm', x: 56, z: -22,
    cli: ['qc show queue_info chip 0 chiplet 0 tm addr_id 0', 'qc show buf_alc_rel_cnt chip 0 tm addr_id 0', 'qc show oq_info_uc chip 0 chiplet 0 tm addr_id 0'],
    info: [
      '队列与 FD 管理；把最终 QID 映射为 (port, VC)。',
      '按包长计算 credit 并预扣；不满足额度时停该 VC 队列，RR 轮询恢复。'
    ]
  },
  {
    id: 'tm_cbfc', name: 'TM-CBFC', sub: 'S_P_CU / S_VC_CU · TM_VC_CC', group: 'tm', x: 56, z: -9,
    cli: ['cbfc show chip 0 chiplet 0 pipe 0 reg tm channel 0 vc 0 credit', 'cbfc show chip 0 chiplet 0 pipe 0 reg tm channel all_credit', 'cbfc show chip 0 chiplet 0 pipe 0 reg eth_tx channel 0 vc 0 credit'],
    info: [
      '维护端口/VC 预扣 CU（20bit 设计口径）与 TM_VC_CC（12bit）随 metadata 传递。',
      '发包需同时满足端口总额度与 VC 保证+共享额度；差额由 TM→MAC 内部校正回补。'
    ]
  },
  {
    id: 'tm_sch', name: 'TM-SCH', sub: 'Queue→CoS→Port→Interface', group: 'tm', x: 56, z: 4,
    cli: ['sch show chip 0 tm ins 0 context_conf', 'sch show chip 0 tm faddr_drop_cnt', 'sch show chip 0 tm ins 0 control_info'],
    info: [
      '分层选择有资格发送的队列；PFC/host FC、整形、WFQ、CBFC 资格多条件同时满足。',
      'PFC 通过 Q2FCCOS / COS2FCCOS 映射停队列或 CoS；解除后仍需其它条件满足。'
    ]
  },
  {
    id: 'tm_pol', name: 'TM-POL', sub: '队列计数 · ECN · 快速 FC', group: 'tm', x: 56, z: 17,
    cli: ['pol show chiplet 0 counter block 0', 'pol show chiplet 0 aqm_info block 0', 'pol show chiplet 0 redecn_profile block 0'],
    info: [
      '根据 QC 入出队维护队列/端口计数；下行 WRED 与出队 ECN。',
      '快速通路按 TM-MMU 实际读取维护 SPORT/SVC/TOTAL 占用并上报 AQM。'
    ]
  },
  {
    id: 'mitx', name: 'MITX', sub: 'FTAG · 出队缓存', group: 'egress', x: 36, z: 30,
    cli: ['mitx show chip 0 chiplet 0 hpp ins 0 pkt_counter channel 0', 'mitx show chip 0 chiplet 0 fc_status', 'mitx show chip 0 chiplet 0 ftag_valid'],
    info: [
      '出队缓存、FTAG 保序、元数据拼接；按 FIFO 余量接收上游数据。',
      '输出数据后释放 FTAG；向 TM 返回 FIFO/FTAG credit。'
    ]
  },
  {
    id: 'perx', name: 'PERX / PETX', sub: '出口改包 · 长度补偿', group: 'egress', x: 12, z: 30,
    cli: ['perx show chip 0 chiplet 0 pipe 0 cnt', 'perx show chip 0 chiplet 0 pipe 0 sts'],
    info: [
      '去除 MMU/I2E 头或隧道头、增加/减少封装，会改变实际线侧长度。',
      '把长度差额回补 MITX/MACI TX 预算，避免多扣停流或少扣超限。'
    ]
  },
  {
    id: 'maci_tx', name: 'MACI TX / PFC-MNG', sub: '出口缓存 · PFC 响应', group: 'egress', x: -12, z: 30,
    cli: ['maci show chip 0 chiplet 0 pipe 0 tx cnt', 'maci show chip 0 chiplet 0 pipe 0 pfc-ddlk status', 'maci show chip 0 chiplet 0 pipe 0 fcu cfg'],
    info: [
      '接收 MAC 的 PFC 状态，向 TM-SCH 输出 channel_id + PFC mask。',
      '按 mask 与包边界停读出口 FIFO；PFC 死锁检测可产生 drop/调制恢复。',
      '向 MITX 返回实际释放与通道 credit。'
    ]
  },
  {
    id: 'macw_tx', name: 'MACW TX', sub: 'ETH-CBFC-TX · MAC IP TX', group: 'egress', x: -36, z: 30,
    cli: ['macw show chip 0 chiplet 0 port 0 egress count', 'macw show chip 0 chiplet 0 port 0 pfc-cnt', 'cbfc show chip 0 chiplet 0 pipe 0 reg eth_tx channel 0 vc 0 credit'],
    info: [
      'S_VC_CC 20bit / S_VC_CF 15bit；按实际发送长度记账并计算内部补偿。',
      'CF_Update 累计值换算 credits_returned；CF_min/max timer 控制重报。',
      '合成 PFC 帧发往上游（MAC IP TX）。'
    ]
  },
  {
    id: 'down', name: '下游设备', sub: 'PFC / CF_Update 来源', group: 'ext', x: -60, z: 30,
    cli: ['macw show chip 0 chiplet 0 port 0 pfc-cnt', 'macw show chip 0 chiplet 0 port 0 link-status'],
    info: [
      '产生 PFC（priority bitmap + pause time）与 CF_Update/CC_Update。',
      '本地按 priority 暂停；解除后需满足整形、CBFC 与内部资源条件才恢复。'
    ]
  },
  {
    id: 'aux', name: 'AUX / CPP', sub: '端口级内部反压', group: 'ctrl', x: 8, z: 49,
    cli: ['aux_mac show chip 0 auxid 0 fc-status', 'aux_mac show chip 0 auxid 0 count'],
    info: [
      'AUX 对 XMMU 的占用受端口级内部反压限制，避免控制/CPU 流量耗尽业务缓存。',
      '不参与普通链路 PFC/CBFC 协商，编号需在 MACI/MIRX/AQM/TM 间映射。'
    ]
  }
];

window.PZZ_FLOW_LINKS = [
  /* 数据面 */
  { from: 'up', to: 'macw_rx', type: 'data', label: '线侧帧 / PFC 帧' },
  { from: 'macw_rx', to: 'maci_rx', type: 'data', label: 'RX 帧 + VCID 分类' },
  { from: 'maci_rx', to: 'pirx', type: 'data', label: 'flit + 整体 credit' },
  { from: 'pirx', to: 'mirx', type: 'data', label: '128B flit' },
  { from: 'mirx', to: 'xmmu', type: 'data', label: '慢速通路入队' },
  { from: 'xmmu', to: 'tm_qc', type: 'data', label: 'FD / 读请求' },
  { from: 'mirx', to: 'tm_qc', type: 'data', label: '快速通路（TM-MMU）' },
  { from: 'tm_qc', to: 'tm_cbfc', type: 'data', label: 'FD / QID→VC' },
  { from: 'tm_cbfc', to: 'tm_sch', type: 'data', label: '发送资格' },
  { from: 'tm_sch', to: 'mitx', type: 'data', label: '出队请求 / 数据' },
  { from: 'mitx', to: 'perx', type: 'data', label: '128B flit' },
  { from: 'perx', to: 'maci_tx', type: 'data', label: '改包后 flit' },
  { from: 'maci_tx', to: 'macw_tx', type: 'data', label: 'TX 数据' },
  { from: 'macw_tx', to: 'down', type: 'data', label: '线侧发送' },

  /* 统计 / 通知 */
  { from: 'mirx', to: 'aqm', type: 'stat', label: 'SPAQM 源端占用' },
  { from: 'bwli', to: 'mirx', type: 'data', label: '跨 DIE 报文' },
  { from: 'mirx', to: 'bwli', type: 'credit', label: 'MIRX 接收 FC / credit' },
  { from: 'xmmu', to: 'sbc', type: 'stat', label: '各 MIRX 资源统计' },
  { from: 'sbc', to: 'aqmn', type: 'stat', label: 'DIE total/shared/HR' },
  { from: 'tm_pol', to: 'aqmn', type: 'stat', label: '出口 queue/port 深度' },
  { from: 'mce', to: 'aqmn', type: 'stat', label: 'Phase1 队列统计' },
  { from: 'aqmn', to: 'aqm', type: 'stat', label: '聚合统计广播' },
  { from: 'aqmn', to: 'tm_pol', type: 'stat', label: '本 DIE 资源状态' },

  /* PFC */
  { from: 'aqm', to: 'maci_rx', type: 'pfc', label: '8ch×8pri PFC 位图' },
  { from: 'maci_rx', to: 'macw_tx', type: 'pfc', label: 'PFC 发帧触发（FCU）' },
  { from: 'down', to: 'macw_rx', type: 'pfc', label: '对端 PFC / pause time' },
  { from: 'macw_rx', to: 'maci_tx', type: 'pfc', label: 'priority bitmap' },
  { from: 'maci_tx', to: 'tm_sch', type: 'pfc', label: 'channel_id + PFC mask' },
  { from: 'aqm', to: 'mirx', type: 'pfc', label: '快速 VC/port 停读' },

  /* CBFC */
  { from: 'maci_rx', to: 'macw_rx', type: 'cbfc', label: 'EOP CC / CF 原始释放' },
  { from: 'aqm', to: 'macw_rx', type: 'cbfc', label: 'CF 返回比例（8bit）' },
  { from: 'macw_rx', to: 'macw_tx', type: 'cbfc', label: 'CF_Update / CC_Update' },
  { from: 'macw_tx', to: 'tm_cbfc', type: 'cbfc', label: 'credits_returned' },
  { from: 'tm_cbfc', to: 'mitx', type: 'cbfc', label: 'TM_VC_CC / 预扣' },

  /* 内部 credit / 反压 */
  { from: 'pirx', to: 'maci_rx', type: 'credit', label: 'PIRX 整体 credit 返回' },
  { from: 'tm_qc', to: 'mirx', type: 'credit', label: 'ESN credit 返回' },
  { from: 'mitx', to: 'tm_sch', type: 'credit', label: 'FTAG release / FIFO credit' },
  { from: 'maci_tx', to: 'mitx', type: 'credit', label: '通道 credit / 实际释放' },
  { from: 'perx', to: 'mitx', type: 'credit', label: '长度差额补偿' },
  { from: 'mce', to: 'mirx', type: 'credit', label: 'Mirror ENQ 反压' },
  { from: 'aqm', to: 'aux', type: 'credit', label: 'AUX 端口级内部反压' },

  /* ECN / WRED */
  { from: 'tm_pol', to: 'tm_sch', type: 'ecn', label: 'ECN / 队列状态' },
  { from: 'aqm', to: 'pirx', type: 'ecn', label: 'WRED / TRIM 响应' }
];
