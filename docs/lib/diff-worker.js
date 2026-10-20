(function (root) {
  'use strict';
  function compare(left, right, options) {
    options = options || {};
    var max = options.maxInteractiveBytes || 5242880;
    if (new TextEncoder().encode(left).length > max || new TextEncoder().encode(right).length > max) return {fallback:true};
    var a = left.replace(/\r\n/g, '\n').split('\n'), b = right.replace(/\r\n/g, '\n').split('\n');
    if (Math.max(a.length,b.length) > (options.maxInteractiveLines || 50000)) return {fallback:true};
    var normalize = function (s) { return options.ignoreWhitespace ? s.replace(/\s+/g,' ').trim() : s; };
    var aa = a.map(normalize), bb = b.map(normalize);
    var start = Date.now(), v = new Map([[1,0]]), trace = [], edits = null;
    outer: for (var d=0; d<=a.length+b.length; d++) {
      if (d>1400 || Date.now()-start > (options.workerBudgetMs || 1500)) return {fallback:true};
      trace.push(new Map(v));
      for (var k=-d;k<=d;k+=2) {
        var x = k===-d || (k!==d && (v.get(k-1)||0)<(v.get(k+1)||0)) ? (v.get(k+1)||0) : (v.get(k-1)||0)+1;
        var y=x-k;
        while(x<a.length && y<b.length && aa[x]===bb[y]) { x++; y++; }
        v.set(k,x);
        if(x>=a.length && y>=b.length) {
          edits=[];
          for(var depth=d;depth>=0;depth--) {
            var prior=trace[depth], diagonal=x-y;
            var pk=diagonal===-depth || (diagonal!==depth && (prior.get(diagonal-1)||0)<(prior.get(diagonal+1)||0)) ? diagonal+1 : diagonal-1;
            var px=prior.get(pk)||0, py=px-pk;
            while(x>px && y>py) { edits.push({left:a[--x],right:b[--y],kind:'equal'}); }
            if(depth===0) break;
            if(x===px) edits.push({left:null,right:b[--y],kind:'add'});
            else edits.push({left:a[--x],right:null,kind:'delete'});
          }
          edits.reverse(); break outer;
        }
      }
    }
    var rows=[], deleted=[], added=[];
    function flush() {
      for(var i=0;i<Math.max(deleted.length,added.length);i++) rows.push({left:i<deleted.length?deleted[i]:null,
        right:i<added.length?added[i]:null,kind:i<deleted.length&&i<added.length?'change':i<deleted.length?'delete':'add'});
      deleted=[]; added=[];
    }
    edits.forEach(function(e){ if(e.kind==='equal'){flush();rows.push(e);} else if(e.left!==null) deleted.push(e.left);else added.push(e.right); });
    flush();
    var ln=0,rn=0,changes=[];
    rows.forEach(function(r,i){r.ln=r.left===null?'':++ln;r.rn=r.right===null?'':++rn;if(r.kind!=='equal'&&(i===0||rows[i-1].kind==='equal'))changes.push(i);});
    return {rows:rows,changes:changes,inline:Math.max(left.length,right.length)<=1048576&&Math.max(a.length,b.length)<=10000};
  }
  if(typeof module!=='undefined') module.exports={compare:compare};
  else root.onmessage=function(e){try {root.postMessage(compare(e.data.left,e.data.right,e.data.options));}catch(error){root.postMessage({fallback:true,error:error.message});}};
})(typeof self!=='undefined'?self:this);
