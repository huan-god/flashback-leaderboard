import {compareRecord} from './logic.mjs';

const config = window.FLASHBACK_CONFIG || {};
const hasBackendConfig = Boolean(config.supabaseUrl && config.supabaseAnonKey);
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function relatedUrl(value) {
  const trimmed=String(value??'').trim();
  if(!/^https?:\/\//i.test(trimmed) || /[\s\\]/u.test(trimmed))return null;
  try {
    const url=new URL(trimmed);
    return url.hostname && !url.username && !url.password && url.href.length<=2048 ? url.href : null;
  } catch {
    return null;
  }
}
function relatedLink(value, showHost=false) {
  const url=relatedUrl(value);
  if(!url)return '';
  const label=showHost ? new URL(url).hostname : '相关链接';
  return `<div class="smaller"><a class="text-button" href="${esc(url)}" target="_blank" rel="noopener noreferrer ugc">${esc(label)} ↗</a></div>`;
}
const dateLabel = v => {try{return new Date(v).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});}catch{return '—';}};
const uid = () => crypto.randomUUID?.() || String(Date.now())+'_'+Math.random().toString(36).slice(2);
let sb = null;
let toastTimer = 0;
const state = {page:'leaderboard',versions:[],stages:[],records:[],players:[],versionId:'',stageId:'',group:'zero',user:null,profile:null,isAdmin:false,connected:false,notice:''};

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
  state.stages=stages;
  state.records=records;
  state.players=players.sort((a,b)=>b.historical_count-a.historical_count || b.current_count-a.current_count || a.display_name.localeCompare(b.display_name,'zh-CN') || a.player_id.localeCompare(b.player_id));
}
async function refresh() {
  if(hasBackendConfig) {
    try {
      await getSb();
      await loadRemote();
      state.connected=true;
      state.notice='';
    } catch {
      state.connected=false;
      state.notice='暂时无法连接榜单服务，请稍后刷新。';
    }
  }
  if(!state.versions.some(v=>v.id===state.versionId))state.versionId=state.versions[0]?.id||'';
  const stages=state.stages.filter(x=>x.version_id===state.versionId).sort((a,b)=>a.stage_no-b.stage_no);
  if(!stages.some(x=>x.id===state.stageId))state.stageId=stages[0]?.id||'';
  render();
  return state.connected;
}

function canSubmit(){return state.connected && state.stages.length>0;}
function metric(){
  $('#metricRecords').textContent=state.records.length;
  $('#metricPlayers').textContent=state.players.filter(x=>x.historical_count||x.current_count).length;
  $('#metricVersions').textContent=state.versions.length;
  $('#connectionTag').textContent=canSubmit()?'投稿开放':(hasBackendConfig&&!state.connected?'无法连接':'投稿暂未开放');
  $('#submitButton').disabled=!canSubmit();
  $('#heroSubmit').disabled=!canSubmit();
  $('#userButton').hidden=!state.connected;
  $('#userButton').textContent=state.isAdmin?'管理员账号':(state.profile?.display_name || (state.user?'设置昵称':'管理员登录'));
  const existing=$('#adminButton');if(existing)existing.remove();
  if(state.connected&&state.isAdmin){const btn=document.createElement('button');btn.id='adminButton';btn.className='ghost-button';btn.textContent='管理后台';$('#userButton').before(btn);}
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
    <div class="board-wrap"><aside class="filter-panel"><div class="filter-title">选择挑战 <span class="filter-small">STAGE SELECT</span></div><div class="filter-divider"></div><div class="filter-label">01 / 关卡</div>
    <div class="stage-options">${stages.map(x=>`<button class="stage-button ${state.stageId===x.id?'active':''}" data-action="stage" data-id="${esc(x.id)}"><span class="stage-num">0${x.stage_no}</span><span class="stage-name">${esc(x.name)}</span><span class="chevron">›</span></button>`).join('')||'<p class="smaller">暂无关卡</p>'}</div>
    <div class="filter-divider"></div><div class="filter-label">02 / 塑造限制</div><div class="group-switch"><button data-action="group" data-group="zero" class="${state.group==='zero'?'active':''}">全0塑造</button><button data-action="group" data-group="max" class="${state.group==='max'?'active':''}">全满塑造</button></div>
    <div class="filter-hint">✦ 每个版本有三个关卡。<br />✦ 仅收录 <strong>0—6 回合</strong> 通关。<br />✦ 不同阵容独立保留最佳纪录。<br />✦ 分数并列按提交时间优先。</div></aside>
    <div class="board-panel"><div class="board-head"><div><h3>${esc(st?.name||'暂无关卡')} <span style="font-size:13px;color:var(--gold)">/ ${state.group==='zero'?'全0塑造':'全满塑造'}</span></h3><p>${esc(ver?.label||'尚未配置版本')} · 共 ${rows.length} 个当前纪录</p></div><span class="chip">✧ 已审核通过</span></div>
    ${rows.length?`<div class="table-scroll"><table class="board-table"><thead><tr><th>排序</th><th>纪录保持者</th><th>主 C / 队伍</th><th>回合</th><th>首次上传</th></tr></thead><tbody>${rows.map((r,i)=>`<tr><td><span class="rank-icon ${i===0?'first':''}">${String(i+1).padStart(2,'0')}</span></td><td><span class="player-name">${esc(r.display_name)}</span><div class="smaller">唯一纪录保持者</div></td><td><div style="font-size:12px;color:var(--gold);margin-bottom:6px">主C · ${esc(r.carry_name)}</div><div class="team-pills">${r.team.map(n=>`<span class="team-pill">${esc(n)}</span>`).join('')}</div>${relatedLink(r.related_url)}</td><td><span class="rounds">${r.rounds}<small>回合</small></span></td><td><span class="smaller">${dateLabel(r.created_at)}</span></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty"><div class="symbol">✧</div><h3>当前榜单为空</h3><p>${state.connected?'尚无通过审核的成绩。':'投稿服务暂未开放。'} </p>${canSubmit()?'<button class="gold-button" data-action="submit">投稿成绩 →</button>':''}</div>`}
    <div class="board-foot"><span>以服务器上传时间为准 · 审核后自动更新榜单</span><button class="text-button" data-action="refresh">刷新榜单 ↻</button></div></div></div>
    <div class="two-cards"><div class="info-card"><div class="info-number">01</div><h3>一队 · 一纪录</h3><p>相同关卡、塑造组和完整阵容，仅保留回合最少的一条记录。主C单独显示，但不改变队伍归属。</p></div><div class="info-card"><div class="info-number">02</div><h3>荣耀从未消失</h3><p>被超越的纪录不再公开占榜，曾经获得的有效历史荣誉仍计入玩家累计上榜次数。</p></div></div></section>`;
}
function renderPlayers(){
  return `<section class="content-section"><div class="section-eyebrow">HALL OF FAME</div><div class="section-header"><div><h2>玩家荣誉殿堂</h2><p class="section-subtitle">跨版本累计历史上榜次数排名，同分优先比较当前持榜数</p></div><span class="chip">ALL-TIME HONORS</span></div>
   <div class="board-panel"><div class="table-scroll"><table class="players-table"><thead><tr><th>名次</th><th>玩家</th><th>历史上榜</th><th>当前持榜</th></tr></thead><tbody>
   ${state.players.length?state.players.map((p,i)=>`<tr><td><span class="rank-icon ${i===0?'first':''}">${String(i+1).padStart(2,'0')}</span></td><td><span class="player-name">${esc(p.display_name)}</span></td><td><span class="rounds">${p.historical_count}<small>次</small></span></td><td>${p.current_count} 个</td></tr>`).join(''):`<tr><td colspan="4"><div class="empty"><div class="symbol">♙</div><p>尚无上榜玩家</p></div></td></tr>`}
   </tbody></table></div></div><div class="two-cards"><div class="info-card"><div class="info-number">∞</div><h3>历史上榜次数</h3><p>曾经成为某关卡、塑造组、具体阵容的纪录保持者，即记一项历史荣誉。重复夺回同一项不重复累计。</p></div><div class="info-card"><div class="info-number">✦</div><h3>当前持榜数量</h3><p>目前仍保持最佳回合的阵容数量，实时根据已经审核通过的成绩重新计算。</p></div></div></section>`;
}
function renderRules(){
  const items=[['01','三个关卡','每个游戏版本独立设置三个关卡，纪录不会跨版本或关卡比较。'],['02','两种塑造','全0塑造与全满塑造分榜比较。队伍内所有参战角色必须符合所选塑造组规则。'],['03','零至六回合','只能提交 0、1、2、3、4、5、6 回合的有效成绩，上传通关截图供管理员核验。'],['04','阵容识别','提交主C与实际上场的完整队伍。相同角色组合视为同队，与角色填写顺序无关；主C并不拆分榜单。'],['05','唯一保持者','同队仅有回合最少者上榜；同回合数先提交者获胜。以数据库记录的提交时间为准，不受审核顺序影响。'],['06','历史荣誉','曾夺得同一「版本／关卡／塑造／队伍」最佳纪录，历史次数最多计一次，重夺不叠加。被取消的无效成绩不计荣誉。']];
  return `<section class="content-section"><div class="section-eyebrow">RULES & FAIR PLAY</div><div class="section-header"><div><h2>排行榜规则与投稿须知</h2><p class="section-subtitle">只让真实、可验证的成绩留下名字</p></div></div><div class="rules-list">${items.map(i=>`<div class="rules-card"><div class="num">${i[0]}</div><h3>${i[1]}</h3><p>${i[2]}</p></div>`).join('')}</div><div class="notice" style="margin-top:22px"><strong>玩法参考：</strong>「焦点闪回」是《重返未来：1999》从 3.6 版本开始推出的周期挑战玩法，具体关卡、可用增幅与机制以游戏和 Wiki 对应期次为准。<a class="wiki-link" href="https://res1999.huijiwiki.com/wiki/%E7%84%A6%E7%82%B9%E9%97%AA%E5%9B%9E" target="_blank" rel="noopener noreferrer">查阅重返未来1999中文 Wiki · 焦点闪回 ↗</a><br>本站的 0—6 回合收录上限、全0／全满塑造分组和唯一纪录规则是<strong>社区排行榜自定义规则</strong>，并非游戏官方排名规定。</div></section>`;
}
function toast(msg){const el=$('#toast');el.textContent=msg;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),3200);}
function openModal(html,wide=false){$('#modalRoot').innerHTML=`<div class="overlay" id="overlay"><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true"><button class="modal-close" data-action="close" aria-label="关闭">×</button>${html}</section></div>`;}
function closeModal(){$('#modalRoot').innerHTML='';}
function modalOptions(){return state.versions.map(v=>`<option value="${esc(v.id)}" ${v.id===state.versionId?'selected':''}>${esc(v.label)}</option>`).join('');}
function stageOptions(vid){return state.stages.filter(s=>s.version_id===vid).sort((a,b)=>a.stage_no-b.stage_no).map(s=>`<option value="${esc(s.id)}" ${s.id===state.stageId?'selected':''}>${esc(s.name)}</option>`).join('');}
let startingGuest=false;

async function openSubmission(){
  if(!canSubmit() || startingGuest)return;
  if(!state.user){
    showGuestForm();
    return;
  }
  if(!state.profile){openProfile(true);return;}
  openModal(`<div class="modal-eyebrow">SUBMIT A NEW RECORD</div><h2>提交挑战成绩</h2><p class="modal-subtitle">填写完整队伍与回合数，管理员核验后才会进入公开榜单。</p>
   <form id="submissionForm"><div class="form-grid"><div class="field"><label for="nickname">玩家昵称 *</label><input id="nickname" name="nickname" maxlength="24" required value="${esc(state.profile?.display_name||'')}" readonly/></div><div class="field"><label for="fVersion">游戏版本</label><select id="fVersion" name="version">${modalOptions()}</select></div></div>
   <div class="form-grid"><div class="field"><label for="fStage">挑战关卡</label><select id="fStage" name="stage">${stageOptions(state.versionId)}</select></div><div class="field"><label for="fGroup">塑造分组</label><select id="fGroup" name="group"><option value="zero" ${state.group==='zero'?'selected':''}>全0塑造</option><option value="max" ${state.group==='max'?'selected':''}>全满塑造</option></select></div></div>
   <div class="form-grid"><div class="field"><label for="carry">主C角色 *</label><input id="carry" name="carry" required maxlength="40" placeholder="主输出角色名称"/></div><div class="field"><label for="rounds">通关回合 *</label><select id="rounds" name="rounds">${Array.from({length:7},(_,n)=>`<option value="${n}">${n} 回合</option>`).join('')}</select></div></div>
   <div class="field"><label for="team">完整配队 *</label><textarea id="team" name="team" required placeholder="填写实际上场的角色名称"></textarea><span class="field-hint">按实际出战填写全部角色，用顿号 / 逗号分开，1—4 名，不按填写顺序区分队伍。</span></div>
   <div class="field"><label for="proof">通关截图 *</label><input id="proof" name="proof" type="file" accept="image/png,image/jpeg,image/webp" required/><span class="field-hint">支持 PNG / JPG / WebP，单张不超过 5 MB。图片仅投稿者和管理员可见。</span></div>
   <div class="field"><label for="relatedUrl">相关链接（选填）</label><input id="relatedUrl" name="relatedUrl" type="url" maxlength="2048" placeholder="https://" aria-describedby="relatedUrlHint"/><span id="relatedUrlHint" class="field-hint">可填写通关视频或攻略。成绩上榜后，链接会随该纪录公开。</span></div>
   <div class="form-note">按服务器记录的提交时间处理同回合成绩。</div>
   <div class="form-actions"><button type="button" class="outline-button" data-action="close">取消</button><button class="gold-button" id="submissionConfirm" type="submit">确认提交 →</button></div></form>`);
}
function showGuestForm(){
  openModal('<h2>投稿昵称</h2><p class="modal-subtitle">昵称将公开显示。同一浏览器会保留你的投稿身份。</p><form id="guestForm"><div class="field"><label for="guestName">展示昵称</label><input id="guestName" name="name" required minlength="2" maxlength="24" autocomplete="nickname"></div><div class="form-actions"><button type="button" class="outline-button" data-action="close">取消</button><button type="submit" class="gold-button">继续投稿</button></div></form>');
}
function openProfile(forSubmission=false){
  openModal('<h2>玩家资料</h2><form id="profileForm" data-for-submission="'+forSubmission+'"><div class="field"><label for="profileName">展示昵称</label><input name="name" id="profileName" maxlength="24" minlength="2" required value="'+esc(state.profile?.display_name||'')+'"/></div><div class="form-actions">'+(state.user?.is_anonymous?'<button type="button" class="outline-button" data-action="admin-login">管理员登录</button>':'<button type="button" class="outline-button" data-action="logout">退出登录</button>')+'<button type="submit" class="gold-button">保存昵称</button></div></form>');
}
function openLogin(){
  if(!state.connected)return;
  openModal('<h2>管理员登录</h2><p class="modal-subtitle">请使用站长授权的邮箱。</p><form id="loginForm"><div class="field"><label for="email">电子邮箱</label><input id="email" name="email" type="email" required autocomplete="email"></div><div class="form-note">收到邮件后，请在同一浏览器中打开一次性登录链接。</div><div class="form-actions"><button type="button" class="outline-button" data-action="close">取消</button><button type="submit" class="gold-button">发送登录邮件</button></div></form>');
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
  const enteredUrl=String(fd.get('relatedUrl')??'').trim();
  const related_url=relatedUrl(enteredUrl);
  if(enteredUrl && !related_url)throw Error('请输入有效的 HTTP 或 HTTPS 相关链接。');
  return {nickname,carry,team,rounds,file,related_url,stage_id:String(fd.get('stage')),group_code:String(fd.get('group'))};
}
function decodeProof(blob) {
  return new Promise((resolve,reject)=>{
    if(!blob?.size){reject(Error('截图文件为空。'));return;}
    const reader=new FileReader();
    reader.onerror=()=>reject(Error('截图文件读取失败。'));
    reader.onload=()=>{
      const image=new Image();
      image.onload=()=>resolve(image);
      image.onerror=()=>reject(Error('截图无法解码，请检查原图是否能正常打开。'));
      image.src=reader.result;
    };
    reader.readAsDataURL(blob);
  });
}
async function submitRecord(form){
  const button=$('#submissionConfirm');
  if(!canSubmit() || !state.user || !state.profile || button.disabled)return;
  button.disabled=true;
  button.textContent='正在提交…';
  try {
    const v=getSubmission(form);
    await decodeProof(v.file);
    const ext={ 'image/png':'png', 'image/webp':'webp', 'image/jpeg':'jpg' }[v.file.type];
    const path=state.user.id+'/'+uid()+'.'+ext;
    const {error:uploadError}=await sb.storage.from('proofs').upload(path,v.file,{contentType:v.file.type,upsert:false});
    if(uploadError)throw uploadError;
    const {error}=await sb.from('submissions').insert({player_id:state.user.id,stage_id:v.stage_id,group_code:v.group_code,team:v.team,carry_name:v.carry,rounds:v.rounds,evidence_path:path,related_url:v.related_url});
    if(error)throw error;
    closeModal();await refresh();toast('已提交，当前状态：等待管理员审核。');
  }catch(e){toast(`投稿失败：${e.message||e}`);button.disabled=false;button.textContent='确认提交 →';}
}
async function loadModerationRows(tab){
  const {data,error}=await sb.from('submissions')
    .select('id,player_id,stage_id,group_code,team,carry_name,rounds,created_at,status,related_url,review_note,profiles(display_name)')
    .eq('status',tab).order('created_at',{ascending:false}).limit(250);
  if(error)throw error;
  return (data||[]).map(x=>({...x,display_name:x.profiles?.display_name||'未知玩家'}));
}
async function openAdmin(tab='pending'){
  if(!state.isAdmin){toast('仅管理员可以访问管理后台。');return;}
  if(!['pending','approved','removed'].includes(tab))tab='pending';
  const labels={pending:'待审核',approved:'已通过',removed:'已移除'};
  openModal(`<div class="modal-eyebrow">MODERATION CENTER · ADMIN ONLY</div><h2>排行榜管理后台</h2><p class="modal-subtitle">管理员可审核、拒绝或撤销已通过的成绩。 移除不物理删除，保留审核原因和证据。</p>
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
        ${relatedLink(r.related_url,true)}
        <div id="proof-${esc(r.id)}" class="minor" role="status" style="margin-top:8px"></div><div class="review-actions"><button class="outline-button" data-action="preview" data-id="${esc(r.id)}">查看截图</button>${buttons}</div></article>`;
    }).join(''):`<div class="empty"><div class="symbol">✓</div><h3>${labels[tab]}列表为空</h3><p>可切换其他状态查看记录。</p></div>`;
  }catch(e){const el=$('#adminList');if(el)el.innerHTML=`<div class="notice error">读取后台失败：${esc(e.message)}</div>`;}
}
async function review(id,approved){
  if(!state.isAdmin)return;
  if(!approved&&!window.confirm('确定拒绝这条投稿吗？'))return;
  try {
    const {error}=await sb.rpc('review_submission',{p_submission_id:id,p_decision:approved?'approved':'rejected',p_note:''});
    if(error)throw error;
    await refresh();await openAdmin('pending');toast(approved?'审核通过，排行榜已更新。':'投稿已拒绝。');
  }catch(e){toast(`审核失败：${e.message||e}`);}
}
async function removeRecord(id){
  if(!state.isAdmin)return;
  const reason=window.prompt('请输入移除原因（例如：截图无效、阵容不符），至少2个字。\n这条成绩将从榜单中撤下，并重新计算纪录和历史荣誉。');
  if(reason===null)return;
  const note=reason.trim();
  if(note.length<2||note.length>200){toast('移除原因必须为 2—200 个字符。');return;}
  if(!window.confirm('确定移除这条已通过的成绩吗？操作会记录原因并影响排行榜。'))return;
  try{
    const {error}=await sb.rpc('remove_submission',{p_submission_id:id,p_reason:note});
    if(error)throw error;
    await refresh();await openAdmin('approved');toast('成绩已移除，排行榜与玩家荣誉已重新计算。');
  }catch(e){toast(`移除失败：${e.message||e}`);}
}
async function preview(id,button){
  const root=document.getElementById(`proof-${id}`);
  if(!state.isAdmin||!root||button.disabled)return;
  button.disabled=true;
  root.textContent='正在读取截图…';
  try{
    const {data,error}=await sb.from('submissions').select('evidence_path').eq('id',id).single();
    if(error)throw error;
    const {data:blob,error:downloadError}=await sb.storage.from('proofs').download(data.evidence_path);
    if(downloadError)throw downloadError;
    const image=await decodeProof(blob);
    image.alt='投稿成绩截图';
    image.style.cssText='max-width:100%;max-height:410px;border:1px solid #6e5d52;object-fit:contain';
    if(root.isConnected)root.replaceChildren(image);
  }catch(e){
    if(root.isConnected)root.textContent=`查看失败：${e.message||e}`;
  }finally{
    button.disabled=false;
  }
}
function openVersion(){
  if(!state.isAdmin)return;
  openModal(`<div class="modal-eyebrow">NEW GAME VERSION</div><h2>新建游戏版本</h2><p class="modal-subtitle">新增版本后自动创建恰好三个关卡。</p><form id="versionForm"><div class="form-grid"><div class="field"><label>版本代号（不能重复）</label><input name="code" maxlength="30" placeholder="填写游戏版本代号" required/></div><div class="field"><label>展示名称</label><input name="label" maxlength="80" placeholder="填写游戏版本展示名称" required/></div></div>${[1,2,3].map(i=>`<div class="field"><label>第 ${i} 关名称</label><input name="stage${i}" maxlength="80" placeholder="第${i}关" required/></div>`).join('')}<div class="form-actions"><button type="button" class="outline-button" data-action="admin">返回后台</button><button type="submit" class="gold-button">创建版本</button></div></form>`);
}
async function createVersion(form){
  const fd=new FormData(form);const code=String(fd.get('code')||'').trim(),label=String(fd.get('label')||'').trim();const names=[1,2,3].map(i=>String(fd.get('stage'+i)||'').trim());
  if(!code||!label||names.some(x=>!x))return toast('所有版本与关卡字段都必须填写。');
  try {
    const {data:vid,error}=await sb.rpc('create_version',{p_code:code,p_label:label,p_stage_names:names});
    if(error)throw error;
    state.versionId=vid;state.stageId='';state.page='leaderboard';closeModal();await refresh();toast(`已新建版本：${label}`);
  }catch(e){toast(`新建失败：${e.message||e}`);}
}
async function sendLogin(form){
  const email=String(new FormData(form).get('email')||'').trim();
  try{const {error}=await sb.auth.signInWithOtp({email,options:{emailRedirectTo:new URL('./',window.location.href).href}});if(error)throw error;closeModal();toast('登录链接已发送，请检查邮箱。');}
  catch(e){toast(`发送失败：${e.message}`);}
}
async function updateProfile(name,user){
  const {error}=await sb.from('profiles').upsert({id:user.id,display_name:name},{onConflict:'id'});
  if(error)throw error;
  state.profile={id:user.id,display_name:name};
}
async function startGuest(form){
  if(startingGuest || !canSubmit())return;
  const name=String(new FormData(form).get('name')||'').trim();
  if(name.length<2||name.length>24)return toast('昵称需在 2—24 个字符之间。');
  const button=form.querySelector('[type=submit]');
  startingGuest=true;
  button.disabled=true;
  try {
    let user=state.user;
    if(!user){
      const {data,error}=await sb.auth.signInAnonymously();
      if(error)throw error;
      user=data.user;
    }
    state.user=user;
    await updateProfile(name,user);
    await syncAuth();
    startingGuest=false;
    await openSubmission();
  } catch(e){
    toast('无法开始投稿：'+(e.message||e));
  } finally {
    startingGuest=false;
    button.disabled=false;
  }
}
async function saveProfile(form){
  const name=String(new FormData(form).get('name')||'').trim();
  if(!state.user || name.length<2||name.length>24)return toast('昵称需在 2—24 个字符之间。');
  try{
    await updateProfile(name,state.user);
    closeModal();render();
    if(form.dataset.forSubmission==='true')await openSubmission();
    else toast('昵称已保存。');
  } catch(e){toast('保存失败：'+e.message);}
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
let authSubscribed=false;

async function init(){
  if(!await refresh() || authSubscribed)return;
  authSubscribed=true;
  try { await syncAuth(); }
  catch { toast('暂时无法验证登录状态。'); }
  sb.auth.onAuthStateChange(()=>{setTimeout(()=>syncAuth().catch(()=>toast('暂时无法验证登录状态。')),0);});
}

// 采用事件委托，确保每次局部重绘后操作依然有效。
document.addEventListener('click',async ev=>{
  const el=ev.target.closest('button');if(!el)return;
  const page=el.dataset.page,action=el.dataset.action;
  if(page){state.page=page;render();$('#content').scrollIntoView({behavior:'smooth',block:'start'});return;}
  if(el.id==='submitButton'||el.id==='heroSubmit'||action==='submit'){await openSubmission();return;}
  if(el.id==='userButton'){if(state.user)openProfile();else openLogin();return;}
  if(action==='admin-login'){openLogin();return;}
  if(el.id==='adminButton'||action==='admin'){await openAdmin();return;}
  if(action==='moderation-tab'){await openAdmin(el.dataset.tab);return;}
  if(action==='remove-record'){await removeRecord(el.dataset.id);return;}
  if(action==='close'){closeModal();return;}
  if(action==='stage'){state.stageId=el.dataset.id;render();return;}
  if(action==='group'){state.group=el.dataset.group;render();return;}
  if(action==='refresh'){await init();if(state.connected)toast('榜单已更新。');return;}
  if(action==='approve'||action==='reject'){await review(el.dataset.id,action==='approve');return;}
  if(action==='preview'){await preview(el.dataset.id,el);return;}
  if(action==='new-version'){openVersion();return;}
  if(action==='logout'){await sb.auth.signOut();closeModal();await syncAuth();toast('已退出登录。');return;}
});
document.addEventListener('change',ev=>{
  if(ev.target.id==='versionSelect'){state.versionId=ev.target.value;state.stageId='';render();}
  if(ev.target.id==='fVersion'){const el=$('#fStage');if(el)el.innerHTML=stageOptions(ev.target.value);}
});
document.addEventListener('submit',async ev=>{
  const form=ev.target;if(!['submissionForm','guestForm','loginForm','profileForm','versionForm'].includes(form.id))return;
  ev.preventDefault();if(form.id==='submissionForm')await submitRecord(form);if(form.id==='guestForm')await startGuest(form);if(form.id==='loginForm')await sendLogin(form);if(form.id==='profileForm')await saveProfile(form);if(form.id==='versionForm')await createVersion(form);
});
document.addEventListener('keydown',ev=>{if(ev.key==='Escape')closeModal();});
document.addEventListener('click',ev=>{if(ev.target.id==='overlay')closeModal();});
init();
