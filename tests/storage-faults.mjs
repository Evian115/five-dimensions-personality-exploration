import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec=promisify(execFile);const name='bigfive-reliability-'+process.pid;
const docker=async(...args)=>(await exec('docker',args,{maxBuffer:2**20})).stdout.trim();
const run=script=>docker('exec',name,'node','--experimental-strip-types','-e',script);
const report={};
try{
 await docker('run','--rm','-d','--name',name,'--read-only','--tmpfs','/app/data:rw,size=1m,uid=1000,gid=1000','-v',process.cwd()+'/server:/app/server:ro','-v',process.cwd()+'/src:/app/src:ro','-p','127.0.0.1::5173',process.env.TEST_DOCKER_IMAGE || 'bigfive-open-web');
 const binding=await docker('port',name,'5173');const base='http://'+binding;
 let ready=false;for(let i=0;i<60;i++){try{ready=(await fetch(base)).ok;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 const payload=()=>({submissionId:randomUUID(),answers:Object.fromEntries(Array.from({length:60},(_,i)=>[i+1,3]))});
 const post=async data=>{const r=await fetch(base+'/api/results',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});return {status:r.status,value:await r.json()};};
 const before=await post(payload());assert.equal(before.status,201);
 const snapshot=()=>run("const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/app/data/bigfive.sqlite',{readOnly:true});console.log(JSON.stringify({r:d.prepare('SELECT * FROM results').all(),s:d.prepare('SELECT * FROM submission_receipts').all(),integrity:d.prepare('PRAGMA integrity_check').get()}));d.close();");
 const original=await snapshot();
 const filled=await run("const f=require('node:fs');const fd=f.openSync('/app/data/fill','w');let bytes=0;try{for(;;)bytes+=f.writeSync(fd,Buffer.alloc(4096));}catch(e){console.log(JSON.stringify({error:e.code,bytes}));}finally{f.closeSync(fd);}");
 assert.equal(JSON.parse(filled).error,'ENOSPC');
 const pending=payload();const failed=await post(pending);assert.equal(failed.status,500);assert.equal(await snapshot(),original);
 const decoded=await fetch(base+'/api/results/decode?token='+before.value.id);assert.equal(decoded.status,200);
 await run("require('node:fs').unlinkSync('/app/data/fill')");
 const retried=await post(pending);assert.equal(retried.status,201);
 report.diskFull={filesystem:'isolated Docker tmpfs 1 MiB',fill:JSON.parse(filled),statusWhileFull:500,recordsAndReceiptsUnchanged:true,decodeStillWorked:true,retryAfterFreeingSpace:201,integrity:JSON.parse(await snapshot()).integrity};
 // Give a new process a real read-only database directory and the original key.
 await run("const f=require('node:fs');const{DatabaseSync}=require('node:sqlite');f.mkdirSync('/app/data/readonly');const d=new DatabaseSync('/app/data/bigfive.sqlite');d.exec(\"VACUUM INTO '/app/data/readonly/test.sqlite'\");d.close();f.copyFileSync('/app/data/bigfive.sqlite.link-key','/app/data/readonly/test.sqlite.link-key');f.chmodSync('/app/data/readonly/test.sqlite',0o444);f.chmodSync('/app/data/readonly/test.sqlite.link-key',0o444);f.chmodSync('/app/data/readonly',0o555);");
 const readonly=JSON.parse(await run("try{require('./server/store.ts').createResultStore('/app/data/readonly/test.sqlite');console.log(JSON.stringify({opened:true}));}catch(e){console.log(JSON.stringify({opened:false,error:e.message}));}"));
 assert.equal(readonly.opened,false);report.readonly=readonly;
 writeFileSync(join(tmpdir(),'bigfive-disk-fault-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{try{await docker('rm','-f',name);}catch{}}
