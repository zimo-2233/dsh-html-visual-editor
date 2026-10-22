/* React is supplied by the enclosing client-plugin factory. No source editor. */
const HV_CHANNEL = 'dsh-html-visual';
const HV_MAX_EDITABLE = 5 * 1024 * 1024;
const HV_MAX_WRITE = 8 * 1024 * 1024;
// Session-local recovery only: never localStorage, disk, or an autosave request.
const hvDrafts = new Map();

function hvKey(scope, path) {
  return JSON.stringify([scope && scope.sessionId, path]);
}
function hvBytes(text) {
  return new TextEncoder().encode(text).length;
}
function hvToken() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
}
function hvHtmlRoute(scope, path) {
  let absolute = String(path || '').replace(/\\/g, '/');
  if (!/^(?:\/|[a-z]:\/|~(?:\/|$))/i.test(absolute)) {
    absolute = String(scope.cwd || '').replace(/\\/g, '/').replace(/\/$/, '') + '/' + absolute;
  }
  const unc = absolute.startsWith('//');
  const parts = absolute.split('/').filter(Boolean);
  const normalized = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..' && normalized.length > 0 && !/^[a-z]:$/i.test(normalized[normalized.length - 1])) normalized.pop();
    else if (part !== '..') normalized.push(part);
  }
  return 'sidebar/html/' + encodeURIComponent(scope.sessionId) + '/' + (unc ? '/' : '') + normalized.map(encodeURIComponent).join('/');
}
async function hvReadEnvelope(response) {
  const parsed = await response.json().catch(() => null);
  if (!response.ok || !parsed || parsed.ok !== true || parsed.value === undefined) {
    const error = new Error(parsed && parsed.error && parsed.error.message || 'HTTP ' + response.status);
    error.code = parsed && parsed.error && parsed.error.code || 'http';
    error.status = response.status;
    throw error;
  }
  return parsed.value;
}
function hvWriteUrl(service, basis) {
  const params = new URLSearchParams({ sessionId: basis.scope.sessionId, path: basis.path, expectedMtimeMs: String(basis.mtime) });
  if (basis.scope.cwd) params.set('cwd', basis.scope.cwd);
  return service.hostRouteUrl('sidebar/write?' + params.toString());
}
function hvRemember(basis, bodyHtml, mode) {
  if (!basis || typeof basis.source !== 'string') return;
  const html = mergeVisualBody(basis.source, bodyHtml);
  hvDrafts.delete(basis.key);
  hvDrafts.set(basis.key, { html, original: basis.source, mtime: basis.mtime, mode, bodyHtml });
  while (hvDrafts.size > 5) hvDrafts.delete(hvDrafts.keys().next().value);
}
// The sidebar service is provided by dsh-better-sidebar. It is reachable as a
// direct property on the host scope and through the service registry.
function hvSidebarService(ctx) {
  if (!ctx) return undefined;
  if (ctx.betterSidebar) return ctx.betterSidebar;
  try { return typeof ctx.get === 'function' ? ctx.get('betterSidebar') : undefined; }
  catch (_) { return undefined; }
}
function hvDownload(html, path, suffix) {
  const basename = String(path || 'document.html').split(/[\\/]/).pop() || 'document.html';
  const stem = basename.replace(/\.html?$/i, '');
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = stem + suffix + '.html';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function VisualEditor(props) {
  const iframeRef = useRef(null);
  const portRef = useRef(null);
  const frameLoadCountRef = useRef(0);
  const navigationBlockedRef = useRef(false);
  const bootstrapStartedRef = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;
  const basisRef = useRef(null);
  const tokenRef = useRef('');
  const mountedRef = useRef(false);
  const readyRef = useRef(false);
  const dirtyRef = useRef(false);
  const modeRef = useRef('preview');
  const pendingModeRef = useRef(null);
  const savingRef = useRef(false);
  const saveRef = useRef(null);
  const pendingExternalRef = useRef(null);
  const requestsRef = useRef(new Map());
  const requestSeqRef = useRef(0);
  const revisionRef = useRef(0);
  const cacheTimerRef = useRef(null);
  const loadedInputRef = useRef(null);
  const [srcDoc, setSrcDoc] = useState('');
  const [mode, setModeState] = useState('preview');
  const [dirty, setDirty] = useState(false);
  const [ready, setReady] = useState(false);
  const [large, setLarge] = useState(false);
  const [saveState, setSaveState] = useState('idle');
  const [notice, setNotice] = useState('正在载入可视化预览…');
  const [externalPending, setExternalPending] = useState(false);
  const [hasMtime, setHasMtime] = useState(false);

  const reportError = useCallback(error => {
    if (mountedRef.current) setNotice(error instanceof Error ? error.message : String(error));
  }, []);
  const rejectRequests = useCallback(reason => {
    for (const request of requestsRef.current.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    requestsRef.current.clear();
  }, []);
  const disconnect = useCallback(reason => {
    const port = portRef.current;
    portRef.current = null;
    if (port) {
      port.onmessage = null;
      port.onmessageerror = null;
      port.close();
    }
    readyRef.current = false;
    pendingModeRef.current = null;
    if (mountedRef.current) setReady(false);
    rejectRequests(reason);
  }, [rejectRequests]);
  const post = useCallback((command, value, requestId) => {
    const port = portRef.current;
    if (!port || !readyRef.current || navigationBlockedRef.current) throw new Error('预览尚未就绪或已发生导航；请重新载入。');
    // A transferred port belongs to one Document, not its reusable WindowProxy.
    // Never send commands or secrets to iframe.contentWindow with target '*'.
    port.postMessage({ channel: HV_CHANNEL, token: tokenRef.current, command, value, requestId });
  }, []);
  const serialize = useCallback(() => new Promise((resolve, reject) => {
    const requestId = 'visual-' + (++requestSeqRef.current);
    const timer = setTimeout(() => {
      requestsRef.current.delete(requestId);
      reject(new Error('读取可视化草稿超时；未写入文件。请重试或导出已缓存草稿。'));
    }, 10000);
    requestsRef.current.set(requestId, { resolve, reject, timer });
    try { post('serialize', undefined, requestId); }
    catch (error) {
      clearTimeout(timer);
      requestsRef.current.delete(requestId);
      reject(error);
    }
  }), [post]);

  const loadSnapshot = useCallback((input, allowRecovery) => {
    disconnect('文档已重新载入。');
    frameLoadCountRef.current = 0;
    navigationBlockedRef.current = false;
    bootstrapStartedRef.current = false;
    clearTimeout(cacheTimerRef.current);
    pendingExternalRef.current = null;
    setExternalPending(false);
    readyRef.current = false;
    setReady(false);
    dirtyRef.current = false;
    setDirty(false);
    revisionRef.current++;
    setSaveState('idle');
    const key = hvKey(input.scope, input.path);
    const oversized = !!input.largeFile || (typeof input.content === 'string' && hvBytes(input.content) > HV_MAX_EDITABLE);
    setLarge(oversized);
    const cached = allowRecovery && !oversized ? hvDrafts.get(key) : null;
    const currentMtime = typeof input.mtimeMs === 'number' && Number.isFinite(input.mtimeMs) ? input.mtimeMs : null;
    const basis = {
      key, path: input.path, scope: { ...input.scope }, source: input.content,
      mtime: currentMtime, backup: input.content,
    };
    let rendering = input.content;
    let nextMode = 'preview';
    if (cached && typeof input.content === 'string') {
      rendering = cached.html;
      basis.source = cached.original;
      basis.mtime = cached.mtime;
      nextMode = cached.mode;
      dirtyRef.current = true;
      setDirty(true);
      if (cached.original !== input.content || cached.mtime !== currentMtime) {
        pendingExternalRef.current = input;
        setExternalPending(true);
        setNotice('已恢复内存草稿，但磁盘版本已变化。禁止覆盖保存；请先导出草稿，再重新载入。');
      } else setNotice('已恢复本次运行中的未保存草稿；尚未写入磁盘。');
    } else setNotice(oversized ? '超过 5 MiB：仅只读预览，不载入可编辑文档。' : '正在载入可视化预览…');
    basisRef.current = basis;
    setHasMtime(basis.mtime !== null);
    modeRef.current = nextMode;
    setModeState(nextMode);
    tokenRef.current = hvToken();
    if (oversized || typeof rendering !== 'string') {
      setSrcDoc('');
      if (!oversized) setNotice('未取得完整 HTML 内容；请重新载入。');
      return;
    }
    try {
      const service = hvSidebarService(propsRef.current.ctx);
      if (!service) throw new Error('侧栏服务不可用：请确认已安装并启用 dsh-better-sidebar。');
      const baseUrl = service.hostRouteUrl(hvHtmlRoute(basis.scope, basis.path));
      setSrcDoc(createVisualDocument(rendering, { token: tokenRef.current, baseUrl, parentOrigin: window.location.origin }));
    } catch (error) { setSrcDoc(''); reportError(error); }
  }, [disconnect, reportError]);

  useEffect(() => {
    mountedRef.current = true;
    const handleData = data => {
      if (!mountedRef.current || !readyRef.current || !data || data.channel !== HV_CHANNEL || data.token !== tokenRef.current) return;
      if (data.type === 'dirty') {
        dirtyRef.current = true;
        revisionRef.current++;
        setDirty(true);
        if (!savingRef.current) setSaveState('idle');
        clearTimeout(cacheTimerRef.current);
        if (typeof data.bodyHtml === 'string') {
          try { hvRemember(basisRef.current, data.bodyHtml, modeRef.current); } catch (error) { reportError(error); }
        } else {
          cacheTimerRef.current = setTimeout(() => {
            const basis = basisRef.current;
            serialize().then(body => {
              if (basis === basisRef.current && dirtyRef.current) hvRemember(basis, body, modeRef.current);
            }).catch(error => { if (mountedRef.current) reportError(error); });
          }, 250);
        }
      } else if (data.type === 'serialized') {
        const request = requestsRef.current.get(data.requestId);
        if (!request) return;
        clearTimeout(request.timer);
        requestsRef.current.delete(data.requestId);
        if (typeof data.bodyHtml === 'string') request.resolve(data.bodyHtml);
        else request.reject(new Error('编辑桥返回了无效 HTML；未写入文件。'));
      } else if (data.type === 'save-request') {
        if (saveRef.current) saveRef.current();
      } else if (data.type === 'error') {
        const request = requestsRef.current.get(data.requestId);
        const error = new Error(typeof data.message === 'string' ? data.message : '可视化编辑桥出错。');
        if (request) {
          clearTimeout(request.timer);
          requestsRef.current.delete(data.requestId);
          request.reject(error);
        } else reportError(error);
      }
    };
    const onMessage = event => {
      const frame = iframeRef.current;
      const data = event.data;
      if (!frame || event.source !== frame.contentWindow || !data ||
          data.channel !== HV_CHANNEL || data.token !== tokenRef.current || navigationBlockedRef.current) return;
      if (event.origin !== 'null') {
        if (data.type === 'ready' || data.type === 'bootstrap-started') setNotice('编辑通道来源异常，已拒绝连接，请重新载入。');
        return;
      }
      if (data.type === 'bootstrap-started') {
        bootstrapStartedRef.current = true;
        if (!readyRef.current) setNotice('编辑脚本已启动，正在等待页面解析及通道连接…');
        return;
      }
      if (data.type !== 'ready' || !event.ports || !event.ports[0]) return;
      const port = event.ports[0];
      if (portRef.current) {
        if (port !== portRef.current) port.close();
        return;
      }
      const generation = tokenRef.current;
      portRef.current = port;
      port.onmessage = message => {
        if (portRef.current === port && tokenRef.current === generation) handleData(message.data);
      };
      port.onmessageerror = () => {
        if (portRef.current !== port) return;
        disconnect('编辑通道已断开。');
        reportError(new Error('编辑通道已断开，已停用保存；请导出最近草稿或重新载入。'));
      };
      if (typeof port.start === 'function') port.start();
      readyRef.current = true;
      setReady(true);
      const desiredMode = pendingModeRef.current || modeRef.current;
      pendingModeRef.current = null;
      modeRef.current = desiredMode;
      setModeState(desiredMode);
      // This first mode message also acknowledges the offered document port.
      try { post('mode', desiredMode === 'edit'); } catch (error) { reportError(error); }
      if (!dirtyRef.current && !pendingExternalRef.current) {
        setNotice(basisRef.current && basisRef.current.mtime === null
          ? '没有可靠的修改时间：可编辑和导出，但保存已禁用。请重新载入获取保存基线。'
          : desiredMode === 'edit' ? '编辑通道已就绪，可直接修改页面内容。修改后请保存。'
          : '预览为只读；点击顶部“编辑”后直接修改渲染页面。');
      }
    };
    const beforeUnload = event => {
      if (!dirtyRef.current && !savingRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      mountedRef.current = false;
      readyRef.current = false;
      clearTimeout(cacheTimerRef.current);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('beforeunload', beforeUnload);
      disconnect('编辑器已关闭。最近已序列化的草稿仅在当前运行内存中保留。');
    };
  }, [post, serialize, disconnect, reportError]);

  useEffect(() => {
    if (!srcDoc || large || ready) return;
    const generation = tokenRef.current;
    const timer = setTimeout(() => {
      if (mountedRef.current && tokenRef.current === generation && !readyRef.current && !navigationBlockedRef.current) {
        setNotice(bootstrapStartedRef.current
          ? '编辑脚本已启动，但页面解析或通道连接尚未完成。请点“重新载入”；若仍失败，请提供 Console 错误。'
          : '页面已显示，但未收到编辑脚本启动消息。请点“重新载入”；若仍失败，请提供 Console 中脚本或安全策略错误。');
      }
    }, 8000);
    return () => clearTimeout(timer);
  }, [srcDoc, large, ready]);

  const onFrameLoad = useCallback(() => {
    frameLoadCountRef.current++;
    if (frameLoadCountRef.current <= 1) return;
    navigationBlockedRef.current = true;
    clearTimeout(cacheTimerRef.current);
    disconnect('页面发生导航，已停用编辑，请重载。');
    setNotice('页面发生导航，已停用编辑和保存，请重新载入。可先导出最近的内存草稿。');
  }, [disconnect]);

  useEffect(() => {
    const input = { path: props.path, scope: { ...props.scope }, content: props.content, mtimeMs: props.mtimeMs, largeFile: props.largeFile };
    const old = loadedInputRef.current;
    if (old && old.path === input.path && old.scope.sessionId === input.scope.sessionId && old.scope.cwd === input.scope.cwd &&
        old.content === input.content && old.mtimeMs === input.mtimeMs && !!old.largeFile === !!input.largeFile) return;
    loadedInputRef.current = input;
    const basis = basisRef.current;
    if (basis && basis.key === hvKey(input.scope, input.path) && basis.source === input.content && basis.mtime === input.mtimeMs) return;
    if (dirtyRef.current || savingRef.current) {
      pendingExternalRef.current = input;
      setExternalPending(true);
      setNotice('宿主文件或磁盘版本已变化，保留当前草稿且禁止覆盖保存。请导出草稿，或确认放弃后重新载入。');
      return;
    }
    loadSnapshot(input, true);
  }, [props.path, props.scope.sessionId, props.scope.cwd, props.content, props.mtimeMs, props.largeFile, loadSnapshot]);

  const changeMode = useCallback(async next => {
    if ((next !== 'preview' && next !== 'edit') || (next === modeRef.current && pendingModeRef.current === null) || savingRef.current) return;
    try {
      if (!readyRef.current) {
        if (navigationBlockedRef.current) throw new Error('页面发生导航，请重新载入后再编辑。');
        pendingModeRef.current = next;
        setNotice('正在连接编辑通道，就绪后将自动进入编辑状态；若长时间无响应请点“重新载入”。');
        return;
      }
      const basis = basisRef.current;
      // Snapshot before every transition; changing mode never resets srcDoc.
      const body = await serialize();
      if (basis !== basisRef.current || !mountedRef.current) return;
      if (dirtyRef.current) hvRemember(basis, body, next);
      post('mode', next === 'edit');
      modeRef.current = next;
      setModeState(next);
      if (!pendingExternalRef.current) setNotice(next === 'edit' ? '可直接编辑页面内容；格式操作作用于页面中的选区。修改仅在点击保存后写入 HTML。' : '只读预览（包含当前未保存草稿）。');
    } catch (error) { reportError(error); }
  }, [serialize, post, reportError]);

  const save = useCallback(async () => {
    const basis = basisRef.current;
    if (savingRef.current) return;
    if (!basis || typeof basis.source !== 'string' || !readyRef.current) { reportError(new Error('没有可保存的完整 HTML。')); return; }
    if (basis.mtime === null) { reportError(new Error('没有可靠的 mtime 保存基线；请先导出草稿，再重新载入。')); return; }
    if (pendingExternalRef.current) { reportError(new Error('文件已变化，禁止覆盖保存。请导出草稿或重新载入。')); return; }
    if (hvBytes(basis.source) > HV_MAX_EDITABLE) { reportError(new Error('超过 5 MiB 的文档只读。')); return; }
    savingRef.current = true;
    setSaveState('saving');
    let savedRevision;
    try {
      const bodyHtml = await serialize();
      if (!mountedRef.current || basis !== basisRef.current) return;
      savedRevision = revisionRef.current;
      hvRemember(basis, bodyHtml, modeRef.current);
      const html = mergeVisualBody(basis.source, bodyHtml);
      if (hvBytes(html) > HV_MAX_WRITE) throw new Error('HTML 超过 8 MiB 写请求上限；请改用导出草稿。');
      // Recheck immediately before sending; source changes may arrive during serialization.
      if (pendingExternalRef.current) throw new Error('文件已变化；本次保存已取消，请导出草稿。');
      const response = await fetch(hvWriteUrl(hvSidebarService(propsRef.current.ctx), basis), {
        method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: html,
      });
      const result = await hvReadEnvelope(response);
      basis.source = html;
      basis.mtime = result && typeof result.mtimeMs === 'number' && Number.isFinite(result.mtimeMs) ? result.mtimeMs : null;
      if (mountedRef.current && basis === basisRef.current) {
        setHasMtime(basis.mtime !== null);
        if (revisionRef.current === savedRevision && !pendingExternalRef.current) {
          dirtyRef.current = false;
          setDirty(false);
          hvDrafts.delete(basis.key);
          setNotice(basis.mtime === null ? '已保存，但服务器未返回新 mtime；再次保存前必须重新载入。' : '已保存完整 HTML；原始样式由文档合并器保留。');
        } else {
          const latest = hvDrafts.get(basis.key);
          if (latest) {
            latest.original = html;
            latest.mtime = basis.mtime;
          }
          setNotice('已保存所提交的版本；保存期间的新修改仍未保存。');
        }
        setSaveState('saved');
      }
      // No implicit onReload: a host remount could discard edits made during POST.
    } catch (error) {
      if (mountedRef.current) {
        setSaveState('failed');
        if (error && (error.status === 409 || error.code === 'fs-conflict')) {
          pendingExternalRef.current = loadedInputRef.current;
          setExternalPending(true);
          setNotice('保存冲突：文件已被外部修改，未覆盖。请导出草稿，再重新载入磁盘版本。');
        } else reportError(error);
      }
    } finally { savingRef.current = false; }
  }, [serialize, reportError]);
  saveRef.current = save;

  const reload = useCallback(() => {
    if (savingRef.current) return;
    if (dirtyRef.current && !window.confirm('放弃当前未保存修改并重新载入？建议先导出草稿。')) return;
    const basis = basisRef.current;
    if (basis) hvDrafts.delete(basis.key);
    const input = pendingExternalRef.current || loadedInputRef.current;
    if (input) loadSnapshot(input, false);
    // Explicit user action only. A refresh can retrieve a new conflict baseline.
    if (typeof propsRef.current.onReload === 'function') propsRef.current.onReload();
  }, [loadSnapshot]);
  const cancel = useCallback(() => {
    const basis = basisRef.current;
    if (!basis || savingRef.current) return;
    if (pendingExternalRef.current) { reload(); return; }
    if (dirtyRef.current && !window.confirm('放弃当前可视化修改，恢复到最后成功载入或保存的版本？')) return;
    hvDrafts.delete(basis.key);
    loadSnapshot({ path: basis.path, scope: basis.scope, content: basis.source, mtimeMs: basis.mtime }, false);
  }, [loadSnapshot, reload]);
  const exportDraft = useCallback(async () => {
    const basis = basisRef.current;
    if (!basis) return;
    try {
      let html;
      if (readyRef.current) {
        const body = await serialize();
        if (basis !== basisRef.current) return;
        html = mergeVisualBody(basis.source, body);
        if (dirtyRef.current) hvRemember(basis, body, modeRef.current);
      } else {
        const cached = hvDrafts.get(basis.key);
        html = cached ? cached.html : basis.source;
        if (typeof html !== 'string') throw new Error('未取得可导出的 HTML；请使用文件菜单下载原文件。');
        setNotice('编辑桥未就绪：导出最近的内存快照，可能不含最后输入。');
      }
      hvDownload(html, basis.path, '.draft');
    } catch (error) {
      const cached = hvDrafts.get(basis.key);
      if (cached) {
        hvDownload(cached.html, basis.path, '.cached-draft');
        setNotice('编辑桥不可用，已导出最近的内存快照，可能不含最后输入。');
      } else reportError(error);
    }
  }, [serialize, reportError]);
  const backup = useCallback(() => {
    const basis = basisRef.current;
    if (basis && typeof basis.backup === 'string') hvDownload(basis.backup, basis.path, '.original-backup');
  }, []);
  const exec = useCallback((command, value) => {
    if (modeRef.current !== 'edit' || savingRef.current || !readyRef.current) return;
    try { post('exec', { command, value }); } catch (error) { reportError(error); }
  }, [post, reportError]);

  useEffect(() => {
    const state = { modes: !large && !!srcDoc, mode, dirty,
      editable: !large && ready && hasMtime && !externalPending,
      saveState, ...(large ? { largeFile: true } : {}) };
    propsRef.current.onToolbarState && propsRef.current.onToolbarState(state);
  }, [mode, dirty, ready, hasMtime, externalPending, large, srcDoc, saveState]);
  useEffect(() => {
    const callback = props.onToolbarControls;
    if (callback) callback({ setMode: changeMode, save });
    return () => { if (callback) callback(null); };
  }, [props.onToolbarControls, changeMode, save]);

  const buttonStyle = { padding: '4px 8px', border: '1px solid var(--border-color, #bbb)', borderRadius: 4,
    color: 'inherit', background: 'transparent', cursor: 'pointer', fontSize: 12 };
  const button = (label, action, disabled, title) => h('button', {
    type: 'button', style: buttonStyle, disabled: !!disabled, title: title || label,
    onMouseDown: event => event.preventDefault(), onClick: action,
  }, label);
  const unavailable = !ready || saveState === 'saving' || large;
  const service = hvSidebarService(props.ctx);
  let largeUrl = '';
  if (large) {
    try { largeUrl = service.hostRouteUrl(hvHtmlRoute(props.scope, props.path)); } catch (_) { /* notice remains */ }
  }
  return h('section', {
    'aria-label': 'HTML 可视化编辑器',
    style: { height: '100%', minHeight: 260, display: 'flex', flexDirection: 'column', overflow: 'hidden', color: 'inherit' },
  },
    props.toolbar !== 'host' && h('div', { style: { display: 'flex', gap: 6, padding: 6, flexWrap: 'wrap' } },
      button('预览', () => changeMode('preview'), unavailable || mode === 'preview'),
      button('编辑页面', () => changeMode('edit'), unavailable || mode === 'edit'),
      button(saveState === 'saving' ? '保存中…' : '保存 HTML', save, unavailable || !hasMtime || externalPending),
      dirty && h('span', { role: 'status' }, '● 未保存')),
    h('div', { style: { display: 'flex', gap: 6, padding: 6, flexWrap: 'wrap', alignItems: 'center', borderBottom: '1px solid var(--border-color, #bbb)' } },
      button('导出草稿 HTML', exportDraft, large || !srcDoc),
      button('下载载入时备份', backup, large || typeof props.content !== 'string'),
      button('重新载入', reload, saveState === 'saving'),
      !large && button('取消编辑 / 还原', cancel, unavailable || !dirty),
      h('span', { style: { fontSize: 12, opacity: 0.75 } }, 'v0.1.2 · 不自动保存 · 不执行原页面脚本 · 窗口关闭前请保存或导出')),
    !large && mode === 'edit' && h('div', { role: 'toolbar', 'aria-label': '页面文字格式',
      style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', padding: 6, borderBottom: '1px solid var(--border-color, #bbb)' } },
      button('加粗', () => exec('bold'), unavailable),
      button('斜体', () => exec('italic'), unavailable),
      button('下划线', () => exec('underline'), unavailable),
      button('H1', () => exec('formatBlock', 'h1'), unavailable),
      button('H2', () => exec('formatBlock', 'h2'), unavailable),
      button('正文', () => exec('formatBlock', 'p'), unavailable),
      h('label', { style: { fontSize: 12 } }, '字号 ', h('select', {
        'aria-label': '文字字号（px）', disabled: unavailable, defaultValue: '',
        style: { ...buttonStyle, width: 68 },
        onChange: event => { exec('fontSizePx', Number(event.target.value)); event.target.value = ''; },
      }, h('option', { value: '', disabled: true }, 'px'), ...[12, 14, 16, 18, 20, 24, 28, 32, 40, 48].map(size => h('option', { key: size, value: size }, size)))),
      h('label', { style: { fontSize: 12 } }, '颜色 ', h('input', {
        type: 'color', 'aria-label': '文字颜色', defaultValue: '#222222', disabled: unavailable,
        style: { width: 30, height: 25, verticalAlign: 'middle', padding: 0, border: 0 },
        onChange: event => exec('foreColor', event.target.value),
      })),
      button('链接', () => {
        const value = window.prompt('输入链接（http/https/mailto/tel 或 #锚点；留空取消）：', 'https://');
        if (value === null || !value.trim()) return;
        const href = value.trim();
        if (/[\u0000-\u001f\u007f]/.test(href) || !/^(https?:|mailto:|tel:|#)/i.test(href)) {
          setNotice('不允许此链接协议。'); return;
        }
        exec('createLink', href);
      }, unavailable),
      button('取消链接', () => exec('unlink'), unavailable),
      button('撤销', () => exec('undo'), unavailable),
      button('重做', () => exec('redo'), unavailable)),
    h('div', { role: externalPending ? 'alert' : 'status', style: { padding: '6px 8px', fontSize: 12,
      background: externalPending ? 'rgba(180, 100, 0, .14)' : 'rgba(100, 100, 100, .08)', overflowWrap: 'anywhere' } }, notice),
    large && largeUrl ? h('iframe', { title: 'HTML 大文件只读预览', src: largeUrl, sandbox: '', referrerPolicy: 'no-referrer',
      style: { border: 0, background: 'white', width: '100%', flex: 1, minHeight: 180 } })
    : srcDoc ? h('iframe', { ref: iframeRef, title: 'HTML 页面可视化编辑', srcDoc, sandbox: 'allow-scripts', referrerPolicy: 'no-referrer', onLoad: onFrameLoad,
      style: { border: 0, background: 'white', width: '100%', flex: 1, minHeight: 180 } })
    : h('div', { style: { padding: 12 } }, large ? '此文件只读，请通过文件菜单打开或下载。' : '等待完整 HTML 文档。'));
}

function apply(ctx) {
  // dsh-better-sidebar is a third-party plugin: its service may be absent.
  // A top-level inject entry for a missing plugin stays pending forever and
  // blocks the whole client tree, so the service is acquired lazily instead.
  let registered = false;
  const register = service => {
    if (registered || !service || typeof service.registerFileViewer !== 'function') return;
    registered = true;
    ctx.effect(() => service.registerFileViewer({
      id: 'html-visual-editor', title: 'HTML 可视化编辑', exts: ['html', 'htm'], priority: 100,
      fetchStrategy: 'fsRead', component: props => h(VisualEditor, props),
    }));
  };
  const lookup = () => {
    let service = ctx.betterSidebar;
    if (!service) {
      try { service = typeof ctx.get === 'function' ? ctx.get('betterSidebar') : undefined; }
      catch (_) { service = undefined; }
    }
    return service;
  };
  const service = lookup();
  if (service) { register(service); return; }
  try {
    ctx.inject(['betterSidebar'], scope => { if (scope) register(scope.betterSidebar); });
  } catch (_) { /* The deferred hook is unavailable: the bounded retry below still runs. */ }
  // Bounded fallback: the sidebar plugin may activate after this one, and the
  // order of client plugins is not guaranteed. The timer stops on success.
  let attempts = 0;
  const timer = setInterval(() => {
    if (registered || ++attempts > 120) { clearInterval(timer); return; }
    const found = lookup();
    if (found) { clearInterval(timer); register(found); }
  }, 1000);
  ctx.effect(() => () => clearInterval(timer));
}
