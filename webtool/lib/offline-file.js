(function () {
  var data = window.__DOCSIFY_OFFLINE_DATA__;
  if (!data || !data.content) {
    return;
  }

  // file:// 下直接读内嵌内容；http(s) 下先走原生请求，失败（如服务器屏蔽 .md
  // 文件或部署缺文件）时回退到内嵌内容，保证站点拷贝到任意环境都能打开。
  var content = data.content || {};
  var NativeXHR = window.XMLHttpRequest;

  function localKey(url) {
    var parsed;
    var base;
    var path;
    try {
      parsed = new URL(String(url), window.location.href);
      if (parsed.origin !== new URL(window.location.href).origin) {
        return null;
      }
      base = decodeURIComponent(new URL('.', window.location.href).pathname);
      path = decodeURIComponent(parsed.pathname);
    } catch (error) {
      return null;
    }
    if (path.indexOf(base) !== 0) {
      return null;
    }
    return path.slice(base.length).replace(/^\/+/, '');
  }

  function OfflineXHR() {
    this._listeners = {};
    this._native = null;
    this._key = null;
    this._mode = 'native';
    this._headers = {};
    this._aborted = false;
    this.readyState = 0;
    this.status = 0;
    this.statusText = '';
    this.response = null;
    this.responseText = '';
    this.responseType = '';
  }

  OfflineXHR.prototype.addEventListener = function (type, listener) {
    if (this._mode === 'native') {
      this._native.addEventListener(type, listener);
      return;
    }
    if (!this._listeners[type]) {
      this._listeners[type] = [];
    }
    this._listeners[type].push(listener);
  };

  OfflineXHR.prototype.removeEventListener = function (type, listener) {
    if (this._mode === 'native') {
      this._native.removeEventListener(type, listener);
      return;
    }
    this._listeners[type] = (this._listeners[type] || []).filter(function (item) {
      return item !== listener;
    });
  };

  OfflineXHR.prototype._emit = function (type) {
    var event = { type: type, target: this };
    (this._listeners[type] || []).slice().forEach(function (listener) {
      listener.call(this, event);
    }, this);
    if (typeof this['on' + type] === 'function') {
      this['on' + type].call(this, event);
    }
  };

  OfflineXHR.prototype._finish = function (status, statusText, text) {
    this.status = status;
    this.statusText = statusText;
    this.response = text;
    this.responseText = text;
    this.readyState = 4;
    this._emit('readystatechange');
    this._emit('load');
    this._emit('loadend');
  };

  OfflineXHR.prototype.open = function (method, url) {
    this._key = localKey(url);
    this._mode = this._key === null
      ? 'native'
      : (window.location.protocol === 'file:' ? 'embedded' : 'fallback');
    if (this._mode !== 'embedded') {
      this._native = new NativeXHR();
      this._native.open(method, url);
      return;
    }
    this._method = method;
    this._url = url;
    this.readyState = 1;
  };

  OfflineXHR.prototype.setRequestHeader = function (name, value) {
    if (this._mode === 'fallback') {
      this._headers[name] = value;
    } else if (this._mode === 'native') {
      this._native.setRequestHeader(name, value);
    }
  };

  OfflineXHR.prototype.getResponseHeader = function (name) {
    return this._mode !== 'embedded' && this._native ? this._native.getResponseHeader(name) : null;
  };

  OfflineXHR.prototype.send = function () {
    var self = this;
    if (this._mode === 'native') {
      this._native.send();
      return;
    }
    if (this._mode === 'embedded') {
      setTimeout(function () {
        var found;
        if (self._aborted) {
          return;
        }
        found = self._key !== null && Object.prototype.hasOwnProperty.call(content, self._key);
        self._finish(found ? 200 : 404, found ? 'OK' : 'Not Found', found ? content[self._key] : '');
      }, 0);
      return;
    }

    Object.keys(self._headers).forEach(function (name) {
      self._native.setRequestHeader(name, self._headers[name]);
    });
    self._native.addEventListener('load', function () {
      if (self._aborted) {
        return;
      }
      var status = self._native.status;
      if (status < 400) {
        self._finish(status, self._native.statusText, self._native.responseText);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(content, self._key)) {
        self._finish(200, 'OK', content[self._key]);
        return;
      }
      self._finish(status, self._native.statusText, self._native.responseText);
    });
    self._native.addEventListener('error', function () {
      if (self._aborted) {
        return;
      }
      if (Object.prototype.hasOwnProperty.call(content, self._key)) {
        self._finish(200, 'OK', content[self._key]);
        return;
      }
      self._emit('error');
    });
    self._native.send();
  };

  OfflineXHR.prototype.abort = function () {
    this._aborted = true;
    if (this._mode !== 'embedded' && this._native) {
      this._native.abort();
    }
  };

  window.XMLHttpRequest = OfflineXHR;
}());
