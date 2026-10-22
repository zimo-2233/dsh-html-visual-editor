// HTML round-trip and isolated rendering. No original document scripts execute.
// HTML5 parser source locations avoid mistaking template/script text for body.
import { parse } from 'parse5';
export function findBodyRange(source) {
  const doc = parse(source, { sourceCodeLocationInfo: true, scriptingEnabled: false });
  const html = doc.childNodes.find(node => node.tagName === 'html');
  const body = html?.childNodes.find(node => node.tagName === 'body');
  const loc = body?.sourceCodeLocation;
  if (!loc?.startTag || !loc?.endTag) return null;
  const range = { start: loc.startTag.endOffset, end: loc.endTag.startOffset };
  // HTML5 moves trailing scripts/stray content into body. Splicing that body
  // into the original source would duplicate the out-of-range original nodes.
  const within = node => {
    const at = node.sourceCodeLocation;
    if (at && !(node.nodeName === '#text' && !node.value.trim()) &&
      (at.startOffset < range.start || at.endOffset > range.end)) return false;
    return (node.childNodes || []).every(within) && (!node.content || within(node.content));
  };
  return body.childNodes.every(within) ? range : null;
}

export function mergeVisualBody(original, editedBodyHtml) {
  if (typeof editedBodyHtml !== 'string') throw new Error('Missing edited HTML body');
  const range = findBodyRange(original);
  if (range) return original.slice(0, range.start) + editedBodyHtml + original.slice(range.end);
  // A fragment or an implicit-body document cannot promise byte-identical head.
  // DOMParser's explicit structure preserves its content semantically instead.
  const doc = new DOMParser().parseFromString(original, 'text/html');
  doc.body.innerHTML = editedBodyHtml;
  const dt = doc.doctype;
  const doctype = dt ? '<!DOCTYPE ' + dt.name + (dt.publicId ? ' PUBLIC "' + dt.publicId + '"' : '') + (dt.systemId ? (dt.publicId ? ' "' : ' SYSTEM "') + dt.systemId + '"' : '') + '>\n' : '';
  return doctype + doc.documentElement.outerHTML;
}

// Runs only in an opaque-origin iframe. CSP allows this nonce-bearing script,
// but no original HTML scripts, handlers, frames, objects, forms or connections.
export function visualFrameRuntime(token, parentOrigin, protectedNodes = []) {
  const channel = 'dsh-html-visual';
  parent.postMessage({channel, token, type:'bootstrap-started'}, parentOrigin);
  let bridgePort = null, retryTimer = null, acknowledged = false, attempts = 0;
  const offeredPorts = new Set();
  let editing = false, savedRange = null;
  const send = (type, extra = {}) => bridgePort?.postMessage({ channel, token, type, ...extra });
  const rememberSelection = () => {
    const s = getSelection();
    if (s && s.rangeCount && document.body.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
  };
  document.addEventListener('selectionchange', rememberSelection);
  const restoreSelection = () => {
    if (!savedRange || !document.body.contains(savedRange.commonAncestorContainer)) return;
    const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange);
  };
  const bodyHtml = () => {
    const body = document.body.cloneNode(true);
    for (const node of body.querySelectorAll('[data-dsh-hve-injected]')) {
      if (node.getAttribute('data-dsh-hve-injected') === token) node.remove();
    }
    let html = body.innerHTML;
    for (const [marker, original] of protectedNodes) html = html.split('<!--' + marker + '-->').join(original);
    return html;
  };
  document.addEventListener('input', () => { if (editing) send('dirty'); });
  document.addEventListener('paste', e => {
    if (!editing) return;
    e.preventDefault(); document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') || '');
    send('dirty');
  });
  document.addEventListener('drop', e => e.preventDefault());
  document.addEventListener('submit', e => e.preventDefault(), true);
  const blockNavigation = e => {
    if (e.target.closest?.('a,area,button,[href],input[type=submit],input[type=button]')) e.preventDefault();
  };
  document.addEventListener('click', blockNavigation, true);
  document.addEventListener('auxclick', blockNavigation, true);
  document.addEventListener('contextmenu', e => e.preventDefault(), true);
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault(); send('save-request');
    }
  });
  const receive = (port, e) => {
    const m = e.data;
    if (!m || m.channel !== channel || m.token !== token || (acknowledged && port !== bridgePort)) return;
    if (!acknowledged && m.command !== 'mode') return;
    try {
      if (m.command === 'mode') {
        if (!acknowledged) {
          bridgePort = port; acknowledged = true;
          clearTimeout(retryTimer);
          for (const other of offeredPorts) if (other !== port) other.close();
          offeredPorts.clear();
        }
        editing = !!m.value;
        document.body.contentEditable = editing ? 'true' : 'false';
        document.body.spellcheck = editing;
        document.documentElement.dataset.dshHveMode = editing ? 'edit' : 'preview';
        if (editing) document.body.focus({ preventScroll: true });
      } else if (m.command === 'exec' && editing) {
        const op = m.value || {};
        const allowed = new Set(['bold','italic','underline','strikeThrough','formatBlock','fontSize','foreColor','hiliteColor','justifyLeft','justifyCenter','justifyRight','insertUnorderedList','insertOrderedList','createLink','unlink','undo','redo','removeFormat','fontSizePx']);
        if (!allowed.has(op.command)) throw new Error('Unsupported formatting command');
        if (op.command === 'createLink' && !/^(https?:|mailto:|tel:|#)/i.test(String(op.value || ''))) throw new Error('Only http(s), mailto, tel and anchor links are allowed');
        if (op.command === 'foreColor' || op.command === 'hiliteColor') {
          if (!/^#[0-9a-f]{6}$/i.test(String(op.value))) throw new Error('Invalid color');
        }
        document.body.focus({ preventScroll: true }); restoreSelection();
        if (op.command === 'fontSizePx') {
          const px = Number(op.value);
          if (!Number.isFinite(px) || px < 8 || px > 96) throw new Error('Font size must be 8–96 px');
          const existing = new Set(document.body.querySelectorAll('font[size="7"]'));
          document.execCommand('styleWithCSS', false, 'false');
          document.execCommand('fontSize', false, '7');
          for (const el of document.body.querySelectorAll('font[size="7"]')) {
            if (existing.has(el)) continue;
            const span = document.createElement('span');
            for (const attr of el.attributes) if (attr.name !== 'size') span.setAttribute(attr.name, attr.value);
            span.style.fontSize = px + 'px';
            while (el.firstChild) span.appendChild(el.firstChild);
            el.replaceWith(span);
          }
        } else {
          if (op.command === 'formatBlock' && !/^(p|h[1-6]|blockquote|pre)$/i.test(String(op.value).replace(/[<>]/g, ''))) throw new Error('Invalid block format');
          if (op.command === 'fontSize' && !/^[1-7]$/.test(String(op.value))) throw new Error('Invalid font size');
          document.execCommand('styleWithCSS', false, 'true');
          document.execCommand(op.command, false, op.value ?? null);
        }
        rememberSelection(); send('dirty');
      } else if (m.command === 'serialize') send('serialized', { requestId: m.requestId, bodyHtml: bodyHtml() });
    } catch (err) { send('error', { requestId: m.requestId, message: String(err.message || err) }); }
  };
  const offer = () => {
    if (acknowledged || attempts >= 30) return;
    attempts++;
    const connection = new MessageChannel();
    const port = connection.port1;
    offeredPorts.add(port);
    port.onmessage = e => receive(port, e);
    port.start();
    // Schedule before posting: tests and some hosts deliver a response quickly.
    retryTimer = setTimeout(offer, 250);
    parent.postMessage({channel, token, type:'ready'}, parentOrigin, [connection.port2]);
  };
  addEventListener('pagehide', () => {
    clearTimeout(retryTimer);
    bridgePort?.close();
    for (const port of offeredPorts) port.close();
    offeredPorts.clear();
  }, {once:true});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', offer, {once:true});
  else offer();
}

export function createVisualDocument(source, { token, baseUrl, parentOrigin }) {
  if (!/^[a-zA-Z0-9_-]{16,160}$/.test(token)) throw new Error('Invalid frame token');
  const origin = new URL(parentOrigin).origin;
  if (origin === 'null') throw new Error('Editor must run from the DSH web origin');
  const doc = new DOMParser().parseFromString(source, 'text/html');
  // The first CSP is ours, before any resource can be parsed/fetched. Original
  // metadata stays untouched in the saved source (mergeVisualBody only replaces body).
  const originalBaseHref = doc.querySelector('base[href]')?.getAttribute('href');
  const protectedNodes = [];
  // Body metadata can trigger navigation or alter assets. Park it in inert
  // placeholders while editing, restore exactly during serialization.
  doc.body.querySelectorAll('base,meta[http-equiv]').forEach(node => {
    if (node.tagName !== 'BASE' && !/^(content-security-policy|refresh)$/i.test(node.httpEquiv)) return;
    const marker = 'dsh-hve-preserve-' + token + '-' + protectedNodes.length;
    protectedNodes.push([marker, node.outerHTML]);
    node.replaceWith(doc.createComment(marker));
  });
  doc.head.querySelectorAll('meta[http-equiv]').forEach(m => {
    if (/^(content-security-policy|refresh)$/i.test(m.httpEquiv)) m.remove();
  });
  let resolvedBase = baseUrl;
  if (originalBaseHref) {
    try { resolvedBase = new URL(originalBaseHref, baseUrl).href; } catch {}
  }
  if (!/^https?:/i.test(resolvedBase)) resolvedBase = baseUrl;
  doc.querySelectorAll('base').forEach(e => e.remove());
  const base = doc.createElement('base'); base.href = resolvedBase;
  doc.head.prepend(base);
  // No original JS is run. Kept original nodes/attributes round-trip unchanged.
  const csp = doc.createElement('meta'); csp.httpEquiv = 'Content-Security-Policy';
  csp.content = `default-src 'none'; script-src 'nonce-${token}'; script-src-attr 'none'; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri http: https:`;
  doc.head.prepend(csp);
  const style = doc.createElement('style'); style.setAttribute('data-dsh-hve-injected', token);
  style.textContent = 'html[data-dsh-hve-mode="edit"] body{outline:2px dashed #4f7cff;outline-offset:-3px;min-height:calc(100vh - 16px)}html[data-dsh-hve-mode="edit"] body:focus{outline-color:#2f61ed}';
  doc.head.appendChild(style);
  // Serialize a marker, then insert the trusted script as text. Chromium can
  // hide a DOM script's nonce content attribute during DOM serialization; a
  // missing nonce would leave a perfectly rendered but permanently inert frame.
  // Keep bootstrap before original stylesheets: a trailing inline script can
  // wait on a slow stylesheet. Its ready signal still waits for complete parsing.
  const marker = 'dsh-hve-bootstrap-' + token;
  csp.after(doc.createComment(marker));
  const safeJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const script = ('(' + visualFrameRuntime.toString() + ')(' + safeJson(token) + ',' + safeJson(origin) + ',' + safeJson(protectedNodes) + ');').replace(/<\/script/gi, '<\\/script');
  const bridge = '<script nonce="' + token + '" data-dsh-hve-injected="' + token + '">' + script + '</script>';
  return ('<!DOCTYPE html>\n' + doc.documentElement.outerHTML).replace('<!--' + marker + '-->', bridge);
}
