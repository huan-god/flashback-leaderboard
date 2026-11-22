import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalTeam,chooseWinners,compareRecord,playerRanking,validateLineup} from '../logic.mjs';
const make = (id,player,rounds,time,team=['甲','乙','丙','丁'],group='zero',stage='s1',status='approved') => ({id,player_id:player,display_name:player,status,rounds,created_at:time,team,group_code:group,stage_id:stage});
test('complete team order does not split a record slot',()=>{
  assert.equal(canonicalTeam(['乙','甲']), canonicalTeam(['甲','乙']));
  assert.equal(canonicalTeam(['Ａ','乙']),canonicalTeam(['A','乙']));
});
test('lower rounds beat earlier slower submission',()=>{
  const a=make('a','甲',4,'2026-01-01T01:00:00Z');
  const b=make('b','乙',2,'2026-01-01T02:00:00Z');
  assert.equal(chooseWinners([a,b])[0].id,'b');
});
test('equal rounds first upload wins, review order irrelevant',()=>{
  const early=make('early','甲',2,'2026-01-01T01:00:00Z');
  const late=make('late','乙',2,'2026-01-01T02:00:00Z');
  assert.equal(chooseWinners([late,early])[0].id,'early');
});
test('different team, stage or group each has a separate slot',()=>{
  const a=make('a','甲',3,'2026-01-01', ['甲','乙']);
  const b=make('b','乙',2,'2026-01-02', ['甲','丙']);
  const c=make('c','丙',1,'2026-01-03', ['甲','乙'], 'max');
  const d=make('d','丁',1,'2026-01-04', ['甲','乙'], 'zero', 's2');
  assert.equal(chooseWinners([a,b,c,d]).length,4);
});
const core = ['露西','哑谜','乌尔里希'];
const optional = [...core,'小瑞安侬／卡戎'];

test('a shorter subset beats every larger lineup in its own stage and division',()=>{
  const short=make('short','选手一',6,'2026-11-22',core);
  const long=make('long','选手二',1,'2026-11-21',optional);
  const different=make('different','选手三',1,'2026-11-21',['露西','哑谜','小瑞安侬','卡戎']);
  const max=make('max','选手四',1,'2026-11-21',optional,'max');
  assert.deepEqual(new Set(chooseWinners([short,long,different,max]).map(r=>r.id)),new Set(['short','different','max']));
});

test('a result using one named alternative only displaces that concrete lineup',()=>{
  const options=make('options','选手一',4,'2026-11-21',optional);
  const fast=make('fast','选手二',3,'2026-11-22',['卡戎',...core]);
  const rows=chooseWinners([options,fast]);
  assert.equal(rows[0].id,'fast');
  assert.deepEqual(rows[1].team,[...core,'小瑞安侬']);
  assert.equal(chooseWinners([options])[0].team[3],'卡戎/小瑞安侬');
});

test('a legacy one-cell shorthand cannot suppress a precise lineup',()=>{
  const legacy={...make('archive','选手一',6,'2026-11-21',['露西/哑谜']),source_history_id:'archive-row'};
  const fresh=make('fresh','选手二',2,'2026-11-22',core);
  assert.equal(chooseWinners([legacy,fresh]).length,2);
});

test('new lineups require one character per slot and at most four characters',()=>{
  assert.doesNotThrow(()=>validateLineup([...core,'小瑞安侬']));
  assert.throws(()=>validateLineup(optional),/只能填一名/);
  assert.throws(()=>validateLineup([...core,'小瑞安侬/卡戎']),/只能填一名/);
  assert.throws(()=>validateLineup([...core,'小瑞安侬','卡戎']),/1—4/);
});
test('pending or rejected submissions do not enter leaderboard',()=>{
  const approved=make('a','甲',5,'2026-01-01');
  const pending=make('b','乙',0,'2026-01-02',undefined,'zero','s1','pending');
  const rejected=make('c','丙',0,'2026-01-02',undefined,'zero','s1','rejected');
  assert.equal(chooseWinners([approved,pending,rejected])[0].id,'a');
});
test('historic count deduplicates reacquiring same team record',()=>{
  const rows=[make('a','甲',3,'2026-01-01'),make('b','乙',2,'2026-01-02'),make('c','甲',1,'2026-01-03')];
  const k=canonicalTeam(rows[0].team);
  const hist=['a','b','c'].map((id,i)=>({submission_id:id,player_id:rows[i].player_id,stage_id:'s1',group_code:'zero',team_key:k}));
  const rank=playerRanking(rows,hist);
  assert.equal(rank.find(x=>x.player_id==='甲').historical_count,1);
  assert.equal(rank.find(x=>x.player_id==='甲').current_count,1);
  assert.equal(rank.find(x=>x.player_id==='乙').historical_count,1);
});
test('invalidated submissions no longer contribute to history',()=>{
 const rows=[make('a','甲',2,'2026-01-01',undefined,'zero','s1','rejected')];
 const hist=[{submission_id:'a',player_id:'甲',stage_id:'s1',group_code:'zero',team_key:'甲|乙|丙|丁'}];
 assert.deepEqual(playerRanking(rows,hist),[]);
});

test('removed records are excluded and previous valid record regains the slot',()=>{
  const earlier=make('a','玩家甲',3,'2026-01-01T10:00:00Z');
  const removed=make('b','玩家乙',2,'2026-01-02T10:00:00Z',undefined,'zero','s1','removed');
  assert.equal(chooseWinners([removed,earlier]).at(0).id,'a');
});
test('historical honors exclude removed submission events',()=>{
  const approved=make('a','玩家甲',3,'2026-01-01T10:00:00Z');
  const removed=make('b','玩家乙',2,'2026-01-02T10:00:00Z',undefined,'zero','s1','removed');
  const team_key=canonicalTeam(approved.team);
  const events=[approved,removed].map(s=>({submission_id:s.id,player_id:s.player_id,stage_id:s.stage_id,group_code:s.group_code,team_key}));
  const ranking=playerRanking([removed,approved],events);
  assert.equal(ranking.length,1);
  assert.equal(ranking[0].player_id,'玩家甲');
});
