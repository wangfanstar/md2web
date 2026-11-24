/* 架构图数据：由 mermaid_code/*.md 生成 */
window.PZZ_DIAGRAMS = [
  {
    "id": "BWLI_UCIE",
    "title": "BWLI_UCIE",
    "direction": "LR",
    "nodes": [
      {
        "id": "NOC",
        "label": "NOC 总线 / (NOC 0~3)"
      },
      {
        "id": "UMIRX",
        "label": "UMIRX 总线 / (Umirx 0~5)"
      },
      {
        "id": "WLB",
        "label": "WLB / OOB / (带外与负载)"
      },
      {
        "id": "B_TX_L",
        "label": "TX_AFIFO / (跨时钟域缓冲)"
      },
      {
        "id": "B_RX_L",
        "label": "RX_AFIFO / (跨时钟域缓冲)"
      },
      {
        "id": "ADAPT_L",
        "label": "2. UCIe Adapt / (适配与链路管理)"
      },
      {
        "id": "P_TX_L",
        "label": "TX_AFIFO"
      },
      {
        "id": "P_RX_L",
        "label": "RX_AFIFO"
      },
      {
        "id": "P_RX_R",
        "label": "RX_AFIFO"
      },
      {
        "id": "P_TX_R",
        "label": "TX_AFIFO"
      },
      {
        "id": "ADAPT_R",
        "label": "2. UCIe Adapt / (适配与链路管理)"
      },
      {
        "id": "B_RX_R",
        "label": "RX_AFIFO / (跨时钟域缓冲)"
      },
      {
        "id": "B_TX_R",
        "label": "TX_AFIFO / (跨时钟域缓冲)"
      },
      {
        "id": "MAC_INTF_R",
        "label": "对端内部业务域"
      },
      {
        "id": "MAC_INTF",
        "label": "MAC_INTF"
      }
    ],
    "edges": [
      {
        "from": "B_TX_L",
        "to": "P_TX_L"
      },
      {
        "from": "P_RX_L",
        "to": "B_RX_L"
      },
      {
        "from": "P_RX_R",
        "to": "B_RX_R"
      },
      {
        "from": "B_TX_R",
        "to": "P_TX_R"
      },
      {
        "from": "MAC_INTF",
        "to": "B_TX_L"
      },
      {
        "from": "B_RX_L",
        "to": "MAC_INTF"
      },
      {
        "from": "P_TX_L",
        "to": "P_RX_R"
      },
      {
        "from": "P_TX_R",
        "to": "P_RX_L"
      },
      {
        "from": "B_RX_R",
        "to": "MAC_INTF_R"
      },
      {
        "from": "MAC_INTF_R",
        "to": "B_TX_R"
      }
    ]
  },
  {
    "id": "ICU_INTERNAL",
    "title": "ICU_INTERNAL",
    "direction": "LR",
    "nodes": [
      {
        "id": "SOP_IN",
        "label": "SOP_0 / SOP_1 / (来自 Data Combiner)"
      },
      {
        "id": "ST0",
        "label": "st0 / Data / 128B"
      },
      {
        "id": "EXT_HDR",
        "label": "external / Header removal"
      },
      {
        "id": "ST1_D",
        "label": "st1 / data"
      },
      {
        "id": "VLAN_P",
        "label": "vlan parse / Vlan removal"
      },
      {
        "id": "ST2_D",
        "label": "st2 / data"
      },
      {
        "id": "IP_P",
        "label": "ip parse / ip removal"
      },
      {
        "id": "ST3_D",
        "label": "st3 / data"
      },
      {
        "id": "L4_P",
        "label": "L4 parser"
      },
      {
        "id": "FINAL_RES",
        "label": "Final / Resolution"
      },
      {
        "id": "ST5",
        "label": "st5 / data"
      },
      {
        "id": "ST1_M",
        "label": "st1 / meta"
      },
      {
        "id": "ST2_M",
        "label": "st2 / meta"
      },
      {
        "id": "ST3_M",
        "label": "st3 / meta"
      },
      {
        "id": "ST4_M",
        "label": "st4 / meta"
      },
      {
        "id": "FLEX_FIFO",
        "label": "Flex FIFO Top / Channel Mux / (MACI 调度控制系统)"
      },
      {
        "id": "PKT_LEN",
        "label": "14 bits"
      },
      {
        "id": "CBFC_VC",
        "label": "据总线输出: / 1. PKT_LEN / 2. CBFC_VC (5 bits, 基于PCP/DSCP"
      },
      {
        "id": "ID",
        "label": ": / 1. PKT_LEN / 2. CBFC_VC / 3. DE / Drop ID (2 bits"
      }
    ],
    "edges": [
      {
        "from": "ST0",
        "to": "EXT_HDR"
      },
      {
        "from": "EXT_HDR",
        "to": "ST1_D"
      },
      {
        "from": "ST1_D",
        "to": "VLAN_P"
      },
      {
        "from": "VLAN_P",
        "to": "ST2_D"
      },
      {
        "from": "ST2_D",
        "to": "IP_P"
      },
      {
        "from": "IP_P",
        "to": "ST3_D"
      },
      {
        "from": "ST3_D",
        "to": "L4_P"
      },
      {
        "from": "L4_P",
        "to": "FINAL_RES"
      },
      {
        "from": "FINAL_RES",
        "to": "ST5"
      },
      {
        "from": "EXT_HDR",
        "to": "ST1_M"
      },
      {
        "from": "ST1_M",
        "to": "VLAN_P"
      },
      {
        "from": "VLAN_P",
        "to": "ST2_M"
      },
      {
        "from": "ST2_M",
        "to": "IP_P"
      },
      {
        "from": "IP_P",
        "to": "ST3_M"
      },
      {
        "from": "ST3_M",
        "to": "L4_P"
      },
      {
        "from": "L4_P",
        "to": "ST4_M"
      },
      {
        "from": "ST4_M",
        "to": "FINAL_RES"
      },
      {
        "from": "SOP_IN",
        "to": "ST0"
      },
      {
        "from": "FINAL_RES",
        "to": "FLEX_FIFO"
      },
      {
        "from": "ST5",
        "to": "FLEX_FIFO"
      }
    ]
  },
  {
    "id": "SimplePacketIngress2Egress",
    "title": "SimplePacketIngress2Egress",
    "direction": "LR",
    "nodes": [
      {
        "id": "PIRX0",
        "label": "PIRX 0"
      },
      {
        "id": "PIRX1",
        "label": "PIRX 1"
      },
      {
        "id": "PIRX2",
        "label": "PIRX 2"
      },
      {
        "id": "PIRX3",
        "label": "PIRX 3"
      },
      {
        "id": "RR1",
        "label": "RR 仲裁 / PIRX 0/1 → L2-A"
      },
      {
        "id": "RR2",
        "label": "RR 仲裁 / PIRX 2/3 → L2-B"
      },
      {
        "id": "ING_PARSER_A",
        "label": "Ingress Parser"
      },
      {
        "id": "EMF_A",
        "label": "EMF"
      },
      {
        "id": "ING_PARSER_B",
        "label": "Ingress Parser"
      },
      {
        "id": "EMF_B",
        "label": "EMF"
      },
      {
        "id": "LPM",
        "label": "LPM / 最长前缀匹配"
      },
      {
        "id": "NH",
        "label": "NH / NextHop"
      },
      {
        "id": "L2EIF",
        "label": "L2EIF / TRUNK / 出口选择"
      },
      {
        "id": "AQM0",
        "label": "AQM 0 / (→ PITX 0/1)"
      },
      {
        "id": "AQM1",
        "label": "AQM 1 / (→ PITX 2/3)"
      },
      {
        "id": "PITX0",
        "label": "PITX 0"
      },
      {
        "id": "PITX1",
        "label": "PITX 1"
      },
      {
        "id": "PITX2",
        "label": "PITX 2"
      },
      {
        "id": "PITX3",
        "label": "PITX 3"
      },
      {
        "id": "PERX0",
        "label": "PERX 0"
      },
      {
        "id": "PERX1",
        "label": "PERX 1"
      },
      {
        "id": "PERX2",
        "label": "PERX 2"
      },
      {
        "id": "PERX3",
        "label": "PERX 3"
      },
      {
        "id": "RR_E1",
        "label": "RR 仲裁 / PERX 0/1"
      },
      {
        "id": "RR_E2",
        "label": "RR 仲裁 / PERX 2/3"
      },
      {
        "id": "EP1",
        "label": "Egress Parser A"
      },
      {
        "id": "EP2",
        "label": "Egress Parser B"
      },
      {
        "id": "EGR_ACL",
        "label": "EGR ACL"
      },
      {
        "id": "EGR_NH",
        "label": "EGR NEXTHOP"
      },
      {
        "id": "PETX_MUX",
        "label": "PETX_MUX"
      },
      {
        "id": "MUX0",
        "label": "MUX 0/1"
      },
      {
        "id": "MUX1",
        "label": "MUX 2/3"
      },
      {
        "id": "PETX0",
        "label": "PETX 0"
      },
      {
        "id": "PETX1",
        "label": "PETX 1"
      },
      {
        "id": "PETX2",
        "label": "PETX 2"
      },
      {
        "id": "PETX3",
        "label": "PETX 3"
      },
      {
        "id": "NOTE1",
        "label": "📝 Ingress 关键规则： / ① PIRX RR仲裁在X2 TOP / ② 非极简: EMF→LPM RR仲裁 / ③ 极简: EMF bypass L3→L2EIF / ④ L2EIF 3路(1非极简+2极简)→AQM / ⑤ 3.2T pipe内 PIRX↔PITX 一一对应"
      },
      {
        "id": "NOTE2",
        "label": "📝 Egress 关键规则： / ① PERX RR仲裁在X2 TOP / ② 极简: Parser直送PETX / ③ 非极简: 2路Parser→Egress HPP / ④ EGR NH对2路Parser RR仲裁 / ⑤ PETX仲裁极简/非极简互斥 / ⑥ 3.2T pipe内 PERX↔PETX 一一对应"
      }
    ],
    "edges": [
      {
        "from": "PIRX0",
        "to": "RR1"
      },
      {
        "from": "PIRX1",
        "to": "RR1"
      },
      {
        "from": "PIRX2",
        "to": "RR2"
      },
      {
        "from": "PIRX3",
        "to": "RR2"
      },
      {
        "from": "ING_PARSER_A",
        "to": "EMF_A"
      },
      {
        "from": "ING_PARSER_B",
        "to": "EMF_B"
      },
      {
        "from": "RR1",
        "to": "ING_PARSER_A"
      },
      {
        "from": "RR2",
        "to": "ING_PARSER_B"
      },
      {
        "from": "LPM",
        "to": "L2EIF"
      },
      {
        "from": "EMF_A",
        "to": "LPM"
      },
      {
        "from": "EMF_B",
        "to": "LPM"
      },
      {
        "from": "EMF_A",
        "to": "L2EIF"
      },
      {
        "from": "EMF_B",
        "to": "L2EIF"
      },
      {
        "from": "L2EIF",
        "to": "AQM0"
      },
      {
        "from": "L2EIF",
        "to": "AQM1"
      },
      {
        "from": "AQM0",
        "to": "PITX0"
      },
      {
        "from": "AQM0",
        "to": "PITX1"
      },
      {
        "from": "AQM1",
        "to": "PITX2"
      },
      {
        "from": "AQM1",
        "to": "PITX3"
      },
      {
        "from": "PITX0",
        "to": "PERX0"
      },
      {
        "from": "PITX1",
        "to": "PERX1"
      },
      {
        "from": "PITX2",
        "to": "PERX2"
      },
      {
        "from": "PITX3",
        "to": "PERX3"
      },
      {
        "from": "PERX0",
        "to": "RR_E1"
      },
      {
        "from": "PERX1",
        "to": "RR_E1"
      },
      {
        "from": "PERX2",
        "to": "RR_E2"
      },
      {
        "from": "PERX3",
        "to": "RR_E2"
      },
      {
        "from": "RR_E1",
        "to": "EP1"
      },
      {
        "from": "RR_E2",
        "to": "EP2"
      },
      {
        "from": "EGR_ACL",
        "to": "EGR_NH"
      },
      {
        "from": "EP1",
        "to": "EGR_ACL"
      },
      {
        "from": "EP2",
        "to": "EGR_ACL"
      },
      {
        "from": "EP1",
        "to": "PETX_MUX"
      },
      {
        "from": "EP2",
        "to": "PETX_MUX"
      },
      {
        "from": "EGR_NH",
        "to": "PETX_MUX"
      },
      {
        "from": "MUX0",
        "to": "PETX0"
      },
      {
        "from": "MUX0",
        "to": "PETX1"
      },
      {
        "from": "MUX1",
        "to": "PETX2"
      },
      {
        "from": "MUX1",
        "to": "PETX3"
      }
    ]
  },
  {
    "id": "bfd_1588",
    "title": "BFD 与 1588(PTP) 报文芯片内部处理流程",
    "direction": "LR",
    "nodes": [
      {
        "id": "RX_IN",
        "label": "① 线路接收 / SerDes → PCS/FEC / → MAC"
      },
      {
        "id": "TX_OUT",
        "label": "⑧ 线路发送 / TX MAC → SerDes"
      },
      {
        "id": "MACI_RX",
        "label": "HPP MACI RX / ICU → Flex FIFO #8 / (AUX/BFD 高优不丢弃)"
      },
      {
        "id": "ING",
        "label": "② HPP Ingress / ING_PARSER 识别 BFD / (FWD_TYPE=0x6)+ACL / → I2E MSG"
      },
      {
        "id": "MMU",
        "label": "MMU / TM"
      },
      {
        "id": "EGR_PRS",
        "label": "③ EGR_PARSER / 解析 I2E MSG / BFD_HIT/DOWN/ / Discriminator"
      },
      {
        "id": "EPROC",
        "label": "④ CPP EPROC / BFD PIPE 7 fiber"
      },
      {
        "id": "DEC",
        "label": "⑤ BFD FILTER 查表 / 4K 表项 / key=Discriminator"
      },
      {
        "id": "CNT",
        "label": "⑥ 硬件保活 / BFD CNT PIPE / windows cnt 50x1bit / + single cnt 34bit"
      },
      {
        "id": "TH",
        "label": "⑦ TH PIPE / 封装 CPU HDR"
      },
      {
        "id": "LIMIT",
        "label": "限速 LV1/LV2 / (bfd drop 优先)"
      },
      {
        "id": "SCAN",
        "label": "扫描机 x8 / READ&SHIFT 判窗"
      },
      {
        "id": "CPIS",
        "label": "⑦ CPIS / Host / 3 窗无计数 → BFD down"
      },
      {
        "id": "TX_INJ",
        "label": "FW 周期注入 / 组装 BFD 报文"
      },
      {
        "id": "PROXY",
        "label": "CPP MACI BFD Process / 硬件代理保活 / 512 会话 / 0.33ms"
      },
      {
        "id": "CMACI",
        "label": "CPP MACI / (PKT DMA / AUX)"
      },
      {
        "id": "CPIPE",
        "label": "CPP PIPE / 指定出端口"
      },
      {
        "id": "LOOP",
        "label": "HPP Egress / + Loopback 环回 / (查 L2_EIF/NEXTHOP)"
      },
      {
        "id": "HMACI",
        "label": "HPP MACI TX / Flex FIFO #8"
      },
      {
        "id": "NOTE",
        "label": "记忆闭环： / ①→⑦ 接收上送（CPU 计数判定会话）， / ⑦→⑧ 保活/注入发回线路； / 唯一决策点 ⑤：miss→上送，hit&TH=1→上送， / hit&TH=0→保活计数，SBFD→反射"
      }
    ],
    "edges": [
      {
        "from": "RX_IN",
        "to": "ING"
      },
      {
        "from": "EGR_PRS",
        "to": "DEC"
      },
      {
        "from": "DEC",
        "to": "TH"
      },
      {
        "from": "DEC",
        "to": "CNT"
      },
      {
        "from": "CNT",
        "to": "TH"
      },
      {
        "from": "TH",
        "to": "CPIS"
      },
      {
        "from": "CPIS",
        "to": "TX_INJ"
      },
      {
        "from": "TX_INJ",
        "to": "CPIPE"
      },
      {
        "from": "PROXY",
        "to": "HMACI"
      },
      {
        "from": "HMACI",
        "to": "TX_OUT"
      }
    ]
  },
  {
    "id": "bwli_tx_rx",
    "title": "bwli_tx_rx",
    "direction": "LR",
    "nodes": [
      {
        "id": "MI_IN",
        "label": "MI 接口输入总线 / (Data / SOP / EOP / Channel / Length)"
      },
      {
        "id": "IFIFO",
        "label": "NOC IFIFO / (缓冲 单播/组播 等流量)"
      },
      {
        "id": "SHAPING",
        "label": "Shaping & Encoder / (切片为 31B 格式)"
      },
      {
        "id": "ARB_TX",
        "label": "ARB Builder / (多路选路仲裁, 如6选3)"
      },
      {
        "id": "TX_AFIFO",
        "label": "TX_AFIFO / (异步跨时钟域)"
      },
      {
        "id": "UCIE_ENC",
        "label": "UCIe Encoder / (封装为 UCIe_Flit)"
      },
      {
        "id": "ADAPT_TX",
        "label": "UCIe_Adapt / (适配层)"
      },
      {
        "id": "PHY_TX",
        "label": "UCIe_PHY / (物理层)"
      },
      {
        "id": "BWLI_TX",
        "label": "BWLI_TX"
      },
      {
        "id": "PHY_RX",
        "label": "UCIe_PHY / (物理层)"
      },
      {
        "id": "ADAPT_RX",
        "label": "UCIe_Adapt / (适配层)"
      },
      {
        "id": "UCIE_DEC",
        "label": "UCIe Decoder / (解封装 Flit)"
      },
      {
        "id": "RX_AFIFO",
        "label": "RX_AFIFO / (异步跨时钟域)"
      },
      {
        "id": "MERGE",
        "label": "Merge & Builder / (DMUX 与 数据重组)"
      },
      {
        "id": "OFIFO",
        "label": "OFIFO Group / (输出缓冲队列)"
      },
      {
        "id": "MI_REC",
        "label": "Data Decoder / (恢复 MI 接口格式)"
      },
      {
        "id": "BWLI_RX",
        "label": "BWLI_RX"
      },
      {
        "id": "MI_OUT",
        "label": "MI 接口输出总线 / (直达 UMIRX / 级联 BWLI)"
      },
      {
        "id": "FC_CTRL",
        "label": "FC 流控反压机制"
      }
    ],
    "edges": [
      {
        "from": "IFIFO",
        "to": "ARB_TX"
      },
      {
        "from": "BWLI_TX",
        "to": "PHY_TX"
      },
      {
        "from": "UCIE_DEC",
        "to": "MERGE"
      },
      {
        "from": "PHY_RX",
        "to": "BWLI_RX"
      },
      {
        "from": "MI_IN",
        "to": "IFIFO"
      },
      {
        "from": "PHY_TX",
        "to": "PHY_RX"
      },
      {
        "from": "MI_REC",
        "to": "MI_OUT"
      },
      {
        "from": "MI_REC",
        "to": "FC_CTRL"
      },
      {
        "from": "FC_CTRL",
        "to": "ARB_TX"
      }
    ]
  },
  {
    "id": "cpp_pic",
    "title": "CPP PAKCET PATH",
    "direction": "LR",
    "nodes": [
      {
        "id": "A1",
        "label": "AUX0"
      },
      {
        "id": "M1",
        "label": "1(\"800G slice / / HPP MACI"
      },
      {
        "id": "P1",
        "label": "PHY0-7"
      },
      {
        "id": "A2",
        "label": "AUX1"
      },
      {
        "id": "M2",
        "label": "2(\"800G slice / / HPP MACI"
      },
      {
        "id": "P2",
        "label": "PHY0-7"
      },
      {
        "id": "A3",
        "label": "AUX0"
      },
      {
        "id": "M3",
        "label": "3(\"800G slice / / HPP MACI"
      },
      {
        "id": "P3",
        "label": "PHY0-7"
      },
      {
        "id": "A4",
        "label": "AUX1"
      },
      {
        "id": "M4",
        "label": "4(\"800G slice / / HPP MACI"
      },
      {
        "id": "P4",
        "label": "PHY0-7"
      },
      {
        "id": "L2_1",
        "label": "1.6T PIPE / / L2 HPP"
      },
      {
        "id": "L2_2",
        "label": "1.6T PIPE / / L2 HPP"
      },
      {
        "id": "L3",
        "label": "3.2T PIPE / / L3 HPP"
      }
    ],
    "edges": [
      {
        "from": "A1",
        "to": "M1"
      },
      {
        "from": "P1",
        "to": "M1"
      },
      {
        "from": "A2",
        "to": "M2"
      },
      {
        "from": "P2",
        "to": "M2"
      },
      {
        "from": "A3",
        "to": "M3"
      },
      {
        "from": "P3",
        "to": "M3"
      },
      {
        "from": "A4",
        "to": "M4"
      },
      {
        "from": "P4",
        "to": "M4"
      },
      {
        "from": "M1",
        "to": "L2_1"
      },
      {
        "from": "M2",
        "to": "L2_1"
      },
      {
        "from": "M3",
        "to": "L2_2"
      },
      {
        "from": "M4",
        "to": "L2_2"
      },
      {
        "from": "L2_1",
        "to": "L3"
      },
      {
        "from": "L2_2",
        "to": "L3"
      }
    ]
  },
  {
    "id": "hpp_packet_ingress2egress",
    "title": "hpp_packet_ingress2egress",
    "direction": "LR",
    "nodes": [
      {
        "id": "MACW",
        "label": "MACW"
      },
      {
        "id": "MACI_RX",
        "label": "_RX[\"MACI RX"
      },
      {
        "id": "MACI_NOC",
        "label": "MACI NOC"
      },
      {
        "id": "MACI_TX",
        "label": "MACI TX"
      },
      {
        "id": "PIRX",
        "label": "PI RX / PIRX"
      },
      {
        "id": "L2A",
        "label": "L2 HPP"
      },
      {
        "id": "L3A",
        "label": "L3 HPP + SPP"
      },
      {
        "id": "PITX",
        "label": "PITX"
      },
      {
        "id": "XMMU",
        "label": "XMMU / TMMU / Crossbar & Memory"
      },
      {
        "id": "PERX",
        "label": "PERX"
      },
      {
        "id": "L2B",
        "label": "L2B[\"L2 HPP"
      },
      {
        "id": "L3B",
        "label": "L3 HPP + SPP"
      },
      {
        "id": "PETX",
        "label": "PETX / PI TX"
      },
      {
        "id": "HPP_MACI_TX",
        "label": "HPP MACI TX"
      },
      {
        "id": "MACW_TX",
        "label": "MACW TX"
      },
      {
        "id": "MACI_NOC2",
        "label": "MACI NOC"
      },
      {
        "id": "CPP_MACI",
        "label": "CPP MACI"
      },
      {
        "id": "HPP_MACI_RX",
        "label": "HPP MACI RX"
      }
    ],
    "edges": [
      {
        "from": "MACW",
        "to": "MACI_RX"
      },
      {
        "from": "MACI_NOC",
        "to": "MACI_RX"
      },
      {
        "from": "MACI_TX",
        "to": "MACI_RX"
      },
      {
        "from": "MACI_RX",
        "to": "PIRX"
      },
      {
        "from": "PIRX",
        "to": "L2A"
      },
      {
        "from": "L2A",
        "to": "L3A"
      },
      {
        "from": "L3A",
        "to": "PITX"
      },
      {
        "from": "PERX",
        "to": "L2B"
      },
      {
        "from": "L2B",
        "to": "L3B"
      },
      {
        "from": "L3B",
        "to": "PETX"
      },
      {
        "from": "PETX",
        "to": "HPP_MACI_TX"
      },
      {
        "from": "HPP_MACI_TX",
        "to": "MACW_TX"
      },
      {
        "from": "HPP_MACI_TX",
        "to": "MACI_NOC2"
      },
      {
        "from": "HPP_MACI_TX",
        "to": "CPP_MACI"
      },
      {
        "from": "HPP_MACI_TX",
        "to": "HPP_MACI_RX"
      },
      {
        "from": "PITX",
        "to": "XMMU"
      },
      {
        "from": "XMMU",
        "to": "PERX"
      }
    ]
  },
  {
    "id": "hpppipe",
    "title": "hpppipe",
    "direction": "LR",
    "nodes": [
      {
        "id": "PHY0",
        "label": "PHY 0-7"
      },
      {
        "id": "PHY1",
        "label": "PHY 0-7"
      },
      {
        "id": "PHY2",
        "label": "PHY 0-7"
      },
      {
        "id": "PHY3",
        "label": "PHY 0-7"
      },
      {
        "id": "AUX_MAC",
        "label": "AUX MAC / (x2 Lane)"
      },
      {
        "id": "CPP_MACI",
        "label": "CPP MACI"
      },
      {
        "id": "CPP",
        "label": "CPP / CPIS / Control Plane"
      },
      {
        "id": "PCIE",
        "label": "PCIE (x2 Lane)"
      },
      {
        "id": "NOC0",
        "label": "NOC 0"
      },
      {
        "id": "NOC1",
        "label": "NOC 1"
      },
      {
        "id": "NOC2",
        "label": "NOC 2"
      },
      {
        "id": "NOC3",
        "label": "NOC 3"
      },
      {
        "id": "MACI0",
        "label": "800G HPP MACI 0 / Port 0-7: Line / Port 8: Aux / Loop"
      },
      {
        "id": "MACI1",
        "label": "800G HPP MACI 1 / Port 0-7: Line / Port 8: Aux / Loop"
      },
      {
        "id": "MACI2",
        "label": "800G HPP MACI 2 / Port 0-7: Line / Port 8: Aux / Loop"
      },
      {
        "id": "MACI3",
        "label": "800G HPP MACI 3 / Port 0-7: Line / Port 8: Aux / Loop"
      },
      {
        "id": "MACI_LAYER",
        "label": "MACI_LAYER"
      },
      {
        "id": "L2_A",
        "label": "1.6T PIPE / L2 HPP (A)"
      },
      {
        "id": "L2_B",
        "label": "1.6T PIPE / L2 HPP (B)"
      },
      {
        "id": "L3",
        "label": "3.2T PIPE / L3 HPP"
      },
      {
        "id": "MMU",
        "label": "MMU / 缓存与调度"
      },
      {
        "id": "Aux",
        "label": "绝对高优"
      },
      {
        "id": "TM_RULE",
        "label": "📝 调度规格约束： / 1个 L2 HPP (1.6T) 对应 2个 MACI。 / 每个 MACI 有 9 个端口。 / 因此，配套的 TM 必须支持 18 个端口的整包调度。"
      }
    ],
    "edges": [
      {
        "from": "PCIE",
        "to": "CPP"
      },
      {
        "from": "CPP",
        "to": "CPP_MACI"
      },
      {
        "from": "AUX_MAC",
        "to": "CPP_MACI"
      },
      {
        "from": "AUX_MAC",
        "to": "NOC3"
      },
      {
        "from": "NOC3",
        "to": "NOC2"
      },
      {
        "from": "NOC2",
        "to": "NOC1"
      },
      {
        "from": "NOC1",
        "to": "NOC0"
      },
      {
        "from": "CPP_MACI",
        "to": "NOC3"
      },
      {
        "from": "MACI0",
        "to": "L2_A"
      },
      {
        "from": "MACI1",
        "to": "L2_A"
      },
      {
        "from": "MACI2",
        "to": "L2_B"
      },
      {
        "from": "MACI3",
        "to": "L2_B"
      },
      {
        "from": "L2_A",
        "to": "L3"
      },
      {
        "from": "L2_B",
        "to": "L3"
      },
      {
        "from": "L3",
        "to": "MMU"
      },
      {
        "from": "PHY0",
        "to": "MACI0"
      },
      {
        "from": "PHY1",
        "to": "MACI1"
      },
      {
        "from": "PHY2",
        "to": "MACI2"
      },
      {
        "from": "PHY3",
        "to": "MACI3"
      },
      {
        "from": "NOC0",
        "to": "MACI0"
      },
      {
        "from": "NOC1",
        "to": "MACI1"
      },
      {
        "from": "NOC2",
        "to": "MACI2"
      },
      {
        "from": "NOC3",
        "to": "MACI3"
      }
    ]
  },
  {
    "id": "mac_wrapper",
    "title": "mac_wrapper",
    "direction": "TB",
    "nodes": [
      {
        "id": "MACI_TX",
        "label": "MAC INTERFACE / (MACI TX)"
      },
      {
        "id": "T_Sched",
        "label": "schedule / (按 chan_id 分配)"
      },
      {
        "id": "T_Fifo",
        "label": "fifo_0 ~ fifo_7 / (吸收路径延迟)"
      },
      {
        "id": "T_Buff",
        "label": "chan_buff_xxx / (位宽适配)"
      },
      {
        "id": "T_LLR",
        "label": "LLR_TX + CBFC"
      },
      {
        "id": "MAC_IP_TX",
        "label": "CEMAC IP / (8个 MAC AFIFO)"
      },
      {
        "id": "TX_WRAPPER",
        "label": "TX_WRAPPER"
      },
      {
        "id": "MAC_IP_RX",
        "label": "CEMAC IP / (8个 MAC AFIFO)"
      },
      {
        "id": "R_Drop",
        "label": "netp_rx_drop / (8路处理)"
      },
      {
        "id": "R_LLR",
        "label": "LLR_RX + CBFC / (8路处理)"
      },
      {
        "id": "R_Buff",
        "label": "chan_buff / (8路处理)"
      },
      {
        "id": "R_Weave",
        "label": "weave0 / weave1 / 及 MUX 选择器"
      },
      {
        "id": "R_Sched",
        "label": "schedule"
      },
      {
        "id": "MACI_RX",
        "label": "MAC INTERFACE / (MACI RX)"
      },
      {
        "id": "RX_WRAPPER",
        "label": "RX_WRAPPER"
      }
    ],
    "edges": [
      {
        "from": "T_Buff",
        "to": "T_LLR"
      },
      {
        "from": "MACI_TX",
        "to": "TX_WRAPPER"
      },
      {
        "from": "TX_WRAPPER",
        "to": "MAC_IP_TX"
      },
      {
        "from": "R_Drop",
        "to": "R_LLR"
      },
      {
        "from": "R_Weave",
        "to": "R_Sched"
      },
      {
        "from": "MAC_IP_RX",
        "to": "RX_WRAPPER"
      },
      {
        "from": "RX_WRAPPER",
        "to": "MACI_RX"
      }
    ]
  },
  {
    "id": "mac_wrapper_cemac_ip",
    "title": "mac_wrapper_cemac_ip",
    "direction": "TB",
    "nodes": [
      {
        "id": "MACI",
        "label": "MACI (MAC INTERFACE) / 外部系统交互接口 / (定宽报文数据与控制字交互)"
      },
      {
        "id": "N_Adapt",
        "label": "netp_data_ / adapt_top"
      },
      {
        "id": "CBFC",
        "label": "> CBFC[\"CBFC"
      },
      {
        "id": "LLR",
        "label": "-> CBFC LLR[\"LLR TX/RX"
      },
      {
        "id": "Drop",
        "label": "> CBFC LLR Drop[\"netp_rx_ / drop"
      },
      {
        "id": "N_FC",
        "label": "netp_fc_adapt_top"
      },
      {
        "id": "MC0",
        "label": "mac_core0 (兼容 800G)"
      },
      {
        "id": "MC4",
        "label": "mac_core4 (兼容 400G)"
      },
      {
        "id": "MC26",
        "label": "mac_core2, 6 (兼容 200G)"
      },
      {
        "id": "MC1357",
        "label": "mac_core1, 3, 5, 7 (兼容 100G)"
      },
      {
        "id": "PCS",
        "label": "CEPCS_TOP / (64/66b, Lane Lock)"
      },
      {
        "id": "FEC",
        "label": "CEFEC_TOP / (RS FEC 纠错)"
      },
      {
        "id": "SERDES",
        "label": "底层物理层 (PHY) / serdes/8*128"
      },
      {
        "id": "M_800G",
        "label": "800G 模式 / 核心: mac_core0 / MII 占用: Lanes 0~15 / SerDes 占用: Lanes 0~7"
      },
      {
        "id": "M_400G",
        "label": "400G 模式 / 核心: mac_core0 / 4 / MII 占用: 0~7 / 8~15 / SerDes 占用: 0~3 / 4~7"
      },
      {
        "id": "M_200G",
        "label": "200G 模式 / 核心: core0/2/4/6 / MII 占用: 每通道 4 lanes / SerDes 占用: 每通道 2 lanes"
      },
      {
        "id": "M_100G",
        "label": "100G 模式 / 核心: core0~7 / MII 占用: 每通道 2 lanes / SerDes 占用: 每通道 1 lane"
      }
    ],
    "edges": [
      {
        "from": "N_Adapt",
        "to": "LLR"
      },
      {
        "from": "PCS",
        "to": "FEC"
      }
    ]
  },
  {
    "id": "maci_rx",
    "title": "maci_rx",
    "direction": "LR",
    "nodes": [
      {
        "id": "MACW",
        "label": "Mac_wrapper"
      },
      {
        "id": "MACTX",
        "label": "MACI TX"
      },
      {
        "id": "MACNOC",
        "label": "MACI NOC"
      },
      {
        "id": "CBFC",
        "label": "CBFC_MNG"
      },
      {
        "id": "FCU",
        "label": "FCU"
      },
      {
        "id": "PAQM1",
        "label": "PAQM"
      },
      {
        "id": "PAQM2",
        "label": "PAQM"
      },
      {
        "id": "FFIFO",
        "label": "Flex FIFO"
      },
      {
        "id": "DATA_BUS",
        "label": "Data Bus / (Line_0 & 1)"
      },
      {
        "id": "DROP",
        "label": "Drop?"
      },
      {
        "id": "LBFIFO",
        "label": "Loop back FIFO / 8 (ch) x16K?"
      },
      {
        "id": "LBRR",
        "label": "RR / (Packet mode)"
      },
      {
        "id": "LBPRE",
        "label": "Prefetch FIFO / (8x1024bit)"
      },
      {
        "id": "LBINS",
        "label": "Insert loopback / header"
      },
      {
        "id": "ICU",
        "label": "ICU x2"
      },
      {
        "id": "CHMUX",
        "label": "Channel / mux"
      },
      {
        "id": "CTRL0_7",
        "label": "Drop 逻辑 x 8 / ↓ / Flex FIFO CTRL 0~7"
      },
      {
        "id": "WRR",
        "label": "WRR"
      },
      {
        "id": "CTRL8",
        "label": "Flex FIFO CTRL 8 / (AUX/BFD)"
      },
      {
        "id": "RRWRR",
        "label": "RR/WRR? / (Packet mode)"
      },
      {
        "id": "SP",
        "label": "SP"
      },
      {
        "id": "PIRX",
        "label": "PI RX"
      },
      {
        "id": "Pirx_maci_fc",
        "label": "9"
      },
      {
        "id": "MACI_RX",
        "label": "MACI_RX"
      },
      {
        "id": "Pirx_maci_credit",
        "label": "1"
      }
    ],
    "edges": [
      {
        "from": "DROP",
        "to": "LBRR"
      },
      {
        "from": "CHMUX",
        "to": "WRR"
      },
      {
        "from": "WRR",
        "to": "SP"
      },
      {
        "from": "CTRL8",
        "to": "RRWRR"
      },
      {
        "from": "RRWRR",
        "to": "SP"
      },
      {
        "from": "DATA_BUS",
        "to": "CHMUX"
      },
      {
        "from": "DATA_BUS",
        "to": "ICU"
      },
      {
        "from": "ICU",
        "to": "CHMUX"
      },
      {
        "from": "LBINS",
        "to": "CHMUX"
      },
      {
        "from": "MACW",
        "to": "CBFC"
      },
      {
        "from": "FCU",
        "to": "MACW"
      },
      {
        "from": "MACW",
        "to": "DATA_BUS"
      },
      {
        "from": "MACTX",
        "to": "DROP"
      },
      {
        "from": "MACNOC",
        "to": "CTRL8"
      },
      {
        "from": "CTRL8",
        "to": "MACNOC"
      },
      {
        "from": "SP",
        "to": "PIRX"
      },
      {
        "from": "PIRX",
        "to": "MACI_RX"
      }
    ]
  },
  {
    "id": "mirx",
    "title": "mirx",
    "direction": "LR",
    "nodes": [
      {
        "id": "MACIRX",
        "label": "MACI-RX"
      },
      {
        "id": "PIRX",
        "label": "PIRX(\"PIRX"
      },
      {
        "id": "PPIN",
        "label": "PP / (parser)"
      },
      {
        "id": "PITX",
        "label": "PITX"
      },
      {
        "id": "MIRX",
        "label": "MIRX"
      },
      {
        "id": "UCIE",
        "label": "UCIE"
      },
      {
        "id": "UMIRX",
        "label": "IRX(\"UMIRX"
      },
      {
        "id": "Ingress",
        "label": "Store"
      },
      {
        "id": "MC",
        "label": "ngress \" --> MC(\"MC / (Memory Core)"
      },
      {
        "id": "Egress",
        "label": "Data"
      },
      {
        "id": "TM",
        "label": "ess \" --> TM(\"TM"
      },
      {
        "id": "MITX",
        "label": "s \" --> MITX(\"MITX"
      },
      {
        "id": "PERX",
        "label": "PERX"
      },
      {
        "id": "PPOUT",
        "label": "PP / (parser)"
      },
      {
        "id": "PETX",
        "label": "PETX"
      },
      {
        "id": "MACITX",
        "label": "MACI-TX"
      }
    ],
    "edges": [
      {
        "from": "MACIRX",
        "to": "PIRX"
      },
      {
        "from": "PIRX",
        "to": "PPIN"
      },
      {
        "from": "PPIN",
        "to": "PITX"
      },
      {
        "from": "PITX",
        "to": "MIRX"
      },
      {
        "from": "UCIE",
        "to": "UMIRX"
      },
      {
        "from": "MIRX",
        "to": "MC"
      },
      {
        "from": "UMIRX",
        "to": "MC"
      },
      {
        "from": "MC",
        "to": "TM"
      },
      {
        "from": "MC",
        "to": "MITX"
      },
      {
        "from": "TM",
        "to": "MITX"
      },
      {
        "from": "MITX",
        "to": "PERX"
      },
      {
        "from": "PERX",
        "to": "PPOUT"
      },
      {
        "from": "PPOUT",
        "to": "PETX"
      },
      {
        "from": "PETX",
        "to": "MACITX"
      }
    ]
  },
  {
    "id": "packet_bypass_hardware_path",
    "title": "packet_bypass_hardware_path",
    "direction": "LR",
    "nodes": [
      {
        "id": "START",
        "label": "报文进入"
      },
      {
        "id": "Parser",
        "label": "Parser 解析"
      },
      {
        "id": "VFP",
        "label": "> VFP[VFP"
      },
      {
        "id": "INGVLAN",
        "label": "ING VLAN"
      },
      {
        "id": "LOOKUP",
        "label": "查表类型"
      },
      {
        "id": "EMF",
        "label": "EMF - MAC表"
      },
      {
        "id": "LPM",
        "label": "LPM - 路由表"
      },
      {
        "id": "EMFMC",
        "label": "EMF - MC"
      },
      {
        "id": "IACL",
        "label": "Ingress ACL"
      },
      {
        "id": "FWD",
        "label": "转发决策"
      },
      {
        "id": "L2EIF",
        "label": "L2EIF"
      },
      {
        "id": "ECMP",
        "label": "ECMP"
      },
      {
        "id": "L3PATH",
        "label": "L3 path"
      },
      {
        "id": "NEXTHOP",
        "label": "NEXTHOP"
      },
      {
        "id": "INGTRUNK",
        "label": "ING TRUNK?"
      },
      {
        "id": "PITX",
        "label": "PITX"
      },
      {
        "id": "XMMU",
        "label": "XMMU/MMU 入队"
      },
      {
        "id": "MCE",
        "label": "MCE[MCE 组播复制?"
      },
      {
        "id": "TM",
        "label": "TM 调度"
      },
      {
        "id": "MITX",
        "label": "MITX"
      },
      {
        "id": "PERX",
        "label": "ERX[PERX"
      },
      {
        "id": "EGRPARSER",
        "label": "EGR.parser"
      },
      {
        "id": "EGRNH",
        "label": "EGR.nexthop"
      },
      {
        "id": "TUNCHK",
        "label": "需要隧道?"
      },
      {
        "id": "L3OIF",
        "label": "L3OIF"
      },
      {
        "id": "TSTART",
        "label": "Tunnel Start 封装"
      },
      {
        "id": "EGRVLAN",
        "label": "EGR.VLAN"
      },
      {
        "id": "EACL",
        "label": "egress ACL?"
      },
      {
        "id": "MODIFY",
        "label": "Modify 改写"
      },
      {
        "id": "PETX",
        "label": "PETX"
      },
      {
        "id": "OUT",
        "label": "报文发出"
      },
      {
        "id": "SVP",
        "label": "SVP + MYMAC 识别"
      },
      {
        "id": "DVP",
        "label": "VP[DVP"
      },
      {
        "id": "TECMP",
        "label": "TECMP 二次查表"
      },
      {
        "id": "TNEXTHOP",
        "label": "TNEXTHOP"
      },
      {
        "id": "INNERL3",
        "label": "内层 LPM/ACL/ECMP"
      }
    ],
    "edges": [
      {
        "from": "START",
        "to": "Parser"
      },
      {
        "from": "Parser",
        "to": "VFP"
      },
      {
        "from": "VFP",
        "to": "INGVLAN"
      },
      {
        "from": "INGVLAN",
        "to": "LOOKUP"
      },
      {
        "from": "LOOKUP",
        "to": "EMF"
      },
      {
        "from": "LOOKUP",
        "to": "LPM"
      },
      {
        "from": "LOOKUP",
        "to": "EMFMC"
      },
      {
        "from": "EMF",
        "to": "IACL"
      },
      {
        "from": "LPM",
        "to": "IACL"
      },
      {
        "from": "EMFMC",
        "to": "IACL"
      },
      {
        "from": "IACL",
        "to": "FWD"
      },
      {
        "from": "FWD",
        "to": "L2EIF"
      },
      {
        "from": "FWD",
        "to": "ECMP"
      },
      {
        "from": "FWD",
        "to": "L3PATH"
      },
      {
        "from": "ECMP",
        "to": "NEXTHOP"
      },
      {
        "from": "L2EIF",
        "to": "INGTRUNK"
      },
      {
        "from": "NEXTHOP",
        "to": "INGTRUNK"
      },
      {
        "from": "L3PATH",
        "to": "INGTRUNK"
      },
      {
        "from": "INGTRUNK",
        "to": "PITX"
      },
      {
        "from": "XMMU",
        "to": "MCE"
      },
      {
        "from": "MCE",
        "to": "TM"
      },
      {
        "from": "MITX",
        "to": "PERX"
      },
      {
        "from": "PERX",
        "to": "EGRPARSER"
      },
      {
        "from": "EGRPARSER",
        "to": "EGRNH"
      },
      {
        "from": "EGRNH",
        "to": "TUNCHK"
      },
      {
        "from": "TUNCHK",
        "to": "L3OIF"
      },
      {
        "from": "L3OIF",
        "to": "TSTART"
      },
      {
        "from": "TSTART",
        "to": "EGRVLAN"
      },
      {
        "from": "TUNCHK",
        "to": "EGRVLAN"
      },
      {
        "from": "EGRVLAN",
        "to": "EACL"
      },
      {
        "from": "EACL",
        "to": "MODIFY"
      },
      {
        "from": "MODIFY",
        "to": "PETX"
      },
      {
        "from": "PITX",
        "to": "XMMU"
      },
      {
        "from": "TM",
        "to": "MITX"
      },
      {
        "from": "PETX",
        "to": "OUT"
      },
      {
        "from": "SVP",
        "to": "DVP"
      },
      {
        "from": "DVP",
        "to": "TECMP"
      },
      {
        "from": "TECMP",
        "to": "TNEXTHOP"
      }
    ]
  },
  {
    "id": "packet_u_path",
    "title": "packet_u_path",
    "direction": "LR",
    "nodes": [
      {
        "id": "S1",
        "label": "① SerDes & MAC / 32L 物理接收"
      },
      {
        "id": "S2",
        "label": "2[\"② MACI RX / 接口适配"
      },
      {
        "id": "S3",
        "label": "③ PIRX / 解析入口"
      },
      {
        "id": "S4",
        "label": "④ L2 HPP / 二层查表"
      },
      {
        "id": "S5",
        "label": "⑤ L3 HPP+SPP / 三层路由"
      },
      {
        "id": "S6",
        "label": "⑥ PITX / 管线出口"
      },
      {
        "id": "IPFIX_IN",
        "label": "IPFIX / 采样"
      },
      {
        "id": "TM1",
        "label": "TM / 流量排队 / 调度"
      },
      {
        "id": "TMMU",
        "label": "TMMU / Pipe 共享内存池"
      },
      {
        "id": "TM2",
        "label": "TM / 流量排队 / 调度"
      },
      {
        "id": "MC",
        "label": "MC / 组播复制分发"
      },
      {
        "id": "XMMU",
        "label": "XMMU / UCIe / 跨 Pipe / 跨 Die 交换矩阵"
      },
      {
        "id": "S7",
        "label": "⑦ PERX / 接收核心报文"
      },
      {
        "id": "S8",
        "label": "8[\"⑧ L2 HPP / 二层编辑"
      },
      {
        "id": "S9",
        "label": "⑨ L3 HPP+SPP / 三层编辑"
      },
      {
        "id": "S10",
        "label": "⑩ PETX / 重组出口"
      },
      {
        "id": "S11",
        "label": "⑪ MACI TX / 接口适配"
      },
      {
        "id": "S12",
        "label": "⑫ SerDes & MAC / 32L 物理发送"
      },
      {
        "id": "IPFIX_OUT",
        "label": "IPFIX / 采样"
      }
    ],
    "edges": [
      {
        "from": "S1",
        "to": "S2"
      },
      {
        "from": "S2",
        "to": "S3"
      },
      {
        "from": "S3",
        "to": "S4"
      },
      {
        "from": "S4",
        "to": "S5"
      },
      {
        "from": "S5",
        "to": "S6"
      },
      {
        "from": "S6",
        "to": "IPFIX_IN"
      },
      {
        "from": "S7",
        "to": "S8"
      },
      {
        "from": "S8",
        "to": "S9"
      },
      {
        "from": "S9",
        "to": "S10"
      },
      {
        "from": "S10",
        "to": "S11"
      },
      {
        "from": "S11",
        "to": "S12"
      },
      {
        "from": "IPFIX_OUT",
        "to": "S7"
      },
      {
        "from": "S6",
        "to": "TM1"
      },
      {
        "from": "S6",
        "to": "TMMU"
      },
      {
        "from": "S6",
        "to": "MC"
      },
      {
        "from": "S6",
        "to": "XMMU"
      },
      {
        "from": "TMMU",
        "to": "S9"
      },
      {
        "from": "TM2",
        "to": "S7"
      },
      {
        "from": "MC",
        "to": "S7"
      },
      {
        "from": "XMMU",
        "to": "S7"
      }
    ]
  },
  {
    "id": "pma_pmd_pcs_mac",
    "title": "pma_pmd_pcs_mac",
    "direction": "TB",
    "nodes": [
      {
        "id": "MAC_TX",
        "label": "MAC Transmit / 以太网帧组装 / FCS计算"
      },
      {
        "id": "MAC_RX",
        "label": "MAC Receive / 地址识别 / FCS校验"
      },
      {
        "id": "RS_TX",
        "label": "Reconciliation Sublayer / xGMII 接口发送"
      },
      {
        "id": "RS_RX",
        "label": "Reconciliation Sublayer / xGMII 接口接收"
      },
      {
        "id": "ENC_64_66",
        "label": "64B/66B 编码与速率匹配 / Encode & Rate Matching"
      },
      {
        "id": "TRANS_TX",
        "label": "64B/66B 到 256B/257B 转码 / Transcoder"
      },
      {
        "id": "SCR",
        "label": "扰码器 Scrambler"
      },
      {
        "id": "AM_TX",
        "label": "对齐标记插入 / Alignment Marker Insertion"
      },
      {
        "id": "FEC_ENC",
        "label": "FEC 编码 / Reed-Solomon Encode"
      },
      {
        "id": "DIST_TX",
        "label": "符号分发与交织 / Distribution & Interleave"
      },
      {
        "id": "ALIGN_RX",
        "label": "对齐锁定与通道去偏 / Alignment Lock & Deskew"
      },
      {
        "id": "REORDER_RX",
        "label": "通道重排与解交织 / Lane Reorder & De-interleave"
      },
      {
        "id": "FEC_DEC",
        "label": "FEC 解码与纠错 / Reed-Solomon Decode"
      },
      {
        "id": "AM_RX",
        "label": "对齐标记移除 / Alignment Marker Removal"
      },
      {
        "id": "DESCR",
        "label": "解扰器 Descrambler"
      },
      {
        "id": "TRANS_RX",
        "label": "256B/257B 到 64B/66B 转码 / Reverse Transcoder"
      },
      {
        "id": "DEC_64_66",
        "label": "64B/66B 解码与速率匹配 / Decode & Rate Matching"
      },
      {
        "id": "PMA_TX",
        "label": "PMA 发送: 比特级复用 & PAM4映射 / Bit-level Mux & PAM4 Encode"
      },
      {
        "id": "PMA_RX",
        "label": "PMA 接收: 时钟恢复, 解复用 & PAM4解码 / CDR, Demux & PAM4 Decode"
      },
      {
        "id": "PMD_TX",
        "label": "PMD 发送: 光/电驱动输出 / Signal Drivers"
      },
      {
        "id": "PMD_RX",
        "label": "PMD 接收: 光/电信号接收 / Signal Detect"
      },
      {
        "id": "MEDIUM",
        "label": "物理介质 / Physical Medium"
      }
    ],
    "edges": [
      {
        "from": "MAC_TX",
        "to": "RS_TX"
      },
      {
        "from": "RS_TX",
        "to": "ENC_64_66"
      },
      {
        "from": "ENC_64_66",
        "to": "TRANS_TX"
      },
      {
        "from": "TRANS_TX",
        "to": "SCR"
      },
      {
        "from": "SCR",
        "to": "AM_TX"
      },
      {
        "from": "AM_TX",
        "to": "FEC_ENC"
      },
      {
        "from": "FEC_ENC",
        "to": "DIST_TX"
      },
      {
        "from": "DIST_TX",
        "to": "PMA_TX"
      },
      {
        "from": "PMA_TX",
        "to": "PMD_TX"
      },
      {
        "from": "PMD_TX",
        "to": "MEDIUM"
      },
      {
        "from": "MEDIUM",
        "to": "PMD_RX"
      },
      {
        "from": "PMD_RX",
        "to": "PMA_RX"
      },
      {
        "from": "PMA_RX",
        "to": "ALIGN_RX"
      },
      {
        "from": "ALIGN_RX",
        "to": "REORDER_RX"
      },
      {
        "from": "REORDER_RX",
        "to": "FEC_DEC"
      },
      {
        "from": "FEC_DEC",
        "to": "AM_RX"
      },
      {
        "from": "AM_RX",
        "to": "DESCR"
      },
      {
        "from": "DESCR",
        "to": "TRANS_RX"
      },
      {
        "from": "TRANS_RX",
        "to": "DEC_64_66"
      },
      {
        "from": "DEC_64_66",
        "to": "RS_RX"
      },
      {
        "from": "RS_RX",
        "to": "MAC_RX"
      }
    ]
  },
  {
    "id": "pma_pmd_pcs_mac_llr_cbfc",
    "title": "pma_pmd_pcs_mac_llr_cbfc",
    "direction": "TB",
    "nodes": [
      {
        "id": "LLC_IN",
        "label": "上层协议 / MAC Client / LLC"
      },
      {
        "id": "CBFC_TX",
        "label": "FC_TX[\"CBFC 发送处理 / Credit Check & Flow Control"
      },
      {
        "id": "LLR_TX",
        "label": "LLR 发送处理 / Sequence Assignment & Tx Buffer"
      },
      {
        "id": "FA",
        "label": "MAC 帧组装 / Frame Assembly"
      },
      {
        "id": "FCS",
        "label": "FCS 计算与附加"
      },
      {
        "id": "Preamble",
        "label": "前导码与 SFD 插入"
      },
      {
        "id": "RS_TX",
        "label": "Reconciliation Sublayer / xGMII 接口发送"
      },
      {
        "id": "ENC",
        "label": "64B/66B 编码与速率匹配"
      },
      {
        "id": "TRANS",
        "label": "NS[\"64B/66B 到 256B/257B 转码"
      },
      {
        "id": "SCR",
        "label": "扰码器 Scrambler"
      },
      {
        "id": "AM_TX",
        "label": "对齐标记插入"
      },
      {
        "id": "FEC_ENC",
        "label": "FEC 编码 / Reed-Solomon Encode"
      },
      {
        "id": "DIST",
        "label": "符号分发与交织"
      },
      {
        "id": "PMA_TX",
        "label": "PMA 发送: 比特级复用 & PAM4 映射"
      },
      {
        "id": "PMD_TX",
        "label": "PMD 发送: 光/电驱动输出"
      },
      {
        "id": "MEDIUM",
        "label": "物理介质 / Physical Medium"
      },
      {
        "id": "PMD_RX",
        "label": "PMD 接收: 光/电信号接收"
      },
      {
        "id": "PMA_RX",
        "label": "PMA 接收: 时钟恢复 / 解复用 / PAM4 解码"
      },
      {
        "id": "ALIGN",
        "label": "对齐锁定与通道去偏"
      },
      {
        "id": "REORDER",
        "label": "RDER[\"通道重排与解交织"
      },
      {
        "id": "FEC_DEC",
        "label": "FEC 解码与纠错 / Reed-Solomon Decode"
      },
      {
        "id": "AM_RX",
        "label": "对齐标记移除"
      },
      {
        "id": "DESCR",
        "label": "解扰器 Descrambler"
      },
      {
        "id": "TRANS_RX",
        "label": "256B/257B 到 64B/66B 反转换码"
      },
      {
        "id": "DEC",
        "label": "64B/66B 解码与速率匹配"
      },
      {
        "id": "RS_RX",
        "label": "Reconciliation Sublayer / xGMII 接口接收"
      },
      {
        "id": "PRE_RM",
        "label": "前导码与 SFD 移除"
      },
      {
        "id": "FCS_CHK",
        "label": "FCS 校验与剥离"
      },
      {
        "id": "MAC_RX",
        "label": "MAC 接收处理 / Address & Processing"
      },
      {
        "id": "LLR_RX",
        "label": "LLR 序检处理 / Sequence Check & ACK/NACK"
      },
      {
        "id": "CBFC_RX",
        "label": "CBFC 接收处理 / Credit Generation & Update"
      },
      {
        "id": "LLC_OUT",
        "label": "上层协议 / MAC Client / LLC"
      },
      {
        "id": "NOTE1",
        "label": "生成 ACK/NACK / 用于纠错重传"
      },
      {
        "id": "NOTE2",
        "label": "生成 CF_upstate / 向对端发送信用"
      }
    ],
    "edges": [
      {
        "from": "LLC_IN",
        "to": "CBFC_TX"
      },
      {
        "from": "CBFC_TX",
        "to": "LLR_TX"
      },
      {
        "from": "LLR_TX",
        "to": "FA"
      },
      {
        "from": "FA",
        "to": "FCS"
      },
      {
        "from": "FCS",
        "to": "Preamble"
      },
      {
        "from": "Preamble",
        "to": "RS_TX"
      },
      {
        "from": "ENC",
        "to": "TRANS"
      },
      {
        "from": "TRANS",
        "to": "SCR"
      },
      {
        "from": "SCR",
        "to": "AM_TX"
      },
      {
        "from": "AM_TX",
        "to": "FEC_ENC"
      },
      {
        "from": "FEC_ENC",
        "to": "DIST"
      },
      {
        "from": "RS_TX",
        "to": "ENC"
      },
      {
        "from": "DIST",
        "to": "PMA_TX"
      },
      {
        "from": "PMA_TX",
        "to": "PMD_TX"
      },
      {
        "from": "PMD_TX",
        "to": "MEDIUM"
      },
      {
        "from": "MEDIUM",
        "to": "PMD_RX"
      },
      {
        "from": "PMD_RX",
        "to": "PMA_RX"
      },
      {
        "from": "ALIGN",
        "to": "REORDER"
      },
      {
        "from": "REORDER",
        "to": "FEC_DEC"
      },
      {
        "from": "FEC_DEC",
        "to": "AM_RX"
      },
      {
        "from": "AM_RX",
        "to": "DESCR"
      },
      {
        "from": "DESCR",
        "to": "TRANS_RX"
      },
      {
        "from": "TRANS_RX",
        "to": "DEC"
      },
      {
        "from": "PMA_RX",
        "to": "ALIGN"
      },
      {
        "from": "DEC",
        "to": "RS_RX"
      },
      {
        "from": "RS_RX",
        "to": "PRE_RM"
      },
      {
        "from": "PRE_RM",
        "to": "FCS_CHK"
      },
      {
        "from": "FCS_CHK",
        "to": "MAC_RX"
      },
      {
        "from": "MAC_RX",
        "to": "LLR_RX"
      },
      {
        "from": "LLR_RX",
        "to": "CBFC_RX"
      },
      {
        "from": "CBFC_RX",
        "to": "LLC_OUT"
      },
      {
        "from": "LLR_RX",
        "to": "NOTE1"
      },
      {
        "from": "CBFC_RX",
        "to": "NOTE2"
      }
    ]
  },
  {
    "id": "tm",
    "title": "tm",
    "direction": "TB",
    "nodes": [
      {
        "id": "PITX",
        "label": "PITX"
      },
      {
        "id": "PERX",
        "label": "PERX"
      },
      {
        "id": "MIRX",
        "label": "MIRX / Packet-IN / Parser"
      },
      {
        "id": "MCE",
        "label": "MCE / Multicast Engine"
      },
      {
        "id": "MC_BUF",
        "label": "MC-BUF / Multicast Buffer"
      },
      {
        "id": "MITX",
        "label": "MITX / Multicast TX"
      },
      {
        "id": "QC",
        "label": "QC (Local FD Mem)"
      },
      {
        "id": "RND",
        "label": "RND"
      },
      {
        "id": "MMU",
        "label": "MU[MMU"
      },
      {
        "id": "BMU",
        "label": "BMU"
      },
      {
        "id": "TND",
        "label": "ND[TND"
      },
      {
        "id": "QFN",
        "label": "QFN"
      },
      {
        "id": "QLN",
        "label": "LN[QLN"
      },
      {
        "id": "POL",
        "label": "POL"
      },
      {
        "id": "CBFC",
        "label": "FC[CBFC"
      },
      {
        "id": "SCH",
        "label": "SCH"
      },
      {
        "id": "SBC",
        "label": "SBC / System Buffer Ctrl"
      },
      {
        "id": "BM",
        "label": "BM / Buffer Manager"
      },
      {
        "id": "TLN",
        "label": "TLN / Translation Lookaside"
      },
      {
        "id": "FM",
        "label": "FM 8Bank / (Frame Memory)"
      },
      {
        "id": "EBN",
        "label": "EBN / EQN"
      },
      {
        "id": "CN",
        "label": "CN"
      },
      {
        "id": "QR",
        "label": "QR / QN / BN"
      },
      {
        "id": "TX",
        "label": "TX / TX Units"
      },
      {
        "id": "TD",
        "label": "TD0 / TD1"
      },
      {
        "id": "TN",
        "label": "TN0 / TN1"
      },
      {
        "id": "TM",
        "label": "TM"
      }
    ],
    "edges": [
      {
        "from": "RND",
        "to": "MMU"
      },
      {
        "from": "BMU",
        "to": "TND"
      },
      {
        "from": "QFN",
        "to": "QLN"
      },
      {
        "from": "POL",
        "to": "CBFC"
      },
      {
        "from": "PITX",
        "to": "MIRX"
      },
      {
        "from": "MIRX",
        "to": "PERX"
      },
      {
        "from": "MIRX",
        "to": "EBN"
      },
      {
        "from": "MIRX",
        "to": "TM"
      },
      {
        "from": "TM",
        "to": "CN"
      },
      {
        "from": "TM",
        "to": "QR"
      },
      {
        "from": "SBC",
        "to": "BM"
      },
      {
        "from": "BM",
        "to": "FM"
      },
      {
        "from": "BM",
        "to": "TLN"
      },
      {
        "from": "TLN",
        "to": "TM"
      },
      {
        "from": "FM",
        "to": "TX"
      },
      {
        "from": "TM",
        "to": "FM"
      },
      {
        "from": "MCE",
        "to": "MITX"
      },
      {
        "from": "MITX",
        "to": "MC_BUF"
      },
      {
        "from": "MC_BUF",
        "to": "TD"
      }
    ]
  },
  {
    "id": "tm_packet",
    "title": "tm_packet",
    "direction": "TB",
    "nodes": [
      {
        "id": "MIRX",
        "label": "MIRX / (数据与描述符接收入口)"
      },
      {
        "id": "ENQ",
        "label": "ENQ (入队模块) / • 聚合最多 16 个 FD / • 路由决策: 快/慢速通路"
      },
      {
        "id": "FAST_BUF",
        "label": "Fast Buffer (快速缓存) / • 12×384×128B / • 报文数据直存，避免跨DIE"
      },
      {
        "id": "LOCAL_FD",
        "label": "LOCAL_FD (本地描述符) / • 4K×100bit ECC / • 无出队延迟"
      },
      {
        "id": "CNNOC",
        "label": "CNNOC / • 远端 QMEM/XMMU 存取 / • 申请 tag，失败则 FD_FLUSH"
      },
      {
        "id": "SCH",
        "label": "SCH (三级调度引擎) / • 队列 -> CoS -> 端口 / • SP绝对优先 + WFQ权重公平 / • 双桶整形"
      },
      {
        "id": "FD_FIFO",
        "label": "FD FIFO"
      },
      {
        "id": "FD_LINK",
        "label": "FD link"
      },
      {
        "id": "DEQ",
        "label": "DEQ (出队模块) / • 接收 SCH 发送的 FD_TX / • 产生 FD_RD 触发读取"
      },
      {
        "id": "MITX",
        "label": "MITX / (向外发送 128B 数据)"
      },
      {
        "id": "PETX",
        "label": "PETX / (修改 IP CE 位)"
      },
      {
        "id": "AQM",
        "label": "AQM (统计接口) / • 5维队列深度统计 / • 计算 PFC/CBFC 流控"
      },
      {
        "id": "ECN",
        "label": "ECN (拥塞通知) / • 携带 ECN / fast_ECN 标记 / • 触发对端 DCQCN 降速"
      },
      {
        "id": "AQM_IF",
        "label": "AQM IF"
      }
    ],
    "edges": [
      {
        "from": "MIRX",
        "to": "ENQ"
      },
      {
        "from": "MIRX",
        "to": "FAST_BUF"
      },
      {
        "from": "MIRX",
        "to": "CNNOC"
      },
      {
        "from": "ENQ",
        "to": "FAST_BUF"
      },
      {
        "from": "ENQ",
        "to": "LOCAL_FD"
      },
      {
        "from": "ENQ",
        "to": "CNNOC"
      },
      {
        "from": "ENQ",
        "to": "SCH"
      },
      {
        "from": "ENQ",
        "to": "FD_FIFO"
      },
      {
        "from": "ENQ",
        "to": "FD_LINK"
      },
      {
        "from": "FD_LINK",
        "to": "SCH"
      },
      {
        "from": "SCH",
        "to": "FD_FIFO"
      },
      {
        "from": "SCH",
        "to": "DEQ"
      },
      {
        "from": "DEQ",
        "to": "LOCAL_FD"
      },
      {
        "from": "DEQ",
        "to": "CNNOC"
      },
      {
        "from": "DEQ",
        "to": "MITX"
      },
      {
        "from": "PETX",
        "to": "DEQ"
      },
      {
        "from": "LOCAL_FD",
        "to": "AQM"
      },
      {
        "from": "CNNOC",
        "to": "AQM"
      },
      {
        "from": "AQM",
        "to": "AQM_IF"
      },
      {
        "from": "ENQ",
        "to": "AQM_IF"
      },
      {
        "from": "FD_FIFO",
        "to": "ECN"
      },
      {
        "from": "DEQ",
        "to": "ECN"
      },
      {
        "from": "ECN",
        "to": "MITX"
      },
      {
        "from": "ECN",
        "to": "AQM_IF"
      },
      {
        "from": "FAST_BUF",
        "to": "MIRX"
      }
    ]
  },
  {
    "id": "xmmu",
    "title": "xmmu",
    "direction": "TB",
    "nodes": [
      {
        "id": "PITX",
        "label": "PITX"
      },
      {
        "id": "PERX",
        "label": "PERX"
      },
      {
        "id": "MIRX",
        "label": "MIRX / Packet-IN / Parser"
      },
      {
        "id": "MCE",
        "label": "MCE / Multicast Engine"
      },
      {
        "id": "MC_BUF",
        "label": "MC-BUF / Multicast Buffer"
      },
      {
        "id": "MITX",
        "label": "MITX / Multicast TX"
      },
      {
        "id": "QC",
        "label": "QC (Local FD Mem)"
      },
      {
        "id": "RND",
        "label": "RND"
      },
      {
        "id": "MMU",
        "label": "MU[MMU"
      },
      {
        "id": "BMU",
        "label": "BMU"
      },
      {
        "id": "TND",
        "label": "ND[TND"
      },
      {
        "id": "QFN",
        "label": "QFN"
      },
      {
        "id": "QLN",
        "label": "LN[QLN"
      },
      {
        "id": "POL",
        "label": "POL"
      },
      {
        "id": "CBFC",
        "label": "FC[CBFC"
      },
      {
        "id": "SCH",
        "label": "SCH"
      },
      {
        "id": "SBC",
        "label": "SBC / System Buffer Ctrl"
      },
      {
        "id": "BM",
        "label": "BM / Buffer Manager"
      },
      {
        "id": "TLN",
        "label": "TLN / Translation Lookaside"
      },
      {
        "id": "FM",
        "label": "FM 8Bank / (Frame Memory)"
      },
      {
        "id": "EBN",
        "label": "EBN / EQN"
      },
      {
        "id": "CN",
        "label": "CN"
      },
      {
        "id": "QR",
        "label": "QR / QN / BN"
      },
      {
        "id": "TX",
        "label": "TX / TX Units"
      },
      {
        "id": "TD",
        "label": "TD0 / TD1"
      },
      {
        "id": "TN",
        "label": "TN0 / TN1"
      },
      {
        "id": "TM",
        "label": "TM"
      }
    ],
    "edges": [
      {
        "from": "RND",
        "to": "MMU"
      },
      {
        "from": "BMU",
        "to": "TND"
      },
      {
        "from": "QFN",
        "to": "QLN"
      },
      {
        "from": "POL",
        "to": "CBFC"
      },
      {
        "from": "PITX",
        "to": "MIRX"
      },
      {
        "from": "MIRX",
        "to": "PERX"
      },
      {
        "from": "MIRX",
        "to": "EBN"
      },
      {
        "from": "MIRX",
        "to": "TM"
      },
      {
        "from": "TM",
        "to": "CN"
      },
      {
        "from": "TM",
        "to": "QR"
      },
      {
        "from": "SBC",
        "to": "BM"
      },
      {
        "from": "BM",
        "to": "FM"
      },
      {
        "from": "BM",
        "to": "TLN"
      },
      {
        "from": "TLN",
        "to": "TM"
      },
      {
        "from": "FM",
        "to": "TX"
      },
      {
        "from": "TM",
        "to": "FM"
      },
      {
        "from": "MCE",
        "to": "MITX"
      },
      {
        "from": "MITX",
        "to": "MC_BUF"
      },
      {
        "from": "MC_BUF",
        "to": "TD"
      }
    ]
  },
  {
    "id": "xmmu_arch",
    "title": "xmmu_arch",
    "direction": "LR",
    "nodes": [
      {
        "id": "PITX",
        "label": "PITX"
      },
      {
        "id": "PERX",
        "label": "PERX"
      },
      {
        "id": "MCE",
        "label": "MCE"
      },
      {
        "id": "MCBUF",
        "label": "MC-BUF"
      },
      {
        "id": "MIRX",
        "label": "MIRX"
      },
      {
        "id": "RND",
        "label": "RND"
      },
      {
        "id": "MMU",
        "label": "MU[\"MMU"
      },
      {
        "id": "BMU",
        "label": "BMU"
      },
      {
        "id": "TND",
        "label": "TND"
      },
      {
        "id": "QFN",
        "label": "QFN"
      },
      {
        "id": "QC",
        "label": "QC / Local FD Mem"
      },
      {
        "id": "QLN",
        "label": "QLN"
      },
      {
        "id": "POL",
        "label": "POL"
      },
      {
        "id": "CBFC",
        "label": "CBFC"
      },
      {
        "id": "SCH",
        "label": "SCH"
      },
      {
        "id": "MITX",
        "label": "MITX"
      },
      {
        "id": "SBC",
        "label": "SBC"
      },
      {
        "id": "BM",
        "label": "BM"
      },
      {
        "id": "TLN",
        "label": "TLN / EBN / EQN / CN"
      },
      {
        "id": "NIFNE",
        "label": "NIFNE / QR/QN · QR/BN"
      },
      {
        "id": "FM",
        "label": "FM / 8Bank"
      },
      {
        "id": "LI",
        "label": "Link Interface"
      },
      {
        "id": "TXTX",
        "label": "TX/TX / TD0/TD1 · TN0/TN1"
      },
      {
        "id": "MC",
        "label": "MC"
      },
      {
        "id": "TM",
        "label": "TM"
      }
    ],
    "edges": [
      {
        "from": "RND",
        "to": "MMU"
      },
      {
        "from": "MMU",
        "to": "BMU"
      },
      {
        "from": "BMU",
        "to": "TND"
      },
      {
        "from": "TND",
        "to": "QFN"
      },
      {
        "from": "QFN",
        "to": "QC"
      },
      {
        "from": "QC",
        "to": "QLN"
      },
      {
        "from": "QLN",
        "to": "POL"
      },
      {
        "from": "POL",
        "to": "CBFC"
      },
      {
        "from": "CBFC",
        "to": "SCH"
      },
      {
        "from": "PITX",
        "to": "MIRX"
      },
      {
        "from": "PERX",
        "to": "MIRX"
      },
      {
        "from": "MCE",
        "to": "MIRX"
      },
      {
        "from": "MCBUF",
        "to": "MIRX"
      },
      {
        "from": "MIRX",
        "to": "RND"
      },
      {
        "from": "SCH",
        "to": "MITX"
      },
      {
        "from": "MITX",
        "to": "SBC"
      },
      {
        "from": "MITX",
        "to": "LI"
      },
      {
        "from": "MC",
        "to": "TM"
      },
      {
        "from": "MC",
        "to": "MCE"
      },
      {
        "from": "MC",
        "to": "PITX"
      },
      {
        "from": "MCBUF",
        "to": "MITX"
      }
    ]
  },
  {
    "id": "xmmu_module",
    "title": "xmmu_module",
    "direction": "LR",
    "nodes": [
      {
        "id": "PITX",
        "label": "PITX"
      },
      {
        "id": "PERX",
        "label": "PERX"
      },
      {
        "id": "BWLI_Spare",
        "label": "BWLI Spare"
      },
      {
        "id": "MC_BUF",
        "label": "MC-BUF"
      },
      {
        "id": "MCE",
        "label": "MCE"
      },
      {
        "id": "MIRX",
        "label": "MIRX"
      },
      {
        "id": "TM",
        "label": "TM"
      },
      {
        "id": "MITX",
        "label": "MITX"
      },
      {
        "id": "SBC",
        "label": "SBC"
      },
      {
        "id": "TLN_OUT",
        "label": "TLN"
      },
      {
        "id": "ESN",
        "label": "ESN (x3)"
      },
      {
        "id": "EQN",
        "label": "EQN (x3)"
      },
      {
        "id": "CN",
        "label": "CN (x3)"
      },
      {
        "id": "RN_RX",
        "label": "RN Array (6-ch) / ↓ / RX Array (6-ch)"
      },
      {
        "id": "PTR",
        "label": "Pointer / Req and Res"
      },
      {
        "id": "BM",
        "label": "BM"
      },
      {
        "id": "TLN_IN",
        "label": "TLN"
      },
      {
        "id": "FM",
        "label": "FM / 8Bank"
      },
      {
        "id": "CS",
        "label": "CS"
      },
      {
        "id": "TX_ARRAY",
        "label": "TX TX / TX TX"
      },
      {
        "id": "TD_ARRAY",
        "label": "TD0 ↔ TD1"
      },
      {
        "id": "TN_ARRAY",
        "label": "TN0 XY / TN1 YX"
      },
      {
        "id": "QR_QN",
        "label": "QR / QN"
      },
      {
        "id": "QR_SN",
        "label": "QR / SN"
      },
      {
        "id": "FD_TXN",
        "label": "FD FD FD / TXN TXN TXN"
      }
    ],
    "edges": [
      {
        "from": "PITX",
        "to": "MIRX"
      },
      {
        "from": "MIRX",
        "to": "RN_RX"
      },
      {
        "from": "FM",
        "to": "TD_ARRAY"
      },
      {
        "from": "TD_ARRAY",
        "to": "MITX"
      },
      {
        "from": "RN_RX",
        "to": "PTR"
      },
      {
        "from": "MIRX",
        "to": "TM"
      },
      {
        "from": "TM",
        "to": "PERX"
      },
      {
        "from": "MCE",
        "to": "TM"
      },
      {
        "from": "TN_ARRAY",
        "to": "TD_ARRAY"
      },
      {
        "from": "MC_BUF",
        "to": "BWLI_Spare"
      },
      {
        "from": "MC_BUF",
        "to": "MCE"
      },
      {
        "from": "MCE",
        "to": "MC_BUF"
      },
      {
        "from": "MCE",
        "to": "MITX"
      },
      {
        "from": "MIRX",
        "to": "ESN"
      },
      {
        "from": "MIRX",
        "to": "EQN"
      },
      {
        "from": "MIRX",
        "to": "SBC"
      },
      {
        "from": "SBC",
        "to": "EQN"
      },
      {
        "from": "TLN_OUT",
        "to": "MIRX"
      },
      {
        "from": "TLN_IN",
        "to": "TLN_OUT"
      },
      {
        "from": "TM",
        "to": "CN"
      },
      {
        "from": "TM",
        "to": "FD_TXN"
      },
      {
        "from": "CN",
        "to": "CS"
      },
      {
        "from": "CN",
        "to": "QR_QN"
      },
      {
        "from": "CN",
        "to": "QR_SN"
      },
      {
        "from": "FD_TXN",
        "to": "CS"
      },
      {
        "from": "PTR",
        "to": "BM"
      },
      {
        "from": "PTR",
        "to": "FM"
      },
      {
        "from": "BM",
        "to": "FM"
      },
      {
        "from": "BM",
        "to": "CS"
      },
      {
        "from": "BM",
        "to": "TX_ARRAY"
      },
      {
        "from": "BM",
        "to": "TLN_IN"
      },
      {
        "from": "CS",
        "to": "FM"
      },
      {
        "from": "CS",
        "to": "TX_ARRAY"
      }
    ]
  }
];
