(function (root) {
  'use strict';
  const deskewLimit = 152;
  const range = n => Array.from({ length: n }, (_, i) => i);

  function mapping(preset) {
    const first = preset === 'spread' ? i => [i, i + 8] : i => [2 * i, 2 * i + 1];
    const second = preset === 'spread' ? i => [23 - i, 31 - i] : i => [16 + 2 * i, 17 + 2 * i];
    return range(8).map(i => first(i).concat(second(i)));
  }

  function receiveMap(tx, phase) {
    return tx.flatMap(lanes => lanes.map((_, slot) => lanes[(slot + phase) % 4]));
  }

  function distribute(blocks) {
    const flows = [[], []];
    blocks.forEach((block, i) => flows[i % 2].push(block));
    return flows;
  }

  function collect(flows) {
    return flows[0].flatMap((block, i) => i < flows[1].length ? [block, flows[1][i]] : [block]);
  }

  function alignment(tx, fault, recovery) {
    const unavailable = new Set(fault.loss ? tx[fault.physical] : []);
    if (fault.am) unavailable.add(fault.lane);
    const locked = range(32).map(i => recovery >= 2 && !unavailable.has(i));
    return { locked, aligned: locked.every(Boolean) && fault.skew <= deskewLimit };
  }

  // Clause 119.2.4.7, referenced by 172.2.4.9. index is in transmission order.
  function symbolAt(lane, row) {
    return {
      flow: Math.floor(lane / 16),
      word: (lane + row) % 2,
      index: 8 * row + Math.floor((lane % 16) / 2)
    };
  }

  function byteBits(byte) {
    return range(8).map(i => (byte >> i) & 1);
  }

  // Clause 49 self-synchronous scrambler, applied separately to each Flow.
  function scramble(bits, flow, decode = false) {
    const history = range(58).map(i => ((i + flow) % (flow ? 3 : 2)) === 0 ? 1 : 0);
    return bits.map(bit => {
      const out = bit ^ history[19] ^ history[0];
      history.shift();
      history.push(decode ? bit : out);
      return out;
    });
  }

  const blockSize = 257;
  const markerSize = 8 * blockSize;
  const markerOffset = 0;
  const umOctets = [8, 9, 10, 12, 13, 14];
  // IEEE 802.3df Tables 172–2 and 172–3, with the common octets stored separately.
  const markerVariables = [
    'B6 D9 FE 71 F3 26 01 8E 0C',
    '04 67 A5 DE 7E 98 5A 21 81',
    '46 FE C1 F3 56 01 3E 0C A9',
    '5A 84 79 80 D0 7B 86 7F 2F',
    'E1 19 D5 51 F2 E6 2A AE 0D',
    'F2 4E ED 4F D1 B1 12 B0 2E',
    '3D EE BD 9C A1 11 42 63 5E',
    '22 32 29 76 5B CD D6 89 A4',
    '60 9F 1E 73 75 60 E1 8C 8A',
    '6B A2 8E C4 3C 5D 71 3B C3',
    'FA 04 6A EB D8 FB 95 14 27',
    '6C 71 DD 66 38 8E 22 99 C7',
    '18 5B 5D F6 95 A4 A2 09 6A',
    '14 CC CE 97 C3 33 31 68 3C',
    'D0 B1 35 FB A6 4E CA 04 59',
    'B4 56 59 BA 79 A9 A6 45 86',
    'B6 D9 01 8E 0C 26 FE 71 F3',
    '04 67 5A 21 81 98 A5 DE 7E',
    '46 FE 3E 0C A9 01 C1 F3 56',
    '5A 84 86 7F 2F 7B 79 80 D0',
    'E1 19 2A AE 0D E6 D5 51 F2',
    'F2 4E 12 B0 2E B1 ED 4F D1',
    '3D EE 42 63 5E 11 BD 9C A1',
    '22 32 D6 89 A4 CD 29 76 5B',
    '60 9F E1 8C 8A 60 1E 73 75',
    '6B A2 71 3B C3 5D 8E C4 3C',
    'FA 04 95 14 27 FB 6A EB D8',
    '6C 71 22 99 C7 8E DD 66 38',
    '18 5B A2 09 6A A4 5D F6 95',
    '14 CC 31 68 3C 33 CE 97 C3',
    'D0 B1 CA 04 59 4E 35 FB A6',
    'B4 56 A6 45 86 A9 59 BA 79'
  ];
  const laneMarkers = markerVariables.map(row => {
    const [up0, ...tail] = row.split(' ').map(octet => parseInt(octet, 16));
    return [0x9A, 0x4A, 0x26, up0, 0x65, 0xB5, 0xD9, ...tail].flatMap(byteBits);
  });
  const markerFor = (lane, bit) => laneMarkers[lane][bit];
  const umFor = lane => umOctets.flatMap(octet =>
    range(8).map(bit => markerFor(lane, 8 * octet + bit))).join('');
  const markerIds = new Map(range(32).map(lane => [umFor(lane), lane]));
  const messageBits = pair => range(514).flatMap(i =>
    pair.flatMap(word => range(10).map(bit => (word[i] >> bit) & 1)));

  function sample(flow, input, received, group = 0) {
    const bytes = range(4).map((_, i) => range(8).map(j => {
      const offset = (group * 8 + i * 2 + flow) * 8 + j;
      return input.charCodeAt(offset % input.length) & 127;
    }));
    const payloads = bytes.map(block => block.flatMap(byteBits));
    const encoded = payloads.map(bits => [0, 1].concat(bits));
    const transcoded = [1].concat(...payloads);
    const scrambled = scramble(transcoded, flow);
    const recovered = scramble(received || scrambled, flow, true).slice(0, blockSize);
    const reverse = range(4).map(i => [0, 1].concat(recovered.slice(1 + i * 64, 65 + i * 64)));
    const decoded = reverse.map(bits => range(8).map(i =>
      range(8).reduce((byte, j) => byte | (bits[2 + i * 8 + j] << j), 0)));
    return { bytes, encoded, transcoded, scrambled, recovered, reverse, decoded };
  }

  function codewords(codec, input = 'Visual PCS 800G ', idle = false) {
    return range(2).map(flow => {
      // Teaching control-block representation for an all-Idle input.
      const idlePayload = byteBits(0x1e).concat(range(56).fill(0));
      const idleBlock = [0].concat(idlePayload, idlePayload, idlePayload, idlePayload);
      const data = scramble(range(40).flatMap(group => idle ? idleBlock
        : sample(flow, input, undefined, group).transcoded), flow);
      // Place the IEEE lane markers in a shortened teaching frame with illustrative padding.
      const marker = range(markerSize).map(i => ((i + flow) % 5 < 2 ? 1 : 0));
      for (const local of range(16)) {
        const lane = 16 * flow + local;
        for (const row of range(12)) {
          const { word, index } = symbolAt(lane, row);
          for (const bit of range(10)) marker[20 * index + 10 * word + bit] = markerFor(lane, 10 * row + bit);
        }
      }
      const stream = data.slice(0, markerOffset).concat(marker, data.slice(markerOffset));
      return range(2).map(word => {
        const message = range(514).map(i => range(10).reduce((symbol, bit) =>
          symbol | (stream[20 * i + 10 * word + bit] << bit), 0));
        return message.concat(codec.rsParity(message));
      });
    });
  }

  function receive(codec, words, tx, phase, count, target) {
    const incoming = range(2).map(() => range(2).map(() => Array(544)));
    const recovered = [];
    for (const lanes of tx) {
      const physical = range(68).flatMap(row => {
        const symbols = lanes.map(lane => {
          const { flow, word, index } = symbolAt(lane, row);
          return words[flow][word][index];
        });
        return range(10).flatMap(bit => symbols.map(symbol => (symbol >> bit) & 1));
      });
      for (const slot of range(4)) {
        const source = (slot + phase) % 4;
        const bits = range(680).map(i => physical[4 * i + source]);
        const lane = markerIds.get(umOctets.flatMap(octet => bits.slice(8 * octet, 8 * octet + 8)).join(''));
        recovered.push(lane);
        if (lane === undefined) continue;
        for (let row = 0; row < 68; row++) {
          const { flow, word, index } = symbolAt(lane, row);
          incoming[flow][word][index] = range(10).reduce((symbol, bit) => symbol | (bits[10 * row + bit] << bit), 0);
        }
      }
    }
    const id = symbolAt(target, 0);
    for (let i = 0; i < count; i++) {
      incoming[id.flow][id.word][id.index + 16 * i] ^= i + 1;
    }
    const results = incoming.map((pair, flow) => {
      if (recovered.some(lane => lane === undefined)) {
        return { errors: 0, corrected: false, valid: false, interleaved: [], data: [] };
      }
      const decoded = pair.map(word => codec.rsDecode(word));
      const valid = decoded.every((result, i) => result.ok &&
        result.cw.every((symbol, j) => symbol === words[flow][i][j]));
      const interleaved = valid ? messageBits(decoded.map(result => result.cw)) : [];
      const data = interleaved.slice(0, markerOffset).concat(interleaved.slice(markerOffset + markerSize));
      const errors = flow === id.flow ? count : 0;
      return { errors, corrected: errors > 0 && valid, valid, interleaved, data };
    });
    return { results, recovered };
  }

  function pam4Pair(words, tx, channel, row, bit, pair) {
    const ids = tx[channel].slice(2 * pair, 2 * pair + 2);
    const bits = ids.map(lane => {
      const id = symbolAt(lane, row);
      return (words[id.flow][id.word][id.index] >> bit) & 1;
    });
    const level = [0, 1, 3, 2][bits[0] * 2 + bits[1]];
    const gray = level ^ (level >> 1);
    return { ids, bits, level, recovered: [gray >> 1, gray & 1] };
  }

  root.PCS800Model = {
    deskewLimit, mapping, receiveMap, distribute, collect, alignment,
    symbolAt, laneMarkers, codewords, receive, pam4Pair, sample, scramble, range, markerOffset, markerSize, messageBits
  };
})(globalThis);
