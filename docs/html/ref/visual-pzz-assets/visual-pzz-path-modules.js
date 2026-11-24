/* ????????? / ?? / ?????? packet_path.html ? MODULES ?? */
window.PZZ_PATH_MODULES = {
  "parser": {
    "label": "Parser",
    "stage": "ingress",
    "role": "解析报文头部并生成后级使用的 metadata；清晰图中所有 10 类报文都从这里开始。",
    "inputs": [
      "MACI/PIRX FLIT",
      "前 256B 报文头",
      "Port / UDF / GPU ID"
    ],
    "outputs": [
      "协议类型",
      "UDF / tunnel 字段",
      "转发与控制 metadata"
    ]
  },
  "vfp": {
    "label": "VFP",
    "stage": "ingress",
    "role": "入口过滤和分类，结合 Port、UDF 与 VFP action 决定后续 VLAN/查表方向。",
    "inputs": [
      "Parser metadata",
      "Port / UDF 字段"
    ],
    "outputs": [
      "过滤结果",
      "分类/动作 metadata"
    ]
  },
  "ing-vlan": {
    "label": "ING VLAN",
    "stage": "ingress",
    "role": "执行 VLAN/XLATE、SVP、MYMAC 和隧道终结前的入口分类。",
    "inputs": [
      "VFP result",
      "VLAN / XLATE 配置",
      "隧道字段"
    ],
    "outputs": [
      "SVP",
      "VFI/PHB",
      "L2/L3 进入方向"
    ]
  },
  "emf": {
    "label": "EMF",
    "stage": "lookup",
    "role": "根据 MAC、DIP 或 MC 类型进行二层、路由或二层组播查表，给出初始转发类型。",
    "inputs": [
      "SMAC/DMAC",
      "DIP/VRF",
      "MC 类型"
    ],
    "outputs": [
      "L2EIF/DVP",
      "LPM/MC 结果",
      "FWD_TYPE"
    ]
  },
  "l3-path": {
    "label": "L3 path",
    "stage": "lookup",
    "role": "把报文送入三层转发路径，串起 LPM、ACL、ECMP、NEXTHOP 等路由动作。",
    "inputs": [
      "L3 enable",
      "DIP / VRF",
      "LIF MAC"
    ],
    "outputs": [
      "L3 转发结论",
      "下一跳上下文"
    ]
  },
  "acl": {
    "label": "ACL",
    "stage": "lookup",
    "role": "对入口或三层路径做过滤、动作、class 和 To Host 等策略判决。",
    "inputs": [
      "Parser metadata",
      "L2/L3 lookup result"
    ],
    "outputs": [
      "permit/drop",
      "class/action"
    ]
  },
  "lpm": {
    "label": "LPM",
    "stage": "lookup",
    "role": "根据 DIP 与 VRF/VFI 查询主机或路由前缀，得到下一跳或 ECMP 组。",
    "inputs": [
      "DIP",
      "VRF/VFI"
    ],
    "outputs": [
      "NEXTHOP index",
      "ECMP group"
    ]
  },
  "ecmp": {
    "label": "ECMP",
    "stage": "lookup",
    "role": "在等价路径中选择下一跳；VXLAN overlay/underlay 场景可能需要二次选择。",
    "inputs": [
      "ECMP group",
      "hash fields"
    ],
    "outputs": [
      "NEXTHOP index"
    ]
  },
  "nexthop": {
    "label": "NEXTHOP",
    "stage": "lookup",
    "role": "把路由或 ECMP 结果展开为出口、DVP、TRUNK 和改包所需的下一跳属性。",
    "inputs": [
      "NEXTHOP index",
      "ECMP result"
    ],
    "outputs": [
      "L2EIF/DVP",
      "出口属性"
    ]
  },
  "l2-eif": {
    "label": "L2EIF",
    "stage": "lookup",
    "role": "把二层或三层决策落到逻辑出口接口，为 TRUNK 和下游 PITX 提供出口上下文。",
    "inputs": [
      "EMF/LPM/NEXTHOP result"
    ],
    "outputs": [
      "逻辑出口",
      "端口/队列上下文"
    ]
  },
  "ing-trunk": {
    "label": "ING TRUNK",
    "stage": "lookup",
    "role": "入口侧聚合/端口选择；对 Scale Up、L2 和 VXLAN 路径提供统一的 ingress trunk 结果。",
    "inputs": [
      "L2EIF/DVP",
      "TRUNK 配置"
    ],
    "outputs": [
      "端口集合",
      "出口选择上下文"
    ]
  },
  "pitx": {
    "label": "PITX",
    "stage": "mmu",
    "role": "等待并对齐 payload 与 HPP metadata，把入口数据交给 XMMU；SOP 需要等 metadata 有效。",
    "inputs": [
      "PIRX payload",
      "HPP metadata",
      "SOP/EOP"
    ],
    "outputs": [
      "metadata + payload",
      "FD/入队上下文"
    ]
  },
  "xmmu": {
    "label": "XMMU",
    "stage": "mmu",
    "role": "管理共享 buffer、FD、跨 pipe/跨 die 互联；Scale Up 可走 bypass TM 的快速通路。",
    "inputs": [
      "FLIT + metadata",
      "buffer/credit"
    ],
    "outputs": [
      "FD",
      "buffer 链",
      "TM/跨 Die 流量"
    ]
  },
  "mce": {
    "label": "MCE",
    "stage": "mmu",
    "role": "承接组播、广播、Mirror 等复制动作，必要时构造多个 replica FD。",
    "inputs": [
      "复制 metadata",
      "原始 FD",
      "目的集合"
    ],
    "outputs": [
      "replica FD",
      "复制后的出口集合"
    ]
  },
  "mc-trunk": {
    "label": "MC TRUNK",
    "stage": "mmu",
    "role": "复制后的组播/广播报文选择聚合出口；只在 MC 或相关复制路径出现。",
    "inputs": [
      "MC group",
      "replica FD"
    ],
    "outputs": [
      "成员端口/出口 trunk"
    ]
  },
  "tm": {
    "label": "TM",
    "stage": "mmu",
    "role": "执行队列准入、拥塞、整形和调度；快速 bypass TM 路径会通过 annotation 标出。",
    "inputs": [
      "FD",
      "queue_id",
      "credit",
      "AQM/POL state"
    ],
    "outputs": [
      "dequeue",
      "ECN/drop/trim",
      "MITX context"
    ]
  },
  "mitx": {
    "label": "MITX",
    "stage": "mmu",
    "role": "接收 TM/XMMU 出队结果，把 payload 交给出口侧 PERX。",
    "inputs": [
      "FD/出队数据",
      "出口 metadata"
    ],
    "outputs": [
      "egress FLIT",
      "出口通道"
    ]
  },
  "perx": {
    "label": "PERX",
    "stage": "egress",
    "role": "提取出口 header/metadata，对齐并处理 VXLAN 终结后的外层无效字节。",
    "inputs": [
      "MITX 128B FLIT",
      "I2E/MMU header"
    ],
    "outputs": [
      "Egress metadata",
      "PETX payload"
    ]
  },
  "egr-parser": {
    "label": "EGR.parser",
    "stage": "egress",
    "role": "按出口业务重新解析报文并把 NEXTHOP、L3OIF、隧道封装信息交给出口 VLAN/Modify。",
    "inputs": [
      "PERX metadata",
      "出口报文头"
    ],
    "outputs": [
      "EGR nexthop/L3OIF",
      "tunnel context"
    ]
  },
  "egr-nexthop": {
    "label": "EGR.nexthop",
    "stage": "egress",
    "role": "展开出口下一跳的端口、隧道和改写上下文，供 L3OIF 与 EGR.VLAN 使用。",
    "inputs": [
      "EGR metadata",
      "NEXTHOP context"
    ],
    "outputs": [
      "EGR port",
      "DVP/L3OIF",
      "modify context"
    ]
  },
  "l3oif": {
    "label": "L3OIF",
    "stage": "egress",
    "role": "路由出口接口处理，提供外层 MAC、TTL、VLAN 和隧道改写所需的出口属性。",
    "inputs": [
      "EGR nexthop",
      "OIF context"
    ],
    "outputs": [
      "egress OIF",
      "rewrite plan"
    ]
  },
  "egr-vlan": {
    "label": "EGR.VLAN",
    "stage": "egress",
    "role": "出口 VLAN/XLATE、tag/untag、STG 和隧道出口动作聚合；实际字节修改在 PETX。",
    "inputs": [
      "PERX/EGR metadata",
      "OIF/tunnel context"
    ],
    "outputs": [
      "OTAG",
      "EGR class/drop",
      "modify metadata"
    ]
  },
  "egr-acl": {
    "label": "ACL",
    "stage": "egress",
    "role": "出口策略和 drop/class 判定，决定报文是否进入最终改包。",
    "inputs": [
      "EGR.VLAN result",
      "出口 metadata"
    ],
    "outputs": [
      "permit/drop",
      "class/action"
    ]
  },
  "tunnel-start": {
    "label": "Tunnel Start1",
    "stage": "special",
    "role": "为 VXLAN-start 或 DCI 出口建立第一层隧道外层封装。",
    "inputs": [
      "DVP/SVP",
      "outer DIP/SIP",
      "VNI"
    ],
    "outputs": [
      "outer tunnel metadata"
    ]
  },
  "tunnel-start2": {
    "label": "Tunnel Start2",
    "stage": "special",
    "role": "在需要二次封装或 DCI 重入时补齐第二层隧道处理。",
    "inputs": [
      "Tunnel Start1 result",
      "DCI context"
    ],
    "outputs": [
      "final tunnel header plan"
    ]
  },
  "dvp": {
    "label": "DVP",
    "stage": "special",
    "role": "VxLAN/隧道终结或开始时的虚拟端口上下文，连接 overlay 与 underlay 路径。",
    "inputs": [
      "SVP/VNI",
      "tunnel lookup"
    ],
    "outputs": [
      "DVP",
      "underlay NEXTHOP context"
    ]
  },
  "svp": {
    "label": "SVP",
    "stage": "special",
    "role": "VXLAN-end 入口识别到的源虚拟端口，用于判断隧道终结和内层转发方向。",
    "inputs": [
      "VLAN/XLATE",
      "VNI/SIP/DIP"
    ],
    "outputs": [
      "SVP",
      "tunnel termination context"
    ]
  },
  "mymac": {
    "label": "MYMAC",
    "stage": "special",
    "role": "识别本地 MAC/三层接口，决定隧道终结后进入 L2 还是内层 L3 路径。",
    "inputs": [
      "inner DMAC",
      "LIF MAC",
      "SVP"
    ],
    "outputs": [
      "L2/L3 branch"
    ]
  },
  "tecmp": {
    "label": "TECMP",
    "stage": "special",
    "role": "VXLAN-end 终结后的二次 ECMP/隧道查表，确定 DCI 或 underlay 方向。",
    "inputs": [
      "DVP",
      "inner/outer route context"
    ],
    "outputs": [
      "TNEXTHOP",
      "L2EIF/route action"
    ]
  },
  "tnexthop": {
    "label": "TNEXTHOP",
    "stage": "special",
    "role": "隧道终结后的下一跳展开，连接内层路由结果与 ingress trunk。",
    "inputs": [
      "TECMP/DVP result"
    ],
    "outputs": [
      "L2EIF",
      "ING TRUNK",
      "DCI context"
    ]
  },
  "petx": {
    "label": "PETX",
    "stage": "egress",
    "role": "出口最终落笔：VLAN、MAC、TTL、checksum、隧道、ECN、TRIM/DROP/MOD 和 FLIT 对齐。",
    "inputs": [
      "PERX FLIT",
      "Egress metadata",
      "Modify plan"
    ],
    "outputs": [
      "最终报文",
      "MACI TX"
    ]
  }
};
