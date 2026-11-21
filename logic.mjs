/** 榜单公共规则：同版本、关卡、塑造组和同样完整队伍，只保留最优记录。 */
export function canonicalTeam(team) {
  if (!Array.isArray(team)) return '';
  return team.map(s => String(s).normalize('NFKC').trim().toLocaleLowerCase('zh-CN'))
    .sort((a,b) => a < b ? -1 : a > b ? 1 : 0).join('|');
}
export function scopeKey(s) { return `${s.stage_id}::${s.group_code}::${canonicalTeam(s.team)}`; }
export function compareRecord(a,b) {
  return Number(a.rounds) - Number(b.rounds)
    || new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    || String(a.id).localeCompare(String(b.id));
}
export function chooseWinners(rows) {
  const map = new Map();
  for (const row of rows.filter(x => x.status === 'approved')) {
    const key = scopeKey(row);
    const current = map.get(key);
    if (!current || compareRecord(row, current) < 0) map.set(key, row);
  }
  return [...map.values()].sort(compareRecord);
}
export function playerRanking(rows, events) {
  const winners = chooseWinners(rows);
  const players = new Map();
  function ensure(id, name) {
    if (!players.has(id)) players.set(id, {player_id:id,display_name:name,historical_count:0,current_count:0});
    return players.get(id);
  }
  for (const r of rows) if (r.status === 'approved') ensure(r.player_id, r.display_name);
  for (const r of winners) ensure(r.player_id, r.display_name).current_count++;
  const validSubmissions = new Map(rows.filter(r=>r.status==='approved').map(r=>[r.id,r]));
  const seen = new Set();
  for (const ev of events) {
    const sub = validSubmissions.get(ev.submission_id);
    if (!sub) continue;
    const identity = `${ev.player_id}::${ev.stage_id}::${ev.group_code}::${ev.team_key}`;
    if (!seen.has(identity)) {seen.add(identity); ensure(ev.player_id, sub.display_name).historical_count++;}
  }
  return [...players.values()].sort((a,b)=>b.historical_count-a.historical_count||b.current_count-a.current_count||a.display_name.localeCompare(b.display_name,'zh-CN'));
}
