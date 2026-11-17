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

  function codewords(codec) {
    return range(2).map(flow => range(2).map(word => {
      const message = range(514).map(i => (i * 73 + (1 + 2 * flow + word) * 137) & 1023);
      return message.concat(codec.rsParity(message));
    }));
  }

  function receive(codec, words, rx, count, target) {
    const incoming = range(2).map(() => range(2).map(() => Array(544)));
    rx.forEach(lane => {
      for (let row = 0; row < 68; row++) {
        const { flow, word, index } = symbolAt(lane, row);
        incoming[flow][word][index] = words[flow][word][index];
      }
    });
    const id = symbolAt(target, 0);
    for (let i = 0; i < count; i++) {
      incoming[id.flow][id.word][id.index + 16 * i] ^= i + 1;
    }
    return incoming.map((pair, flow) => {
      const valid = pair.every((word, i) => {
        const decoded = codec.rsDecode(word);
        return decoded.ok && decoded.cw.every((symbol, j) => symbol === words[flow][i][j]);
      });
      const errors = flow === id.flow ? count : 0;
      return { errors, corrected: errors > 0 && valid, valid };
    });
  }

  function pam4Pair(words, tx, channel, row, bit, pair) {
    const ids = tx[channel].slice(2 * pair, 2 * pair + 2);
    const bits = ids.map(lane => {
      const id = symbolAt(lane, row);
      return (words[id.flow][id.word][id.index] >> bit) & 1;
    });
    return { ids, bits, level: [0, 1, 3, 2][bits[0] * 2 + bits[1]] };
  }

  root.PCS800Model = {
    deskewLimit, mapping, receiveMap, distribute, collect, alignment,
    symbolAt, codewords, receive, pam4Pair, range
  };
})(globalThis);
