/* 报文转发路径数据：CPP ingress→egress（CppPacketIngree2Egress.png）与 HPP 业务面路径
 * 节点坐标为 3D 示意图布局（x 水平，z 纵深）；steps 为按顺序经过的节点 id。
 */
window.PZZ_ROUTE_GROUPS = [
  { id: 'cpp', name: 'CPP 报文路径' },
  { id: 'hpp', name: 'HPP 报文路径' }
];

window.PZZ_ROUTE_KINDS = {
  data:   { name: '业务数据', color: '#3b7dd8' },
  cpu:    { name: 'CPU / AUX', color: '#d9981f' },
  mirror: { name: '镜像',     color: '#8e5bd0' },
  cross:  { name: '跨 DIE',   color: '#2f9e5f' },
  ctrl:   { name: '控制面',   color: '#18a999' }
};

window.PZZ_ROUTE_CATEGORIES = [
  { id: 'local_hpp',  name: '本 DIE · HPP',        color: '#3b7dd8' },
  { id: 'local_aux',  name: '本 DIE · AUX',        color: '#d9981f' },
  { id: 'cpp_ctrl',   name: 'CPP / 控制',          color: '#18a999' },
  { id: 'cpp_mirror', name: 'CPP / Mirror',        color: '#8e5bd0' },
  { id: 'cross_hpp',  name: '跨 DIE · HPP',        color: '#2f9e5f' },
  { id: 'cross_cpp',  name: '跨 DIE · 输出/过路',  color: '#0ea5e9' }
];

window.PZZ_ROUTE_CLASS_FILTERS = [
  { id: 'all',    name: '全部' },
  { id: 'local',  name: '本 DIE' },
  { id: 'cross',  name: '跨 DIE' },
  { id: 'aux',    name: 'AUX' },
  { id: 'hpp',    name: 'HPP' },
  { id: 'cpp',    name: 'CPP / Mirror' },
  { id: 'mirror', name: 'Mirror' }
];

window.PZZ_ROUTE_NODES = [
  /* HPP 业务面（z = -38） */
  { id: 'macw_rx', name: 'MACW RX', sub: 'MAC IP RX · 线侧入口', group: 'hpp', x: -130, z: -38,
    cli: ['macw show chip 0 chiplet 0 port 0 ingress count', 'macw show chip 0 chiplet 0 port 0 status', 'macw show chip 0 chiplet 0 port 0 config'],
    info: ['线侧帧、PFC/CBFC 控制帧从这里进入 HPP。', 'MACI RX 之前完成链路层接收与通道缓存。'] },
  { id: 'maci_rx', name: 'MACI RX / ICU', sub: 'FlexFIFO · VC 分类', group: 'hpp', x: -104, z: -38,
    cli: ['maci show chip 0 chiplet 0 pipe 0 rx cnt', 'maci show chip 0 chiplet 0 pipe 0 rx sts'],
    info: ['按通道缓存入口报文，ICU 输出 VC/CoS 与报文类型。', '也是 CPP 报文注入 HPP 的落点（HPP Ingress MACI RX）。'] },
  { id: 'pirx', name: 'PIRX / PITX', sub: 'HPP 入口适配', group: 'hpp', x: -78, z: -38,
    cli: ['pirx show chip 0 chiplet 0 pipe 0 cnt', 'pirx show chip 0 chiplet 0 pipe 0 sts', 'pitx show chip 0 chiplet 0 pipe 0 cnt'],
    info: ['接收适配、通道交织与 PITX 组包，把 flit 送给 Parser。', '与 MACI RX 之间有整体 credit 与分通道反压。'] },
  { id: 'parse', name: 'Parser / VLAN', sub: '解析 · VFP/VLAN', group: 'hpp', x: -52, z: -38,
    cli: ['pirx show chip 0 chiplet 0 pipe 0 cnt', 'vlan show vlan_id 1 all'],
    info: ['解析以太网/RoCE/UEC/SUE/VxLAN 等报文头。', 'VFP/VLAN 处理入向 VLAN、隧道与分类信息。'] },
  { id: 'lookup', name: 'L2 / L3 / ACL', sub: 'EMF · LPM · TCAM', group: 'hpp', x: -26, z: -38,
    cli: ['mac show count', 'acl show group 0 pipe 0', 'ecmp_group show ecmp_group_id 0'],
    info: ['L2 EMF、L3 LPM/NEXTHOP/ECMP、ACL/TCAM 在同一查表阶段完成。', '结果决定出端口、ECMP/TRUNK 成员与丢弃/镜像动作。'] },
  { id: 'mirx', name: 'MIRX / MMU', sub: '入队 · 快慢通路', group: 'hpp', x: 0, z: -38,
    cli: ['mirx show chiplet 0 pkt-cnt block all', 'mirx show chiplet 0 fcstatus block 0', 'mirx show chiplet 0 spaqmsb block 0'],
    info: ['按目标 TM 选择快速/慢速通路并入队。', 'SPAQM 维护源端口/PG/VC 占用，供 AQM 生成反压。'] },
  { id: 'tm', name: 'TM QC/SCH/POL', sub: '队列 · 调度 · 整形', group: 'hpp', x: 26, z: -38,
    cli: ['qc show queue_info chip 0 chiplet 0 tm addr_id 0', 'sch show chip 0 tm ins 0 context_conf', 'pol show chiplet 0 counter block 0'],
    info: ['QC 管队列/FD，SCH 在 Queue→CoS→Port 间调度，POL 管计数与 ECN。', '只有 PFC/CBFC/整形/资源条件都满足才出队。'] },
  { id: 'mitx', name: 'MITX', sub: 'FTAG · 出队缓存', group: 'hpp', x: 52, z: -38,
    cli: ['mitx show chip 0 chiplet 0 hpp ins 0 pkt_counter channel 0', 'mitx show chip 0 chiplet 0 fc_status', 'mitx show chip 0 chiplet 0 ftag_valid'],
    info: ['按调度结果读出报文，FTAG 保证保序。', '向 TM 返回 FTAG/FIFO credit。'] },
  { id: 'perx', name: 'PERX / PETX', sub: '出口改包', group: 'hpp', x: 78, z: -38,
    cli: ['perx show chip 0 chiplet 0 pipe 0 cnt', 'perx show chip 0 chiplet 0 pipe 0 sts'],
    info: ['出口解析与改包：去隧道头、改 VLAN/ACL、长度补偿。', '改包长度变化会回补或扣减出口 credit。'] },
  { id: 'maci_tx', name: 'MACI TX', sub: '出口 FIFO · PFC', group: 'hpp', x: 104, z: -38,
    cli: ['maci show chip 0 chiplet 0 pipe 0 tx cnt', 'maci show chip 0 chiplet 0 pipe 0 tx sts'],
    info: ['出口通道缓存，按 PFC 状态停读/恢复。', '镜像报文在此转入 MACI NOC。'] },
  { id: 'macw_tx', name: 'MACW TX', sub: 'MAC IP TX · 线侧发送', group: 'hpp', x: 130, z: -38,
    cli: ['macw show chip 0 chiplet 0 port 0 egress count', 'macw show chip 0 chiplet 0 port 0 status', 'macw show chip 0 chiplet 0 port 0 config'],
    info: ['按端口速率与 FEC 配置发送到线侧。', '承载 PFC/CBFC 控制帧的发送。'] },

  /* CPP 控制面（z = +38） */
  { id: 'ipfix', name: 'IPFIX DP', sub: '采样 / 统计报文', group: 'cpp', x: -130, z: 38,
    cli: ['ipfix ingress show summary', 'ipfix show block 0 ingress fifo stat'],
    info: ['IPFIX 采样报文经 CPP 上送 CPU。', '也用于 Telemetry / 流表统计上报。'] },
  { id: 'cpis', name: 'CPIS (IN)', sub: 'HOST / FW CPU 报文入口', group: 'cpp', x: -104, z: 38,
    cli: ['read pkt_dma cnt cpis', 'read pkt_dma intr cpis'],
    info: ['Host CPU 与 FW 的控制面/数据面网关。', 'CPU 报文从这里进入 CPP。'] },
  { id: 'cpis_out', name: 'CPIS (OUT)', sub: '上送 CPU', group: 'cpp', x: 130, z: 38,
    cli: ['read pkt_dma cnt cpis', 'read pkt_dma intr cpis'],
    info: ['CPP 上送 CPU 的报文从这里交给 HOST/FW。', '与 CPIS (IN) 是同一个物理接口的不同方向。'] },
  { id: 'cpp_maci_in', name: 'CPP MACI (IN)', sub: 'CPP 入向 MACI', group: 'cpp', x: -78, z: 38,
    cli: ['maci show chip 0 chiplet 0 pipe 0 rx cnt', 'cpp-pipe show instance 0 fifo_sts'],
    info: ['CPP 入向 MACI 汇聚 IPFIX/CPIS/AUX/HPP mirror 报文。', '按报文类型分流到 CPP pipeline 或 CPP MACI NOC。'] },
  { id: 'cpp_ing', name: 'CPP Ingress Pipeline', sub: '解析 · 查表 · 封装', group: 'cpp', x: -52, z: 38,
    cli: ['cpp-pipe show instance 0 limit-level-1 counter', 'cpp-pipe show instance 0 fifo_sts', 'cpp-pipe show instance 0 drop_count'],
    info: ['处理 CPU 报文与 EGRESS MIRROR 报文。', '输出 metadata 给 CPP MIRX。'] },
  { id: 'cpp_mirx', name: 'CPP MIRX', sub: '入队 · 跨 DIE 判定', group: 'cpp', x: -26, z: 38,
    cli: ['mirx show chiplet 0 pkt-cnt-cpp', 'mirx show chiplet 0 fcstatus block 64'],
    info: ['区分本 DIE / MIRROR / 跨 DIE 报文。', '本 DIE 报文进 XMMU，跨 DIE 报文直接送 SPARE UCIe。'] },
  { id: 'xmmu', name: 'XMMU', sub: '缓存 · MC Fabric', group: 'cpp', x: 0, z: 38,
    cli: ['mcbm show chiplet 0 total-buffer', 'mcfm show chiplet 0 flit-pkt-cnt', 'paqm show chiplet 0 src_db block 0'],
    info: ['本 DIE 与控制面报文的缓存和调度中心。', '也可接收其他 DIE 的 DATA/SPARE UCIe 输入。'] },
  { id: 'cpp_mce', name: 'CPP MCE', sub: '组播复制', group: 'cpp', x: 26, z: 38,
    cli: ['paqm show chiplet 0 egr_db block 0', 'display mce dropinfo'],
    info: ['组播报文的复制与跨 DIE 分发。', '复制前检查 queue/MCE/DIE 级反压。'] },
  { id: 'cpp_tm', name: 'CPP TM', sub: '队列 · 调度', group: 'cpp', x: 52, z: 38,
    cli: ['sch show chip 0 cpp ins 0 context_conf', 'qc show queue_info chip 0 chiplet 0 cpp'],
    info: ['CPU 上送报文的队列与调度。', '与 HPP TM 相同的 Queue→CoS→Port 调度模型。'] },
  { id: 'cpp_mitx', name: 'CPP MITX', sub: 'FTAG · 出队', group: 'cpp', x: 78, z: 38,
    cli: ['mitx show chip 0 cpp ins 0 pkt_counter channel 0', 'mitx show chip 0 cpp ins 0 control_info'],
    info: ['按调度结果读出 CPP 报文并保持顺序。'] },
  { id: 'cpp_egr', name: 'CPP Egress Pipeline', sub: '出向封装', group: 'cpp', x: 104, z: 38,
    cli: ['cpp-pipe show instance 0 drop_count', 'cpp-pipe show instance 0 egr_tohost'],
    info: ['CPU 上送报文的出口封装与格式转换。', '之后交 CPP MACI 从 CPIS 或 AUX 口发出。'] },
  { id: 'cpp_maci_eg', name: 'CPP MACI (EG)', sub: 'CPP 出向 MACI', group: 'cpp', x: 130, z: 38,
    cli: ['read pkt_dma cnt cpis', 'maci show chip 0 chiplet 0 pipe 0 tx cnt'],
    info: ['把 CPP 报文分发到 CPIS（上送 CPU）或 AUX MAC（出端口）。', '也承接 SP HPP Egress 的 AUX 普通二三层报文。'] },

  /* 共享 / 边界节点（z = 0） */
  { id: 'aux_in', name: 'AUX MAC (IN)', sub: 'AUX 口入向', group: 'ctrl', x: -140, z: 0,
    cli: ['aux_mac show chip 0 auxid 0 count', 'aux_mac show chip 0 auxid 0 link-status'],
    info: ['AUX 面板口入向报文（CPU/标准二三层/带互通头）。', '进入 CPP MACI 后按类型分流。'] },
  { id: 'cpp_maci_noc', name: 'CPP MACI NOC', sub: '转交 HPP 入口', group: 'shared', x: -112, z: 0,
    cli: ['cpp-pipe show instance 0 drop_count', 'maci show chip 0 chiplet 0 pipe 0 rx cnt'],
    info: ['标准/带互通头二三层报文不进入 CPP pipeline。', '由 CPP MACI NOC 直接送到 HPP Ingress MACI RX。'] },
  { id: 'hpp_maci_noc', name: 'HPP MACI NOC', sub: 'HPP 出口镜像', group: 'shared', x: -84, z: 0,
    cli: ['maci show chip 0 chiplet 0 pipe 0 tx cnt', 'macw show chip 0 chiplet 0 port 0 egress count'],
    info: ['HPP 出口镜像在 MACI TX 之后转入 MACI NOC。', '送到 CPP MACI，进入 EGRESS MIRROR 处理流程。'] },
  { id: 'sp_hpp_eg', name: 'SP HPP Egress', sub: 'AUX 出端口来源', group: 'shared', x: -14, z: 0,
    cli: ['petx show chip 0 chiplet 0 pipe 0 cnt', 'macw show chip 0 chiplet 0 port 0 egress count'],
    info: ['HPP 出口中 AUX 普通二三层报文的专用出口。', '交给 CPP MACI 从 AUX 口发出。'] },
  { id: 'bwli', name: 'UCIe / BWLI', sub: '跨 DIE 链路', group: 'cross', x: 22, z: 0,
    cli: ['bwli show chiplet 0 pkt-cnt tx-in-cnt block 0', 'bwli show chiplet 0 pkt-cnt rx-out-cnt block 0'],
    info: ['跨 DIE 报文经 BWLI/UCIe 发往目标 die。', '与 MIRX 之间有 credit 与 FC 闭环。'] },
  { id: 'spare_ucie', name: 'SPARE UCIe', sub: '跨 DIE 输出', group: 'cross', x: 52, z: 0,
    cli: ['bwli_spare show chiplet 0 spare_num 0 egress cnt', 'bwli_spare show chiplet 0 spare_num 0 sts'],
    info: ['CPP 跨 DIE 报文与 MCE 复制报文的跨 DIE 出口。', 'CPP MIRX 判定跨 DIE 时可不进 XMMU 直接发送。'] },
  { id: 'ucie_in', name: 'DATA/SPARE UCIe (IN)', sub: '其他 DIE 输入', group: 'cross', x: 86, z: 0,
    cli: ['bwli_spare show chiplet 0 spare_num 0 ingress cnt', 'bwli show chiplet 0 he-pkt-cnt rx-out-cnt block 0'],
    info: ['其他 DIE 的 DATA UCIe x16 / SPARE UCIe x1 输入。', '写入本 DIE XMMU 后参与本地缓存与调度。'] },
  { id: 'aux_out', name: 'AUX MAC (OUT)', sub: 'AUX 口出向', group: 'ctrl', x: 140, z: 0,
    cli: ['aux_mac show chip 0 auxid 0 count', 'aux_mac show chip 0 auxid 0 fc-status'],
    info: ['CPP 上送 CPU 之外的 AUX 出端口报文从这里发出。', '与 AUX MAC 入向共用面板口。'] }
];

window.PZZ_ROUTES = [
  {
    id: 'cpp_ipfix', group: 'cpp', kind: 'cpu', category: 'cpp_ctrl', filters: ['cpp'], name: 'IPFIX 上送 CPU',
    summary: 'IPFIX 采样报文 → CPP 入向流水线 → XMMU → CPP TM → 上送 CPIS',
    steps: ['ipfix', 'cpp_maci_in', 'cpp_ing', 'cpp_mirx', 'xmmu', 'cpp_tm', 'cpp_mitx', 'cpp_egr', 'cpp_maci_eg', 'cpis_out'],
    notes: { 0: 'IPFIX 报文 x1', 5: '上送 CPU 报文', 8: 'CPU 报文' }
  },
  {
    id: 'cpp_cpu', group: 'cpp', kind: 'cpu', category: 'cpp_ctrl', filters: ['cpp'], name: 'CPU 报文进入 CPP pipeline',
    summary: 'CPIS 的 HOST/FW CPU 报文 → CPP pipeline → XMMU/TM → CPP MACI 按类型发出',
    steps: ['cpis', 'cpp_maci_in', 'cpp_ing', 'cpp_mirx', 'xmmu', 'cpp_tm', 'cpp_mitx', 'cpp_egr', 'cpp_maci_eg'],
    notes: { 0: 'HOST/FW CPU 报文 x1', 2: 'CPU 报文', 8: 'CPIS / AUX' }
  },
  {
    id: 'cpp_aux_in', group: 'cpp', kind: 'data', category: 'local_aux', filters: ['local','aux','hpp'], name: 'AUX 二三层 → HPP 入口',
    summary: 'AUX 标准/带互通头二三层 → CPP MACI → CPP MACI NOC → HPP Ingress MACI RX',
    steps: ['aux_in', 'cpp_maci_in', 'cpp_maci_noc', 'maci_rx'],
    notes: { 0: 'AUX 二三层 x2', 1: '标准/带互通头', 2: '转交 HPP' }
  },
  {
    id: 'cpp_mirror', group: 'cpp', kind: 'mirror', category: 'cpp_mirror', filters: ['cpp','aux','mirror'], name: 'HPP 出口镜像 → CPU',
    summary: 'HPP Egress Mirror → CPP MACI → CPP pipeline → XMMU/TM → CPIS',
    steps: ['hpp_maci_noc', 'cpp_maci_in', 'cpp_ing', 'cpp_mirx', 'xmmu', 'cpp_tm', 'cpp_mitx', 'cpp_egr', 'cpp_maci_eg', 'cpis_out'],
    notes: { 0: 'EGRESS MIRROR x1', 1: 'MIRROR 报文', 8: '上送 CPU' }
  },
  {
    id: 'cpp_ucie_in', group: 'cpp', kind: 'cross', category: 'cross_cpp', filters: ['cross','cpp'], name: '其他 DIE 输入 → CPU',
    summary: 'DATA/SPARE UCIe 报文 → XMMU → CPP TM → MITX → CPIS',
    steps: ['ucie_in', 'xmmu', 'cpp_tm', 'cpp_mitx', 'cpp_egr', 'cpp_maci_eg', 'cpis_out'],
    notes: { 0: '其他 DIE 输入', 1: '上送 CPU 报文' }
  },
  {
    id: 'cpp_ucie_out', group: 'cpp', kind: 'cross', category: 'cross_cpp', filters: ['cross','cpp','mirror'], name: '本 DIE / Mirror → 跨 DIE',
    summary: 'CPP MIRX → XMMU → CPP MCE → SPARE UCIe（跨 DIE 输出）',
    steps: ['cpp_mirx', 'xmmu', 'cpp_mce', 'spare_ucie'],
    notes: { 0: '本 DIE / MIRROR', 2: '组播复制', 3: '跨 DIE 输出' }
  },
  {
    id: 'cpp_cross_direct', group: 'cpp', kind: 'cross', category: 'cross_cpp', filters: ['cross','cpp'], name: '跨 DIE 报文直发',
    summary: 'CPP MIRX 判定跨 DIE → 直接送 SPARE UCIe，不占本 DIE 缓存',
    steps: ['cpp_mirx', 'spare_ucie'],
    notes: { 0: '跨 DIE 报文', 1: 'SPARE UCIe x2' }
  },
  {
    id: 'cpp_xmmu_cross', group: 'cpp', kind: 'cross', category: 'cross_cpp', filters: ['cross','cpp'], name: 'XMMU 缓存后跨 DIE',
    summary: '本 DIE 缓存后仍需跨 DIE 的报文 → XMMU → SPARE UCIe',
    steps: ['cpp_mirx', 'xmmu', 'spare_ucie'],
    notes: { 1: '跨 DIE 报文', 2: 'SPARE UCIe x2' }
  },
  {
    id: 'cpp_sp_aux', group: 'cpp', kind: 'ctrl', category: 'local_aux', filters: ['local','aux','hpp'], name: 'SP HPP Egress → AUX 口',
    summary: 'SP HPP 出口的 AUX 普通二三层 → CPP MACI → AUX MAC',
    steps: ['sp_hpp_eg', 'cpp_maci_eg', 'aux_out'],
    notes: { 0: 'AUX 普通二三层', 1: 'CPP MACI' }
  },
  {
    id: 'cpp_tm_cpu', group: 'cpp', kind: 'ctrl', category: 'cpp_ctrl', filters: ['cpp'], name: 'CPP TM 调度 → CPU',
    summary: 'CPP TM 调度的上送 CPU 报文 → MITX → Egress → CPIS',
    steps: ['cpp_tm', 'cpp_mitx', 'cpp_egr', 'cpp_maci_eg', 'cpis_out'],
    notes: { 0: '上送 CPU', 3: 'CPU 报文' }
  },

  {
    id: 'hpp_l2', group: 'hpp', kind: 'data', category: 'local_hpp', filters: ['local','hpp'], name: 'HPP L2 单播本地转发',
    summary: 'MACW RX → MACI RX → PIRX → Parser/VLAN → L2 查表 → MMU/TM → MITX → MACW TX',
    steps: ['macw_rx', 'maci_rx', 'pirx', 'parse', 'lookup', 'mirx', 'tm', 'mitx', 'perx', 'maci_tx', 'macw_tx'],
    notes: { 3: '解析 + VLAN', 4: 'L2 EMF 查表', 7: '出队', 10: '本地口发出' }
  },
  {
    id: 'hpp_l3', group: 'hpp', kind: 'data', category: 'local_hpp', filters: ['local','hpp'], name: 'HPP L3 路由本地转发',
    summary: '同一 HPP 流水线，LOOKUP 阶段走 L3 LPM/NEXTHOP/ECMP',
    steps: ['macw_rx', 'maci_rx', 'pirx', 'parse', 'lookup', 'mirx', 'tm', 'mitx', 'perx', 'maci_tx', 'macw_tx'],
    notes: { 4: 'L3 LPM + ECMP', 7: '出队', 10: '下一跳口发出' }
  },
  {
    id: 'hpp_cpu_in', group: 'hpp', kind: 'cpu', category: 'local_aux', filters: ['local','aux','hpp'], name: 'CPU / AUX 注入 HPP',
    summary: 'CPP MACI NOC → HPP Ingress MACI RX → 完整 HPP 流水线 → MACW TX',
    steps: ['cpp_maci_noc', 'maci_rx', 'pirx', 'parse', 'lookup', 'mirx', 'tm', 'mitx', 'perx', 'maci_tx', 'macw_tx'],
    notes: { 0: '标准二三层 x16', 1: 'HPP Ingress', 4: '查表', 10: '线侧发出' }
  },
  {
    id: 'hpp_cross', group: 'hpp', kind: 'cross', category: 'cross_hpp', filters: ['cross','hpp'], name: 'HPP 入口 → 跨 DIE 转发',
    summary: 'MACW RX → 查表确定目的 DIE → MIRX → UCIe/BWLI',
    steps: ['macw_rx', 'maci_rx', 'pirx', 'parse', 'lookup', 'mirx', 'bwli'],
    notes: { 4: '目的 DIE 判定', 5: '跨 DIE 报文', 6: 'BWLI/UCIe' }
  },
  {
    id: 'hpp_mirror', group: 'hpp', kind: 'mirror', category: 'cpp_mirror', filters: ['cpp','aux','mirror'], name: 'HPP 出口镜像 → CPP',
    summary: 'HPP 出向 → MACI TX → MACI NOC → CPP MACI（进入 CPP 镜像处理）',
    steps: ['macw_rx', 'maci_rx', 'pirx', 'parse', 'lookup', 'mirx', 'tm', 'mitx', 'perx', 'maci_tx', 'hpp_maci_noc', 'cpp_maci_in'],
    notes: { 9: 'MACI TX', 10: 'HPP EGRESS MIRROR', 11: 'CPP MACI' }
  },
  {
    id: 'hpp_aux_eg', group: 'hpp', kind: 'ctrl', category: 'local_aux', filters: ['local','aux','hpp'], name: 'HPP 出口 → AUX 口',
    summary: 'HPP 出口的 AUX 普通二三层 → SP HPP Egress → CPP MACI → AUX MAC',
    steps: ['maci_tx', 'sp_hpp_eg', 'cpp_maci_eg', 'aux_out'],
    notes: { 0: 'HPP 出口', 1: 'AUX 普通二三层', 2: 'CPP MACI' }
  }
];
