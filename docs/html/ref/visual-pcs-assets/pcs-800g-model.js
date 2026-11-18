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
  const markerOffset = blockSize;
  const messageBits = pair => range(514).flatMap(i =>
    pair.flatMap(word => range(10).map(bit => (word[i] >> bit) & 1)));

  function sample(flow, input, received) {
    const bytes = range(4).map((_, i) => range(8).map(j => {
      const offset = (i * 2 + flow) * 8 + j;
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

  function codewords(codec, input = 'Visual PCS 800G ') {
    return range(2).map(flow => {
      const block = sample(flow, input).transcoded;
      const data = scramble(range(40).flatMap(() => block), flow);
      // A shortened teaching interval and synthetic marker bits.
      const marker = range(markerSize).map(i => ((i + flow) % 5 < 2 ? 1 : 0));
      const stream = data.slice(0, markerOffset).concat(marker, data.slice(markerOffset));
      return range(2).map(word => {
        const message = range(514).map(i => range(10).reduce((symbol, bit) =>
          symbol | (stream[20 * i + 10 * word + bit] << bit), 0));
        return message.concat(codec.rsParity(message));
      });
    });
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
      const decoded = pair.map(word => codec.rsDecode(word));
      const valid = decoded.every((result, i) => result.ok &&
        result.cw.every((symbol, j) => symbol === words[flow][i][j]));
      const interleaved = valid ? messageBits(decoded.map(result => result.cw)) : [];
      const data = interleaved.slice(0, markerOffset).concat(interleaved.slice(markerOffset + markerSize));
      const errors = flow === id.flow ? count : 0;
      return { errors, corrected: errors > 0 && valid, valid, interleaved, data };
    });
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
    symbolAt, codewords, receive, pam4Pair, sample, scramble, range, markerOffset, markerSize, messageBits
  };
})(globalThis);
