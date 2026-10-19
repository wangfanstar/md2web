# RLM (Reduced Lane Mode) 测试用例

> 芯片测试 CLI — 覆盖全部 `rlm set / rlm show` 命令与 RLM 寄存器直接读写对照，三种速率 800GR8 / 400GR4 / 200GR2 各测一轮。
> 所有命令均在 `CMD_VIEW_SYSTEM`（DEBUG）视图下执行，自动携带 `[ chip N ]` 前缀。
> 相关源文件：`sdk/src/cli/modules/soc/qlake/cli_rlm.c`、`sdk/src/soc/qlake/ql/ql_npu_rlm.c`、`sdk/include/soc/qlake/ql/ql_npu_rlm.h`。

---

## 目录

1. [测试环境与准备](#1-测试环境与准备)
2. [寻址、速率与寄存器速查](#2-寻址速率与寄存器速查)
3. [寄存器直读 / 直写用例](#3-寄存器直读--直写用例)
4. [set 命令用例](#4-set-命令用例)
5. [show 命令用例](#5-show-命令用例)
6. [三种速率 lane 缩减与恢复](#6-三种速率-lane-缩减与恢复)
7. [中断用例](#7-中断用例)
8. [复位用例](#8-复位用例)
9. [错误与边界用例](#9-错误与边界用例)
10. [LLR + RLM 联合用例](#10-llr--rlm-联合用例)
11. [附录 A — 命令速查表](#附录-a--命令速查表)
12. [附录 B — 寄存器/字段速查表](#附录-b--寄存器字段速查表)
13. [附录 C — 判定准则与恢复清单](#附录-c--判定准则与恢复清单)

---

## 1. 测试环境与准备

### 1.1 环境

| 项目 | 说明 |
|------|------|
| 测试视图 | `CMD_VIEW_SYSTEM`（DEBUG） |
| Chip 索引 | `chip 0` |
| 前置条件 | 端口已按目标速率配置完成，PCS 链路已锁定（link up）；如验证 LLR 相关用例需先 enable LLR |
| 寄存器访问 | RLM 寄存器为**直接寄存器**，用 `reg read / reg write`；无需 `memory read` |
| 计数器特性 | `RLM_SWITCH_CODE_STAT_CNT(0x18c)`、`RLM_RX_FAULT_CODE_STAT_CNT(0x18d)`、`RLM_AM_CRC_ERROR_STAT(0x18e)`、`RLM_EXCEED_DSK_CAPABILITY(0x17b)` 为 **RC（Read-Clear）**，读取后自动清零，禁止为取 raw 值而重复读取 |
| 速率自动识别 | `rlm set ... enable/disable` 不再需要速率参数：CLI 内部用 `ql_macw_speed_get()` 读取端口当前速率，再判断是否支持 RLM |

### 1.2 前置检查

```
port show chip 0 chiplet 0 port 0 stat        # 确认端口速率/链路
rlm show port-id 0 config                     # 确认可读到 RLM 寄存器
```

> `rlm show ...` 输出第一段会打印 `inst=0x....  module=<id>`，该 `module` 即后续 `reg read/write` 要用的 module-id；每条寄存器的 `reg=<id>` 即 reg-id，可直接复制到 `reg read/write`。

---

## 2. 寻址、速率与寄存器速查

### 2.1 两种寻址形式

所有命令都有两种等价形式：

```
rlm set  port-id <0-511>            <sub-cmd> ...      # port-id 形式
rlm set  pipe <0-63> channel <0-7>  <sub-cmd> ...      # pipe+channel 形式
rlm show port-id <0-511>            <sub-cmd>
rlm show pipe <0-63> channel <0-7>  <sub-cmd>
```

换算关系：

```
pipe    = port_id / 8
channel = port_id % 8
port_id = pipe * 8 + channel
```

> 底层 RLM 硬件 API 按 **pipe（MAC）粒度** 操作；`channel` 只用于换算端口、打印与 `enable/disable` 的旁路位。

### 2.2 速率与端口映射

| 速率 | Lane 数 | 有效起始 Channel | RLM 使能 | 端口旁路位（BYPASS_RLM_EN） |
|------|--------|-----------------|---------|----------------------------|
| 800GR8 | 8 | 0 | 支持 | bit0（ch0~7 整 MAC 一个端口） |
| 400GR4 | 4 | 0, 4 | 支持 | bit0 / bit2 |
| 200GR2 | 2 | 0, 2, 4, 6 | 支持 | bit0 / bit1 / bit2 / bit3 |
| 400GR8 | 8 | 0 | 不支持（CLI 报错） | — |
| 200GR4 / 100GR4 / 100GR2 / 100GR1 / 50GR* / 25GR1 / 10GR1 / HEI* | — | — | 不支持（CLI 报错） | — |

| 速率 | Port 0 | Port 1 | Port 2 | Port 3 |
|------|--------|--------|--------|--------|
| 800GR8 | Lane 0-7 | — | — | — |
| 400GR4 | Lane 0-3 | Lane 4-7 | — | — |
| 200GR2 | Lane 0-1 | Lane 2-3 | Lane 4-5 | Lane 6-7 |

> `enable/disable` 对一个 MAC（pipe）生效；EN 为整 MAC 全局位，单端口是否生效由 `BYPASS_RLM_EN` 对应位决定。仅当该 MAC 上所有端口都被旁路时，全局 `EN` 才清 0。

### 2.3 PCS 子块 / 模块 / 实例映射

RLM 寄存器在三个 PCS 子块中布局完全一致，仅寄存器 ID 不同；按 `pipe % 16` 选择：

| pipe % 16 | 子块 | module-id（示例，以 `reg show module-id-list` 为准） | block | instance-id |
|-----------|------|------------------------------|-------|-------------|
| 0-7 | `MACW_PCS_MACW_PCS` | 104 | p | `(pipe/16)<<16 \| p` |
| 8 / 15 | `SDS_CMU_PCS_MACW_PCS` | 132 | 0 / 1 | `(pipe/16)<<16 \| (0 或 1)` |
| 9-14 | `SDS_PCS_MACW_PCS` | 137 | p-9 | `(pipe/16)<<16 \| (p-9)` |

> `instance-id` = `(chiplet << 16) | block`，chiplet = `pipe / 16`。例如 chip0 / pipe0 → `0x00000000`；pipe3 → `0x00000003`；pipe11 → `0x00000002`（SDS_PCS，module 137）。

### 2.4 RLM FSM 状态值

| TX FSM | 值 | 含义 |
|--------|----|------|
| INIT | 0 | 待机，全宽度模式 |
| SWITCH | 1 | 通道切换协调中 |
| REDUCE | 2 | 稳定运行于精简宽度 |

| RX FSM | 值 | 含义 |
|--------|----|------|
| INIT | 0 | 未锁定 AM |
| LOCK | 1 | 正常工作态，AM 已锁定 |
| SWITCH | 2 | 通道切换中 |
| REDUCE | 3 | 精简宽度，已稳定 |

> `RLM_SWITCH_FSM_STATUS(0x17c)`：TX FSM 每 lane 一个（8 个独立），位于 bits[15:0]（每 lane 2bit）；RX FSM 每 port 一个（4 个共享），寄存器按 lane 展示于 bits[31:16]，同 port 的 lane 读数相同。

### 2.5 中断位布局

`INTR_STS_0(0x030)` / `INTR_STS_MASK_0(0x034)` / `INTR_ENABLE_0(0x038)`：

| Bit | 中断源 |
|:---:|--------|
| 7:0 | LINK（PCS 链路状态） |
| 15:8 | RX_LINK_DOWN |
| 19:16 | RLM_TX_LINK_DOWN（每 port 1bit） |
| 23:20 | RLM_RX_LINK_DOWN（每 port 1bit） |
| 27:24 | RLM_RX_REDUCE_INTR（每 port 1bit） |
| 28 | SE_HIT |

### 2.6 复位类型

| 复位类型 | 作用范围 | FSM 影响 |
|---------|---------|---------|
| `pcs-tx` | RLM 内部 PCS 侧 TX 模块（每 lane 独立） | FSM 复位 → INIT |
| `pcs-rx` | RLM 内部 PCS 侧 RX 模块（每 lane 独立） | FSM 复位 → INIT |
| `sds-tx` | RLM 内部 Serdes 侧 TX 数据流 | FSM 状态不变，数据流停止 |
| `sds-rx` | RLM 内部 Serdes 侧 RX 数据流 | FSM 状态不变，数据流停止 |

### 2.7 计数器说明

每条 lane 的切换/故障码统计为 **4bit 饱和计数器**（最大 15）；AM CRC 错误为 **8bit 饱和计数器**（最大 255）。

| 计数器（CLI 列名） | 寄存器 / 字段 |
|-------------------|--------------|
| TX Switch Cnt | `RLM_SWITCH_CODE_STAT_CNT(0x18c)[31:0]`（8 lane × 4bit） |
| RX Switch Cnt | `RLM_SWITCH_CODE_STAT_CNT(0x18c)[63:32]` |
| TX Fault Cnt | `RLM_RX_FAULT_CODE_STAT_CNT(0x18d)[31:0]` |
| RX Fault Cnt | `RLM_RX_FAULT_CODE_STAT_CNT(0x18d)[63:32]` |
| AM CRC Err | `RLM_AM_CRC_ERROR_STAT(0x18e)`（8 lane × 8bit） |
| Exceed DSK | `RLM_EXCEED_DSK_CAPABILITY(0x17b)[7:0]` |

## 3. 寄存器直读 / 直写用例

### 3.0 命令语法

```
reg read  module-id <M> instance-id <I> reg-id <R> [ count <N> ]
reg read  module-id <M> instance-id <I> reg-id <R> field <offset> <len>
reg write module-id <M> instance-id <I> reg-id <R> value <HEX<0-FFFFFFFFFFFFFFFF>>
reg write module-id <M> instance-id <I> reg-id <R> field <offset> <len> value <HEX>
reg show reg-id-list   module-id <M>
reg show field-id-list reg-id <R>
```

- `module-id`：PCS 子块号（`rlm show config` 打印的 `module=<id>`；MACW_PCS 通常为 104）。
- `instance-id`：`(chiplet << 16) | block`（见 2.3）。
- `reg-id`：RLM 寄存器号（`rlm show config` 每条打印的 `reg=<id>`）。

> 下文以 **chip0 / pipe0 / MACW_PCS（module-id=104，instance-id=0x00000000）** 为例；reg-id 数值以本 SDK `ql_reg_def.h` 为准，可用 `rlm show ... config` 打印的 `reg=` 值核对。

### 3.1 RLM 寄存器 reg-id 速查

| 地址 | 寄存器名 | MACW_PCS(pipe0-7) | SDS_CMU_PCS(pipe8/15) | SDS_PCS(pipe9-14) |
|------|---------|:-----------------:|:---------------------:|:-----------------:|
| 0x170 | CFG_RLM | 7561 | 10576 | 10780 |
| 0x171 | CFG_RLM_FAULT_SDS_LANE | 7562 | 10577 | 10781 |
| 0x172 | CFG_RLM_LANE_SWAP | 7563 | 10578 | 10782 |
| 0x173 | CFG_RLM_AM_PERIOD | 7564 | 10579 | 10783 |
| 0x174 | CFG_RLM_SDS_TX_VLD | 7565 | 10580 | 10784 |
| 0x175 | CFG_RLM_LANE_LOCK | 7566 | 10581 | 10785 |
| 0x176 | CFG_RLM_SDS_FAULT_MASK | 7567 | 10582 | 10786 |
| 0x177 | CFG_RLM_RX_UE_FAULT_TH | 7568 | 10583 | 10787 |
| 0x178 | CFG_RLM_CRC_CHECK | 7569 | 10584 | 10788 |
| 0x179 | CFG_RLM_RST | 7570 | 10585 | 10789 |
| 0x17a | RLM_RX_LINK_STATUS | 7571 | 10586 | 10790 |
| 0x17b | RLM_EXCEED_DSK_CAPABILITY | 7572 | 10587 | 10791 |
| 0x17c | RLM_SWITCH_FSM_STATUS | 7573 | 10588 | 10792 |
| 0x17d | RLM_FAULT_LANE_STATUS | 7574 | 10589 | 10793 |
| 0x18c | RLM_SWITCH_CODE_STAT_CNT | 7578 | 10593 | 10797 |
| 0x18d | RLM_RX_FAULT_CODE_STAT_CNT | 7579 | 10594 | 10798 |
| 0x18e | RLM_AM_CRC_ERROR_STAT | 7580 | 10595 | 10799 |
| 0x030 | INTR_STS_0 | 7503 | 10518 | 10722 |
| 0x034 | INTR_STS_MASK_0 | 7504 | 10519 | 10723 |
| 0x038 | INTR_ENABLE_0 | 7505 | 10520 | 10724 |

### 3.2 寄存器读写用例

#### TC-REG-01 — 直读 CFG_RLM 与 `rlm show config` 交叉验证

```
reg read module-id 104 instance-id 0x00000000 reg-id 7561
rlm show port-id 0 config
```

**步骤**：直读 `CFG_RLM` raw 值；再用 `rlm show config` 读同一寄存器。
**预期**：两处 raw 一致；`config` 打印的 `reg=` 与 `reg-id` 一致；`EN / TX_AFIFO_TH / BYPASS_RLM_EN` 字段与直读按位解析一致。
**PASS 判定**：raw 相等，且字段解析一致。

> 注意：`rlm show config` 当前 `LOOP_BACK_EN` 恒打印 `0x00`（源码 TODO 未回读），验证 loopback 请以 `CFG_RLM bits[8:1]` 直读为准。

---

#### TC-REG-02 — 直写 CFG_RLM.EN 后直读回读

```
# 置 EN=1（保留其它字段，示例 raw=0x0000...0001）
reg write module-id 104 instance-id 0x00000000 reg-id 7561 value 0x0000000000000001
reg read  module-id 104 instance-id 0x00000000 reg-id 7561
# 清 EN=0
reg write module-id 104 instance-id 0x00000000 reg-id 7561 value 0x0000000000000000
reg read  module-id 104 instance-id 0x00000000 reg-id 7561
```

**预期**：回读 raw bit0 与写入一致；`rlm show config` 的 `EN` 随之一致。
**注意**：直写会覆盖整个 64bit 寄存器，请先读出原值再按位修改，勿直接把 EN 之外的字段清零。

---

#### TC-REG-03 — 字段级直写 TX_AFIFO_TH

```
# 字段方式：bitoff=9 len=4（TX_AFIFO_TH）
reg write module-id 104 instance-id 0x00000000 reg-id 7561 field 9 4 value 0x5
reg read  module-id 104 instance-id 0x00000000 reg-id 7561 field 9 4
```

**预期**：字段回读 = 0x5；`rlm show config` → `TX_AFIFO_TH=5`。
**恢复**：复位默认值 0xC（12）：`reg write ... field 9 4 value 0xC`。

---

#### TC-REG-04 — RC 计数器读清零验证

```
# 读取前后各一次，第二次应为 0（或仅统计两次读取之间的新事件）
rlm show port-id 0 counter
rlm show port-id 0 counter
```

**步骤**：连续两次读 counter。
**预期**：`SWITCH_CODE_STAT_CNT / RX_FAULT_CODE_STAT_CNT / AM_CRC_ERROR_STAT / EXCEED_DSK_CAPABILITY` 均为 RC；第二次读的值反映两次读取之间的新事件，链路静止时应为全 0。
**PASS 判定**：RC 行为符合"读后清零"。

---

#### TC-REG-05 — 直读状态寄存器（FSM / Fault / Reset）

```
reg read module-id 104 instance-id 0x00000000 reg-id 7573   # RLM_SWITCH_FSM_STATUS (0x17c)
reg read module-id 104 instance-id 0x00000000 reg-id 7574   # RLM_FAULT_LANE_STATUS (0x17d)
reg read module-id 104 instance-id 0x00000000 reg-id 7570   # CFG_RLM_RST (0x179)
rlm show port-id 0 fsm
rlm show port-id 0 fault-lane-status
rlm show port-id 0 reset-status
```

**预期**：直读 raw 与 `rlm show` 输出的 `raw=0x...` 一致。
- `0x17c`：`TX = raw[15:0]` 每 lane 2bit；`RX = raw[31:16]` 每 lane 2bit。
- `0x17d`：`TX_Fault = raw[7:0]`；`RX_Fault = raw[15:8]`。
- `0x179`：PCS_TX/PCS_RX/SDS_TX/SDS_RX 各 16bit（SEL[7:0]+VAL[15:8]）。

---

#### TC-REG-06 — 跨 PCS 子块（pipe 8 / 9 / 11）直读

对 SDS 区 pipe 直读，验证 `ql_npu_rlm_pcs_reg_loc_get` 的子块重映射正确：

```
# pipe 8  -> SDS_CMU_PCS, module-id=132, instance-id=0x00000000
reg read module-id 132 instance-id 0x00000000 reg-id 10576
# pipe 9  -> SDS_PCS,     module-id=137, instance-id=0x00000000
reg read module-id 137 instance-id 0x00000000 reg-id 10780
# pipe 11 -> SDS_PCS,     module-id=137, instance-id=0x00000002
reg read module-id 137 instance-id 0x00000002 reg-id 10780
```

**预期**：均读回成功；与 `rlm show pipe 8 channel 0 config` / `rlm show pipe 9 channel 0 config` / `rlm show pipe 11 channel 0 config` 打印的 `module=`、`inst=`、`reg=`、`raw=` 一致。
**PASS 判定**：子块/block/reg-id 三者映射一致，无越界错误。

---

## 4. set 命令用例

### 4.1 enable / disable

#### TC-SET-01 — RLM 使能（800GR8）

```
rlm show port-id 0 config
rlm set  port-id 0 enable
rlm show port-id 0 config
```

**步骤**：确认端口已配 800GR8 且 link up；enable；验证配置与状态。
**预期**：
- 打印 `RLM enabled: chip=0 pipe=0 channel=0  inst=0x.... module=<id>  speed=800GR8`
- `CFG_RLM.EN=1 (ENABLE)`，`BYPASS_RLM_EN` 对应位（bit0）清 0
- `rlm show port-id 0 status` → Port Type: 800GR8，RX Link Status port0=UP
- enable 后自动适配 `CFG_HETS_DIS_COMP`（打印 `DIS_COMP before/after`）

**PASS 判定**：`EN=1` 且本端口旁路位=0；DIS_COMP 有 before/after 对比输出。

---

#### TC-SET-02 — RLM 禁能（800GR8）

```
rlm set  port-id 0 disable
rlm show port-id 0 config
```

**预期**：打印 `RLM disabled: ... speed=800GR8`；`BYPASS_RLM_EN` 对应位置 1；该 MAC 全部端口都旁路时 `EN=0`。
**PASS 判定**：本端口不再生效；同 MAC 其它端口状态保持命令前状态。

---

#### TC-SET-03 — RLM 使能（400GR4，两个端口独立）

```
rlm set  port-id 0 enable          # ch0，旁路位 bit0
rlm set  port-id 4 enable          # ch4，旁路位 bit2
rlm show port-id 0 config
rlm show port-id 4 config
```

**预期**：`EN=1`；`BYPASS_RLM_EN` bit0=0、bit2=0。仅 enable port4 时 port0 保持原状态。
**PASS 判定**：两端口旁路位独立正确。

---

#### TC-SET-04 — RLM 使能（200GR2，四端口）

```
rlm set port-id 0 enable           # bit0
rlm set port-id 2 enable           # bit1
rlm set port-id 4 enable           # bit2
rlm set port-id 6 enable           # bit3
rlm show port-id 0 config
```

**预期**：`EN=1`，`BYPASS_RLM_EN=0x0`（4 位全 0）。

---

#### TC-SET-05 — enable/disable 循环

```
rlm set port-id 0 enable
rlm show port-id 0 config
rlm set port-id 0 disable
rlm show port-id 0 config
rlm set port-id 0 enable
rlm show port-id 0 config
```

**预期**：EN/旁路位按 enable→disable→enable 正确翻转，无残留、无报错。

---

### 4.2 tx-afifo-th

#### TC-SET-06 — TX_AFIFO_TH 设置

```
rlm set  port-id 0 tx-afifo-th 5
rlm show port-id 0 config
rlm set  port-id 0 tx-afifo-th 12
rlm show port-id 0 config
```

**预期**：`CFG_RLM.TX_AFIFO_TH=5`，再恢复 12（复位默认 0xC）。
**直读交叉**：`reg read module-id 104 instance-id 0x00000000 reg-id 7561 field 9 4` → 5 / 12。

---

### 4.3 loopback

#### TC-SET-07 — per-lane loopback 使能/禁能

```
rlm set  port-id 0 loopback lane-mask 0x03 enable
rlm show port-id 0 config
rlm set  port-id 0 loopback lane-mask 0x03 disable
```

**预期**：打印 `RLM loopback enabled/disabled: ... lane-mask=0x03`。
**直读验证**（`rlm show config` 的 LOOP_BACK_EN 恒为 0，需直读）：
```
reg read module-id 104 instance-id 0x00000000 reg-id 7561
# bits[8:1] = LOOP_BACK_EN；使能 0x03 时 bit1/bit2 = 1（lane0/lane1）
```

**PASS 判定**：`CFG_RLM bits[8:1]` 与 lane-mask 对应位一致。

---

### 4.4 bypass

#### TC-SET-08 — bypass 单端口（800GR8）

```
rlm set  port-id 0 bypass port-mask 0x1 enable
rlm show port-id 0 config
rlm set  port-id 0 bypass port-mask 0x1 disable
```

**预期**：`BYPASS_RLM_EN` bit0 = 1 / 0；日志 `port-mask=0x1`。
**注意**：`bypass` 不改变全局 `EN`，只置/清指定 200G 单元旁路位。

---

#### TC-SET-09 — bypass 多端口（200GR2）

```
rlm set port-id 0 enable
rlm set port-id 2 enable
rlm set port-id 0 bypass port-mask 0x5 enable
rlm show port-id 0 config
```

**预期**：`BYPASS_RLM_EN=0x5`（port0+port2 旁路），port1/port3 不受影响。

### 4.5 fault-sds-lane

#### TC-SET-10 — Serdes 故障 lane 软件注入

```
rlm set  port-id 0 fault-sds-lane tx-mask 0x03 rx-mask 0x0C
rlm show port-id 0 config
rlm show port-id 0 fault-lane-status
rlm set  port-id 0 fault-sds-lane tx-mask 0x00 rx-mask 0x00
```

**预期**：
- `CFG_RLM_FAULT_SDS_LANE`: `TX_SDS_LANE_NUM=0x03`, `RX_SDS_LANE_NUM=0x0C`
- `fault-lane-status` → lane0/lane1 TX=FAULT；lane2/lane3 RX=FAULT
**直读交叉**：`reg read ... reg-id 7562` → bits[7:0]=0x03, bits[15:8]=0x0C。

---

### 4.6 lane-swap

#### TC-SET-11 — lane-swap 全等映射 / 交叉映射

```
# 交叉映射（示例）
rlm set  port-id 0 lane-swap tx 0x00DB6C rx 0x00DB6C
rlm show port-id 0 config
# 恢复全等映射 laneN -> SDS N
rlm set  port-id 0 lane-swap tx 0x00FAC6 rx 0x00FAC6
```

**预期**：`CFG_RLM_LANE_SWAP` 打印每 lane 的 TX->SDS / RX->SDS 映射与设定一致；`0x00FAC6` 为 laneN→SDS N 全等映射。
**直读交叉**：`reg read ... reg-id 7563`：TX lane i = raw[3i+2:3i]，RX lane i = raw[24+3i+2:24+3i]，3bit/lane。

**PASS 判定**：直读每 lane 3bit 值与 `show config` 映射表一致；流量正常通过。

---

### 4.7 am-period

#### TC-SET-12 — AM 周期设置

```
rlm set  port-id 0 am-period 0
rlm show port-id 0 config
rlm set  port-id 0 am-period 5
rlm show port-id 0 config
rlm set  port-id 0 am-period 8
rlm show port-id 0 config
rlm set  port-id 0 am-period 0
```

**预期**：`CFG_RLM_AM_PERIOD.VAL` = 设定值，且 `AM period=` 随映射表变化：

| VAL | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|-----|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Period | 256 | 512 | 1024 | 2560 | 5120 | 10240 | 20480 | 40960 | 81920 |

**直读交叉**：`reg read ... reg-id 7564 field 0 4`。

---

### 4.8 sds-tx-vld

#### TC-SET-13 — Serdes TX valid 阈值

```
rlm set  port-id 0 sds-tx-vld down 10 up 5
rlm show port-id 0 config
rlm set  port-id 0 sds-tx-vld down 0 up 0
```

**预期**：`CFG_RLM_SDS_TX_VLD`: `DOWN_CNT=10`(bits[4:0])、`UP_CNT=5`(bits[9:5])；恢复 0/0。
**直读交叉**：`reg read ... reg-id 7565`。

---

### 4.9 lane-lock

#### TC-SET-14 — AM 锁定/失锁阈值

```
rlm set  port-id 0 lane-lock cmp-num 16 mismatch 4
rlm show port-id 0 config
rlm set  port-id 0 lane-lock cmp-num 0 mismatch 0
```

**预期**：`CFG_RLM_LANE_LOCK`: `CMP_NUM_TH=16`(bits[4:0])、`CMP_MISMATCH_TH=4`(bits[9:5])；恢复 0/0。
**语义**：连续 `CMP_NUM_TH` 次正确 AM 判定 LOCK；锁定后连续 `CMP_MISMATCH_TH` 次失配判定 UNLOCK。

---

### 4.10 sds-fault-mask

#### TC-SET-15 — Serdes 故障信号屏蔽

```
rlm set  port-id 0 sds-fault-mask sigdet 0x0F rxd-vld 0xF0 cpld 0x00 txc-vld 0xFF
rlm show port-id 0 config
rlm set  port-id 0 sds-fault-mask sigdet 0x00 rxd-vld 0x00 cpld 0x00 txc-vld 0x00
```

**预期**：`CFG_RLM_SDS_FAULT_MASK`: `SIGDET=0x0F`[7:0]、`RXD_VLD=0xF0`[15:8]、`CPLD=0x00`[23:16]、`TXC_VLD=0xFF`[31:24]。
**语义**：每 bit 对应一条 lane，1=屏蔽该类故障。

---

### 4.11 rx-ue-fault-th

#### TC-SET-16 — 连续 RX UE 错误阈值

```
rlm set  port-id 0 rx-ue-fault-th 5
rlm show port-id 0 config
rlm set  port-id 0 rx-ue-fault-th 0
```

**预期**：`CFG_RLM_RX_UE_FAULT_TH.NUM=5`(bits[4:0])；恢复 0。

---

### 4.12 crc-check

#### TC-SET-17 — AM CRC 校验与阈值

```
rlm set  port-id 0 crc-check enable err-th 10
rlm show port-id 0 config
rlm set  port-id 0 crc-check disable err-th 0
```

**预期**：`CFG_RLM_CRC_CHECK`: `EN=1`(bit0)、`ERR_TH=10`(bits[5:1])；关闭后 `EN=0`。
**直读交叉**：`reg read ... reg-id 7569`。

### 4.13 test force-fault

#### TC-SET-18 — 强制 lane 故障注入（RX/TX）

```
rlm set  port-id 0 test force-fault rx lane-mask 0x01 assert
rlm show port-id 0 fault-lane-status
rlm set  port-id 0 test force-fault rx lane-mask 0x01 deassert
```

**预期**：采用 read-modify-write，只影响指定方向的 lanes；注入后 `fault-lane-status` 对应 lane 为 FAULT，deassert 后恢复 ok。
**语义**：与 `fault-sds-lane` 操作同一寄存器 `CFG_RLM_FAULT_SDS_LANE(0x171)`，`force-fault` 便于按方向增量修改。

---

## 5. show 命令用例

### TC-SHOW-01 — config

```
rlm show port-id 0 config
```

**预期**：打印 `module=/inst=`、各寄存器 `reg=/addr=/raw=`，字段包括：
`CFG_RLM(EN/TX_AFIFO_TH/BYPASS_RLM_EN)`、`CFG_RLM_CRC_CHECK`、`CFG_RLM_LANE_SWAP(逐 lane 映射)`、`CFG_RLM_FAULT_SDS_LANE`、`CFG_RLM_AM_PERIOD`、`CFG_RLM_SDS_TX_VLD`、`CFG_RLM_LANE_LOCK`、`CFG_RLM_SDS_FAULT_MASK`、`CFG_RLM_RX_UE_FAULT_TH`、`CFG_RLM_RST`、`CFG_HETS_DIS_COMP_<ch>`、`am_decrease_scale`。
**PASS 判定**：所有期望字段均可读且与直读 raw 一致。

---

### TC-SHOW-02 — status

```
rlm show port-id 0 status
```

**预期**：`Port Type`、`FEC Mode`、`RLM_RX_LINK_STATUS`、`RLM_FAULT_LANE_STATUS` raw；逐 port 的 RX Link UP/DOWN（4 port）；TX/RX Fault Lanes 位图。

---

### TC-SHOW-03 — fsm

```
rlm show port-id 0 fsm
```

**预期**：`RLM_SWITCH_FSM_STATUS` raw；8 条 lane 的 TX FSM（8 独立）；8 条 lane 的 RX FSM（同 port 共享，port = lane/2）。

---

### TC-SHOW-04 — counter

```
rlm show port-id 0 counter
```

**预期**：打印 RC 寄存器 raw 标注；`TX/RX Switch Cnt`、`TX/RX Fault Cnt`、`AM CRC Err` 各 8 lane 值；`Exceed DSK` 位图。末尾提示 `RC counters cleared on read`。

---

### TC-SHOW-05 — rx-link-status

```
rlm show port-id 0 rx-link-status
```

**预期**：`RLM_RX_LINK_STATUS(0x17a)` raw + 4 个 port 的 UP/DOWN 与 bit 号。

---

### TC-SHOW-06 — fault-lane-status

```
rlm show port-id 0 fault-lane-status
```

**预期**：`RLM_FAULT_LANE_STATUS(0x17d)` raw；逐 lane 的 TX_Fault / RX_Fault；末尾 `TX_Fault=0x.. RX_Fault=0x..`。

---

### TC-SHOW-07 — reset-status

```
rlm show port-id 0 reset-status
```

**预期**：`CFG_RLM_RST(0x179)` raw；PCS_TX/PCS_RX/SDS_TX/SDS_RX 的 SEL/VAL 与告警 `ALL(asserted)/released/hw-auto`；`SEL=0` 为硬件控制，`SEL=1` 为软件接管。

---

### TC-SHOW-08 — intr-status

```
rlm show port-id 0 intr-status
```

**预期**：打印 `INTR_ENABLE_0(0x38)`、`INTR_STS_MASK_0(0x34)`、`INTR_STS_0(0x30)` 的 raw；按 2.5 的位段逐项列出 → 见 [7. 中断用例](#7-中断用例)。

---

### TC-SHOW-09 — pipe+channel 形式等价性

```
# 以下三组等价
rlm show port-id 0 config  ==  rlm show pipe 0 channel 0 config
rlm show port-id 5 config  ==  rlm show pipe 0 channel 5 config
rlm show port-id 9 config  ==  rlm show pipe 1 channel 1 config
```

**预期**：同一 (pipe,channel) 的两种形式输出一致（`channel` 仅影响打印与端口换算）。

---

## 6. 三种速率 lane 缩减与恢复

> 前置：对应速率使能完成（`rlm set ... enable`）；通过 `test force-fault` 注入 RX/TX lane 故障触发 RLM 缩减；恢复后再次读 FSM/计数器确认。

### 6.1 800GR8

#### TC-LANE-01 — 单 lane 故障缩减

```
rlm set  port-id 0 enable
rlm show port-id 0 fsm                       # 初始 TX=INIT, RX=LOCK
rlm set  port-id 0 test force-fault rx lane-mask 0x01 assert
rlm show port-id 0 fsm
rlm show port-id 0 status
rlm show port-id 0 counter
rlm set  port-id 0 test force-fault rx lane-mask 0x01 deassert
rlm show port-id 0 fsm
```

**预期**：RX 检测 lane0 故障 → RX FSM `LOCK(1)→SWITCH(2)→REDUCE(3)`；TX FSM `INIT(0)→SWITCH(1)→REDUCE(2)`；`counter` 的 TX/RX Switch Cnt 出现非 0；恢复后返回全宽（RX=LOCK，TX=INIT）。

#### TC-LANE-02 — 多 lane 逐步缩减

```
rlm set port-id 0 enable
rlm set port-id 0 test force-fault rx lane-mask 0x03 assert
rlm show port-id 0 fsm
rlm set port-id 0 test force-fault rx lane-mask 0x0F assert
rlm show port-id 0 fsm
rlm set port-id 0 test force-fault rx lane-mask 0x0F deassert
```

**预期**：2 lane 故障 → 可能缩到 400GR4；4 lane 故障 → 可能缩到 200GR2 或更低；每次切换经过 SWITCH，计数器逐次递增。

#### TC-LANE-03 — 不同包长下缩减

以 64B / 512B / 1518B / 9000B 各发流一轮，配合 `test force-fault rx lane-mask 0x01 assert` → 观察 FSM 进入 REDUCE、`counter` 的 Switch/Fault 计数、切换窗口内丢包情况。
**预期**：各包长均能完成缩减与恢复；长短包差异仅体现在切换窗口时长与丢包，功能一致。

---

### 6.2 400GR4

#### TC-LANE-04 — 双端口独立缩减

```
rlm set port-id 0 enable          # lane0-3
rlm set port-id 4 enable          # lane4-7
rlm set port-id 0 test force-fault rx lane-mask 0x0F assert   # 仅 port0
rlm show port-id 0 fsm
rlm show port-id 4 fsm
rlm set port-id 0 test force-fault rx lane-mask 0x0F deassert
```

**预期**：port0 进入 REDUCE，port4 保持 LOCK（lane4-7 正常）；两端口状态独立、互不影响。

---

### 6.3 200GR2

#### TC-LANE-05 — 单端口缩减

```
rlm set port-id 0 enable
rlm set port-id 0 test force-fault rx lane-mask 0x01 assert
rlm show port-id 0 fsm
rlm show port-id 0 counter
rlm set port-id 0 test force-fault rx lane-mask 0x01 deassert
```

**预期**：2 lane 中 1 lane 故障 → 缩到更低宽度或触发 port down；恢复后回到正常。

#### TC-LANE-06 — 四端口全部缩减

```
rlm set port-id 0 enable
rlm set port-id 2 enable
rlm set port-id 4 enable
rlm set port-id 6 enable
rlm set port-id 0 test force-fault rx lane-mask 0xFF assert
rlm show port-id 0 fsm
rlm show port-id 0 status
rlm set port-id 0 test force-fault rx lane-mask 0xFF deassert
```

**预期**：4 个 port 各自进入缩减状态，独立统计；恢复后全部回全宽。

---

### 6.4 震荡与稳定性

#### TC-LANE-07 — 快速反复缩减/恢复

```
rlm set port-id 0 enable
for i in 1 2 3 4 5; do
  rlm set port-id 0 test force-fault rx lane-mask 0x03 assert
  sleep 0.1
  rlm set port-id 0 test force-fault rx lane-mask 0x03 deassert
  sleep 0.1
done
rlm show port-id 0 fsm
rlm show port-id 0 counter
```

**预期**：FSM 在 LOCK↔SWITCH↔REDUCE 之间反复切换，不死锁、不丢状态；Switch Cnt 随切换次数递增；`counter` 读后清零，无累积异常。

---

## 7. 中断用例

> `rlm set ... intr enable/mask` 为**整寄存器直接写入**（非按位读改写），需给出完整 29bit 位图（`HEX<0-1FFFFFFF>`）。位布局见 2.5。

#### TC-INTR-01 — 使能指定中断

```
rlm set  port-id 0 intr enable 0x100000     # bit20 = RLM_RX_LINK_DOWN port0
rlm show port-id 0 intr-status
```

**预期**：`INTR_ENABLE_0=0x100000`；`intr-status` 中 `RLM_RX_LINK_DOWN (23:20)` 行 Enable 对应 port0=1。

#### TC-INTR-02 — 屏蔽中断

```
rlm set  port-id 0 intr enable 0x100000
rlm set  port-id 0 intr mask   0x100000
rlm show port-id 0 intr-status
```

**预期**：`INTR_STS_MASK_0=0x100000`；即使故障触发 `INTR_STS_0` 置位，上报被屏蔽。

#### TC-INTR-03 — 全范围使能/屏蔽/清零

```
rlm set port-id 0 intr enable 0x1FFFFFFF
rlm show port-id 0 intr-status
rlm set port-id 0 intr mask   0x1FFFFFFF
rlm show port-id 0 intr-status
rlm set port-id 0 intr enable 0x0
rlm set port-id 0 intr mask   0x0
```

**预期**：enable/mask 全 1 → 再全 0；状态寄存器位与设置一致。

#### TC-INTR-04 — 故障触发中断状态

```
rlm set  port-id 0 enable
rlm set  port-id 0 intr enable 0x1F00000
rlm set  port-id 0 intr mask   0x0
rlm set  port-id 0 test force-fault rx lane-mask 0xFF assert
rlm show port-id 0 intr-status
rlm show port-id 0 fault-lane-status
rlm set  port-id 0 test force-fault rx lane-mask 0xFF deassert
rlm set  port-id 0 intr enable 0x0
```

**预期**：全部 lane 故障 → `INTR_STS_0` 对应 `RLM_RX_LINK_DOWN` / `RLM_RX_REDUCE_INTR` 位被硬件置位；`fault-lane-status` 全 FAULT。

---

## 8. 复位用例

#### TC-RST-01 — PCS TX 复位

```
rlm set  port-id 0 enable
rlm show port-id 0 fsm
rlm set  port-id 0 reset pcs-tx lane-mask 0x01 assert
rlm show port-id 0 reset-status
rlm show port-id 0 fsm
rlm set  port-id 0 reset pcs-tx lane-mask 0x01 deassert
rlm show port-id 0 reset-status
```

**预期**：assert 后 `CFG_RLM_RST.PCS_TX SEL=0x01 VAL=0x01`；PCS TX 复位使 TX FSM → INIT(0)；deassert 后 `VAL=0x00`。

#### TC-RST-02 — PCS RX 复位

```
rlm set port-id 0 reset pcs-rx lane-mask 0x02 assert
rlm show port-id 0 reset-status
rlm set port-id 0 reset pcs-rx lane-mask 0x02 deassert
```

**预期**：`PCS_RX SEL=0x02`，assert `VAL=0x02` / deassert `VAL=0x00`；RX FSM 被复位。

#### TC-RST-03 — SDS TX 复位（FSM 不变）

```
rlm set  port-id 0 enable
rlm show port-id 0 fsm
rlm set  port-id 0 reset sds-tx lane-mask 0xFF assert
rlm show port-id 0 reset-status
rlm show port-id 0 fsm
rlm set  port-id 0 reset sds-tx lane-mask 0xFF deassert
```

**预期**：`SDS_TX SEL=0xFF VAL=0xFF`；Serdes 数据流停止，**FSM 状态保持不变**。

#### TC-RST-04 — SDS RX 复位

```
rlm set port-id 0 reset sds-rx lane-mask 0xFF assert
rlm show port-id 0 reset-status
rlm set port-id 0 reset sds-rx lane-mask 0xFF deassert
```

**预期**：`SDS_RX SEL=0xFF`；行为同 SDS TX（数据流停止、FSM 不变）。

#### TC-RST-05 — PCS 与 SDS 复位差异对比

```
rlm set port-id 0 reset pcs-tx lane-mask 0x01 assert
rlm show port-id 0 fsm
rlm set port-id 0 reset pcs-tx lane-mask 0x01 deassert
rlm set port-id 0 reset sds-tx lane-mask 0x01 assert
rlm show port-id 0 fsm
rlm set port-id 0 reset sds-tx lane-mask 0x01 deassert
```

**预期**：对同一 lane：PCS TX 复位 → TX FSM 归 INIT；SDS TX 复位 → TX FSM 不变。验证"PCS 复位影响 FSM、SDS 复位不影响 FSM"。

---

## 9. 错误与边界用例

| 用例 | 命令 | 预期 |
|------|------|------|
| TC-ERR-01 不支持速率 | 端口为 100GR1 时 `rlm set port-id 0 enable` | CLI 读取速率后报错：`Error: current speed 100GR1 is not supported by RLM enable.` + `Supported RLM enable speeds: 800GR8, 400GR4, 200GR2`；**不访问寄存器**，`CFG_RLM` 不变 |
| TC-ERR-02 非法起始 channel | `rlm set pipe 0 channel 1 enable` | 起始 channel 必须为偶通道且与速率占用位匹配；硬件层 `rlm_bypass_bit_get` 校验不通过返回 `GT_E_PARAM`（若该 channel 先被识别为不支持速率，则 CLI 先报"not supported"） |
| TC-ERR-03 am-period 越界 | `rlm set port-id 0 am-period 9` | `Failed to set AM_PERIOD (must be 0-8)`；寄存器不变 |
| TC-ERR-04 reset 类型越界 | 通过 pipe 形式传入非法 type | `Error: reset type must be 0-3 (pcs-tx/pcs-rx/sds-tx/sds-rx)` |
| TC-ERR-05 lane-mask=0 | `rlm set port-id 0 loopback lane-mask 0x0 enable` | 掩码为 0 时底层 API 视为 no-op 直接返回成功，寄存器不变 |
| TC-ERR-06 port-mask=0 | `rlm set port-id 0 bypass port-mask 0x0 enable` | 同 TC-ERR-05，no-op 成功 |
| TC-ERR-07 直写保留位 | `reg write ... reg-id 7561 value 0xFFFFFFFFFFFFFFFF` | 读回确认哪些位可写；未定义位应保持不变/回读为 0，并记录；测试后按原始 raw 恢复 |
| TC-ERR-08 读越界 reg-id | `reg read module-id 104 instance-id 0x00000000 reg-id 65535` | 读失败返回错误；不得导致挂死 |
| TC-ERR-09 多 pipe 越界 | `rlm show port-id 511 config`（若无该 pipe） | 端口速率读取失败 → `Error: get port speed type failed ...` |
| TC-ERR-10 CRC 阈值边界 | `rlm set port-id 0 crc-check enable err-th 31` / `err-th 0` | `ERR_TH=31`（5bit 上限）/ `0`；越界由 CLI 参数范围拦截 |

**PASS 判定**：错误路径给出明确提示且不产生寄存器副作用；边界值写读一致。

---

## 10. LLR + RLM 联合用例

#### TC-COMB-01 — LLR + RLM 基础导通

```
llr set  port-id 0 cfg enable
rlm set  port-id 0 enable
rlm show port-id 0 status
llr show port-id 0 status
```
**预期**：两者均使能成功；发流无丢包；RLM status RX Link UP。

#### TC-COMB-02 — 仅 RLM（无 LLR）

```
llr set port-id 0 cfg disable
rlm set port-id 0 enable
```
**预期**：RLM 独立工作，不依赖 LLR；流量正常。

#### TC-COMB-03 — RLM 缩减过程中 LLR 状态

```
llr set port-id 0 cfg enable
rlm set port-id 0 enable
rlm set port-id 0 test force-fault rx lane-mask 0x01 assert
rlm show port-id 0 fsm
llr show port-id 0 status
rlm set port-id 0 test force-fault rx lane-mask 0x01 deassert
```
**预期**：缩减后 LLR 保持 enable；剩余 lane 流量正常，无死锁。

#### TC-COMB-04 — 反复震荡稳定性

```
llr set port-id 0 cfg enable
rlm set port-id 0 enable
for i in 1 2 ... 100; do
  rlm set port-id 0 test force-fault rx lane-mask 0x01 assert
  sleep 0.05
  rlm set port-id 0 test force-fault rx lane-mask 0x01 deassert
  sleep 0.05
done
rlm show port-id 0 fsm
rlm show port-id 0 counter
llr show port-id 0 status
rlm show port-id 0 config
```
**预期**：100 次震荡后 RLM/LLR 均正常；FSM 最终 LOCK/INIT；配置寄存器未被破坏；无死锁。

#### TC-COMB-05 — 带宽对比

分别测 LLR-only / RLM-only / LLR+RLM 三场景吞吐量；对 800GR8 全宽与缩减（4 lane 故障）分别测量。
**预期**：
| 场景 | 预期带宽 |
|------|---------|
| 800GR8 全宽 | ~800Gbps |
| 缩减到 4 lane | ~400Gbps |
| 200GR2 全宽 | ~200Gbps |
| 200GR2 减到 1 lane | ~100Gbps |

带宽按剩余 lane 数线性下降；RLM 自身不额外占用带宽。

---

## 附录 A — 命令速查表

### SET 命令

```
# 使能/禁能（速率自动识别，无需速率参数）
rlm set port-id <0-511> enable
rlm set port-id <0-511> disable

# 环回 / 旁路
rlm set port-id <0-511> loopback   lane-mask HEX<0-FF> {enable|disable}
rlm set port-id <0-511> bypass     port-mask HEX<0-F>  {enable|disable}

# 复位
rlm set port-id <0-511> reset {pcs-tx|pcs-rx|sds-tx|sds-rx} lane-mask HEX<0-FF> {assert|deassert}

# 中断（整寄存器写入）
rlm set port-id <0-511> intr enable HEX<0-1FFFFFFF>
rlm set port-id <0-511> intr mask   HEX<0-1FFFFFFF>

# 配置寄存器
rlm set port-id <0-511> tx-afifo-th      INTEGER<0-15>
rlm set port-id <0-511> fault-sds-lane   tx-mask HEX<0-FF> rx-mask HEX<0-FF>
rlm set port-id <0-511> lane-swap        tx HEX<0-FFFFFF> rx HEX<0-FFFFFF>
rlm set port-id <0-511> am-period        INTEGER<0-8>
rlm set port-id <0-511> sds-tx-vld       down INTEGER<0-31> up INTEGER<0-31>
rlm set port-id <0-511> lane-lock        cmp-num INTEGER<0-31> mismatch INTEGER<0-31>
rlm set port-id <0-511> sds-fault-mask   sigdet HEX<0-FF> rxd-vld HEX<0-FF> cpld HEX<0-FF> txc-vld HEX<0-FF>
rlm set port-id <0-511> rx-ue-fault-th   INTEGER<0-31>
rlm set port-id <0-511> crc-check {disable|enable} err-th INTEGER<0-31>

# 故障注入
rlm set port-id <0-511> test force-fault {rx|tx} lane-mask HEX<0-FF> {assert|deassert}

# 以上所有 SET 均有等价形式:
rlm set pipe <0-63> channel <0-7> <sub-cmd> ...
```

### SHOW 命令

```
rlm show port-id <0-511> status
rlm show port-id <0-511> fsm
rlm show port-id <0-511> counter
rlm show port-id <0-511> config
rlm show port-id <0-511> rx-link-status
rlm show port-id <0-511> fault-lane-status
rlm show port-id <0-511> reset-status
rlm show port-id <0-511> intr-status

# 等价形式:
rlm show pipe <0-63> channel <0-7> <sub-cmd>
```

### 寄存器访问

```
reg read  module-id <M> instance-id <I> reg-id <R> [ count <N> ]
reg read  module-id <M> instance-id <I> reg-id <R> field <offset> <len>
reg write module-id <M> instance-id <I> reg-id <R> value <HEX>
reg write module-id <M> instance-id <I> reg-id <R> field <offset> <len> value <HEX>
reg show  reg-id-list   module-id <M>
reg show  field-id-list reg-id <R>
```

---

## 附录 B — 寄存器/字段速查表

| 地址 | 寄存器名 | 访问 | 字段（bitoff,len） |
|------|---------|------|-------------------|
| 0x030 | INTR_STS_0 | RWONE | 见 2.5 |
| 0x034 | INTR_STS_MASK_0 | RW | 见 2.5 |
| 0x038 | INTR_ENABLE_0 | RW | 见 2.5 |
| 0x170 | CFG_RLM | RW | EN(0,1)、LOOP_BACK_EN(1,8)、TX_AFIFO_TH(9,4,复位0xC)、BYPASS_RLM_EN(13,4) |
| 0x171 | CFG_RLM_FAULT_SDS_LANE | RW | TX_SDS_LANE_NUM(0,8)、RX_SDS_LANE_NUM(8,8) |
| 0x172 | CFG_RLM_LANE_SWAP | RW | TX_LANE0-7(0..23, 3bit/lane)、RX_LANE0-7(24..47, 3bit/lane) |
| 0x173 | CFG_RLM_AM_PERIOD | RW | VAL(0,4) |
| 0x174 | CFG_RLM_SDS_TX_VLD | RW | DOWN_CNT(0,5)、UP_CNT(5,5) |
| 0x175 | CFG_RLM_LANE_LOCK | RW | CMP_NUM_TH(0,5)、CMP_MISMATCH_TH(5,5) |
| 0x176 | CFG_RLM_SDS_FAULT_MASK | RW | SIGDET(0,8)、SDS_RXD_VLD(8,8)、CPLD_FAULT(16,8)、SDS_TXC_VLD(24,8) |
| 0x177 | CFG_RLM_RX_UE_FAULT_TH | RW | NUM(0,5) |
| 0x178 | CFG_RLM_CRC_CHECK | RW | EN(0,1)、ERR_TH(1,5) |
| 0x179 | CFG_RLM_RST | RW | PCS_TX_SEL(0,8)、PCS_TX_VAL(8,8)、PCS_RX_SEL(16,8)、PCS_RX_VAL(24,8)、SDS_TX_SEL(32,8)、SDS_TX_VAL(40,8)、SDS_RX_SEL(48,8)、SDS_RX_VAL(56,8) |
| 0x17a | RLM_RX_LINK_STATUS | R | I(0,4)（每 port 1bit） |
| 0x17b | RLM_EXCEED_DSK_CAPABILITY | RC | LANE(0,8) |
| 0x17c | RLM_SWITCH_FSM_STATUS | R | TX FSM(0,16, 2bit/lane)、RX FSM(16,16, 2bit/lane) |
| 0x17d | RLM_FAULT_LANE_STATUS | R | TX_LANE(0,8)、RX_LANE(8,8) |
| 0x18c | RLM_SWITCH_CODE_STAT_CNT | RC | TX(0,32, 4bit/lane)、RX(32,32, 4bit/lane) |
| 0x18d | RLM_RX_FAULT_CODE_STAT_CNT | RC | TX(0,32)、RX(32,32)（4bit/lane） |
| 0x18e | RLM_AM_CRC_ERROR_STAT | RC | 8bit/lane（0..63） |

---

## 附录 C — 判定准则与恢复清单

### C.1 判定准则

| 测试项 | PASS 条件 |
|--------|----------|
| 寄存器直读/直写 | 直读 raw 与 `rlm show ... config` 的 raw 一致；字段方式写读回一致 |
| enable/disable | EN 与 BYPASS_RLM_EN 端口位正确翻转；其它端口状态保持 |
| 配置寄存器 | `show config` 对应字段 = 设定值，且直读一致 |
| LANE_SWAP | 逐 lane 3bit 映射与设定一致；流量正常 |
| AM_PERIOD | VAL 字段正确，Period 映射表一致 |
| 阈值/掩码类 | 字段值与设定一致，边界值（0/上限）可写读 |
| CRC_CHECK | EN + ERR_TH 正确；超阈值触发 fault |
| loopback | `CFG_RLM bits[8:1]` 与 lane-mask 一致（勿用 show config 判定） |
| bypass | BYPASS_RLM_EN 对应位正确 |
| 中断 | INTR_ENABLE_0 / INTR_STS_MASK_0 / INTR_STS_0 正确反映 enable/mask/sts |
| FSM | 故障注入 → LOCK→SWITCH→REDUCE；恢复 → 回到 LOCK/INIT |
| 计数器 | 4bit 饱和、8bit(CRC) 饱和；RC 读后清零 |
| 复位 PCS | FSM 归 INIT |
| 复位 SDS | 数据流停止，FSM 不变 |
| 缩减/恢复 | 缩减后带宽按 lane 比例下降；恢复后回全宽 |
| 震荡 | N 次循环后状态正常，无死锁 |

### C.2 测试后恢复清单（默认/建议值）

```
rlm set port-id 0 tx-afifo-th 12
rlm set port-id 0 am-period 0
rlm set port-id 0 sds-tx-vld down 0 up 0
rlm set port-id 0 lane-lock cmp-num 0 mismatch 0
rlm set port-id 0 sds-fault-mask sigdet 0x00 rxd-vld 0x00 cpld 0x00 txc-vld 0x00
rlm set port-id 0 rx-ue-fault-th 0
rlm set port-id 0 crc-check disable err-th 0
rlm set port-id 0 lane-swap tx 0x00FAC6 rx 0x00FAC6       # 全等映射
rlm set port-id 0 fault-sds-lane tx-mask 0x00 rx-mask 0x00
rlm set port-id 0 bypass port-mask 0x0 disable
rlm set port-id 0 loopback lane-mask 0xFF disable
rlm set port-id 0 intr enable 0x0
rlm set port-id 0 intr mask   0x0
rlm set port-id 0 reset pcs-tx lane-mask 0xFF deassert
rlm set port-id 0 reset pcs-rx lane-mask 0xFF deassert
rlm set port-id 0 reset sds-tx lane-mask 0xFF deassert
rlm set port-id 0 reset sds-rx lane-mask 0xFF deassert
rlm set port-id 0 disable
```

> 直写寄存器（第 3 章）后请按读取到的原始 raw 值回写恢复。

---

*相关源文件：`cli_rlm.c` / `ql_npu_rlm.c` / `ql_npu_rlm.h`*
*寄存器定义：`ql_reg_def.h` / `ql_reg_field.h`*
*命令语法：`cli_reg.c`（reg read/write）*
