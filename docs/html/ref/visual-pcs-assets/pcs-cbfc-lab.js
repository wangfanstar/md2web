(() => {
  'use strict';
  const el = id => document.getElementById('cb-' + id);
  const groups = {
    '正常传输': {'单帧与信用归还': 'tx rx drain cf', '尽力而为 VC': 'be'},
    '准入与背压': {'连续两帧争用信用': 'tx rx tx rx drain cf retry rx', '额度恰好耗尽': 'tx rx tx rx'},
    '反馈与恢复': {'重复 CF_Update': 'tx rx drain cf cf', 'CF_Update 丢失': 'tx rx drain miss timer cf',
      '数据帧丢失与信用回收': 'tx loss cc cf'}
  };
  let events, index, timer, state;
  const option = (select, name) => select.add(new Option(name, name));
  function stop() { clearInterval(timer); timer = null; el('play').textContent = '播放'; }
  function render(note, token, direction) {
    el('step').textContent = index + ' / ' + events.length + ' · ' + note;
    const {used, consumed, seen, received, freed, buffered} = state;
    el('count').textContent = '每帧 ' + cost() + ' 信用 ｜ A：可用 ' + (+el('limit').value-used) +
      '，S_P_CU = S_VC_CU[1] = ' + used + '，S_VC_CC = ' + consumed + '，S_VC_CF = ' + seen +
      ' ｜ B：R_VC_CC = ' + received + '，R_VC_CF = ' + freed + '，缓冲占用 ' + buffered;
    const box = el('token');
    box.getAnimations().forEach(a => a.cancel());
    box.textContent = token;
    box.style.left = '50%';
    if (direction) box.animate([{left:direction>0?'15%':'85%'},{left:direction>0?'85%':'15%'}],
      {duration:1000,fill:'forwards'});
    el('next').disabled = index >= events.length;
  }
  function cost() { return Math.ceil((+el('size').value + +el('over').value)/+el('unit').value); }
  function reset() {
    stop(); index = 0;
    events = groups[el('group').value][el('case').value].split(' ');
    state = {used:0,consumed:0,seen:0,received:0,freed:0,buffered:0,inFlight:false,blocked:false};
    const valid = ['limit','size','over'].every(id => el(id).value && el(id).validity.valid);
    render(valid?'已就绪，按下一步观察准入判定。':'请输入范围内的整数。','VC 1',0);
    el('play').disabled = el('next').disabled = !valid;
  }
  function next() {
    if (index >= events.length) return;
    const event = events[index++], s = state, n = cost();
    let note, token, dir = 0;
    switch(event) {
      case 'retry':
        if (!s.blocked) { note='队列中没有等待重试的帧。'; token='队列空'; break; }
        // A waiting frame undergoes the same admission check.
      case 'tx':
        s.blocked = s.used+n > +el('limit').value;
        s.inFlight = !s.blocked;
        token=s.blocked?'等待信用':'数据帧'; note=(el('mode').value==='vc'?'VC':'端口')+' 准入：'+s.used+' + '+n+(s.blocked?' > ':' ≤ ')+el('limit').value;
        if (!s.blocked) { s.used+=n; s.consumed+=n; dir=1; } break;
      case 'rx':
        if (s.inFlight) { s.buffered+=n; s.received+=n; }
        note=s.inFlight?'B 接收有效帧并占用缓冲。':'A 未发帧，B 无接收事件。';
        token=s.inFlight?'已接收':'等待'; s.inFlight=false; break;
      case 'drain':
        s.freed+=s.buffered; s.buffered=0; note='B 排空已接收缓冲，更新累计释放值。'; token='释放'; break;
      case 'cf': {
        const delta=s.freed-s.seen; s.used-=delta; s.seen=s.freed;
        note='A 收到累计释放值 '+s.freed+'，本次归还 '+delta+'。'; token='CF_Update'; dir=-1; break;
      }
      case 'be': note='尽力而为帧通过，双方无损信用计数保持原值。';token='BE 数据'; dir=1;break;
      case 'miss': note='CF_Update 在链路丢失，A 的额度尚未恢复。';token='反馈丢失';break;
      case 'timer': note='CF_max_timer 到期，B 再次通告累计释放值。';token='周期更新';break;
      case 'loss': note=s.inFlight?'已发送帧丢失，B 未计入接收。':'准入受阻，没有在途帧。';s.inFlight=false;token='无接收';break;
      case 'cc': {
        const lost=s.consumed-s.received; s.freed+=lost;s.received=s.consumed;
        note='B 对照发送累计值，回收泄漏信用 '+lost+'。';token='CC_Update'; dir=1;break;
      }
    }
    render(note,token,dir);
    if(index===events.length) stop();
  }
  function preset() {
    el('limit').value=el('case').value==='额度恰好耗尽'?3:4;
    el('size').value=192;el('over').value=0;el('unit').value=64;
    reset();
  }
  function categories() {
    el('case').replaceChildren();
    Object.keys(groups[el('group').value]).forEach(name=>option(el('case'),name));
    preset();
  }
  Object.keys(groups).forEach(name=>option(el('group'),name));
  el('group').onchange=categories; el('case').onchange=preset;
  ['mode','limit','size','over','unit'].forEach(id=>el(id).oninput=reset);
  el('next').onclick=()=>{stop();next();};
  el('reset').onclick=reset;
  el('play').onclick=()=>{
    if(timer){stop();return;}
    if(index===events.length)reset();
    timer=setInterval(next,1800);el('play').textContent='暂停';next();
  };
  const panel=document.getElementById('lab-cbfc');
  new MutationObserver(()=>{if(panel.hidden)stop();}).observe(panel,{attributes:true,attributeFilter:['hidden']});
  categories();
})();
