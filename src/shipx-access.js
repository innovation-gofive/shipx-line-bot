const { createHash } = require('node:crypto');
const { serviceError } = require('./service-error');
const DIRECTORY = '/api/v1/Company/GetListCompany';
const denied = reason => Object.assign(serviceError('ShipX',DIRECTORY,reason,403),{retryable:false});

// A token being issued does not prove it can read a mapped customer's company.
async function ensureCompanyAccess(client,companyId,cancel){
  if(!Number.isSafeInteger(companyId)||companyId<1||companyId>2147483647)throw new Error('Company scope required');
  if(client.config.demo||!client.tokens?.oauth?.enabled())return;
  cancel?.throwIfAborted();
  const token=await client.tokens.oauth.ensure(),identity=client.tokens.oauth.status();
  const key=createHash('sha256').update(token).digest('hex');
  let cached=client.companyAccess;
  if(!cached||cached.key!==key||cached.until<=Date.now()){
    if(!client.companyAccessPending||client.companyAccessPending.key!==key){
      const promise=(async()=>{
        const companies=await client.companies(AbortSignal.timeout(10000));
        const latest=client.tokens.oauth.status();
        if(!latest.enabled||latest.revision!==identity.revision)throw denied('company_access_context_changed');
        const result={key,ids:new Set(companies.map(c=>c.id)),checkedAt:Date.now(),until:Date.now()+60000,revision:latest.revision,lastSuccess:latest.lastSuccess};
        client.companyAccess=result;return result;
      })();
      client.companyAccessPending={key,promise};
    }
    const pending=client.companyAccessPending;
    try{cached=await pending.promise;}finally{if(client.companyAccessPending===pending)client.companyAccessPending=null;}
  }
  cancel?.throwIfAborted();
  if(!cached.ids.has(companyId))throw denied('company_access_not_verified');
}
function accessStatus(client,groups=[]){
  const auth=client.tokens?.oauth?.status(),cache=client.companyAccess;
  if(!auth?.enabled)return {required:false,checked:false,missingCompanies:[]};
  if(!cache||cache.revision!==auth.revision||cache.lastSuccess!==auth.lastSuccess)return {required:true,checked:false,missingCompanies:[]};
  const missing=new Map();
  for(const group of groups)if(group.active&&group.company_id&&!cache.ids.has(group.company_id))missing.set(group.company_id,{id:group.company_id,name:group.company_name||'Company '+group.company_id});
  return {required:true,checked:true,stale:cache.until<=Date.now(),checkedAt:cache.checkedAt,companyCount:cache.ids.size,missingCompanies:[...missing.values()]};
}
async function verifyMappedAccess(client,groups){
  for(const companyId of new Set(groups.filter(g=>g.active&&g.company_id).map(g=>g.company_id))){
    try{await ensureCompanyAccess(client,companyId);}catch(error){if(error.reason!=='company_access_not_verified')throw error;}
  }
  // No mappings still requires a directory check when requested explicitly.
  if(!client.companyAccess&&client.tokens?.oauth?.enabled()){
    const token=await client.tokens.oauth.ensure(),companies=await client.companies(AbortSignal.timeout(10000)),auth=client.tokens.oauth.status();
    client.companyAccess={key:createHash('sha256').update(token).digest('hex'),ids:new Set(companies.map(c=>c.id)),checkedAt:Date.now(),until:Date.now()+60000,revision:auth.revision,lastSuccess:auth.lastSuccess};
  }
  return accessStatus(client,groups);
}
module.exports={ensureCompanyAccess,accessStatus,verifyMappedAccess};
