const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function load(responses = []) {
  const requests = [], timers = new Map(); let n = 0;
  const src = fs.readFileSync('pages/index/index.ink','utf8').split('<script setup>')[1].split('</script>')[0].replace('export default {','globalThis.page = {');
  const ctx = {URL, console:{log(){}}, setTimeout(fn){timers.set(++n,fn);return n;}, clearTimeout(id){if(id==null)throw Error('Ink requires a timer id');timers.delete(id);}, fetch:async(url,options={})=>{
    requests.push({url,options});
    const r = responses.shift(); if(!r) throw Error('unexpected request');
    if(typeof r === 'function') return r(url,options);
    return {status:r.status||200,headers:{get:k=>r.headers?.[k]||null},text:async()=>typeof r.body === 'string'?r.body:JSON.stringify(r.body)};
  }};
  vm.runInNewContext(src,ctx); const page=ctx.page;
  page.data={...page.data}; page.setData=u=>Object.assign(page.data,u);
  page.items=[];ctx.realRequestFeed=page.requestFeed; let feedCalls=0; page.requestFeed=()=>{feedCalls++;};
  return {page,ctx,requests,timers,feedCalls:()=>feedCalls,realRequestFeed:ctx.realRequestFeed};
}
const qr = {body:{data:{token:'secret-token',qrcode:'iVBORw0KGgoAAAANSUhEUg==',status:'new'}}};
const home = {body:'home',headers:{'set-cookie':'guest=yes; Domain=.douyin.com; Path=/'}};
test('wakeup opens a genuine QR, deduplicates repeated wakeups and schedules one poll',async()=>{
  const {page,requests,timers}=load([home,qr]);
  await page.onVoiceWakeup({}); await page.onVoiceWakeup({});
  assert.equal(page.data.loginVisible,true); assert.match(page.data.loginQr,/^data:image\/png;base64,/);
  assert.equal(requests.length,2); assert.equal(timers.size,1); assert.equal(page.data.loggedIn,false);
});
test('HTML or validation response displays no pretend QR and preserves playback',async()=>{
  const {page,timers}=load([home,{body:'<html>challenge</html>'},{body:'<html>challenge</html>'}]);
  page.data.src='https://example.com/current.mp4';
  await page.startLogin(); assert.equal(page.data.loginState,'error'); assert.equal(page.data.loginQr,'');
  assert.equal(page.data.src,'https://example.com/current.mp4');assert.equal(timers.size,0);
});
test('cancel discards a delayed QR and stops polling',async()=>{
  let resolve; const {page,timers}=load([home,()=>new Promise(r=>resolve=r)]);
  const pending=page.startLogin(); await new Promise(setImmediate); page.closeLogin();
  resolve({status:200,headers:{get:()=>null},text:async()=>JSON.stringify(qr.body)}); await pending;
  assert.equal(page.data.loginVisible,false);assert.equal(page.data.loginQr,'');assert.equal(timers.size,0);
});
test('confirmed QR requires a verified account and session cookie before switching feed',async()=>{
  const h=load([home,qr,{body:{data:{status:'3',redirect_url:'https://www.douyin.com/passport/sso/login/callback/?ticket=secret'}}},
    {body:'ok',headers:{'set-cookie':'sessionid=credential; Domain=.douyin.com; Path=/; Secure; HttpOnly'}},
    {body:{status_code:0,data:{id_str:'account1',nickname:'测试用户'}}}]);
  await h.page.startLogin(); await h.page.pollLogin(h.page.loginAttempt);
  assert.equal(h.page.data.loggedIn,true);assert.equal(h.page.data.loginVisible,false);assert.equal(h.page.data.accountName,'测试用户');
  assert.equal(h.feedCalls(),1);assert.equal(h.timers.size,0);
  assert.equal(h.page.authHeaders().Cookie.includes('sessionid=credential'),true);
});
test('redirect without a session cookie is not accepted as logged in',async()=>{
  const {page}=load([home,qr,{body:{data:{status:'3',redirect_url:'https://www.douyin.com/passport/sso/login/callback/'} }},{body:'ok'},{body:{status_code:0,data:{id:'1',nickname:'name'}}}]);
  await page.startLogin(); await page.pollLogin(page.loginAttempt);assert.equal(page.data.loggedIn,false);assert.equal(page.data.loginState,'error');
});
test('untrusted redirect is rejected before transmitting cookies',async()=>{
  const {page,requests}=load([home,qr,{body:{data:{status:'3',redirect_url:'https://www.douyin.com.evil.example/callback'}}}]);
  await page.startLogin();await page.pollLogin(page.loginAttempt);assert.equal(requests.length,3);assert.equal(page.data.loggedIn,false);
});
test('expired QR clears image and does not poll forever',async()=>{
  const {page,timers}=load([home,qr,{body:{data:{status:'5'}}}]);await page.startLogin();await page.pollLogin(page.loginAttempt);
  assert.equal(page.data.loginState,'expired');assert.equal(page.data.loginQr,'');assert.equal(timers.size,0);
});
test('hide/unload cancels login and a verified session does not reopen login on wake',async()=>{
  const {page,timers}=load([home,qr]);await page.startLogin();page.onHide();assert.equal(timers.size,0);assert.equal(page.data.loginVisible,false);
  page.data.loggedIn=true;await page.onVoiceWakeup({});assert.equal(page.data.loginVisible,false);
  page.onUnload();
});
test('cookie jar respects domains, paths, deletion and expiry',()=>{
  const {ctx}=load();const jar=[];
  ctx.saveLoginCookies(jar,'https://sso.douyin.com/get_qrcode/', 'sid=one; Path=/; Secure, sessionid=two; Domain=.douyin.com; Path=/');
  assert.equal(ctx.loginCookieHeader(jar,'https://www.douyin.com/'),'sessionid=two');
  ctx.saveLoginCookies(jar,'https://sso.douyin.com/','injected=x; Domain=evil.example; Path=/');
  assert.equal(jar.some(c=>c.name==='injected'),false);
  ctx.saveLoginCookies(jar,'https://www.douyin.com/','sessionid=; Domain=.douyin.com; Path=/; Max-Age=0');
  assert.equal(ctx.loginCookieHeader(jar,'https://www.douyin.com/'),'');
});
test('logout discards authenticated queues and starts anonymous feed',()=>{
  const h=load();h.page.data.loggedIn=true;h.page.items=[{id:'private'}];h.page.logout();
  assert.equal(h.page.data.loggedIn,false);assert.equal(h.page.items.length,0);assert.equal(h.page.data.src,'');assert.equal(h.feedCalls(),1);
});

test('Ink newline-separated Set-Cookie preserves both cookies and Expires commas',()=>{
 const {ctx}=load();const jar=[];
 ctx.saveLoginCookies(jar,'https://www.douyin.com/','sessionid=one; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT\nother=two; Path=/');
 assert.equal(ctx.loginCookieHeader(jar,'https://www.douyin.com/'),'sessionid=one; other=two');
});
test('verified feed uses authenticated cookies and forbids automatic redirects',async()=>{
 const h=load([{body:{status_code:0,aweme_list:[]}}]);h.page.data.loggedIn=true;
 h.page.loginJar=[{name:'sessionid',value:'test',domain:'douyin.com',path:'/',hostOnly:false,expires:Infinity}];
 await h.realRequestFeed.call(h.page);
 assert.equal(h.requests[0].options.headers.Cookie,'sessionid=test');assert.equal(h.requests[0].options.redirect,'error');
});
test('logout rejects a late authenticated feed response',async()=>{
 let resolve;const h=load([()=>new Promise(r=>resolve=r)]);h.page.data.loggedIn=true;
 h.page.loginJar=[{name:'sessionid',value:'test',domain:'douyin.com',path:'/',hostOnly:false,expires:Infinity}];
 const pending=h.realRequestFeed.call(h.page);await new Promise(setImmediate);h.page.logout();
 resolve({status:200,text:async()=>JSON.stringify({status_code:0,aweme_list:[{aweme_id:'private',video:{play_addr_h264:{url_list:['https://example.com/a.mp4']}}}]})});
 await pending;assert.equal(h.page.items.length,0);assert.equal(h.page.data.src,'');
});
test('expired authentication and HTTP 401 return to anonymous mode',async()=>{
 const h=load([{status:401,body:{}}]);h.page.data.loggedIn=true;
 h.page.loginJar=[{name:'sessionid',value:'test',domain:'douyin.com',path:'/',hostOnly:false,expires:Infinity}];
 await h.realRequestFeed.call(h.page);assert.equal(h.page.data.loggedIn,false);assert.equal(h.feedCalls(),1);
 h.page.data.loggedIn=true;h.page.loginJar=[];await h.realRequestFeed.call(h.page);assert.equal(h.page.data.loggedIn,false);
});

test('late anonymous bootstrap cannot replace authenticated session headers',async()=>{
 const h=load();let finishHome;
 h.ctx.wx={request(options){if(options.url.includes('ttwid'))options.success({statusCode:200,cookies:[]});else finishHome=options.success;}};
 const pending=h.realRequestFeed.call(h.page);h.page.resetFeedSession();h.page.data.loggedIn=true;
 h.page.loginJar=[{name:'sessionid',value:'new',domain:'douyin.com',path:'/',hostOnly:false,expires:Infinity}];
 finishHome({statusCode:200,cookies:['guest=old; Path=/'],data:''});await pending;
 assert.equal(h.page.feedSessionHeaders,null);assert.equal(h.requests.length,0);
});
test('site refusal 4031 is reported without exposing response or token',async()=>{
 const {page}=load([home,{body:{data:{error_code:4031,description:'remote text'}}},{body:'<html></html>'}]);
 await page.startLogin();assert.match(page.data.loginMessage,/4031/);assert.equal(page.data.loginQr,'');
});
