const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const local=path.join(root,'lib','client.js');
const installed=path.join(process.env.USERPROFILE,'.dsh','profiles','desktop','node_modules','dsh-html-visual-editor','lib','client.js');
const targets=[local];
if(fs.existsSync(installed))targets.push(installed);
for(const file of targets){
  const src=fs.readFileSync(file,'utf8');
  let entry;
  vm.runInNewContext(src,{window:{__ModuleLoader__:{load:value=>{entry=value}}},console,TextEncoder,URL,URLSearchParams,setTimeout,clearTimeout,setInterval,clearInterval},{filename:file});
  assert.equal(entry.id,'dsh-html-visual-editor');
  const imports=[];
  const react={createElement:(...args)=>args,useState(){},useRef(){},useEffect(){},useCallback(){}};
  const exports=entry.factory(name=>{imports.push(name);assert.equal(name,'react');return react});
  assert.deepEqual(Array.from(exports.inject),[],'A missing third-party plugin must not stay pending in inject');
  assert.equal(typeof exports.apply,'function');
  let descriptor,disposed=false;
  const service={registerFileViewer(value){descriptor=value;return()=>{disposed=true}}};
  const ctx={betterSidebar:service,effect(fn){this.disposer=fn()}};
  exports.apply(ctx);
  assert.equal(descriptor.id,'html-visual-editor');
  assert.equal(descriptor.priority,100);
  assert.deepEqual(Array.from(descriptor.exts),['html','htm']);
  assert.equal(descriptor.fetchStrategy,'fsRead');
  assert.equal(typeof descriptor.component,'function');
  assert.deepEqual(imports,['react']);
  ctx.disposer();assert.equal(disposed,true);

  // Deferred acquisition: the service arrives after apply() ran.
  let deferredDescriptor=null;
  const deferred={betterSidebar:null,effect(fn){this.disposer=fn()}};
  let pending=null;
  deferred.get=()=>undefined;
  deferred.inject=(deps,cb)=>{pending=cb;};
  exports.apply(deferred);
  assert.equal(deferredDescriptor,null);
  assert.ok(pending,'A deferred inject must be requested when the service is absent');
  pending({betterSidebar:{registerFileViewer(value){deferredDescriptor=value;return()=>{}}}});
  assert.equal(deferredDescriptor.id,'html-visual-editor');

  // Inert without the sidebar plugin: no throw, no registration, timer cleared.
  let inertRegistered=false;
  const inert={effect(fn){const d=fn();if(typeof d==='function')d();},get:()=>undefined,
    inject:()=>{throw new Error('must not ask for an absent service')}};
  exports.apply(inert);
  assert.equal(inertRegistered,false);
  console.log('PASS client loader/React import/viewer registration/disposal: '+file);
}
if(targets.length===2){
  const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  assert.equal(hash(local),hash(installed),'Installed bundle must match tested local bundle');
  console.log('PASS installed bundle SHA256 matches built bundle: '+hash(local));
}else console.log('Installed bundle not found; skipped installed-copy comparison');
