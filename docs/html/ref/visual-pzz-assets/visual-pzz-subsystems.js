/* 子系统索引：由 pzz_all.md 生成（gen_pzz_subsystems.py） */
window.PZZ_SUB_GROUPS = [
  {
    "id": "io",
    "name": "接口",
    "sub": "SerDes · Ethernet · UCIe · PCIe · DMA"
  },
  {
    "id": "ingress",
    "name": "入口处理",
    "sub": "MACI · PIPE · Parser · VLAN · VxLAN"
  },
  {
    "id": "lookup",
    "name": "查表",
    "sub": "L2 · L3 · ACL · TCAM"
  },
  {
    "id": "forward",
    "name": "转发决策",
    "sub": "ECMP · TRUNK · MCE · DLB"
  },
  {
    "id": "buffer",
    "name": "缓存 / 调度",
    "sub": "TMMU · CMMU · XMMU · AQM · TM · 拥塞控制"
  },
  {
    "id": "cpu",
    "name": "CPU / 系统",
    "sub": "CPP · CPIS · IPFIX · Global · Telemetry"
  }
];
window.PZZ_SUBSYSTEMS = [
  {
    "id": "serdes",
    "name": "SerDes",
    "section": "9.2",
    "group": "io",
    "stage": 0,
    "tag": "130 lane × 112G",
    "summary": "本芯片共4个die，每个Die集成130Lane 112Gbps SerDes，特性如下：",
    "features": [
      "本芯片共4个die，每个Die集成130Lane 112Gbps SerDes，特性如下：",
      "集成16组x8lane Marco，1组x2lane Marco",
      "支持典型以太网应用频点：112.5/106.25/56.25/53.125/51.5625/26.5625/25.78125/10.3125Gbps",
      "支持PAM4/NRZ编码模式：",
      "112Gbps PAM4",
      "56Gbps NRZ",
      "支持每条链路速率独立可配",
      "支持极性翻转",
      "支持8lane内Tx/Rx Lane Swap(需TX，RX成对Swap)",
      "支持Auto Negotiation功能",
      "支持Link Training功能",
      "支持Loop Back功能"
    ],
    "blocks": [
      "PLL",
      "CMU",
      "Refclk",
      "ATB",
      "PAM4",
      "NRZ"
    ],
    "ifaces": [
      "芯片设计每个die支持130Lanes的Serdes接口，其中每lane均支持最大112G速率范围的频点，承载专用的信元协议。每条Lane对外出4个引脚："
    ]
  },
  {
    "id": "ethernet",
    "name": "Ethernet",
    "section": "9.3",
    "group": "io",
    "stage": 0,
    "tag": "800G ~ 10G",
    "summary": "以800G速率为单位，每个DIE支持16个800G模块，每个800G模块支持如下速率：",
    "features": [
      "以800G速率为单位，每个DIE支持16个800G模块，每个800G模块支持如下速率：",
      "800GR8x1(x1表示每个模块支持1个对应速率接口，下同)",
      "400GR4x2/400GR8x1",
      "200GR2x4/200GR4x2",
      "100GR1x8/100GR2x4",
      "50GR1x4/50GR2x4",
      "40GR4x2/25GR1x4/10GR1x4",
      "100G及以上速率支持LLR特性，100G以下速率不支持；",
      "100G及以上速率支持CBFC特性，每800G PIPE支持64个VC，单端口最大支持32个VC；100G以下速率不支持；",
      "支持1588v2一步法和两步法，一步法精度为50ns以内，两步法精度为10ns以内；",
      "支持光模块抗损,支持速率为800GR8/400GR4/200GR2。",
      "支持SUE/UEC/ETH-LINK/OSIA格式数据帧。"
    ],
    "blocks": [
      "MAC",
      "PCS",
      "FEC",
      "LLR",
      "CBFC",
      "SerDes"
    ],
    "ifaces": []
  },
  {
    "id": "ucie",
    "name": "UCIe",
    "section": "22.19",
    "group": "io",
    "stage": 0,
    "tag": "D2D / BWLI",
    "summary": "支持接收5路NOC的数据报文，其中2组单播，2组组播，一组BWLI_BWLI对接口；",
    "features": [
      "支持接收5路NOC的数据报文，其中2组单播，2组组播，一组BWLI_BWLI对接口；",
      "支持单组播接口WRR调度，调度权重支持软件寄存器配置",
      "支持数据报文通路接口总线1024bit；",
      "支持单播NOC口数据报文9 Channel交织传输；",
      "支持入口流量整形（bps），整形粒度83Mbps（1.33GHz）；",
      "支持将1024bit总线数据报文切片为31B Word；",
      "支持将31B Word数据切片恢复成1024bit总线数据报文；",
      "支持将31B Word数据切片封装为UCIe协议数据格式；",
      "支持数据报文流控Die-To-Die传递；",
      "集成2UCIe-A PHY；",
      "支持两UCIe 总带宽4096Gbps；",
      "支持UCIe重传；"
    ],
    "blocks": [
      "BWLI",
      "Adapt",
      "PHY",
      "Spare"
    ],
    "ifaces": []
  },
  {
    "id": "pcie",
    "name": "PCIe",
    "section": "38.2",
    "group": "io",
    "stage": 0,
    "tag": "Gen5 · RC / EP",
    "summary": "PCIE controller功能列表",
    "features": [
      "PCIE controller功能列表",
      "Pcie_clk 1.2 GHz",
      "auxclk 50MHz",
      "支持PCIE Gen1/Gen2/Gen3/Gen4/Gen5 (2.5 Gbps/5 Gbps/8 Gbps/16 Gbps/32 Gbps)",
      "支持PCIE 4/2/1 lane，本项目采用4 lane",
      "标准PIPE接口，32bit/lane，Gen1:62.5 MHz",
      "标准PIPE接口，32bit/lane，Gen2:125 MHz",
      "标准PIPE接口，32bit/lane，Gen3:250 MHz",
      "标准PIPE接口，32bit/lane，Gen4:500 MHz",
      "标准PIPE接口，32bit/lane，Gen5:1000 MHz",
      "用户接口为AXI4，link width:64 bits",
      "支持MSIX中断"
    ],
    "blocks": [
      "Controller",
      "PHY",
      "DMA",
      "PCIB"
    ],
    "ifaces": []
  },
  {
    "id": "dma",
    "name": "DMA",
    "section": "38.3",
    "group": "io",
    "stage": 0,
    "tag": "PKT / Block",
    "summary": "packet DMA",
    "features": [
      "packet DMA",
      "Ingress，接收来自HOST_CPU通过PCIe DMA下发的报文，转发到CPP MACI；",
      "支持HOST通过PCIe 初始化配置寄存器（4个PCIe发送通道使能、发送描述符基地址、发送描述符队列长度、描述符队列的写指针位置、描述符队列的读指针位置）；",
      "支持HOST通过DMA通道配置描述符的写指针，用于指示HOST发起pkt_DMA的发包请求；",
      "支持判断内部读写指针和当前空闲状态，硬件通过状态机跳转配置PCIe的IP寄存器，发起对外部DDR中描述符空间的读请求；",
      "支持解析PCIe写入的pkt_DMA Ingress描述符内容，硬件配置PCIe的IP寄存器，读取外部buffer空间中报文；",
      "支持接收PCIe完成报文DMA读的中断请求，将报文发送到CPP_MACI；",
      "当笔报文发送结束后，回写描述符内Flag字段，后上报中断到HOST（通过PCIE msix）；",
      "Ingress，接收来自FW的下发报文，转发到CPP MACI；",
      "支持FW初始化配置寄存器（4个FW core发送使能、发送描述符基地址、发送描述符队列长度、描述符队列的写指针位置、描述符队列的读指针位置）；",
      "支持FW通过配置通路下发请求，更新写指针；",
      "支持根据读指针位置和描述符空间基地址。已内部DMA操作读取对应描述符，每个描述符大小16B；"
    ],
    "blocks": [
      "pkt_DMA",
      "Ingress",
      "Egress",
      "PCIe",
      "CPIS"
    ],
    "ifaces": []
  },
  {
    "id": "maci",
    "name": "MACI",
    "section": "22.2",
    "group": "ingress",
    "stage": 1,
    "tag": "HPP / CPP buffer",
    "summary": "HPP MACI",
    "features": [
      "HPP MACI",
      "支持800G MAC接口；",
      "支持line/aux/mirror/failover/injection等流量分通道管理；",
      "ingress方向支持64字节以上线速入BUFFER；",
      "egress方向及内部总线支持64B 50%线速，300B以上全线速；",
      "支持CBFC，每个800G PIPE总共64 VC，单端口最大支持32VC；",
      "ingress buffer满后按优先级丢弃（非CBFC场景）；",
      "egress buffer满后反压上游；",
      "支持egress mirror，流量送入VPP（保留本PIPE上行通路），最大支持800G egress mirror；",
      "支持egress flit counter统计（配合PI）；",
      "支持egress速率统计（配合PETX，CSIG）；",
      "DLB端口状态统计；"
    ],
    "blocks": [
      "MACI RX",
      "MACI TX",
      "Flex FIFO",
      "WRR",
      "CBFC"
    ],
    "ifaces": []
  },
  {
    "id": "pipe",
    "name": "PIRX / PITX / PERX / PETX",
    "section": "22.3",
    "group": "ingress",
    "stage": 1,
    "tag": "HPP pipe 前后级",
    "summary": "每个die有16个PIRX",
    "features": [
      "每个die有16个PIRX",
      "16个PIRX出向连接Ingress HPP和PITX，入向连接MACI；",
      "支持800Gbps的数据处理能力",
      "支持9个通道，8个数据通道和1个AUX/loopback通道",
      "9个通道交织输入，输入位宽128B",
      "支持根据通道配置选择走极简数据通道或HPP数据通道。分别维护PITX中极简数据通道和HPP数据通道空闲地址数量，每个地址对应128B+meta data大小的空间",
      "按照flit输入的顺序分配PITX中的存储地址，存储地址随FLIT发送给PITX，同时存储地址随metadata传输。其中极简数据通道和HPP数据通道的存储地址独立分配。",
      "接收PITX反馈的地址回收信息（包含channel号），用来维护剩余的缓存量和每通道占用的缓存量",
      "输入的128B flit送给PITX",
      "输入的3B TS，仅SOP有效，长度为3B，随metadata发送给HPP",
      "2路HPP PIRX共享一个HPP 数据总线，2路间WRR调度",
      "SOP flit和存储地址，次flit（如果有）送给PIRX汇聚模块。存储地址包含2bit PIRX地址编号和PITX中首flit存储地址，HPP用来识别metadata写入的PITX"
    ],
    "blocks": [
      "PIRX",
      "PITX",
      "PERX",
      "PETX"
    ],
    "ifaces": []
  },
  {
    "id": "parser",
    "name": "Parser",
    "section": "22.4",
    "group": "ingress",
    "stage": 1,
    "tag": "ICU / EGR parser",
    "summary": "ICU:",
    "features": [
      "ICU:",
      "ICU支持解析报文输出2bit的DE（Drop Eligibility）；",
      "ICU支持解析报文输出16bit的VC（Virtual Channel）；",
      "ICU支持解析报文输出14bit的报文长度；",
      "Parser：",
      "1.支持按channel配置PORT CFG Register；",
      "2.支持按pipe 1K的underlay mac查表；",
      "3.支持普通以太网报文的解析；",
      "4.支持RoCEv2报文的解析；",
      "5.支持UEC报文的解析，包括标准头和SES（Semantic Sublayer）头压缩的报文。",
      "6.支持SUE报文的解析，包括16bit和32bi address两种报文头；",
      "7.支持ETH_LINK/OISA/GSE/Eth-X报文的解析；"
    ],
    "blocks": [
      "ICU",
      "Parser",
      "EGR_parser",
      "UDF"
    ],
    "ifaces": []
  },
  {
    "id": "vlan",
    "name": "VLAN",
    "section": "22.5",
    "group": "ingress",
    "stage": 1,
    "tag": "ING / EGR VLAN",
    "summary": "支持外层VLAN(处理外层VLAN，内层VLAN只识别，不处理)",
    "features": [
      "支持外层VLAN(处理外层VLAN，内层VLAN只识别，不处理)",
      "支持外层VLAN Rang，具体实现待评估。",
      "支持VLAN初始化(确定入报文所属VLAN)",
      "支持VFP表指定VLAN ID初始化VLAN ID",
      "支持匹配端口TPID初始化VLAN ID，1个Channel支持配置4个OTPID，匹配操作时可选。",
      "支持VxLAN报文隧道内，外层VLAN ID处理(增加，修改，删除，保留操作)",
      "支持VLAN过滤",
      "检查入报文/出报文VLAN是否与端口存在合法绑定关系，如果非法，报文丢弃。"
    ],
    "blocks": [
      "VFP",
      "EGR VLAN",
      "XLATE"
    ],
    "ifaces": []
  },
  {
    "id": "vxlan",
    "name": "VxLAN",
    "section": "22.6",
    "group": "ingress",
    "stage": 1,
    "tag": "隧道终结",
    "summary": "支持二层VxLAN单播",
    "features": [
      "支持二层VxLAN单播",
      "支持二层VxLAN组播，广播",
      "支持二层VxLAN未知单播，未知组播按广播转发",
      "支持已知单播，组播VNI限速(ACL限速)",
      "支持二层VP隔离(端口隔离)",
      "支持三层VxLAN单播",
      "VxLAN IPv4(underlay/overlay)",
      "VxLAN IPv6(underlay/overlay)",
      "支持三层VxLAN组播，广播",
      "支持泛洪抑制",
      "支持MAC/VLAN based VxLAN",
      "支持VxLAN-DCI隧道(VxLAN隧道终结后重入VxLAN-DCI隧道)"
    ],
    "blocks": [
      "隧道终结",
      "DVP",
      "TAG",
      "VFI"
    ],
    "ifaces": []
  },
  {
    "id": "l2",
    "name": "L2",
    "section": "22.7",
    "group": "lookup",
    "stage": 2,
    "tag": "EMF / MAC 表",
    "summary": "二三层组播",
    "features": [
      "二三层组播",
      "三层组播RPF",
      "三层组播FRR",
      "vlan广播抑制",
      "port广播抑制",
      "二层转发",
      "三层主机路由转发",
      "Mac学习、迁移、老化",
      "Mac学习消息过滤",
      "远端查表及保序",
      "MTU检查",
      "TTL检查"
    ],
    "blocks": [
      "EMF",
      "MAC 学习",
      "老化",
      "STP"
    ],
    "ifaces": []
  },
  {
    "id": "l3",
    "name": "L3",
    "section": "22.8",
    "group": "lookup",
    "stage": 2,
    "tag": "LPM / NH / FRR",
    "summary": "上行数据流基于L3的转发找出出端口及队列；",
    "features": [
      "上行数据流基于L3的转发找出出端口及队列；",
      "下行数据流用于报文内外层封装信息的查找；",
      "本章节覆盖HPP中蓝色的模块需求及方案。",
      "LPM需求：",
      "本地10K条路由容量",
      "IPv4远程支持最大512K条路由容量",
      "IPv6远程支持最大256K条路由容量",
      "支持第一级6K*20B的TCAM进行bucket分类",
      "支持TCAM每个2k*20B分组内支持entry的横向扩展",
      "支持每个报文查1次LPM",
      "支持报文的输入和输出保序",
      "支持TMMU查表结果的乱序返回"
    ],
    "blocks": [
      "LPM",
      "NEXTHOP",
      "FRR",
      "L3_OIF",
      "EGR_NEXTHOP"
    ],
    "ifaces": []
  },
  {
    "id": "acl",
    "name": "ACL",
    "section": "22.9",
    "group": "lookup",
    "stage": 2,
    "tag": "Ingress / Egress",
    "summary": "TCAM iACL支持最大16表并查；容量8K",
    "features": [
      "TCAM iACL支持最大16表并查；容量8K",
      "TCAM iACL支持双pipe共享",
      "TCAM eACL支持最大4表并查；容量2K",
      "TCAM eACL支持双pipe共享",
      "EM表扩展ACL；容量16K本地容量与IPFIX共享",
      "EM表；支持40B和80B的Key",
      "支持UDF",
      "支持ACL和EM的并行查找",
      "支持结果的各种统计及动作",
      "TCAM表支持最大80B的master key，生成的sub key支持20B/40B/60B/80B",
      "支持每个报文查1次TCAM iACL、1次EM iACL、1次TCAM eACL、1次EM eACL",
      "支持报文的输入和输出保序"
    ],
    "blocks": [
      "IACL",
      "EACL",
      "UDF"
    ],
    "ifaces": []
  },
  {
    "id": "tcam",
    "name": "TCAM",
    "section": "22.10",
    "group": "lookup",
    "stage": 2,
    "tag": "精确匹配",
    "summary": "支持2路输入，IACL/EACL",
    "features": [
      "支持2路输入，IACL/EACL",
      "支持100B位宽输入",
      "支持组装20B/40B/60B/80B 查找key",
      "TCAM支持位宽深度扩展，进行深度扩展时，可以定义TCAM的优先级。",
      "每个key关联20B 结果表",
      "支持结果优先级仲裁",
      "支持16kx20B条目（IACL 13K EACL 3K）",
      "支持TCAM ecc校验"
    ],
    "blocks": [
      "Key"
    ],
    "ifaces": []
  },
  {
    "id": "ecmp",
    "name": "ECMP",
    "section": "22.11",
    "group": "forward",
    "stage": 3,
    "tag": "ECMP / FLOWSET",
    "summary": "ECMP（Equal-Cost Multipath）是一种路由选择算法，用于实现负载均衡。它允许将流量分散到具有相等开销的多条路径上。通过在路由表中设置多个下一跳选项，并且每个选项具有相同的开销，ECMP可以将流量有效地分发到多个路径上，从而实现负载均衡。",
    "features": [
      "ECMP（Equal-Cost Multipath）是一种路由选择算法，用于实现负载均衡。它允许将流量分散到具有相等开销的多条路径上。通过在路由表中设置多个下一跳选项，并且每个选项具有相同的开销，ECMP可以将流量有效地分发到多个路径上，从而实现负载均衡。",
      "ECMP模块功能列表：",
      "1.本地ECMP_GROUP线性表 4K*12B",
      "2.本地ECMP_MENBER线性表 64K*8B",
      "3.支持一表两次并查",
      "4.最大支持两级查找",
      "5.支持以下hash值来源LBN配置，RND随机生成, HASH计算。",
      "支持以下ECMP模式：STATIC, FIXED, SPRAT, ELIGIBILITY负载分担模式",
      "7.支持以下负载分担业务：FRR ，ECMP failover，DLB rebalance，GLB。"
    ],
    "blocks": [
      "ECMP_GROUP",
      "ECMP_MEMBER",
      "DLB",
      "FRR"
    ],
    "ifaces": []
  },
  {
    "id": "trunk",
    "name": "TRUNK",
    "section": "22.13",
    "group": "forward",
    "stage": 3,
    "tag": "LAG / DLB",
    "summary": "支持链路聚合功能，支持512个聚合组，每个聚合组支持64个成员口。",
    "features": [
      "支持链路聚合功能，支持512个聚合组，每个聚合组支持64个成员口。",
      "支持单播或者组播出口为聚合口的功能。",
      "支持聚合组Link Failover功能，最多配置8个Link Failover接口。",
      "聚合Hash方式支持：",
      "逐包随机HASH；",
      "按五元组HASH；",
      "按任意包字段进行HASH；",
      "对称HASH和弹性HASH；",
      "支持DLB，模式包括：STATIC模式，DLB Fixed模式，DLB Spray模式；",
      "组播报文支持TRUNK的时候，组播后的报文统一使用上行报文计算出来的hash，不支持基于trunk group或者MCID选择hash。",
      "支持Trunk Failover返回多候选端口，查询DLB返回端口端口不可用。则选取候选端口。"
    ],
    "blocks": [
      "TRUNK_GROUP",
      "FLOWSET",
      "DLB",
      "L2_EIF"
    ],
    "ifaces": []
  },
  {
    "id": "mce",
    "name": "MCE",
    "section": "22.12",
    "group": "forward",
    "stage": 3,
    "tag": "组播复制",
    "summary": "组播功能特性规格：",
    "features": [
      "组播功能特性规格：",
      "L2组播支持16K Group，包含4K泛洪域，单个entry最大支持512 bitmap。",
      "L3组播支持8K Group，支持64K MLL entry。",
      "COPY to CPU， 支持3个Group;",
      "入端口镜像/出端口镜像/流镜像，共享15个Group;",
      "组播性能，300B字节线速设计；",
      "组播复制前报文分2个优先级；"
    ],
    "blocks": [
      "MC 复制",
      "ENQ",
      "DEQ",
      "Mirror"
    ],
    "ifaces": []
  },
  {
    "id": "dlb",
    "name": "DLB",
    "section": "26.4",
    "group": "forward",
    "stage": 3,
    "tag": "动态负载分担",
    "summary": "支持ECMP的DLB/GLB负载均衡",
    "features": [
      "支持ECMP的DLB/GLB负载均衡",
      "支持TRUNK的DLB负载均衡",
      "支持PFC aware DLB",
      "支持最多512个DLB PORT",
      "支持最多256个GLB PORT，即GLB支持256 SPINE，512 LEAF",
      "支持本地FLOWSET线性表规格4K*32b/pipe，整芯片64K",
      "支持本地DLB_PORT线性表规格128*512b",
      "支持本地DLB_NHI线性表规格64K*64b",
      "本地DLB_QUAL质量表规格512*7b",
      "本地GLB_QUAL质量表规格512*(512*3b)",
      "支持DLB的Rebalance",
      "DLB支持fixed、spray和eligibility三种模式"
    ],
    "blocks": [
      "DLB_PORT",
      "DLB_QUAL",
      "FLOWSET",
      "PORT512"
    ],
    "ifaces": []
  },
  {
    "id": "tmmu",
    "name": "TMMU",
    "section": "22.15",
    "group": "buffer",
    "stage": 4,
    "tag": "TM 内 MMU",
    "summary": "PZZ单die支持12.8T，实现了4个Pipe，每个pipe支持3.2T。",
    "features": [
      "PZZ单die支持12.8T，实现了4个Pipe，每个pipe支持3.2T。",
      "TMMU用于支持6.4T的2个pipe之间LPM、MAC及NEXTHOP的共享，在上述表项支持的规格超过其本地表容量时，需要到TMMU进行查表，并获得表项结果。",
      "TMMU需要支持最大512K的IPv4、256K的IPv6、64K的NEXTHOP、64K的EGR_NEXTHOP、以及128K的MAC表项；",
      "需求分解如下：",
      "参数要求说明总表项容量10MB支持的表类型MAC/IPv4/ IPv6/NH/L3OIF表项宽度20字节160 位/条目处理单元数量16个通过NoC互连单元内存容量4 BANK ×8K×20B32K×20B=640KB/单元单元内Bank数量4个8K×20B×4=640KB…"
    ],
    "blocks": [
      "TKN",
      "TRN",
      "TMC"
    ],
    "ifaces": []
  },
  {
    "id": "cmmu",
    "name": "CMMU",
    "section": "22.16",
    "group": "buffer",
    "stage": 4,
    "tag": "CPU MMU",
    "summary": "PZZ项目中单die支持12.8Tbps，共 4个Pipe，每个pipe支持3.2Tbps。",
    "features": [
      "PZZ项目中单die支持12.8Tbps，共 4个Pipe，每个pipe支持3.2Tbps。",
      "Counter内存管理单元CMMU(Counter Memory Manage unit)子系统用于支持12.8T 4个pipe之间多个模块发起的表项统计，单die 64K个 counter共享缓存。CMMU由Counter 查找密钥网络CKN(Counter Key Ne…",
      "支持多种Counter统计类型",
      "支持多种counter统计类型，包括Double counter、Sflow counter、Token bucket、OAM counter、Combined min/max double counter、Double Threshold Counter",
      "支持1分钟不翻转支持Counter计数1分钟不翻转",
      "本设计中支持Counter计数1分钟不翻转。单Die支持12.8T转发。",
      "平均包长 64B*50%+300B*50% = 182B",
      "1min的字节数 = 12.8 Tbps * 60s=96TB =96*2^40B （至少47bit）",
      "1min的包数 = 12.8Tbps *60s /182B =1.055*2^39（至少40bit）",
      "64B限速的平均包长 = 64B*100%",
      "1min的包数 = 12.8Tbps *60s /64B =1.5 *2^40（至少41bit）",
      "支持单Die 64K个Counter共享"
    ],
    "blocks": [
      "CKN",
      "CRN",
      "CMC",
      "OAM"
    ],
    "ifaces": []
  },
  {
    "id": "xmmu",
    "name": "XMMU",
    "section": "22.18",
    "group": "buffer",
    "stage": 4,
    "tag": "MC / buffer",
    "summary": "每个XMMU上的Buffer总容量45MB，单个MC（Memory Cell）支持45/16=2.8125MB 存储，单MC里又拆成4个MCFM，每个MCFM拆成12 bank来提高数据的读写效率；",
    "features": [
      "每个XMMU上的Buffer总容量45MB，单个MC（Memory Cell）支持45/16=2.8125MB 存储，单MC里又拆成4个MCFM，每个MCFM拆成12 bank来提高数据的读写效率；",
      "Buffer Size粒度为256B；",
      "Packet Flit粒度为128B；",
      "NOC写报文带宽支持51.2Tbps；",
      "SBC支持16个MC，每个MC中有MCBM管理存储空间，支持实现noc无拥塞写入；",
      "支持直接将报文写入TM，降低路径延时；",
      "支持MIRX产生FD buffer首地址；",
      "支持TM/MCE 2路调度FD出队，进行报文读取；",
      "单800G MITX支持2路MCTN读取，提升读通路带宽；",
      "NOC读报文带宽支持12.8Tbps；",
      "支持MCE读取原始报文；",
      "支持报文分片读取"
    ],
    "blocks": [
      "MCRX",
      "MCCS",
      "MCTX",
      "MCTD",
      "MCFM",
      "MCBM",
      "QMEM",
      "SBC"
    ],
    "ifaces": []
  },
  {
    "id": "aqm",
    "name": "AQM",
    "section": "22.21",
    "group": "buffer",
    "stage": 4,
    "tag": "RED / ECN / PFC",
    "summary": "AQM支持获取基于源端口PG/VC的4个DIE的缓存统计，包括share/headroom统计",
    "features": [
      "AQM支持获取基于源端口PG/VC的4个DIE的缓存统计，包括share/headroom统计",
      "AQM支持获取4个DIE的全局缓存统计",
      "AQM支持获取4个DIE的TM队列和端口级统计",
      "AQM支持获取4个DIE的MCE统计",
      "AQM支持产生PFC流控状态信息",
      "AQM支持产生CBFC流控状态信息",
      "支持TRIM判断功能",
      "支持WRED功能",
      "支持DLB信息处理。"
    ],
    "blocks": [
      "MIRX",
      "shared",
      "headroom"
    ],
    "ifaces": []
  },
  {
    "id": "tm",
    "name": "TM",
    "section": "22.20",
    "group": "buffer",
    "stage": 4,
    "tag": "8 HPP + 1 CPP",
    "summary": "支持1.6Tbps带宽",
    "features": [
      "支持1.6Tbps带宽",
      "支持1330Mpps转发率",
      "支持三级调度，端口级，cos级，队列级",
      "端口级18个端口，cos级144个cos，队列级180队列",
      "18个端口调度器",
      "144个cos调度器",
      "180个队列",
      "各级支持双桶整形",
      "端口级支持wfq调度",
      "Cos级队列间支持sp/wfq调度",
      "队列级到cos级支持灵活挂接",
      "支持CBFC,16端口支持8vc，8端口支持16vc，4端口支持32vc"
    ],
    "blocks": [
      "POL",
      "QC",
      "FASTPATH",
      "SCH"
    ],
    "ifaces": []
  },
  {
    "id": "congestion",
    "name": "系统拥塞控制",
    "section": "38.6",
    "group": "buffer",
    "stage": 4,
    "tag": "PFC / CBFC / DCN",
    "summary": "基于上述分析，PZZ项目需要提前预埋支持未来新型CC算法的能力，主要规格包括：",
    "features": [
      "基于上述分析，PZZ项目需要提前预埋支持未来新型CC算法的能力，主要规格包括：",
      "ECN，以及ECN相关的增强特性，参考RoCEv2协议；Fast ECN/latency ECN",
      "INT，主要是参考IFA2.0标准，具体实现参考TELEMETRY IFA方案描述；;",
      "Trim包截断通知能力，参考UEC标准；",
      "CSIG，交换机参与拥塞计算的增强型INT能力，参考UEC标准;",
      "PFC/CBFC，兼容传统端侧CC算法，或者没有CC能力的网卡，参考IB/RoCEv2协议;具体实现参考Ethernet/AQM PFC/CBFC的方案描述。",
      "DCN，芯片拥塞管理（待分析）；"
    ],
    "blocks": [
      "DCN",
      "CBFC",
      "CSIG",
      "HPCC"
    ],
    "ifaces": []
  },
  {
    "id": "cpp",
    "name": "CPP",
    "section": "22.17",
    "group": "cpu",
    "stage": 5,
    "tag": "CPU packet path",
    "summary": "CPP PIPE上行支持接收MACI发送的64B-12K包，处理后发送至MIRX；",
    "features": [
      "CPP PIPE上行支持接收MACI发送的64B-12K包，处理后发送至MIRX；",
      "CPP PIPE上行支持5个通道，1 MACI NOC+2 AUX + 1 CPIS + 1 IPFIX；",
      "CPP PIPE上行支持5个通道整包输入，输入位宽128B；整包输出，输出位宽128B；",
      "CPP PIPE上行支持处理CPU下发的端口透传报文；",
      "CPP PIPE上行支持处理HPP环回至CPP的egress mirr报文；",
      "CPP PIPE上行支持处理HPP环回至CPP的mod报文；",
      "CPP PIPE上行支持处理HPP上送的IPFIX报文；",
      "CPP PIPE上行支持处理GLB & MAC报文；",
      "CPP PIPE上行支持封装I2E MSG；",
      "CPP PIPE上行支持封装INGRESS MMU HDR；",
      "CPP PIPE下行支持解析I2E MSG & EGRESS MMU HDR；",
      "CPP PIPE 下行支持3个通道AUX，2个AUX口，1个CPIS口(包括1个CPIS & 1个 host CPU口)；"
    ],
    "blocks": [
      "CPP MACI",
      "CPP pipeline",
      "MACI NOC",
      "IPFIX"
    ],
    "ifaces": [
      "主要有两类接口"
    ]
  },
  {
    "id": "cpis",
    "name": "CPIS",
    "section": "26.3",
    "group": "cpu",
    "stage": 5,
    "tag": "CPU 接口",
    "summary": "CPIS（Control Plane Interface System）是host CPU的网关。CPIS是PZZ设备内部和软件之间的主要连接。无论控制处理器是通过PCle直接连接还是由RCPU远程控制，CPIS I/O结构都提供了配置设置和读取状态，以及和CPU之间互相传…",
    "features": [
      "CPIS（Control Plane Interface System）是host CPU的网关。CPIS是PZZ设备内部和软件之间的主要连接。无论控制处理器是通过PCle直接连接还是由RCPU远程控制，CPIS I/O结构都提供了配置设置和读取状态，以及和CPU之间互相传…"
    ],
    "blocks": [
      "FNOC",
      "AXI",
      "BusMatrix"
    ],
    "ifaces": []
  },
  {
    "id": "ipfix",
    "name": "IPFIX / EM",
    "section": "22.14",
    "group": "cpu",
    "stage": 5,
    "tag": "采样 / 上报",
    "summary": "IPFIX全称为IP Flow Information Export，即IP数据流信息输出，它是由IETF公布的用于网络中的流信息测量的标准协议；它在设置QoS 策略、部署应用和进行容量规划上都有着巨大的价值。",
    "features": [
      "IPFIX全称为IP Flow Information Export，即IP数据流信息输出，它是由IETF公布的用于网络中的流信息测量的标准协议；它在设置QoS 策略、部署应用和进行容量规划上都有着巨大的价值。",
      "IPFIX 定义的格式以Cisco Netflow Version 9数据输出格式作为基础，可使IP流量信息从一个输出器（Exporter）传送到收集器（Collector）。",
      "IPFIX 技术应用在流量模型（历史流量大小，丢包原因，时戳，流量起止时间，报文解析等），流量工程，攻击检测，网络质量的监控等场景中可以发挥积极的作用，并可以满足多样化的客户需求。",
      "支持全芯片256K的IPFIX容量，平均每个pipe支持16K的本地容量，容量由IPFIX与EM共享。",
      "支持UDF。",
      "支持最大80B的Master Key。",
      "支持每个报文查2次IPFIX（ingress/egress）及2次EM（ingress/egress）。",
      "支持硬件的表项学习。",
      "支持硬件扫描机进行表项的上报与老化。",
      "支持异常状态感知（MicroBurst感知和Latency超阈值感知）。",
      "支持报文分片感知与上报。",
      "支持TTL变化感知与上报。"
    ],
    "blocks": [
      "采样",
      "Timer",
      "老化",
      "上报"
    ],
    "ifaces": []
  },
  {
    "id": "global",
    "name": "Global",
    "section": "38.4",
    "group": "cpu",
    "stage": 5,
    "tag": "时钟 / 复位 / 管脚",
    "summary": "芯片内支持低电平有效复位",
    "features": [
      "芯片内支持低电平有效复位",
      "支持低电平有效的芯片管脚硬复位（POR_RESETn）",
      "芯片管脚复位生效时，清除配置与复位数据通路",
      "支持低电平有效的异步上电复位功能（POR_RESETn），复位所有逻辑与PLL",
      "支持grst_n与srst_n两种复位寄存器",
      "支持grst_n有效时候清除配置寄存器，不复位数据通路",
      "支持srst_n仅复位数据通道，不复位配置寄存器",
      "支持可由外部CPU配置软复位功能（grst_n和srst_n）",
      "复位模块到各个物理模块的复位信号延时控制（在同一个系统时钟周期内）",
      "支持上电过程中通过SAR或JTAG切换PLL初始配置频率",
      "支持内部关键信号通过OBS进行观测",
      "支持上电后通过 CFGB和JTAG配置PLL"
    ],
    "blocks": [
      "CRG",
      "RGM",
      "PVT",
      "EFUSE",
      "GPIO",
      "JTAG"
    ],
    "ifaces": []
  },
  {
    "id": "telemetry",
    "name": "Telemetry",
    "section": "38.5",
    "group": "cpu",
    "stage": 5,
    "tag": "INT / IFA / 统计",
    "summary": "gRPC telemetry；",
    "features": [
      "gRPC telemetry；",
      "IFA 2.0；",
      "Network monitor/sflow",
      "Netanalysis(RoCEv2，统一IPFIX实现)",
      "MOD(Mirror on Drop)",
      "Visibility into packet processing/packet track",
      "Real-time switch utilization",
      "Port MIRROR /sample",
      "RSPAN/ERSPAN",
      "健康检测",
      "1588",
      "IFIT（待分析）"
    ],
    "blocks": [
      "IFA",
      "INT",
      "ERSPAN",
      "sFlow",
      "SBFD"
    ],
    "ifaces": []
  }
];
window.PZZ_SUB_FLOWS = [
  {
    "from": "serdes",
    "to": "maci"
  },
  {
    "from": "ethernet",
    "to": "maci"
  },
  {
    "from": "ucie",
    "to": "xmmu"
  },
  {
    "from": "pcie",
    "to": "cpp"
  },
  {
    "from": "dma",
    "to": "cpp"
  },
  {
    "from": "maci",
    "to": "pipe"
  },
  {
    "from": "pipe",
    "to": "parser"
  },
  {
    "from": "parser",
    "to": "vlan"
  },
  {
    "from": "vlan",
    "to": "l2"
  },
  {
    "from": "vxlan",
    "to": "l2"
  },
  {
    "from": "l2",
    "to": "l3"
  },
  {
    "from": "l3",
    "to": "acl"
  },
  {
    "from": "acl",
    "to": "ecmp"
  },
  {
    "from": "tcam",
    "to": "acl"
  },
  {
    "from": "ecmp",
    "to": "trunk"
  },
  {
    "from": "trunk",
    "to": "mce"
  },
  {
    "from": "mce",
    "to": "tm"
  },
  {
    "from": "dlb",
    "to": "trunk"
  },
  {
    "from": "tmmu",
    "to": "tm"
  },
  {
    "from": "xmmu",
    "to": "tm"
  },
  {
    "from": "cmmu",
    "to": "xmmu"
  },
  {
    "from": "aqm",
    "to": "tm"
  },
  {
    "from": "tm",
    "to": "pipe"
  },
  {
    "from": "congestion",
    "to": "aqm"
  },
  {
    "from": "cpp",
    "to": "cpis"
  },
  {
    "from": "ipfix",
    "to": "telemetry"
  },
  {
    "from": "global",
    "to": "cpp"
  },
  {
    "from": "telemetry",
    "to": "cpp"
  },
  {
    "from": "dma",
    "to": "tm"
  },
  {
    "from": "serdes",
    "to": "pipe"
  },
  {
    "from": "maci",
    "to": "cpp"
  },
  {
    "from": "pipe",
    "to": "maci"
  },
  {
    "from": "mce",
    "to": "xmmu"
  },
  {
    "from": "ecmp",
    "to": "dlb"
  },
  {
    "from": "tm",
    "to": "maci"
  },
  {
    "from": "tmmu",
    "to": "xmmu"
  }
];
