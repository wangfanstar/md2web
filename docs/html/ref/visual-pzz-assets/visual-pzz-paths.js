/* 报文路径数据：由 sdk/doc/html/packet_path.html 的 PACKETS 提取 */
window.PZZ_PATH_TYPES = [
  {
    "id": "scale-up-simple",
    "label": "Scale Up 极简",
    "badges": [
      "bypass",
      "UCIe"
    ],
    "summary": "面向智算 Scale Up 的极简低时延路径，重点提取 GPU ID / outport 并减少通用查表开销。",
    "stages": {
      "ingress": [
        "parser",
        "vfp",
        "ing-vlan",
        "emf",
        "ing-trunk"
      ],
      "mmu": [
        "pitx",
        "xmmu",
        "mce",
        "mc-trunk",
        "tm"
      ],
      "egress": [
        "mitx",
        "perx",
        "egr-parser",
        "petx"
      ]
    },
    "notes": [
      "极简路径以低延迟为优先，Scale Up 同 pipe 内与非极简模式互斥。",
      "XMMU 可采用 bypass TM 或保留 TM 的快速通路，需结合 credit/反压配置确认。"
    ]
  },
  {
    "id": "scale-up-l2",
    "label": "Scale Up L2",
    "badges": [
      "bypass",
      "L2"
    ],
    "summary": "Scale Up 二层单播路径，使用 MAC(S,D) 相关查表结果完成快速二层转发。",
    "stages": {
      "ingress": [
        "parser",
        "vfp",
        "ing-vlan",
        "emf",
        "ing-trunk"
      ],
      "mmu": [
        "pitx",
        "xmmu",
        "mce",
        "mc-trunk",
        "tm"
      ],
      "egress": [
        "mitx",
        "perx",
        "egr-parser",
        "petx"
      ]
    },
    "notes": [
      "EMF 负责二层 MAC 方向判断，正常情况下不进入完整 L3 LPM/ECMP 路径。",
      "出口仍需要 PERX/EGR.parser/PETX 对齐和最终改包。"
    ]
  },
  {
    "id": "scale-up-l3-ipv4",
    "label": "Scale Up L3 IPv4 Route",
    "badges": [
      "bypass",
      "IPv4"
    ],
    "summary": "Scale Up 场景下的 IPv4 路由极简路径，以 ROUTE(DIP) 得到目标方向后快速出队。",
    "stages": {
      "ingress": [
        "parser",
        "vfp",
        "ing-vlan",
        "emf",
        "ing-trunk"
      ],
      "mmu": [
        "pitx",
        "xmmu",
        "mce",
        "mc-trunk",
        "tm"
      ],
      "egress": [
        "mitx",
        "perx",
        "egr-parser",
        "petx"
      ]
    },
    "notes": [
      "图中把 IPv4 route 结果压缩在 Scale Up 快速处理链中；与完整 Scale Out L3 路径区分。",
      "IPv4 路由的字段解释和出口修改仍依赖对应 metadata。"
    ]
  },
  {
    "id": "l2-uc-mc",
    "label": "L2：UC、MC",
    "badges": [
      "UC",
      "MC"
    ],
    "summary": "普通二层单播与组播共用入口分类，依据 EMF / L3 path / ACL 结果进入对应出口和复制路径。",
    "stages": {
      "ingress": [
        "parser",
        "vfp",
        "ing-vlan",
        "emf",
        "l3-path",
        "acl",
        "l2-eif",
        "ing-trunk",
        "pitx"
      ],
      "mmu": [
        "xmmu",
        "mce",
        "mc-trunk",
        "tm"
      ],
      "egress": [
        "mitx",
        "perx",
        "egr-parser",
        "l3-path",
        "egr-vlan",
        "egr-acl",
        "petx"
      ]
    },
    "notes": [
      "UC 和 MC 在 EMF/ACL 后分叉；MC 需要 MCE 复制并通过 MC TRUNK 选择成员。",
      "二层路径也可能在出口侧出现 L3 path 标签，需按 egress metadata 判断。"
    ]
  },
  {
    "id": "l3-uc",
    "label": "L3：UC",
    "badges": [
      "UC",
      "ECMP"
    ],
    "summary": "完整三层单播转发，经过 LPM、ACL、ECMP、NEXTHOP 和 L3OIF 后由出口 VLAN/ACL/PETX 定稿。",
    "stages": {
      "ingress": [
        "parser",
        "vfp",
        "ing-vlan",
        "emf",
        "lpm",
        "acl",
        "ecmp",
        "nexthop",
        "l2-eif",
        "ing-trunk",
        "pitx"
      ],
      "mmu": [
        "xmmu",
        "mce",
        "mc-trunk",
        "tm"
      ],
      "egress": [
        "mitx",
        "perx",
        "egr-parser",
        "egr-nexthop",
        "l3oif",
        "egr-vlan",
        "egr-acl",
        "petx"
      ]
    },
    "notes": [
      "LPM 决定路由前缀，ECMP/NEXTHOP 共同决定下一跳，错误出端口不能只看 LPM。",
      "PETX 负责 DMAC/SMAC、TTL、checksum、VLAN 和出口长度等最终修改。"
    ]
  },
  {
    "id": "l3-mc",
    "label": "L3：MC",
    "badges": [
      "MC",
      "copy"
    ],
    "summary": "三层组播路径，入口完成 L3 path/ACL，MMU 侧由 MCE 复制，出口继续执行 L3 path 与改写。",
    "stages": {
      "ingress": [
        "parser",
        "vfp",
        "ing-vlan",
        "emf",
        "l3-path",
        "acl",
        "l2-eif",
        "pitx"
      ],
      "mmu": [
        "xmmu",
        "mce",
        "mc-trunk",
        "tm"
      ],
      "egress": [
        "mitx",
        "perx",
        "egr-parser",
        "l3-path",
        "egr-vlan",
        "egr-acl",
        "petx"
      ]
    },
    "notes": [
      "复制发生在 MCE/XMMU 相关路径，replica 仍需分别进入 TM 队列并受出口拥塞约束。",
      "MC TRUNK 成员选择和出口 L3 path 是排查组播出端口的关键。"
    ]
  },
  {
    "id": "vxlan-end",
    "label": "VXLAN-end",
    "badges": [
      "Tunnel",
      "DCI",
      "Gateway"
    ],
    "summary": "VXLAN 隧道终结路径，先由 SVP/MYMAC 识别外层，再对内层 L2 或 L3 重新查表。",
    "stages": {
      "ingress": [
        "parser",
        "vfp",
        "ing-vlan",
        "svp",
        "mymac",
        "emf",
        "acl",
        "dvp",
        "l2-eif",
        "ing-trunk",
        "pitx"
      ],
      "mmu": [
        "xmmu",
        "mce",
        "mc-trunk",
        "tm"
      ],
      "egress": [
        "mitx",
        "perx",
        "egr-parser",
        "egr-vlan",
        "egr-acl",
        "petx"
      ]
    },
    "notes": [
      "VXLAN-end 的关键不是单纯剥头，而是终结后内层 L2/L3 的再次判决。",
      "外层隧道字段命中不完整时，可能转入隧道报文三层转发路径。"
    ]
  },
  {
    "id": "vxlan-start",
    "label": "VXLAN-start",
    "badges": [
      "Tunnel",
      "DCI",
      "Gateway"
    ],
    "summary": "VXLAN 隧道开始路径，出口侧从 DVP/SVP 和路由结果生成一层或两层外部隧道头。",
    "stages": {
      "ingress": [
        "parser",
        "vfp",
        "ing-vlan",
        "mymac",
        "l3-path",
        "acl",
        "l2-eif",
        "ing-trunk"
      ],
      "mmu": [
        "pitx",
        "xmmu",
        "mce",
        "mc-trunk",
        "tm"
      ],
      "egress": [
        "mitx",
        "perx",
        "egr-parser",
        "tunnel-start",
        "tunnel-start2",
        "egr-vlan",
        "egr-acl",
        "petx"
      ]
    },
    "notes": [
      "VXLAN-start 的核心差异在 egress Tunnel Start，而不是入口 Parser。",
      "EGR.VLAN、ACL 和 PETX 共同完成外层 VLAN、策略与最终字节修改。"
    ]
  },
  {
    "id": "vxlan-outer-mc",
    "label": "VXLAN 外层 MC 场景",
    "badges": [
      "Tunnel",
      "MC",
      "规格限制"
    ],
    "summary": "VXLAN 外层组播场景，强调组播隧道与核心复制能力；图中同时保留 MC/MIRROR 能力限制提示。",
    "stages": {
      "ingress": [
        "parser",
        "vfp",
        "ing-vlan",
        "emf",
        "ing-trunk",
        "pitx"
      ],
      "mmu": [
        "xmmu",
        "mce",
        "mc-trunk",
        "tm"
      ],
      "egress": [
        "mitx",
        "perx",
        "egr-parser",
        "tunnel-start",
        "egr-vlan",
        "egr-acl",
        "petx"
      ]
    },
    "notes": [
      "此行保留源图中的‘规格不支持 MC/MIRROR?’疑问，不把它解释为已经确认的硬件结论。",
      "MCE、MC TRUNK 和 TM 是该场景的重点观察模块。"
    ]
  },
  {
    "id": "simple-mc-mirror",
    "label": "极简模式 MC/MIRROR",
    "badges": [
      "bypass",
      "MC",
      "MIRROR"
    ],
    "summary": "极简模式下的组播/镜像相关路径，保留统一的 Parser/VFP/ING VLAN 与复制链。",
    "stages": {
      "ingress": [
        "parser",
        "vfp",
        "ing-vlan",
        "emf",
        "ing-trunk",
        "pitx"
      ],
      "mmu": [
        "xmmu",
        "mce",
        "mc-trunk",
        "tm"
      ],
      "egress": [
        "mitx",
        "perx",
        "egr-parser",
        "petx"
      ]
    },
    "notes": [
      "极简 MC/MIRROR 仍需单独关注复制和出口带宽保护，不能只按普通 Scale Up bypass 路径理解。",
      "Egress mirror 可能通过 HPP MACI_NOC 回到 CPP MACI，跨 die 场景还需看 spare UCIe。"
    ]
  }
];
