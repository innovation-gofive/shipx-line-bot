const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,existsSync,unlinkSync,rmdirSync,readFileSync}=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {Store}=require('../src/store');
const {ShipXTokenStore,tokenSettings}=require('../src/shipx-token');
const {ShipXClient}=require('../src/shipx');
const {ISSUER,DISCOVERY,DEFAULT_SCOPE,PASSWORD_SCOPE}=require('../src/shipx-oauth');
const {createApp}=require('../src/app');
const {createNotifications}=require('../src/notifications');
const metadata={issuer:ISSUER,token_endpoint:ISSUER+'/connect/token',grant_types_supported:['client_credentials','password','refresh_token'],token_endpoint_auth_methods_supported:['client_secret_post','client_secret_basic']};
const jwt=exp=>'eyJhbGciOiJSUzI1NiJ9.'+Buffer.from(JSON.stringify({exp})).toString('base64url')+'.signature';
function fixture(t){
  const directory=mkdtempSync(path.join(os.tmpdir(),'shipx-oauth-'));
  const f={directory,now:Date.parse('2026-11-27T09:00:00+07:00'),calls:[],responses:[]};
  f.config={databasePath:path.join(directory,'test.sqlite'),origin:'http://localhost:3000',shipxBaseUrl:'https://api.example.test',adminUsername:'admin',adminPassword:'long-test-password',lineSecret:'test-secret',lineToken:'test-token'};
  f.reopen=()=>{f.store=new Store(f.config.databasePath);f.tokens=new ShipXTokenStore(f.config,f.store,{clock:()=>f.now});f.oauth=f.tokens.oauth;f.oauth.fetcher=async(url,options)=>{
    assert.equal(options.redirect,'error');
    if(url===DISCOVERY)return Response.json(metadata);
    assert.equal(url,ISSUER+'/connect/token');const form=new URLSearchParams(options.body);f.calls.push({form,headers:options.headers});
    const next=f.responses.shift();if(typeof next==='function')return next(url,options);if(next)return next;
    return Response.json({access_token:'access-'+f.calls.length,token_type:'Bearer',expires_in:3600});
  };};
  f.reopen();
  f.save=(extra={})=>f.oauth.save({enabled:true,revision:f.oauth.status().revision,grantType:'client_credentials',clientId:'test-client',clientSecret:'private-client-secret',username:'',password:'',scope:DEFAULT_SCOPE,authMethod:'client_secret_post',...extra},'admin');
  t.after(()=>{f.store.close();for(const file of ['test.sqlite','test.sqlite-wal','test.sqlite-shm','shipx-token.key']){const target=path.join(directory,file);if(existsSync(target))unlinkSync(target);}rmdirSync(directory);});
  return f;
}
test('client credentials issue a cached token without user/password, and persist only encrypted secrets',async t=>{
  const f=fixture(t);f.save({username:'must-not-be-stored',password:'must-not-be-stored'});
  assert.equal(await f.oauth.ensure(),'access-1');assert.equal(await f.oauth.ensure(),'access-1');assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].form.get('grant_type'),'client_credentials');assert.equal(f.calls[0].form.get('scope'),'ship-x.api');assert.equal(f.calls[0].form.has('username'),false);assert.equal(f.calls[0].form.has('password'),false);
  const row=f.oauth.row(),status=f.oauth.status();
  for(const secret of ['private-client-secret','access-1','must-not-be-stored']){assert(!JSON.stringify(row).includes(secret));assert(!JSON.stringify(status).includes(secret));assert(!JSON.stringify(f.store.audits()).includes(secret));}
  assert.equal(status.hasPassword,false);assert.equal(readFileSync(path.join(f.directory,'shipx-token.key')).length,32);
});
test('proactive renewal requests a new machine token two minutes before expiry and survives restart',async t=>{
  const f=fixture(t);f.save();await f.oauth.ensure();const expiry=f.oauth.status().expiresAt;
  f.save({clientSecret:''});assert.equal(f.oauth.status().state,'ready');assert.equal(f.oauth.status().expiresAt,expiry);
  assert.equal(f.oauth.status().refreshAt,expiry-120000);f.store.close();f.reopen();assert.equal(await f.oauth.ensure(),'access-1');assert.equal(f.calls.length,1);
  f.now=expiry-120000;await f.oauth.background();assert.equal(await f.oauth.ensure(),'access-2');assert.equal(f.calls.length,2);assert.equal(f.calls[1].form.get('grant_type'),'client_credentials');
});
test('parallel API work shares one token renewal and a stale 401 cannot invalidate a newer token',async t=>{
  const f=fixture(t);f.save();assert.deepEqual(await Promise.all(Array.from({length:15},()=>f.oauth.ensure())),Array(15).fill('access-1'));assert.equal(f.calls.length,1);
  let apiCalls=0;const client=new ShipXClient(f.config,async(_url,options)=>{apiCalls++;return options.headers.Authorization==='Bearer access-1'?Response.json({}, {status:401}):Response.json({data:{companies:[]}});},f.tokens);
  await Promise.all(Array.from({length:4},()=>client.companies()));assert.equal(f.calls.length,2);assert.equal(apiCalls,8);
  assert.equal(await f.oauth.ensure({force:true,rejectedToken:'access-1'}),'access-2');assert.equal(f.calls.length,2);
});
test('password mode rotates refresh tokens, retains an unrotated refresh token and can re-login once on invalid_grant',async t=>{
  const f=fixture(t);f.save({grantType:'password',username:'service@example.test',password:'private-user-password',scope:PASSWORD_SCOPE});
  f.responses.push(Response.json({access_token:'first-access',token_type:'Bearer',expires_in:3600,refresh_token:'first-refresh'}));await f.oauth.ensure();
  f.responses.push(Response.json({access_token:'second-access',token_type:'Bearer',expires_in:3600,refresh_token:'second-refresh'}));await f.oauth.ensure({force:true});
  assert.equal(f.calls[1].form.get('refresh_token'),'first-refresh');assert.equal(f.calls[1].form.has('password'),false);
  f.responses.push(Response.json({access_token:'third-access',token_type:'Bearer',expires_in:3600}));await f.oauth.ensure({force:true});assert.equal(f.calls[2].form.get('refresh_token'),'second-refresh');
  f.responses.push(Response.json({error:'invalid_grant'},{status:400}),Response.json({access_token:'relogin-access',token_type:'Bearer',expires_in:3600,refresh_token:'new-refresh'}));
  assert.equal(await f.oauth.ensure({force:true}),'relogin-access');assert.equal(f.calls[3].form.get('refresh_token'),'second-refresh');assert.equal(f.calls[4].form.get('grant_type'),'password');
  const status=JSON.stringify(f.oauth.status());for(const secret of ['first-refresh','second-refresh','private-user-password','relogin-access'])assert(!status.includes(secret));
});
test('invalid client or password stops unattended login attempts until an explicit admin retry',async t=>{
  const f=fixture(t);f.save();f.responses.push(Response.json({error:'invalid_client',error_description:'private-client-secret'},{status:400}));
  await assert.rejects(f.oauth.ensure(),{reason:'invalid_client'});for(let i=0;i<5;i++){f.now+=3600000;await f.oauth.background();}assert.equal(f.calls.length,1);assert.equal(f.oauth.status().state,'action_required');
  assert(!JSON.stringify(f.store.audits()).includes('private-client-secret'));await f.oauth.ensure({manual:true,force:true});assert.equal(f.calls.length,2);
  f.save({grantType:'password',username:'user',password:'private-password',scope:PASSWORD_SCOPE});f.responses.push(Response.json({error:'invalid_grant'},{status:400}));
  await assert.rejects(f.oauth.ensure(),{reason:'invalid_grant'});await f.oauth.background();assert.equal(f.calls.length,3);
});
test('refresh client failures never trigger password retries',async t=>{
  const f=fixture(t);f.save({grantType:'password',username:'user',password:'private-password',scope:PASSWORD_SCOPE});
  f.responses.push(Response.json({access_token:'token',token_type:'Bearer',expires_in:3600,refresh_token:'refresh'}));await f.oauth.ensure();
  f.responses.push(Response.json({error:'invalid_client'},{status:400}));await assert.rejects(f.oauth.ensure({force:true}),{reason:'invalid_client'});assert.equal(f.calls.length,2);assert.equal(f.calls[1].form.get('grant_type'),'refresh_token');
});
test('temporary renewal errors back off and preserve a still-valid token, while expired tokens fail closed',async t=>{
  const f=fixture(t);f.save();await f.oauth.ensure();const expiry=f.oauth.status().expiresAt;f.now=expiry-120000;
  f.responses.push(()=>{throw new Error('private-network-details');});assert.equal(await f.oauth.ensure(),'access-1');assert.equal(f.calls.length,2);
  assert.equal(f.oauth.status().nextAttempt,f.now+60000);assert.equal(await f.oauth.ensure(),'access-1');assert.equal(f.calls.length,2);
  f.now=expiry+1;f.responses.push(Response.json({error:'server_error'},{status:503}));await assert.rejects(f.oauth.ensure(),{reason:'server_error'});assert.equal(f.oauth.status().state,'retry_pending');
  assert(!JSON.stringify(f.store.audits()).includes('private-network-details'));
});
test('issuer changes and external token URLs are rejected before any credential request',async t=>{
  const f=fixture(t);f.save();let calls=0;f.oauth.fetcher=async()=>{calls++;return Response.json({...metadata,token_endpoint:'https://other.example.test/token'});};
  await assert.rejects(f.oauth.ensure(),{reason:'oauth_discovery_invalid'});assert.equal(calls,1);assert.equal(f.oauth.status().state,'action_required');
});
test('paused or changed settings revoke an in-flight token response',async t=>{
  const f=fixture(t);f.save();let resolveToken,started;const ready=new Promise(r=>started=r);
  f.responses.push(async()=>{started();return new Promise(r=>resolveToken=r);});const pending=f.oauth.ensure();await ready;f.oauth.pause('admin');
  resolveToken(Response.json({access_token:'old-settings-token',token_type:'Bearer',expires_in:3600}));await assert.rejects(pending,{reason:'oauth_settings_changed'});
  assert.equal(f.oauth.row().bundle,null);assert.equal(f.oauth.status().state,'paused');
});
test('manual bearer tokens remain usable when automatic mode is paused and 403 never triggers renewal',async t=>{
  const f=fixture(t);f.tokens.save('manual-token','admin');f.save();await f.oauth.ensure();
  const client=new ShipXClient(f.config,async()=>Response.json({},{status:403}),f.tokens);await assert.rejects(client.companies(),{statusCode:403});assert.equal(f.calls.length,1);
  f.oauth.pause('admin');const manual=new ShipXClient(f.config,async(_url,options)=>{assert.equal(options.headers.Authorization,'Bearer manual-token');return Response.json({data:{companies:[]}});},f.tokens);await manual.companies();assert.equal(f.calls.length,1);
});
test('machine tokens do not cause hourly expiry warnings, but refresh failures notify the Admin group once',async t=>{
  const f=fixture(t);f.store.seedDemo();const group='C'+'a'.repeat(32);f.store.discover(group,f.now);f.store.support.saveSettings({enabled:true,groupId:group},'admin');f.save();await f.oauth.ensure();
  assert.equal(tokenSettings(f.config,f.tokens,f.now).warning,null);f.now=f.oauth.status().refreshAt;f.responses.push(Response.json({error:'invalid_client'},{status:400}));
  const sent=[],deps={config:f.config,store:f.store,shipx:{},tokens:f.tokens,line:{push:async(to,message)=>sent.push({to,message})},clock:()=>new Date(f.now)};
  await createNotifications(deps).tick();await createNotifications(deps).tick();assert.equal(sent.length,1);assert.equal(sent[0].to,group);assert.match(JSON.stringify(sent[0].message),/อัตโนมัติไม่สำเร็จ/);
});
test('malformed or already expired token responses cannot replace a valid encrypted bundle',async t=>{
  const f=fixture(t);f.save();await f.oauth.ensure();const original=f.oauth.row().bundle;
  for(const change of [{token_type:'Other'},{expires_in:'3600'},{access_token:'bad token'},{access_token:jwt(Math.floor(f.now/1000)-10)},{refresh_token:''}]){
    f.responses.push(Response.json({access_token:'candidate',token_type:'Bearer',expires_in:3600,...change}));
    await assert.rejects(f.oauth.ensure({manual:true,force:true}),{reason:'oauth_token_invalid'});assert.equal(f.oauth.row().bundle,original);
  }
});
test('HTTP Basic authenticates the client with encoded fields and never sends the secret in the form',async t=>{
  const f=fixture(t);f.save({clientId:'client:id',clientSecret:'secret+value',authMethod:'client_secret_basic'});await f.oauth.ensure();
  const call=f.calls[0];assert.equal(call.headers.Authorization,'Basic '+Buffer.from('client%3Aid:secret%2Bvalue').toString('base64'));assert.equal(call.form.has('client_secret'),false);assert.equal(call.form.has('client_id'),false);
});
test('credential settings enforce revisions and typed input, preserve masked secrets and remove unused user passwords',t=>{
  const f=fixture(t);f.save({grantType:'password',username:'user',password:'private-user-password',scope:PASSWORD_SCOPE});
  assert.throws(()=>f.save({revision:0}),{status:409});assert.throws(()=>f.save({clientId:123}),{status:400});assert.throws(()=>f.save({scope:'bad\nheader'}),{status:400});
  f.save({clientSecret:'',grantType:'client_credentials',username:'user',password:''});assert.equal(f.oauth.status().hasClientSecret,true);assert.equal(f.oauth.status().hasPassword,false);assert.equal(f.oauth.status().username,'');
  assert.throws(()=>f.save({clearClientSecret:true}),{status:400});
});
test('OAuth routes require login and CSRF and expose metadata only; manual updates require pausing auto mode',async t=>{
  const f=fixture(t);f.tokens.save('old-manual-token','admin');
  const {app,worker}=await createApp({config:f.config,store:f.store,shipx:new ShipXClient(f.config,async()=>Response.json({data:{companies:[]}}),f.tokens),tokens:f.tokens,line:{}});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await worker.stop();await new Promise(r=>server.close(r));});
  const base=`http://127.0.0.1:${server.address().port}`,request=(url,options)=>fetch(base+url,options);
  assert.equal((await request('/api/admin/shipx/oauth',{method:'PUT'})).status,401);
  const logged=await request('/api/login',{method:'POST',headers:{Origin:f.config.origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:f.config.adminPassword})});
  const session=await logged.json(),headers={Cookie:logged.headers.get('set-cookie').split(';')[0],Origin:f.config.origin,'Content-Type':'application/json','X-CSRF-Token':session.csrf};
  const body={enabled:true,revision:0,grantType:'client_credentials',clientId:'test-client',clientSecret:'private-client-secret',scope:DEFAULT_SCOPE,authMethod:'client_secret_post'};
  assert.equal((await request('/api/admin/shipx/oauth',{method:'PUT',headers:{...headers,'X-CSRF-Token':'bad'},body:JSON.stringify(body)})).status,403);
  assert.equal((await request('/api/admin/shipx/oauth',{method:'PUT',headers,body:JSON.stringify({...body,tokenUrl:'https://other.test'})})).status,400);
  assert.equal((await request('/api/admin/shipx/oauth',{method:'PUT',headers,body:JSON.stringify(body)})).status,200);
  assert.equal((await request('/api/admin/shipx/token',{method:'PUT',headers,body:'{"token":"manual"}'})).status,409);
  const result=await (await request('/api/admin/shipx/oauth/test',{method:'POST',headers,body:'{}'})).json();assert.equal(result.ok,true);assert(!JSON.stringify(result).includes('access-1'));
  const settings=await (await request('/api/admin/settings',{headers})).json();assert.equal(settings.shipxTokenStatus.source,'automatic');assert(!JSON.stringify(settings).includes('private-client-secret'));
  await request('/api/admin/shipx/oauth/pause',{method:'POST',headers,body:'{}'});assert.equal(f.tokens.token(),'old-manual-token');assert.equal(f.oauth.enabled(),false);
});
