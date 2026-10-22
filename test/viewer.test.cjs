'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/viewer.js'), 'utf8');

function createHarness() {
  const hooks = [];
  let cursor = 0, pending = [], changed = false, tree, currentProps;
  const listeners = new Map(), sent = [], writes = [], downloads = [];
  const timers = new Map();
  let timerId = 0;
  const callbacks = { toolbar: null, controls: null };
  const fakeFrame = { contentWindow: { postMessage() { throw new Error('WindowProxy postMessage is forbidden after ready'); } } };
  const fakePorts = [];
  let currentPort = null;
  const newPort = () => {
    const port = { onmessage: null, onmessageerror: null, closed: false, started: false,
      postMessage(message) { assert.equal(this.closed, false); sent.push(message); },
      start() { this.started = true; }, close() { this.closed = true; } };
    fakePorts.push(port);
    return port;
  };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const React = {
    useRef(value) { const i = cursor++; if (!hooks[i]) hooks[i] = { current: value }; return hooks[i]; },
    useState(value) {
      const i = cursor++;
      if (!hooks[i]) hooks[i] = { value: typeof value === 'function' ? value() : value,
        set: next => { const old = hooks[i].value; hooks[i].value = typeof next === 'function' ? next(old) : next; if (!Object.is(old, hooks[i].value)) changed = true; } };
      return [hooks[i].value, hooks[i].set];
    },
    useCallback(fn, deps) { const i = cursor++; if (!hooks[i] || !same(hooks[i].deps, deps)) hooks[i] = { fn, deps }; return hooks[i].fn; },
    useEffect(fn, deps) { const i = cursor++; if (!hooks[i] || !same(hooks[i].deps, deps)) { pending.push(() => { if (hooks[i] && hooks[i].cleanup) hooks[i].cleanup(); hooks[i] = { deps, cleanup: fn() }; }); } },
  };
  const window = { location: { origin: 'http://localhost:53984' },
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name), confirm: () => true, prompt: () => null };
  const context = vm.createContext({ console, TextEncoder, URL, URLSearchParams, Blob,
    crypto: require('node:crypto').webcrypto,
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: id => timers.delete(id),
    window, document: { body: { appendChild() {} }, createElement: () => ({ click() { downloads.push(this); }, remove() {} }) },
    fetch: async (url, options) => { writes.push({ url, options }); return harness.response; },
    ...React, h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item !== false && item != null) }),
    createVisualDocument: (html, options) => JSON.stringify({ html, options }),
    mergeVisualBody: (original, body) => original.replace(/<body[^>]*>[\s\S]*<\/body>/i, '<body>' + body + '</body>'),
  });
  vm.runInContext(source + '\nglobalThis.testApi={VisualEditor,apply,hvReadEnvelope,hvHtmlRoute,hvDrafts};', context);
  function walk(node, predicate) {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    for (const child of node.children || []) { const found = walk(child, predicate); if (found) return found; }
    return null;
  }
  const service = { hostRouteUrl: route => 'http://localhost:53984/proxy/' + route, registerFileViewer: desc => { harness.descriptor = desc; return () => { harness.disposed = true; }; } };
  const harness = {
    api: context.testApi, context, window, sent, writes, timers, callbacks, listeners, fakePorts,
    get port() { return currentPort; },
    response: { ok: true, status: 200, json: async () => ({ ok: true, value: { ok: true, mtimeMs: 200 } }) },
    props: { ctx: { betterSidebar: service }, store: {}, scope: { sessionId: 'session-A', cwd: 'C:\\project' }, path: 'C:\\project\\page.html',
      content: '<!doctype html><html><head><style>p{color:red}</style></head><body><p>old</p></body></html>', mtimeMs: 100, toolbar: 'host',
      onToolbarState: state => { callbacks.toolbar = state; }, onToolbarControls: value => { callbacks.controls = value; } },
    render(patch) {
      currentProps = { ...(currentProps || harness.props), ...patch };
      let turns = 0;
      do {
        if (++turns > 30) throw new Error('render loop');
        changed = false; cursor = 0; pending = [];
        tree = context.testApi.VisualEditor(currentProps);
        const iframe = walk(tree, node => node.type === 'iframe' && node.props.ref);
        if (iframe) iframe.props.ref.current = fakeFrame;
        const effects = pending; pending = [];
        for (const effect of effects) effect();
      } while (changed);
      return tree;
    },
    get frame() { return walk(tree, node => node.type === 'iframe'); },
    get text() { const texts = []; (function collect(n) { if (typeof n === 'string') texts.push(n); else if (n && n.children) n.children.forEach(collect); })(tree); return texts.join(' '); },
    event(data, overrides) {
      const doc = JSON.parse(harness.frame.props.srcDoc);
      const payload = { channel: 'dsh-html-visual', token: doc.options.token, ...data };
      if (data.type === 'ready') {
        const port = newPort();
        listeners.get('message')({ source: fakeFrame.contentWindow, origin: 'null', data: payload, ports: [port], ...overrides });
        if (port.onmessage) currentPort = port;
      } else if (currentPort && currentPort.onmessage) currentPort.onmessage({ data: payload });
      harness.render();
    },
    windowMessage(data, overrides) {
      const doc = JSON.parse(harness.frame.props.srcDoc);
      listeners.get('message')({ source: fakeFrame.contentWindow, origin: 'null', data: { channel: 'dsh-html-visual', token: doc.options.token, ...data }, ports: [], ...overrides });
      harness.render();
    },
    frameLoad() { harness.frame.props.onLoad(); harness.render(); },
    reply(body = '<p>edited</p>') {
      const request = sent.filter(message => message.command === 'serialize').at(-1);
      assert.ok(request, 'a serialization request was sent');
      harness.event({ type: 'serialized', requestId: request.requestId, bodyHtml: body });
    },
    async flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); harness.render(); },
    findButton(text) { return walk(tree, node => node.type === 'button' && node.children.includes(text)); },
    unmount() { for (const hook of hooks) if (hook && hook.cleanup) hook.cleanup(); },
    remount(patch) { harness.unmount(); hooks.length = 0; currentProps = null; harness.render(patch); },
    service,
  };
  return harness;
}

(async () => {
  // Module syntax is a factory body, not an ESM module.
  new Function('h', 'useState', 'useRef', 'useEffect', 'useCallback', source);
  const h = createHarness();
  let disposer;
  h.api.apply({ betterSidebar: h.service, get: name => name === 'betterSidebar' ? h.service : undefined, effect: fn => { disposer = fn(); } });
  assert.equal(h.descriptor.id, 'html-visual-editor');
  assert.equal(h.descriptor.priority, 100);
  assert.equal(h.descriptor.fetchStrategy, 'fsRead');
  disposer(); assert.ok(h.disposed);
  assert.equal(h.api.hvHtmlRoute({ sessionId: 's', cwd: 'C:\\foo' }, 'a.html'), 'sidebar/html/s/C%3A/foo/a.html');
  assert.equal(h.api.hvHtmlRoute({ sessionId: 's' }, '\\\\server\\share\\a.html'), 'sidebar/html/s//server/share/a.html');

  h.render();
  const initialSrc = h.frame.props.srcDoc;
  assert.equal(h.frame.props.sandbox, 'allow-scripts');
  assert.equal(h.callbacks.toolbar.mode, 'preview');
  assert.equal(h.callbacks.toolbar.editable, false);
  h.event({ type: 'ready' }, { origin: 'http://evil.test' });
  assert.equal(h.callbacks.toolbar.editable, false, 'reject nonopaque origin');
  h.event({ type: 'ready' }, { source: {} });
  assert.equal(h.callbacks.toolbar.editable, false, 'reject another frame');
  h.event({ type: 'ready', token: 'wrong' });
  assert.equal(h.callbacks.toolbar.editable, false, 'reject wrong token');
  h.event({ type: 'ready' }, { ports: [] });
  assert.equal(h.callbacks.toolbar.editable, false, 'reject ready without a transferred port');
  h.event({ type: 'ready' });
  assert.equal(h.callbacks.toolbar.editable, true);
  assert.ok(h.port.started);
  h.frameLoad();
  assert.equal(h.callbacks.toolbar.editable, true, 'ready before initial load is accepted');
  h.windowMessage({ type: 'dirty', bodyHtml: '<p>forged</p>' });
  assert.equal(h.callbacks.toolbar.dirty, false, 'window messages cannot modify an established document channel');
  const enter = h.callbacks.controls.setMode('edit');
  const pendingMode = h.sent.filter(message => message.command === 'serialize').at(-1);
  h.windowMessage({ type: 'serialized', requestId: pendingMode.requestId, bodyHtml: '<script>FORGED</script>' });
  assert.equal(h.callbacks.toolbar.mode, 'preview', 'window serialization cannot fulfill a port request');
  h.reply(); await enter; h.render();
  assert.equal(h.callbacks.toolbar.mode, 'edit');
  h.event({ type: 'dirty', bodyHtml: '<p>draft</p>' });
  assert.equal(h.callbacks.toolbar.dirty, true);
  assert.equal(h.frame.props.srcDoc, initialSrc, 'dirty must not reset the iframe');
  const beforeUnload = { preventDefault() { this.prevented = true; } };
  h.listeners.get('beforeunload')(beforeUnload);
  assert.ok(beforeUnload.prevented);
  assert.equal(beforeUnload.returnValue, '');
  // The memory map is keyed by session + path and remains outside persistent storage.
  assert.equal(h.api.hvDrafts.size, 1);

  const saving = h.callbacks.controls.save();
  h.reply('<p>saved</p>'); await saving; h.render();
  assert.equal(h.writes.length, 1);
  assert.match(h.writes[0].url, /expectedMtimeMs=100/);
  assert.equal(h.writes[0].options.method, 'POST');
  assert.match(h.writes[0].options.body, /<style>p\{color:red\}<\/style>/);
  assert.match(h.writes[0].options.body, /<p>saved<\/p>/);
  assert.equal(h.callbacks.toolbar.dirty, false);
  assert.equal(h.callbacks.toolbar.saveState, 'saved');
  assert.equal(h.frame.props.srcDoc, initialSrc, 'successful save must not remount the iframe');
  h.event({ type: 'dirty', bodyHtml: '<p>after save</p>' });
  const second = h.callbacks.controls.save(); h.reply(); await second; h.render();
  assert.match(h.writes[1].url, /expectedMtimeMs=200/, 'use the new baseline after saving');

  h.event({ type: 'dirty', bodyHtml: '<p>mine</p>' });
  h.render({ content: h.props.content.replace('old', 'external'), mtimeMs: 300 });
  assert.equal(h.frame.props.srcDoc, initialSrc);
  assert.equal(h.callbacks.toolbar.dirty, true);
  assert.equal(h.callbacks.toolbar.editable, false);
  await h.callbacks.controls.save();
  assert.equal(h.writes.length, 2, 'external change blocks writing');
  assert.match(h.text, /禁止覆盖/);
  h.unmount();

  const missing = createHarness(); missing.render({ mtimeMs: undefined }); missing.event({ type: 'ready' });
  assert.equal(missing.callbacks.toolbar.editable, false);
  await missing.callbacks.controls.save(); missing.render(); assert.equal(missing.writes.length, 0);
  assert.match(missing.text, /mtime/); missing.unmount();

  const big = createHarness(); big.render({ content: undefined, largeFile: { size: 6 * 1024 * 1024 } });
  assert.equal(big.callbacks.toolbar.largeFile, true);
  assert.equal(big.callbacks.toolbar.modes, false);
  assert.equal(big.callbacks.toolbar.editable, false);
  assert.ok(big.frame.props.src); assert.equal(big.frame.props.sandbox, '');
  assert.ok(big.findButton('导出草稿 HTML').props.disabled);
  await big.callbacks.controls.save(); assert.equal(big.writes.length, 0); big.unmount();

  const conflict = createHarness(); conflict.render(); conflict.event({ type: 'ready' });
  conflict.event({ type: 'dirty', bodyHtml: '<p>mine</p>' });
  conflict.response = { ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'fs-conflict', message: 'changed' } }) };
  const failed = conflict.callbacks.controls.save(); conflict.reply(); await failed; conflict.render();
  assert.equal(conflict.callbacks.toolbar.dirty, true);
  assert.equal(conflict.callbacks.toolbar.editable, false);
  assert.equal(conflict.callbacks.toolbar.saveState, 'failed');
  assert.match(conflict.text, /保存冲突/);
  await conflict.callbacks.controls.save(); assert.equal(conflict.writes.length, 1);
  conflict.unmount();

  const fullBig = createHarness(); fullBig.render({ content: '<body>' + 'x'.repeat(5 * 1024 * 1024) + '</body>' });
  assert.equal(fullBig.callbacks.toolbar.largeFile, true);
  assert.equal(fullBig.callbacks.toolbar.editable, false); fullBig.unmount();

  const recovery = createHarness(); recovery.render(); recovery.event({ type: 'ready' });
  recovery.event({ type: 'dirty', bodyHtml: '<p>recover me</p>' });
  recovery.remount();
  assert.equal(recovery.callbacks.toolbar.dirty, true);
  assert.match(recovery.frame.props.srcDoc, /recover me/);
  assert.match(recovery.text, /恢复/);
  assert.equal(recovery.writes.length, 0, 'memory recovery does not autosave'); recovery.unmount();

  const concurrent = createHarness(); concurrent.render(); concurrent.event({ type: 'ready' });
  concurrent.event({ type: 'dirty', bodyHtml: '<p>first</p>' });
  let finishPost;
  concurrent.response = new Promise(resolve => { finishPost = resolve; });
  const inflight = concurrent.callbacks.controls.save(); concurrent.reply('<p>first</p>'); await concurrent.flush();
  concurrent.event({ type: 'dirty', bodyHtml: '<p>later edit</p>' });
  finishPost({ ok: true, status: 200, json: async () => ({ ok: true, value: { mtimeMs: 400 } }) });
  await inflight; concurrent.render();
  assert.equal(concurrent.callbacks.toolbar.dirty, true, 'typing during save must remain dirty');
  assert.match(concurrent.text, /新修改仍未保存/); concurrent.unmount();

  const navigation = createHarness(); navigation.render(); navigation.frameLoad();
  navigation.event({ type: 'ready' });
  assert.equal(navigation.callbacks.toolbar.editable, true, 'ready after initial load is accepted');
  navigation.event({ type: 'dirty', bodyHtml: '<p>safe cache</p>' });
  const boundPort = navigation.port;
  const navigationSave = navigation.callbacks.controls.save();
  navigation.frameLoad();
  await navigationSave; navigation.render();
  assert.equal(boundPort.closed, true);
  assert.equal(navigation.callbacks.toolbar.editable, false);
  assert.match(navigation.text, /页面发生导航/);
  const commandsBefore = navigation.sent.length;
  navigation.event({ type: 'ready' });
  assert.equal(navigation.callbacks.toolbar.editable, false, 'a replacement document cannot reconnect after navigation');
  navigation.windowMessage({ type: 'save-request' });
  await navigation.callbacks.controls.save();
  assert.equal(navigation.sent.length, commandsBefore, 'no command or secret is sent to a navigated document');
  assert.equal(navigation.writes.length, 0);
  navigation.unmount();

  const reset = createHarness(); reset.render(); reset.event({ type: 'ready' });
  const firstPort = reset.port;
  reset.render({ content: reset.props.content.replace('old', 'new disk'), mtimeMs: 500 });
  assert.equal(firstPort.closed, true, 'loading a clean external snapshot closes the old document port');
  assert.equal(reset.callbacks.toolbar.editable, false);
  reset.event({ type: 'ready' });
  assert.equal(reset.callbacks.toolbar.editable, true);
  const lastPort = reset.port; reset.unmount(); assert.equal(lastPort.closed, true, 'unmount closes the transferred port');

  const keyboard = createHarness(); keyboard.render(); keyboard.event({ type: 'ready' });
  keyboard.event({ type: 'save-request' }); keyboard.reply(); await keyboard.flush();
  assert.equal(keyboard.writes.length, 1, 'iframe Ctrl+S reaches the current save handler'); keyboard.unmount();
  const early = createHarness(); early.render();
  await early.callbacks.controls.setMode('edit'); early.render();
  assert.match(early.text, /正在连接编辑通道/);
  assert.equal(early.writes.length, 0);
  early.event({type:'ready'});
  assert.equal(early.callbacks.toolbar.mode,'edit','an early edit click is applied after handshake');
  assert.equal(early.sent.at(-1).command,'mode'); assert.equal(early.sent.at(-1).value,true);
  const established=early.port;
  early.event({type:'ready'});
  assert.equal(early.fakePorts.at(-1).closed,true,'duplicate ready closes only the unused incoming port');
  assert.equal(established.closed,false);
  assert.equal([...early.timers.values()].some(t=>t.ms===8000),false,'ready cancels bootstrap timeout');
  early.unmount();

  const stalled=createHarness(); stalled.render();
  const deadline=[...stalled.timers.values()].find(t=>t.ms===8000);
  assert.ok(deadline); deadline.fn(); stalled.render();
  assert.match(stalled.text,/未收到编辑脚本启动消息/);
  assert.equal(stalled.callbacks.toolbar.editable,false);
  assert.equal(stalled.writes.length,0);
  stalled.windowMessage({type:'bootstrap-started'});
  assert.match(stalled.text,/编辑脚本已启动/);
  deadline.fn(); stalled.render();
  assert.match(stalled.text,/页面解析或通道连接尚未完成/);
  stalled.unmount();
  console.log('viewer tests: registration, bridge authentication, mode/draft retention, mtime writes, external-change guard, missing baseline, 5MiB read-only, 409 conflict, Ctrl+S, early edit, retry-port cleanup and bootstrap timeout passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
