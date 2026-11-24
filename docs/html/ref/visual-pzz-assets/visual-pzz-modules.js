/* 模块索引数据：由 sdk/doc/docs/ref_md/pzz_chip_ref/*.md 生成 */
window.PZZ_GROUPS = [
  {
    "id": "serdes",
    "name": "SerDes / Ethernet"
  },
  {
    "id": "hpp",
    "name": "HPP PIPE"
  },
  {
    "id": "maci",
    "name": "MACI / CPP"
  },
  {
    "id": "mmu",
    "name": "MMU / Buffer"
  },
  {
    "id": "tm",
    "name": "TM / QoS"
  },
  {
    "id": "ucie",
    "name": "UCIe / Bridge"
  },
  {
    "id": "pcie",
    "name": "PCIe"
  },
  {
    "id": "soc",
    "name": "SoC / 其他"
  }
];
window.PZZ_MODULES = [
  {
    "id": "serdes",
    "name": "SerDes",
    "group": "serdes",
    "summary": "SerDes模块作为构建外部SerDes链路的高速串行物理接口，采用时分多路复用，点对点的高速串行通信的技术，实现外部长距、抗噪声、抗干扰的差分传输；对内实现并行数据的串-并、并-串转换。在PZZ项目中承载ETH协议数据传输。本文详细介绍112G SerDes",
    "subs": [
      "sds_top",
      "cmu_top"
    ]
  },
  {
    "id": "eth",
    "name": "ETH",
    "group": "serdes",
    "summary": "本文档为QLake接口模块ETH的设计文档。",
    "subs": [
      "netp_data_adapt_top",
      "netp_rx_drop_pkt",
      "netp_chan_buff",
      "netp_rx_weave",
      "netp_rx_schedule",
      "netp_tx_schedule"
    ]
  },
  {
    "id": "eth_auxw",
    "name": "ETH AUXW",
    "group": "serdes",
    "summary": "AUX_WRAPPER 是PZZ项目中的以太网接口IP模块，负责接收和发送标准以太网协议。本文主要描述了顶层架构框图、规格需求、详细设计等信息。",
    "subs": [
      "CEMAC_TOP",
      "TX方向通路",
      "RX方向通路",
      "CEPCS_RX_TOP",
      "功能详述",
      "CEPCS_TX_TOP"
    ]
  },
  {
    "id": "eth_cbfc",
    "name": "ETH CBFC",
    "group": "serdes",
    "summary": "本文是CBFC（Credit-based Flow Control）模块的实现说明文档，该模块是ETH的一个子模块，主要负责标准CBFC协议的实现，目的是消除由于接收端缓存拥塞导致的丢包问题。本模块分为发送端（CBFC_TX）和接收端（CBFC_RX）：发送端",
    "subs": [
      "CBFC",
      "《协议规范》",
      "General Overview",
      "Cyclic Counters for Tracking Credits with Resiliency",
      "Overview",
      "Configuration Parameters and Initialization"
    ]
  },
  {
    "id": "eth_llr",
    "name": "ETH LLR",
    "group": "serdes",
    "summary": "本文是LLR（Link Level Retry）模块的实现说明文档，该模块是ETH的一个子模块，主要负责标准ETH重传协议的实现。本模块分为TX侧和RX侧：TX侧负责给每个支持重传的包分配序列号，并进行缓存；RX侧负责检查每个支持重传包的序列号是否连续。LLR",
    "subs": [
      "LLR_TX支持对接收的数据是否需要支持重传进行判断",
      "LLR_TX支持对LLR-eligible frame增加重传相关信息",
      "LLR_TX支持对LLR-eligible frame进行缓存及端口间缓存共享",
      "LLR_RX支持根据接收frame的重传信息进行处理",
      "LLR_RX支持对非预期的frame打上标记发往后级",
      "支持接收发送CtlOS，用于握手及frame接收确认"
    ]
  },
  {
    "id": "CEFEC_reference_guide_v1.1",
    "name": "CEFEC",
    "group": "serdes",
    "summary": "Channelized Ethernet Forward Error Correction core provides RS (544,514), RS (528,514) and RS (272,257) encode and decode function",
    "subs": [
      "Configuration",
      "Use for library",
      "Use for Simulation",
      "Use for Modes Selection",
      "Use for ESTAT"
    ]
  },
  {
    "id": "CEMAC_reference_guide_v1.7",
    "name": "CEMAC",
    "group": "serdes",
    "summary": "The CEMAC provides 10G to 400G Ethernet MAC layer functions per IEEE802.3 Standard. It allows flexible configurations to support v",
    "subs": [
      "TX 帧封装",
      "RX 帧解析",
      "Pause / PFC",
      "CRC / FCS",
      "统计计数",
      "接口 / 时序"
    ]
  },
  {
    "id": "CEPCS_reference_guide_v1.82",
    "name": "CEPCS",
    "group": "serdes",
    "summary": "Channelized Ethernet Physical Coding Sublayer (CEPCS) core provides all PCS functions for 10G to 400G Ethernet Channels defined by",
    "subs": [
      "PCS 编码",
      "PMA 适配",
      "对齐 / 去偏斜",
      "FEC 接口",
      "状态机",
      "统计 / 中断"
    ]
  },
  {
    "id": "CESOCX16_WRAP_reference_guide_v1.0",
    "name": "CESOCX16 WRAP",
    "group": "serdes",
    "summary": "CESOC_X12_WRAP is a design that includes 2x 400G Ethernet sub-system(CESOCX8) and FlexE sub-system to support 16 Serdes Lanes appl",
    "subs": [
      "Environment Directory",
      "Testcases",
      "Reset Diagram"
    ]
  },
  {
    "id": "hpp_maci",
    "name": "HPP MACI",
    "group": "hpp",
    "summary": "HPP PIPE 模块",
    "subs": [
      "MACI RX",
      "MACI TX",
      "Flex FIFO",
      "AUX / BFD 通道",
      "Mirror / Loopback",
      "Bytes 统计"
    ]
  },
  {
    "id": "pirx_perx",
    "name": "PIRX / PERX",
    "group": "hpp",
    "summary": "本文描述了PIRXPERX模块的功能需求、性能需求、接口、寄存器配置、方案详细设计等，DE、DV、SW都可以阅读本文档，DE根据该文档进行RTL编写，DV、SW可以通过该文档更深入的理解DE的方案实现方法，有针对性的开发测试case。",
    "subs": [
      "数据管理模块",
      "入口fifo",
      "Header汇聚模块",
      "HPP header汇聚",
      "hpp_ofifo",
      "Header调度模块"
    ]
  },
  {
    "id": "pitx",
    "name": "PITX",
    "group": "hpp",
    "summary": "本文档详细描述QLAKE V100R001项目上行子系统PITX的功能以及实现方式，是QLAKE V100R001项目上行子系统PITX的技术说明文档，同时用于指导后续项目组成员的开发和测试工作。",
    "subs": [
      "存储调度",
      "Metadata 存储",
      "SOP 对齐",
      "Modify",
      "报文对齐",
      "TRIM / MOD"
    ]
  },
  {
    "id": "petx",
    "name": "PETX",
    "group": "hpp",
    "summary": "本文档为PZZ项目PI子系统PETX模块的设计文档。描述了PETX模块的需求规格、编程手册及详细设计等内容，可为开发人员、验证人员及相关模块负责人提供关于该模块清晰的理解。",
    "subs": [
      "支持接收并调报文",
      "支持接收并调度METADATA",
      "支持配合PERX完成本地SRAM地址管理",
      "支持发送报文、METADATA给MACi",
      "支持响应MACi反压",
      "支持接收MACi带宽统计信息"
    ]
  },
  {
    "id": "pi_csig",
    "name": "PI CSIG",
    "group": "hpp",
    "summary": "HPP PIPE 模块",
    "subs": [
      "CSIG 标签格式",
      "标签生成",
      "标签解析",
      "与 PITX 接口",
      "错误检查",
      "配置"
    ]
  },
  {
    "id": "parser_ingress_parser",
    "name": "Ingress Parser",
    "group": "hpp",
    "summary": "本文档为QLake项目Parser子系统INGR_Parser模块的设计文档，描述了INGR_Parser模块的需求规格、编程手册及详细设计等内容，可为开发人员、验证人员及相关模块负责人提供关于INGR_Parser模块清晰的理解。",
    "subs": [
      "以太网帧",
      "ARP",
      "IPV4",
      "IPV6",
      "UDP",
      "TCP"
    ]
  },
  {
    "id": "parser_icu",
    "name": "Parser ICU",
    "group": "hpp",
    "summary": "本文档为QLake V100R001项目Parser子系统ICU模块的设计文档。",
    "subs": [
      "以太网帧",
      "IPv4",
      "IPv6",
      "TCP/UDP/ICMP/ICMPv6",
      "RoCEv2",
      "UEC"
    ]
  },
  {
    "id": "parser_egress_parser",
    "name": "Egress Parser",
    "group": "hpp",
    "summary": "本文档为PZZ项目EGR-Parser模块的设计文档。",
    "subs": [
      "VLAN",
      "IPv4",
      "UDP",
      "TCP",
      "SCTP",
      "IPv4 ICMP header"
    ]
  },
  {
    "id": "hash",
    "name": "HASH",
    "group": "hpp",
    "summary": "本文档为QLake项目ECMP子系统HASH模块的设计文档。",
    "subs": [
      "HASH 功能模块",
      "REQ & RSP格式",
      "计算信息",
      "BIN prepare",
      "HASH SM"
    ]
  },
  {
    "id": "acl",
    "name": "ACL",
    "group": "hpp",
    "summary": "本文档根据QLake项目的ACL模块的功能需求，主要为数字电路设计人员、验证人员以及其他需要了解本模块内部操作细节的人员提供参考。",
    "subs": [
      "Acl_lxf",
      "Acl_gen_key",
      "Acl_tcam_ctl",
      "Acl_dc_matrix",
      "Acl_admem",
      "Acl_comb"
    ]
  },
  {
    "id": "l3_lpm",
    "name": "L3 LPM",
    "group": "hpp",
    "summary": "HPP PIPE 模块",
    "subs": [
      "lpm_tcam_comp",
      "lpm_decode1"
    ]
  },
  {
    "id": "l3_oif",
    "name": "L3 OIF",
    "group": "hpp",
    "summary": "HPP PIPE 模块",
    "subs": [
      "支持本地容量16K（单pipe）",
      "支持远程最大容量32K（双pipe共享）",
      "每个报文查2次L3OIF"
    ]
  },
  {
    "id": "l3_nexhop_frr_oif",
    "name": "L3 NH / FRR / OIF",
    "group": "hpp",
    "summary": "适用于网络设备等网关协议中的数据包转发过程中下一跳的查找表以及FRR查找表，其为L3网络层子系统中的下一跳查表，其作用是告诉其他网络设备当接收到该路由时，应将数据包转发到哪个IP地址。可分为本地直接查表或者远程查表；也可为下一级的1xFRR_GROUP的查表提",
    "subs": [
      "NH_local_table",
      "NH_remote_interface",
      "BUFFER_MNG",
      "ID_MNG",
      "FRR_GROUP",
      "L3_OIF"
    ]
  },
  {
    "id": "egr_nexthop",
    "name": "Egress Nexthop",
    "group": "hpp",
    "summary": "HPP PIPE 模块",
    "subs": [
      "支持本地容量16K（单pipe）",
      "支持远程最大容量64K（双pipe共享）",
      "每个报文查1次EGR_NEXTHOP"
    ]
  },
  {
    "id": "ingress_dvp",
    "name": "Ingress DVP",
    "group": "hpp",
    "summary": "HPP PIPE 模块",
    "subs": [
      "Hardware interface 硬件接口",
      "表项初始化",
      "带流配置表项",
      "缓存阈值说明"
    ]
  },
  {
    "id": "ingress_vlan_vxlan",
    "name": "Ingress VLAN / VXLAN",
    "group": "hpp",
    "summary": "适用于51.2Tbps交换机中的入方向VLAN查表/VxLAN查表/VxLAN隧道终结/IP隧道终结功能的实现。",
    "subs": [
      "VFP Master Key",
      "VFP查表结果",
      "VFP采样配置",
      "给VLAN查表模块输出数据格式",
      "给隧道终结模块输出数据格式",
      "给出口聚合模块输出数据格式"
    ]
  },
  {
    "id": "egress_vlan_vxlan",
    "name": "Egress VLAN / VXLAN",
    "group": "hpp",
    "summary": "EGR_VLAN_VxLAN模块需要从EGR_PARSER模块获取I2E_MSG信息，为二层/三层转发报文重新封装报文内层ETH头和IP头，以及判断报文是否需要入隧道，并为入隧道报文打包隧道头，包括隧道外层的ETH头、IP头、UDP头、VxLAN头、GRE头和",
    "subs": [
      "EGR_DVP表",
      "数据分发",
      "查EGR_DVP表",
      "反压与数据输出",
      "转发类型判定",
      "EGR_DVP统计"
    ]
  },
  {
    "id": "emf",
    "name": "EMF",
    "group": "hpp",
    "summary": "本文描述了EMF模块的功能需求、性能需求、接口、方案详细设计等，DE、DV、SW都可以阅读本文档，DE根据该文档进行RTL编写，DV、SW可以通过该文档更深入的理解DE的方案，有针对性的开发测试case。",
    "subs": [
      "SMAC_TBL_MNG模块",
      "DMAC_TBL_MNG模块",
      "SMAC_SEARCH_ENGINE模块",
      "DMAC_SEARCH_ENGINE模块",
      "LEARN_MOVE_ENGINE模块",
      "SCAN_ENGINE模块"
    ]
  },
  {
    "id": "ecmp",
    "name": "ECMP",
    "group": "hpp",
    "summary": "本文档为QLake项目HPP dynamic子系统ECMP模块的设计文档，描述了ECMP模块的需求规格、编程手册及详细设计等内容，可为开发人员、验证人员及相关模块负责人提供关于ECMP模块清晰的理解。",
    "subs": [
      "ECMP/TECMP",
      "ECMP_GROUP",
      "ECMP_MEMBER",
      "Cos_vc_map",
      "Hash profile",
      "流程说明"
    ]
  },
  {
    "id": "trunk",
    "name": "TRUNK",
    "group": "hpp",
    "summary": "本文档为L2EIF&trunk查找模块的设计文档。本模块在芯片中承担L2EIF 查找功能，链路聚合负载分担功能，link failover 功能，以及mirror采样功能,。本文档会对整体设计、规格列表、接口列表、表项设计等做详细的介绍。并作为代码开发的输入文",
    "subs": [
      "ING TRUNK 子系统设计",
      "Hash_data 数据格式",
      "Fwd_type 数据格式",
      "流水线功能",
      "端口类型判断",
      "链路聚合功能实现"
    ]
  },
  {
    "id": "aqm",
    "name": "AQM",
    "group": "hpp",
    "summary": "AQM收集和同步各DIE的缓存使用统计，根据各类统计信息提前产生流控信息给源端口，产生PFC/CBFC机制通知给对端，避免芯片内缓存溢出和拥塞丢包。",
    "subs": [
      "aqm_data_parse",
      "aqm _fcu",
      "aqm_unique"
    ]
  },
  {
    "id": "congestion_control",
    "name": "Congestion Control",
    "group": "hpp",
    "summary": "本文档为PZZ项目Congestion Control的特性文档。",
    "subs": [
      "FAST CNP",
      "Function Overview 功能概述",
      "ECN",
      "FAST CNP实现方案",
      "TRIM",
      "TRIMABLE端"
    ]
  },
  {
    "id": "telemetry",
    "name": "Telemetry",
    "group": "hpp",
    "summary": "本文档为PZZ项目TELEMETRY 的特性文档。",
    "subs": [
      "BFD",
      "RSPAN",
      "ERSPAN",
      "IFA",
      "Function Overview 功能概述",
      "Related Modules 相关模块"
    ]
  },
  {
    "id": "dlb",
    "name": "DLB",
    "group": "hpp",
    "summary": "本文描述DLB模块的功能需求，主要为数字电路设计人员、验证人员以及其他需要了解本模块内部操作细节的人员提供参考。",
    "subs": [
      "表项规格",
      "表项并行查找",
      "ECMP的DLB/GLB选口",
      "ECMP的DLB模式"
    ]
  },
  {
    "id": "sbc",
    "name": "SBC",
    "group": "hpp",
    "summary": "It is suitable for digital signature and verification, message authentication code generation and verification, and random number ",
    "subs": [
      "SBC管理对应的MIRX",
      "管理64个MCBM池",
      "动态打开关闭SBC的能力",
      "给指定的MI分配MCBM",
      "部分AQM功能实现",
      "关键信息上报"
    ]
  },
  {
    "id": "oob",
    "name": "OOB",
    "group": "hpp",
    "summary": "本文档为OOB模块结构与功能，供验证同事与软件同事使用。",
    "subs": [
      "支持接收4路FNOC消息",
      "支持接收1路DLB信息",
      "支持接收1路GLB信息",
      "支持接收1路SAQM信息",
      "支持接收1路NAQM信息",
      "支持各类消息DIE-TO-DIE反压"
    ]
  },
  {
    "id": "maci_noc",
    "name": "MACI NOC",
    "group": "maci",
    "summary": "本文适用于QLake V100R001项目开发IC Design，IC DV,FPGA/Emual及软件设计人员，描述了MAIC_NOC的概要设计",
    "subs": [
      "NOC 请求 / 响应",
      "CPP ↔ HPP 通道",
      "AUX / BFD 通路",
      "Credit / 反压",
      "路由 / 仲裁",
      "统计"
    ]
  },
  {
    "id": "cpp_maci",
    "name": "CPP MACI",
    "group": "maci",
    "summary": "本文档为QLake V100R001项目CPP_MACI子系统的设计文档。",
    "subs": [
      "CPP_MACI_RX",
      "以太网帧",
      "IPV4",
      "IPV6",
      "UDP",
      "TCP"
    ]
  },
  {
    "id": "cpp_pipe",
    "name": "CPP PIPE",
    "group": "maci",
    "summary": "本文档为QLake项目CPP子系统CPP PIPE模块的设计文档。",
    "subs": [
      "总体概述",
      "上行数据流",
      "下行数据流",
      "内部上行数据流",
      "内部下行数据流",
      "支持配置为极简模式"
    ]
  },
  {
    "id": "cpp_hpp",
    "name": "CPP / HPP Flow",
    "group": "maci",
    "summary": "MACI / CPP 模块",
    "subs": [
      "CPP Egress 数据流",
      "CPP MACI 入口",
      "AUX / CPIS 通路",
      "MACI NOC",
      "Spare UCIe",
      "OOB"
    ]
  },
  {
    "id": "parser_cpp_icu",
    "name": "CPP ICU Parser",
    "group": "maci",
    "summary": "本文档为QLake V100R001项目Parser子系统CPP_ICU模块的设计文档。",
    "subs": [
      "以太网帧",
      "IPv4",
      "IPv6",
      "TCP/UDP/ICMP/ICMPv6",
      "CPU2CPP HDR",
      "报文类型"
    ]
  },
  {
    "id": "ipfix",
    "name": "IPFIX",
    "group": "maci",
    "summary": "描述及分析QLake V100R001项目的IPFIX模块的功能需求，主要为数字电路设计人员、验证人员以及其他需要了解本模块内部操作细节的人员提供参考。",
    "subs": [
      "入口报文处理和HashKey解析模块(rx_packet_engine)",
      "ipfix使能判断",
      "IPFIX KEY的选择",
      "IPFIX KEY的掩码",
      "入口报文pkt buffer"
    ]
  },
  {
    "id": "mi_rx",
    "name": "MIRX",
    "group": "mmu",
    "summary": "本文描述了MIRX/UMIRX/CMIRX模块的功能需求、性能需求、接口、寄存器配置、方案详细设计等，DE、DV、SW都可以阅读本文档，DE根据该文档进行RTL编写，DV、SW可以通过该文档更深入的理解DE的方案实现方法，有针对性的开发测试case。",
    "subs": [
      "Protocal check",
      "MC sel/Tag alloc",
      "ENQ Manager",
      "mirr enq",
      "Packet Manager",
      "Source Port counters"
    ]
  },
  {
    "id": "mi_tx",
    "name": "MITX",
    "group": "mmu",
    "summary": "本文档为QLake项目MMU接口传输模块MITX的设计文档，描述了该模块从需求规格、概要设计到详细设计的全部内容。",
    "subs": [
      "mitx_xb",
      "Mitx_data_buffer",
      "Mitx_read_manager"
    ]
  },
  {
    "id": "mcbm",
    "name": "MCBM",
    "group": "mmu",
    "summary": "本文档为MMU子系统MCBM的架构文档，为了支持QLake项目以太网交换芯片的缓存管理功能。MCBM 模块负责管理本地帧内存的帧缓冲区（buffer）；为每个 MC 模块的6个MCRX 模块分配buffer、并根据link write指令完成建链；根据link",
    "subs": [
      "Allocation模块",
      "Link write模块",
      "Link read模块",
      "Recycle模块",
      "AQM"
    ]
  },
  {
    "id": "mce",
    "name": "MCE",
    "group": "mmu",
    "summary": "本文档为组播引擎（MCE）系统模块的设计文档。MCE模块在芯片中承担组播报文的出入队管理、组播报文的拷贝、组播缓存空间的管理、普通组播报文的复制以及镜像报文的复制的功能。本模块采用新的组播实现架构，本文档会对整体设计、规格列表、接口列表、表项设计等做详细的介绍",
    "subs": [
      "EDQ-组播出入队管理模块",
      "buffer & entry说明",
      "入队处理",
      "调度出队处理",
      "fd下行处理",
      "AQM处理"
    ]
  },
  {
    "id": "cmmu_noc",
    "name": "CMMU NOC",
    "group": "mmu",
    "summary": "本文适用于QLake V100R001项目开发IC Design，IC DV,FPGA/Emual及软件设计人员，描述了CMMU_NOC的概要设计",
    "subs": [
      "支持CKN,CRN两个网络",
      "CKN/CRN由4x4 noc网络组成",
      "CKN/CRN支持自适应路由可配置",
      "CRN支持通过xbar将响应路由到正确目的节点"
    ]
  },
  {
    "id": "bmu",
    "name": "BMU",
    "group": "mmu",
    "summary": "本文档为缓存管理子系统BMU的架构文档，为了支持QLake项目交换网接入芯片的缓存管理功能。BMU在TM子系统的快速通路中，负责分配buffer存储地址给RND，并从TND中接收释放的缓存地址。BMU负责集中管理一定数量的内存资源BD的索引列表，分配和回收这些",
    "subs": [
      "IDP",
      "Sub_pool management（mini_bmu_ftagm）",
      "mini_bmu_sort_alc_logic"
    ]
  },
  {
    "id": "cmc",
    "name": "CMC",
    "group": "mmu",
    "summary": "适用于PZZ项目统计子系统CMMU设计，满足系统中多种表项统计的需求。",
    "subs": [
      "支持多种Counter统计类型",
      "支持Counter计数1分钟不翻转",
      "支持单Die 64K个Counter",
      "支持硬件扫描机功能及中断上报",
      "支持4个44的NOC拓扑",
      "支持一拍最大128个counter操作"
    ]
  },
  {
    "id": "xmmu_dlb_glb_aqm_noc",
    "name": "XMMU DLB/GLB/AQM NOC",
    "group": "mmu",
    "summary": "本文档主要说明GLB &DLB 以及AQM NOC的整体设计方案。",
    "subs": [
      "DLB",
      "GLB",
      "AQM",
      "NOC",
      "Credit 管理",
      "统计"
    ]
  },
  {
    "id": "xmmu_gnoc",
    "name": "XMMU GNOC",
    "group": "mmu",
    "summary": "本文档主要说明GNOC以及基于GNOC的其他NOC设计说明，供周边模块以及相关验证软件同事参考。包含范围：~~MCRN~~、MCTN、MCCN、EQN、ESN、FDTXN、MTBC、QRQN、QRSN、MTLN 10个noc 模块，模块之间仅有参数以及拓扑数量",
    "subs": [
      "请求通道",
      "响应通道",
      "路由",
      "仲裁",
      "Credit",
      "错误处理"
    ]
  },
  {
    "id": "xmmu_mccs",
    "name": "XMMU MCCS",
    "group": "mmu",
    "summary": "本文档为QLake项目XMMU子系统MCCS模块的设计文档。描述了MCCS模块的需求规格、编程手册及详细设计等内容，可为开发人员、验证人员及相关模块负责人提供关于该模块清晰的理解。",
    "subs": [
      "RX Distributor",
      "FD-TO-TX",
      "FD-TO-TX-MC",
      "FLUSH",
      "FD_FIFO & FD Decode",
      "CN_FIFO & CN_RR2 & Flush Decode"
    ]
  },
  {
    "id": "xmmu_mcfm",
    "name": "XMMU MCFM",
    "group": "mmu",
    "summary": "描述MCFM模块的功能需求，主要为数字电路设计人员、验证人员以及其他需要了解本模块内部操作细节的人员提供参考。",
    "subs": [
      "Fabric control",
      "TX0 / TX1",
      "TD0 / TD1",
      "FIFO",
      "Flit / Packet 计数",
      "Error / 中断"
    ]
  },
  {
    "id": "xmmu_mcrx",
    "name": "XMMU MCRX",
    "group": "mmu",
    "summary": "描述MCRX模块的功能需求，主要为数字电路设计人员、验证人员以及其他需要了解本模块内部操作细节的人员提供参考。",
    "subs": [
      "Prematrue EOP错误检测",
      "Unexpected SOP错误检测",
      "Missing SOP错误检测",
      "FlitCounter overflow错误检测",
      "Buffer Allocation Timeout错误检测",
      "RN ERR错误检测"
    ]
  },
  {
    "id": "xmmu_mctd",
    "name": "XMMU MCTD",
    "group": "mmu",
    "summary": "本文档为QLake项目XMMU子系统MCTD模块的设计文档。描述了MCTD模块的需求规格、编程手册及详细设计等内容，可为开发人员、验证人员及相关模块负责人提供关于该模块清晰的理解。",
    "subs": [
      "FM Data Unit",
      "Metadata",
      "AQM update",
      "TN NOC Field (MCTD->MCTN)",
      "TD Metadata",
      "Flit Flow Diagram"
    ]
  },
  {
    "id": "xmmu_mctx",
    "name": "XMMU MCTX",
    "group": "mmu",
    "summary": "本文档为QLake项目XMMU子系统MCTX模块的设计文档。描述了MCTX模块的需求规格、编程手册及详细设计等内容，可为开发人员、验证人员及相关模块负责人提供关于该模块清晰的理解。",
    "subs": [
      "Meta Unit",
      "FD-TO-TX",
      "FLUSH",
      "FD-TO-TX-MC",
      "Link Read",
      "FM Sampler"
    ]
  },
  {
    "id": "xmmu_qf",
    "name": "XMMU QF",
    "group": "mmu",
    "summary": "描述QF（Queue Free Buffers NOC）模块的功能需求，主要为数字电路设计人员、验证人员以及其他需要了解本模块内部操作细节的人员提供参考。",
    "subs": [
      "通用端口模块",
      "捐赠接收逻辑",
      "TX侧数据转移",
      "buffer调度",
      "捐赠接收DB数量统计",
      "控制引擎模块"
    ]
  },
  {
    "id": "xmmu_qmem",
    "name": "XMMU QMEM",
    "group": "mmu",
    "summary": "本文档对QLake项目QMEM模块相关设计进行了分析说明，旨在为前端/后端/软件/产品等任何团队成员提供参考，以帮助他们了解QMEM模块在整个QLake总系统中的功能和作用。",
    "subs": [
      "ARB",
      "Fd_rw_ctrl",
      "output"
    ]
  },
  {
    "id": "xmmu_rn_noc",
    "name": "XMMU RN NOC",
    "group": "mmu",
    "summary": "本文档主要说明Receive Noc 以及相关模块的整体设计方案。",
    "subs": [
      "RN 请求",
      "RN 响应",
      "Credit",
      "路由",
      "反压",
      "统计"
    ]
  },
  {
    "id": "tm_pol",
    "name": "TM POL",
    "group": "tm",
    "summary": "本文档为流量管理 (Traffic Manager) 子系统POL模块的设计文档。POL模块在TM子系统中承担拥塞避免功能。",
    "subs": [
      "REDENG",
      "LOCALRED",
      "REDCTRL",
      "REDCALC",
      "REDBOUND",
      "HIER"
    ]
  },
  {
    "id": "tm_qc",
    "name": "TM QC",
    "group": "tm",
    "summary": "TM_QC（Queue Control）模块在TM子系统中，负责报文描述符（FD）的入队，出队链表调度管理等功能。",
    "subs": [
      "QC_ENQ",
      "Enq流程",
      "Enq resp流程",
      "QC_DEQ",
      "出队流程",
      "出队状态机"
    ]
  },
  {
    "id": "tm_sch",
    "name": "TM SCH",
    "group": "tm",
    "summary": "TM_SCH模块在QLAKE芯片TM子系统中，负责符合调度条件的队列间调度，调度功能由4层层次化调度组成。",
    "subs": [
      "Scoreboad",
      "Flow of TM trigger",
      "UC Flow",
      "MC Flow",
      "MITX Management",
      "Length Feedback to TM"
    ]
  },
  {
    "id": "tm_dma_mmu",
    "name": "TM DMA MMU",
    "group": "tm",
    "summary": "本文档对QLake项目TM_MMU模块相关设计进行了分析说明，旨在为前端/后端/软件/产品等任何团队成员提供参考，以帮助他们了解TM_MMU模块在整个QLake总系统中的功能和作用。",
    "subs": [
      "MUX",
      "正常通路",
      "Bypass tm通路(面积考虑，将sram换成fifo)"
    ]
  },
  {
    "id": "tm_dma_rnd",
    "name": "TM DMA RN/DM",
    "group": "tm",
    "summary": "本文档为TM快速通路中的RND架构文档，主要功能是将报文切片写入缓存、包链表管理和FD信息生成。",
    "subs": [
      "RN_MUX",
      "正常通路模式",
      "Bypass tm通路",
      "LGU"
    ]
  },
  {
    "id": "tm_dma_tnd",
    "name": "TM DMA TN/DM",
    "group": "tm",
    "summary": "本文档对QLake项目TM子系统极简转发通路的TND模块相关设计进行了分析说明，旨在为前端/后端/软件/产品等任何团队成员提供参考，以帮助他们了解TND模块在整个QLake总系统中的功能和作用。",
    "subs": [
      "EXTR",
      "CFG",
      "DBG",
      "LINK"
    ]
  },
  {
    "id": "tmmu_lc_ac",
    "name": "TMMU LC/AC",
    "group": "tm",
    "summary": "本文档为查找表cache的架构文档，为了支持QLake项目查找表的cache功能，包括lookup 和atomic（LC/AC）。如果查表操作在cache命中，则快速返回结果，节省查表延迟，减少NOC压力。",
    "subs": [
      "支持KEY的热度统计和衰减",
      "支持cache时KEY Memory中记录KEY",
      "支持retry机制在LC/AC内部独立实现"
    ]
  },
  {
    "id": "tmmu_noc",
    "name": "TMMU NOC",
    "group": "tm",
    "summary": "本文适用于QLake V100R001 项目开发IC Design，IC DV,FPGA/Emual及软件设计人员，描述了TMMU_NOC的概要设计",
    "subs": [
      "支持TKN,TRN两个网络",
      "TKN/TRN由344 noc网络组成",
      "TKN/TRN支持自适应路由可配置",
      "TRN支持通过xbar将查表响应路由到正确目的节点"
    ]
  },
  {
    "id": "tmmu_tmc",
    "name": "TMMU TMC",
    "group": "tm",
    "summary": "适用于PZZ V100R001 芯片TMMU模块整理，并对TMMU模块需求进行分解，提供内部子模块的设计需求的依据。PZZ单die支持12.8T，实现了4个Pipe，每个pipe支持3.2T。TMMU用于支持6.4T的2个pipe之间LPM、MAC，在上述表项",
    "subs": [
      "Tmc_Smt_Control",
      "Tmc_address_Calculation",
      "Tmc_Arbiter",
      "Tmc_Memory",
      "Tmc_Align",
      "Tmc_Result_processing"
    ]
  },
  {
    "id": "ucie",
    "name": "UCIe",
    "group": "ucie",
    "summary": "基于智算网络应用需求，开发一颗51.2Tbps处理性能的以太网交换芯片；针对智算网络的不同互联场景，典型业务处理性能设计目标达到相应的高带宽低延迟报文转发能力，以满足智算Scale Up和Scale Out互联网络的业务需求。",
    "subs": [
      "复位流程",
      "UCIe IP时钟结构",
      "互连UCIe数据流"
    ]
  },
  {
    "id": "ucie_bwli",
    "name": "UCIe BWLI",
    "group": "ucie",
    "summary": "BWLI作为UCIe协议层，区分BWLI_TX接收MI发送过来的数据并将其切片为31B数据格式，将31B数据封装成UCIe_Flit数据格式发送到UCIe_Adapt，通过UCIe_phy实现跨Die传输，对端BWLI_RX从UCIe_Adapt接收数据，并将",
    "subs": [
      "Date_Encoder( X3 )",
      "FIFO_Group（X3）",
      "Frame_Builder_Tx",
      "TX_AFIFO_Group（X2）",
      "Ucie_Flit_Encoder（X2）",
      "Ucie_Flit_Decoder（X2）"
    ]
  },
  {
    "id": "ucie_bwli_spare",
    "name": "UCIe BWLI Spare",
    "group": "ucie",
    "summary": "BWLI_Spare作为UCIe协议层，区分BWLI_TX接收MI和OOB发送过来的数据并将其切片为31B数据格式，将31B数据封装成UCIe_Flit数据格式发送到UCIe_Adapt，通过UCIe_phy实现跨Die传输，对端BWLI_RX从UCIe_Ad",
    "subs": [
      "Data_Encoder",
      "FIFO_Group",
      "Frame_Builder_Tx",
      "TX_AFIFO Group",
      "UCIe_Flit_Encoder",
      "Ucie_Flit_Decoder"
    ]
  },
  {
    "id": "ucie_lsm",
    "name": "UCIe LSM",
    "group": "ucie",
    "summary": "UCIe LSM，全称 Link State Machine，链路状态机。UCIe D2D (Die-to-die) Adapter 位于 Procotol Layer 及 Physical Layer 之间，Adapter 往上通过 FDI (Flit-Aw",
    "subs": [
      "Functional Requirement 1产生FDI 状态信号，检测并响应协议层状态转换请求",
      "Functional Requirement 2产生RDI状态转换请求信号，检测RDI链路状态，协调同步",
      "Functional Requirement 3与远端adapter协调链路状态",
      "Functional Requirement 4与远端进行参数协商",
      "Functional Requirement 5支持请求协议层解除时钟门控",
      "Functional Requirement 6向协议层传递当前物理层所处链路训练和电源管理状态信息"
    ]
  },
  {
    "id": "ucie_rx",
    "name": "UCIe RX",
    "group": "ucie",
    "summary": "本文档是UCIe Adapter RX模块设计文档，详细介绍了Adapter RX的功能、设计的总体框架、设计的详细方案以及接口信息等，供验证和相关设计人员参考使用。",
    "subs": [
      "支持256Byte Flit格式",
      "支持UCIe环回",
      "支持flit 头格式(小端模式)",
      "支持接收完整Flit报文",
      "支持每拍128B数据CRC校验",
      "支持设定时间内CRC校验错误Flit个数超阈值触发Retrain"
    ]
  },
  {
    "id": "ucie_sideband",
    "name": "UCIe Sideband",
    "group": "ucie",
    "summary": "UCIe / Bridge 模块",
    "subs": [
      "Sideband 通道",
      "链路状态",
      "参数交换",
      "错误处理",
      "复位",
      "调试"
    ]
  },
  {
    "id": "ucie_tx",
    "name": "UCIe TX",
    "group": "ucie",
    "summary": "UCIe_adapter_tx负责将协议层经由fdi口发送过来的数据进行处理后将数据发送至RDI口，由 UCIe PHY给到对端。UCIe_adapter_tx需要确保进行可靠的数据发送，一旦出现数据出错，需要进行retry，将错误数据重新发送。当UCIe_a",
    "subs": [
      "BE注意事项",
      "DFT注意事项"
    ]
  },
  {
    "id": "emu_bwli_bridge",
    "name": "EMU BWLI Bridge",
    "group": "ucie",
    "summary": "由于测试需求，需要开发一个bridge用于连接TC和DUT。",
    "subs": [
      "bridge_tx",
      "tx_checksum_encoder",
      "mii_to_bwli_gen",
      "tx_queue_filter",
      "tx_interleave",
      "tx_afifo"
    ]
  },
  {
    "id": "emu_mac_bridge",
    "name": "EMU MAC Bridge",
    "group": "ucie",
    "summary": "由于MAC测试需求，需要开发一个bridge用于连接TC和DUT。",
    "subs": [
      "maci_bridge_tx",
      "axi_to_maci_gen",
      "tx_interleave",
      "tx_afifo",
      "bridge_rx",
      "rx_afifo"
    ]
  },
  {
    "id": "emu_mi_bridge",
    "name": "EMU MI Bridge",
    "group": "ucie",
    "summary": "由于测试需求，需要开发一个bridge用于连接TC和DUT。",
    "subs": [
      "bridge_tx",
      "tx_checksum_encoder",
      "mii_to_bwli_gen",
      "tx_queue_filter",
      "tx_interleave",
      "tx_afifo"
    ]
  },
  {
    "id": "pcie_block_dma",
    "name": "PCIe Block DMA",
    "group": "pcie",
    "summary": "本文档的目的是对QLAKE V100R001 的block_dma设计进行整理，读者为前端设计、验证以及相关软件开发人员。",
    "subs": [
      "block_dma",
      "block_dma状态机跳转",
      "ind_access",
      "axi_intf_slv",
      "axi_intf_mst"
    ]
  },
  {
    "id": "pcie_dma_xbar",
    "name": "PCIe DMA Xbar",
    "group": "pcie",
    "summary": "描述及分析QLakePCIE_DMA模块中Xbar的功能需求，主要为数字电路设计人员、验证人员以及其他需要了解本模块内部操作细节的人员提供参考。",
    "subs": [
      "xbar",
      "Xbar内部模块划分",
      "AR、AW通道pending寄存器仅能存放一笔请求信息",
      "W通道pending寄存器存放一笔写数据及对应信息",
      "R通道pending寄存器存放一笔读数据及对应信息",
      "B通道pending寄存器仅存放一笔写请求响应信息"
    ]
  },
  {
    "id": "pcie_pcib",
    "name": "PCIe PCIB",
    "group": "pcie",
    "summary": "适用于QLake V100R001芯片的PCIe_pcib_top模块整理，并对PCIe_pcib_top模块需求进行分解，提供内部子模块的设计需求的依据。",
    "subs": [
      "PCIE CORE",
      "PCIE PHY",
      "pcib_hbus2apb_intf",
      "pcib_apb2cfgb_intf",
      "pexc_msix_handler",
      "中断映射表"
    ]
  },
  {
    "id": "pcie_pkt_bmu",
    "name": "PCIe PKT BMU",
    "group": "pcie",
    "summary": "本文档为缓存管理子系统BMU的架构文档，为了支持QLake项目交换网接入芯片的缓存管理功能。BMU负责集中管理一定数量的内存资源BD的索引列表，分配和回收这些资源。",
    "subs": [
      "IDP",
      "Sub_pool management",
      "Budget management"
    ]
  },
  {
    "id": "pcie_pkt_mem_dma",
    "name": "PCIe PKT MEM DMA",
    "group": "pcie",
    "summary": "本文描述了pkt_mem_DMA模块的功能需求、接口、寄存器配置、方案详细设计等，DE、DV、SW都可以阅读本文档，DE根据该文档进行RTL编写，DV、SW可以通过该文档更深入的理解DE的方案实现方法，有针对性的开发测试case。",
    "subs": [
      "支持HOST通过PCIe 初始化配置寄存器（4个PCIe发送通道使能、发送描述符基地址、发送描述符队列长度、描述符队列的写指针位置、描述符队列的读指针位置）；",
      "支持HOST通过DMA通道配置描述符的写指针，用于指示HOST发起pkt_DMA的发包请求；",
      "支持判断内部读写指针和当前空闲状态，硬件通过状态机跳转配置PCIe的IP寄存器，发起对外部DDR中描述符空间的读请求；",
      "支持解析PCIe写入的pkt_DMA Ingress描述符内容，硬件配置PCIe的IP寄存器，读取外部buffer空间中报文；",
      "支持接收PCIe完成报文DMA读的中断请求，将报文发送到CPP_MACI；",
      "当笔报文发送结束后，回写描述符内Flag字段，后上报中断到HOST（通过PCIE msix）；"
    ]
  },
  {
    "id": "soc",
    "name": "SoC",
    "group": "soc",
    "summary": "本文档的目的是对QLake V100R001 SOC项目设计部分进行整理，主要针对芯片系统顶层，GLOBAL及部分通用模块进行约束设计，读者为前端设计、验证以及相关软件开发人员。",
    "subs": [
      "PLL",
      "集成接口信号",
      "IP接口信号",
      "集成结构图",
      "PLL IP内部结构图",
      "WRAPPER_GPIO"
    ]
  },
  {
    "id": "pzz_all",
    "name": "PZZ 总览",
    "group": "soc",
    "summary": "基于智算网络应用需求，开发一颗51.2Tbps处理性能的以太网交换芯片。",
    "subs": [
      "智算南向Scale Up互联",
      "智算北向Scale Out互联",
      "通算部分规格",
      "逻辑方案",
      "物理方案",
      "工作原理"
    ]
  },
  {
    "id": "crypto",
    "name": "Crypto",
    "group": "soc",
    "summary": "适用于商用密码应用中的报文加解密以及验签值的生成，可满足多种密码应用的安全需求。同时，本文本还可为安全产品生产商提供产品和技术的标准定位以及标准化的参考，提高安全产品的可信性与互操作性。",
    "subs": [
      "ENGINE_CTRL",
      "AES算法",
      "SM4算法"
    ]
  }
];
