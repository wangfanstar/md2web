(function (P) {
  'use strict';

  const active = new WeakMap();
  P.stopModuleDemo = function (dialog) {
    if (active.has(dialog)) active.get(dialog)();
  };

  P.mountModuleDemo = function (dialog, host, cards, explanation) {
    P.stopModuleDemo(dialog);
    const demo = document.createElement('section');
    demo.className = 'pcs-module-demo';
    demo.setAttribute('aria-label', '模块流程动画');
    demo.innerHTML = `
      <ol class="pcs-module-demo-track"></ol>
      <p class="pcs-module-demo-status" role="status"></p>
      <div class="pcs-follow-actions">
        <button type="button" class="btn" data-play>播放</button>
        <button type="button" class="btn" data-next>下一步</button>
        <button type="button" class="btn" data-replay>重播</button>
      </div>`;
    const track = demo.querySelector('ol');
    const list = cards.map((text, i) => {
      const element = document.createElement('li');
      const label = document.createElement('small');
      label.textContent = ['输入', '处理', '输出'][i];
      const value = document.createElement('b');
      value.textContent = text;
      element.append(label, value);
      track.append(element);
      return element;
    });
    const status = demo.querySelector('[role="status"]');
    const play = demo.querySelector('[data-play]');
    let index = 0, timer = null;

    function render() {
      list.forEach((item, i) => item.setAttribute('aria-current', i === index ? 'step' : 'false'));
      status.textContent = (index + 1) + ' / 3 · ' +
        (index === 1 ? explanation : (index === 0 ? '查看输入。' : '查看输出，下面是当前实验样例。'));
      play.textContent = timer !== null ? '暂停' : index === 2 ? '重新播放' : '播放';
    }
    function pause() {
      clearInterval(timer);
      timer = null;
      render();
    }
    function advance() {
      index = Math.min(index + 1, 2);
      if (index === 2) pause();
      else render();
    }
    function start() {
      if (index === 2) index = 0;
      timer = setInterval(advance, 2300);
      render();
    }
    play.onclick = () => timer === null ? start() : pause();
    demo.querySelector('[data-next]').onclick = () => {
      pause();
      if (index === 2) index = 0;
      else index++;
      render();
    };
    demo.querySelector('[data-replay]').onclick = () => {
      pause();
      index = 0;
      start();
    };
    const dispose = () => {
      pause();
      dialog.removeEventListener('close', dispose);
      active.delete(dialog);
    };
    dialog.addEventListener('close', dispose);
    active.set(dialog, dispose);
    host.prepend(demo);
    render();
  };
})(globalThis.PCS);
