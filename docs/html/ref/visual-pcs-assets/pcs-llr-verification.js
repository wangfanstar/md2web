/* Deterministic acceptance cases for the same event model used by the LLR lab. */
window.LLRVerification = {
  run(simulate) {
    const results = [];
    function check(id, preset, input, criterion, verify) {
      for (const sender of ['A', 'B']) {
        const options = { ...input, sender };
        const result = { name: id + ' · ' + sender + ' 发', preset, options, check: criterion };
        try {
          const rows = simulate(preset, options);
          const events = rows.map(row => row[10]);
          const total = (port, counter) => events.reduce((sum, event) =>
            sum + event.counter.split('|').filter(key => key === port + ' ' + counter).length, 0);
          const receiver = sender === 'A' ? 'B' : 'A';
          result.actual = { events:rows.length, finalState:events.at(-1).txState, expectedSeq:events.at(-1).expected,
            acknowledged:events.at(-1).acknowledged, replayCount:total(sender, 'tx_replay') };
          if (events.some((event, i) => i && event.time < events[i - 1].time)) throw Error('时间倒退');
          if (!verify({ rows, events, end: events.at(-1), tx: key => total(sender, key),
            rx: key => total(receiver, key) })) throw Error('预期与实际轨迹不符');
        } catch (error) { result.error = error.message; }
        results.push(result);
      }
    }
    for (const A of ['v0','v1','off','none','reserved1','reserved2']) {
      for (const B of ['v0','v1','off','none','reserved1','reserved2']) {
        const enabled = ['v0','v1'].includes(A) && ['v0','v1'].includes(B);
        check((enabled ? 'N01' : 'N02') + ' LLDP ' + A + '/' + B, 'lldp', {versions:{A,B}},
          enabled ? '双方启用后进入 ADVANCE' : '继续普通以太网', ({end,tx}) =>
            end.txState === (enabled ? 'ADVANCE' : 'LLR_OFF') && tx('tx_init_ctl_os') === Number(enabled));
      }
    }
    check('I01 初始化', 'init', {}, 'INIT/ECHO 各一次并进入 ADVANCE', ({end,tx,rx}) =>
      end.txState === 'ADVANCE' && tx('tx_init_ctl_os') === 1 && rx('tx_init_echo_ctl_os') === 1);
    check('I02 单向握手失败', 'init-fail', {}, '丢 INIT 的方向保持 INIT', ({end,rx}) =>
      end.txState === 'INIT' && rx('rx_init_ctl_os') === 0);
    check('D01 正常累计确认','normal',{},'交付两帧，ACK(11)，零重放',({end,tx,rx}) =>
      end.acknowledged === 11 && tx('tx_replay') === 0 && rx('rx_expected_seq_good') === 2);
    for (const [id, faults] of [['D02 头帧',['lost','','']],['D03 中间帧',['','lost','']],['D03 尾帧',['','','lost']]]) {
      check(id,'normal',{frameCount:3,faults,tx:{outstanding_seq_max:3}},'三帧各交付一次，最终 ACK(12)',
        ({end,tx,rx}) => end.acknowledged === 12 && tx('tx_replay') >= 1 && rx('rx_expected_seq_good') === 3);
    }
    check('D04 坏 FCS','bad-fcs',{},'坏 FCS 一次，重放后两帧交付',({rx}) =>
      rx('rx_expected_seq_bad') === 1 && rx('rx_expected_seq_good') === 2);
    check('D05 Poisoned FCS','poisoned',{},'标记 frame_bad，无 NACK',({rx,tx}) =>
      rx('rx_expected_seq_poisoned') === 1 && tx('tx_poisoned') === 1 && rx('tx_nack_ctl_os') === 0);
    check('D06 / R02 ACK 丢失','timeout',{},'重复帧被识别，累计交付仍为两次',({rx,tx}) =>
      rx('rx_duplicate_seq') > 0 && rx('rx_expected_seq_good') === 2 && tx('rx_ack_ctl_os') === 0);
    check('R01 部分确认','normal',{frameCount:3,tx:{outstanding_seq_max:3}, injections:[{kind:'nack',time:60,seq:10}]},
      '重放从序号 11 开始',({rows}) => rows.find(row => row[10].replay)?.[5] === 11);
    check('R03 丢 NACK','nack',{dropFeedback:[9]},'NACK 未到达，定时器恢复传输',
      ({end,tx,rx}) => rx('tx_nack_ctl_os') === 1 && tx('rx_nack_ctl_os') === 0 && end.acknowledged === 11);
    for (const time of [170,190,210]) {
      check('R04 重放中 ACK @'+time,'bad-fcs',{injections:[{kind:'ack',time,seq:10}]},
        '确认前缀只释放一次，最终确认 11',({end}) => end.acknowledged === 11);
    }
    for (const behavior of ['DISCARD','BLOCK','BEST_EFFORT']) {
      for (const reinit of ['TRUE','FALSE']) {
        check('F01 FLUSH '+behavior+'/'+reinit,'pcs',{tx:{llr_flush_behavior:behavior,re_init_on_discard:reinit}},
          '按策略处理上层帧并决定是否重新初始化',({end,tx}) =>
            end.txState === (reinit === 'TRUE' ? 'ADVANCE':'FLUSH') && tx('tx_discard') === Number(behavior === 'DISCARD'));
      }
      check('F01 INIT '+behavior,'init',{tx:{llr_init_behavior:behavior}},'按 INIT 策略记录丢弃',
        ({tx}) => tx('tx_discard') === Number(behavior === 'DISCARD'));
    }
    check('B01 跨零累计确认','normal',{start:1048574,frameCount:3,tx:{outstanding_seq_max:3}},
      '三个序号跨零，最终 ACK(0)',({end,rx}) => end.acknowledged === 0 && rx('rx_expected_seq_good') === 3);
    for (const d of [0,1,-1,524287,524288,524289]) for (const fault of ['','bad-fcs','poisoned']) {
      for (const valid of [true,false]) {
        const seq = (10+d+1048576)%1048576;
        const counter = !valid ? null : d === 0 ? 'rx_expected_seq_'+({'':'good','bad-fcs':'bad',poisoned:'poisoned'}[fault]) :
          d === 1 || d === 524287 ? 'rx_missing_seq':'rx_duplicate_seq';
        check('B02 RX Δ'+d+' '+(fault||'GOOD')+' valid='+valid,'normal',
          {start:seq,expected:10,rxValid:valid,frameCount:1,faults:[fault]},'核对首次接收分类与期望序号',
          ({events}) => (!counter || events[0].counter.includes(counter)) &&
            events[0].expected === (valid && !d && fault !== 'bad-fcs' ? 11:10));
      }
    }
    for (const seq of [8,9,10,11,12]) for (const kind of ['ack','nack']) {
      check('B03 '+kind+'('+seq+')','normal',{injections:[{time:30,kind,seq}]},'非法反馈计数与窗口一致',
        ({events}) => events.find(e=>e.time===30)?.counter.includes('rx_ack_nack_seq_error') === (seq===8 || seq===12));
    }
    for (const size of [511,512,513]) for (const limit of [0,1,524288]) {
      check('B04 存储 '+size+' / 序号上限 '+limit,'normal',{bufferBytes:size,tx:{outstanding_seq_max:limit}},
        '整帧准入，单帧窗口在 ACK 后继续发送',({tx}) => tx('tx_ok') === (size>=512 && limit>0 ? 2:0));
    }
    for (const wait of [0,1,65535]) check('B05 超时 '+wait,'timeout',
      {tx:{replay_timer_max:wait,data_age_timer_max:1000000,replay_ct_max:0,re_init_on_discard:'FALSE'}},
      '首次超时即 FLUSH',({end})=>end.txState==='FLUSH' && end.time===wait);
    for (const max of [0,1,2,254,255]) check('B06 重放上限 '+max,'timeout',
      {eventLimit:2800,tx:{replay_ct_max:max,data_age_timer_max:210000,re_init_on_discard:'FALSE'}},
      '255 由驻留到期结束，有限阈值按 REPLAY 退出次数结束',({tx,end})=>
        end.txState==='FLUSH' && (max===255 ? end.time===210000 : tx('tx_replay')===max));
    for (const time of [99,100,101]) check('B07 PCS 恢复 @'+time,'pcs',
      {tx:{pcs_lost_status_timer_max:100,re_init_on_discard:'FALSE'},injections:[{time,kind:'pcs-up'}]},
      '同拍采用到期优先',({end})=>end.txState===(time<100?'ADVANCE':'FLUSH'));
    for (const spacing of [400,2048,16384]) check('B08 CtlOS 目标 '+spacing,'normal',{rx:{ctlos_target_spacing:spacing}},
      '发送槽按 8 B 对齐',({events})=>events.some(e=>e.wire && e.ctlByte===spacing));
    check('B09 Type D 信用','cbfc',{},'首次发送扣信用，重放按序接收后归还',({end})=>
      end.creditSent===2 && end.creditReceived===2 && end.creditReturned===2);
    check('B10 REPLAY 中管理复位','bad-fcs',{injections:[{kind:'reset',time:180}]},
      '结束会话后无旧事件',({end,rows})=>end.txState==='LLR_OFF' && rows.at(-1)[0]==='管理复位');
    for (const initFault of ['init-lost','echo-lost','echo-mismatch']) {
      check('I01 首次握手异常 '+initFault,'init',{initFault},'第二次 INIT 满足四倍间隔并恢复',
        ({events,end,tx}) => end.txState==='ADVANCE' && tx('tx_init_ctl_os')===2 &&
          events.filter(e=>e.type===3)[1].time >= Math.ceil(4*2048/25));
    }
    for (const delta of [-1,0,1]) {
      check('B05 反馈与超时相差 '+delta+' ns','timeout',
        {frameCount:1,tx:{replay_timer_max:100},injections:[{kind:'ack',seq:10,time:100+delta}]},
        '同拍反馈优先；超时后能观察到 REPLAY 入口',({rows,end})=>
          end.acknowledged===10 && rows.some(row=>row[0]==='进入 REPLAY')===(delta>0));
    }
    for (const offset of [248,256,264,2040,2048,2056]) {
      const spacing = 4096;
      const prior = offset >= 2040;
      const start = prior ? 0 : spacing-offset;
      const reverseFrame = prior ? {start,end:8192,previous:spacing-offset} : {start,end:8192};
      check('B08 帧内边界 '+offset+' B','normal',{rx:{ctlos_target_spacing:spacing},reverseFrame},
        '越过帧首保护区并满足同帧间隔',({events})=>
          events.find(e=>e.wire && e.ctlByte!==undefined)?.ctlByte===
          Math.max(spacing,prior ? reverseFrame.previous+2048 : start+256));
    }
    for (const bytes of [511,512,513]) {
      check('B04 字节门限 '+bytes,'normal',{tx:{outstanding_data_max:bytes}},
        '按发帧前的未确认字节判定准入',({rows})=>
          rows.findIndex(r=>r[0]==='发送帧 11') < rows.findIndex(r=>r[0]==='累计 ACK 与释放') === (bytes>512));
    }
    check('B09 Type C 最佳努力重放','cbfc',{packetType:'C'},'重放不影响信用',
      ({end,tx})=>tx('tx_replay')===1 && end.creditSent===0 && end.creditReceived===0);
    check('B04 超过设备最大窗口','normal',{tx:{outstanding_seq_max:524289}},
      '拒绝配置',({rows})=>rows.length===1 && rows[0][0]==='配置无效');
    for (const nack of [true,false]) check('B08 LLR/CBFC 仲裁 '+(nack?'NACK':'ACK'),'arbitration',{nack},
      'LLR 按 ECHO、INIT、反馈排序，CF_Update 获得服务',
      ({rows})=>rows.map(r=>r[0]).join(',')==='INIT_ECHO,CF_Update,INIT,'+(nack?'NACK':'ACK'));
    for (const packetType of ['A','B']) check('B09 Type '+packetType,'cbfc',{packetType},
      '最佳努力非 LLR 帧直接交付，非法组合拒绝',({rows,end})=>
        rows[0][0]===(packetType==='B'?'配置无效':'接收 Type A') && end.creditSent===0);
    check('B09 丢弃窗口内信用控制','cbfc',{injections:[
      {time:40,kind:'CF_Update'},{time:41,kind:'CC_Update'}]},
      '单独接收 CF_Update，过滤 CC_Update',({events})=>
        events.find(e=>e.time===40)?.rxResult==='接收' && events.find(e=>e.time===41)?.rxResult==='丢弃');
    check('I02 双向独立初始化','duplex',{forward:'init',backward:'init-fail'},
      '一端 ADVANCE，另一端停在 INIT',({events})=>
        new Set(['A','B'].map(port=>events.filter(e=>e.sender===port).at(-1).txState)).size===2);
    check('B10 同时发包单向坏帧','duplex',{forward:'bad-fcs',backward:'normal'},
      '两向独立交付，只有故障方向重放',({events})=>
        events.filter(e=>e.replay).length===2 && new Set(events.filter(e=>e.replay).map(e=>e.sender)).size===1);
    for (const time of [5,180]) check('B10 活动会话复位 @'+time,'bad-fcs',{injections:[{kind:'reset',time}]},
      '复位后时间线结束',({end})=>end.time===time && end.txState==='LLR_OFF');
    for (const age of [99,100,101]) check('B07 驻留与失锁到期 '+age,'timeout',
      {tx:{data_age_timer_max:age,pcs_lost_status_timer_max:90,re_init_on_discard:'FALSE'},
       injections:[{kind:'pcs-down',time:10}]},'先到期的定时器触发一次 FLUSH',
      ({end,rows})=>end.time===Math.min(age,100) && rows.filter(r=>r[0]==='FLUSH').length===1);
    for (const state of ['INIT','FLUSH']) check('B10 '+state+' 管理复位',
      state==='INIT'?'init':'pcs',{resetState:state},'复位后窗口为空，无旧会话事件',
      ({rows,end})=>end.txState==='LLR_OFF' && rows.at(-1)[9]==='空' && end.txSeq===0);
    for (const seq of [1048573,1048574,1048575,0,1]) check('B03 跨零反馈 '+seq,'normal',
      {start:1048574,frameCount:3,tx:{outstanding_seq_max:3},injections:[{time:60,kind:'ack',seq}]},
      '只确认跨零队列中的有效前缀',({events})=>
        events.find(e=>e.time===60)?.acknowledged===(seq===1?1048573:seq));
    // Fixed seed for reproducible combinations of start sequence, frame count and window size.
    let seed = 20261121;
    const sample = () => { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed; };
    for (let i=0;i<16;i++) {
      const start=sample()%1048576, frames=1+sample()%5, windowSize=1+sample()%3;
      check('组合回归 20261121/'+i,'normal',{start,frameCount:frames,tx:{outstanding_seq_max:windowSize}},
        '按序交付所有帧，累计确认和窗口最终一致',({end,rx,rows})=>
          rx('rx_expected_seq_good')===frames && end.acknowledged===(start+frames-1)%1048576 && rows.at(-1)[9]==='空');
    }
    return results;
  }
};
