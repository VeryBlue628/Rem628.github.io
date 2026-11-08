window.MB_VER = "20261108a";

/* ---------- 全局错误显示（诊断用）：任何脚本错误都显示在页面顶部 ---------- */
function showFatal(m) {
  try {
    let el = document.getElementById("fatal-err");
    if (!el) {
      el = document.createElement("div");
      el.id = "fatal-err";
      el.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;background:#ffe5e0;color:#8f1f11;font-size:12px;padding:10px 14px;white-space:pre-wrap;word-break:break-all;font-family:monospace";
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent += m + "\n";
  } catch (e) {}
}
window.addEventListener("error", (e) => showFatal("脚本错误: " + e.message + " @" + String(e.filename || "").split("/").pop() + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => showFatal("异步错误: " + ((e.reason && e.reason.message) || e.reason)));
/* =========================================================
   大学数学题库 · 在线版
   存储层：云数据库（跨设备同步）+ localStorage（本地缓存/离线兜底）
   ========================================================= */

/* ---------- 云配置（来自 publicConfig，可安全置于前端） ---------- */
/* ---------- Supabase 配置（免费层自建后端） ----------
   使用前填入你自己的 Supabase 项目信息（Settings → API）：
   url     → Project URL（如 https://xxxx.supabase.co）
   anonKey → anon public key
   email/password → Authentication → Users 里创建的单人账号 */
const SUPA_CFG = {
  "url": "https://pgpaegrihdhynevpyfes.supabase.co",
  "anonKey": "sb_publishable_pD0k8jn6vDbZK4DYEaFesA_Qi5jwEdD"
};
/* Local-first progress, persistent sign-in and conflict-aware synchronization. */
let supa = null;
const LOCAL_UID = '2109519881526317056';
let CLOUD_DOWN = false;
let rec = {}, fav = [], exams = [], exDel = {}, recDel = {}, favOps = {};
let learningData=LearningCore.clean();
let _seedRestored=false;
let _ukey = '', _favLocalT = 0, _cloudExams = [], _syncT = null;
let _syncPromise = null, _syncAgain = false, _storageFailed = false;
let _toastT;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id='toast'; el.className='toast'; document.body.appendChild(el); }
  el.textContent=msg; el.classList.add('show'); clearTimeout(_toastT);
  _toastT=setTimeout(()=>el.classList.remove('show'),3500);
}
function setSyncLabel(text) {
  const el=document.getElementById('syncstate');
  const label=_storageFailed ? '本机保存失败，请立即导出备份' : text;
  if(el) el.textContent=label;
  window.dispatchEvent(new CustomEvent('mathbank-sync',{detail:label}));
}
function _read(k,d) { try { const v=JSON.parse(localStorage.getItem(k)); return v==null?d:v; } catch(e) { return d; } }
function userKey(s) { const u=s?.user||{}; return String(u.id||u.sub||u.email||u.phone||'anon').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,64); }
function localSession() {
  const last=_read('mb_last_user',null);
  if(last?.id) return {user:last,local:true};
  // Keep an existing Supabase sign-in after upgrading the website.
  const token=_read('sb-'+new URL(SUPA_CFG.url).hostname.split('.')[0]+'-auth-token',null);
  if(token?.user?.id) return {user:{id:token.user.id,email:token.user.email},local:true};
  return {user:{id:LOCAL_UID},local:true};
}
function initCloud() {
  if(supa) return supa;
  if(!window.supabase) throw Error('登录组件暂不可用，仍可使用本地题库');
  supa=window.supabase.createClient(SUPA_CFG.url,SUPA_CFG.anonKey,{
    auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false},
    global:{fetch:(input,init={})=>{
      const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),10000);
      const abort=()=>ctl.abort();
      if(init.signal?.aborted) ctl.abort(); else init.signal?.addEventListener('abort',abort,{once:true});
      return fetch(input,{...init,signal:ctl.signal}).finally(()=>{clearTimeout(timer);init.signal?.removeEventListener('abort',abort);});
    }}});
  return supa;
}
async function getSession() {
  try {
    if(navigator.onLine===false) throw Error('offline');
    const {data,error}=await initCloud().auth.getSession();
    if(error) throw error;
    if(data?.session?.user) {
      const user={id:data.session.user.id,email:data.session.user.email};
      localStorage.setItem('mb_last_user',JSON.stringify(user));
      CLOUD_DOWN=false; return {user};
    }
  } catch(e) { /* Retain the same local account when token refresh cannot reach the server. */ }
  CLOUD_DOWN=true; return localSession();
}
async function requireLogin() { return localSession(); }
function validObject(v) { return !!v && typeof v==='object' && !Array.isArray(v); }
function safeId(k) { return typeof k==='string' && k.length>0 && k.length<=160 && !['__proto__','constructor','prototype'].includes(k) && /^[A-Za-z0-9_-]+$/.test(k); }
function mapValues(v,check) {
  const out={}; if(!validObject(v)) return out;
  for(const [k,x] of Object.entries(v)) if(safeId(k)&&check(x)) out[k]=x;
  return out;
}
function stamp(v) { return Number.isFinite(v)&&v>=0; }
function validExam(e) {
  return validObject(e)&&safeId(e.id)&&stamp(e.ts)&&['GS','XD','GL','CY'].includes(e.tk||'GS')
    &&Array.isArray(e.qids)&&e.qids.every(safeId)&&validObject(e.ans)
    &&Object.entries(e.ans).every(([k,v])=>safeId(k)&&typeof v==='string')
    &&stamp(e.score||0)&&stamp(e.total||0)&&stamp(e.right||0)&&stamp(e.pending||0)
    &&(e.updatedAt===undefined||stamp(e.updatedAt));
}
function cleanState(p={}) {
  return {
    rec:mapValues(p.rec,v=>typeof v==='string'||(validObject(v)&&typeof v.a==='string'&&stamp(v.t||0))),
    fav:Array.isArray(p.fav)?[...new Set(p.fav.filter(safeId))]:[],
    exams:Array.isArray(p.exams)?p.exams.filter(validExam):[],
    exdel:mapValues(p.exdel,stamp),recdel:mapValues(p.recdel,stamp),
    favOps:mapValues(p.favOps,v=>validObject(v)&&typeof v.on==='boolean'&&stamp(v.t)),
    favT:stamp(p.favT)?p.favT:(stamp(p.ts)?p.ts:0),ts:stamp(p.ts)?p.ts:0,
    schema:4,...LearningCore.clean(p),
    seedRestored:p.seedRestored===true
  };
}
function snapshot() { return {rec,fav,exams,exdel:exDel,recdel:recDel,favOps,favT:_favLocalT,seedRestored:_seedRestored||_read('mb_seed:'+_ukey,false),ts:Date.now(),schema:4,...learningData}; }
function assignState(p) {
  learningData=LearningCore.clean(p);_seedRestored=p.seedRestored===true;rec=p.rec;fav=p.fav;exams=p.exams;exDel=p.exdel;recDel=p.recdel;favOps=p.favOps;_favLocalT=p.favT;
}
function loadForUser(s) {
  const k=userKey(s); if(k===_ukey) return;
  _ukey=k;_cloudExams=[];
  let p=_read('NEU-STATE:'+k,null);
  if(!p) p={rec:_read('NEU-REC:'+k,{}),fav:_read('NEU-FAV:'+k,[]),exams:_read('NEU-EXAMS:'+k,[]),exdel:_read('NEU-EXDEL:'+k,{}),recdel:_read('NEU-RECDEL:'+k,{}),favT:_read('NEU-FAVT:'+k,0)};
  p=cleanState(p);const oldDraft=_read('NEU-DRAFT:'+k,null);if(oldDraft&&validExam(oldDraft)&&!p.drafts[oldDraft.id])p.drafts[oldDraft.id]=oldDraft;
  assignState(p);
}
function migrateOldLocalData() { /* Legacy account migration is explicit through the import controls. */ }
function saveLocal() {
  if(!_ukey) return false;
  try {
    // One atomic storage entry is authoritative. Legacy keys remain readable by old exports.
    localStorage.setItem('NEU-STATE:'+_ukey,JSON.stringify(snapshot()));
    _storageFailed=false;
  } catch(e) {
    _storageFailed=true;setSyncLabel('');toast('设备存储已满或不可用，本次修改尚未保存。请立即导出备份。');return false;
  }
  try {
    for(const [key,value] of Object.entries({'NEU-REC:':rec,'NEU-FAV:':fav,'NEU-EXAMS:':exams,'NEU-EXDEL:':exDel,'NEU-RECDEL:':recDel,'NEU-FAVT:':_favLocalT})) localStorage.setItem(key+_ukey,JSON.stringify(value));
  } catch(e) { /* Atomic snapshot above succeeded; compatibility mirrors are optional. */ }
  return true;
}
function recAns(id) { const v=rec[id]; return v&&typeof v==='object'?v.a:v; }
function recTime(id) { return recordTime(rec[id]); }
function recordTime(v) { return v&&typeof v==='object'?v.t||0:0; }
function examTime(e) { return e.updatedAt||e.ts||0; }
function isFav(id) { return fav.includes(id); }
function touchFav() {
  const t=Date.now();const current=new Set(fav);
  // Compare with last persisted state so remove operations survive cross-device merges.
  const prior=cleanState(_read('NEU-STATE:'+_ukey,{fav:_read('NEU-FAV:'+_ukey,[])}));
  for(const id of new Set([...prior.fav,...fav])) if(current.has(id)!==prior.fav.includes(id)) favOps[id]={on:current.has(id),t};
  _favLocalT=t;
}
function mergeExams(a,b) {
  const out=new Map();for(const e of [...(a||[]),...(b||[])]) if(validExam(e)&&(!out.has(e.id)||examTime(e)>examTime(out.get(e.id)))) out.set(e.id,e);
  return [...out.values()].sort((x,y)=>y.ts-x.ts);
}
function mergeState(left,right) {
  const a=cleanState(left),b=cleanState(right),out=cleanState(a);
  for(const kind of ['exdel','recdel']) for(const [id,t] of Object.entries(b[kind])) out[kind][id]=Math.max(out[kind][id]||0,t);
  for(const [id,r] of Object.entries(b.rec)) if(!out.rec[id]||recordTime(r)>recordTime(out.rec[id])) out.rec[id]=r;
  for(const id of Object.keys(out.rec)) if(out.recdel[id]!==undefined&&out.recdel[id]>=recordTime(out.rec[id])) delete out.rec[id];
  out.exams=mergeExams(a.exams,b.exams).filter(e=>out.exdel[e.id]===undefined||out.exdel[e.id]<examTime(e));
  const newest=b.favT>a.favT?b:a;out.fav=a.favT===0&&b.favT===0?[...new Set([...a.fav,...b.fav])]:newest.fav.slice();out.favT=Math.max(a.favT,b.favT);
  // Legacy clients use a whole-list clock. New clients track individual add/remove events.
  for(const [id,op] of Object.entries(b.favOps)) {
    const cur=out.favOps[id];
    if(!cur||op.t>cur.t||(op.t===cur.t&&!op.on)) out.favOps[id]=op;
  }
  const set=new Set(out.fav);
  for(const [id,op] of Object.entries(out.favOps)) {
    if(!Object.keys(newest.favOps).length&&newest.favT>op.t) continue;
    if(op.on)set.add(id);else set.delete(id);
  }
  out.fav=[...set];out.seedRestored=a.seedRestored||b.seedRestored;Object.assign(out,LearningCore.merge(a,b));
  return out;
}
function deleteExam(id) { exams=exams.filter(e=>e.id!==id);exDel[id]=Date.now();saveLocal();scheduleSync(); }
async function cloudAccount() {
  const s=await getSession();
  if(s.local) {setSyncLabel('本地已保存 · 云端未连接');return null;}
  if(userKey(s)!==_ukey) {setSyncLabel('账号已变化，请返回首页继续');return null;}
  return s;
}
async function pullState() {
  if(!await cloudAccount())return false;
  const {data,error}=await supa.from('user_state').select('payload,updated_at').eq('owner_id',_ukey).maybeSingle();
  if(error)throw error;
  if(data?.payload) {assignState(mergeState(snapshot(),data.payload));saveLocal();}
  setSyncLabel('已读取云端 · 本地已保存');return true;
}
async function syncOnce() {
  if(!await cloudAccount())return false;
  const key=_ukey;
  for(let attempt=0;attempt<4;attempt++) {
    const {data,error}=await supa.from('user_state').select('payload,updated_at').eq('owner_id',key).maybeSingle();
    if(error)throw error;if(key!==_ukey)return false;
    assignState(mergeState(snapshot(),data?.payload||{}));saveLocal();
    const payload=snapshot(),updated_at=new Date(Math.max(Date.now(),(Date.parse(data?.updated_at)||0)+1)).toISOString();
    let result;
    if(data) {
      let q=supa.from('user_state').update({payload,updated_at}).eq('owner_id',key);
      q=data.updated_at==null?q.is('updated_at',null):q.eq('updated_at',data.updated_at);
      result=await q.select('owner_id');
    } else result=await supa.from('user_state').insert({owner_id:key,payload,updated_at}).select('owner_id');
    if(result.error?.code==='23505')continue;
    if(result.error)throw result.error;
    if(!result.data?.length)continue; // A different device wrote first; re-read and merge.
    setSyncLabel('已同步');return true;
  }
  throw Error('其他设备正在同步，请稍后重试');
}
async function pushState() {
  if(_syncPromise) {_syncAgain=true;return _syncPromise;}
  _syncPromise=(async()=>{
    let ok=false;
    do { _syncAgain=false;ok=await syncOnce(); } while(_syncAgain);
    return ok;
  })().catch(e=>{setSyncLabel('本地已保存 · 云同步失败，联网后重试');return false;}).finally(()=>{_syncPromise=null;});
  return _syncPromise;
}
function scheduleSync() {
  clearTimeout(_syncT);setSyncLabel('本地已保存 · 等待同步');
  _syncT=setTimeout(()=>{_syncT=null;void pushState();},600);
}
function flushSync() {saveLocal();if(_syncT){clearTimeout(_syncT);_syncT=null;void pushState();}}
function syncExams() {scheduleSync();}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')flushSync();else if(_ukey)scheduleSync();});
window.addEventListener('pagehide',flushSync);
window.addEventListener('online',()=>{if(_ukey)scheduleSync();});
window.addEventListener('storage',e=>{
  if(e.key==='NEU-STATE:'+_ukey&&e.newValue){try{assignState(mergeState(snapshot(),JSON.parse(e.newValue)));}catch(_){} }
});
async function manualRefresh(btn) {
  if(btn)btn.disabled=true;
  try {
    const ok=await pushState();
    if(typeof loadFavData==='function')await loadFavData();
    if(typeof renderChapter==='function')renderChapter();
    if(typeof renderFav==='function')renderFav();
    if(typeof renderCourses==='function')renderCourses();
    if(typeof state==='undefined'||!state?.exam)paintAll();else typesetMath(document.body);
    syncFavBtns();applyFilters();toast(ok?'已同步并刷新':'已刷新本地记录，云端暂不可用');
  } finally {if(btn)btn.disabled=false;}
}
async function checkUpdate() {
  try {
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),4000);
    let r;try{r=await fetch('version.json?t='+Date.now(),{cache:'no-store',signal:ctl.signal});}finally{clearTimeout(timer);}
    if(!r.ok)return false;const v=(await r.json()).v;
    if(typeof v==='string'&&/^[0-9]{8}[a-z]$/.test(v)&&v>window.MB_VER&&!document.getElementById('update-notice')) {
      const box=document.createElement('div');box.id='update-notice';box.className='banner info';box.textContent=window.AndroidBackup?'网站有新版本。完成当前练习后，请完全关闭应用并重新打开以更新。':'网站有新版本。完成当前练习后，请关闭此站点的所有标签页，再重新打开以更新。';
      document.body.appendChild(box);
    }
  }catch(e){}return false;
}

/* ---------- 题目渲染 ----------
   高数/线代是图片题，C语言是纯文本题：用 isImg() 判断，二者共用一套 DOM。 */
function esc(s) { return escHtml(s).replace(/"/g, "&quot;"); }
function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function isImg(u) { return /^(img\/|https?:|\.\/)/.test(String(u || "")); }
function bodyHtml(u, alt) {
  return isImg(u)
    ? '<img src="' + esc(u) + '" loading="lazy" alt="' + alt + '" onerror="imgFail(this)">'
    : '<div class="txt">' + escHtml(u) + "</div>";
}
/* 填空判分用的文本归一：去掉空白与中英文标点后比较，避免「对，」「对.」这类误差 */
function normTxt(s) {
  return String(s??'').normalize('NFKC').replace(/[\s\u3000]/g,'').replace(/[。；;，,]+$/g,'').toLowerCase();
}

function qType(q) {
  return q.t === "multi" ? "multi"
    : (q.t === "blank" ? "blank"
      : (q.t === "calc" ? "calc" : "single"));
}
/* LaTeX 公式排版：页面里有公式才去加载 MathJax（约 1MB，按需） */
let _mathLoad=null,_mathQueue=Promise.resolve();
function typesetMath(el) {
  if (!/\\\(|\\\[/.test((el||document.body).textContent||'')) return;
  if(!_mathLoad) _mathLoad=new Promise((resolve,reject)=>{
    if(window.MathJax?.typesetPromise){resolve();return;}
    window.MathJax={tex:{inlineMath:[["\\(","\\)"]],displayMath:[["\\[","\\]"]]},startup:{typeset:false}};
    const script=document.createElement('script');script.src='vendor/mathjax/tex-svg-full.js';
    script.onload=()=>Promise.resolve(window.MathJax.startup.promise).then(resolve,reject);
    script.onerror=()=>{script.remove();delete window.MathJax;reject(Error('公式资源加载失败'));};document.head.appendChild(script);
  });
  _mathQueue=_mathQueue.catch(()=>{}).then(()=>_mathLoad).then(()=>MathJax.typesetPromise([el||document.body])).catch(()=>{_mathLoad=null;toast('公式资源暂不可用，联网后可刷新重试');});
}

function qHTML(q, i, prefix) {
  if (!q) return "";
  const L = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const type = qType(q);
  let workArea = "";
  if (type === "calc") {
    // 解答题（线代填空/计算）：答案无法自动判分，先自己算再看解析，自评
    const stemHtml = String(q.s || "").replace(/⟪BLANK⟫/g, '<span class="blank-slot"></span>');
    workArea = '<div class="stem calc-stem">' + stemHtml + "</div>"
      + '<div class="self-eval"><span class="hint-inline">先自己算，再对照解析：</span>'
      + '<button class="btn" onclick="selfAssess(this,true)">✓ 答对了</button>'
      + '<button class="btn" onclick="selfAssess(this,false)">✗ 没答出来</button></div>';
  } else {
    let opts = "";
    if (type === "blank") {
      opts = '<div class="blank-box">'
        + '<input type="text" class="blank-in" placeholder="输入答案后点「核对」" autocomplete="off">'
        + '<button class="btn" onclick="checkBlank(this)">核对</button></div>';
    } else {
      const inp = type === "multi" ? "checkbox" : "radio";
      for (let k = 1; k <= 8; k++) {
        const v = L[k - 1];
        if (!q.o || !q.o[String(k)]) continue;
        opts += '<label class="opt" data-v="' + v + '">'
          + '<input type="' + inp + '" name="' + prefix + "-" + i + '" value="' + v + '">'
          + '<span class="lbl">' + v + "</span>"
          + bodyHtml(q.o[String(k)], "选项" + v) + "</label>";
      }
      if (type === "multi") {
        opts += '<div class="multi-submit">'
          + '<button class="btn primary" onclick="submitMulti(this)">确认作答</button>'
          + '<span class="hint-inline">多选题，选完再确认</span></div>';
      }
    }
    workArea = '<div class="stem">' + bodyHtml(q.s, "题干") + "</div>"
      + '<div class="opts">' + opts + "</div>";
  }
  let why;
  if (q.eh) why = '<div class="txt why-txt">' + q.eh + "</div>";      // 已排版的解析 HTML
  else if (q.et) why = '<div class="txt why-txt">' + escHtml(q.et) + "</div>";
  else if (q.w) why = bodyHtml(q.w, "答案解析");
  else why = '<span class="hint">（该题无解析）</span>';
  // 文本题把题干也放进搜索索引，这样在本章内搜关键词能搜到题目
  const plainStem = type === "calc" ? String(q.s || "").replace(/<[^>]+>/g, " ") : (q.s && !isImg(q.s) ? q.s : "");
  const searchTxt = ((q.ch || "") + " " + (q.kp || "") + " " + plainStem).toLowerCase();
  let tag = "";
  if (q.tag) tag = '<span class="qtype calc">' + escHtml(q.tag) + "</span>";
  else if (type === "multi") tag = '<span class="qtype multi">多选</span>';
  else if (type === "blank") tag = '<span class="qtype blank">填空</span>';
  // 有些章节的知识点名和章节名相同，这时只显示一个，避免出现「A · A」
  const metaTxt = (q.kp && q.ch && q.kp !== q.ch) ? (q.kp + " · " + q.ch) : (q.kp || q.ch || "");
  return '<div class="q" data-qid="' + q.q + '" data-ans="' + esc(q.a) + '" data-txt="'
    + esc(searchTxt) + '" data-type="' + type + '">'
    + '<div class="qh"><span class="no">第 ' + i + " 题</span>" + tag
    + '<span class="meta">' + esc(metaTxt) + "</span>"
    + '<button class="fav-btn" data-qid="' + q.q + '" onclick="toggleFav(this)" title="收藏">'
    + (isFav(q.q) ? "★" : "☆") + "</button></div>"
    + workArea
    + '<div class="fb"></div>'
    + '<div class="peek"><button onclick="peek(this)">查看答案解析</button></div>'
    + '<div class="why">' + why + "</div></div>";
}

/* ---------- 图片加载诊断 ----------
   服务端已抽查确认图片全部可用；个别设备整页图片空白，
   多半是浏览器开了「无图/省流模式」或被广告拦截插件拦截，给出明确提示。 */
let _imgFailN = 0, _imgWarned = false;
function imgFail(el) {
  // 弱网下偶发加载失败：先自动带时间戳重试一次，再失败才提示
  if (!el.dataset.retry) {
    el.dataset.retry = "1";
    el.src = el.src.split("?")[0] + "?r=" + Date.now();
    return;
  }
  _imgFailN++;
  const ph = document.createElement("div");
  ph.className = "img-missing";
  ph.textContent = "图片加载失败";
  el.replaceWith(ph);
  if (_imgFailN >= 3 && !_imgWarned) { _imgWarned = true; showImgHelp(); }
}
function showImgHelp() {
  if (document.getElementById("imghelp")) return;
  const wrap = document.querySelector(".wrap");
  if (!wrap) return;
  const d = document.createElement("div");
  d.className = "banner err";
  d.id = "imghelp";
  d.innerHTML = '部分图片未能加载，可能是网络中断或资源未缓存。请联网后 <a href="#" onclick="location.reload();return false">重试</a>。';
  wrap.insertBefore(d, wrap.firstChild);
}

/* ---------- 筛选状态 ---------- */
const f = { kp: null, wrong: false, kw: "", fav: false };
function answerCorrect(type,answer,expected) {
  if(type==='calc')return answer==='ok';
  if(type==='blank')return normTxt(answer)===normTxt(expected);
  if(type==='multi')return [...String(answer)].sort().join('')===[...String(expected)].sort().join('');
  return answer===expected;
}
function isWrong(q) {
  const id=q.getAttribute('data-qid');
  return !!rec[id]&&!answerCorrect(q.dataset.type,recAns(id),q.dataset.ans);
}
function visibleQs() {
  return Array.prototype.slice.call(document.querySelectorAll(".q"))
    .filter((q) => q.style.display !== "none");
}
function applyFilters() {
  document.querySelectorAll(".q").forEach((q) => {
    const blk = q.closest(".kp-block");
    const okKp = !f.kp || (blk && blk.getAttribute("data-kp") === f.kp) || (f.kp && !blk);
    const okW = !f.wrong || isWrong(q);
    const okKw = !f.kw || (q.getAttribute("data-txt") || "").indexOf(f.kw) >= 0;
    const okFav = !f.fav || isFav(q.getAttribute("data-qid"));
    q.style.display = okKp && okW && okKw && okFav ? "" : "none";
  });
  document.querySelectorAll(".kp-block").forEach((b) => {
    const any = Array.prototype.some.call(b.querySelectorAll(".q"), (q) => q.style.display !== "none");
    b.style.display = any ? "" : "none";
  });
  const em = document.getElementById("empty");
  if (em) em.style.display = visibleQs().length ? "none" : "block";
  updateGroupStats();
  updateScore();
}
function updateGroupStats() {
  document.querySelectorAll(".gbtn").forEach((b) => {
    const id = b.getAttribute("data-kp");
    if (id === "__all__") return;
    const blk = document.querySelector('.kp-block[data-kp="' + id + '"]');
    if (!blk) return;
    const qs = blk.querySelectorAll(".q");
    let done = 0;
    qs.forEach((q) => { if (rec[q.getAttribute("data-qid")]) done++; });
    const n = b.querySelector(".n");
    if (n) n.textContent = done + "/" + qs.length;
  });
}
function updateScore() {
  const qs = visibleQs();
  let done = 0, ok = 0;
  qs.forEach((q) => {
    const id = q.getAttribute("data-qid");
    if (rec[id]) { done++; if (answerCorrect(q.dataset.type, recAns(id), q.dataset.ans)) ok++; }
  });
  const el = document.getElementById("score");
  if (!el) return;
  const pct = done ? Math.round((ok * 100) / done) : 0;
  el.innerHTML = "已答 <b>" + done + "</b>/" + qs.length + "　正确率 <b>" + pct + "%</b>";
}

/* ---------- 作答 ---------- */
function markResult(q, ok, ans) {
  const fb = q.querySelector(".fb");
  if (fb) {
    fb.className = "fb " + (ok ? "ok" : "no");
    fb.innerHTML = ok ? "✓ 回答正确" : "✗ 回答错误，正确答案：" + escHtml(ans);
  }
  const why = q.querySelector(".why");
  if (why) why.classList.add("show");
}
function optionFor(q,value) {return [...q.querySelectorAll('.opt')].find(el=>el.dataset.v===String(value));}
function paintAnswered(q, v) {
  const ans = q.getAttribute("data-ans") || "";
  const type = q.getAttribute("data-type") || "single";

  if (type === "blank") {
    const inp = q.querySelector(".blank-in");
    if (inp) { inp.value = v; inp.disabled = true; }
    const b = q.querySelector(".blank-box .btn");
    if (b) b.disabled = true;
    q.querySelectorAll(".opt").forEach((o) => o.classList.add("locked"));
    markResult(q, normTxt(v) === normTxt(ans), ans);
    return;
  }

  if (type === "multi") {
    String(v).split("").forEach((c) => {
      const el = optionFor(q,c);
      if (!el) return;
      el.classList.add(ans.indexOf(c) >= 0 ? "right" : "wrong");
      const i = el.querySelector("input");
      if (i) i.checked = true;
    });
    // 漏选的正确项用虚线框标出来，让人知道当时少选了哪个
    String(ans).split("").forEach((c) => {
      if (String(v).indexOf(c) < 0) {
        const el = optionFor(q,c);
        if (el) el.classList.add("right", "missed");
      }
    });
    q.querySelectorAll("input").forEach((i) => { i.disabled = true; });
    q.querySelectorAll(".opt").forEach((o) => o.classList.add("locked"));
    const b = q.querySelector(".multi-submit .btn");
    if (b) b.disabled = true;
    markResult(q, v === ans, ans);
    return;
  }

  if (type === "calc") {
    const ok = v === "ok";
    q.querySelectorAll(".self-eval .btn").forEach((b, idx) => {
      b.disabled = true;
      if ((idx === 0) === ok) b.classList.add(ok ? "self-ok" : "self-no");
    });
    const fb = q.querySelector(".fb");
    if (fb) {
      fb.className = "fb " + (ok ? "ok" : "no");
      fb.textContent = ok ? "✓ 自评：已掌握" : "✗ 自评：还没掌握，看解析再练一遍";
    }
    const why = q.querySelector(".why");
    if (why) why.classList.add("show");
    return;
  }

  const chosen = optionFor(q,v);
  if (chosen) chosen.classList.add(v === ans ? "right" : "wrong");
  if (v !== ans) {
    const right = optionFor(q,ans);
    if (right) right.classList.add("right");
  }
  q.querySelectorAll("input").forEach((i) => { i.disabled = true; });
  q.querySelectorAll(".opt").forEach((o) => o.classList.add("locked"));
  markResult(q, v === ans, ans);
}
/* 多选：勾选完点「确认作答」才判分 */
function submitMulti(btn) {
  const q = btn.closest(".q");
  if (!q) return;
  if (typeof state !== "undefined" && state.exam) { toast("模拟卷将在交卷时统一判分"); return; }
  const picked = [];
  q.querySelectorAll('input[type=checkbox]').forEach((b) => { if (b.checked) picked.push(b.value); });
  if (!picked.length) { toast("至少选一个选项"); return; }
  const val = picked.sort().join("");
  rec[q.getAttribute("data-qid")] = { a: val, t: Date.now() };
  saveLocal();
  paintAnswered(q, val);
  applyFilters();
  scheduleSync();
}
/* 填空：写下答案后点「核对」，按归一化文本判分 */
function checkBlank(btn) {
  const q = btn.closest(".q");
  if (!q) return;
  if (typeof state !== "undefined" && state.exam) { toast("模拟卷将在交卷时统一判分"); return; }
  const inp = q.querySelector(".blank-in");
  const val = inp ? inp.value.trim() : "";
  if (!val) { toast("先写个答案再核对"); return; }
  rec[q.getAttribute("data-qid")] = { a: val, t: Date.now() };
  saveLocal();
  paintAnswered(q, val);
  applyFilters();
  scheduleSync();
}
/* 重新渲染会清掉所有作答标记，所以每次渲染后都要回扫一遍，
   把 rec 里已有记录的题目重新标成「已答」（绿/红 + 锁死选项 + 显示解析）。
   放在 bootPage 里统一做，避免某个页面的 render 函数漏掉这一步。 */
function paintAll() {
  document.querySelectorAll(".q").forEach((q) => {
    const id = q.getAttribute("data-qid");
    if (rec[id]) paintAnswered(q, recAns(id));
  });
  typesetMath(document.body);   // 页面里有 LaTeX 公式（线代填空/计算）时排版
}

/* 解答题自评：数学填空/计算无法自动判分，按「会/不会」记录，照样进进度和错题本 */
function selfAssess(btn, ok) {
  // 模拟练习页：自评结果记入试卷（exam.ans），不写入刷题记录
  if (typeof state !== "undefined" && state && state.exam && typeof examSelf === "function") {
    examSelf(btn, ok);
    return;
  }
  const q = btn.closest(".q");
  if (!q) return;
  rec[q.getAttribute("data-qid")] = { a: ok ? "ok" : "no", t: Date.now() };
  saveLocal();
  paintAnswered(q, ok ? "ok" : "no");
  applyFilters();
  scheduleSync();
}

function toggleFav(btn) {
  const qid = btn.getAttribute("data-qid");
  const i = fav.indexOf(qid);
  if (i >= 0) fav.splice(i, 1); else fav.push(qid);
  touchFav();
  saveLocal();
  syncFavBtns();
  applyFilters();
  scheduleSync();
}
function syncFavBtns() {
  document.querySelectorAll(".fav-btn").forEach((b) => {
    const on = isFav(b.getAttribute("data-qid"));
    b.classList.toggle("on", on);
    b.textContent = on ? "★" : "☆";
    b.title = on ? "取消收藏" : "收藏本题";
    b.setAttribute("aria-label",b.title); b.setAttribute("aria-pressed",String(on));
  });
}
function peek(btn) {
  btn.closest(".q").querySelector(".why").classList.toggle("show");
}
function toggleFavFilter(btn) {
  f.fav = !f.fav;
  btn.classList.toggle("on", f.fav);
  btn.textContent = f.fav ? "显示全部" : "只看收藏";
  applyFilters();
}
function toggleWrong(btn) {
  f.wrong = !f.wrong;
  btn.classList.toggle("on", f.wrong);
  btn.textContent = f.wrong ? "显示全部" : "只看错题";
  applyFilters();
}
let cram = false;
function toggleCram(btn) {
  cram = !cram;
  btn.classList.toggle("on", cram);
  btn.textContent = cram ? "返回答题模式" : "背题模式";
  document.querySelectorAll(".q").forEach((q) => {
    const ans = q.getAttribute("data-ans"), id = q.getAttribute("data-qid");
    if (cram) {
      // 多选答案是 "ABD" 这样的串，要逐项标绿
      if (q.getAttribute("data-type") === "multi") {
        String(ans).split("").forEach((c) => {
          const el = optionFor(q,c);
          if (el) el.classList.add("right");
        });
      } else {
        const right = optionFor(q,ans);
        if (right) right.classList.add("right");
      }
      const fb = q.querySelector(".fb");
      fb.className = "fb ok";
      fb.textContent = q.getAttribute("data-type") === "calc"
        ? "解答题 · 答案解析在下方" : "答案 " + ans;
      q.querySelector(".why").classList.add("show");
      q.querySelectorAll("input,.blank-box button,.multi-submit button,.self-eval button").forEach((i) => { i.disabled = true; });
      q.querySelectorAll(".opt").forEach((o) => o.classList.add("locked"));
    } else {
      q.querySelectorAll(".opt").forEach((o) => o.classList.remove("right", "wrong", "locked"));
      q.querySelectorAll("input,.blank-box button,.multi-submit button,.self-eval button").forEach((i) => { i.disabled = false; });
      const fb = q.querySelector(".fb");
      fb.className = "fb"; fb.innerHTML = "";
      q.querySelector(".why").classList.remove("show");
      if (rec[id]) paintAnswered(q, recAns(id));
    }
  });
  updateScore();
}
async function resetAll() {
  const qs = visibleQs();
  if (!qs.length) { toast("当前没有显示任何题目，无可重置的记录。"); return; }
  if (!confirm("确定清空当前显示的这 " + qs.length + " 道题的作答记录吗？\n\n· 被筛选隐藏的题目不受影响\n· 收藏不会被清除")) return;
  // 删除本地作答并打重置墓碑（pullState 合并时，早于墓碑时间的云端旧作答不再复活）
  qs.forEach((q) => {
    const id = q.getAttribute("data-qid");
    delete rec[id];
    recDel[id] = Date.now();
  });
  saveLocal();
  // 旧版这里 scheduleSync() 之后立刻 reload，600ms 的推送定时器永远没机会执行，
  // 重置结果从未上云 → 刷新后被云端旧记录全部合并回来。现在必须等推送完成再刷新。
  toast("正在重置并同步…");
  try { await pushState(); } catch (e) {}
  location.reload();
}

/* ---------- 定位 ---------- */
function qLabel(q) {
  const no = q ? q.querySelector(".no") : null;
  return no ? no.textContent.trim() : "该题";
}
function scrollToQ(t) {
  const hdr = document.querySelector("header");
  const off = hdr ? hdr.offsetHeight : 0;
  const y = t.getBoundingClientRect().top + window.pageYOffset - off - 14;
  window.scrollTo(0, y < 0 ? 0 : y);
}
function jumpToLatest(quiet) {
  const qs = visibleQs();
  if (!qs.length) return;
  let lastT = -1, lastIdx = -1, answeredIdx = -1, target;
  for (let i = 0; i < qs.length; i++) {
    const id = qs[i].getAttribute("data-qid");
    if (!rec[id]) continue;
    answeredIdx = i;
    const t = recTime(id);
    if (t > 0 && t > lastT) { lastT = t; lastIdx = i; }
  }
  if (lastIdx >= 0) target = qs[lastIdx];
  else if (answeredIdx >= 0) target = qs[answeredIdx];
  else target = qs[0];
  scrollToQ(target);
  if (!quiet) {
    toast(lastIdx < 0 && answeredIdx < 0
      ? "已定位到 " + qLabel(target) + "（还没开始做）"
      : "已定位到 " + qLabel(target) + "（上次做到这里）");
  }
}
function jumpToNo() {
  const el = document.getElementById("jumpno");
  if (!el) return;
  const n = parseInt(el.value, 10);
  if (!n || n < 1) { toast("请输入要跳转的题号"); return; }
  const qs = visibleQs();
  let target = null;
  for (const q of qs) {
    const txt = ((q.querySelector(".no") || {}).textContent || "").replace(/\D/g, "");
    if (parseInt(txt, 10) === n) { target = q; break; }
  }
  if (!target) { toast("第 " + n + " 题不在当前显示的题目中"); return; }
  scrollToQ(target);
  toast("已跳到 " + qLabel(target));
}

/* ---------- 目录折叠 ---------- */
function navIsOpen() {
  const box = document.getElementById("navbox");
  if (!box) return false;
  return window.innerWidth <= 768 ? box.classList.contains("open") : !box.classList.contains("closed");
}
function setNavBtn() {
  const btn = document.querySelector(".nav-toggle");
  if (btn) btn.textContent = navIsOpen() ? "✕ 收起目录" : "☰ 目录";
}
function toggleNav() {
  const box = document.getElementById("navbox");
  if (!box) return;
  if (window.innerWidth <= 768) box.classList.toggle("open");
  else box.classList.toggle("closed");
  setNavBtn();
}
function closeNav() {
  const box = document.getElementById("navbox");
  if (!box) return;
  if (window.innerWidth <= 768) box.classList.remove("open");
  else box.classList.add("closed");
  setNavBtn();
}
function pickKp(btn, id) {
  f.kp = f.kp === id ? null : id;
  document.querySelectorAll(".gbtn").forEach((b) => {
    b.classList.toggle("on", b.getAttribute("data-kp") === f.kp);
  });
  applyFilters();
  if (window.innerWidth <= 768) closeNav();
  jumpToLatest();
}

/* ---------- 全局事件 ---------- */
document.addEventListener("change", (e) => {
  const inp = e.target;
  if (!inp || inp.type !== "radio") return;   // 多选走「确认作答」，填空走「核对」
  const q = inp.closest(".q");
  if (!q || inp.disabled) return;
  // 模拟练习页：只选择不判分、不写入刷题记录（交卷时统一判分）
  if (typeof state !== "undefined" && state && state.exam) return;
  rec[q.getAttribute("data-qid")] = { a: inp.value, t: Date.now() };
  saveLocal();
  paintAnswered(q, inp.value);
  applyFilters();
  scheduleSync();
});
window.addEventListener("resize", setNavBtn);

/* ---------- 页面启动助手 ---------- */
function bindCommonControls() {
  const kw = document.getElementById("kw");
  if (kw) kw.addEventListener("input", () => {
    f.kw = kw.value.trim().toLowerCase();
    applyFilters();
  });
  const jn = document.getElementById("jumpno");
  if (jn) jn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.keyCode === 13) jumpToNo();
  });
}
async function bootPage(renderFn,beforeRender) {
  loadForUser(localSession());
  if(beforeRender) await beforeRender();
  const draw=()=>{renderFn();paintAll();syncFavBtns();setNavBtn();applyFilters();};
  draw();jumpToLatest(true);
  try {
    const ok=await pushState();
    if(ok){if(beforeRender)await beforeRender();
      const editing=document.querySelector('input:checked:not(:disabled)')||[...document.querySelectorAll('input[type=text]:not(:disabled)')].some(i=>i.value);
      if(!editing)draw();
    }
  }catch(e){setSyncLabel('本地已保存 · 云端暂不可用');}
}
async function doSignOut() {
  if(!confirm('退出后需要重新登录，当前设备的学习记录会保留。继续吗？'))return;
  await pushState();
  try {await initCloud().auth.signOut({scope:'local'});}catch(e){toast('退出失败，请联网后重试');return;}
  localStorage.removeItem('mb_last_user');location.href='index.html';
}
void checkUpdate();
