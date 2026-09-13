#!/usr/bin/env node
/* 精简 DOM 垫片：真实加载 index.html 的两段脚本并驱动核心 UI 流程。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const modelSrc = html.match(/\/\*MODEL\*\/([\s\S]*?)\/\*MODEL\*\//)[1];
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const uiSrc = blocks[1];

let pass=0, fail=0;
function ok(c,m){ if(c){pass++;} else {fail++; console.error('  ✗ '+m);} }
function eq(a,b,m){ ok(JSON.stringify(a)===JSON.stringify(b), `${m} (期望 ${JSON.stringify(b)}, 实际 ${JSON.stringify(a)})`); }
function section(n){ console.log('• '+n); }

/* ---------------- 迷你 DOM ---------------- */
let currentBlob = function(parts,opts){ Object.assign(this,{parts,type:opts&&opts.type,size:(parts||[]).reduce((s,p)=>s+(p.byteLength||p.length||0),0)}); };
const activeHolder = {doc:null};
function parseAttrs(s){
  const attrs={}; const re=/([\w:-]+)(?:\s*=\s*"([^"]*)")?/g; let m;
  while((m=re.exec(s))) attrs[m[1]] = m[2] ?? '';
  return attrs;
}
function txtNode(s){ return {nodeType:3, children:[], _text:s, textContent:s, parentNode:null}; }

function El(tag){
  const dataMap={};
  const dataset=new Proxy(dataMap,{
    get:(t,k)=>k in t ? String(t[k]) : undefined,
    set:(t,k,v)=>{ t[k]=String(v); return true; },
    has:(t,k)=>k in t,
    ownKeys:t=>Reflect.ownKeys(t),
    getOwnPropertyDescriptor:(t,k)=>Object.getOwnPropertyDescriptor(t,k)
  });
  const el = {
    nodeType:1, tagName:tag.toUpperCase(), children:[], parentNode:null,
    attributes:{}, style:{}, dataset, value:'', checked:false, disabled:false,
    title:'', type:'', draggable:false, width:0, height:0, _cls:new Set(),
  };
  Object.defineProperty(el,'className',{get(){return [...el._cls].join(' ');},set(v){el._cls=new Set(String(v).split(/\s+/).filter(Boolean));}});
  Object.defineProperty(el,'textContent',{get(){return el._text ?? '';},set(v){el._text=String(v); el.children=[];}});
  Object.defineProperty(el,'innerHTML',{get(){return el._html??'';},set(v){el._html=v; el.children=[]; parseHTML(v,el);}});
  el.classList={
    add(...c){c.forEach(x=>x&&el._cls.add(x));},
    remove(...c){c.forEach(x=>el._cls.delete(x));},
    toggle(c,f){const want=f===undefined?!el._cls.has(c):!!f; want?el._cls.add(c):el._cls.delete(c);},
    contains(c){return el._cls.has(c);}
  };
  el.setAttribute=(k,v)=>{el.attributes[k]=String(v); if(k.startsWith('data-'))el.dataset[k.slice(5)]=String(v); if(k==='class')el.className=v; if(k==='value')el.value=String(v); if(k==='checked')el.checked=true; if(k==='type')el.type=String(v);};
  el.getAttribute=k=>el.attributes[k]??null;
  el.hasAttribute=k=>k in el.attributes;
  el.appendChild=c=>{c.parentNode=el; el.children.push(c); return c;};
  el.append=(...cs)=>cs.forEach(c=>el.appendChild(typeof c==='string'?txtNode(c):c));
  el.removeChild=c=>{const i=el.children.indexOf(c); if(i>=0){el.children.splice(i,1); c.parentNode=null;}};
  el.remove=()=>el.parentNode&&el.parentNode.removeChild(el);
  el.listeners={};
  el.addEventListener=(t,fn)=>{(el.listeners[t]=el.listeners[t]||[]).push(fn);};
  el.removeEventListener=()=>{};
  el.setPointerCapture=()=>{}; el.releasePointerCapture=()=>{};
  el.focus=()=>{ if(activeHolder.doc) activeHolder.doc.activeElement=el; };
  el.blur=()=>{ if(activeHolder.doc && activeHolder.doc.activeElement===el) activeHolder.doc.activeElement=null; };
  el.getBoundingClientRect=()=>el._rect||{left:0,top:0,right:0,bottom:0,width:0,height:0,x:0,y:0};
  el.getContext=()=>ctx2d;
  el.toBlob=cb=>cb(new currentBlob([new Uint8Array([137,80,78,71,13,10,26,10,1,2,3])],{type:'image/png'}));
  el.toDataURL=()=>'data:image/png;base64,';
  el.querySelector=sel=>queryAll(el,sel)[0]||null;
  el.querySelectorAll=sel=>queryAll(el,sel);
  el.matches=sel=>simpleMatch(el,sel);
  el.closest=sel=>{let n=el; while(n&&n.nodeType===1){if(sel.split(',').map(s=>s.trim()).some(s=>simpleMatch(n,s)))return n; n=n.parentNode;} return null;};
  function fire(ev){
    ev.target=el;
    const chain=[]; let n=el; while(n){chain.push(n);n=n.parentNode;}
    for(const node of chain){
      ev.currentTarget=node;
      for(const fn of (node.listeners[ev.type]||[]).slice()){ fn.call(node,ev); if(ev._stop) break; }
      if(ev._stop) break;
    }
    return !ev.defaultPrevented;
  }
  el.dispatchEvent=fire; el.click=()=>fire(new Ev('click'));
  return el;
}
function parseHTML(str, host){
  let i=0; const stack=[host];
  const re=/<(\/?)([a-zA-Z0-9]+)((?:[^>"]*|"[^"]*")*?)(\/?)>|([^<]+)/g;
  let m;
  while((m=re.exec(str))){
    if(m[5]!==undefined){ if(m[5].trim()) stack[stack.length-1].appendChild(txtNode(m[5])); continue; }
    const closing=m[1]==='/', tag=m[2].toLowerCase(), self=m[4]==='/'||['input','br','img','meta'].includes(tag);
    if(closing){ stack.pop(); continue; }
    const e=El(tag);
    for(const [k,v] of Object.entries(parseAttrs(m[3]||''))) e.setAttribute(k,v);
    stack[stack.length-1].appendChild(e);
    if(!self) stack.push(e);
  }
}
function simpleMatch(el,tok){
  if(el.nodeType!==1) return false;
  let rest=tok;
  const tag=rest.match(/^[a-zA-Z0-9]+/);
  if(tag){ if(el.tagName!==tag[0].toUpperCase()) return false; rest=rest.slice(tag[0].length); }
  const re=/([#.][\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g; let m;
  while((m=re.exec(rest))){
    if(m[1]){ if(m[1][0]==='#'&&el.attributes.id!==m[1].slice(1))return false;
      if(m[1][0]==='.'&&!el._cls.has(m[1].slice(1)))return false; }
    else { if(!(m[2] in el.attributes))return false; if(m[3]!==undefined&&String(el.attributes[m[2]])!==m[3])return false; }
  }
  return true;
}
function deepMatch(el,toks){
  // 最右选择器必须命中元素自身，其余 token 沿祖先链匹配
  if(el.nodeType!==1 || !simpleMatch(el,toks[toks.length-1])) return false;
  let n=el.parentNode;
  for(let i=toks.length-2;i>=0;i--){
    let found=false;
    while(n){ if(n.nodeType===1 && simpleMatch(n,toks[i])){ found=true; n=n.parentNode; break; } n=n.parentNode; }
    if(!found) return false;
  }
  return true;
}
function walk(node,fn){ (node.children||[]).forEach(c=>{fn(c); walk(c,fn);}); }
function queryAll(root,sel){
  const groups=sel.split(',').map(s=>s.trim()).map(s=>s.split(/\s+/));
  const out=[];
  walk(root,c=>{ if(c.nodeType===1 && groups.some(g=>deepMatch(c,g))) out.push(c); });
  return out;
}
function Ev(type,init){ return Object.assign({type,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this._stop=true;},stopImmediatePropagation(){this._stop=true;}},init||{}); }

const ctx2d=new Proxy({},{
  get:(t,p)=>{ if(p==='getImageData')return (x,y,w,h)=>({data:new Uint8ClampedArray(w*h*4)});
    if(p==='measureText')return ()=>({width:0});
    return ()=>{}; },
  set:()=>true
});

function FakeBlob(parts,opts){ this.parts=parts; this.type=opts&&opts.type; this.size=(parts||[]).reduce((s,p)=>s+(p.byteLength||p.length||0),0); }

/* ---------------- 沙箱装配 ---------------- */
function makeEnv(store){
  const registry={}; const root=El('body');
  const doc={
    activeElement:null, createElement:t=>El(t), addEventListener(){}, body:root,
    querySelector(sel){
      const m=sel.match(/^#([\w-]+)$/);
      if(m){ if(!registry[m[1]]){ const e=El('div'); e.attributes.id=m[1]; registry[m[1]]=e; root.appendChild(e);} return registry[m[1]]; }
      return queryAll(root,sel)[0]||null;
    },
    querySelectorAll:sel=>queryAll(root,sel),
  };
  activeHolder.doc = doc;
  const winListeners={};
  const win={addEventListener:(t,f)=>{(winListeners[t]=winListeners[t]||[]).push(f);},removeEventListener(){},
    dispatchEvent:ev=>(winListeners[ev.type]||[]).forEach(f=>f(ev)),
    innerWidth:390, innerHeight:780, devicePixelRatio:1, open(){return null;}, scrollTo(){}};
  const blobs=[];
  const BlobCtor=function(parts,opts){const b={parts:parts||[],type:opts&&opts.type,size:(parts||[]).reduce((s,p)=>s+(p.byteLength||p.length||0),0)};blobs.push(b);return b;};
  currentBlob = BlobCtor;
  const env={console,Math,JSON,Date,Uint8Array,Uint8ClampedArray,ArrayBuffer,isFinite,isNaN,parseInt,parseFloat,Promise,
    TextEncoder,TextDecoder,setTimeout:fn=>fn(),clearTimeout(){},setInterval:()=>0,clearInterval(){},
    requestAnimationFrame:()=>1,cancelAnimationFrame(){},
    Blob:BlobCtor,
    URL:{createObjectURL:()=>'blob:x',revokeObjectURL(){}},
    localStorage:{getItem:k=>store[k]??null,setItem:(k,v)=>{store[k]=String(v);},removeItem:k=>{delete store[k];}},
    Event:class{constructor(t,o){this.type=t;Object.assign(this,o||{});}},
    CustomEvent:class{constructor(t,o){this.type=t;Object.assign(this,o||{});}},
    prompt:()=>null, alert(){}, confirm:()=>true,
  };
  env.window=win; win.window=win; win.document=doc; win.localStorage=env.localStorage;
  env.document=doc; env.globalThis=env;
  vm.createContext(env);
  vm.runInContext(modelSrc,env,{filename:'model.js'});
  env.PL = win.PL; // 模型挂在 window 上
  return {env,doc,win,registry,root,blobs,
    boot(){ vm.runInContext(uiSrc,env,{filename:'ui.js'}); return env; },
    M:null};
}

/* ---------------- 运行 ---------------- */
async function main(){
const store={};
const E=makeEnv(store);
const {doc,win}=E;
E.boot();
const M=E.env.PL;
const $=id=>doc.querySelector('#'+id);
const click=el=>el.dispatchEvent(new Ev('click'));
const ptr=(el,t,x,y)=>el.dispatchEvent(new Ev(t,{clientX:x,clientY:y,pointerId:1}));
const wptr=(t,x,y)=>win.dispatchEvent(new Ev(t,{clientX:x,clientY:y,pointerId:1}));
const key=(k,extra)=>win.dispatchEvent(new Ev('keydown',Object.assign({key:k,ctrlKey:false,metaKey:false,shiftKey:false},extra||{})));
const saved=()=>M.deserialize(store['pixelLoomProject.v2']);

section('UI 初始化');
ok(true,'初始化未抛异常');
eq(queryAll(E.root,'.framecard').length,1,'初始 1 张帧卡');
eq(queryAll(E.root,'.layerrow').length,1,'初始 1 个图层行');

section('图层增删/显隐/锁定/外观');
click($('addLayer')); click($('addLayer'));
eq(saved().frames[0].layers.length,3,'两次添加 → 3');
click($('delLayer'));
eq(saved().frames[0].layers.length,2,'删除 → 2');
click($('upLayer'));
let rows=queryAll(E.root,'.layerrow');
click(rows[0].querySelector('.vis'));
ok(saved().frames[0].layers.some(l=>!l.visible),'隐藏生效');
click(queryAll(E.root,'.layerrow')[0].querySelector('.vis'));
click(queryAll(E.root,'.layerrow')[0].querySelector('.lock'));
const blend=$('blend'); blend.value='screen'; blend.dispatchEvent(new Ev('change'));
ok(saved().frames[0].layers.some(l=>l.blend==='screen'),'混合模式写入');
const op=$('layerOpacity');
op.dispatchEvent(new Ev('pointerdown')); op.value=0.5; op.dispatchEvent(new Ev('input')); wptr('pointerup');
ok(Math.abs(saved().frames[0].layers[1].opacity-0.5)<1e-9,'不透明度 0.5 写入');
// 在锁定图层上绘制（顶行=数组末=当前选中刚锁定的）
const stage=$('canvas');
stage._rect={left:0,top:0,width:640,height:640,right:640,bottom:640};
ptr(stage,'pointerdown',20,20); wptr('pointerup');
ok(saved().frames[0].layers.every(l=>l.pixels.every(c=>c===null)),'锁定图层拒绝绘制');
click(queryAll(E.root,'.layerrow')[0].querySelector('.lock'));

section('像素绘制 + 撤销重做');
ptr(stage,'pointerdown',20,20); ptr(stage,'pointermove',60,20); wptr('pointerup');
let p=saved();
eq(p.frames[0].layers[p.sel.layer].pixels.slice(0,2),['#ff7aa8','#ff7aa8'],'笔画落两格');
key('z',{ctrlKey:true});
ok(saved().frames[0].layers.every(l=>l.pixels[0]===null),'Ctrl+Z 撤销像素');
key('z',{ctrlKey:true,shiftKey:true});
ok(saved().frames[0].layers.some(l=>l.pixels[0]==='#ff7aa8'),'Ctrl+Shift+Z 重做像素');
// Ctrl+S 保存不抛错
key('s',{ctrlKey:true}); ok(true,'Ctrl+S 无异常');

section('关键帧打点、补间与搓条');
// 先在 t=0 打 x 关键帧
click(queryAll(E.root,'.dia').find(b=>b.dataset.ch==='x'));
p=saved();
ok(p.frames[0].layers[p.sel.layer].keys.some(k=>k.ch==='x'&&k.t===0),'t=0 x 关键帧');
// 搓到 t=1 再打点并赋值 100
const scrubEl=$('scrub');
scrubEl._rect={left:0,top:0,width:1000,height:34,right:1000,bottom:34};
ptr(scrubEl,'pointerdown',995,17); ptr(scrubEl,'pointerup',995,17);
click(queryAll(E.root,'.dia').find(b=>b.dataset.ch==='x'));
const xr=queryAll(E.root,'input[data-ch="x"]')[0];
xr.dispatchEvent(new Ev('pointerdown')); xr.value=100; xr.dispatchEvent(new Ev('input')); wptr('pointerup');
p=saved();
const L=p.frames[0].layers[p.sel.layer];
ok(L.keys.some(k=>k.ch==='x'&&Math.abs(k.v-100)<1e-9),'t=1 x=100 关键帧');
approx(M.evalLayerAt(L,0.5).x,50,1e-9,'模型补间中点 50');
// 搓到中点：舞台画布被重绘（验证不抛错且时间读数更新）
ptr(scrubEl,'pointerdown',500,17); ptr(scrubEl,'pointerup',500,17);
ok(['0.12s','0.13s'].includes($('timeread').textContent),'单帧 50% 时间读数 ≈0.125s（实际 '+$('timeread').textContent+'）');
// 拖拽关键帧（在中点的 x 关键帧不存在；把 t=1 的关键帧拖到 0.75）
scrubEl._rect={left:0,top:0,width:1000,height:34,right:1000,bottom:34};
const keyEl=queryAll(E.root,'.key.ch-x').find(k=>Math.abs(+k.dataset.t-1)<1e-9);
ok(!!keyEl,'搓条上存在终点 x 关键帧菱形');
ptr(keyEl,'pointerdown',1000,17);
ptr(scrubEl,'pointermove',750,17);
ptr(scrubEl,'pointerup',750,17);
p=saved();
const L2=p.frames[0].layers[p.sel.layer];
ok(L2.keys.some(k=>k.ch==='x'&&Math.abs(k.t-0.75)<1e-9),'关键帧拖拽到 0.75');
ok(!L2.keys.some(k=>k.ch==='x'&&Math.abs(k.t-1)<1e-9),'旧时刻 1.0 关键帧已移走');
// 删除关键帧（钻石再点一次，此刻播放头在 0.75）
click(queryAll(E.root,'.dia').find(b=>b.dataset.ch==='x'));
ok(!saved().frames[0].layers[p.sel.layer].keys.some(k=>k.ch==='x'&&Math.abs(k.t-0.75)<1e-9),'钻石删除关键帧');

section('帧：新增/复制/时长/删除保护/排序');
click($('addFrame')); click($('dupFrame'));
eq(saved().frames.length,3,'新增+复制 → 3 帧');
eq(new Set(saved().frames.map(f=>f.id)).size,3,'帧 id 唯一');
eq(new Set(saved().frames.flatMap(f=>f.layers.map(l=>l.id))).size,
   saved().frames.reduce((s,f)=>s+f.layers.length,0),'图层 id 全局唯一');
const dur=queryAll(E.root,'.fdur')[0];
dur.value=500; dur.dispatchEvent(new Ev('change'));
eq(saved().frames[0].duration,500,'帧时长 500ms');
// 删除保护
for(let i=0;i<5;i++){ const b=queryAll(E.root,'.fdel')[0]; if(b) b.click(); }
eq(saved().frames.length,1,'最后一帧不可删除');

section('键盘播放/切帧/工具');
key(' '); ok($('play').textContent.includes('暂停'),'空格播放');
key(' '); ok($('play').textContent.includes('播放'),'空格暂停');
click($('addFrame'));
key('ArrowRight'); key('ArrowLeft'); key('Home');
['b','e','g','i'].forEach(k=>key(k));
ok(true,'方向/Home/工具键无异常');
// 循环开关
const loop=$('loop'); loop.checked=false; loop.dispatchEvent(new Ev('change'));
eq(saved().loop,false,'关闭循环写入');
loop.checked=true; loop.dispatchEvent(new Ev('change'));

section('导出：当前帧 / 精灵表 / APNG');
E.blobs.length=0;
click($('expFrame'));
ok(E.blobs.some(b=>b.type==='image/png'),'当前帧 PNG');
click($('expSheet'));
ok(E.blobs.some(b=>b.type==='image/png'),'精灵表 PNG');
ok(E.blobs.some(b=>b.type==='application/json'),'精灵表 JSON');
click($('expApng'));
const apng=await new Promise(r=>setTimeout(()=>r(E.blobs.filter(b=>b.type==='image/png').pop()),0));
ok(apng && apng.size>100,'APNG 产生字节');
const bytes=apng.parts[0];
ok(bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71,'APNG 签名');
// 校验含 acTL
const all=Buffer.concat(apng.parts.map(x=>Buffer.from(x)));
ok(all.includes(Buffer.from('acTL')),'APNG 含 acTL 块');
ok(all.includes(Buffer.from('fcTL')),'APNG 含 fcTL 块');

section('极端：快速乱点/无效输入不崩溃');
for(let i=0;i<40;i++){ click($('addLayer')); }
for(let i=0;i<15;i++){ click($('delLayer')); }
ok(saved().frames.every(f=>f.layers.length>=1),'每帧至少 1 图层');
for(let i=0;i<40;i++){ click($('addFrame')); }
for(let i=0;i<60;i++){ const b=queryAll(E.root,'.fdel')[0]; if(b)b.click(); }
ok(saved().frames.length>=1,'至少 1 帧');
const badDur=queryAll(E.root,'.fdur')[0];
badDur.value='abc'; badDur.dispatchEvent(new Ev('change'));
ok(saved().frames[0].duration>=M.DUR_MIN,'非法时长被钳制');
key('z',{ctrlKey:true}); key('z',{ctrlKey:true}); key('z',{ctrlKey:true});
key('y',{ctrlKey:true});
ok(true,'连续撤销重做不崩溃');

section('刷新后完整恢复（新沙箱读同一 localStorage）');
click($('save'));
const raw=store['pixelLoomProject.v2'];
const before=JSON.parse(raw);
const E2=makeEnv({'pixelLoomProject.v2':raw});
E2.boot();
const p2=E2.env.PL.deserialize(raw);
eq(p2.frames.length,before.frames.length,'恢复帧数');
eq(p2.loop,before.loop,'恢复循环开关');
// 关键帧/像素/外观逐项对比
let same=0,total=0;
p2.frames.forEach((f,i)=>{
  eq(f.duration,before.frames[i].duration,'帧'+i+' 时长');
  f.layers.forEach((l,j)=>{
    const b=before.frames[i].layers[j];
    total++;
    if(l.blend===b.blend&&l.opacity===b.opacity&&l.visible===b.visible&&l.locked===b.locked
       &&JSON.stringify(l.pixels)===JSON.stringify(b.pixels)
       &&JSON.stringify(l.keys)===JSON.stringify(b.keys)) same++;
  });
});
eq(same,total,'全部图层外观/像素/关键帧完整恢复');
eq(queryAll(E2.root,'.framecard').length,p2.frames.length,'恢复后帧卡数');
eq(queryAll(E2.root,'.layerrow').length,p2.frames[p2.sel.frame].layers.length,'恢复后图层行数');
// 恢复后仍可编辑并再次撤销
E2.doc.querySelector('#addFrame').click();
eq(E2.env.PL.deserialize(E2.env.localStorage.getItem('pixelLoomProject.v2')).frames.length,p2.frames.length+1,'恢复后可继续加帧');
E2.win.dispatchEvent(new Ev('keydown',{key:'z',ctrlKey:true}));
eq(E2.env.PL.deserialize(E2.env.localStorage.getItem('pixelLoomProject.v2')).frames.length,p2.frames.length,'恢复后撤销可用');

section('BUG 复现 1：切到图层更少的帧 → 自动选中有效图层，面板不空白');
{
  const R = makeEnv({}); R.boot();
  const d = R.doc, w = R.win, Mx = R.env.PL;
  const read = () => Mx.deserialize(R.env.localStorage.getItem('pixelLoomProject.v2'));
  const cards = () => queryAll(R.root,'.framecard');
  const rows  = () => queryAll(R.root,'.layerrow');
  const activeRow = () => rows().find(r=>r._cls.has('active'));

  // 帧0：加两层 → 共 3 层；新增帧1（继承 3 层）
  d.querySelector('#addLayer').click();
  d.querySelector('#addLayer').click();
  d.querySelector('#addFrame').click();
  // 在帧1删掉两层，只剩 1 层
  for(let k=0;k<2;k++){
    d.querySelector('#delLayer').click();
  }
  eq(read().frames[1].layers.length,1,'帧1 只剩 1 层');
  // 点回帧0，选中第 3 层（数组末）
  cards()[0].dispatchEvent(new Ev('click'));
  rows()[0].dispatchEvent(new Ev('click')); // 显示序首行 = 数组末层
  // 纯选择切换不触发保存，通过实时 DOM 校验选中层
  let active = activeRow();
  ok(!!active && active.dataset.li==='2','帧0 选中第 3 层（活动行 data-li=2）');
  // 关键：点到只有 1 层的帧1
  cards()[1].dispatchEvent(new Ev('click'));
  // 实时 DOM：图层列表必须仍有选中行、变换面板不为空
  active = activeRow();
  ok(!!active,'切帧后图层列表存在选中行（不丢失高亮）');
  ok(active.dataset.li==='0','选中帧1 的有效图层 0（实际 '+active.dataset.li+'）');
  eq(queryAll(R.root,'#channels .dia').length,5,'变换面板渲染 5 个通道（不为空）');
  eq(queryAll(R.root,'#channels input[type=range]').length,5,'5 个通道滑杆都在');
  // 触发一次真实编辑（切换显隐）使选择写入存档，再核对 sel
  active.querySelector('.vis').dispatchEvent(new Ev('click'));
  let pp = read();
  eq(pp.sel.frame,1,'存档：当前帧=1');
  ok(pp.sel.layer===0 && !!pp.frames[1].layers[0],'存档：帧1 自动夹到有效图层 0');
  // 方向键切帧同样安全
  d.querySelector('#addFrame').click(); // 帧2 继承帧1 的 1 层
  w.dispatchEvent(new Ev('keydown',{key:'ArrowLeft'}));
  const pp2 = read();
  ok(pp2.frames[pp2.sel.frame].layers[pp2.sel.layer]!==undefined,'← 切帧后图层选择有效');
  ok(queryAll(R.root,'#channels input[type=range]').length===5,'← 后通道滑杆仍在');
  // 搓条播放跨帧也不白屏（直接驱动：把播放头移到帧2区间，采样切帧）
  const scrub = d.querySelector('#scrub');
  scrub._rect={left:0,top:0,width:1000,height:34,right:1000,bottom:34};
  scrub.dispatchEvent(new Ev('pointerdown',{clientX:995,clientY:17,pointerId:1}));
  scrub.dispatchEvent(new Ev('pointerup',{clientX:995,clientY:17,pointerId:1}));
  const pp3 = read();
  ok(pp3.frames[pp3.sel.frame].layers[pp3.sel.layer]!==undefined,'搓条跨帧后图层选择有效');
  ok(!!queryAll(R.root,'.layerrow').find(r=>r._cls.has('active')),'搓条后仍有选中图层行');
}

section('BUG 复现 2：键盘调整图层不透明度 → 入历史、可撤销、可保存');
{
  const R = makeEnv({}); R.boot();
  const d = R.doc, w = R.win, Mx = R.env.PL;
  const read = () => Mx.deserialize(R.env.localStorage.getItem('pixelLoomProject.v2'));
  const slider = d.querySelector('#layerOpacity');
  d.querySelector('#save').click(); // 先落盘初始状态
  slider.focus();
  eq(read().frames[0].layers[0].opacity,1,'初始不透明度 1');

  // 键盘：聚焦滑块后按方向键，浏览器会改 value 并派发 input/change；垫片里手动模拟该序列
  slider.dispatchEvent(new Ev('keydown',{key:'ArrowRight'}));
  slider.value = '0.9';
  slider.dispatchEvent(new Ev('input'));
  slider.dispatchEvent(new Ev('change'));
  const after1 = read();
  ok(Math.abs(after1.frames[0].layers[0].opacity-0.9)<1e-9,'键盘调整写入项目（0.9）');
  // 自动保存：直接从 localStorage 重新反序列化得到 0.9（已在 read 中验证）
  // 撤销
  w.dispatchEvent(new Ev('keydown',{key:'z',ctrlKey:true}));
  const undone = read();
  ok(Math.abs(undone.frames[0].layers[0].opacity-1)<1e-9,'Ctrl+Z 撤销键盘不透明度调整（回到 1）');
  // 重做
  w.dispatchEvent(new Ev('keydown',{key:'y',ctrlKey:true}));
  const redone = read();
  ok(Math.abs(redone.frames[0].layers[0].opacity-0.9)<1e-9,'Ctrl+Y 重做回 0.9');
  // 刷新恢复：新沙箱读同一存档
  const R2 = makeEnv({'pixelLoomProject.v2':R.env.localStorage.getItem('pixelLoomProject.v2')});
  R2.boot();
  const restored = R2.env.PL.deserialize(R2.env.localStorage.getItem('pixelLoomProject.v2'));
  ok(Math.abs(restored.frames[0].layers[0].opacity-0.9)<1e-9,'刷新后不透明度仍为 0.9（不回退）');
  // 标签显示也恢复成 90%
  eq(R2.doc.querySelector('#opLabel').textContent,'90%','恢复后 UI 不透明度标签 90%');

  // 指针拖拽路径仍正常（单条历史、可撤销）
  slider.blur();
  slider.dispatchEvent(new Ev('pointerdown'));
  slider.value='0.3'; slider.dispatchEvent(new Ev('input'));
  w.dispatchEvent(new Ev('pointerup'));
  ok(Math.abs(read().frames[0].layers[0].opacity-0.3)<1e-9,'拖拽调整为 0.3');
  w.dispatchEvent(new Ev('keydown',{key:'z',ctrlKey:true}));
  ok(Math.abs(read().frames[0].layers[0].opacity-0.9)<1e-9,'撤销拖拽回到 0.9');
}

section('旧版 v1 存档迁移');
const cells=Array(256).fill(null); cells[7]='#010203';
const v1=JSON.stringify({fps:4,frames:[cells]});
const E3=makeEnv({'pixelLoom':v1}); // 注意：旧键名 pixelLoom
E3.boot();
const migrated=E3.env.PL.deserialize(E3.env.localStorage.getItem('pixelLoomProject.v2') ?? v1);
ok(!!migrated,'v1 迁移成功');
eq(migrated.frames[0].layers[0].pixels[7],'#010203','v1 像素保留');
ok(Math.abs(migrated.frames[0].duration-250)<1e-9,'v1 按 fps 推导时长');

function approx(a,b,eps,m){ok(Math.abs(a-b)<=eps,`${m} (期望 ${b}, 实际 ${a})`);}

console.log(`\n${fail?'❌':'✅'} UI 冒烟：通过 ${pass} 项，失败 ${fail} 项`);
if(fail) process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exit(1);});
