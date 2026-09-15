/* PacketDiag 核心解析与绘制（从 PacketDiagPic.html 抽取，离线可用）。
 * 对外接口：window.PacketDiag = { parse, render, presets, defaultSource }
 */
(function (global) {

  "use strict";

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.round(number)));
  }

  function normalizedColwidth(value) {
    return clampNumber(value, 1, 256, 32);
  }

  function normalizedColheight(value) {
    return clampNumber(value, 1, 12, 1);
  }


  const DEFAULT_PACKET_SOURCE = `packetdiag {
    colwidth = 32;
    node_height = 40;
    default_fontsize = 12;

    // ---- 基础头部 (Base Header: Word 0 ~ Word 7) ----

    // Word 0
    0-31: HOST_MAC;

    // Word 1
    32-47: HOST_MAC;
    48-63: NP_MAC;

    // Word 2
    64-95: NP_MAC;

    // Word 3
    96-111: "0x8100";
    112-127: VLAN;

    // Word 4
    128-143: "Ethernet Type";
    144-151: "Message Length";
    152-153: R;
    154: NS_E;
    155-159: R;

    // Word 5
    160-167: "Message Type";
    168-175: DISP_REG;
    176-179: DST_CHAIN_ID [textcolor = "red"];
    180-191: VRF [textcolor = "red"];

    // Word 6
    192-202: L2_IIF [textcolor = "red"];
    203: R;
    204-215: L2_EIF [textcolor = "red"];
    216-223: "TimeStamp[37:30]";

    // Word 7
    224: R;
    225-255: "TimeStamp[29:0]";

    // ---- 复用变体部分 (Alternatives for Word 8) ----
  
    // 变体 1: BFD上送
    256-287: "BFD Discriminator" [color = "#fce5cd"];

    // 变体 2: MOD上送
    288-311: R [color = "#fce5cd"];
    312-319: DISCARD_COUNTER_IDX [color = "#fce5cd"];

    // 变体 3: MAC地址学习
    320: VP_V [color = "#fce5cd"];
    321: R [color = "#fce5cd"];
    322-327: VP [color = "#fce5cd"];
    328-337: R [color = "#fce5cd"];
    338-351: VFI [color = "#fce5cd"];
  }`;

  const PRESETS = {
    packet: DEFAULT_PACKET_SOURCE,
    tcp: `packetdiag {
    colwidth = 32;
    node_height = 72;
    default_fontsize = 12;

    // ---- TCP Header ----
    0-15: Source Port [color = "#dbeafe"];
    16-31: Destination Port [color = "#dbeafe"];
    32-63: Sequence Number [color = "#fef3c7"];
    64-95: Acknowledgment Number [color = "#fef3c7"];
    96-99: Data Offset [color = "#dcfce7"];
    100-105: Reserved [color = "#e5e7eb"];
    106: URG [rotate = 270, color = "#fce7f3"];
    107: ACK [rotate = 270, color = "#fce7f3"];
    108: PSH [rotate = 270, color = "#fce7f3"];
    109: RST [rotate = 270, color = "#fce7f3"];
    110: SYN [rotate = 270, color = "#fce7f3"];
    111: FIN [rotate = 270, color = "#fce7f3"];
    112-127: Window [color = "#dbeafe"];
    128-143: Checksum [color = "#fee2e2"];
    144-159: Urgent Pointer [color = "#fee2e2"];
    160-191: "Options and Padding" [color = "#ede9fe"];
    192-223: data [colheight = 3, color = "#ccfbf1"];
  }`,
    ipv4: `packetdiag {
    colwidth = 32;
    node_height = 54;
    default_fontsize = 13;

    // ---- IPv4 Header ----
    0-3: Version [color = "#dbeafe"];
    4-7: IHL [color = "#dbeafe"];
    8-13: DSCP [color = "#dcfce7"];
    14-15: ECN [color = "#dcfce7"];
    16-31: Total Length [color = "#fef3c7"];
    32-47: Identification [color = "#ede9fe"];
    48-50: Flags [color = "#fef9c3"];
    51-63: Fragment Offset [color = "#fef9c3"];
    64-71: TTL [color = "#fee2e2"];
    72-79: Protocol [color = "#fee2e2"];
    80-95: Header Checksum [color = "#e5e7eb"];
    96-127: Source Address [color = "#e0f2fe"];
    128-159: Destination Address [color = "#e0f2fe"];
  }`,
    udp: `packetdiag {
    colwidth = 32;
    node_height = 60;
    default_fontsize = 13;

    // ---- UDP Header ----
    0-15: Source Port [color = "#dbeafe"];
    16-31: Destination Port [color = "#dbeafe"];
    32-47: Length [color = "#fef3c7"];
    48-63: Checksum [color = "#fee2e2"];
  }`,
    ethernet: `packetdiag {
    colwidth = 32;
    node_height = 52;
    default_fontsize = 12;

    // ---- Ethernet Frame ----
    0-7: Preamble [color = "#e5e7eb"];
    8-15: SFD [color = "#d1d5db"];
    16-63: Destination MAC [color = "#dbeafe"];
    64-111: Source MAC [color = "#dbeafe"];
    112-127: EtherType [color = "#dcfce7"];
    128-159: Payload [color = "#fef3c7"];
    160-191: FCS [color = "#fee2e2"];
  }`,
    standard: `packetdiag {
    colwidth = 32;
    node_height = 58;
    default_fontsize = 12;

    # === Demo: Full Standard PacketDiag Compatibility ===
    # This example exercises ALL standard syntax features

    # ---- Standard Field Attributes ----

    # 1. label attribute — display alias
    0-7: type [label = "Type", color = "#dbeafe"];

    # 2. number attribute — hide bit badge
    8-15: code [label = "Code", color = "#dcfce7", number = 0];

    # 3. style & shape — border and cell shape
    16-19: chksum [label = "Checksum", color = "#fef3c7", style = "dashed"];
    20-23: rsvd [label = "Reserved", color = "#ede9fe", style = "dotted"];

    # 4. description — hover tooltip
    24-31: ident [label = "Identifier", color = "#fee2e2", description = "Unique flow identifier assigned by the source"];

    # 5. shape = ellipse
    32-47: payload [label = "Payload", color = "#ccfbf1", shape = "ellipse"];

    # 6. len — variable-length field (jagged right edge)
    48-63: data [label = "Var Data", color = "#ffedd5", len = 64];

    # 7. background — override cell background
    64-79: flags [background = "#c7d2fe", label = "Flags", description = "Control flags bitmap"];

    # 8. icon & rotate
    80: F [label = "F", rotate = 270, icon = "flag"];
    81: S [label = "S", rotate = 270, icon = "sync"];
    82: R [label = "R", rotate = 270];
    83-95: unused [label = "Unused", style = "none", color = "#e5e7eb"];

    # 9. Sparse packet — gaps show dotted empty areas
    100-107: gap_fill [label = "After Gap", color = "#dbeafe"];

    # 10. scale config
    scale_direction = "left_to_right";
    scale_interval = 8;

    # ---- Description Table ----
    desctable {
      type = "Packet type identifier"
      code = "Operation code (request/response)"
      ident = "Flow identifier"
      payload = "Data payload (variable length)"
      data = "Variable-length data field"
      flags = "Control flags bitmap"
    }
  }`
  };

  "use strict";

  function parsePacketDiag(source, overrides) {
    const ov = overrides || {};
    const text = extractPacketSource(source);
    const lines = text.split(/\r?\n/);
    const config = {
      colwidth: 32,
      node_height: 72,
      default_fontsize: 12,
      bit_order: "asc",
      numbering: "global"
    };
    const sections = [];
    const descTableEntries = [];
    const warnings = [];
    let currentSection = createSection("");
    let pendingRowLabel = "";
    let pendingRowNote = "";
    let hasBody = false;
    let localRowIndex = 0;
    let inDescTable = false;
    let explicitRowMode = false;
    let currentExplicitRow = null;

    function finishSection() {
      if (currentSection.fields.length > 0 || currentSection.name) {
        sections.push(currentSection);
      }
      currentSection = createSection("");
      localRowIndex = 0;
      explicitRowMode = false;
      currentExplicitRow = null;
    }

    for (let index = 0; index < lines.length; index += 1) {
      const originalLine = lines[index];
      const comment = readLineComment(originalLine);
      let line = stripLineComment(originalLine).trim();
      let inlineLeftNote = "";

      if (line === "packetdiag {" || line === "packetdiag{" || /^@startpacketdiag\b/i.test(line)) {
        hasBody = true;
        continue;
      }

      if (line === "}" || /^@endpacketdiag\b/i.test(originalLine.trim())) {
        if (inDescTable) {
          inDescTable = false;
        }
        continue;
      }

      // desctable block
      if (/^desctable\b/i.test(line)) {
        inDescTable = true;
        hasBody = true;
        line = line.replace(/^desctable\s*\{?\s*/i, "").replace(/}\s*$/, "").trim();
        if (line === "") {
          continue;
        }
      }

      if (inDescTable) {
        let closingDescTable = false;
        if (line.endsWith("}")) {
          line = line.slice(0, -1).trim();
          closingDescTable = true;
        }
        const dtMatch = line.match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/);
        if (dtMatch) {
          descTableEntries.push({
            label: dtMatch[1],
            description: parseValue(dtMatch[2].replace(/;\s*$/, ""))
          });
        }
        if (closingDescTable) {
          inDescTable = false;
        }
        continue;
      }

      if (comment) {
        const leftNote = parseLeftNote(comment);
        const atRowLabel = parseAtRow(comment);
        const sectionName = (!leftNote && atRowLabel === null) ? parseSectionComment(comment) : "";

        if (atRowLabel !== null) {
          localRowIndex += 1;
          explicitRowMode = true;
          currentExplicitRow = localRowIndex;
          pendingRowLabel = atRowLabel || "";
        } else if (leftNote && line === "") {
          pendingRowNote = appendNote(pendingRowNote, leftNote);
        } else if (leftNote) {
          inlineLeftNote = leftNote;
        } else if (sectionName) {
          finishSection();
          currentSection.name = sectionName;
        } else if (line === "" && isUsefulRowLabel(comment)) {
          pendingRowLabel = comment;
        }
      }

      if (line === "") {
        continue;
      }

      const configMatch = line.match(/^([A-Za-z_]\w*)\s*=\s*(.+?)\s*;?$/);
      if (configMatch) {
        const key = configMatch[1];
        const value = parseValue(configMatch[2]);
        config[key] = value;
        continue;
      }

      const field = parseFieldLine(line, index + 1);
      if (field) {
        const numbering = config.numbering === "local" ? "local" : "global";
        const colW = normalizedColwidth(config.colwidth);
        let rowIndex;
        if (numbering === "local") {
          rowIndex = localRowIndex;
        } else if (explicitRowMode && currentExplicitRow !== null) {
          rowIndex = currentExplicitRow;
          field.explicitRow = true;
        } else {
          rowIndex = Math.floor(field.start / colW);
          field.explicitRow = false;
        }
        field.visualRowIndex = rowIndex;

        if (pendingRowLabel && !currentSection.rowLabels.has(rowIndex)) {
          currentSection.rowLabels.set(rowIndex, pendingRowLabel);
        }
        const rowNote = appendNote(pendingRowNote, inlineLeftNote);
        if (rowNote) {
          currentSection.rowNotes.set(rowIndex, appendNote(currentSection.rowNotes.get(rowIndex) || "", rowNote));
        }
        pendingRowLabel = "";
        pendingRowNote = "";
        currentSection.fields.push(field);
        hasBody = true;
        continue;
      }

      throw new Error(`第 ${index + 1} 行无法解析: ${line}`);
    }

    finishSection();

    const nonEmptySections = sections.filter((section) => section.fields.length > 0);
    if (!hasBody && descTableEntries.length === 0) {
      return { config: sanitizeConfig(config, warnings), sections: [], fields: [], descTable: [], warnings };
    }

    const safeConfig = sanitizeConfig(config, warnings);
    if (ov.numbering) safeConfig.numbering = ov.numbering;
    if (ov.bit_order) safeConfig.bit_order = ov.bit_order;
    return {
      config: safeConfig,
      sections: nonEmptySections.map((section) => buildSectionRows(section, safeConfig)),
      fields: nonEmptySections.flatMap((section) => section.fields),
      descTable: buildDescTable(sections, descTableEntries),
      warnings
    };
  }

  function fieldBitRange(field) {
    return `${field.start}${field.start === field.end ? "" : `-${field.end}`}`;
  }

  function findFieldForDescKey(fields, key) {
    const keyLower = String(key).toLowerCase();
    return fields.find((field) => {
      const displayLabel = field.options.label || field.label;
      return field.label.toLowerCase() === keyLower || String(displayLabel).toLowerCase() === keyLower;
    });
  }

  function fieldRowNumber(field) {
    if (field && Number.isInteger(field.visualRowIndex)) {
      return field.visualRowIndex + 1;
    }
    return null;
  }

  function enrichDescEntry(entry, field) {
    if (!field) {
      return entry;
    }
    const enriched = { ...entry };
    if (!enriched.bitRange) {
      enriched.bitRange = fieldBitRange(field);
    }
    if (enriched.rowNumber === undefined || enriched.rowNumber === null) {
      enriched.rowNumber = fieldRowNumber(field);
    }
    return enriched;
  }

  function buildDescTable(sections, explicitEntries) {
    const allFields = sections.flatMap((section) => section.fields);
    const entries = explicitEntries.map((entry) => {
      const field = findFieldForDescKey(allFields, entry.label);
      return enrichDescEntry(entry, field);
    });
    const seenLabels = new Set(entries.map((e) => e.label.toLowerCase()));

    for (const section of sections) {
      for (const field of section.fields) {
        const displayLabel = field.options.label || field.label;
        const desc = field.options.description;
        const bitRange = fieldBitRange(field);
        const rowNumber = fieldRowNumber(field);
        const keys = new Set([field.label.toLowerCase(), String(displayLabel).toLowerCase()]);

        const existing = entries.find((e) => keys.has(e.label.toLowerCase()));
        if (existing) {
          if (!existing.bitRange) {
            existing.bitRange = bitRange;
          }
          if (existing.rowNumber === undefined || existing.rowNumber === null) {
            existing.rowNumber = rowNumber;
          }
          if (desc && !existing.description) {
            existing.description = String(desc);
          }
          continue;
        }

        if (desc && !seenLabels.has(String(displayLabel).toLowerCase())) {
          entries.push({
            label: displayLabel,
            description: String(desc),
            bitRange,
            rowNumber
          });
          seenLabels.add(String(displayLabel).toLowerCase());
        }
      }
    }

    return entries;
  }

  function createSection(name) {
    return {
      name,
      fields: [],
      rowLabels: new Map(),
      rowNotes: new Map()
    };
  }

  function extractPacketSource(source) {
    const fence = source.match(/```(?:packetdiag)?\s*([\s\S]*?)```/i);
    let text = fence ? fence[1].trim() : source.trim();
    text = text.replace(/^@startpacketdiag[^\n]*\n?/im, "").replace(/^@endpacketdiag[^\n]*/im, "").trim();
    return text;
  }

  function readLineComment(line) {
    const index = findCommentIndex(line);
    if (index < 0) return "";
    const skip = line[index] === "#" ? 1 : 2;
    return line.slice(index + skip).trim();
  }

  function stripLineComment(line) {
    const index = findCommentIndex(line);
    return index >= 0 ? line.slice(0, index) : line;
  }

  function findCommentIndex(line) {
    let quote = "";
    let slashIndex = -1;
    let hashIndex = -1;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (quote) {
        if (char === "\\" && i + 1 < line.length) {
          i += 1;
        } else if (char === quote) {
          quote = "";
        }
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "/" && i + 1 < line.length && line[i + 1] === "/" && slashIndex < 0) {
        slashIndex = i;
      }
      if (char === "#" && hashIndex < 0) {
        hashIndex = i;
      }
    }
    if (slashIndex >= 0 && hashIndex >= 0) return Math.min(slashIndex, hashIndex);
    return slashIndex >= 0 ? slashIndex : hashIndex;
  }

  function parseSectionComment(comment) {
    const match = comment.match(/^-{2,}\s*(.+?)\s*-{2,}$/);
    if (!match) {
      return "";
    }
    return match[1].trim();
  }

  function isUsefulRowLabel(comment) {
    return /^(变体|variant|alternative)\b/i.test(comment.trim());
  }

  function parseLeftNote(comment) {
    const match = comment.match(/^@left\s*:\s*(.+)$/i);
    return match ? match[1].trim() : "";
  }

  function parseAtRow(comment) {
    const match = comment.match(/^@row\s*:?\s*(.*)$/i);
    if (!match) return null;
    return match[1].trim();
  }

  function appendNote(current, next) {
    const cleanNext = String(next || "").trim();
    if (!cleanNext) {
      return current || "";
    }
    return current ? `${current}\n${cleanNext}` : cleanNext;
  }

  function parseValue(rawValue) {
    const clean = rawValue.trim().replace(/;$/, "").trim();
    const unquoted = unwrapQuotes(clean);
    if (/^-?\d+(?:\.\d+)?$/.test(unquoted)) {
      return Number(unquoted);
    }
    return unquoted;
  }

  function parseFieldLine(line, lineNumber) {
    const match = line.match(/^(\d+)(?:\s*-\s*(\d+))?\s*:\s*(.+?)\s*;?$/);
    if (!match) {
      return null;
    }

    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (end < start) {
      throw new Error(`第 ${lineNumber} 行 bit 范围结束值小于开始值`);
    }

    const labelAndOptions = splitLabelAndOptions(match[3].replace(/;$/, "").trim());
    if (!labelAndOptions.label) {
      throw new Error(`第 ${lineNumber} 行缺少字段名称`);
    }

    return {
      id: `${lineNumber}:${start}-${end}`,
      start,
      end,
      label: unwrapQuotes(labelAndOptions.label),
      options: labelAndOptions.options,
      lineNumber,
      sourceLine: line
    };
  }

  function splitLabelAndOptions(input) {
    let text = input.trim();
    const options = {};

    if (text.endsWith("]")) {
      const start = findTrailingOptionStart(text);
      if (start >= 0) {
        const rawOptions = text.slice(start + 1, -1).trim();
        if (/[A-Za-z_]\w*\s*=/.test(rawOptions)) {
          Object.assign(options, parseOptions(rawOptions));
          text = text.slice(0, start).trim();
        }
      }
    }

    return { label: text, options };
  }

  function findTrailingOptionStart(text) {
    let quote = "";
    let depth = 0;
    for (let i = text.length - 1; i >= 0; i -= 1) {
      const char = text[i];
      if (quote) {
        if (char === quote && text[i - 1] !== "\\") {
          quote = "";
        }
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "]") {
        depth += 1;
        continue;
      }
      if (char === "[") {
        depth -= 1;
        if (depth === 0) {
          return i;
        }
      }
    }
    return -1;
  }

  function parseOptions(rawOptions) {
    const options = {};
    const regex = /([A-Za-z_]\w*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\]\s]+))/g;
    let match;
    while ((match = regex.exec(rawOptions)) !== null) {
      const key = match[1];
      const value = match[2] ?? match[3] ?? match[4] ?? "";
      options[key] = /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
    }
    return options;
  }

  function unwrapQuotes(value) {
    const clean = String(value).trim();
    if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
      return clean.slice(1, -1);
    }
    return clean;
  }

  function sanitizeConfig(config, warnings = []) {
    let bitOrder = normalizeBitOrder(config.bit_order, warnings);

    if (config.scale_direction !== undefined) {
      const sd = String(config.scale_direction).trim().toLowerCase();
      if (sd === "right_to_left") {
        bitOrder = "desc";
      } else if (sd === "left_to_right") {
        bitOrder = "asc";
      } else {
        warnings.push(`scale_direction = "${config.scale_direction}" 无效，已忽略`);
      }
    }

    return {
      colwidth: normalizedColwidth(config.colwidth),
      node_height: clampNumber(config.node_height, 28, 180, 72),
      default_fontsize: clampNumber(config.default_fontsize, 8, 28, 12),
      bit_order: bitOrder,
      numbering: normalizeNumbering(config.numbering, warnings),
      scale_interval: Math.max(1, Math.min(64, parseInt(config.scale_interval, 10) || 8))
    };
  }

  function normalizeNumbering(value, warnings = []) {
    if (value === undefined || value === null || value === "") {
      return "global";
    }
    const mode = String(value).trim().toLowerCase();
    if (mode === "global" || mode === "local") {
      return mode;
    }
    warnings.push(`numbering = "${value}" 无效，已按 global 渲染`);
    return "global";
  }

  function normalizeBitOrder(value, warnings = []) {
    if (value === undefined || value === null || value === "") {
      return "asc";
    }
    const bitOrder = String(value).trim().toLowerCase();
    if (bitOrder === "asc" || bitOrder === "desc") {
      return bitOrder;
    }
    warnings.push(`bit_order = "${value}" 无效，已按 asc 渲染`);
    return "asc";
  }

  function buildSectionRows(section, config) {
    const colwidth = config.colwidth;
    const rowsByIndex = new Map();
    const fragmentsByField = new Map();

    const numbering = config.numbering === "local" ? "local" : "global";

    for (const field of section.fields) {
      let fragments;

      if (numbering === "local") {
        if (field.end >= colwidth) {
          throw new Error(
            `字段 "${field.label}" 的位范围 ${field.start}-${field.end} 超出 colwidth (${colwidth})。` +
            `在 numbering="local" 模式下，每行位号必须 < colwidth。`
          );
        }
        const rowIndex = field.visualRowIndex;
        const fragment = {
          field,
          rowIndex,
          start: field.start,
          end: field.end,
          colStart: field.start,
          colEnd: field.end,
          drawLabel: false
        };
        fragments = [fragment];

        if (!rowsByIndex.has(rowIndex)) {
          rowsByIndex.set(rowIndex, {
            index: rowIndex,
            label: section.rowLabels.get(rowIndex) || "",
            note: section.rowNotes.get(rowIndex) || "",
            fragments: []
          });
        }
        rowsByIndex.get(rowIndex).fragments.push(fragment);
      } else if (field.explicitRow) {
        const rowIdx = field.visualRowIndex;
        const rowStartBit = Math.floor(field.start / colwidth) * colwidth;
        const fragment = {
          field,
          rowIndex: rowIdx,
          start: field.start,
          end: field.end,
          colStart: field.start - rowStartBit,
          colEnd: field.end - rowStartBit,
          drawLabel: false
        };
        fragments = [fragment];

        if (!rowsByIndex.has(rowIdx)) {
          rowsByIndex.set(rowIdx, {
            index: rowIdx,
            label: section.rowLabels.get(rowIdx) || "",
            note: section.rowNotes.get(rowIdx) || "",
            fragments: []
          });
        }
        rowsByIndex.get(rowIdx).fragments.push(fragment);
      } else {
        const firstRow = Math.floor(field.start / colwidth);
        const lastRow = Math.floor(field.end / colwidth);
        fragments = [];

        for (let rowIdx = firstRow; rowIdx <= lastRow; rowIdx += 1) {
          const rowStartBit = rowIdx * colwidth;
          const fragmentStart = Math.max(field.start, rowStartBit);
          const fragmentEnd = Math.min(field.end, rowStartBit + colwidth - 1);
          const fragment = {
            field,
            rowIndex: rowIdx,
            start: fragmentStart,
            end: fragmentEnd,
            colStart: fragmentStart - rowStartBit,
            colEnd: fragmentEnd - rowStartBit,
            drawLabel: false
          };
          fragments.push(fragment);

          if (!rowsByIndex.has(rowIdx)) {
            rowsByIndex.set(rowIdx, {
              index: rowIdx,
              label: section.rowLabels.get(rowIdx) || "",
              note: section.rowNotes.get(rowIdx) || "",
              fragments: []
            });
          }
          rowsByIndex.get(rowIdx).fragments.push(fragment);
        }
      }

      fragmentsByField.set(field.id, fragments);
    }

    for (const fragments of fragmentsByField.values()) {
      let labelFragment = fragments[0];
      for (const fragment of fragments) {
        if (fragment.end - fragment.start > labelFragment.end - labelFragment.start) {
          labelFragment = fragment;
        }
      }
      labelFragment.drawLabel = true;
    }

    const rows = [...rowsByIndex.values()].sort((a, b) => a.index - b.index);
    for (const row of rows) {
      row.fragments.sort((a, b) => a.start - b.start || a.end - b.end);
    }

    return {
      name: section.name,
      rows
    };
  }

  function renderDiagram(parsed, canvas, options = {}) {
    const ctx = canvas.getContext("2d");
    const config = parsed.config;
    const pixelRatio = options.pixelRatio || window.devicePixelRatio || 1;
    const fitWidth = options.fitWidth ?? true;
    const requestedWidth = options.width || 980;
    const bitOrder = options.bitOrder === "desc" ? "desc" : "asc";
    const globalNote = String(options.globalNote || "").trim();
    const colwidth = config.colwidth;
    const nodeHeight = config.node_height;
    const fontSize = config.default_fontsize;
    const leftPad = 32;
    const rightPad = 32;
    const topPad = 28;
    const bottomPad = 28;
    const noteWidth = 220;
    const rowLabelWidth = 120;
    const leftGutter = noteWidth + rowLabelWidth;
    const minBitWidth = 12;
    const maxCanvasWidth = fitWidth ? requestedWidth : Math.max(requestedWidth, 1040);
    const diagramWidth = Math.max(colwidth * minBitWidth, maxCanvasWidth - leftPad - rightPad - leftGutter);
    const canvasWidth = Math.ceil(leftPad + leftGutter + diagramWidth + rightPad);
    const sectionGap = 28;
    const rulerHeight = 30;
    const rowGap = 12;
    const sectionTitleHeight = 28;
    const rowCaptionHeight = 18;
    const bitWidth = diagramWidth / colwidth;
    const noteLineHeight = 15;

    ctx.font = '12px "Segoe UI", system-ui, sans-serif';
    const globalNoteLines = wrapTextLines(ctx, globalNote, noteWidth - 12, 10);
    const globalNoteHeight = globalNoteLines.length > 0 ? 22 + globalNoteLines.length * noteLineHeight : 0;
    const sectionLayouts = parsed.sections.map((section) => ({
      section,
      rows: section.rows.map((row) => {
        const noteLines = wrapTextLines(ctx, row.note || "", noteWidth - 12, 8);
        return {
          row,
          noteLines,
          height: Math.max(rowHeight(row, nodeHeight), noteLines.length * noteLineHeight + 10)
        };
      })
    }));

    const descTableBlockHeight = measureDescTableHeight(parsed.descTable);
    let canvasHeight = topPad + bottomPad + globalNoteHeight + (globalNoteHeight > 0 ? 18 : 0);
    for (const layout of sectionLayouts) {
      if (layout.section.name) {
        canvasHeight += sectionTitleHeight;
      }
      canvasHeight += rulerHeight;
      for (const rowLayout of layout.rows) {
        canvasHeight += rowCaptionHeight + rowLayout.height + rowGap;
      }
      canvasHeight += sectionGap;
    }
    if (descTableBlockHeight > 0) {
      canvasHeight += descTableBlockHeight;
    }
    canvasHeight = Math.max(260, Math.ceil(canvasHeight));

    canvas.width = Math.ceil(canvasWidth * pixelRatio);
    canvas.height = Math.ceil(canvasHeight * pixelRatio);
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const hitBoxes = [];
    let y = topPad;

    if (globalNoteLines.length > 0) {
      drawNoteBlock(ctx, "全局注释", globalNoteLines, leftPad, y, noteWidth, globalNoteHeight);
      y += globalNoteHeight + 18;
    }

    if (parsed.sections.length === 0 && (!parsed.descTable || parsed.descTable.length === 0)) {
      drawEmptyState(ctx, canvasWidth, canvasHeight, y);
      canvas._hitBoxes = [];
      return { width: canvasWidth, height: canvasHeight, hitBoxes };
    }

    if (parsed.sections.length === 0 && parsed.descTable && parsed.descTable.length > 0) {
      y = drawDescTable(ctx, parsed.descTable, leftPad, y + 16, canvasWidth - leftPad - rightPad, fontSize);
      canvas._hitBoxes = [];
      return { width: canvasWidth, height: canvasHeight, hitBoxes };
    }

    for (const layout of sectionLayouts) {
      const section = layout.section;
      const noteX = leftPad;
      const labelX = leftPad + noteWidth;
      const gridX = leftPad + leftGutter;

      if (section.name) {
        drawSectionTitle(ctx, section.name, leftPad, y, canvasWidth - leftPad - rightPad, sectionTitleHeight, fontSize);
        y += sectionTitleHeight;
      }

      drawRuler(ctx, gridX, y, diagramWidth, colwidth, bitWidth, bitOrder, config.scale_interval);
      y += rulerHeight;

      for (const rowLayout of layout.rows) {
        const row = rowLayout.row;
        const rowBitStart = row.fragments.length > 0
          ? Math.min(...row.fragments.map((fragment) => fragment.start))
          : row.index * colwidth;
        const rowBitEnd = row.fragments.length > 0
          ? Math.max(...row.fragments.map((fragment) => fragment.end))
          : row.index * colwidth + colwidth - 1;
        const bitRange = config.numbering === "local" ? `0-${colwidth - 1}` : `${rowBitStart}-${rowBitEnd}`;
        const caption = row.label || `Row ${row.index + 1}  ${bitRange}`;
        const actualRowHeight = rowLayout.height;
        drawRowCaption(ctx, caption, labelX, y + rowCaptionHeight, rowLabelWidth - 12);
        y += rowCaptionHeight;

        drawRowNote(ctx, rowLayout.noteLines, noteX, y, noteWidth, actualRowHeight);
        drawRowGrid(ctx, gridX, y, diagramWidth, actualRowHeight, colwidth, bitWidth, config.scale_interval);

        for (const fragment of row.fragments) {
          const field = fragment.field;
          const x = fragmentX(gridX, fragment, colwidth, bitWidth, bitOrder);
          const w = Math.max(1.5, (fragment.colEnd - fragment.colStart + 1) * bitWidth);
          const h = Math.min(actualRowHeight, nodeHeight * normalizedColheight(field.options.colheight));
          const color = field.options.color || defaultColorFor(field.label);
          drawCell(ctx, fragment, x, y, w, h, color, fontSize);
          hitBoxes.push({ x, y, w, h, fragment });
        }

        // Sparse packet: draw indicator for uncovered bit ranges
        drawSparseGaps(ctx, row, gridX, y, actualRowHeight, colwidth, bitWidth, bitOrder);

        y += actualRowHeight + rowGap;
      }

      y += sectionGap;
    }

    // Description table
    if (parsed.descTable && parsed.descTable.length > 0) {
      y += 12;
      y = drawDescTable(ctx, parsed.descTable, leftPad, y, canvasWidth - leftPad - rightPad, fontSize);
    }

    canvas._hitBoxes = hitBoxes;
    return { width: canvasWidth, height: canvasHeight, hitBoxes };
  }

  function fragmentX(gridX, fragment, colwidth, bitWidth, bitOrder) {
    if (bitOrder === "desc") {
      return gridX + (colwidth - 1 - fragment.colEnd) * bitWidth;
    }
    return gridX + fragment.colStart * bitWidth;
  }

  function rowHeight(row, nodeHeight) {
    return Math.max(...row.fragments.map((fragment) => nodeHeight * normalizedColheight(fragment.field.options.colheight)), nodeHeight);
  }

  function drawEmptyState(ctx, width, height, top = 0) {
    ctx.fillStyle = "#f8faf9";
    ctx.fillRect(0, top, width, height - top);
    ctx.fillStyle = "#65726a";
    ctx.font = '600 16px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("输入 PacketDiag 源码后会在这里显示图片", width / 2, top + (height - top) / 2);
    ctx.textAlign = "start";
  }

  function drawSectionTitle(ctx, text, x, y, width, height, fontSize) {
    ctx.fillStyle = "#202321";
    roundRect(ctx, x, y, width, height, 5);
    ctx.fill();
    ctx.fillStyle = "#f4fbf7";
    ctx.font = `700 ${Math.max(12, fontSize + 1)}px "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + 12, y + height / 2);
  }

  function drawRuler(ctx, x, y, width, colwidth, bitWidth, bitOrder, scaleInterval) {
    const interval = scaleInterval || 8;
    ctx.strokeStyle = "#9aa49d";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + 22.5);
    ctx.lineTo(x + width, y + 22.5);
    ctx.stroke();

    ctx.fillStyle = "#49524b";
    ctx.font = '11px "Cascadia Mono", Consolas, monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    const marks = buildRulerMarks(colwidth, interval);
    drawRulerTick(ctx, x, y, "start");
    drawRulerTick(ctx, x + width, y, "start");
    for (const mark of marks) {
      if (mark >= colwidth) {
        continue;
      }
      const markX = bitOrder === "desc" ? x + (colwidth - 1 - mark) * bitWidth : x + mark * bitWidth;
      const isMajor = mark % interval === 0 || mark === colwidth - 1;
      drawRulerTick(ctx, markX, y, isMajor ? "major" : "minor");
      if (isMajor) {
        ctx.fillText(String(mark), markX, y + 10);
      }
    }

    ctx.textAlign = "start";
  }

  function drawRulerTick(ctx, x, y, kind) {
    const isMajor = kind !== "minor";
    ctx.strokeStyle = isMajor ? "#6b746d" : "#c8cec9";
    ctx.beginPath();
    ctx.moveTo(x + 0.5, y + (isMajor ? 4 : 12));
    ctx.lineTo(x + 0.5, y + 23);
    ctx.stroke();
  }

  function buildRulerMarks(colwidth, scaleInterval) {
    const interval = scaleInterval || 8;
    const marks = new Set([0, colwidth]);
    for (let bit = interval; bit < colwidth; bit += interval) {
      marks.add(bit);
    }
    marks.add(colwidth - 1);
    return [...marks].sort((a, b) => a - b);
  }

  function drawRowCaption(ctx, text, x, y, maxWidth) {
    ctx.fillStyle = "#5e6961";
    ctx.font = '12px "Cascadia Mono", Consolas, monospace';
    ctx.textBaseline = "alphabetic";
    ctx.fillText(fitText(ctx, text, maxWidth), x, y - 4);
  }

  function drawNoteBlock(ctx, title, lines, x, y, width, height) {
    ctx.fillStyle = "#f6faf7";
    roundRect(ctx, x, y, width, height, 6);
    ctx.fill();
    ctx.strokeStyle = "#d8e1dc";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#304138";
    ctx.font = '700 12px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = "alphabetic";
    ctx.fillText(title, x + 10, y + 15);
    drawWrappedLines(ctx, lines, x + 10, y + 35, 15, "#51645a");
  }

  function drawRowNote(ctx, lines, x, y, width, height) {
    if (lines.length === 0) {
      return;
    }
    ctx.fillStyle = "#f8fbf9";
    roundRect(ctx, x, y, width - 12, height, 5);
    ctx.fill();
    ctx.strokeStyle = "#dbe3de";
    ctx.lineWidth = 1;
    ctx.stroke();
    drawWrappedLines(ctx, lines, x + 9, y + 16, 15, "#4d5e55");
  }

  function drawWrappedLines(ctx, lines, x, y, lineHeight, color) {
    ctx.fillStyle = color;
    ctx.font = '12px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = "alphabetic";
    for (let i = 0; i < lines.length; i += 1) {
      ctx.fillText(lines[i], x, y + i * lineHeight);
    }
  }

  function drawRowGrid(ctx, x, y, width, height, colwidth, bitWidth, scaleInterval) {
    const interval = scaleInterval || 8;
    ctx.fillStyle = "#fbfcfb";
    ctx.strokeStyle = "#d9dfdb";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, width, height);

    ctx.strokeStyle = "#edf0ed";
    ctx.beginPath();
    for (let bit = 1; bit < colwidth; bit += 1) {
      const lineX = x + bit * bitWidth;
      ctx.moveTo(lineX + 0.5, y);
      ctx.lineTo(lineX + 0.5, y + height);
    }
    ctx.stroke();

    ctx.strokeStyle = "#c7cec8";
    ctx.beginPath();
    for (let bit = interval; bit < colwidth; bit += interval) {
      const lineX = x + bit * bitWidth;
      ctx.moveTo(lineX + 0.5, y);
      ctx.lineTo(lineX + 0.5, y + height);
    }
    ctx.stroke();
  }

  function drawSparseGaps(ctx, row, x, y, rowHeight, colwidth, bitWidth, bitOrder) {
    const fragments = [...row.fragments].sort((a, b) => a.colStart - b.colStart);
    const gaps = [];
    let cursor = 0;

    for (const frag of fragments) {
      if (frag.colStart > cursor) {
        gaps.push({ start: cursor, end: frag.colStart - 1 });
      }
      cursor = Math.max(cursor, frag.colEnd + 1);
    }
    if (cursor < colwidth) {
      gaps.push({ start: cursor, end: colwidth - 1 });
    }

    if (gaps.length === 0 || (gaps.length === 1 && gaps[0].start === 0 && gaps[0].end === colwidth - 1)) {
      return;
    }

    for (const gap of gaps) {
      const gapX = bitOrder === "desc"
        ? x + (colwidth - 1 - gap.end) * bitWidth
        : x + gap.start * bitWidth;
      const gapW = Math.max(2, (gap.end - gap.start + 1) * bitWidth);
      ctx.save();
      ctx.fillStyle = "rgba(120, 130, 124, 0.08)";
      ctx.fillRect(gapX, y + 1, gapW, rowHeight - 1);
      if (gapW > 20) {
        ctx.fillStyle = "rgba(120, 130, 124, 0.18)";
        ctx.font = 'italic 10px "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("···", gapX + gapW / 2, y + rowHeight / 2);
      }
      ctx.restore();
    }
  }

  function measureDescTableHeight(entries) {
    if (!entries || entries.length === 0) {
      return 0;
    }
    const titleHeight = 28;
    const rowHeight = 26;
    const headerHeight = 26;
    return 12 + titleHeight + 6 + headerHeight + 2 + entries.length * (rowHeight + 1) + 4;
  }

  function drawDescTable(ctx, entries, x, y, maxWidth, fontSize) {
    const titleHeight = 28;
    const rowHeight = 26;
    const headerHeight = 26;
    const pad = 12;
    const colNoW = Math.min(52, maxWidth * 0.08);
    const colNameW = Math.min(160, maxWidth * 0.24);
    const colBitW = Math.min(100, maxWidth * 0.16);
    const colDescW = maxWidth - colNoW - colNameW - colBitW;
    const colWidths = [colNoW, colNameW, colBitW, colDescW];

    // Title bar
    ctx.fillStyle = "#374151";
    roundRect(ctx, x + 0.5, y + 0.5, maxWidth, titleHeight, 5);
    ctx.fill();
    ctx.fillStyle = "#f4fbf7";
    ctx.font = `700 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText("\u{1F4CB} 描述表 (Description Table)", x + pad, y + titleHeight / 2);

    y += titleHeight + 6;

    // Header
    drawDescRow(ctx, x, y, colWidths, rowHeight, "#d1d5db", "#1f2937", true,
      ["行号", "字段名称", "位范围", "描述"]);
    y += headerHeight + 2;

    // Data rows
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const bgColor = i % 2 === 0 ? "#f9fafb" : "#f3f4f6";
      drawDescRow(ctx, x, y, colWidths, rowHeight, bgColor, "#374151", false, [
        entry.rowNumber ?? "-",
        String(entry.label),
        entry.bitRange || "-",
        String(entry.description)
      ]);
      y += rowHeight + 1;
    }

    return y + 4;
  }

  function drawDescRow(ctx, x, y, widths, h, bgColor, textColor, isHeader, cells) {
    const totalW = widths.reduce((sum, width) => sum + width, 0);
    ctx.fillStyle = bgColor;
    ctx.fillRect(x, y, totalW, h);

    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(x + 0.5, y + 0.5, totalW, h);

    ctx.fillStyle = textColor;
    ctx.textBaseline = "middle";
    const font = isHeader
      ? `700 11px "Segoe UI", system-ui, sans-serif`
      : `11px "Segoe UI", system-ui, sans-serif`;

    let columnX = x;
    for (let i = 0; i < cells.length; i += 1) {
      const columnWidth = widths[i];
      const useMono = i === 0 || i === 2;
      ctx.font = useMono ? `11px "Cascadia Mono", Consolas, monospace` : font;
      ctx.textAlign = i === 0 ? "center" : "left";

      ctx.save();
      ctx.beginPath();
      ctx.rect(columnX, y, columnWidth, h);
      ctx.clip();
      const textX = i === 0 ? columnX + columnWidth / 2 : columnX + 8;
      ctx.fillText(fitText(ctx, String(cells[i]), columnWidth - 10), textX, y + h / 2 + 1);
      ctx.restore();

      columnX += columnWidth;
    }
    ctx.textAlign = "start";

    // Column dividers
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    columnX = x;
    for (let i = 0; i < widths.length - 1; i += 1) {
      columnX += widths[i];
      ctx.moveTo(columnX + 0.5, y);
      ctx.lineTo(columnX + 0.5, y + h);
    }
    ctx.stroke();
  }

  function getDisplayLabel(field) {
    return field.options.label || field.label;
  }

  function drawCell(ctx, fragment, x, y, w, h, color, fontSize) {
    const field = fragment.field;
    const displayLabel = getDisplayLabel(field);
    const borderStyle = field.options.style || "solid";
    const showNumber = field.options.number !== undefined ? !!field.options.number : true;
    const shape = field.options.shape || "box";
    const varLen = field.options.len !== undefined ? Number(field.options.len) || 0 : 0;
    const hasIcon = field.options.icon !== undefined;
    const bgValue = field.options.background;

    // background attribute overrides color when it's a CSS color value
    let cellColor = color;
    if (bgValue !== undefined) {
      const bg = String(bgValue);
      if (/^#[0-9a-fA-F]{3,8}$/.test(bg) || /^(rgb|hsl|var|currentColor|[a-z]+)/i.test(bg)) {
        cellColor = bg;
      }
    }

    ctx.fillStyle = cellColor;
    if (shape === "ellipse") {
      ellipsePath(ctx, x + w / 2, y + h / 2, Math.max(0, w / 2 - 1), Math.max(0, h / 2 - 1));
      ctx.fill();
      if (borderStyle !== "none") {
        ctx.strokeStyle = "#30343a";
        ctx.lineWidth = 1;
        if (borderStyle === "dashed") {
          ctx.setLineDash([4, 3]);
        } else if (borderStyle === "dotted") {
          ctx.setLineDash([2, 3]);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else {
      roundRect(ctx, x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1), 4);
      ctx.fill();
    }

    // Variable-length indicator: zigzag right edge
    if (varLen > 0 && shape !== "ellipse" && w > 8) {
      ctx.save();
      ctx.fillStyle = cellColor;
      ctx.beginPath();
      const zigX = x + w - 5;
      ctx.moveTo(zigX, y + 0.5);
      for (let zi = 0; zi < Math.floor(h / 4); zi += 1) {
        const zy = y + zi * 4;
        ctx.lineTo(zi % 2 === 0 ? zigX + 5 : zigX, zy + 2);
      }
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x + w, y + 0.5);
      ctx.closePath();
      ctx.fill();
      // redraw main border
      if (borderStyle !== "none") {
        ctx.strokeStyle = "#30343a";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // len label
      if (w > 40 && h > 20) {
        ctx.fillStyle = "rgba(17, 24, 39, 0.45)";
        ctx.font = '9px "Cascadia Mono", Consolas, monospace';
        ctx.textAlign = "right";
        ctx.fillText(`len=${varLen}`, x + w - 5, y + h - 4);
      }
      ctx.restore();
    }

    if (borderStyle !== "none") {
      ctx.strokeStyle = "#30343a";
      ctx.lineWidth = 1;
      if (borderStyle === "dashed") {
        ctx.setLineDash([4, 3]);
      } else if (borderStyle === "dotted") {
        ctx.setLineDash([2, 3]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Icon badge
    if (hasIcon && w > 30 && h > 20) {
      ctx.save();
      ctx.fillStyle = "rgba(17, 24, 39, 0.62)";
      ctx.beginPath();
      ctx.arc(x + w - 10, y + 10, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#f0f4f1";
      ctx.font = 'bold 9px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("i", x + w - 9.5, y + 10.5);
      ctx.restore();
    }

    ctx.fillStyle = field.options.textcolor || "#111827";
    ctx.font = `600 ${Math.max(8, Math.min(fontSize, h * 0.36))}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (showNumber) {
      const bitText = `${fragment.start}${fragment.start === fragment.end ? "" : `-${fragment.end}`}`;
      ctx.save();
      ctx.fillStyle = "rgba(17, 24, 39, 0.56)";
      ctx.font = '10px "Cascadia Mono", Consolas, monospace';
      ctx.textAlign = "left";
      if (w > 30 && h > 26) {
        ctx.fillText(bitText, x + 5, y + 13);
      }
      ctx.restore();
    }

    if (!fragment.drawLabel || w < 7 || h < 18) {
      ctx.textAlign = "start";
      return;
    }

    const rotate = Number(field.options.rotate);
    const shouldRotate = rotate === 90 || rotate === 270 || (w < 30 && h > 38);
    if (shouldRotate) {
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate(rotate === 90 ? Math.PI / 2 : -Math.PI / 2);
      ctx.fillText(fitText(ctx, displayLabel, Math.max(10, h - 12)), 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(fitText(ctx, displayLabel, Math.max(6, w - 12)), x + w / 2, y + h / 2 + 3);
    }
    ctx.textAlign = "start";
  }

  function ellipsePath(ctx, cx, cy, rx, ry) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(0, rx), Math.max(0, ry), 0, 0, Math.PI * 2);
    ctx.closePath();
  }

  function roundRect(ctx, x, y, width, height, radius) {
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, width, height, radius);
      return;
    }

    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function fitText(ctx, text, maxWidth) {
    const value = String(text);
    if (ctx.measureText(value).width <= maxWidth) {
      return value;
    }
    if (maxWidth < ctx.measureText("...").width + 4) {
      return "";
    }
    let fitted = value;
    while (fitted.length > 1 && ctx.measureText(`${fitted}...`).width > maxWidth) {
      fitted = fitted.slice(0, -1);
    }
    return `${fitted}...`;
  }

  function wrapTextLines(ctx, text, maxWidth, maxLines) {
    const source = String(text || "").trim();
    if (!source) {
      return [];
    }

    const lines = [];
    const paragraphs = source.split(/\r?\n/);
    for (const paragraph of paragraphs) {
      let line = "";
      const tokens = splitWrapTokens(paragraph);
      for (const token of tokens) {
        const cleanToken = line ? token : token.trimStart();
        if (ctx.measureText(cleanToken).width > maxWidth) {
          if (line) {
            lines.push(line.trimEnd());
            line = "";
            if (lines.length >= maxLines) {
              return truncateWrappedLines(ctx, lines, maxWidth);
            }
          }
          const pieces = splitLongToken(ctx, cleanToken, maxWidth);
          for (let i = 0; i < pieces.length - 1; i += 1) {
            lines.push(pieces[i]);
            if (lines.length >= maxLines) {
              return truncateWrappedLines(ctx, lines, maxWidth);
            }
          }
          line = pieces[pieces.length - 1] || "";
          continue;
        }

        const candidate = line ? `${line}${token}` : cleanToken;
        if (ctx.measureText(candidate).width <= maxWidth || line === "") {
          line = candidate;
        } else {
          lines.push(line.trimEnd());
          line = token.trimStart();
        }

        if (lines.length >= maxLines) {
          return truncateWrappedLines(ctx, lines, maxWidth);
        }
      }
      if (line) {
        lines.push(line.trimEnd());
      }
      if (lines.length >= maxLines) {
        return truncateWrappedLines(ctx, lines, maxWidth);
      }
    }
    return lines;
  }

  function splitLongToken(ctx, token, maxWidth) {
    const pieces = [];
    let line = "";
    for (const char of token) {
      const candidate = `${line}${char}`;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        pieces.push(line);
        line = char;
      } else {
        line = candidate;
      }
    }
    if (line) {
      pieces.push(line);
    }
    return pieces.length > 0 ? pieces : [token];
  }

  function splitWrapTokens(text) {
    const tokens = [];
    let buffer = "";
    for (const char of String(text)) {
      buffer += char;
      if (/\s/.test(char) || /[\u4e00-\u9fff]/.test(char)) {
        tokens.push(buffer);
        buffer = "";
      }
    }
    if (buffer) {
      tokens.push(buffer);
    }
    return tokens;
  }

  function truncateWrappedLines(ctx, lines, maxWidth) {
    const result = lines.slice(0);
    const lastIndex = result.length - 1;
    if (lastIndex >= 0) {
      result[lastIndex] = fitText(ctx, `${result[lastIndex]}...`, maxWidth);
    }
    return result;
  }

  function defaultColorFor(label) {
    const palette = [
      "#dbeafe",
      "#dcfce7",
      "#fef3c7",
      "#fee2e2",
      "#ede9fe",
      "#e0f2fe",
      "#fce7f3",
      "#e5e7eb",
      "#ccfbf1",
      "#ffedd5"
    ];
    let hash = 0;
    for (let i = 0; i < label.length; i += 1) {
      hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
    }
    return palette[hash % palette.length];
  }

  global.PacketDiag = {
    parse: parsePacketDiag,
    render: renderDiagram,
    presets: PRESETS,
    defaultSource: DEFAULT_PACKET_SOURCE
  };
}(typeof window !== "undefined" ? window : globalThis));
