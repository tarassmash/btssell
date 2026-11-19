// Индикаторы и анализ — та же логика, что в public/index.html

const ema=(a,n)=>{const k=2/(n+1);let e=a[0];return a.map(x=>e=x*k+e*(1-k));};
function rsi(c,n=14){let g=0,l=0;for(let i=1;i<=n;i++){const d=c[i]-c[i-1];d>0?g+=d:l-=d;}g/=n;l/=n;const out=Array(n).fill(null);out.push(100-100/(1+g/(l||1e-9)));
  for(let i=n+1;i<c.length;i++){const d=c[i]-c[i-1];g=(g*(n-1)+Math.max(d,0))/n;l=(l*(n-1)+Math.max(-d,0))/n;out.push(100-100/(1+g/(l||1e-9)));}return out;}
function atr(k,n=14){const tr=k.map((x,i)=>i?Math.max(x.h-x.l,Math.abs(x.h-k[i-1].c),Math.abs(x.l-k[i-1].c)):x.h-x.l);return ema(tr,n);}
function slope(y){const n=y.length,mx=(n-1)/2,my=y.reduce((a,b)=>a+b,0)/n;let num=0,den=0;y.forEach((v,i)=>{num+=(i-mx)*(v-my);den+=(i-mx)**2;});return num/den;}
function corr(a,b){const n=a.length,ma=a.reduce((x,y)=>x+y)/n,mb=b.reduce((x,y)=>x+y)/n;let s=0,sa=0,sb=0;for(let i=0;i<n;i++){s+=(a[i]-ma)*(b[i]-mb);sa+=(a[i]-ma)**2;sb+=(b[i]-mb)**2;}return s/Math.sqrt(sa*sb||1e-12);}
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));

/* ---------- analysis ---------- */
function align(k,btc){const m=new Map(btc.map(x=>[x.t,x]));return k.filter(x=>m.has(x.t)).map(x=>[x,m.get(x.t)]);}
function analyze(t,k,btc,W){
  const pr=align(k,btc);if(pr.length<W+20)return null;
  const ck=pr.map(p=>p[0]),bk=pr.map(p=>p[1]);
  const c=ck.map(x=>x.c),b=bk.map(x=>x.c),N=c.length,s=N-W;
  const rc=[],rb=[];for(let i=s;i<N;i++){rc.push(Math.log(c[i]/c[i-1]));rb.push(Math.log(b[i]/b[i-1]));}
  const ret=(c[N-1]/c[s-1]-1)*100,bret=(b[N-1]/b[s-1]-1)*100;
  let su=0,sbu=0,nu=0;rc.forEach((r,i)=>{if(rb[i]>0){su+=r;sbu+=rb[i];nu++;}});
  const upCap=nu&&sbu>0?su/sbu:0;
  const rs=c.map((x,i)=>x/b[i]);const lrs=rs.slice(s).map(Math.log);
  const rsSlope=slope(lrs)*W*100;
  const cr=corr(rc,rb);
  const e20=ema(c,20),e50=ema(c,50),R=rsi(c),A=atr(ck);
  const last=c[N-1],a=A[N-1],r=R[N-1];
  // RS: обновляет ли линия монета/BTC минимумы
  const rsNow=rs[N-1],rsMinPrev=Math.min(...rs.slice(s,N-3));
  const rsLL=rsNow<=rsMinPrev*1.002;
  const belowE=last<e50[N-1]&&e20[N-1]<e50[N-1];
  // score
  let score=0;
  score+=clamp((1-upCap)/2,0,1)*30;             // up-capture: 1 → 0, -1 → 30
  score+=clamp(-rsSlope/10,0,1)*25;             // RS падает на 10%+ за окно → 25
  score+=clamp(-(ret-bret)/10,0,1)*15;          // отставание от BTC
  score+=belowE?15:(last<e20[N-1]?7:0);
  score+=rsLL?10:0;
  score+=t.funding>0?clamp(t.funding/0.03,0,1)*5:0;
  // уровни
  const swingH=Math.max(...ck.slice(N-12).map(x=>x.h));
  const swingL=Math.min(...ck.slice(N-W).map(x=>x.l));
  const res=Math.max(e20[N-1],last);           // зона входа: откат к EMA20
  const entryHi=Math.min(Math.max(e20[N-1],last)+0.3*a,swingH);
  const entry=res;
  const stop=Math.max(swingH,entry+0.8*a)+0.3*a;
  const risk=stop-entry;
  const tp1=entry-1.5*risk,tp2=Math.min(entry-2.5*risk,swingL);
  const dist=(last-e20[N-1])/a; // в ATR
  let status,stxt;
  if(score<45||bret<=0&&false){status=0;stxt='нет';}
  if(score>=45){
    if(dist>-0.6&&dist<0.8&&r>40&&r<62){status=2;stxt='вход';}
    else if(r<32||dist<=-0.6){status=1;stxt='ждать отскок';}
    else{status=1;stxt='ждать';}
  }else{status=0;stxt='слабый сигнал';}
  return {symbol:t.symbol,last,ret,bret,rel:ret-bret,upCap,rsSlope,corr:cr,rsi:r,funding:t.funding,vol:t.vol,score:Math.round(score),status,stxt,
    lv:{entry,entryHi,stop,tp1,tp2,risk,swingH,swingL,atr:a,dist,rsLL,belowE},ser:{ck,b,e20,e50,rs}};
}


module.exports={ema,rsi,atr,slope,corr,clamp,align,analyze};
