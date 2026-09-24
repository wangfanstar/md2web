(function () {
  'use strict';
  var root = document.querySelector('[data-trash-root]');
  var status = document.querySelector('[data-status]');
  var csrf = '';
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]); }); }
  function setStatus(text, error) { status.hidden = !text; status.className = 'status' + (error ? ' error' : ' ok'); status.textContent = text || ''; }
  function api(path, options) {
    options = options || {}; var headers = Object.assign({'Content-Type':'application/json'}, options.headers || {});
    if (csrf) headers['X-CSRF-Token'] = csrf;
    return fetch(path, Object.assign({}, options, {headers:headers})).then(function (r) { return r.json().catch(function () { return {}; }).then(function (p) { if (!r.ok || p.ok === false) throw new Error(p.error || ('HTTP ' + r.status)); return p; }); });
  }
  function opId() { var a = new Uint8Array(16); if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a); else for (var i=0;i<a.length;i++) a[i]=Math.floor(Math.random()*256); return Array.prototype.map.call(a,function (x) { return ('0'+x.toString(16)).slice(-2); }).join(''); }
  function mountFromQuery() { var m = new URLSearchParams(location.search).get('mount'); return m ? m.replace(/\\/g,'/').replace(/\/$/,'') : 'md'; }
  function loadMount(mount) { return api('__trash?mount=' + encodeURIComponent(mount)).then(function (p) { return {mount:mount, entries:p.entries || []}; }); }
  function renderSection(data) {
    var m = data.mount, title = m === 'md' ? '全部仓库' : m.replace(/^md\//,'');
    var rows = data.entries.map(function (e) { return '<div class="trash-item"><div class="item-main"><div class="item-name">' + esc(e.path || e.name) + '</div><div class="item-meta">' + esc(e.kind === 'folder' ? '文件夹' : 'Markdown 文档') + ' · 删除于 ' + esc(e.deletedAt || '') + (e.assets && e.assets.length ? ' · 附件 ' + e.assets.length + ' 个' : '') + '</div></div><div class="actions"><button data-restore="' + esc(m) + '" data-entry="' + esc(e.id) + '">恢复</button><button class="danger" data-remove="' + esc(m) + '" data-entry="' + esc(e.id) + '">永久删除</button></div></div>'; }).join('');
    return '<section class="panel"><div class="panel-head"><h2>' + esc(title) + '</h2><div class="actions">' + (data.entries.length ? '<button class="danger" data-empty="' + esc(m) + '">清空回收站</button>' : '') + '</div></div>' + (rows || '<div class="empty">回收站为空</div>') + '</section>';
  }
  function renderAll(data) { root.innerHTML = data.map(renderSection).join('') || '<section class="panel empty">没有可显示的回收站。</section>'; }
  function discoverMounts() {
    var selected = mountFromQuery();
    if (selected !== 'md') return Promise.resolve([selected]);
    return api('__folders').then(function (p) { var mounts = ['md']; (p.folders || []).forEach(function (f) { var m = f.mount || f.path; if (m && mounts.indexOf(m) < 0) mounts.push(m); }); return mounts; }).catch(function () { return ['md']; });
  }
  function reload() {
    if (!window.SiteAuth || !SiteAuth.isAuthenticated()) { root.innerHTML = '<section class="panel login">请先登录 SVN 账号后查看和操作回收站。页面顶部的登录入口由站点设置提供。</section>'; return; }
    csrf = SiteAuth.csrfToken() || ''; root.innerHTML = '<p class="hint">正在读取回收站…</p>';
    discoverMounts().then(function (mounts) { return Promise.all(mounts.map(loadMount)); }).then(renderAll).catch(function (e) { root.innerHTML = ''; setStatus(e.message, true); });
  }
  function mutate(action, mount, entry) {
    var message = action === 'restore' ? '确认恢复这个条目？' : '确认永久删除这个条目？该操作不可恢复。';
    if (!window.confirm(message)) return;
    var body = {operationId:opId(), mount:mount}; if (entry) body.entryId = entry;
    api(action === 'restore' ? '__md/restore' : '__md/trash-empty', {method:'POST', body:JSON.stringify(body)}).then(function () { setStatus(action === 'restore' ? '已恢复。' : '已永久删除。', false); reload(); }).catch(function (e) { setStatus(e.message, true); });
  }
  document.addEventListener('click', function (e) { var n=e.target; if (n.getAttribute('data-action')==='reload') reload(); else if (n.hasAttribute('data-restore')) mutate('restore',n.getAttribute('data-restore'),n.getAttribute('data-entry')); else if (n.hasAttribute('data-remove')) mutate('remove',n.getAttribute('data-remove'),n.getAttribute('data-entry')); else if (n.hasAttribute('data-empty')) { if (window.confirm('确认清空这个回收站？该操作不可恢复。')) mutate('empty',n.getAttribute('data-empty'),''); } });
  function init() { if (window.SiteAuth) SiteAuth.refresh().then(reload).catch(reload); else reload(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());
