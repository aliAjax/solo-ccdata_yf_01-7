#!/usr/bin/env node
/* 端到端：按 UI composeFrame 的同一套数学在离屏缓冲上光栅化两帧动画，
   走 exportSamples + encodeAPNG，再解压每一帧校验像素位置随补间移动。 */
const fs=require('fs'),path=require('path'),vm=require('vm'),zlib=require('zlib');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const m=html.match(/\/\*MODEL\*\/([\s\S]*?)\/\*MODEL\*\//);
const sb={console};sb.globalThis=sb;vm.createContext(sb);vm.runInContext(m[1],sb);
const M=sb.PL;
let pass=0,fail=0;
function ok(c,m){if(c)pass++;else{fail++;console.error('  ✗ '+m);}}

// 与 UI composeFrame 等价的逆映射最近邻光栅化（输出 RGBA），深色背景 + source-over
function rasterize(frame, localT){
  const S=M.SIZE,N=M.N,cell=S/N;
  const buf=new Uint8Array(S*S*4);
  for(let i=0;i<buf.length;i+=4){buf[i]=0x20;buf[i+1]=0x24;buf[i+2]=0x33;buf[i+3]=255;}
  const over=(i,r,g,b,a)=>{
    const A=a/255;
    buf[i]  =Math.round(r*A+buf[i]*(1-A));
    buf[i+1]=Math.round(g*A+buf[i+1]*(1-A));
    buf[i+2]=Math.round(b*A+buf[i+2]*(1-A));
  };
  for(const layer of frame.layers){
    if(!layer.visible)continue;
    const ch=M.evalLayerAt(layer,localT), eff=layer.opacity*ch.op;
    if(eff<=0.001)continue;
    const rad=ch.rot*Math.PI/180, sc=ch.scale||1e-9;
    const cos=Math.cos(rad)/sc, sin=Math.sin(rad)/sc;
    const cx=S/2+ch.x, cy=S/2+ch.y;
    for(let py=0;py<S;py++)for(let px=0;px<S;px++){
      const dx=px+0.5-cx, dy=py+0.5-cy;
      // 逆变换回未旋转/未缩放的舞台坐标
      const ux= dx*cos+dy*sin;
      const uy=-dx*sin+dy*cos;
      const gx=Math.floor((ux+S/2)/cell), gy=Math.floor((uy+S/2)/cell);
      if(gx<0||gy<0||gx>=N||gy>=N)continue;
      const c=layer.pixels[gy*N+gx]; if(!c)continue;
      const r=parseInt(c.slice(1,3),16),g=parseInt(c.slice(3,5),16),b=parseInt(c.slice(5,7),16);
      over((py*S+px)*4,r,g,b,Math.round(255*eff));
    }
  }
  return buf;
}

const p=M.attachHistory(M.newProject());
const layer=p.frames[0].layers[0];
// 一个红色像素在中心附近，x: 0→100 补间；缩放 1→2
layer.pixels[7*16+7]='#ff0000';
M.upsertKey(layer,'x',0,0); M.upsertKey(layer,'x',1,100);
M.upsertKey(layer,'scale',0,1); M.upsertKey(layer,'scale',1,2);
M.setFrameDuration(p,0,1000);

const plan=M.exportSamples(p,4); // 0,250,500,750ms
ok(plan.frames.length===4,'4 个采样帧');
const out=plan.frames.map(s=>({rgba:rasterize(p.frames[s.frameIndex],s.localT),delayMs:250}));
const bytes=M.encodeAPNG(M.SIZE,M.SIZE,out,0);
fs.writeFileSync('/tmp/e2e.png',Buffer.from(bytes));

// 用 zlib 解出每帧，检查红点中心是否随时间右移
function chunks(buf){const u=new Uint8Array(buf);const cs=[];let o=8;
 while(o<u.length){const len=(u[o]<<24|u[o+1]<<16|u[o+2]<<8|u[o+3])>>>0;
  const type=String.fromCharCode(...u.subarray(o+4,o+8));
  cs.push({type,data:u.subarray(o+8,o+8+len)});o+=12+len;}return cs;}
const cs=chunks(bytes);
function redCentroid(zdata){
  const raw=zlib.inflateSync(Buffer.from(zdata));
  const S=M.SIZE,stride=S*4+1;let sx=0,sy=0,n=0;
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){
    const o=y*stride+1+x*4;
    if(raw[o]>200&&raw[o+1]<100&&raw[o+2]<100){sx+=x;sy+=y;n++;}
  }
  return n?{cx:sx/n,cy:sy/n,n}:null;
}
const idat=cs.find(c=>c.type==='IDAT').data;
const fdats=cs.filter(c=>c.type==='fdAT').map(c=>c.data.subarray(4));
const zall=[idat,...fdats];
ok(zall.length===4,'解出 4 个 zlib 帧');
const centroids=zall.map(redCentroid);
ok(centroids.every(Boolean),'每帧都找到红色像素群');
centroids.forEach((c,i)=>console.log('   帧',i,'红块中心 x=',c.cx.toFixed(1),'数量=',c.n));
ok(centroids[0].cx < centroids[1].cx && centroids[1].cx < centroids[2].cx && centroids[2].cx < centroids[3].cx,
   '红点随补间逐帧右移');
// 4 个采样对应 t=0/.25/.5/.75，x 补间位移 0→75px（叠加缩放对块中心的取整）
ok(centroids[3].cx-centroids[0].cx > 60,
   '补间位移与 t=.75 相符（实际 '+(centroids[3].cx-centroids[0].cx).toFixed(1)+'，预期 ~67-75）');
ok(centroids[2].cx-centroids[0].cx > 40 && centroids[2].cx-centroids[0].cx < 55,
   '中点位移 ~45（实际 '+(centroids[2].cx-centroids[0].cx).toFixed(1)+'）');
ok(centroids[3].n > centroids[0].n,'缩放增大使红色像素变多（'+centroids[0].n+' → '+centroids[3].n+'）');
// y 方向应基本不动（中心约 150-160 区间）
ok(centroids.every(c=>Math.abs(c.cy-centroids[0].cy)<20),'y 方向无漂移');

// 验证导出文件可被标准 APNG 感知的容器读取：尺寸头
const ihdr=cs.find(c=>c.type==='IHDR').data;
ok((ihdr[0]<<24|ihdr[1]<<16|ihdr[2]<<8|ihdr[3])===M.SIZE &&
   (ihdr[4]<<24|ihdr[5]<<16|ihdr[6]<<8|ihdr[7])===M.SIZE,'APNG 尺寸头 320×320');

// 极端：全透明图层 + 零缩放不崩溃、不出 NaN
const p2=M.attachHistory(M.newProject());
M.setLayerOpacity(p2,0,0);
M.upsertKey(p2.frames[0].layers[0],'scale',0,0);
const r2=rasterize(p2.frames[0],0.5);
ok(r2.length===M.SIZE*M.SIZE*4 && r2.every(v=>isFinite(v)),'零透明零缩放输出有限值');

// 精灵表 JSON 计划完整性
const sheet=M.exportSamples(p,12);
ok(sheet.frames.every(f=>f.frameIndex===0 && isFinite(f.localT)),'精灵表采样全部落在有效帧');
const pack=M.packRect(sheet.frames.length);
ok(pack.cols*pack.rows>=sheet.frames.length,'打包矩形装得下全部帧');

console.log(`\n${fail?'❌':'✅'} 端到端渲染/导出：通过 ${pass} 项，失败 ${fail} 项（样例文件 /tmp/e2e.png, ${bytes.length} 字节）`);
process.exit(fail?1:0);
