import {compareRecord,validateLineup} from './logic.mjs?v=lineup-2';
import {
  adminContact, askRejectionReason, contactField, mountSubmissionProgress,
  bindModerationFilters, filterModerationRows, moderationFilterFields, moderationPager, moderationPageSize
} from './submission-progress.js?v=1';

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
const state = {page:'leaderboard',versions:[],stages:[],records:[],players:[],archives:[],carries:[],
  carryMetric:'appearance_count',carryScope:'period',carryFilter:'',resonanceOnly:false,versionId:'',stageId:'',group:'zero',user:null,profile:null,isAdmin:false,connected:false,notice:''};

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
async function queryRanking(table, columns){
  const rows=[];
  for(let from=0;;from+=500){
    let request=sb.from(table).select('*');
    for(const column of columns)request=request.order(column);
    const {data,error}=await request.range(from,from+499);
    if(error)throw error;
    rows.push(...data);
    if(data.length<500)return rows;
  }
}
async function loadRemote() {
  const [versions,stages,records,players,archives,carries]=await Promise.all([
    query('versions','id,code,label,created_at'),
    query('stages','id,version_id,stage_no,name,challenge_id'),
    query('leaderboard_records'),
    queryRanking('flashback_player_ranking_by_group',['group_code','player_id']),
    query('historical_records','id,stage_id,group_code,display_order,carry_names,lineup_label,credited_player'),
    queryRanking('flashback_carry_ranking_by_group',['group_code','version_id','carry_name'])
  ]);
  state.versions=versions.sort((a,b)=>b.code.localeCompare(a.code,'zh-CN',{numeric:true})||new Date(b.created_at)-new Date(a.created_at));
  state.stages=stages;
  state.records=records;
  state.archives=archives;
  state.carries=carries;
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
  $('#metricPlayers').textContent=new Set(state.players.map(row=>row.player_id)).size;
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
  const pages={leaderboard:renderLeaderboard,carries:renderCarries,players:renderPlayers,rules:renderRules};
  if(state.page==='submissions'){
    $('#content').insertAdjacentHTML('beforeend','<section class="content-section" id="submissionProgress"></section>');
    mountSubmissionProgress($('#submissionProgress'),{
      client:sb,ownerId:state.user?.id,table:'submissions',columns:'stage_id,group_code,team,carry_name,rounds,resonance_ten',
      describe(row){
        const stage=state.stages.find(item=>item.id===row.stage_id);
        const version=state.versions.find(item=>item.id===stage?.version_id);
        const details=[version?.label,row.group_code==='zero'?'全0塑造':'全满塑造',
          row.resonance_ten?'共鸣10':'',`主 C · ${row.carry_name}`,`${row.rounds} 回合`];
        return {title:stage?.name||'已隐藏关卡',summary:details.filter(Boolean).join(' · ')};
      }
    });
    return;
  }
  $('#content').insertAdjacentHTML('beforeend',pages[state.page]());
}
function standardStages(versionId){
  return state.stages.filter(stage=>stage.version_id===versionId).sort((a,b)=>a.stage_no-b.stage_no);
}
function challengeOccurrences(stage){
  return state.stages.filter(other=>other.challenge_id===stage.challenge_id).length;
}
function splitCarryNames(value){
  return String(value??'').split(/[/／、]/).map(name=>name.trim());
}
function carryKey(name){
  return name.normalize('NFKC').trim().toLowerCase();
}
const resonanceBadge='<span class="resonance-tag">✦ 全0塑 · 共鸣10</span>';
function resonanceChoice(group, selected=false){
  const zero=group==='zero';
  return `<label class="resonance-choice"${zero?'':' hidden'}><input name="resonanceTen" type="checkbox"
    ${selected&&zero?'checked':''} ${zero?'':'disabled'}> 全队 0 塑造、共鸣 10</label>`;
}
function groupSwitch(){
  return `<div class="group-switch" role="group" aria-label="塑造分组">
    ${[['zero','全0塑造'],['max','全满塑造']].map(([key,label])=>
      `<button data-action="group" data-group="${key}" class="${state.group===key?'active':''}" aria-pressed="${state.group===key}">${label}</button>`).join('')}
  </div>`;
}
function recordsArchive(rows){
  if(!rows.length)return '';
  return `<div class="board-foot"><span>历史档案 · 全 0 塑 · 6 回合内满星</span></div>
  <div class="table-scroll"><table class="board-table">
    <thead><tr><th>主 C</th><th>原表配队</th><th>攻略者</th><th>成绩</th></tr></thead>
    <tbody>${rows.map(row=>`<tr><td>${row.carry_names.map(esc).join('／')}</td>
      <td>${esc(row.lineup_label)}</td><td>${esc(row.credited_player)}</td><td>≤ 6 回合</td></tr>`).join('')}</tbody>
  </table></div><div class="board-foot"><span>档案沿用原表简称、替代位与行序。准确回合未收录。</span></div>`;
}
function renderLeaderboard(){
  const ver=state.versions.find(x=>x.id===state.versionId);
  const stages=standardStages(state.versionId);
  const st=stages.find(x=>x.id===state.stageId);
  const matchesStage=row=>row.stage_id===state.stageId&&row.group_code===state.group;
  const ranked=state.records.filter(matchesStage).sort(compareRecord).map((record,index)=>({
    ...record,rank:index+1,carryNames:splitCarryNames(record.carry_name)
  }));
  const historical=state.archives.filter(matchesStage).sort((a,b)=>a.display_order-b.display_order);
  const names=new Map();
  for(const name of [...ranked.flatMap(row=>row.carryNames),...historical.flatMap(row=>row.carry_names)]){
    const key=carryKey(name);
    if(key&&!names.has(key))names.set(key,name);
  }
  if(!names.has(state.carryFilter))state.carryFilter='';
  const matchesCarry=carryNames=>!state.carryFilter||carryNames.some(name=>carryKey(name)===state.carryFilter);
  const resonanceOnly=state.group==='zero'&&state.resonanceOnly;
  const rows=ranked.filter(row=>matchesCarry(row.carryNames)&&(!resonanceOnly||row.resonance_ten));
  const archives=resonanceOnly?[]:historical.filter(row=>matchesCarry(row.carry_names));
  const carryOptions=[...names].sort((a,b)=>a[1].localeCompare(b[1],'zh-CN',{numeric:true})).map(([key,name])=>
    `<option value="${esc(key)}" ${key===state.carryFilter?'selected':''}>${esc(name)}</option>`).join('');
  const options=state.versions.map(x=>`<option value="${esc(x.id)}" ${state.versionId===x.id?'selected':''}>${esc(x.label)}</option>`).join('');
  return `<section class="content-section"><div class="section-eyebrow">LATEST RECORDS</div>
    <div class="section-header"><div><h2>焦点闪回 · 排行榜</h2><p class="section-subtitle">同阵容少人优先 · 人数相同则比回合</p></div><select id="versionSelect" class="version-select" aria-label="选择版本">${options}</select></div>
    <div class="board-wrap"><aside class="filter-panel"><div class="filter-title">选择挑战 <span class="filter-small">STAGE SELECT</span></div><div class="filter-divider"></div><div class="filter-label">01 / 关卡</div>
    <div class="stage-options">${stages.map(x=>`<button class="stage-button ${state.stageId===x.id?'active':''}" data-action="stage" data-id="${esc(x.id)}"><span class="stage-num">0${x.stage_no}</span><span class="stage-name">${esc(x.name)}${challengeOccurrences(x)>1?' · 重复关卡':''}</span><span class="chevron">›</span></button>`).join('')||'<p class="smaller">暂无关卡</p>'}</div>
    <div class="filter-divider"></div><div class="filter-label">02 / 塑造限制</div>${groupSwitch()}
    <div class="filter-divider"></div><label class="filter-label carry-filter-label" for="carryFilter">03 / 主 C 筛选</label>
    <select id="carryFilter" class="version-select carry-filter" ${names.size?'':'disabled'}><option value="">全部主 C</option>${carryOptions}</select>
    ${state.group==='zero'?`<div class="resonance-filter"><button class="resonance-tag" data-action="resonance-filter" aria-pressed="${resonanceOnly}">✦ 只看全0塑 · 共鸣10</button></div>`:''}
    <div class="filter-hint">✦ 每个版本有三个关卡。<br />✦ 仅收录 <strong>0—6 回合</strong> 通关。<br />✦ 四人队包含三人队的全部角色时，三人队胜出。<br />✦ 同阵容先比回合，并列按提交时间。</div></aside>
    <div class="board-panel"><div class="board-head"><div><h3>${esc(st?.name||'暂无关卡')} <span style="font-size:13px;color:var(--gold)">/ ${state.group==='zero'?'全0塑造':'全满塑造'}</span></h3><p>${esc(ver?.label||'尚未配置版本')} · ${archives.length&&!rows.length?`${archives.length} 条历史档案`:`${rows.length} 个当前纪录${archives.length?` · ${archives.length} 条历史档案`:''}`}</p></div><span class="chip">${archives.length&&!rows.length?'历史档案':'✧ 已审核通过'}</span></div>
    ${rows.length?`<div class="table-scroll"><table class="board-table"><thead><tr><th>排序</th><th>玩家</th><th>主 C / 队伍</th><th>回合</th><th>首次上传</th></tr></thead><tbody>${rows.map(r=>`<tr><td><span class="rank-icon ${r.rank===1?'first':''}">${String(r.rank).padStart(2,'0')}</span></td><td><span class="player-name">${esc(r.display_name)}</span></td><td><div style="font-size:12px;color:var(--gold);margin-bottom:6px">主C · ${esc(r.carry_name)}</div><div class="team-pills">${r.team.map(n=>`<span class="team-pill">${esc(n)}</span>`).join('')}</div>${r.resonance_ten?resonanceBadge:''}${relatedLink(r.related_url)}</td><td><span class="rounds">${r.rounds}<small>回合</small></span></td><td><span class="smaller">${dateLabel(r.created_at)}</span></td></tr>`).join('')}</tbody></table></div>`:archives.length?'':`<div class="empty"><div class="symbol">✧</div><h3>${resonanceOnly?'暂无全0塑 · 共鸣10纪录':'当前榜单为空'}</h3><p>${state.connected?(resonanceOnly?'可关闭标签筛选，查看其他已通过成绩。':'尚无通过审核的成绩。'):'投稿服务暂未开放。'} </p>${canSubmit()?'<button class="gold-button" data-action="submit">投稿成绩 →</button>':''}</div>`}
    ${recordsArchive(archives)}
    <div class="board-foot"><span>以服务器上传时间为准 · 审核后自动更新榜单</span><button class="text-button" data-action="refresh">刷新榜单 ↻</button></div></div></div>
    <div class="two-cards"><div class="info-card"><div class="info-number">01</div><h3>少人通关优先</h3><p>同一关卡、同一塑造组，少人队的角色都出现在多人队中时，少人队胜出。</p></div><div class="info-card"><div class="info-number">02</div><h3>历史上榜荣誉</h3><p>曾经获得的有效纪录仍计入玩家累计上榜次数。原始配队可在审核后台查看。</p></div></div></section>`;
}
function renderCarries(){
  const labels={appearance_count:'上榜总次数',challenge_count:'通关关卡数'};
  const scopes={period:'本期',all:'历史总计'};
  const versionId=state.carryScope==='period'?state.versionId:null;
  const version=state.versions.find(item=>item.id===versionId);
  const primary=state.carryMetric;
  const secondary=primary==='appearance_count'?'challenge_count':'appearance_count';
  const rows=state.carries.filter(row=>row.version_id===versionId&&row.group_code===state.group&&row[primary]>0).sort((a,b)=>
    b[primary]-a[primary]||b[secondary]-a[secondary]||a.carry_name.localeCompare(b.carry_name,'zh-CN'));
  return `<section class="content-section"><div class="section-header"><div>
    <h2>主 C 排行榜</h2><p class="section-subtitle">${esc(version?.label||'')} ${state.carryScope==='all'?'所有版本 · 关联后的重复关卡合并统计':''}</p>
    </div></div>
    <div class="ranking-division">${groupSwitch()}</div>
    <div class="moderation-tabs" role="group" aria-label="统计范围">${Object.entries(scopes).map(([key,label])=>`<button class="outline-button ${key===state.carryScope?'selected':''}" data-action="carry-scope" data-key="${key}" aria-pressed="${key===state.carryScope}">${label}</button>`).join('')}</div>
    <div class="moderation-tabs">${Object.entries(labels).map(([key,label])=>`<button class="outline-button ${key===primary?'selected':''}" data-action="carry-metric" data-key="${key}" aria-pressed="${key===primary}">${label}</button>`).join('')}</div>
    <div class="board-panel"><div class="table-scroll"><table class="players-table">
    <thead><tr><th>名次</th><th>主 C</th><th>${labels[primary]}</th><th>${labels[secondary]}</th></tr></thead>
    <tbody>${rows.map((row,i)=>`<tr><td>${i+1}</td><td>${esc(row.carry_name)}</td><td class="rounds">${row[primary]}</td><td>${row[secondary]}</td></tr>`).join('')||'<tr><td colspan="4">暂无可统计成绩</td></tr>'}</tbody>
    </table></div><div class="board-foot"><span>当前塑造组内，上榜按关卡与配队去重，通关按关卡去重。统计计入已审核成绩和历史档案。</span></div></div></section>`;
}
function renderPlayers(){
  const players=state.players.filter(row=>row.group_code===state.group);
  return `<section class="content-section"><div class="section-eyebrow">HALL OF FAME</div><div class="section-header"><div><h2>玩家荣誉殿堂</h2><p class="section-subtitle">跨版本累计历史上榜次数排名，同分优先比较当前持榜数</p></div><span class="chip">ALL-TIME HONORS</span></div>
   <div class="ranking-division">${groupSwitch()}</div>
   <div class="board-panel"><div class="table-scroll"><table class="players-table"><thead><tr><th>名次</th><th>玩家</th><th>历史上榜</th><th>当前持榜</th></tr></thead><tbody>
   ${players.length?players.map((p,i)=>`<tr><td><span class="rank-icon ${i===0?'first':''}">${String(i+1).padStart(2,'0')}</span></td><td><span class="player-name">${esc(p.display_name)}</span></td><td><span class="rounds">${p.historical_count}<small>次</small></span></td><td>${p.current_count} 个</td></tr>`).join(''):`<tr><td colspan="4"><div class="empty"><div class="symbol">♙</div><p>尚无上榜玩家</p></div></td></tr>`}
   </tbody></table></div></div><div class="two-cards"><div class="info-card"><div class="info-number">∞</div><h3>历史上榜次数</h3><p>曾经成为某关卡、塑造组、具体阵容的纪录保持者，即记一项历史荣誉。重复夺回同一项不重复累计。</p></div><div class="info-card"><div class="info-number">✦</div><h3>当前持榜数量</h3><p>目前仍保持最佳回合的阵容数量，实时根据已经审核通过的成绩重新计算。</p></div></div></section>`;
}
function renderRules(){
  const items=[['01','三个关卡','每个游戏版本独立设置三个关卡，纪录不会跨版本或关卡比较。'],['02','两种塑造','全0塑造与全满塑造分榜比较。队伍内所有参战角色必须符合所选塑造组规则。'],['03','零至六回合','只能提交 0、1、2、3、4、5、6 回合的有效成绩，上传通关截图供管理员核验。'],['04','填写阵容','每条成绩填写实际出战的 1—4 名角色，用顿号或逗号分隔。每个位置只能填一名角色。'],['05','胜负规则','阵容包含少人队的全部角色时，少人队直接胜出。完整阵容相同则先比回合，再比提交时间。'],['06','历史荣誉','曾夺得同一「版本／关卡／塑造／队伍」最佳纪录，历史次数最多计一次，重夺不叠加。被取消的无效成绩不计荣誉。']];
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
   <div class="form-grid"><div class="field"><label for="carry">主 C 角色 *</label><input id="carry" name="carry" required maxlength="170" placeholder="共同主 C 用 / 分隔"/></div><div class="field"><label for="rounds">通关回合 *</label><select id="rounds" name="rounds">${Array.from({length:7},(_,n)=>`<option value="${n}">${n} 回合</option>`).join('')}</select></div></div>
   ${resonanceChoice(state.group)}
   <div class="field"><label for="team">完整配队 *</label><textarea id="team" name="team" required placeholder="露西、哑谜、乌尔里希、小瑞安侬"></textarea><span class="field-hint">填写实际出战的 1—4 名角色，用顿号或逗号分隔，每个位置只填一名。</span></div>
   <div class="field"><label for="proof">通关截图 *</label><input id="proof" name="proof" type="file" accept="image/png,image/jpeg,image/webp" required/><span class="field-hint">支持 PNG / JPG / WebP，单张不超过 5 MB。图片仅投稿者和管理员可见。</span></div>
   <div class="field"><label for="relatedUrl">相关链接（选填）</label><input id="relatedUrl" name="relatedUrl" type="url" maxlength="2048" placeholder="https://" aria-describedby="relatedUrlHint"/><span id="relatedUrlHint" class="field-hint">可填写通关视频或攻略。成绩上榜后，链接会随该纪录公开。</span></div>
   <div class="form-note">按服务器记录的提交时间处理同回合成绩。</div>
   ${contactField}
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
function splitTeam(value){
  return String(value??'').split(/[、，,;；\n]+/).map(name=>name.trim()).filter(Boolean);
}
function getSubmission(form){
  const fd=new FormData(form);const team=splitTeam(fd.get('team'));
  const nickname=String(fd.get('nickname')||'').trim();
  const carries=splitCarryNames(fd.get('carry'));
  const rounds=Number(fd.get('rounds'));const file=fd.get('proof');
  if(nickname.length<2||nickname.length>24)throw Error('玩家昵称需要 2—24 个字符。');
  validateLineup(team);
  const norm=team.map(carryKey);
  const normalizedCarries=carries.map(carryKey);
  if(carries.length>4 || new Set(normalizedCarries).size!==carries.length || normalizedCarries.some(name=>!norm.includes(name))){
    throw Error('每位主 C 都需要单独写在固定出战位置中，且只能填一次。');
  }
  if(!Number.isInteger(rounds)||rounds<0||rounds>6)throw Error('回合数必须在 0—6 之间。');
  if(!file||!(file instanceof File)||file.size===0)throw Error('请上传通关截图。');
  if(file.size>5*1024*1024)throw Error('截图不能超过 5 MB。');
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('截图只支持 PNG、JPG 和 WebP。');
  if(!state.stages.some(s=>s.id===fd.get('stage')&&s.version_id===fd.get('version')))throw Error('版本与关卡不匹配。');
  const enteredUrl=String(fd.get('relatedUrl')??'').trim();
  const related_url=relatedUrl(enteredUrl);
  if(enteredUrl && !related_url)throw Error('请输入有效的 HTTP 或 HTTPS 相关链接。');
  const group_code=String(fd.get('group'));
  return {nickname,carry:carries.join('/'),team,rounds,file,related_url,stage_id:String(fd.get('stage')),group_code,
    resonance_ten:group_code==='zero'&&fd.has('resonanceTen'),contact:String(fd.get('contact')??'').trim()};
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
    const {error}=await sb.rpc('submit_flashback_result',{p_record:{
      stage_id:v.stage_id,group_code:v.group_code,team:v.team,carry_name:v.carry,rounds:v.rounds,
      evidence_path:path,related_url:v.related_url,resonance_ten:v.resonance_ten},p_contact:v.contact||null});
    if(error)throw error;
    closeModal();
    if(state.page==='submissions')render();
    toast('已提交，可在「我的投稿」查看审核进度。');
  }catch(e){toast(`投稿失败：${e.message||e}`);button.disabled=false;button.textContent='确认提交 →';}
}
const moderationFilters={tab:'',name:'',location:'',division:'',page:0};
async function loadModerationRows(tab){
  const base=sb.from('flashback_moderation_list').select('*').eq('status',tab);
  const {data,error}=await filterModerationRows(base,moderationFilters,'stage_id','group_code');
  if(error)throw error;
  return data||[];
}
const adminTabs={pending:'待审核',approved:'已通过',rejected:'已拒绝',removed:'已移除',historical:'历史档案'};
function adminHistory(openStage){
  return state.versions.flatMap(version=>standardStages(version.id).map(stage=>{
    const rows=state.archives.filter(row=>row.stage_id===stage.id).sort((a,b)=>a.display_order-b.display_order);
    if(!rows.length)return '';
    return `<details class="review-card" ${openStage===stage.id?'open':''}>
      <summary>${esc(version.label)} · ${esc(stage.name)} · ${rows.length} 条</summary>
      ${rows.map(row=>`<div class="review-card"><strong>${esc(row.credited_player)}</strong>
        <div class="review-meta">主 C ${row.carry_names.map(esc).join('／')} · ${esc(row.lineup_label)}</div>
        <button class="reject" data-action="archive-history" data-id="${esc(row.id)}" data-stage="${esc(stage.id)}">删除档案</button>
      </div>`).join('')}
    </details>`;
  })).join('')||'<p class="minor">暂无历史档案。</p>';
}
async function openAdmin(tab='pending',openStage=''){
  if(!state.isAdmin){toast('仅管理员可以访问管理后台。');return;}
  if(!Object.hasOwn(adminTabs,tab))tab='pending';
  if(tab!==moderationFilters.tab){moderationFilters.tab=tab;moderationFilters.page=0;}
  const stagesByVersion=state.versions.map(version=>[version.label,standardStages(version.id).map(stage=>[stage.id,stage.name])]);
  openModal(`<div class="modal-eyebrow">MODERATION CENTER · ADMIN ONLY</div><h2>排行榜管理后台</h2>
  <p class="modal-subtitle">移除可撤下已通过成绩并保留在「已移除」。删除会同时从后台列表和统计中隐藏。</p>
  <div class="moderation-tabs">${Object.entries(adminTabs).filter(([key])=>key!=='historical'||state.archives.length).map(([key,val])=>`<button class="outline-button ${key===tab?'selected':''}" data-action="moderation-tab" data-tab="${key}">${val}</button>`).join('')}</div>
  ${tab==='historical'?'':moderationFilterFields(moderationFilters,'关卡',stagesByVersion)}
  <div id="adminList"><div class="smaller">正在读取${adminTabs[tab]}…</div></div>
  <div class="form-actions" style="margin-top:20px"><button class="outline-button" data-action="manage-versions">版本管理</button><button class="outline-button" data-action="close">关闭</button></div>`,true);
  const host=$('#adminList');
  if(tab==='historical'){host.innerHTML=adminHistory(openStage);return;}
  let request=0;
  async function load(){
    const current=++request;
    host.textContent='正在读取投稿…';
    try{
      const result=await loadModerationRows(tab);
      if(!host.isConnected||current!==request)return;
      if(!result.length&&moderationFilters.page>0){moderationFilters.page-=1;return load();}
      const rows=result.slice(0,moderationPageSize);
      host.innerHTML=rows.length?`<div class="minor admin-count">本页 ${rows.length} 条${adminTabs[tab]}记录</div>`+rows.map(r=>{
        const stage=state.stages.find(x=>x.id===r.stage_id),version=state.versions.find(v=>v.id===stage?.version_id);
        const buttons=tab==='pending'?`<button class="approve" data-action="approve" data-id="${esc(r.id)}">✓ 审核通过</button><button class="reject" data-action="reject" data-id="${esc(r.id)}">× 拒绝成绩</button>`:
          tab==='approved'?`<button class="reject" data-action="remove-record" data-id="${esc(r.id)}">移除这条成绩</button>`:
          tab==='rejected'?`<button class="approve" data-action="reopen-result" data-id="${esc(r.id)}">退回待审核</button>`:'';
        return `<article class="review-card"><div class="review-top"><strong>${esc(r.display_name)} <span class="chip">${r.rounds} 回合</span></strong><span class="minor">${dateLabel(r.created_at)}</span></div>
          <div class="review-meta">${esc(version?.label||'未知版本')} · ${esc(stage?.name||'未知关卡')} · ${r.group_code==='zero'?'全0塑造':'全满塑造'}<br>主C：${esc(r.carry_name)}　队伍：${r.team.map(esc).join(' / ')}${r.status==='removed'?`<br><strong>撤销原因：</strong>${esc(r.review_note||'未记录')}`:''}</div>
          ${r.resonance_ten?resonanceBadge:''}${adminContact(r.contact)}
          ${r.status==='rejected'?`<p class="submission-reason"><strong>拒绝理由：</strong>${esc(r.review_note||'未记录')}</p>`:''}
          ${relatedLink(r.related_url,true)}
          <div id="proof-${esc(r.id)}" class="minor" role="status" style="margin-top:8px"></div>
          <div class="review-actions">${r.evidence_path?`<button class="outline-button" data-action="preview" data-id="${esc(r.id)}">查看截图</button>`:''}${buttons}
          <button class="outline-button" data-action="edit-score" data-id="${esc(r.id)}" data-tab="${esc(tab)}">编辑成绩</button>
          <button class="reject" data-action="archive-record" data-id="${esc(r.id)}" data-tab="${tab}">删除成绩</button></div></article>`;
      }).join('')+moderationPager(moderationFilters.page,result.length>moderationPageSize):
        '<div class="empty"><h3>暂无符合条件的投稿</h3></div>';
    }catch(e){if(host.isConnected&&current===request)host.innerHTML=`<div class="notice error">读取后台失败：${esc(e.message)}</div>`;}
  }
  bindModerationFilters($('.moderation-filter'),host,moderationFilters,load);
  await load();
}
async function reopenRejected(button){
  if(!state.isAdmin||button.disabled)return;
  button.disabled=true;
  try{
    const {error}=await sb.rpc('reopen_rejected_result',{p_board:'flashback',p_id:button.dataset.id});
    if(error)throw error;
    await openAdmin('pending');
    toast('已退回待审核，可以编辑后重新审核。');
  }catch(error){toast(`退回失败：${error.message}`);}
  finally{button.disabled=false;}
}
async function openScoreEditor(button){
  if(!state.isAdmin||button.disabled)return;
  button.disabled=true;
  const {id,tab}=button.dataset;
  try{
    const {data:record,error}=await sb.from('submissions')
      .select('stage_id,group_code,team,carry_name,rounds,credited_player,related_url,source_history_id,resonance_ten,profiles(display_name)')
      .eq('id',id).single();
    if(error)throw error;
    if(!button.isConnected)return;
    const stageOptions=state.versions.map(version=>`<optgroup label="${esc(version.label)}">${standardStages(version.id)
      .map(stage=>`<option value="${esc(stage.id)}" ${stage.id===record.stage_id?'selected':''}>${esc(stage.name)}</option>`).join('')}</optgroup>`).join('');
    openModal(`<h2>编辑成绩</h2>
      <form id="scoreForm" data-id="${esc(id)}" data-tab="${esc(tab)}">
        <div class="form-grid">
          <div class="field"><label for="editStage">版本及关卡</label><select id="editStage" name="stage" required>${stageOptions}</select></div>
          <div class="field"><label for="editGroup">塑造分组</label><select id="editGroup" name="group">
            <option value="zero" ${record.group_code==='zero'?'selected':''}>全0塑造</option>
            <option value="max" ${record.group_code==='max'?'selected':''}>全满塑造</option></select></div>
        </div>
        <div class="form-grid">
          <div class="field"><label for="editName">展示昵称</label><input id="editName" name="name" value="${esc(record.credited_player)}" placeholder="${esc(record.profiles?.display_name)}" minlength="2" maxlength="80" ${record.source_history_id?'required':''}/></div>
          <div class="field"><label for="editRounds">通关回合</label><select id="editRounds" name="rounds">${Array.from({length:7},(_,n)=>`<option value="${n}" ${record.rounds===n?'selected':''}>${n} 回合</option>`).join('')}</select></div>
        </div>
        ${resonanceChoice(record.group_code,record.resonance_ten)}
        <div class="field"><label for="editCarry">主 C</label><input id="editCarry" name="carry" value="${esc(record.carry_name)}" maxlength="170" required/><span class="field-hint">共同主 C 用 / 分隔。</span></div>
        <div class="field"><label for="editTeam">配队</label><textarea id="editTeam" name="team" maxlength="170" data-original-team="${esc(JSON.stringify(record.team))}" required>${esc(record.team.join('、'))}</textarea><span class="field-hint">修改配队时，填写 1—4 名角色，每个位置一名。</span></div>
        <div class="field"><label for="editUrl">相关链接</label><input id="editUrl" name="url" type="url" value="${esc(record.related_url)}" maxlength="2048"/></div>
        <div class="form-actions"><button type="button" class="outline-button" data-action="moderation-tab" data-tab="${esc(tab)}">返回</button>
          <button type="submit" class="gold-button">保存成绩</button></div>
      </form>`);
  }catch(e){toast(`读取成绩失败：${e.message||e}`);}
  finally{button.disabled=false;}
}
async function saveScore(form){
  if(!state.isAdmin)return;
  const button=form.querySelector('[type=submit]');
  if(button.disabled)return;
  const fields=new FormData(form);
  const url=String(fields.get('url')??'').trim();
  const link=relatedUrl(url);
  if(url&&!link)return toast('请输入有效的 HTTP 或 HTTPS 相关链接。');
  button.disabled=true;
  try{
    const teamInput=form.elements.namedItem('team');
    const teamChanged=teamInput.value!==teamInput.defaultValue;
    const team=teamChanged?splitTeam(teamInput.value):JSON.parse(teamInput.dataset.originalTeam);
    if(teamChanged)validateLineup(team);
    const {error}=await sb.rpc('edit_submission',{
      p_id:form.dataset.id,p_stage_id:fields.get('stage'),p_group:fields.get('group'),
      p_team:team,p_carry:splitCarryNames(fields.get('carry')).join('/'),
      p_rounds:Number(fields.get('rounds')),p_credited_player:fields.get('name'),p_related_url:link,
      p_resonance_ten:fields.get('group')==='zero'&&fields.has('resonanceTen')
    });
    if(error)throw error;
    await refresh();
    await openAdmin(form.dataset.tab);
    toast('成绩已保存，排行榜已更新。');
  }catch(e){toast(`保存成绩失败：${e.message||e}`);}
  finally{button.disabled=false;}
}
async function review(id,approved){
  if(!state.isAdmin)return;
  const reason=approved?'':askRejectionReason(toast);
  if(reason===null)return;
  try {
    const {error}=await sb.rpc('review_submission',{p_submission_id:id,p_decision:approved?'approved':'rejected',p_note:reason});
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
function openVersionManager(){
  if(!state.isAdmin)return;
  openModal(`<h2>版本管理</h2><p class="modal-subtitle">每期独立显示成绩。跨期相同的关卡可以关联，主 C 双榜自动去重。</p>
  ${state.versions.map(version=>`<article class="review-card">
    <strong>${esc(version.label)}</strong>
    <ul class="review-meta">${standardStages(version.id).map(stage=>`<li>${esc(stage.name)}${challengeOccurrences(stage)>1?' · 重复关卡':''}</li>`).join('')}</ul>
    <div class="review-actions">
      <button class="outline-button" data-action="edit-version" data-id="${esc(version.id)}">编辑版本</button>
      <button class="reject" data-action="archive-version" data-id="${esc(version.id)}">删除版本</button>
    </div></article>`).join('')||'<p class="minor">暂无版本。</p>'}
  <div class="form-actions"><button class="outline-button" data-action="admin">返回审核</button>
    <button class="gold-button" data-action="new-version">新建版本</button></div>`,true);
}
function repeatOptions(stage){
  const groups=new Map();
  for(const version of state.versions){
    for(const candidate of standardStages(version.id)){
      if(candidate.id===stage?.id||groups.has(candidate.challenge_id))continue;
      groups.set(candidate.challenge_id,`${version.code} · ${candidate.name}`);
    }
  }
  if(stage&&!groups.has(stage.challenge_id))groups.set(stage.challenge_id,'保留此关目前的统计归属');
  const distinct=stage?'取消关联，作为新的独立关卡':'作为独立关卡';
  return `<option value="">${distinct}</option>${Array.from(groups,([id,label])=>
    `<option value="${esc(id)}" ${id===stage?.challenge_id?'selected':''}>${esc(label)}</option>`).join('')}`;
}
function openVersion(id=''){
  if(!state.isAdmin)return;
  const version=state.versions.find(item=>item.id===id);
  const stages=standardStages(id);
  openModal(`<h2>${version?'编辑版本':'新建版本'}</h2>
  <p class="modal-subtitle">如果本期关卡与往期相同，在右侧选择对应关卡。变更归属后会自动重算主 C 双榜。</p>
  <form id="versionForm" data-id="${esc(id)}">
    <div class="form-grid">
      <div class="field"><label for="versionCode">版本代号</label><input id="versionCode" name="code" value="${esc(version?.code)}" maxlength="30" required/></div>
      <div class="field"><label for="versionLabel">展示名称</label><input id="versionLabel" name="label" value="${esc(version?.label)}" maxlength="80" required/></div>
    </div>
    ${[1,2,3].map(i=>{
      const stage=stages.find(item=>item.stage_no===i);
      return `<div class="form-grid">
        <div class="field"><label for="stage${i}">第 ${i} 关名称</label><input id="stage${i}" name="stage${i}" value="${esc(stage?.name)}" maxlength="80" required/></div>
        <div class="field"><label for="repeat${i}">第 ${i} 关·重复关卡</label><select id="repeat${i}" name="repeat${i}">${repeatOptions(stage)}</select></div>
      </div>`;
    }).join('')}
    <div class="form-actions"><button type="button" class="outline-button" data-action="manage-versions">返回版本管理</button>
      <button type="submit" class="gold-button">保存版本</button></div>
  </form>`,true);
}
async function saveVersion(form){
  if(!state.isAdmin)return;
  const fields=new FormData(form);
  const code=String(fields.get('code')||'').trim();
  const label=String(fields.get('label')||'').trim();
  const names=[1,2,3].map(i=>String(fields.get('stage'+i)||'').trim());
  if(!code||!label||names.some(name=>!name))return toast('请填完整版本和关卡名称。');
  const button=form.querySelector('[type=submit]');
  if(button.disabled)return;
  button.disabled=true;
  try {
    const {data:vid,error}=await sb.rpc('save_version',{
      p_version_id:form.dataset.id||null,p_code:code,p_label:label,
      p_stage_names:names,p_challenges:[1,2,3].map(i=>fields.get('repeat'+i)||null)
    });
    if(error)throw error;
    state.versionId=vid;
    state.stageId='';
    await refresh();
    openVersionManager();
    toast('版本已保存，主 C 双榜已更新。');
  }catch(e){toast(`保存失败：${e.message||e}`);}
  finally{button.disabled=false;}
}
const adminArchiveActions={
  'archive-record':{label:'这条成绩',rpc:'archive_submission',argument:'p_submission_id'},
  'archive-history':{label:'这条档案',rpc:'archive_historical_record',argument:'p_record_id'},
  'archive-version':{label:'这个版本及其榜单',rpc:'archive_version',argument:'p_version_id'}
};
async function archiveAdmin(button){
  if(!state.isAdmin||button.disabled)return;
  const {action,id,tab,stage}=button.dataset;
  const config=adminArchiveActions[action];
  if(!window.confirm(`删除${config.label}？删除后会从列表及统计中撤下。`))return;
  button.disabled=true;
  try{
    const {error}=await sb.rpc(config.rpc,{[config.argument]:id});
    if(error)throw error;
    await refresh();
    if(action==='archive-version')openVersionManager();
    else await openAdmin(action==='archive-history'?'historical':tab,stage);
    toast('已删除。');
  }catch(e){toast(`删除失败：${e.message||e}`);}
  finally{button.disabled=false;}
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
  if(action==='edit-score'){await openScoreEditor(el);return;}
  if(action==='reopen-result'){await reopenRejected(el);return;}
  if(action==='carry-scope'){
    if(['period','all'].includes(el.dataset.key)){state.carryScope=el.dataset.key;render();}
    return;
  }
  if(action==='carry-metric'){
    if(['appearance_count','challenge_count'].includes(el.dataset.key)){state.carryMetric=el.dataset.key;render();}
    return;
  }
  if(action==='remove-record'){await removeRecord(el.dataset.id);return;}
  if(action==='close'){closeModal();return;}
  if(action==='stage'){state.stageId=el.dataset.id;render();return;}
  if(action==='group'){state.group=el.dataset.group;state.resonanceOnly=false;render();return;}
  if(action==='resonance-filter'){
    state.resonanceOnly=!state.resonanceOnly;
    render();
    $('[data-action="resonance-filter"]')?.focus({preventScroll:true});
    return;
  }
  if(action==='refresh'){await init();if(state.connected)toast('榜单已更新。');return;}
  if(action==='approve'||action==='reject'){await review(el.dataset.id,action==='approve');return;}
  if(action==='preview'){await preview(el.dataset.id,el);return;}
  if(action==='manage-versions'){openVersionManager();return;}
  if(action==='new-version'||action==='edit-version'){openVersion(el.dataset.id||'');return;}
  if(Object.hasOwn(adminArchiveActions,action)){await archiveAdmin(el);return;}
  if(action==='logout'){await sb.auth.signOut();closeModal();await syncAuth();toast('已退出登录。');return;}
});
document.addEventListener('change',ev=>{
  if(ev.target.id==='versionSelect'){
    state.versionId=ev.target.value;
    state.stageId=standardStages(state.versionId)[0]?.id||'';
    render();
  }
  if(ev.target.id==='carryFilter'){
    state.carryFilter=ev.target.value;
    render();
    $('#carryFilter').focus({preventScroll:true});
  }
  if(ev.target.id==='fVersion'){const el=$('#fStage');if(el)el.innerHTML=stageOptions(ev.target.value);}
  if(ev.target.id==='fGroup'||ev.target.id==='editGroup'){
    const choice=ev.target.form.elements.resonanceTen;
    choice.disabled=ev.target.value!=='zero';
    choice.closest('label').hidden=choice.disabled;
    if(choice.disabled)choice.checked=false;
  }
});
document.addEventListener('submit',async ev=>{
  const form=ev.target;if(form.id==='scoreForm'){ev.preventDefault();await saveScore(form);return;}
  if(!['submissionForm','guestForm','loginForm','profileForm','versionForm'].includes(form.id))return;
  ev.preventDefault();if(form.id==='submissionForm')await submitRecord(form);if(form.id==='guestForm')await startGuest(form);if(form.id==='loginForm')await sendLogin(form);if(form.id==='profileForm')await saveProfile(form);if(form.id==='versionForm')await saveVersion(form);
});
document.addEventListener('keydown',ev=>{if(ev.key==='Escape')closeModal();});
document.addEventListener('click',ev=>{if(ev.target.id==='overlay')closeModal();});
init();
