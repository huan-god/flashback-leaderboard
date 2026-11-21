import {canonicalTeam,scopeKey,chooseWinners,compareRecord,playerRanking} from './logic.mjs';

const config = window.FLASHBACK_CONFIG || {};
const demo = !(config.supabaseUrl && config.supabaseAnonKey);
const STORAGE_KEY = 'focus-flashback-demo-v1';
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateLabel = v => {try{return new Date(v).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}catch{return '—';}};
const shortDate = v => {try{return new Date(v).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'});}catch{return '—';}};
const uid = () => crypto.randomUUID?.() || String(Date.now())+'_'+Math.random().toString(36).slice(2);
let sb = null;
let toastTimer = 0;
const state = {page:'leaderboard',versions:[],stages:[],records:[],players:[],allSubmissions:[],histories:[],versionId:'',stageId:'',group:'zero',user:null,profile:null,isAdmin:demo,busy:false,notice:'',demoData:null};

function seededDemo() {
  const versions = [{id:'v-demo-1',code:'trial-01',label:'演示版本 · 01',created_at:'2026-11-20T00:00:00Z'}];
  const stages = [1,2,3].map(n=>({id:'s-demo-'+n,version_id:versions[0].id,stage_no:n,name:['第一关（示意）','第二关（示意）','第三关（示意）'][n-1]}));
  const input = [
    ['甲','s-demo-1','zero',['角色A','角色B','角色C','角色D'],'角色A',3,'2026-11-20T08:00:00Z'],
    ['乙','s-demo-1','zero',['角色D','角色C','角色A','角色B'],'角色A',2,'2026-11-20T09:00:00Z'],
    ['丙','s-demo-1','zero',['角色A','角色B','角色C','角色D'],'角色B',2,'2026-11-20T09:40:00Z'],
    ['丁','s-demo-1','zero',['角色E','角色F','角色G','角色H'],'角色E',4,'2026-11-20T10:10:00Z'],
    ['甲','s-demo-1','max',['角色A','角色E','角色F','角色H'],'角色A',1,'2026-11-20T11:00:00Z'],
    ['乙','s-demo-2','zero',['角色I','角色J','角色K','角色L'],'角色I',5,'2026-11-20T12:00:00Z'],
    ['丁','s-demo-2','max',['角色E','角色F','角色G','角色H'],'角色E',3,'2026-11-20T12:30:00Z'],
    ['丙','s-demo-3','zero',['角色A','角色I','角色C','角色L'],'角色I',4,'2026-11-20T13:00:00Z']
  ];
  const submissions = input.map(([name,stage_id,group_code,team,carry_name,rounds,created_at],i)=>({id:`s${i+1}`,player_id:`player-${name}`,display_name:`测试玩家${name}`,stage_id,group_code,team,team_key:canonicalTeam(team),carry_name,rounds,created_at,status:'approved',evidence_path:'',evidence_filename:'',evidence_data:''}));
  submissions.push({id:'s-pending-1',player_id:'player-戊',display_name:'测试玩家戊',stage_id:'s-demo-3',group_code:'max',team:['角色A','角色B','角色K','角色L'],team_key:canonicalTeam(['角色A','角色B','角色K','角色L']),carry_name:'角色A',rounds:2,created_at:'2026-11-20T14:00:00Z',status:'pending',evidence_path:'',evidence_filename:'演示截图.png',evidence_data:''});
  const histories = [];
  const approvedInOrder = submissions.filter(s=>s.status==='approved').sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
  const seen = new Map();
  for (const s of approvedInOrder) {
    const key=scopeKey(s),old=seen.get(key);
    if(!old||compareRecord(s,old)<0){
      seen.set(key,s);
      histories.push({id:uid(),stage_id:s.stage_id,group_code:s.group_code,team_key:canonicalTeam(s.team),player_id:s.player_id,submission_id:s.id,acquired_at:s.created_at,lost_at:null});
    }
  }
  return {versions,stages,submissions,histories};
}
function loadDemo(){try{const v=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');if(v?.versions?.length&&Array.isArray(v.submissions))return v;}catch{}return seededDemo();}
function saveDemo(){localStorage.setItem(STORAGE_KEY,JSON.stringify(state.demoData));}
function demoUpdate(){
  const data=state.demoData;
  state.versions=data.versions;state.stages=data.stages;state.allSubmissions=data.submissions;
  state.records=chooseWinners(data.submissions);state.histories=data.histories;
  state.players=playerRanking(data.submissions,data.histories);
}
async function getSb() {
  if (sb) return sb;
  const {createClient}=await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  sb=createClient(config.supabaseUrl,config.supabaseAnonKey);
  return sb;
}
async function query(table, select='*') {
  const {data,error}=await sb.from(table).select(select);
  if(error)throw error;
  return data||[];
}
async function loadRemote() {
  const [versions,stages,records,players]=await Promise.all([
    query('versions','id,code,label,created_at'),
    query('stages','id,version_id,stage_no,name'),
    query('leaderboard_records'),
    query('player_ranking')
  ]);
  state.versions=versions.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  state.stages=stages;state.records=records;state.players=players;
}
async function refresh() {
  try { if(demo)demoUpdate(); else await loadRemote(); }
  catch(e){state.notice=`加载失败：${e.message||e}`;}
  if(!state.versions.some(v=>v.id===state.versionId))state.versionId=state.versions[0]?.id||'';
  const st=state.stages.filter(x=>x.version_id===state.versionId).sort((a,b)=>a.stage_no-b.stage_no);
  if(!st.some(x=>x.id===state.stageId))state.stageId=st[0]?.id||'';
  render();
}
function metric(){
  $('#metricRecords').textContent=state.records.length;
  $('#metricPlayers').textContent=state.players.filter(x=>x.historical_count||x.current_count).length;
  $('#metricVersions').textContent=state.versions.length;
  $('#connectionTag').textContent=demo?'本地演示':'在线运行';
  $('#userButton').textContent=demo?'演示模式':(state.isAdmin?'站长账号':(state.profile?.display_name || (state.user?'设置昵称':'玩家登录')));
  const existing=$('#adminButton');if(existing)existing.remove();
  if(state.isAdmin){const btn=document.createElement('button');btn.id='adminButton';btn.className='ghost-button';btn.textContent=demo?'演示审核后台':'管理后台';$('#userButton').before(btn);}
}
function render(){
  metric();
  document.querySelectorAll('.nav-link').forEach(b=>b.classList.toggle('active',b.dataset.page===state.page));
  $('#content').innerHTML=state.notice?`<div class="notice error" style="margin-top:18px">${esc(state.notice)}</div>`:'';
  const html=state.page==='leaderboard'?renderLeaderboard():state.page==='players'?renderPlayers():renderRules();
  $('#content').insertAdjacentHTML('beforeend',html);
}
function renderLeaderboard(){
  const ver=state.versions.find(x=>x.id===state.versionId);
  const stages=state.stages.filter(x=>x.version_id===state.versionId).sort((a,b)=>a.stage_no-b.stage_no);
  const st=stages.find(x=>x.id===state.stageId);
  const rows=state.records.filter(r=>r.stage_id===state.stageId&&r.group_code===state.group).sort(compareRecord);
  const options=state.versions.map(x=>`<option value="${esc(x.id)}" ${state.versionId===x.id?'selected':''}>${esc(x.label)}</option>`).join('');
  return `<section class="content-section"><div class="section-eyebrow">LATEST RECORDS</div>
    <div class="section-header"><div><h2>焦点闪回 · 排行榜</h2><p class="section-subtitle">同一阵容只展示最短回合的唯一纪录保持者 · 同分先上传者优先</p></div><select id="versionSelect" class="version-select" aria-label="选择版本">${options}</select></div>
    ${demo?`<div class="notice">当前是可操作的<strong>单浏览器演示版（审核权限仅为模拟）</strong>：下方均为虚构测试数据，投稿和审核只保存在你自己的浏览器，尚未共享给其他玩家。</div>`:''}
    <div class="board-wrap"><aside class="filter-panel"><div class="filter-title">选择挑战 <span class="filter-small">STAGE SELECT</span></div><div class="filter-divider"></div><div class="filter-label">01 / 关卡</div>
    <div class="stage-options">${stages.map(x=>`<button class="stage-button ${state.stageId===x.id?'active':''}" data-action="stage" data-id="${esc(x.id)}"><span class="stage-num">0${x.stage_no}</span><span class="stage-name">${esc(x.name)}</span><span class="chevron">›</span></button>`).join('')||'<p class="smaller">暂无关卡</p>'}</div>
    <div class="filter-divider"></div><div class="filter-label">02 / 塑造限制</div><div class="group-switch"><button data-action="group" data-group="zero" class="${state.group==='zero'?'active':''}">全0塑造</button><button data-action="group" data-group="max" class="${state.group==='max'?'active':''}">全满塑造</button></div>
    <div class="filter-hint">✦ 每个版本有三个关卡。<br />✦ 仅收录 <strong>0—6 回合</strong> 通关。<br />✦ 不同阵容独立保留最佳纪录。<br />✦ 分数并列按提交时间优先。</div></aside>
    <div class="board-panel"><div class="board-head"><div><h3>${esc(st?.name||'暂无关卡')} <span style="font-size:13px;color:var(--gold)">/ ${state.group==='zero'?'全0塑造':'全满塑造'}</span></h3><p>${esc(ver?.label||'尚未配置版本')} · 共 ${rows.length} 个当前纪录</p></div><span class="chip">✧ 已审核通过</span></div>
    ${rows.length?`<div class="table-scroll"><table class="board-table"><thead><tr><th>排序</th><th>纪录保持者</th><th>主 C / 队伍</th><th>回合</th><th>首次上传</th></tr></thead><tbody>${rows.map((r,i)=>`<tr><td><span class="rank-icon ${i===0?'first':''}">${String(i+1).padStart(2,'0')}</span></td><td><span class="player-name">${esc(r.display_name)}</span><div class="smaller">唯一纪录保持者</div></td><td><div style="font-size:12px;color:var(--gold);margin-bottom:6px">主C · ${esc(r.carry_name)}</div><div class="team-pills">${r.team.map(n=>`<span class="team-pill">${esc(n)}</span>`).join('')}</div></td><td><span class="rounds">${r.rounds}<small>回合</small></span></td><td><span class="smaller">${dateLabel(r.created_at)}</span></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty"><div class="symbol">✧</div><h3>这片时间尚未留下纪录</h3><p>成为第一个提交有效挑战成绩的玩家吧。</p><button class="gold-button" data-action="submit">提交首个纪录 →</button></div>`}
    <div class="board-foot"><span>以服务器上传时间为准 · 审核后自动更新榜单</span><button class="text-button" data-action="refresh">刷新榜单 ↻</button></div></div></div>
    <div class="two-cards"><div class="info-card"><div class="info-number">01</div><h3>一队 · 一纪录</h3><p>相同关卡、塑造组和完整阵容，仅保留回合最少的一条记录。主C单独显示，但不改变队伍归属。</p></div><div class="info-card"><div class="info-number">02</div><h3>荣耀从未消失</h3><p>被超越的纪录不再公开占榜，曾经获得的有效历史荣誉仍计入玩家累计上榜次数。</p></div></div></section>`;
}
function renderPlayers(){
  return `<section class="content-section"><div class="section-eyebrow">HALL OF FAME</div><div class="section-header"><div><h2>玩家荣誉殿堂</h2><p class="section-subtitle">跨版本累计历史上榜次数排名，同分优先比较当前持榜数</p></div><span class="chip">ALL-TIME HONORS</span></div>
   ${demo?'<div class="notice">下列玩家均为虚构演示账号，成绩仅用于测试排名功能。</div>':''}
   <div class="board-panel"><div class="table-scroll"><table class="players-table"><thead><tr><th>名次</th><th>玩家</th><th>历史上榜</th><th>当前持榜</th></tr></thead><tbody>
   ${state.players.length?state.players.map((p,i)=>`<tr><td><span class="rank-icon ${i===0?'first':''}">${String(i+1).padStart(2,'0')}</span></td><td><span class="player-name">${esc(p.display_name)}</span></td><td><span class="rounds">${p.historical_count}<small>次</small></span></td><td>${p.current_count} 个</td></tr>`).join(''):`<tr><td colspan="4"><div class="empty"><div class="symbol">♙</div><p>尚无上榜玩家</p></div></td></tr>`}
   </tbody></table></div></div><div class="two-cards"><div class="info-card"><div class="info-number">∞</div><h3>历史上榜次数</h3><p>曾经成为某关卡、塑造组、具体阵容的纪录保持者，即记一项历史荣誉。重复夺回同一项不重复累计。</p></div><div class="info-card"><div class="info-number">✦</div><h3>当前持榜数量</h3><p>目前仍保持最佳回合的阵容数量，实时根据已经审核通过的成绩重新计算。</p></div></div></section>`;
}
function renderRules(){
  const items=[['01','三个关卡','每个游戏版本独立设置三个关卡，纪录不会跨版本或关卡比较。'],['02','两种塑造','全0塑造与全满塑造分榜比较。队伍内所有参战角色必须符合所选塑造组规则。'],['03','零至六回合','只能提交 0、1、2、3、4、5、6 回合的有效成绩，上传通关截图供管理员核验。'],['04','阵容识别','提交主C与实际上场的完整队伍。相同角色组合视为同队，与角色填写顺序无关；主C并不拆分榜单。'],['05','唯一保持者','同队仅有回合最少者上榜；同回合数先提交者获胜。以数据库记录的提交时间为准，不受审核顺序影响。'],['06','历史荣誉','曾夺得同一「版本／关卡／塑造／队伍」最佳纪录，历史次数最多计一次，重夺不叠加。被取消的无效成绩不计荣誉。']];
  return `<section class="content-section"><div class="section-eyebrow">RULES & FAIR PLAY</div><div class="section-header"><div><h2>排行榜规则与投稿须知</h2><p class="section-subtitle">只让真实、可验证的成绩留下名字</p></div></div><div class="rules-list">${items.map(i=>`<div class="rules-card"><div class="num">${i[0]}</div><h3>${i[1]}</h3><p>${i[2]}</p></div>`).join('')}</div><div class="notice" style="margin-top:22px"><strong>玩法参考：</strong>「焦点闪回」是《重返未来：1999》从 3.6 版本开始推出的周期挑战玩法，具体关卡、可用增幅与机制以游戏和 Wiki 对应期次为准。<a class="wiki-link" href="https://res1999.huijiwiki.com/wiki/%E7%84%A6%E7%82%B9%E9%97%AA%E5%9B%9E" target="_blank" rel="noopener noreferrer">查阅重返未来1999中文 Wiki · 焦点闪回 ↗</a><br>本站的 0—6 回合收录上限、全0／全满塑造分组和唯一纪录规则是<strong>社区排行榜自定义规则</strong>，并非游戏官方排名规定。示意版本与角色数据不对应实际游戏。</div></section>`;
}
function toast(msg){const el=$('#toast');el.textContent=msg;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),3200);}
function openModal(html,wide=false){$('#modalRoot').innerHTML=`<div class="overlay" id="overlay"><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true"><button class="modal-close" data-action="close" aria-label="关闭">×</button>${html}</section></div>`;}
function closeModal(){$('#modalRoot').innerHTML='';}
function modalOptions(){return state.versions.map(v=>`<option value="${esc(v.id)}" ${v.id===state.versionId?'selected':''}>${esc(v.label)}</option>`).join('');}
function stageOptions(vid){return state.stages.filter(s=>s.version_id===vid).sort((a,b)=>a.stage_no-b.stage_no).map(s=>`<option value="${esc(s.id)}" ${s.id===state.stageId?'selected':''}>${esc(s.name)}</option>`).join('');}
function openSubmission(){
  if(!demo&&!state.user){openLogin();toast('玩家投稿需要邮箱登录，审核后台仅向管理员账号开放。');return;}
  if(!demo&&!state.profile){openLogin();toast('请先设置玩家昵称。');return;}
  openModal(`<div class="modal-eyebrow">SUBMIT A NEW RECORD</div><h2>提交挑战成绩</h2><p class="modal-subtitle">填写完整队伍与回合数，管理员核验后才会进入公开榜单。</p>
   <form id="submissionForm"><div class="form-grid"><div class="field"><label for="nickname">玩家昵称 *</label><input id="nickname" name="nickname" maxlength="24" required placeholder="例：时间旅行者" value="${esc(state.profile?.display_name||'')}" ${demo?'':'readonly'}/></div><div class="field"><label for="fVersion">游戏版本</label><select id="fVersion" name="version">${modalOptions()}</select></div></div>
   <div class="form-grid"><div class="field"><label for="fStage">挑战关卡</label><select id="fStage" name="stage">${stageOptions(state.versionId)}</select></div><div class="field"><label for="fGroup">塑造分组</label><select id="fGroup" name="group"><option value="zero" ${state.group==='zero'?'selected':''}>全0塑造</option><option value="max" ${state.group==='max'?'selected':''}>全满塑造</option></select></div></div>
   <div class="form-grid"><div class="field"><label for="carry">主C角色 *</label><input id="carry" name="carry" required maxlength="40" placeholder="主输出角色名称"/></div><div class="field"><label for="rounds">通关回合 *</label><select id="rounds" name="rounds">${Array.from({length:7},(_,n)=>`<option value="${n}">${n} 回合</option>`).join('')}</select></div></div>
   <div class="field"><label for="team">完整配队 *</label><textarea id="team" name="team" required placeholder="例如：角色A、角色B、角色C、角色D"></textarea><span class="field-hint">按实际出战填写全部角色，用顿号 / 逗号分开，1—4 名，不按填写顺序区分队伍。</span></div>
   <div class="field"><label for="proof">通关截图 *</label><input id="proof" name="proof" type="file" accept="image/png,image/jpeg,image/webp" required/><span class="field-hint">支持 PNG / JPG / WebP，单张不超过 5 MB。图片仅管理员可见。</span></div>
   <div class="form-note">${demo?'当前是单设备演示：截图会被压缩保存在此浏览器，仅供本地模拟审核，其他人看不到。':'正式提交需要绑定邮箱账号，系统以服务器生成的时间戳决定同回合优先级。'}</div>
   <div class="form-actions"><button type="button" class="outline-button" data-action="close">取消</button><button class="gold-button" id="submissionConfirm" type="submit">确认提交 →</button></div></form>`);
}
function openLogin(){
  if(demo){toast('当前是演示模式：直接点击「投稿成绩」即可模拟提交；审核后台也可测试。');return;}
  if(state.user){openModal(`<div class="modal-eyebrow">PLAYER PROFILE</div><h2>玩家资料</h2><p class="modal-subtitle">已登录：${esc(state.user.email||'邮箱账号')}</p><form id="profileForm"><div class="field"><label for="profileName">展示昵称</label><input name="name" id="profileName" maxlength="24" minlength="2" required value="${esc(state.profile?.display_name||'')}" placeholder="2—24 个字符"/></div><div class="form-actions"><button type="button" class="outline-button" data-action="logout">退出登录</button><button type="submit" class="gold-button">保存昵称</button></div></form>`);}
  else openModal(`<div class="modal-eyebrow">PLAYER ACCESS</div><h2>邮箱登录</h2><p class="modal-subtitle">邮箱账号用于关联投稿与历史上榜数据。只有站长指定的账号拥有审核与移除权限，无需设置密码。</p><form id="loginForm"><div class="field"><label for="email">电子邮箱</label><input id="email" name="email" type="email" required placeholder="you@example.com"/></div><div class="form-note">我们将发送一次性登录链接。收到邮件后，在同一个浏览器中打开链接；首次登录再设置玩家昵称。</div><div class="form-actions"><button type="button" class="outline-button" data-action="close">取消</button><button type="submit" class="gold-button">发送登录邮件</button></div></form>`);
}
function getSubmission(form){
  const fd=new FormData(form);const team=String(fd.get('team')||'').split(/[、，,;；\n]+/).map(x=>x.trim()).filter(Boolean);
  const nickname=String(fd.get('nickname')||'').trim();const carry=String(fd.get('carry')||'').trim();const rounds=Number(fd.get('rounds'));const file=fd.get('proof');
  if(nickname.length<2||nickname.length>24)throw Error('玩家昵称需要 2—24 个字符。');
  if(team.length<1||team.length>4)throw Error('请填写 1—4 名实际上场角色。');
  if(team.some(x=>x.length>40))throw Error('单个角色名称不能超过 40 字符。');
  const norm=team.map(x=>x.normalize('NFKC').trim().toLowerCase());
  if(new Set(norm).size!==team.length)throw Error('配队不能填写重复角色。');
  if(!norm.includes(carry.normalize('NFKC').trim().toLowerCase()))throw Error('主C必须属于你填写的完整队伍。');
  if(!Number.isInteger(rounds)||rounds<0||rounds>6)throw Error('回合数必须在 0—6 之间。');
  if(!file||!(file instanceof File)||file.size===0)throw Error('请上传通关截图。');
  if(file.size>5*1024*1024)throw Error('截图不能超过 5 MB。');
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('截图只支持 PNG、JPG 和 WebP。');
  if(!state.stages.some(s=>s.id===fd.get('stage')&&s.version_id===fd.get('version')))throw Error('版本与关卡不匹配。');
  return {nickname,carry,team,rounds,file,stage_id:String(fd.get('stage')),group_code:String(fd.get('group'))};
}
async function thumbnail(file){
  try {
    const bitmap=await createImageBitmap(file);const canvas=document.createElement('canvas');const scale=Math.min(1,920/Math.max(bitmap.width,bitmap.height));canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close?.();return canvas.toDataURL('image/jpeg',.6);
  }catch{return ''}
}
async function submitRecord(form){
  const v=getSubmission(form);const button=$('#submissionConfirm');button.disabled=true;button.textContent='正在提交…';
  try {
    if(demo){
      const record={id:uid(),player_id:`demo:${v.nickname.toLocaleLowerCase('zh-CN')}`,display_name:v.nickname,stage_id:v.stage_id,group_code:v.group_code,team:v.team,team_key:canonicalTeam(v.team),carry_name:v.carry,rounds:v.rounds,created_at:new Date().toISOString(),status:'pending',evidence_path:'',evidence_filename:v.file.name,evidence_data:await thumbnail(v.file)};
      state.demoData.submissions.push(record);saveDemo();
    } else {
      if(!state.user||!state.profile)throw Error('请先登录并完成玩家资料。');
      const ext=v.file.type==='image/png'?'png':v.file.type==='image/webp'?'webp':'jpg';
      const path=`${state.user.id}/${uid()}.${ext}`;
      const {error:uploadError}=await sb.storage.from('proofs').upload(path,v.file,{contentType:v.file.type,upsert:false});
      if(uploadError)throw uploadError;
      const {error}=await sb.from('submissions').insert({player_id:state.user.id,stage_id:v.stage_id,group_code:v.group_code,team:v.team,carry_name:v.carry,rounds:v.rounds,evidence_path:path});
      if(error){await sb.storage.from('proofs').remove([path]).catch(()=>{});throw error;}
    }
    closeModal();await refresh();toast('已提交，当前状态：等待管理员审核。');
  }catch(e){toast(`投稿失败：${e.message||e}`);button.disabled=false;button.textContent='确认提交 →';}
}
function demoApprove(id,approved){
  const sub=state.demoData.submissions.find(s=>s.id===id);if(!sub||sub.status!=='pending')throw Error('找不到待审核记录。');
  const old=chooseWinners(state.demoData.submissions).find(s=>scopeKey(s)===scopeKey(sub));
  sub.status=approved?'approved':'rejected';sub.reviewed_at=new Date().toISOString();
  if(approved){
    const current=chooseWinners(state.demoData.submissions).find(s=>scopeKey(s)===scopeKey(sub));
    if(current?.id!==old?.id&&current){
      const previous=state.demoData.histories.filter(x=>x.stage_id===sub.stage_id&&x.group_code===sub.group_code&&x.team_key===canonicalTeam(sub.team)&&!x.lost_at);previous.forEach(x=>x.lost_at=new Date().toISOString());
      state.demoData.histories.push({id:uid(),stage_id:current.stage_id,group_code:current.group_code,team_key:canonicalTeam(current.team),player_id:current.player_id,submission_id:current.id,acquired_at:new Date().toISOString(),lost_at:null});
    }
  }
  saveDemo();
}
async function loadModerationRows(tab){
  if(demo)return state.demoData.submissions.filter(x=>x.status===tab).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  const {data,error}=await sb.from('submissions')
    .select('id,player_id,stage_id,group_code,team,carry_name,rounds,created_at,status,evidence_path,review_note,profiles(display_name)')
    .eq('status',tab).order('created_at',{ascending:false}).limit(250);
  if(error)throw error;
  return (data||[]).map(x=>({...x,display_name:x.profiles?.display_name||'未知玩家'}));
}
async function openAdmin(tab='pending'){
  if(!state.isAdmin){toast('仅管理员可以访问管理后台。');return;}
  if(!['pending','approved','removed'].includes(tab))tab='pending';
  const labels={pending:'待审核',approved:'已通过',removed:'已移除'};
  openModal(`<div class="modal-eyebrow">MODERATION CENTER · ${demo?'LOCAL DEMO':'ADMIN ONLY'}</div><h2>排行榜管理后台</h2><p class="modal-subtitle">${demo?'当前仅为本地模拟，无法代表真实管理员权限。':'只有数据库中授权的管理员账号能进入、审核或移除成绩。'} 移除不物理删除，保留审核原因和证据。</p>
  <div class="moderation-tabs">${Object.entries(labels).map(([key,val])=>`<button class="outline-button ${key===tab?'selected':''}" data-action="moderation-tab" data-tab="${key}">${val}</button>`).join('')}</div>
  <div id="adminList"><div class="smaller">正在读取${labels[tab]}记录…</div></div>
  <div class="form-actions" style="margin-top:20px"><button class="outline-button" data-action="new-version">＋ 新建版本</button><button class="outline-button" data-action="close">关闭</button></div>`,true);
  try{
    const rows=await loadModerationRows(tab);
    const host=$('#adminList'); if(!host)return;
    host.innerHTML=rows.length?`<div class="minor admin-count">共显示 ${rows.length} 条${labels[tab]}记录${rows.length===250?'（仅展示最近250条）':''}</div>`+rows.map(r=>{
      const stage=state.stages.find(x=>x.id===r.stage_id),version=state.versions.find(v=>v.id===stage?.version_id);
      const buttons=tab==='pending'?`<button class="approve" data-action="approve" data-id="${esc(r.id)}">✓ 审核通过</button><button class="reject" data-action="reject" data-id="${esc(r.id)}">× 拒绝成绩</button>`:
        tab==='approved'?`<button class="reject" data-action="remove-record" data-id="${esc(r.id)}">移除这条成绩</button>`:'';
      return `<article class="review-card"><div class="review-top"><strong>${esc(r.display_name)} <span class="chip">${r.rounds} 回合</span></strong><span class="minor">${dateLabel(r.created_at)}</span></div>
        <div class="review-meta">${esc(version?.label||'未知版本')} · ${esc(stage?.name||'未知关卡')} · ${r.group_code==='zero'?'全0塑造':'全满塑造'}<br>主C：${esc(r.carry_name)}　队伍：${r.team.map(esc).join(' / ')}${r.status==='removed'?`<br><strong>撤销原因：</strong>${esc(r.review_note||'未记录')}`:''}</div>
        <div id="proof-${esc(r.id)}" class="minor" style="margin-top:8px"></div><div class="review-actions"><button class="outline-button" data-action="preview" data-id="${esc(r.id)}">查看截图</button>${buttons}</div></article>`;
    }).join(''):`<div class="empty"><div class="symbol">✓</div><h3>${labels[tab]}列表为空</h3><p>可切换其他状态查看记录。</p></div>`;
  }catch(e){const el=$('#adminList');if(el)el.innerHTML=`<div class="notice error">读取后台失败：${esc(e.message)}</div>`;}
}
async function review(id,approved){
  if(!state.isAdmin)return;
  if(!approved&&!window.confirm('确定拒绝这条投稿吗？'))return;
  try {
    if(demo) demoApprove(id,approved);
    else {const {error}=await sb.rpc('review_submission',{p_submission_id:id,p_decision:approved?'approved':'rejected',p_note:''});if(error)throw error;}
    await refresh();await openAdmin('pending');toast(approved?'审核通过，排行榜已更新。':'投稿已拒绝。');
  }catch(e){toast(`审核失败：${e.message||e}`);}
}
function demoRemove(id,reason){
  const sub=state.demoData.submissions.find(x=>x.id===id);
  if(!sub||sub.status!=='approved')throw Error('仅能移除已通过的记录。');
  const old=chooseWinners(state.demoData.submissions).find(s=>scopeKey(s)===scopeKey(sub));
  sub.status='removed';sub.reviewed_at=new Date().toISOString();sub.review_note=reason;
  const current=chooseWinners(state.demoData.submissions).find(s=>scopeKey(s)===scopeKey(sub));
  if(old?.id!==current?.id){
    const items=state.demoData.histories.filter(h=>h.stage_id===sub.stage_id&&h.group_code===sub.group_code&&h.team_key===canonicalTeam(sub.team)&&!h.lost_at);
    items.forEach(h=>h.lost_at=new Date().toISOString());
    if(current)state.demoData.histories.push({id:uid(),stage_id:current.stage_id,group_code:current.group_code,team_key:canonicalTeam(current.team),player_id:current.player_id,submission_id:current.id,acquired_at:new Date().toISOString(),lost_at:null});
  }
  saveDemo();
}
async function removeRecord(id){
  if(!state.isAdmin)return;
  const reason=window.prompt('请输入移除原因（例如：截图无效、阵容不符），至少2个字。\n这条成绩将从榜单中撤下，并重新计算纪录和历史荣誉。');
  if(reason===null)return;
  const note=reason.trim();
  if(note.length<2||note.length>200){toast('移除原因必须为 2—200 个字符。');return;}
  if(!window.confirm('确定移除这条已通过的成绩吗？操作会记录原因并影响排行榜。'))return;
  try{
    if(demo)demoRemove(id,note);
    else {const {error}=await sb.rpc('remove_submission',{p_submission_id:id,p_reason:note});if(error)throw error;}
    await refresh();await openAdmin('approved');toast('成绩已移除，排行榜与玩家荣誉已重新计算。');
  }catch(e){toast(`移除失败：${e.message||e}`);}
}
async function preview(id){
  const root=document.getElementById(`proof-${id}`);if(!root)return;
  try{
    let url='';
    if(demo){const s=state.demoData.submissions.find(x=>x.id===id);url=s?.evidence_data||'';if(!url){root.textContent='这是一条初始化的虚构测试投稿，没有真实截图。';return;}}
    else {const {data,error}=await sb.from('submissions').select('evidence_path').eq('id',id).single();if(error)throw error;const {data:signed,error:err}=await sb.storage.from('proofs').createSignedUrl(data.evidence_path,60);if(err)throw err;url=signed.signedUrl;}
    root.innerHTML=`<img alt="投稿成绩截图" style="max-width:100%;max-height:410px;border:1px solid #6e5d52" src="${esc(url)}"/>`;
  }catch(e){root.textContent=`查看失败：${e.message}`;}
}
function openVersion(){
  if(!state.isAdmin)return;
  openModal(`<div class="modal-eyebrow">NEW GAME VERSION</div><h2>新建游戏版本</h2><p class="modal-subtitle">新增版本后自动创建恰好三个关卡。</p><form id="versionForm"><div class="form-grid"><div class="field"><label>版本代号（不能重复）</label><input name="code" maxlength="30" placeholder="例如 3.0" required/></div><div class="field"><label>展示名称</label><input name="label" maxlength="80" placeholder="例如 3.0 · 某某篇章" required/></div></div>${[1,2,3].map(i=>`<div class="field"><label>第 ${i} 关名称</label><input name="stage${i}" maxlength="80" placeholder="第${i}关" required/></div>`).join('')}<div class="form-actions"><button type="button" class="outline-button" data-action="admin">返回后台</button><button type="submit" class="gold-button">创建版本</button></div></form>`);
}
async function createVersion(form){
  const fd=new FormData(form);const code=String(fd.get('code')||'').trim(),label=String(fd.get('label')||'').trim();const names=[1,2,3].map(i=>String(fd.get('stage'+i)||'').trim());
  if(!code||!label||names.some(x=>!x))return toast('所有版本与关卡字段都必须填写。');
  try {
    let vid;
    if(demo){
      if(state.demoData.versions.some(x=>x.code===code))throw Error('版本代号已存在。');
      vid=uid();state.demoData.versions.unshift({id:vid,code,label,created_at:new Date().toISOString()});
      state.demoData.stages.push(...names.map((name,i)=>({id:uid(),version_id:vid,stage_no:i+1,name})));
      saveDemo();
    }else{
      const {data,error}=await sb.rpc('create_version',{p_code:code,p_label:label,p_stage_names:names});
      if(error)throw error;vid=data;
    }
    state.versionId=vid;state.stageId='';state.page='leaderboard';closeModal();await refresh();toast(`已新建版本：${label}`);
  }catch(e){toast(`新建失败：${e.message||e}`);}
}
async function sendLogin(form){
  const email=String(new FormData(form).get('email')||'').trim();
  try{const {error}=await sb.auth.signInWithOtp({email,options:{emailRedirectTo:window.location.href.split('#')[0]}});if(error)throw error;closeModal();toast('登录链接已发送，请检查邮箱。');}
  catch(e){toast(`发送失败：${e.message}`);}
}
async function saveProfile(form){
  const name=String(new FormData(form).get('name')||'').trim();if(name.length<2||name.length>24)return toast('昵称需在 2—24 个字符之间。');
  try{const {error}=await sb.from('profiles').upsert({id:state.user.id,display_name:name},{onConflict:'id'});if(error)throw error;state.profile={id:state.user.id,display_name:name};closeModal();render();toast('昵称已保存。');}
  catch(e){toast(`保存失败：${e.message}`);}
}
async function syncAuth(){
  const {data:{user}}=await sb.auth.getUser();state.user=user;
  state.profile=null;state.isAdmin=false;
  if(user){
    const {data}=await sb.from('profiles').select('id,display_name').eq('id',user.id).maybeSingle();state.profile=data;
    const {data:isAdmin}=await sb.rpc('is_admin');state.isAdmin=Boolean(isAdmin);
  }
  render();
}
async function init(){
  if(demo){state.demoData=loadDemo();state.notice='';await refresh();}
  else{
    try{await getSb();await loadRemote();await syncAuth();sb.auth.onAuthStateChange(()=>{setTimeout(()=>syncAuth().catch(e=>toast(e.message)),0);});await refresh();}
    catch(e){state.notice=`无法连接 Supabase：${e.message||e}。请检查 config.js 配置及数据库初始化。`;render();}
  }
}

// 采用事件委托，确保每次局部重绘后操作依然有效。
document.addEventListener('click',async ev=>{
  const el=ev.target.closest('button');if(!el)return;
  const page=el.dataset.page,action=el.dataset.action;
  if(page){state.page=page;render();$('#content').scrollIntoView({behavior:'smooth',block:'start'});return;}
  if(el.id==='submitButton'||el.id==='heroSubmit'||action==='submit'){openSubmission();return;}
  if(el.id==='userButton'){openLogin();return;}
  if(el.id==='adminButton'||action==='admin'){await openAdmin();return;}
  if(action==='moderation-tab'){await openAdmin(el.dataset.tab);return;}
  if(action==='remove-record'){await removeRecord(el.dataset.id);return;}
  if(action==='close'){closeModal();return;}
  if(action==='stage'){state.stageId=el.dataset.id;render();return;}
  if(action==='group'){state.group=el.dataset.group;render();return;}
  if(action==='refresh'){await refresh();toast('榜单已更新。');return;}
  if(action==='approve'||action==='reject'){await review(el.dataset.id,action==='approve');return;}
  if(action==='preview'){await preview(el.dataset.id);return;}
  if(action==='new-version'){openVersion();return;}
  if(action==='logout'){await sb.auth.signOut();closeModal();await syncAuth();toast('已退出登录。');return;}
});
document.addEventListener('change',ev=>{
  if(ev.target.id==='versionSelect'){state.versionId=ev.target.value;state.stageId='';render();}
  if(ev.target.id==='fVersion'){const el=$('#fStage');if(el)el.innerHTML=stageOptions(ev.target.value);}
});
document.addEventListener('submit',async ev=>{
  const form=ev.target;if(!['submissionForm','loginForm','profileForm','versionForm'].includes(form.id))return;
  ev.preventDefault();if(form.id==='submissionForm')await submitRecord(form);if(form.id==='loginForm')await sendLogin(form);if(form.id==='profileForm')await saveProfile(form);if(form.id==='versionForm')await createVersion(form);
});
document.addEventListener('keydown',ev=>{if(ev.key==='Escape')closeModal();});
document.addEventListener('click',ev=>{if(ev.target.id==='overlay')closeModal();});
init();
