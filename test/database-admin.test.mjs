import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseCommand } from '../dist/databases.js';
import { insightParameters, recoveryParameters } from '../dist/database-admin.js';
import { parseCommand } from '../dist/commands.js';
const id='db_'+'1'.repeat(32), job='db_'+'2'.repeat(32), bookmark=id+':0000000000000001';
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'hibana-db-admin-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const config=join(root,'hibana.json');await writeFile(config,JSON.stringify({name:'fixture',main:'app.ts',databases:{DB:id}}));
  return {root,config,options:{config,url:'http://127.0.0.1:18888',token:'fixture-token'}};
}
test('conventional database commands validate recovery and insight options before networking',()=>{
  for(const path of [['db','export'],['db','time-travel','info'],['db','time-travel','restore'],['db','insights']]) assert.match(parseCommand([...path,'--help']).helpText,/Usage: hibana db/);
  assert.throws(()=>recoveryParameters({},true),/requires/);
  assert.throws(()=>recoveryParameters({timestamp:'yesterday'}),/RFC3339/);
  assert.throws(()=>recoveryParameters({timestamp:'0'}),/24 hours/);
  assert.throws(()=>recoveryParameters({bookmark:'../escape'}),/Invalid/);
  assert.throws(()=>recoveryParameters({timestamp:'1',bookmark}),/not both/);
  assert.equal(insightParameters({}).get('sort_by'),'total_duration');
  assert.equal(insightParameters({'sort-by':'time','sort-type':'avg','sort-direction':'ASC'}).get('sort_by'),'average_duration');
  assert.throws(()=>insightParameters({'sort-by':'__proto__'}),/sort-by/);
  assert.throws(()=>insightParameters({limit:'101'}),/limit/);
});
test('remote recovery resolves a verified point and submits exactly one confirmed restore',async t=>{
  const f=await fixture(t),calls=[];
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    const path=new URL(url).pathname;calls.push([path,options.method,options.body]);
    if(path==='/databases') return Response.json({databases:[{id,name:'fixture',status:'ready'}]});
    if(options.method==='POST') {assert.deepEqual(JSON.parse(options.body),{bookmark,confirmation:'fixture'});return Response.json({id:job,status:'pending'},{status:202});}
    return Response.json({bookmark,timestamp:new Date(Date.now()-1000).toISOString()});
  });
  const result=await databaseCommand(['time-travel','restore','DB'],{...f.options,bookmark,yes:true,'no-wait':true});
  assert.equal(result.id,job);assert.equal(calls.filter(c=>c[1]==='POST').length,1);
});
test('recovery timestamps reject impossible calendar dates and end-of-day normalization',t=>{
  let now=Date.parse('2026-03-01T12:00:00Z');
  t.mock.method(Date,'now',()=>now);
  for(const timestamp of ['2026-02-29T10:00:00Z','2026-02-29T19:00:00+09:00','2026-02-28T24:00:00Z']) {
    assert.throws(()=>recoveryParameters({timestamp}),/valid.*RFC3339/);
  }
  assert.equal(recoveryParameters({timestamp:'2026-03-01T19:00:00+09:00'}).get('timestamp'),'2026-03-01T10:00:00.000Z');
  assert.equal(recoveryParameters({timestamp:String((now-1000)/1000)}).get('timestamp'),'2026-03-01T11:59:59.000Z');
  now=Date.parse('2028-03-01T00:00:00Z');
  assert.equal(recoveryParameters({timestamp:'2028-02-29T23:59:59Z'}).get('timestamp'),'2028-02-29T23:59:59.000Z');
});
test('streamed SQL exports never overwrite or publish partial downloads',async t=>{
  const f=await fixture(t),output=join(f.root,'dump.sql'),sql='SELECT 1;\n';let declared=sql.length+2,calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(sql,{headers:{'content-type':'application/sql','content-length':String(declared)}});});
  await assert.rejects(databaseCommand(['export','DB'],{...f.options,remote:true,output}),/interrupted/);
  await assert.rejects(access(output));assert.equal((await readdir(f.root)).some(n=>n.startsWith('.hibana-export-')),false);
  declared=sql.length;assert.equal((await databaseCommand(['export','DB'],{...f.options,remote:true,output})).bytes,sql.length);
  await assert.rejects(databaseCommand(['export','DB'],{...f.options,remote:true,output}),/already exists/);
  assert.equal(await readFile(output,'utf8'),sql);assert.equal(calls,2);
});
test('execute --file streams a large SQL file with target confirmation without query splitting',async t=>{
  const f=await fixture(t),file=join(f.root,'import.sql'),sql='-- large file\n'+'INSERT INTO t VALUES(1);\n'.repeat(15000);await writeFile(file,sql);
  let writes=0;
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    if(new URL(url).pathname==='/databases') return Response.json({databases:[{id,name:'fixture',status:'ready'}]});
    assert.equal(new URL(url).pathname,`/databases/${id}/import`);assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('confirmation'),'fixture');assert.equal(await options.body.get('file').text(),sql);writes++;
    return Response.json({statements:15000,changes:15000});
  });
  assert.equal((await databaseCommand(['execute','DB'],{...f.options,remote:true,file,yes:true})).statements,15000);
  assert.equal(writes,1);
});
test('SQL files changed during target lookup are rejected before upload',async t=>{
  const f=await fixture(t),file=join(f.root,'changed.sql');await writeFile(file,'SELECT 1;');let calls=0;
  t.mock.method(globalThis,'fetch',async ()=>{
    calls++;await writeFile(file,'DROP TABLE important;');
    return Response.json({databases:[{id,name:'fixture',status:'ready'}]});
  });
  await assert.rejects(databaseCommand(['execute','DB'],{...f.options,remote:true,file,yes:true}),/file changed/);
  assert.equal(calls,1);
  await assert.rejects(databaseCommand(['export','DB'],{...f.options,remote:true,output:join(f.root,'dump.sql'),table:''}),/Invalid table/);
});
test('create --binding --update-config preserves unrelated settings and refuses existing bindings before creation',async t=>{
  const f=await fixture(t),original=JSON.parse(await readFile(f.config,'utf8'));original.vars={STAGE:'dev'};await writeFile(f.config,JSON.stringify(original));let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({id:job,name:'new-db',status:'ready'});});
  const result=await databaseCommand(['create','new-db'],{...f.options,binding:'ANALYTICS','update-config':true});
  assert.equal(result.config_updated,f.config);
  const config=JSON.parse(await readFile(f.config,'utf8'));assert.deepEqual(config.vars,original.vars);assert.deepEqual(config.databases,{DB:id,ANALYTICS:job});
  await assert.rejects(databaseCommand(['create','second'],{...f.options,binding:'DB','update-config':true}),/already exists/);assert.equal(calls,1);
});
test('a concurrent config edit after database creation is preserved and the created database is reported',async t=>{
  const f=await fixture(t);const edited=JSON.stringify({name:'fixture',main:'changed.ts'});
  t.mock.method(globalThis,'fetch',async()=>{await writeFile(f.config,edited);return Response.json({id:job,name:'new-db',status:'ready'});});
  const result=await databaseCommand(['create','new-db'],{...f.options,binding:'EXTRA','update-config':true});
  assert.equal(result.id,job);assert.equal(result.config_updated,false);assert.equal(await readFile(f.config,'utf8'),edited);assert.match(result.warning,/do not repeat/);
});
test('native SQL file import/export and roundtrip use separate persistent targets', {skip:!process.env.HIBANA_TEST_RUNTIME,timeout:120000},async t=>{
  const f=await fixture(t),file=join(f.root,'input.sql'),dump=join(f.root,'export.sql');
  await writeFile(file,"CREATE TABLE t(id INTEGER PRIMARY KEY, data BLOB); INSERT INTO t VALUES(12,zeroblob(800000)); SELECT length(data) AS bytes FROM t;");
  const options={config:f.config,local:true,runtime:process.env.HIBANA_TEST_RUNTIME,yes:true};
  const imported=await databaseCommand(['execute','DB'],{...options,file});
  assert.equal(imported.results[0].statement,3);
  assert.deepEqual(imported.results[0].results,[{bytes:800000}]);
  assert.ok((await databaseCommand(['export','DB'],{...options,output:dump})).bytes>1024*1024);
  await databaseCommand(['execute',job],{...options,file:dump});
  const result=await databaseCommand(['execute',job],{...options,command:'SELECT id,length(data) AS bytes FROM t'});
  assert.deepEqual(result.results[0].results,[{id:12,bytes:800000}]);
});
