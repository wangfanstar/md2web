(function(root){
  'use strict';
  function copy(value){return JSON.parse(JSON.stringify(value));}
  function flatten(value,path,result){
    if(value&&typeof value==='object'&&Object.keys(value).length){
      Object.keys(value).sort().forEach(function(key){if(key!=='expectedConfigVersion')flatten(value[key],path?path+'.'+key:key,result);});
    }else result[path]=JSON.stringify(value);
    return result;
  }
  function Draft(value){this.accept(value);}
  Draft.prototype.accept=function(value){this.base=copy(value);this.current=copy(value);};
  Draft.prototype.update=function(value){this.current=copy(value);};
  Draft.prototype.value=function(){return copy(this.current);};
  Draft.prototype.reset=function(){this.current=copy(this.base);return this.value();};
  Draft.prototype.changes=function(){
    var before=flatten(this.base,'',{}),after=flatten(this.current,'',{}),keys=Object.keys(before);
    Object.keys(after).forEach(function(k){if(keys.indexOf(k)<0)keys.push(k);});
    return keys.filter(function(k){return before[k]!==after[k];}).map(function(k){
      var secret=/password|apiKey|secret|credentials/i.test(k);
      return {path:k,before:secret?'（隐藏）':before[k],after:secret?'（已修改）':after[k]};
    });
  };
  Draft.prototype.dirty=function(){return this.changes().length>0;};
  if(typeof module!=='undefined')module.exports=Draft;else root.ConfigDraft=Draft;
})(typeof window!=='undefined'?window:this);
