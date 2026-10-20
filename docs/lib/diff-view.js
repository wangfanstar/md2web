(function () {
  'use strict';
  var active = null;
  function node(tag, text, parent) { var el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(parent)parent.appendChild(el);return el; }
  function open(left,right,options) {
    if(active)active();
    options=options||{};
    var overlay=node('div');overlay.className='diff-view';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-label','版本对比');document.body.appendChild(overlay);
    var bar=node('div',undefined,overlay);bar.className='diff-toolbar';
    var worker=null,timer=null,rows=[],changes=[],selected=-1,inline=false,only=false,wrap=false,ignore=false;
    var leftSelect=node('select',undefined,bar),rightSelect=node('select',undefined,bar);
    var versions=options.versions||[{ref:left.ref||'left',label:left.label||'左版本'},{ref:right.ref||'right',label:right.label||'右版本'}];
    [leftSelect,rightSelect].forEach(function(select){versions.forEach(function(v){var o=node('option',v.label,select);o.value=v.ref;});});
    leftSelect.value=left.ref||'left';rightSelect.value=right.ref||'right';
    function stop(){if(worker)worker.terminate();worker=null;clearTimeout(timer);}
    function close(){stop();overlay.remove();document.removeEventListener('keydown',escape);active=null;}
    function escape(e){if(e.key==='Escape'){e.stopImmediatePropagation();close();}}
    document.addEventListener('keydown',escape);active=close;
    function button(label,fn){var b=node('button',label,bar);b.type='button';b.onclick=fn;return b;}
    button('交换',function(){var temp=left;left=right;right=temp;leftSelect.value=left.ref;rightSelect.value=right.ref;calculate();});
    function jump(delta){if(!changes.length)return;selected=(selected+delta+changes.length)%changes.length;viewport.scrollTop=changes[selected]*24;render();}
    button('上一差异',function(){jump(-1);});button('下一差异',function(){jump(1);});
    function toggle(label,fn){var l=node('label',undefined,bar),c=node('input',undefined,l);c.type='checkbox';node('span',label,l);c.onchange=function(){fn(c.checked);};}
    toggle('仅看差异',function(v){only=v;viewport.scrollTop=0;render();});
    toggle('忽略空白',function(v){ignore=v;calculate();});
    toggle('自动换行',function(v){wrap=v;render();});
    function download(text,name){var url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));var a=node('a');a.href=url;a.download=name;a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);}
    button('下载左侧原文',function(){download(left.content,'left.md');});button('下载右侧原文',function(){download(right.content,'right.md');});
    button('Unified diff',function(){var text='--- '+left.label+'\n+++ '+right.label+'\n@@ -1,'+left.content.split('\n').length+' +1,'+right.content.split('\n').length+' @@\n';rows.forEach(function(r){if(r.kind==='equal')text+=' '+r.left+'\n';else {if(r.left!==null)text+='-'+r.left+'\n';if(r.right!==null)text+='+'+r.right+'\n';}});download(text,'comparison.diff');});
    button('关闭',close);
    var status=node('p','正在计算…',overlay),heads=node('div',undefined,overlay);heads.className='diff-heads';
    var lh=node('strong','',heads),rh=node('strong','',heads);
    var viewport=node('div',undefined,overlay);viewport.className='diff-viewport';
    var canvas=node('div',undefined,viewport);viewport.onscroll=function(){if(!wrap)render();};
    function cell(parent,text,other,number,kind){var cell=node('div',undefined,parent);cell.className='diff-cell '+kind;node('span',String(number),cell).className='diff-line-number';var code=node('code',undefined,cell);
      if(text===null)return;
      if(!inline||kind!=='change'||other===null||text.length>10000){code.textContent=text;return;}
      var prefix=0,end=0;while(prefix<text.length&&prefix<other.length&&text[prefix]===other[prefix])prefix++;
      while(end<text.length-prefix&&end<other.length-prefix&&text[text.length-1-end]===other[other.length-1-end])end++;
      code.appendChild(document.createTextNode(text.slice(0,prefix)));node('mark',text.slice(prefix,text.length-end),code);code.appendChild(document.createTextNode(text.slice(text.length-end)));
    }
    function render(){var visible=only?rows.filter(function(r){return r.kind!=='equal';}):rows;
      // Fixed-height virtual rows; wrapping is limited to a bounded window, preserving alignment.
      var start=Math.max(0,Math.floor(viewport.scrollTop/24)-10),end=Math.min(visible.length,start+Math.ceil(viewport.clientHeight/24)+30);
      if(wrap){start=Math.max(0,selected>=0?changes[selected]-3:0);end=Math.min(visible.length,start+200);}
      canvas.textContent='';canvas.style.height=wrap?'auto':visible.length*24+'px';canvas.className=wrap?'is-wrap':'';
      var block=node('div',undefined,canvas);block.style.transform=wrap?'':'translateY('+start*24+'px)';
      for(var i=start;i<end;i++){var r=visible[i],row=node('div',undefined,block);row.className='diff-row';cell(row,r.left,r.right,r.ln,r.kind);cell(row,r.right,r.left,r.rn,r.kind);}
      if(wrap)node('p','换行模式显示当前位置起 200 行；关闭自动换行可滚动完整文档。',canvas);
    }
    function fallback(){stop();rows=[];status.textContent='大文件模式：超过交互阈值或计算预算，请下载两侧完整原文查看。';canvas.textContent='';}
    function calculate(){stop();status.textContent='正在计算…';lh.textContent=left.label;rh.textContent=right.label;
      try{worker=new Worker(new URL('lib/diff-worker.js',document.baseURI).href);}catch(e){fallback();return;}
      timer=setTimeout(fallback,(options.workerBudgetMs||1500)+1000);
      worker.onmessage=function(e){stop();if(e.data.fallback){fallback();return;}rows=e.data.rows;changes=e.data.changes;inline=e.data.inline;selected=-1;
        status.textContent=changes.length+' 处差异 · '+rows.filter(function(r){return r.kind==='add';}).length+' 行新增 / '+rows.filter(function(r){return r.kind==='delete';}).length+' 行删除';viewport.scrollTop=0;render();};
      worker.onerror=fallback;worker.postMessage({left:left.content,right:right.content,options:Object.assign({},options,{versions:undefined,load:undefined,ignoreWhitespace:ignore})});
    }
    var generation=0;
    function load(){if(!options.load)return;var current=++generation;status.textContent='读取版本…';options.load(leftSelect.value,rightSelect.value).then(function(data){if(current!==generation)return;left=data.left;right=data.right;calculate();}).catch(function(e){status.textContent=e.message;});}
    leftSelect.onchange=rightSelect.onchange=load;calculate();
  }
  window.DiffView={open:open};
})();
