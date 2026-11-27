const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { serviceError } = require('./service-error');
const ISSUER = 'https://login.gofive.co.th';
const DISCOVERY = ISSUER + '/.well-known/openid-configuration';
const ENDPOINT = '/connect/token';
const DEFAULT_SCOPE = 'ship-x.api';
const PASSWORD_SCOPE = 'openid profile ship-x.api GOFIVE.API offline_access';
const knownErrors = new Set(['invalid_client','unauthorized_client','invalid_grant','invalid_scope','unsupported_grant_type','access_denied','temporarily_unavailable','server_error']);
const invalid = text => Object.assign(new Error(text), {status:400});
const fail = (reason, retryable = false, status) => Object.assign(serviceError('ShipX OAuth',ENDPOINT,reason,status),{retryable});

class ShipXOAuth {
  constructor(tokens, {fetcher = fetch, clock = Date.now} = {}) {
    this.tokens=tokens; this.store=tokens.store; this.db=tokens.db; this.fetcher=fetcher; this.clock=clock;
    this.pending=null; this.controller=null; this.discovery=null;
    this.db.exec(`CREATE TABLE IF NOT EXISTS shipx_oauth (
      id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
      settings TEXT, bundle TEXT, updated_at INTEGER, last_success INTEGER, last_error TEXT,
      failures INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'paused'
    ); INSERT OR IGNORE INTO shipx_oauth(id) VALUES(1);`);
  }
  row(){return this.db.prepare('SELECT * FROM shipx_oauth WHERE id=1').get();}
  enabled(){return !!this.row().enabled;}
  seal(value, purpose){
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.tokens.key(true),iv);
    cipher.setAAD(Buffer.from('shipx-oauth-v1:'+purpose));
    const bytes=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64');
  }
  open(value,purpose){
    if(!value)return null;
    try{
      const bytes=Buffer.from(value,'base64'),decipher=createDecipheriv('aes-256-gcm',this.tokens.key(),bytes.subarray(0,12));
      decipher.setAAD(Buffer.from('shipx-oauth-v1:'+purpose));decipher.setAuthTag(bytes.subarray(12,28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
    }catch{throw fail('oauth_storage_unreadable');}
  }
  status(){
    const row=this.row(),base={enabled:!!row.enabled,revision:row.revision,issuer:ISSUER,discoveryUrl:DISCOVERY,
      configured:false,clientId:'',username:'',scope:DEFAULT_SCOPE,grantType:'client_credentials',authMethod:'client_secret_post',hasPassword:false,hasClientSecret:false,
      state:row.state,lastError:row.last_error,nextAttempt:row.next_attempt||null,lastSuccess:row.last_success,
      expiresAt:null,refreshAt:null,refreshAvailable:false,updatedAt:row.updated_at};
    try{
      const settings=this.open(row.settings,'settings'),bundle=this.open(row.bundle,'bundle');
      return {...base,...(settings?{configured:true,clientId:settings.clientId,username:settings.username,scope:settings.scope,
        grantType:settings.grantType || 'password',authMethod:settings.authMethod,hasPassword:!!settings.password,hasClientSecret:!!settings.clientSecret}:{}),
        expiresAt:bundle?.expiresAt??null,refreshAt:bundle?.refreshAt??null,refreshAvailable:!!bundle?.refreshToken};
    }catch{return {...base,state:'action_required',lastError:'oauth_storage_unreadable'};}
  }
  save(input,actor){
    const row=this.row();
    if(typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.revision))throw invalid('ข้อมูลการเชื่อมต่อไม่ถูกต้อง');
    if(input.revision!==row.revision)throw Object.assign(invalid('การตั้งค่าเปลี่ยนแล้ว กรุณาโหลดใหม่'),{status:409});
    let previous;try{previous=this.open(row.settings,'settings');}catch{previous=null;}
    const trim=value=>typeof value==='string'?value.trim():value;
    const settings={clientId:trim(input.clientId),grantType:input.grantType,username:input.grantType==='client_credentials'?'':trim(input.username),scope:trim(input.scope),authMethod:input.authMethod,
      password:input.grantType==='client_credentials'?'':input.password||previous?.password||'',clientSecret:input.clearClientSecret?'':input.clientSecret||previous?.clientSecret||''};
    if(typeof settings.clientId!=='string'||!settings.clientId||settings.clientId.length>512||/[\s\x00-\x1f\x7f]/.test(settings.clientId)||
       !['client_credentials','password'].includes(settings.grantType)||
       typeof settings.username!=='string'||(settings.grantType==='password'&&!settings.username)||settings.username.length>320||/[\x00-\x1f\x7f]/.test(settings.username)||
       typeof settings.password!=='string'||(settings.grantType==='password'&&!settings.password)||settings.password.length>2000||
       typeof settings.clientSecret!=='string'||settings.clientSecret.length>4000||
       (settings.grantType==='client_credentials'&&!settings.clientSecret)||
       typeof settings.scope!=='string'||!settings.scope||settings.scope.length>1000||!/^[A-Za-z0-9._:-]+(?: +[A-Za-z0-9._:-]+)*$/.test(settings.scope)||
       !['client_secret_post','client_secret_basic'].includes(settings.authMethod)||
       (input.password!==undefined&&typeof input.password!=='string')||(input.clientSecret!==undefined&&typeof input.clientSecret!=='string')||
      (input.clearClientSecret!==undefined&&typeof input.clearClientSecret!=='boolean'))throw invalid('กรุณาระบุ Client ID, Client Secret และข้อมูลวิธีเชื่อมต่อให้ถูกต้อง');
    this.controller?.abort();
    this.pending=null;
    const unchanged=JSON.stringify(settings)===JSON.stringify(previous);
    let savedBundle=unchanged?row.bundle:null,cached;
    try{cached=this.open(savedBundle,'bundle');}catch{savedBundle=null;}
    const nextState=!input.enabled?'paused':cached?.expiresAt>this.clock()+5000?'ready':'configured';
    this.store.transaction(()=>{
      this.db.prepare(`UPDATE shipx_oauth SET enabled=?,revision=revision+1,settings=?,bundle=?,updated_at=?,last_error=NULL,
        failures=0,next_attempt=0,state=? WHERE id=1`).run(+input.enabled,this.seal(settings,'settings'),savedBundle,this.clock(),nextState);
      this.store.audit({actor,action:'shipx.oauth.settings',outcome:input.enabled?'enabled':'disabled'});
    });
    return this.status();
  }
  pause(actor){
    this.controller?.abort();
    this.pending=null;
    this.db.prepare("UPDATE shipx_oauth SET enabled=0,revision=revision+1,state='paused',last_error=NULL,failures=0,next_attempt=0 WHERE id=1").run();
    this.store.audit({actor,action:'shipx.oauth.settings',outcome:'disabled'});return this.status();
  }
  current(revision){if(!this.enabled()||this.row().revision!==revision)throw fail('oauth_settings_changed');}
  async metadata(signal){
    if(this.discovery&&this.discovery.until>this.clock())return this.discovery.data;
    let response;
    try{response=await this.fetcher(DISCOVERY,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});}
    catch{throw fail('oauth_discovery_connection',true);}
    if(!response.ok)throw fail('oauth_discovery_http',response.status>=500||response.status===429,response.status);
    let data;try{const raw=await response.text();if(raw.length>100000)throw 0;data=JSON.parse(raw);}catch{throw fail('oauth_discovery_invalid');}
    // Credentials can only go to the issuer explicitly selected for this integration.
    if(data?.issuer!==ISSUER||data.token_endpoint!==ISSUER+ENDPOINT||!Array.isArray(data.grant_types_supported)||
       data.grant_types_supported.length===0)throw fail('oauth_discovery_invalid');
    this.discovery={data,until:this.clock()+3600000};return data;
  }
  async exchange(settings,grant,refreshToken,signal,metadata){
    if(!metadata.grant_types_supported.includes(grant)||!metadata.token_endpoint_auth_methods_supported?.includes(settings.authMethod))throw fail('oauth_grant_not_supported');
    const form=new URLSearchParams({client_id:settings.clientId,grant_type:grant});
    const headers={'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'};
    if(settings.clientSecret){
      if(settings.authMethod==='client_secret_basic'){
        const encode=value=>new URLSearchParams({v:value}).toString().slice(2);
        headers.Authorization='Basic '+Buffer.from(encode(settings.clientId)+':'+encode(settings.clientSecret)).toString('base64');
        form.delete('client_id');
      }else form.set('client_secret',settings.clientSecret);
    }
    if(grant==='refresh_token')form.set('refresh_token',refreshToken);
    else{if(grant==='password'){form.set('username',settings.username);form.set('password',settings.password);}form.set('scope',settings.scope);}
    let response;
    try{response=await this.fetcher(ISSUER+ENDPOINT,{method:'POST',redirect:'error',headers,body:form.toString(),signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])});}
    catch{throw fail('oauth_token_connection',true);}
    let data;try{const raw=await response.text();if(raw.length>100000)throw 0;data=JSON.parse(raw);}catch{throw fail('oauth_token_invalid',response.status>=500||response.status===429,response.status);}
    if(!response.ok||data?.error){
      const reason=knownErrors.has(data?.error)?data.error:'oauth_token_http';
      throw fail(reason,response.status>=500||response.status===429||['temporarily_unavailable','server_error'].includes(reason),response.status);
    }
    const {normalizeBearerToken,tokenExpiry}=require('./shipx-token');
    let accessToken;try{accessToken=normalizeBearerToken(data.access_token);}catch{throw fail('oauth_token_invalid');}
    if(typeof data.token_type!=='string'||data.token_type.toLowerCase()!=='bearer'||!Number.isSafeInteger(data.expires_in)||data.expires_in<10||data.expires_in>31536000||
      (data.refresh_token!==undefined&&(typeof data.refresh_token!=='string'||!data.refresh_token||data.refresh_token.length>32000||!/^[\x21-\x7e]+$/.test(data.refresh_token))))throw fail('oauth_token_invalid');
    const now=this.clock(),jwtExpiry=tokenExpiry(accessToken),expiresAt=Math.min(now+data.expires_in*1000,jwtExpiry??Infinity),lifetime=expiresAt-now;
    if(lifetime<10000)throw fail('oauth_token_invalid');
    return {accessToken,refreshToken:data.refresh_token??refreshToken??null,expiresAt,refreshAt:expiresAt-Math.min(120000,Math.floor(lifetime/5))};
  }
  async ensure({force=false,rejectedToken=null,manual=false}={}){
    const row=this.row();if(!row.enabled)throw fail('oauth_disabled');
    const bundle=this.open(row.bundle,'bundle'),now=this.clock(),valid=bundle?.expiresAt>now+5000;
    if(this.pending)return this.wait(this.pending,row,bundle,{force,rejectedToken});
    if(valid&&((rejectedToken&&bundle.accessToken!==rejectedToken)||(!force&&bundle.refreshAt>now)))return bundle.accessToken;
    if(!manual&&(row.state==='action_required'||row.next_attempt>now)){
      if(valid&&!rejectedToken)return bundle.accessToken;
      throw fail(row.last_error||'oauth_retry_pending',row.state!=='action_required');
    }
    const task=this.acquire(row,bundle);this.pending=task;
    try{return await this.wait(task,row,bundle,{force,rejectedToken});}finally{if(this.pending===task)this.pending=null;}
  }
  async wait(task,row,bundle,{force,rejectedToken}){
    try{return await task;}catch(error){
      if(error.retryable&&!force&&!rejectedToken&&bundle?.expiresAt>this.clock()+5000&&this.enabled()&&this.row().revision===row.revision)return bundle.accessToken;
      throw error;
    }
  }
  async acquire(row,previous){
    const revision=row.revision,controller=new AbortController();this.controller=controller;
    try{
      const settings=this.open(row.settings,'settings');if(!settings)throw fail('oauth_not_configured');
      const metadata=await this.metadata(controller.signal);this.current(revision);
      const primaryGrant=settings.grantType || 'password';
      let bundle,grant=primaryGrant;
      if(primaryGrant==='password'&&previous?.refreshToken&&metadata.grant_types_supported.includes('refresh_token')){
        grant='refresh_token';
        try{bundle=await this.exchange(settings,grant,previous.refreshToken,controller.signal,metadata);}
        catch(error){if(error.reason!=='invalid_grant')throw error;this.current(revision);grant='password';}
      }
      if(!bundle)bundle=await this.exchange(settings,primaryGrant,null,controller.signal,metadata);
      this.current(revision);
      this.store.transaction(()=>{
        this.db.prepare("UPDATE shipx_oauth SET bundle=?,last_success=?,last_error=NULL,failures=0,next_attempt=0,state='ready' WHERE id=1 AND revision=?")
          .run(this.seal(bundle,'bundle'),this.clock(),revision);
        this.store.audit({action:grant==='refresh_token'?'shipx.oauth.refresh':'shipx.oauth.login',outcome:'success',endpoint:ENDPOINT});
      });
      return bundle.accessToken;
    }catch(error){
      if(!this.enabled()||this.row().revision!==revision)throw fail('oauth_settings_changed');
      if(controller.signal.aborted)throw fail('oauth_interrupted',true);
      const reason=typeof error.reason==='string'?error.reason:'oauth_token_invalid',retry=error.retryable===true;
      this.db.prepare('UPDATE shipx_oauth SET failures=failures+1,last_error=?,next_attempt=?,state=? WHERE id=1 AND revision=?')
        .run(reason,retry?this.clock()+Math.min(900000,60000*2**Math.min(row.failures,4)):0,retry?'retry_pending':'action_required',revision);
      this.store.audit({action:'shipx.oauth.refresh',outcome:retry?'retry_pending':'configuration_required',endpoint:ENDPOINT,detail:reason});
      throw fail(reason,retry,error.statusCode);
    }finally{if(this.controller===controller)this.controller=null;}
  }
  async background(){
    if(!this.enabled())return;
    try{await this.ensure();}catch{/* Status and sanitized audit describe the retry or required action. */}
  }
  cancel(){this.controller?.abort();}
}
module.exports={ShipXOAuth,ISSUER,DISCOVERY,DEFAULT_SCOPE,PASSWORD_SCOPE};
