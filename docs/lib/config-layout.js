(function () {
  'use strict';
  var bridge, active='repositories', loadedUsers=false, loadedTrash=false, focusReturn=null, saving=false, locked=[];
  function q(s,r){return (r||document).querySelector(s);}
  function all(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));}
  function route(){
    var hash=location.hash.slice(1), legacy={repositories:'repositories','repository-trash':'backup','admin-login':'repositories'};
    if(legacy[hash])return {tab:legacy[hash],section:hash==='repository-trash'?hash:''};
    var p=new URLSearchParams(hash);return {tab:p.get('tab')||'repositories',section:p.get('section'),repo:p.get('repo')};
  }
  function navigate(tab,section){var hash='#tab='+tab+(section?'&section='+encodeURIComponent(section):'');history.pushState(null,'',hash);activate();}
  function closeDrawer(){var drawer=q('[data-repo-drawer]'),row=q('[data-pair-detail]',drawer);if(row){row.hidden=true;q('[data-repo-rows]').appendChild(row);}if(drawer.open)drawer.close();if(focusReturn&&focusReturn.isConnected)focusReturn.focus();}
  function openDrawer(row,button){
    closeDrawer();var detail=q('[data-pair-detail="'+row.getAttribute('data-pair')+'"]');if(!detail)return;
    focusReturn=button||q('[data-edit-repo]',row);detail.hidden=false;q('[data-drawer-body]').appendChild(detail);
    q('#repo-drawer-title').textContent=(q('[data-repo-label]',row)||row).textContent.trim()+' · 设置';
    q('[data-drawer-status]').hidden=true;q('[data-repo-drawer]').showModal();
    var p=new URLSearchParams(location.hash.slice(1));p.set('tab','repositories');p.set('repo',row.getAttribute('data-saved-id')||row.getAttribute('data-mount')||row.getAttribute('data-pair'));history.replaceState(null,'','#'+p.toString());
  }
  function activate(){
    if(!bridge)return;var r=route(),allowed=bridge.state.editable;
    if(['repositories','accounts','records','backup','ai','performance','profiles'].indexOf(r.tab)<0||(!allowed&&r.tab!=='repositories'))r.tab='repositories';
    if(active!==r.tab)closeDrawer();active=r.tab;
    all('[data-config-tab]').forEach(function(b){var selected=b.dataset.configTab===active;b.hidden=!allowed&&b.dataset.configTab!=='repositories';b.setAttribute('aria-selected',String(selected));b.tabIndex=selected?0:-1;});
    all('[data-config-tab-panel]').forEach(function(p){p.hidden=p.dataset.configTabPanel!==active;});
    if(allowed&&active==='records'&&bridge.loadRecords)bridge.loadRecords(true);
    if(allowed&&active==='accounts'&&!loadedUsers&&bridge.loadUsers){loadedUsers=true;bridge.loadUsers();}
    if(allowed&&active==='backup'&&r.section==='repository-trash'&&bridge.loadTrash&&!loadedTrash){loadedTrash=true;bridge.loadTrash();}
    if(r.section){var anchor=document.getElementById(r.section);if(anchor)setTimeout(function(){anchor.scrollIntoView({block:'start'});},0);}
    if(active==='repositories'&&r.repo&&!q('[data-repo-drawer]').open){var row=all('[data-repo-row]').filter(function(x){return [x.getAttribute('data-saved-id'),x.getAttribute('data-mount'),x.getAttribute('data-pair')].indexOf(r.repo)>=0;})[0];if(row)openDrawer(row);}
  }
  function notify(text,error){
    var drawer=q('[data-repo-drawer]'),node=drawer.open?q('[data-drawer-status]'):q('[data-tab-status="'+active+'"]');
    node.hidden=!text;node.className='status '+(error?'error':'ok');node.textContent=text||'';
    var notice=q('[data-config-notice]');notice.hidden=true;notice.textContent=text||'';
  }
  function credentialFields(){return all('[data-repo="credUsername"], [data-repo="credPassword"], [data-default="username"], [data-default="password"], [data-site-credential]');}
  function credentialKey(node){var detail=node.closest('[data-pair-detail]'),owner='global';if(detail){var row=q('[data-repo-row][data-pair="'+detail.getAttribute('data-pair-detail')+'"]');owner=row?row.getAttribute('data-mount'):'';}return owner+'|'+(node.getAttribute('data-repo')||node.getAttribute('data-default')||'backup-'+node.getAttribute('data-site-credential'));}
  function trackCredentials(){var dirty=false;credentialFields().forEach(function(n){if(n.dataset.credentialInitial===undefined)n.dataset.credentialInitial=n.value;if(n.value!==n.dataset.credentialInitial)dirty=true;});bridge.state.pendingCredentials=dirty;}
  function update(){
    if(!bridge)return;trackCredentials();var s=bridge.state,changes=s.draft?s.draft.changes():[],names={repositories:'仓库管理',folderGroups:'仓库管理',auth:'账号与权限',ai:'AI 设置',cache:'缓存与性能',siteBackup:'备份与恢复'};
    var counts={};changes.forEach(function(c){var name=names[c.path.split('.')[0]]||'配置方案';counts[name]=(counts[name]||0)+1;});
    q('[data-config-savebar]').hidden=(!changes.length&&!s.jsonDirty&&!s.pendingCredentials&&!saving)||!s.editable;
    document.body.classList.toggle('config-has-draft',!q('[data-config-savebar]').hidden);
    q('[data-config-dirty-label]').textContent=saving?'正在保存配置…':s.jsonDirty?'JSON 有未保存修改，请在配置方案中应用':Object.keys(counts).map(function(k){return k+' '+counts[k]+' 项';}).join('、')+(s.pendingCredentials?' · 同步凭据需单独验证保存':'');
    q('[data-config-savebar] [data-action="save"]').disabled=saving||!!s.jsonDirty||!s.editable||!changes.length;
    q('[data-config-profile-label]').textContent='当前配置：'+((s.config||{}).profileName||'未加载')+(changes.length?' · 有待保存修改':' · 已保存');
    q('[data-config-identity]').textContent=s.user?s.user.username+' · '+(s.user.role==='admin'?'管理员':'普通用户'):'未登录';
    q('[data-header-logout]').hidden=!s.user;
    q('[data-local-password]').hidden=!s.editable||!s.user||s.user.authSourceId!=='local-admin';
  }
  function filter(){var search=q('[data-repo-search]').value.toLowerCase(),type=q('[data-repo-filter]').value,group=q('[data-repo-group]').value,status=q('[data-repo-status]').value,total=0,visible=0;
    all('[data-repo-row]').forEach(function(row){total++;var mode=row.dataset.sourceMode||'',badge=q('[data-health-badge]',row),level=!row.dataset.savedId?'pending':badge&&/is-error|is-warn/.test(badge.className)?'warning':'ok';row.hidden=(!!search&&row.textContent.toLowerCase().indexOf(search)<0)||(!!type&&mode!==type)||(!!group&&q('[data-group-label]',row).textContent!==group)||(!!status&&level!==status);if(!row.hidden)visible++;});q('[data-repo-count]').textContent=visible+' / '+total+' 个仓库';
  }
  function review(){var host=q('[data-config-review-content]');host.textContent='';var changes=bridge.state.draft?bridge.state.draft.changes():[];changes.forEach(function(c){var p=document.createElement('p');p.textContent=c.path+'：'+(c.before||'未设置')+' → '+(c.after||'移除');host.appendChild(p);});if(!changes.length)host.textContent='没有普通表单修改。';q('[data-config-review-dialog]').showModal();}
  function synchronize(){if(!bridge||!bridge.state.editable||bridge.state.jsonDirty)return;bridge.capture();update();}
  function clearPrivate(){if(bridge.clearRecords)bridge.clearRecords();all('input[type="password"], [data-profile-json], [data-users-list], [data-records-content], [data-config-review-content]').forEach(function(n){if('value' in n)n.value='';else n.textContent='';});credentialFields().forEach(function(n){n.dataset.credentialInitial=n.value;});bridge.state.pendingCredentials=false;loadedUsers=false;loadedTrash=false;closeDrawer();if(q('[data-config-review-dialog]').open)q('[data-config-review-dialog]').close();}
  function connect(value){bridge=value;
    all('[data-config-tab]').forEach(function(button){button.onclick=function(){navigate(button.dataset.configTab);};button.onkeydown=function(e){var list=all('[data-config-tab]').filter(function(b){return !b.hidden;}),i=list.indexOf(button),next=e.key==='Home'?0:e.key==='End'?list.length-1:e.key==='ArrowRight'?(i+1)%list.length:e.key==='ArrowLeft'?(i+list.length-1)%list.length:-1;if(next<0)return;e.preventDefault();list[next].focus();navigate(list[next].dataset.configTab);};});
    all('[data-drawer-close]').forEach(function(b){b.onclick=function(){closeDrawer();history.replaceState(null,'','#tab=repositories');};});q('[data-repo-drawer]').addEventListener('cancel',function(e){e.preventDefault();closeDrawer();history.replaceState(null,'','#tab=repositories');});
    q('[data-config-review]').onclick=review;q('[data-review-close]').onclick=function(){q('[data-config-review-dialog]').close();};
    q('[data-config-latest]').onclick=function(){bridge.latest().catch(function(error){notify(error.message,true);});};
    q('[data-config-discard]').onclick=function(){if(confirm('放弃所有尚未保存的表单与 JSON 修改？'))bridge.discard();};
    var cancelJson=q('[data-json-cancel]');if(cancelJson)cancelJson.onclick=function(){if(bridge.state.jsonDirty&&!confirm('放弃 JSON 中未应用的修改？'))return;bridge.state.jsonDirty=false;q('[data-profile-json]').value='';window.ConfigLayout.jsonMode(false);update();};
    q('[data-repo-search]').oninput=filter;q('[data-repo-filter]').onchange=filter;
    q('[data-repo-group]').onchange=filter;q('[data-repo-status]').onchange=filter;
    document.addEventListener('input',function(e){if(e.target.closest('[data-config-tab-panel], [data-repo-drawer]')){synchronize();if(e.target.matches('[data-profile-json]'))update();}});
    document.addEventListener('change',function(e){if(e.target.closest('[data-config-tab-panel], [data-repo-drawer]'))synchronize();});
    document.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;
      if(saving&&(b.hasAttribute('data-action')||b.hasAttribute('data-user-save')||b.hasAttribute('data-user-revoke')||b.hasAttribute('data-rename-repository'))){e.preventDefault();e.stopImmediatePropagation();return;}
      var edit=b.closest('[data-edit-repo]');if(edit){openDrawer(edit.closest('[data-repo-row]'),edit);return;}
      var action=b.getAttribute('data-action')||'',immediate=/^(profile-(select|reload|create|restore)|auth-save|default-credential|repo-credential|site-credential|site-backup-now|sync|provision|repair|recreate|delete-repo|restore-repo|link-create|link-remove|verify-switch|logout)/.test(action)||b.hasAttribute('data-user-save')||b.hasAttribute('data-user-revoke')||b.hasAttribute('data-rename-repository');
      if(immediate&&(bridge.state.jsonEditing||bridge.state.dirty||bridge.state.jsonDirty||(bridge.state.pendingCredentials&&!/^(repo-credential|default-credential|site-credential)$/.test(action)))){e.preventDefault();e.stopImmediatePropagation();notify('此操作立即生效。请先保存或放弃底部列出的待保存修改，再执行操作。',true);}
    },true);
    window.addEventListener('hashchange',activate);window.addEventListener('popstate',activate);
    q('[data-local-password-save]').onclick=function(){bridge.changePassword(q('[data-current-password]').value,q('[data-new-password]').value).then(function(){q('[data-current-password]').value='';q('[data-new-password]').value='';notify('密码已修改，请重新登录。');}).catch(function(e){notify(e.message,true);});};
    activate();update();
  }
  window.ConfigLayout={connect:connect,refresh:function(){activate();update();},update:update,notify:notify,navigate:navigate,
    credentialSaved:function(root){credentialFields().filter(function(n){return !root||root.contains(n);}).forEach(function(n){n.dataset.credentialInitial=n.value;});update();},
    snapshotCredentials:function(){return credentialFields().map(function(n){return {key:credentialKey(n),value:n.value,initial:n.dataset.credentialInitial};});},
    restoreCredentials:function(saved){credentialFields().forEach(function(n){var item=(saved||[]).filter(function(x){return x.key===credentialKey(n);})[0];if(item){n.value=item.value;n.dataset.credentialInitial=item.initial===undefined?item.value:item.initial;}});update();},
    preview:function(data,name,compareDraft){var comparison=new window.ConfigDraft(compareDraft&&bridge.state.draft?bridge.state.draft.value():bridge.state.config),next=Object.assign({},bridge.state.config,data);delete next.schemaVersion;comparison.update(next);var host=q('[data-config-review-content]');host.textContent=compareDraft?'当前未保存内容 → 服务器最新配置（仅比较，编辑仍保留）：':'方案 '+name+' 相对当前已保存配置的差异（仅预览，不会应用）：';comparison.changes().forEach(function(c){var p=document.createElement('p');p.textContent=c.path+'：'+(c.before||'未设置')+' → '+(c.after||'移除');host.appendChild(p);});q('[data-config-review-dialog]').showModal();},
    beforeRender:closeDrawer,repositoriesRendered:function(){var select=q('[data-repo-group]'),value=select.value,groups=[];all('[data-group-label]').forEach(function(n){if(groups.indexOf(n.textContent)<0)groups.push(n.textContent);});select.textContent='';var first=document.createElement('option');first.value='';first.textContent='全部分组';select.appendChild(first);groups.sort().forEach(function(g){var o=document.createElement('option');o.value=g;o.textContent=g;select.appendChild(o);});select.value=groups.indexOf(value)>=0?value:'';filter();activate();},clearPrivate:clearPrivate,
    clearStatus:function(){all('[data-tab-status], [data-status], [data-profile-status], [data-config-notice], [data-drawer-status]').forEach(function(n){n.hidden=true;n.textContent='';});},
    saving:function(value){saving=value;if(value){locked=all('[data-repo], [data-folder-group], [data-ai], [data-site-backup], [data-policy], [data-auth], [data-default], [data-site-credential], [data-profile-json]').map(function(n){var item={node:n,disabled:n.disabled};n.disabled=true;return item;});}else{locked.forEach(function(item){if(item.node.isConnected)item.node.disabled=item.disabled||!bridge.state.editable;});locked=[];}update();},capture:synchronize,openNew:function(){var rows=all('[data-repo-row]');if(rows.length)openDrawer(rows[rows.length-1]);},
    jsonMode:function(value){bridge.state.jsonEditing=value;all('[data-repo], [data-folder-group], [data-ai], [data-site-backup], [data-policy], [data-auth="url"], [data-default], [data-site-credential] ').forEach(function(n){n.disabled=value||!bridge.state.editable;});}};
})();

