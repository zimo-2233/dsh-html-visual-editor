import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createVisualDocument} from '../src/engine.js';
const dom=new JSDOM('');
const RealParser=dom.window.DOMParser;
const options={token:'boot_nonce_0123456789abcdef',baseUrl:'http://127.0.0.1:58871/sidebar/html/S/C%3A/test.html',parentOrigin:'http://127.0.0.1:58871'};
globalThis.DOMParser=RealParser;

test('bootstrap survives DOM nonce-attribute hiding during serialization',()=>{
  class HiddenNonceParser {
    parseFromString(...args){
      const doc=new RealParser().parseFromString(...args);
      const create=doc.createElement.bind(doc);
      doc.createElement=tag=>{
        const el=create(tag);
        if(tag.toLowerCase()==='script'){
          let nonce='';
          Object.defineProperty(el,'nonce',{get:()=>nonce,set:value=>{nonce=value;el.setAttribute('nonce','');}});
        }
        return el;
      };
      return doc;
    }
  }
  globalThis.DOMParser=HiddenNonceParser;
  try{
    const generated=createVisualDocument('<!doctype html><html><head><style>p{color:red}</style></head><body><p>editable</p></body></html>',options);
    const reparsed=new RealParser().parseFromString(generated,'text/html');
    const script=reparsed.querySelector('[data-dsh-hve-injected][nonce]');
    assert.ok(script);
    assert.equal(script.getAttribute('nonce'),options.token);
    assert.equal(script.parentNode.tagName,'HEAD');
    assert.ok(generated.indexOf('<script nonce=')<generated.indexOf('<style>p{color:red}'));
    assert.ok(generated.includes("script-src 'nonce-"+options.token+"'"));
  }finally{globalThis.DOMParser=RealParser;}
});

test('raw-text body content cannot swallow the bootstrap during srcdoc parsing',()=>{
  const generated=createVisualDocument('<!doctype html><html><head><title>plain</title></head><body><plaintext>example</plaintext></body></html>',options);
  const d=new RealParser().parseFromString(generated,'text/html');
  const script=d.querySelector('script[data-dsh-hve-injected]');
  assert.ok(script,'bootstrap must remain a script element');
  assert.equal(script.parentNode.tagName,'HEAD');
  assert.ok(script.textContent.includes('MessageChannel'));
});
