import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { request } from 'node:http';
import { createResultStore } from '../server/store.ts';
const directory=mkdtempSync(join(tmpdir(),'bigfive-production-reliability-'));
const filename=join(directory,'test.sqlite');
const processes=[];const report={};
const payload=()=>({submissionId:randomUUID(),answers:Object.fromEntries(Array.from({length:60},(_,i)=>[i+1,3]))});
async function start(){
 const child=spawn(process.execPath,['--experimental-strip-types','server/index.ts'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATABASE_PATH:filename,BASE_URL:''},stdio:['ignore','pipe','pipe']});
 const exited=once(child,'exit');const item={child,exited,base:''};processes.push(item);
 item.base=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('startup timeout')),10000);child.stdout.on('data',chunk=>{output+=chunk;const m=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('early exit'));});});
 return item;
}
async function stop(item,signal='SIGTERM'){item.child.kill(signal);await item.exited;}
async function submit(server,data){const t=performance.now();const response=await fetch(server.base+'/api/results',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});return {status:response.status,result:await response.json(),ms:performance.now()-t};}
function rows(){const db=new DatabaseSync(filename,{readOnly:true});try{return{results:db.prepare('SELECT * FROM results ORDER BY id').all(),receipts:db.prepare('SELECT * FROM submission_receipts').all(),integrity:db.prepare('PRAGMA integrity_check').get().integrity_check,foreignKeys:db.prepare('PRAGMA foreign_key_check').all()};}finally{db.close();}}
try{
 createResultStore(filename).close();
 const servers=await Promise.all(Array.from({length:4},start));
 const shared=payload();const tasks=[...Array.from({length:80},payload),...Array.from({length:64},()=>shared)];
 const responses=[];let cursor=0;
 await Promise.all(Array.from({length:16},async()=>{while(cursor<tasks.length){const i=cursor++;responses[i]=await submit(servers[i%servers.length],tasks[i]);}}));
 assert.ok(responses.every(r=>r.status===201));
 assert.equal(new Set(responses.slice(80).map(r=>r.result.id)).size,1);
 let snapshot=rows();assert.equal(snapshot.results.length,81);assert.equal(snapshot.receipts.length,81);assert.equal(snapshot.integrity,'ok');assert.deepEqual(snapshot.foreignKeys,[]);
 const times=responses.map(r=>r.ms).sort((a,b)=>a-b);
 report.multiProcess={processes:4,requests:144,independentSubmissions:81,rows:81,errors:0,p95Ms:Math.round(times[Math.floor(times.length*.95)]),integrity:'ok'};
 const lock=new DatabaseSync(filename);lock.exec('BEGIN IMMEDIATE');const lockedPayload=payload();let failed;
 try{failed=await submit(servers[0],lockedPayload);assert.equal(failed.status,500);assert.deepEqual(rows(),snapshot);}finally{lock.exec('ROLLBACK');lock.close();}
 const retry=await submit(servers[0],lockedPayload);assert.equal(retry.status,201);
 report.lock={statusWhileLocked:failed.status,waitMs:Math.round(failed.ms),rowsUnchangedWhileLocked:true,retryStatus:retry.status};
 // Drain a submission whose body is still being read when SIGTERM arrives.
 const interrupted=payload();const body=JSON.stringify(interrupted);
 const connection=request(servers[1].base+'/api/results',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}});
 const drained=new Promise((resolve,reject)=>{connection.on('error',reject);connection.on('response',res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});});
 connection.write(body.slice(0,Math.floor(body.length/2)));
 await new Promise(resolve=>setTimeout(resolve,100));servers[1].child.kill('SIGTERM');
 await new Promise(resolve=>setTimeout(resolve,100));connection.end(body.slice(Math.floor(body.length/2)));
 assert.equal(await drained,201);await servers[1].exited;
 assert.equal(rows().results.length,83);
 const replacement=await start();assert.equal((await submit(replacement,interrupted)).status,201);
 // Kill after a commit, then retry the same identity after restart.
 const committed=payload();const first=await submit(replacement,committed);assert.equal(first.status,201);await stop(replacement,'SIGKILL');
 const restarted=await start();const replay=await submit(restarted,committed);assert.equal(replay.status,201);assert.equal(replay.result.id,first.result.id);
 snapshot=rows();assert.equal(snapshot.results.length,84);assert.equal(snapshot.receipts.length,84);assert.equal(snapshot.integrity,'ok');assert.deepEqual(snapshot.foreignKeys,[]);
 report.shutdown={partialBodySigtermDrainedWith201:true,retryAfterRestartSucceeded:true,committedSigkillRetryReturnedSameLink:true,rows:84,integrity:'ok'};
 writeFileSync(join(tmpdir(),'bigfive-production-reliability-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{for(const item of processes)if(item.child.exitCode===null&&item.child.signalCode===null)await stop(item);rmSync(directory,{recursive:true,force:true});}
