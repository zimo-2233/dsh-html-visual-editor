import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {findBodyRange, mergeVisualBody, createVisualDocument, visualFrameRuntime} from '../src/engine.js';
const dom = new JSDOM('');
globalThis.DOMParser = dom.window.DOMParser;
const token = 'test_nonce_0123456789abcdef';
const origin = 'http://127.0.0.1:53984';
const baseUrl = origin + '/sidebar/html/S/C%3A/test/report.html';
const html = '<!DOCTYPE html>\r\n<html lang="zh-CN"><head><meta charset="utf-8"><title>测试</title><link href="./report.css" rel="stylesheet"><style>.paper{color:#a32d2d} td{border:1px solid}</style><script>const fake = "<body>not body</body>";</script></head><body class="paper" data-info="a > b"><h1>原始标题</h1><p>原始内容 <b>保留粗体</b></p><img src="img/a.svg"><table><tbody><tr><td>单元格</td></tr></tbody></table><script>window.originalRan=true;</script></body></html>';

test('body scanner ignores script strings, comments and quoted greater-than', () => {
  const r = findBodyRange('<!-- <body>bad</body> -->' + html);
  assert.ok(r);
  const body = ('<!-- <body>bad</body> -->' + html).slice(r.start,r.end);
  assert.ok(body.startsWith('<h1>原始标题'));
  assert.ok(body.endsWith('<script>window.originalRan=true;</script>'));
});
test('save changes only body, keeping original doctype/head/body attributes and suffix byte-for-byte', () => {
  const r = findBodyRange(html);
  const changed = html.slice(r.start,r.end).replace('原始标题','修改后的标题');
  const saved = mergeVisualBody(html, changed);
  assert.equal(saved.slice(0,r.start), html.slice(0,r.start));
  assert.equal(saved.slice(-('</body></html>'.length)), '</body></html>');
  assert.equal(saved, html.replace('原始标题','修改后的标题'));
  assert.ok(saved.includes('class="paper" data-info="a > b"'));
});
test('fragment fallback retains head styles and edited body semantically', () => {
  const saved = mergeVisualBody('<style>p{color:red}</style><p>before</p>', '<p>after</p>');
  assert.ok(saved.includes('<style>p{color:red}</style>'));
  assert.ok(saved.includes('<p>after</p>'));
});
test('render uses nonce-only script policy, no connections, no original metadata refresh', () => {
  const view = createVisualDocument(html.replace('<head>','<head><meta http-equiv="refresh" content="0;url=https://example.com">'), {token, baseUrl, parentOrigin:origin});
  const d = new dom.window.DOMParser().parseFromString(view,'text/html');
  const policy = d.head.firstElementChild;
  assert.equal(policy.httpEquiv,'Content-Security-Policy');
  assert.ok(policy.content.includes("script-src 'nonce-" + token + "'"));
  assert.ok(policy.content.includes("connect-src 'none'"));
  assert.ok(policy.content.includes("script-src-attr 'none'"));
  assert.equal(d.querySelector('meta[http-equiv="refresh"]'),null);
  assert.equal(d.querySelector('base').href, baseUrl);
  const own = [...d.scripts].filter(s => s.getAttribute('data-dsh-hve-injected') === token);
  assert.equal(own.length,1);
  assert.equal(own[0].nonce,token);
  assert.equal([...d.scripts].filter(s=>s.nonce===token).length,1);
});
test('relative original base is resolved for preview but original source remains unchanged on save', () => {
  const original = html.replace('<head>','<head><base href="./assets/">');
  const d = new dom.window.DOMParser().parseFromString(createVisualDocument(original,{token,baseUrl,parentOrigin:origin}), 'text/html');
  assert.equal(d.querySelector('base').href, origin+'/sidebar/html/S/C%3A/test/assets/');
  const range=findBodyRange(original);
  const saved=mergeVisualBody(original,original.slice(range.start,range.end));
  assert.equal(saved,original);
});
test('invalid origin/token are refused', () => {
  assert.throws(()=>createVisualDocument(html,{token:'short',baseUrl,parentOrigin:origin}));
  assert.throws(()=>createVisualDocument(html,{token,baseUrl,parentOrigin:'file://test'}));
});
function runBridge(markup, evaluateGenerated = false, {dropOffers = 0} = {}) {
  const sent = [], timers = new Map();
  let timerId = 0, offers = 0;
  const w = new JSDOM(markup, {url:'about:blank',runScripts:'outside-only'}).window;
  w.setTimeout = callback => {timers.set(++timerId, callback); return timerId;};
  w.clearTimeout = id => timers.delete(id);
  class Port {
    postMessage(data) { if (!this.closed && !this.peer.closed) this.peer.onmessage?.({data}); }
    start() {} close() { this.closed = true; }
  }
  w.MessageChannel = class {
    constructor() {this.port1=new Port();this.port2=new Port();this.port1.peer=this.port2;this.port2.peer=this.port1;}
  };
  let port;
  const parent = {postMessage:(data,target,ports)=>{
    assert.equal(target,origin); if(data.type==='bootstrap-started') return; assert.equal(data.type,'ready');
    assert.ok(ports?.[0]);
    if (++offers <= dropOffers) return;
    port=ports[0];port.onmessage=e=>sent.push(e.data);
    port.postMessage({channel:'dsh-html-visual',token,command:'mode',value:false});
  }};
  Object.defineProperty(w,'parent',{value:parent});
  if (evaluateGenerated) w.eval([...w.document.scripts].find(s=>s.getAttribute('data-dsh-hve-injected')===token).textContent);
  else w.eval('('+visualFrameRuntime.toString()+')('+JSON.stringify(token)+','+JSON.stringify(origin)+')');
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  const send=(command,value,extra={})=>port.postMessage({channel:'dsh-html-visual',token,command,value,requestId:'req-1',...extra});
  return {w,sent,send,timers,get offers(){return offers;},retry(){const item=timers.entries().next().value;assert.ok(item,'retry is scheduled');timers.delete(item[0]);item[1]();}};
}
test('frame bridge binds a document port, rejects window messages and cleans its own injected script', () => {
  const {w,sent,send}=runBridge('<!doctype html><body><p>原文</p><script>original script</script><script data-dsh-hve-injected="'+token+'">bridge</script></body>');
  send('serialize',undefined,{token:'bad'});assert.equal(sent.length,0);
  w.dispatchEvent(new w.MessageEvent('message',{source:w.parent,origin,data:{channel:'dsh-html-visual',token,command:'serialize'}}));
  assert.equal(sent.length,0);
  send('serialize');
  const msg=sent.find(x=>x.type==='serialized');
  assert.equal(msg.requestId,'req-1');
  assert.ok(msg.bodyHtml.includes('original script'));
  assert.ok(!msg.bodyHtml.includes('data-dsh-hve-injected'));
  w.close();
});
test('bootstrap retries a lost ready message until mode acknowledgement, then stops', () => {
  const h=runBridge('<p>retry</p>',false,{dropOffers:1});
  assert.equal(h.offers,1);assert.equal(h.timers.size,1);
  h.retry();assert.equal(h.offers,2);assert.equal(h.timers.size,0);
  h.send('serialize');assert.ok(h.sent.some(m=>m.type==='serialized'));
  h.w.close();
});
test('unsafe link command is rejected instead of creating a script URL', () => {
  const {w,sent,send}=runBridge('<p>test</p>');
  send('mode',true);
  send('exec',{command:'createLink',value:'javascript:alert(1)'});
  assert.ok(sent.some(m=>m.type==='error'&&m.message.includes('Only http(s)')));
  w.close();
});
test('HTML5 locations ignore template bodies and script double-escaped closing tags', () => {
  const cases=[
    '<!doctype html><html><head><template><body>FAKE</body></template></head><body><p>REAL</p></body></html>',
    '<!doctype html><html><head><script><!--<script></script>const s="<body>FAKE</body>";</script></head><body><p>REAL</p></body></html>'
  ];
  for (const original of cases) {
    const range=findBodyRange(original);
    assert.equal(original.slice(range.start,range.end),'<p>REAL</p>');
    const changed=mergeVisualBody(original,'<p>EDITED</p>');
    assert.equal(changed.slice(0,range.start),original.slice(0,range.start));
    assert.ok(changed.includes('<p>EDITED</p></body>'));
  }
});
test('body base/refresh metadata is inert in preview and restored during serialization', () => {
  const original='<!doctype html><html><head><title>x</title></head><body><p>keep</p><base href="./assets/"><meta http-equiv="refresh" content="1000"><script>window.flag=true;</script></body></html>';
  const preview=createVisualDocument(original,{token,baseUrl,parentOrigin:origin});
  const {w,sent,send}=runBridge(preview,true);
  assert.equal(w.document.body.querySelector('base'),null);
  assert.equal(w.document.body.querySelector('meta'),null);
  send('serialize');
  const body=sent.find(m=>m.type==='serialized').bodyHtml;
  assert.ok(body.includes('<base href="./assets/">'));
  assert.ok(body.includes('http-equiv="refresh"'));
  assert.ok(body.includes('window.flag=true'));
  assert.ok(!body.includes('dsh-hve-preserve-'));
  w.close();
});
test('trailing scripts moved into body are not duplicated by source splicing', () => {
  const original='<!doctype html><html><head></head><body><p>A</p></body><script>ORIGINAL</script></html>';
  const d=new dom.window.DOMParser().parseFromString(original,'text/html');
  assert.equal(findBodyRange(original),null);
  const saved=mergeVisualBody(original,d.body.innerHTML.replace('<p>A</p>','<p>B</p>'));
  assert.equal(saved.match(/<script>ORIGINAL<\/script>/g).length,1);
});
test('changing font size does not rewrite unrelated original font elements', () => {
  const original='<p>selected</p><font size="7" face="Arial" color="red" class="keep">UNSELECTED</font>';
  const {w,sent,send}=runBridge(original);
  w.document.execCommand=()=>true;
  send('mode',true);send('exec',{command:'fontSizePx',value:16});send('serialize');
  const body=sent.find(m=>m.type==='serialized').bodyHtml;
  assert.ok(body.includes('<font size="7" face="Arial" color="red" class="keep">UNSELECTED</font>'));
  w.close();
});
