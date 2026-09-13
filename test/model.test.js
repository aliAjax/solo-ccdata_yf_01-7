#!/usr/bin/env node
/* 从 index.html 抽取 /*MODEL*​/ 段落在 vm 沙箱中执行，验证核心与极端流程。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/\/\*MODEL\*\/([\s\S]*?)\/\*MODEL\*\//);
if(!m){ console.error('找不到 MODEL 段落'); process.exit(1); }

const sandbox = { globalThis: {}, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(m[1], sandbox, {filename:'model.js'});
const M = sandbox.PL;
if(!M){ console.error('模型未导出 PL'); process.exit(1); }

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg){
  if(cond){ pass++; } else { fail++; fails.push(msg); console.error('  ✗ ' + msg); }
}
function eq(a, b, msg){ ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (期望 ${JSON.stringify(b)}, 实际 ${JSON.stringify(a)})`); }
function approx(a, b, eps, msg){ ok(Math.abs(a-b) <= (eps||1e-9), `${msg} (期望 ${b}, 实际 ${a})`); }
function section(n){ console.log('• ' + n); }

function proj(){ return M.attachHistory(M.newProject()); }
const histLen = p => p._past.length;

/* ---------------- 1. 基础结构 ---------------- */
section('项目/帧/图层基础');
{
  const p = proj();
  eq(p.frames.length, 1, '初始 1 帧');
  eq(p.frames[0].layers.length, 1, '初始 1 图层');
  eq(M.evalLayerAt(p.frames[0].layers[0], 0.5),
     {x:0,y:0,scale:1,rot:0,op:1}, '无关键帧时通道为默认值');
  ok(p.frames[0].duration === 250, '默认帧时长 250ms');
}

/* ---------------- 2. 图层增删/排序/显隐/锁定/外观 ---------------- */
section('图层操作');
{
  const p = proj();
  M.addLayer(p);
  eq(p.frames[0].layers.length, 2, '添加图层 → 2');
  eq(p.sel.layer, 1, '新图层被选中');
  p.frames[0].layers[0].name = '底'; p.frames[0].layers[1].name = '顶';
  M.duplicateLayer(p, 0);
  eq(p.frames[0].layers.map(l=>l.name), ['底','底 副本','顶'], '复制图层插在其后');
  // 深拷贝独立性
  p.frames[0].layers[0].pixels[0] = '#123456';
  ok(p.frames[0].layers[1].pixels[0] === null, '复制图层像素独立');

  // 排序语义：[a,b,c] from 0 → to 2 ⇒ [b,c,a]
  const p2 = proj();
  M.addLayer(p2); M.addLayer(p2);
  const ids = p2.frames[0].layers.map(l=>l.id);
  M.moveLayer(p2, 0, 2);
  eq(p2.frames[0].layers.map(l=>l.id), [ids[1],ids[2],ids[0]], 'moveLayer 0→2 末位');
  M.moveLayer(p2, 2, 0);
  eq(p2.frames[0].layers.map(l=>l.id), [ids[0],ids[1],ids[2]], 'moveLayer 2→0 首位');
  const before = histLen(p2);
  M.moveLayer(p2, 0, 0);
  eq(histLen(p2), before, '同序移动不入历史');
  M.moveLayer(p2, 99, 0);
  eq(histLen(p2), before, '越界移动不入历史');

  // 删除最后一个被拒绝
  const p3 = proj();
  M.deleteLayer(p3, 0);
  eq(p3.frames[0].layers.length, 1, '至少保留一个图层');
  eq(histLen(p3), 0, '拒绝删除不产生历史');
  M.addLayer(p3); M.deleteLayer(p3, 0);
  eq(p3.sel.layer, 0, '删除后选择夹到有效范围');

  const p4 = proj();
  M.toggleVisible(p4,0); ok(p4.frames[0].layers[0].visible === false, '隐藏');
  M.toggleVisible(p4,0); ok(p4.frames[0].layers[0].visible === true, '恢复显示');
  M.toggleLocked(p4,0); ok(p4.frames[0].layers[0].locked === true, '锁定');
  M.setLayerOpacity(p4, 0, 0.42); approx(p4.frames[0].layers[0].opacity, 0.42, 1e-9, '透明度设置');
  M.setLayerOpacity(p4, 0, 5); eq(p4.frames[0].layers[0].opacity, 1, '透明度上夹');
  M.setLayerOpacity(p4, 0, -3); eq(p4.frames[0].layers[0].opacity, 0, '透明度下夹');
  M.setLayerOpacity(p4, 0, 1);
  const h4 = histLen(p4);
  M.setLayerOpacity(p4, 0, 1); eq(histLen(p4), h4, '重复值不入历史');
  M.setBlend(p4,0,'screen'); eq(p4.frames[0].layers[0].blend, 'screen', '混合模式');
  M.setBlend(p4,0,'not-a-mode'); eq(p4.frames[0].layers[0].blend, 'screen', '非法混合模式被拒');
  const beforeName = p4.frames[0].layers[0].name;
  M.renameLayer(p4,0,'  ');
  eq(p4.frames[0].layers[0].name, beforeName, '空白名保留原名');
}

/* ---------------- 3. 像素绘制：锁/橡皮/填充/笔画历史 ---------------- */
section('像素绘制与填充');
{
  const p = proj();
  const L = () => p.frames[0].layers[0];
  M.beginStroke(p); M.strokePixel(p, 0, 0, '#ff0000'); M.strokePixel(p, 1, 0, '#ff0000'); M.endStroke(p);
  eq([L().pixels[0], L().pixels[1]], ['#ff0000','#ff0000'], '笔画上色');
  eq(histLen(p), 1, '一次笔画一条历史');
  // 空笔画（越界/无变化）不入历史
  M.beginStroke(p); M.strokePixel(p, 0, 0, '#ff0000'); M.strokePixel(p, 99, 99, '#ff0000'); M.endStroke(p);
  eq(histLen(p), 1, '无变化笔画被丢弃');
  // 橡皮
  M.beginStroke(p); M.strokePixel(p, 0, 0, null); M.endStroke(p);
  ok(L().pixels[0] === null, '橡皮清除');
  // 锁定不可画（切换锁定本身记历史，此处只验证笔画不加历史）
  M.toggleLocked(p,0);
  const hLocked = histLen(p);
  M.beginStroke(p); M.strokePixel(p, 5, 5, '#00ff00'); M.endStroke(p);
  ok(L().pixels[5*16+5] === null, '锁定图层笔画无效');
  eq(histLen(p), hLocked, '锁定笔画不产生历史');
  M.toggleLocked(p,0);
  // 洪水填充
  M.fillAt(p, 15, 15, '#0000ff');
  // 除了 (1,0) 红，其余 255 格连通空白全部填蓝（锁定的绿格未落笔）
  eq(L().pixels.filter(c=>c==='#0000ff').length, 255, '空白连通区域全部填充 255 格');
  eq(L().pixels[1], '#ff0000', '红格未被填充波及');
  // 同色填充不入历史
  const h = histLen(p);
  M.fillAt(p, 15, 15, '#0000ff');
  eq(histLen(p), h, '同色填充不入历史');
}

/* ---------------- 4. 关键帧与补间 ---------------- */
section('关键帧与补间');
{
  const p = proj();
  const l = p.frames[0].layers[0];
  M.upsertKey(l,'x',0,0); M.upsertKey(l,'x',1,100);
  const e0 = M.evalLayerAt(l,0), e5 = M.evalLayerAt(l,0.5), e1 = M.evalLayerAt(l,1);
  eq(e0.x, 0, '补间起点'); eq(e5.x, 50, '线性中点 50'); eq(e1.x, 100, '补间终点');
  approx(M.evalLayerAt(l,0.25).x, 25, 1e-9, '1/4 处 25');
  // 区间外保持端值
  eq(M.evalLayerAt(l,-1).x, 0, 't<0 持起点');
  eq(M.evalLayerAt(l,2).x, 100, 't>1 持终点');
  // 单关键帧保持
  const p2 = proj();
  M.upsertKey(p2.frames[0].layers[0],'scale',0.3,2);
  eq(M.evalLayerAt(p2.frames[0].layers[0],0).scale, 2, '单关键帧 t=0');
  eq(M.evalLayerAt(p2.frames[0].layers[0],0.9).scale, 2, '单关键帧恒定');

  // 缓动
  const p3 = proj();
  M.upsertKey(p3.frames[0].layers[0],'y',0,0);
  const k1 = M.upsertKey(p3.frames[0].layers[0],'y',1,100);
  k1.ease = 'easeIn';
  approx(M.evalLayerAt(p3.frames[0].layers[0],0.5).y, 25, 1e-9, 'easeIn 中点 25');
  k1.ease = 'easeOut';
  approx(M.evalLayerAt(p3.frames[0].layers[0],0.5).y, 75, 1e-9, 'easeOut 中点 75');
  k1.ease = 'easeInOut';
  eq(M.evalLayerAt(p3.frames[0].layers[0],0.5).y, 50, 'easeInOut 中点 50');

  // 同刻更新而非新增
  M.upsertKey(l,'x',1,120);
  eq(l.keys.filter(k=>k.ch==='x').length, 2, '同刻 upsert 不新增');
  eq(M.evalLayerAt(l,1).x, 120, 'upsert 更新值');

  // 时间量化：24 格
  M.upsertKey(l,'rot',0.126, 90);
  ok(Math.abs(l.keys.find(k=>k.ch==='rot').t - 0.125) < 1e-9, '时间量化到 1/24');
  // 通道钳制
  M.upsertKey(l,'op',0.5, 9);
  eq(M.evalLayerAt(l,0.5).op, 1, 'op 钳到 1');
  M.upsertKey(l,'scale',0.5, -5);
  eq(M.evalLayerAt(l,0.5).scale, 0, 'scale 钳到 0');

  // 移动关键帧：占用点拒绝
  const p4 = proj();
  const l4 = p4.frames[0].layers[0];
  M.upsertKey(l4,'op',0,0); M.upsertKey(l4,'op',1,1);
  ok(M.moveKey(l4,'op',0,1) === false, '移到已存在的刻点被拒绝');
  ok(l4.keys.find(k=>k.ch==='op'&&k.t===0), '拒绝后原关键帧保留');
  ok(M.moveKey(l4,'op',0,0.5), 'moveKey 成功');
  ok(M.findKey(l4,'op',0.5), '新位置存在关键帧');
  ok(!M.findKey(l4,'op',0), '旧位置关键帧消失');
  // 不同通道允许同时刻
  M.upsertKey(l4,'x',0.5,10);
  ok(M.findKey(l4,'op',0.5) && M.findKey(l4,'x',0.5), '不同通道可共享时刻');

  // 图层间补间独立
  M.addLayer(p);
  const a = p.frames[0].layers[0], b = p.frames[0].layers[1];
  M.upsertKey(b,'x',0,-50); M.upsertKey(b,'x',1,50);
  eq(M.evalLayerAt(a,0.5).x, 60, '图层 A 补间不受影响');
  eq(M.evalLayerAt(b,0.5).x, 0, '图层 B 独立补间');
}

/* ---------------- 5. 关键帧手势（自动打点/取消/历史） ---------------- */
section('关键帧手势与撤销');
{
  const p = proj();
  M.keyGestureBegin(p,0,0,'x',0.5);
  ok(M.findKey(p.frames[0].layers[0],'x',0.5), '手势开始自动打点');
  M.keyGestureValue(p, 40);
  eq(M.evalLayerAt(p.frames[0].layers[0],0.5).x, 40, '手势改值');
  M.keyGestureCancel(p);
  ok(!M.findKey(p.frames[0].layers[0],'x',0.5), 'Esc 取消后关键帧回滚');
  eq(histLen(p), 0, '取消后不留历史');

  M.keyGestureBegin(p,0,0,'y',0.2);
  M.keyGestureValue(p, 30);
  M.keyGestureEnd(p);
  eq(histLen(p), 1, '正常结束保留 1 条历史');
  eq(M.undo(p), '调整关键帧', '撤销标签');
  ok(!M.findKey(p.frames[0].layers[0],'y',0.2), '撤销移除手势产生的关键帧');

  // 打点/删点切换
  const p2 = proj();
  M.toggleKey(p2,0,0,'scale',0.5);
  ok(M.findKey(p2.frames[0].layers[0],'scale',0.5), '打点');
  M.toggleKey(p2,0,0,'scale',0.5);
  ok(!M.findKey(p2.frames[0].layers[0],'scale',0.5), '再点删除');
}

/* ---------------- 6. 帧时间线：时长/复制/排序/采样/循环 ---------------- */
section('时间线与采样');
{
  const p = proj();
  M.setFrameDuration(p,0,1000);
  M.addFrame(p);
  M.setFrameDuration(p,1,3000);
  eq(M.totalDuration(p), 4000, '总时长 4000ms');
  eq(M.frameStartAt(p,1), 1000, '第二帧起点 1000');
  let s = M.sampleAt(p, 0);
  eq([s.frameIndex, s.localT], [0,0], '采样 0ms → 帧0');
  s = M.sampleAt(p, 999);
  ok(s.frameIndex===0 && s.localT > 0.99, '帧0 末端');
  s = M.sampleAt(p, 1000);
  eq(s.frameIndex, 1, '1000ms → 帧1');
  approx(s.localT, 0, 1e-9, '帧1 localT=0');
  s = M.sampleAt(p, 2500);
  approx(s.localT, 0.5, 1e-6, '帧1 中点 localT=.5');
  // 循环回绕
  s = M.sampleAt(p, 4000);
  eq(s.frameIndex, 0, '循环：4000 回到帧0');
  s = M.sampleAt(p, 5000);
  eq(s.frameIndex, 1, '循环：5000 → 帧1');
  s = M.sampleAt(p, -1500);
  eq(s.frameIndex, 1, '负时间循环回绕（-1500→2500）');
  approx(s.localT, 0.5, 1e-6, '回绕后 localT=.5');
  s = M.sampleAt(p, -4000);
  eq(s.frameIndex, 0, '恰好一个周期的负时间归首帧');
  // 非循环夹尾
  M.setLoop(p,false);
  s = M.sampleAt(p, 99999);
  eq(s.frameIndex, 1, '非循环夹到最后一帧');
  approx(s.localT, 1, 1e-6, '末端 localT=1');
  M.setLoop(p,true);

  // 时长极端钳制
  M.setFrameDuration(p,0,0); eq(p.frames[0].duration, M.DUR_MIN, '0 时长 → 最小值');
  M.setFrameDuration(p,0,'abc'); eq(p.frames[0].duration, M.DUR_MIN, 'NaN 时长 → 最小值');
  M.setFrameDuration(p,0,99999999); eq(p.frames[0].duration, M.DUR_MAX, '超大时长 → 最大值');
  M.setFrameDuration(p,0,337); eq(p.frames[0].duration, 337, '正常时长');

  // 复制帧是深拷贝且分配新 id
  const f0id = p.frames[0].id, l0id = p.frames[0].layers[0].id;
  p.frames[0].layers[0].pixels[0] = '#aabbcc';
  M.duplicateFrame(p, 0);
  eq(p.frames.length, 3, '复制后 3 帧');
  eq(p.sel.frame, 1, '选中复制帧');
  ok(p.frames[1].id !== f0id, '新帧有新 id');
  ok(p.frames[1].layers[0].id !== l0id, '复制帧图层有新 id');
  eq(p.frames[1].layers[0].pixels[0], '#aabbcc', '复制帧带像素');
  p.frames[1].layers[0].pixels[1] = '#112233';
  ok(p.frames[0].layers[0].pixels[1] === null, '帧复制后像素互不影响');

  // 帧排序语义（最终数组位次）
  const p2 = proj();
  M.addFrame(p2); M.addFrame(p2); M.addFrame(p2);
  const ids = p2.frames.map(f=>f.id);
  M.moveFrame(p2, 0, 3);
  eq(p2.frames.map(f=>f.id), [ids[1],ids[2],ids[3],ids[0]], 'moveFrame 0→3（最终位次）');
  M.moveFrame(p2, 3, 0);
  eq(p2.frames.map(f=>f.id), [ids[0],ids[1],ids[2],ids[3]], 'moveFrame 3→0（最终位次）');
  M.moveFrame(p2, 1, 2);
  eq(p2.frames.map(f=>f.id), [ids[0],ids[2],ids[1],ids[3]], 'moveFrame 1→2（最终位次）');
  const h = histLen(p2);
  M.moveFrame(p2, 1, 1);
  eq(histLen(p2), h, '帧同序移动不入历史');

  // 删除帧保护与选择夹取
  const p3 = proj();
  M.deleteFrame(p3, 0);
  eq(p3.frames.length, 1, '至少保留一帧');
  M.addFrame(p3); M.addFrame(p3);
  p3.sel.frame = 2;
  M.deleteFrame(p3, 2);
  eq(p3.sel.frame, 1, '删除末帧后选择回退');

  // 新帧继承图层结构
  const p4 = proj();
  M.addLayer(p4); M.addLayer(p4);
  M.addFrame(p4);
  eq(p4.frames[1].layers.length, 3, '新帧继承 3 个图层');
  ok(p4.frames[1].layers.every(l=>l.pixels.every(c=>c===null)), '新帧像素空白');
  eq(p4.frames[1].layers.map((l,i)=>l.name), ['图层 1','图层 2','图层 3'], '新帧沿用图层名');

  // exportSamples 数量
  const p5 = proj();
  M.setFrameDuration(p5,0,500); M.addFrame(p5); M.setFrameDuration(p5,1,500);
  const ex = M.exportSamples(p5, 10);
  eq(ex.frames.length, 10, '1s @10fps → 10 个采样');
  eq(ex.frames[0].frameIndex, 0, '首采样在帧0');
  eq(ex.frames[5].frameIndex, 1, '第 6 采样在帧1');
  eq(M.packRect(1).cols + M.packRect(1).rows, 2, 'packRect 1 格');
  const pk = M.packRect(10);
  ok(pk.cols===4 && pk.rows===3, 'packRect(10)=4×3');
}

/* ---------------- 7. 撤销/重做覆盖三类编辑 + 上限 ---------------- */
section('撤销/重做');
{
  const p = proj();
  M.addLayer(p);                 // 图层
  M.upsertKey && null;
  M.toggleKey(p,0,1,'x',0.5);    // 关键帧
  M.beginStroke(p); M.strokePixel(p,0,0,'#ffffff'); M.endStroke(p); // 像素（补间数据载体）
  M.setFrameDuration(p,0,777);   // 时间线
  eq(histLen(p), 4, '四类编辑各一条历史');
  eq(p.frames[0].duration, 777, '当前时长 777');
  M.undo(p);
  eq(p.frames[0].duration, 250, '撤销帧时长');
  M.undo(p);
  ok(p.frames[0].layers[1].pixels[0] === null, '撤销像素');
  M.undo(p);
  ok(!M.findKey(p.frames[0].layers[1],'x',0.5), '撤销关键帧');
  M.undo(p);
  eq(p.frames[0].layers.length, 1, '撤销图层');
  eq(histLen(p), 0, '历史已空');
  // 重做
  M.redo(p);
  eq(p.frames[0].layers.length, 2, '重做图层');
  M.redo(p); M.redo(p); M.redo(p);
  eq(p.frames[0].duration, 777, '连重做 3 步到 777');
  ok(p.frames[0].layers[1].pixels[0] === '#ffffff', '重做恢复像素');
  // 新操作清空 future
  M.undo(p);
  M.addLayer(p);
  ok(M.redo(p) === null, '新操作后重做栈清空');

  // 历史上限
  const p2 = proj();
  for(let i=0;i<M.HISTORY_LIMIT+30;i++){
    M.setFrameDuration(p2, 0, 250 + (i%50)*10 + 20); // 保证与上一次不同
  }
  ok(p2._past.length <= M.HISTORY_LIMIT, '历史不超过上限 80');
  ok(p2._past.length === M.HISTORY_LIMIT, '历史达到上限即 80');
}

/* ---------------- 8. 持久化：往返/损坏/旧版迁移/清洗 ---------------- */
section('持久化与迁移');
{
  const p = proj();
  M.addLayer(p);
  M.setBlend(p,1,'multiply');
  M.toggleVisible(p,0);
  M.setFrameDuration(p,0,400);
  M.addFrame(p); M.setFrameDuration(p,1,600);
  M.upsertKey(p.frames[0].layers[1],'x',0,0);
  M.upsertKey(p.frames[0].layers[1],'x',1,80).ease='easeOut';
  p.frames[0].layers[0].pixels[10] = '#dead00';
  M.setLoop(p,false);
  const str = M.serialize(p);
  const r = M.deserialize(str);
  ok(r, '往返解析成功');
  eq(r.frames.length, 2, '往返帧数');
  eq(r.frames[0].layers[1].blend, 'multiply', '往返混合模式');
  eq(r.frames[0].layers[0].visible, false, '往返显隐');
  eq(r.frames[0].layers[0].pixels[10], '#dead00', '往返像素');
  eq(r.frames.map(f=>f.duration), [400,600], '往返时长');
  eq(r.loop, false, '往返循环开关');
  eq(M.evalLayerAt(r.frames[0].layers[1],0.5).x, 60, '往返后补间仍可计算(easeOut 中点 60)');
  const xs = r.frames[0].layers[1].keys.filter(k=>k.ch==='x');
  eq(xs[1].ease, 'easeOut', '往返缓动');

  // 损坏数据
  ok(M.deserialize('{bad json') === null, '损坏 JSON → null');
  ok(M.deserialize(JSON.stringify({hello:'world'})) === null, '无帧对象 → null');
  ok(M.deserialize(JSON.stringify({version:2, frames:[]})) === null, 'v2 空帧 → null');

  // 旧版 v1 迁移
  const v1 = {fps:4, frames:[Array(256).fill('').map((_,i)=> i===5 ? '#010203' : '')]};
  const m1 = M.deserialize(JSON.stringify(v1));
  ok(m1, 'v1 迁移成功');
  eq(m1.frames.length, 1, 'v1 帧数');
  eq(m1.frames[0].layers.length, 1, 'v1 单图层');
  eq(m1.frames[0].layers[0].pixels[5], '#010203', 'v1 像素迁移');
  approx(m1.frames[0].duration, 250, 1e-9, 'v1 按 fps 推导时长 250ms');

  // 脏数据清洗
  const dirty = {version:2, fps:999, loop:'x', frames:[
    {duration:-5, name:'', layers:[
      {pixels:['notcolor', 7, '#abcdef', null].concat(Array(252).fill(null)),
       opacity:3, blend:'evil', locked:'yes',
       keys:[{ch:'x',t:2,v:9999},{ch:'nope',t:0,v:1},{ch:'op',t:0.5,v:0.5},{oops:1}]},
      null
    ]},
    null
  ]};
  const dc = M.deserialize(JSON.stringify(dirty));
  ok(dc, '脏数据可恢复');
  eq(dc.fps <= 60 && dc.fps >= 1, true, 'fps 被夹');
  eq(dc.loop, true, "loop 非 false 一律 true");
  eq(dc.frames[0].duration, M.DUR_MIN, '负时长夹到最小');
  eq(dc.frames[0].layers[0].pixels[0], null, '非法颜色丢弃');
  eq(dc.frames[0].layers[0].pixels[2], '#abcdef', '合法颜色保留');
  eq(dc.frames[0].layers[0].opacity, 1, '非法透明度→1');
  eq(dc.frames[0].layers[0].blend, 'source-over', '非法混合→正常');
  eq(dc.frames[0].layers[0].locked, true, "locked 真值");
  const ks = dc.frames[0].layers[0].keys;
  eq(ks.length, 2, '非法通道/越界时刻关键帧被剔除');
  ok(ks.every(k=>k.t>=0&&k.t<=1), '时刻在 0..1');
  eq(dc.frames[0].name, '帧 1', '空名自动命名');
  eq(dc.frames.length, 1, 'null 帧被剔除');
  eq(dc.frames[0].layers.length, 1, 'null 图层被剔除');

  // 持久化不含运行时态
  ok(!JSON.parse(str)._past && !JSON.parse(str)._future, '存档不含历史栈');
}

/* ---------------- 9. PNG / APNG 编码 ---------------- */
section('PNG / APNG 二进制');
function parseChunks(buf){
  const u = new Uint8Array(buf);
  const chunks = [];
  let o = 8;
  while(o < u.length){
    const len = (u[o]<<24|u[o+1]<<16|u[o+2]<<8|u[o+3])>>>0;
    const type = String.fromCharCode(u[o+4],u[o+5],u[o+6],u[o+7]);
    const data = u.subarray(o+8, o+8+len);
    const crcGot = (u[o+8+len]<<24|u[o+8+len+1]<<16|u[o+8+len+2]<<8|u[o+8+len+3])>>>0;
    const body = u.subarray(o+4, o+8+len);
    const crcExp = M.crc32(body);
    chunks.push({type, data, crcOk: crcGot === crcExp});
    o += 12 + len;
  }
  return chunks;
}
{
  const w=4,h=3,rgba=new Uint8Array(w*h*4);
  for(let i=0;i<w*h;i++){ rgba[i*4]=i*20; rgba[i*4+1]=100; rgba[i*4+2]=200; rgba[i*4+3]=255; }
  const png = Buffer.from(M.encodePNG(w,h,rgba));
  ok(png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'PNG 签名');
  const ch = parseChunks(png);
  eq(ch.map(c=>c.type), ['IHDR','IDAT','IEND'], 'PNG 块序列');
  ok(ch.every(c=>c.crcOk), 'PNG 全部 CRC 正确');
  const ihdr = ch[0].data;
  eq((ihdr[0]<<24|ihdr[1]<<16|ihdr[2]<<8|ihdr[3])>>>0, w, 'IHDR 宽');
  eq((ihdr[4]<<24|ihdr[5]<<16|ihdr[6]<<8|ihdr[7])>>>0, h, 'IHDR 高');
  eq([ihdr[8],ihdr[9]], [8,6], '8-bit RGBA');
  const raw = zlib.inflateSync(Buffer.from(ch[1].data));
  eq(raw.length, h*(w*4+1), '解压后扫描线长度');
  for(let y=0;y<h;y++){
    eq(raw[y*(w*4+1)], 0, '扫描线 filter=0');
    ok(raw.subarray(y*(w*4+1)+1, y*(w*4+1)+1+w*4).equals(Buffer.from(rgba.subarray(y*w*4,(y+1)*w*4))), '像素往返一致 行'+y);
  }

  // APNG：3 帧不同画面
  const W=2,H=2, frames=[];
  const cols=[[255,0,0,255],[0,255,0,255],[0,0,255,255]];
  for(let f=0;f<3;f++){
    const px = new Uint8Array(W*H*4);
    for(let i=0;i<W*H;i++) px.set(cols[f], i*4);
    frames.push({rgba:px, delayMs:100});
  }
  const ap = Buffer.from(M.encodeAPNG(W,H,frames,0));
  ok(ap.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'APNG 签名');
  const ac = parseChunks(ap);
  const types = ac.map(c=>c.type);
  eq(types, ['IHDR','acTL','fcTL','IDAT','fcTL','fdAT','fcTL','fdAT','IEND'], 'APNG 块序列/序号');
  ok(ac.every(c=>c.crcOk), 'APNG 全部 CRC 正确');
  // acTL: num_frames=3, num_plays=0（无限循环）
  eq((ac[1].data[0]<<24|ac[1].data[1]<<16|ac[1].data[2]<<8|ac[1].data[3])>>>0, 3, 'acTL 帧数=3');
  eq((ac[1].data[4]<<24|ac[1].data[5]<<16|ac[1].data[6]<<8|ac[1].data[7])>>>0, 0, 'acTL 无限循环');
  // 序号链：fcTL 0, fcTL 1, fdAT 2, fcTL 3, fdAT 4（序列数字段位于各块 data 前 4 字节）
  const seq = i => (ac[i].data[0]<<24|ac[i].data[1]<<16|ac[i].data[2]<<8|ac[i].data[3])>>>0;
  eq([seq(2),seq(4),seq(5),seq(6),seq(7)], [0,1,2,3,4], 'fcTL/fdAT 序号连续');
  // fcTL 布局：4 seq + 4 w + 4 h + 4 x + 4 y + 2 delay_num + 2 delay_den + 1 + 1
  const fc0 = ac[2].data;
  eq((fc0[20]<<8|fc0[21]), 100, 'delay_num=100ms');
  eq((fc0[22]<<8|fc0[23]), 1000, 'delay_den=1000');
  eq(fc0[24], 0, 'dispose=0'); eq(fc0[25], 0, 'blend=0');  // 解码三帧画面
  const z0 = zlib.inflateSync(Buffer.from(ac[3].data));
  const z1 = zlib.inflateSync(Buffer.from(ac[5].data.subarray(4))); // fdAT 去 4 字节序号
  const z2 = zlib.inflateSync(Buffer.from(ac[7].data.subarray(4)));
  [z0,z1,z2].forEach((z,i)=>{
    eq(z.length, H*(W*4+1), '帧'+i+' 扫描线长度');
    eq([z[1],z[2],z[3]], [cols[i][0],cols[i][1],cols[i][2]], '帧'+i+' 像素颜色正确');
  });

  // 大尺寸 stored deflate 分块（>65535 走多块）
  const big = new Uint8Array(300*300*4).fill(128);
  const bp = Buffer.from(M.encodePNG(300,300,big));
  const bc = parseChunks(bp);
  const inflated = zlib.inflateSync(Buffer.from(bc[1].data));
  eq(inflated.length, 300*(300*4+1), '大图多块 deflate 可解压');
  ok(bc.every(c=>c.crcOk), '大图 CRC 正确');

  // adler32 与 zlib 头
  const zz = M.zlibStore(new Uint8Array([1,2,3,4]));
  eq([zz[0],zz[1]], [0x78,0x01], 'zlib 头 78 01');
  const inf = zlib.inflateSync(Buffer.from(zz));
  ok(inf.equals(Buffer.from([1,2,3,4])), 'zlib stored 往返');
}

/* ---------------- 10. 极端规模与边界 ---------------- */
section('极端操作');
{
  const p = proj();
  for(let i=0;i<300;i++) M.addFrame(p);
  eq(p.frames.length, 301, '300+ 帧建立');
  const t0 = Date.now();
  const str = M.serialize(p);
  const back = M.deserialize(str);
  ok(Date.now()-t0 < 1000, '301 帧序列化往返 <1s');
  eq(back.frames.length, 301, '大规模往返帧数');
  const t1 = Date.now();
  for(let i=0;i<1000;i++) M.sampleAt(p, i*37 % (M.totalDuration(p)+1));
  ok(Date.now()-t1 < 200, '1000 次采样 <200ms');

  // 同一图层打满关键帧
  const l = p.frames[0].layers[0];
  for(let i=0;i<=24;i++) M.upsertKey(l,'x',i/24, i*10);
  eq(l.keys.filter(k=>k.ch==='x').length, 25, '25 个量化刻点');
  // 再往同一刻点写不膨胀
  M.upsertKey(l,'x',0.5, 200);
  eq(l.keys.filter(k=>k.ch==='x').length, 25, '同刻点不膨胀');
  approx(M.evalLayerAt(l,0.5).x, 200, 1e-9, '密集关键帧求值正确');

  // 缩放为 0 不产生 NaN
  M.upsertKey(l,'scale',0.5,0);
  const ev = M.evalLayerAt(l,0.5);
  ok(ev.scale===0 && isFinite(ev.x+ev.y+ev.rot+ev.op), 'scale=0 求值有限');

  // 删除图层后关键帧随之消失并可撤销恢复
  const p2 = proj();
  M.addLayer(p2);
  M.upsertKey(p2.frames[0].layers[1],'rot',0.5,45);
  M.deleteLayer(p2,1);
  ok(p2.frames[0].layers.length===1, '删除图层');
  M.undo(p2);
  eq(p2.frames[0].layers.length, 2, '撤销恢复图层');
  approx(M.evalLayerAt(p2.frames[0].layers[1],0.5).rot, 45, 1e-9, '撤销恢复关键帧数据');

  // 全隐藏/全透明图层补间仍可求值（渲染由 UI 跳过）
  M.toggleVisible(p2,1);
  M.setLayerOpacity(p2,1,0);
  approx(M.evalLayerAt(p2.frames[0].layers[1],0.5).rot, 45, 1e-9, '隐藏零透明不影响模型求值');

  // 旋转边界（用干净项目，避免与前面的关键帧叠加）
  const pR = proj();
  M.upsertKey(pR.frames[0].layers[0],'rot',0,720);
  M.upsertKey(pR.frames[0].layers[0],'rot',1,-720);
  const midR = M.evalLayerAt(pR.frames[0].layers[0],0.5).rot;
  eq(midR, 0, '旋转 ±720 补间过零');

  // 对已销毁选择做操作不崩溃（clampSel 兜底）
  const p3 = proj();
  M.addFrame(p3); M.addFrame(p3);
  p3.sel = {frame:99, layer:99};
  M.clampSel(p3);
  ok(p3.sel.frame===2 && p3.sel.layer===0, '越界选择被夹回');
  M.addLayer(p3); // 不应抛错
  ok(true, '夹回后继续操作不崩溃');
}

console.log(`\n${fail ? '❌' : '✅'} 通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
