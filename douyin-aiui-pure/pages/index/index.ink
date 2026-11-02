<script type="application/json" def>
{
  "navigationBarTitleText": "抖音短视频",
  "description": "打开抖音推荐短视频播放器。当用户说打开抖音、刷抖音、刷短视频或看抖音推荐视频时使用。支持连续播放、上下滑动切换、单击隐藏标题及全屏显示。",
  "disableScroll": true
}
</script>

<script setup>
const BASE = 'https://www.douyin.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://www.douyin.com/',
};
const FEED = BASE + '/aweme/v1/web/tab/feed/?device_platform=webapp&aid=6383&channel=channel_pc_web&count=6&refresh_index=0&update_version_code=170400&pc_client_type=1&version_code=170400&version_name=17.4.0&cookie_enabled=true&platform=PC';
// Web-session experiment: all credentials stay in memory and out of reactive UI data.
const LOGIN_HOSTS = ['www.douyin.com', 'sso.douyin.com', 'login.douyin.com'];
function loginURL(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.port || u.username || u.password || !LOGIN_HOSTS.includes(u.hostname)) throw new Error('登录地址不受支持');
  return u;
}
function saveLoginCookies(jar, url, header) {
  const u = loginURL(url), now = Date.now();
  // Headers.get merges repeated Set-Cookie fields. Do not split the comma in Expires.
  String(header || '').split(/\r?\n|,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/).forEach(line => {
    const parts = line.trim().split(';'), pair = parts.shift(), i = pair.indexOf('=');
    if (i <= 0) return;
    const name = pair.slice(0,i), value = pair.slice(i+1);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\x00-\x20\x7f;,]/.test(value)) return;
    const attrs = {};
    parts.forEach(p => { const k=p.indexOf('='); attrs[(k<0?p:p.slice(0,k)).trim().toLowerCase()]=k<0?'':p.slice(k+1).trim(); });
    const domain = (attrs.domain || u.hostname).replace(/^\./,'').toLowerCase();
    if (domain !== 'douyin.com' && !LOGIN_HOSTS.includes(domain)) return;
    if (u.hostname !== domain && !u.hostname.endsWith('.'+domain)) return;
    const path = attrs.path?.startsWith('/') ? attrs.path : u.pathname.slice(0,u.pathname.lastIndexOf('/')+1) || '/';
    let expires = attrs.expires ? Date.parse(attrs.expires) : Infinity;
    if (!Number.isFinite(expires)) expires=Infinity;
    if (/^-?\d+$/.test(attrs['max-age'] || '')) expires=now+Number(attrs['max-age'])*1000;
    if (name.startsWith('__Secure-') && !('secure' in attrs)) return;
    if (name.startsWith('__Host-') && (!('secure' in attrs) || attrs.domain || path!=='/')) return;
    for(let j=jar.length-1;j>=0;j--) if(jar[j].name===name && jar[j].domain===domain && jar[j].path===path) jar.splice(j,1);
    if(expires>now) jar.push({name,value,domain,path,hostOnly:!attrs.domain,expires});
  });
}
function loginCookieHeader(jar, url) {
  const u=loginURL(url);
  return jar.filter(c=>c.expires>Date.now() && (c.domain===u.hostname || (!c.hostOnly && u.hostname.endsWith('.'+c.domain))) && (u.pathname===c.path || u.pathname.startsWith(c.path.endsWith('/')?c.path:c.path+'/')))
    .sort((a,b)=>b.path.length-a.path.length).map(c=>c.name+'='+c.value).join('; ');
}
async function loginRequest(attempt, url, options={}) {
  loginURL(url);
  if(attempt.cancelled) throw new Error('登录已取消');
  const headers=Object.assign({},HEADERS,options.headers);
  const cookie=loginCookieHeader(attempt.jar,url); if(cookie) headers.Cookie=cookie;
  const response=await fetch(url,{...options,headers,redirect:'manual',timeout:15000,signal:attempt.controller?.signal});
  if(attempt.cancelled) throw new Error('登录已取消');
  saveLoginCookies(attempt.jar,url,response.headers.get('set-cookie'));
  const text=await response.text();
  let json=null; try{json=JSON.parse(text);}catch(_){}
  return {status:response.status,json,location:response.headers.get('location')};
}

function extract(data) {
  const found = [], seen = {};
  function visit(n, depth) {
    if (!n || typeof n !== 'object' || depth > 7) return;
    if (Array.isArray(n)) { n.forEach(x => visit(x, depth + 1)); return; }
    const a = n.aweme_info || n, v = a.video;
    if (a.aweme_id && v && !seen[a.aweme_id]) {
      const urls = [];
      function add(addr) { if (addr && Array.isArray(addr.url_list)) addr.url_list.forEach(u => { if (typeof u === 'string' && /^https:\/\//.test(u) && !urls.includes(u)) urls.push(u); }); }
      add(v.play_addr_h264); add(v.play_addr_lowbr);
      (v.bit_rate || []).forEach(b => { let e = {}; try { e = JSON.parse(b.video_extra || '{}'); } catch (_) {} if (!b.is_h265 && !b.is_bytevc1 && String(b.format || e.format || '').toLowerCase() !== 'dash' && !e.audio_file_id) add(b.play_addr); });
      if (urls.length) { seen[a.aweme_id] = true; found.push({id:String(a.aweme_id), title:String(a.desc || '抖音视频'), author:String((a.author || {}).nickname || ''), urls}); }
    }
    ['aweme_list','aweme_detail','data','cards','aweme','items','mix_items','general_search_data','cell_info'].forEach(k => visit(n[k], depth + 1));
  }
  visit(data, 0); return found;
}
export default {
  data: { title:'纯 AIUI 抖音推荐验证', status:'正在请求抖音…', details:'', src:'', playing:false, current:0, count:0, fullscreen:false, infoVisible:true, loadingNext:false, loadingVideo:false, loginVisible:false, loginState:'idle', loginQr:'', loginMessage:'', loggedIn:false, accountName:'' },
  onLoad(query) {
    this.items = []; this.urlIndex = 0;
    if (query && query.mode === 'player-test') {
      const testVideoUrl = String(query.testVideoUrl || '');
      if (!/^https:\/\//.test(testVideoUrl)) {
        this.setData({status:'请通过 testVideoUrl 指定有权使用的 HTTPS 测试视频',src:'',playing:false});
        return;
      }
      this.setData({title:'AIUI 播放器验证素材',status:'正在加载指定测试视频…',src:testVideoUrl,playing:true});
    } else { this.requestFeed(); if(query && query.login==='1') this.startLogin(); }
  },
  onVoiceWakeup() { if (!this.data.loggedIn && !this.data.loginVisible) return this.startLogin(); },
  async startLogin() {
    if(this.data.loggedIn) return;
    this.closeLogin(); this.swipeStart=null;
    const a={jar:[],cancelled:false,deadline:Date.now()+180000,controller:typeof AbortController==='function'?new AbortController():null};
    this.loginAttempt=a;
    this.setData({loginVisible:true,loginState:'loading',loginQr:'',loginMessage:'正在获取抖音登录二维码…'});
    try {
      await loginRequest(a,BASE+'/');
      const profiles=[{origin:BASE,prefix:'/passport/web/',passport:true},{origin:'https://sso.douyin.com',prefix:'/',passport:false}];
      for(const p of profiles){
        const query='aid=6383&service='+encodeURIComponent(BASE+'/')+'&language=zh&is_new_login=1&need_logo=false';
        const r=await loginRequest(a,p.origin+p.prefix+'get_qrcode/?'+query);
        if(this.loginAttempt!==a || a.cancelled) return;
        const d=r.json?.data;
        const code=d?.error_code ?? r.json?.error_code ?? r.json?.status_code;
        if(typeof code==='number' && code!==0) a.failureCode=code;
        console.log('[douyin-login] get_qrcode HTTP '+r.status+', json='+Boolean(r.json)+', error_code='+(typeof code==='number'?code:'none')+', has_qr='+Boolean(d?.qrcode));
        if(r.status!==200 || (code!=null && Number(code)!==0) || typeof d?.token!=='string' || !d.token || !/^iVBOR[A-Za-z0-9+/=\r\n]+$/.test(d.qrcode || '') || d.qrcode.length>1000000) continue;
        a.token=d.token; a.profile=p; a.query=query;
        this.setData({loginState:'waiting',loginQr:'data:image/png;base64,'+d.qrcode.replace(/[\r\n]/g,''),loginMessage:'请使用手机抖音扫一扫，并在手机上确认'});
        this.scheduleLoginPoll(a); return;
      }
      throw new Error('取码失败');
    }catch(_){
      if(this.loginAttempt===a && !a.cancelled) this.loginFailed(a.failureCode===4031?'抖音暂未允许本次登录请求（4031），可重试或继续匿名观看':'暂时无法获取二维码，可重试或继续匿名观看');
    }
  },
  scheduleLoginPoll(a) {
    if(this.loginAttempt!==a || a.cancelled) return;
    if(a.timer!=null) clearTimeout(a.timer);
    a.timer=setTimeout(()=>this.pollLogin(a),2000);
  },
  async pollLogin(a) {
    if(this.loginAttempt!==a || a.cancelled) return;
    if(a.timer!=null) clearTimeout(a.timer);
    if(Date.now()>=a.deadline){this.loginFailed('二维码已过期，请重新获取','expired');return;}
    try{
      const p=a.profile, token=encodeURIComponent(a.token);
      const options=p.passport?{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'token='+token+'&is_new_login=1&need_short_url=true&next='+encodeURIComponent(BASE+'/')}:{};
      const r=await loginRequest(a,p.origin+p.prefix+'check_qrconnect/?'+a.query+'&token='+token,options);
      if(this.loginAttempt!==a || a.cancelled) return;
      const d=r.json?.data;
      if(r.status!==200 || !d || (d.error_code!=null && Number(d.error_code)!==0)) throw new Error('状态查询失败');
      const state=String(d.status);
      if(state==='5' || state==='expired'){this.loginFailed('二维码已过期，请重新获取','expired');return;}
      if(state==='3' || state==='confirmed'){
        if(typeof d.redirect_url!=='string') throw new Error('缺少登录回调');
        let url=d.redirect_url;
        for(let hop=0;hop<6;hop++){
          loginURL(url);
          const callback=await loginRequest(a,url);
          if(callback.status>=300 && callback.status<400 && callback.location){url=new URL(callback.location,url).href;continue;}
          if(callback.status<200 || callback.status>=300) throw new Error('回调失败');
          url=null;break;
        }
        if(url) throw new Error('重定向次数过多');
        const me=await loginRequest(a,BASE+'/webcast/user/me/?aid=1128');
        if(this.loginAttempt!==a || a.cancelled) return;
        const user=me.json?.data;
        const authenticated=/(?:^|; )(?:sessionid|sessionid_ss)=([^;]+)/.test(loginCookieHeader(a.jar,BASE+'/'));
        if(me.status!==200 || me.json?.status_code!==0 || !user || !(user.id_str || user.id || user.user_id) || !authenticated) throw new Error('登录态未验证');
        this.loginJar=a.jar.slice();
        this.closeLogin();
        this.setData({loggedIn:true,accountName:String(user.nickname || '抖音用户')});
        this.resetFeedSession(); this.requestFeed(); return;
      }
      if(!['1','2','new','scanned'].includes(state)) throw new Error('未知扫码状态');
      this.setData({loginState:state==='2'||state==='scanned'?'scanned':'waiting',loginMessage:state==='2'||state==='scanned'?'已扫码，请在手机抖音上确认':'请使用手机抖音扫一扫，并在手机上确认'});
      this.scheduleLoginPoll(a);
    }catch(_){if(this.loginAttempt===a && !a.cancelled) this.loginFailed('登录未完成或状态验证失败，请重试');}
  },
  loginFailed(message,state='error') {
    this.closeLogin(); this.setData({loginVisible:true,loginState:state,loginQr:'',loginMessage:message});
    console.log('[douyin-login] state='+state);
  },
  closeLogin() {
    const a=this.loginAttempt;
    if(a){a.cancelled=true;if(a.timer!=null) clearTimeout(a.timer);try{a.controller?.abort();}catch(_){}a.token='';a.jar=[];}
    this.loginAttempt=null;
    this.setData({loginVisible:false,loginQr:''});
  },
  authHeaders() {
    return this.data.loggedIn && this.loginJar ? Object.assign({},HEADERS,{Cookie:loginCookieHeader(this.loginJar,BASE+'/')}) : null;
  },
  resetFeedSession() {
    this.authEpoch=(this.authEpoch||0)+1;this.navigationVersion=(this.navigationVersion||0)+1;
    this.feedLoading=false;this.feedSessionHeaders=null;this.feedSessionChallenged=false;this.feedRefreshIndex=0;
    this.items=[];this.urlIndex=0;this.playbackConfirmed=false;
    this.setData({src:'',playing:false,count:0,current:0,loadingNext:false,loadingVideo:false});
  },
  logout() {
    this.closeLogin();this.loginJar=null;
    this.setData({loggedIn:false,accountName:''});this.resetFeedSession();this.requestFeed();
  },
  onUnload() { this.closeLogin();this.loginJar=null; },
  onReady() {
    const surface = this.querySelector('#video-stage');
    this.addEventListener('pointerdown', event => {
      if (this.data.loginVisible) return;
      if (this.swipeStart) { this.swipeStart = null; return; }
      if (event.button !== 0 || !surface) return;
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
      const hitVideo = path.some(node => node === surface || (surface.entityId != null && node && node.entityId === surface.entityId));
      // Older hosts dispatch pointer events at the page, without an entity target.
      // The video stage starts at the page origin; exclude the controls below it.
      const pageOnly = !path.some(node => node && node.entityId != null);
      const withinVideo = event.clientX >= 0 && event.clientX < surface.clientWidth && event.clientY >= 0 && event.clientY < surface.clientHeight;
      if (!hitVideo && !(pageOnly && withinVideo)) return;
      this.swipeStart = {x:event.clientX, y:event.clientY, id:event.pointerId};
    }, true);
    this.addEventListener('pointerup', event => {
      const start = this.swipeStart;
      if (!start || start.id !== event.pointerId) return;
      this.swipeStart = null;
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (Math.abs(dy) < 48 || Math.abs(dy) < Math.abs(dx) * 1.2) return;
      event.preventDefault();
      if (dy < 0) this.previous(); else this.next();
    }, true);
    this.addEventListener('pointercancel', event => {
      if (this.swipeStart && this.swipeStart.id === event.pointerId) this.swipeStart = null;
    }, true);
  },
  onHide() { this.swipeStart = null; this.closeLogin(); },
  onKeyUp(event) {
    if(this.data.loginVisible){if(event.code==='Backspace' || event.code==='Escape'){event.preventDefault();this.closeLogin();}return;}
    if(event.code==='KeyL'){event.preventDefault();this.onVoiceWakeup();return;}
    if (this.data.fullscreen && (event.code === 'Backspace' || event.code === 'Escape')) { event.preventDefault(); this.setData({fullscreen:false}); }
    else if (event.code === 'Enter') { event.preventDefault(); this.toggleInfo(); }
    else if (event.code === 'ArrowUp') { event.preventDefault(); this.previous(); }
    else if (event.code === 'ArrowDown') { event.preventDefault(); this.next(); }
  },
  toggleFullscreen() { this.setData({fullscreen:!this.data.fullscreen}); },
  toggleInfo() { this.setData({infoVisible:!this.data.infoVisible}); },
  async requestFeed() {
    if(this.data.loggedIn && !/(?:^|; )(?:sessionid|sessionid_ss)=[^;]+/.test(this.authHeaders()?.Cookie || '')){this.logout();return;}
    if (this.feedLoading) return;
    this.feedLoading = true;
    this.items = this.items || [];
    const authEpoch = this.authEpoch || 0;
    const navigationVersion = this.navigationVersion || 0;
    const setStatus = update => { if ((this.authEpoch || 0) === authEpoch && (this.navigationVersion || 0) === navigationVersion) this.setData(update); };
    this.setData({loadingNext:this.items.length > 0});
    this.setData({status:this.data.loggedIn?'正在请求登录会话资源…':'正在建立匿名会话…', details:''});
    try {
      if (!this.authHeaders() && !this.feedSessionHeaders) {
        const home = await new Promise((resolve, reject) => wx.request({url:BASE + '/', header:HEADERS, timeout:15000, success:resolve, fail:reject}));
        const cookies = {};
        (home.cookies || []).forEach(c => {
          const pair = String(c).split(';')[0], i = pair.indexOf('=');
          if (i > 0 && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(pair.slice(0, i))) cookies[pair.slice(0, i)] = pair.slice(i + 1);
        });
        try {
          const registration = await new Promise((resolve, reject) => wx.request({
            url:'https://ttwid.bytedance.com/ttwid/union/register/?aid=6383&service=www.douyin.com',
            method:'POST', header:{'Content-Type':'application/json', 'Referer':BASE + '/'},
            data:{aid:6383, service:'www.douyin.com'}, timeout:15000, success:resolve, fail:reject,
          }));
          const cookie = (registration.cookies || []).find(c => String(c).startsWith('ttwid='));
          if (cookie && registration.statusCode === 200) cookies.ttwid = String(cookie).split(';')[0].slice(6);
          console.log('[douyin-aiui] ttwid registration HTTP ' + registration.statusCode + ', issued=' + Boolean(cookies.ttwid));
        } catch (_) { console.log('[douyin-aiui] ttwid registration failed'); }
        const cookiePairs = Object.keys(cookies).map(name => name + '=' + cookies[name]);
        const content = typeof home.data === 'string' ? home.data : '';
        const challenge = content.includes('__ac_nonce') && content.includes('__ac_signature');
        console.log('[douyin-aiui] home HTTP ' + home.statusCode + ', unique cookie names=' + Object.keys(cookies).join(',') + ', challenge=' + challenge);
        const headers = Object.assign({}, HEADERS);
        if (cookiePairs.length) headers.Cookie = cookiePairs.join('; ');
        if((this.authEpoch || 0)!==authEpoch) return;
        this.feedSessionHeaders = headers;
        this.feedSessionChallenged = challenge;
      }
      if((this.authEpoch || 0)!==authEpoch) return;
      const headers = this.authHeaders() || this.feedSessionHeaders;
      const challenge = !!this.feedSessionChallenged;
      setStatus({status:'正在请求推荐接口…'});
      const refreshIndex = this.feedRefreshIndex || 0;
      this.feedRefreshIndex = refreshIndex + 1;
      const feedUrl = FEED.replace('refresh_index=0', 'refresh_index=' + refreshIndex);
      const response = await fetch(feedUrl, {headers, redirect:'error', timeout:15000});
      const body = await response.text();
      if((this.authEpoch || 0)!==authEpoch) return;
      if(response.status===401 && this.data.loggedIn){this.logout();return;}
      if (response.status === 401 || response.status === 403) this.feedSessionHeaders = null;
      let data; try { data = JSON.parse(body); } catch (_) {
        const description = 'HTTP ' + response.status + (body.trim() === 'blocked' ? '，服务返回 blocked' : '，响应非 JSON，长度 ' + body.length) + (challenge ? '；首页要求会话校验' : '');
        console.log('[douyin-aiui] feed ' + description);
        if (body.trim() === 'blocked') this.feedSessionHeaders = null;
        setStatus({status:'推荐请求未返回视频', details:description}); return;
      }
      if (response.status < 200 || response.status >= 300 || (data.status_code != null && data.status_code !== 0)) {
        setStatus({status:'推荐接口暂不可用，请稍后再试',details:'HTTP ' + response.status + '，status_code=' + String(data.status_code ?? '无')});
        return;
      }
      const items = extract(data);
      const details = 'HTTP ' + response.status + '，status_code=' + String(data.status_code ?? '无') + '，可播放候选=' + items.length;
      console.log('[douyin-aiui] feed ' + details);
      const seen = new Set(this.items.map(item => item.id));
      const additions = items.filter(item => !seen.has(item.id));
      console.log('[douyin-aiui] feed refresh=' + refreshIndex + ', candidates=' + items.length + ', added=' + additions.length + ', duplicates=' + (items.length-additions.length));
      if (!items.length) { setStatus({status:'本次未返回可播放的视频，请稍后再试', details}); return; }
      if (!additions.length) { setStatus({status:'本次推荐与已看视频重复，请再试一次', details}); return; }
      const nextIndex = this.items.length;
      this.items.push(...additions);
      if ((this.navigationVersion || 0) === navigationVersion) {
        this.urlIndex = 0;
        this.setData({count:this.items.length,current:nextIndex,details}); this.showItem();
      } else this.setData({count:this.items.length});
    } catch (e) {
      const message = '网络请求失败或超时';
      console.log('[douyin-aiui] request error: ' + message);
      setStatus({status:'推荐请求失败',details:message});
    } finally {
      if((this.authEpoch || 0)===authEpoch){this.feedLoading = false;this.setData({loadingNext:false});}
    }
  },
  showItem() {
    const item = this.items[this.data.current]; if (!item) return;
    if (this.urlIndex >= item.urls.length) { this.setData({status:'该视频的候选线路均失败',loadingVideo:false}); return; }
    this.setData({src:item.urls[this.urlIndex],title:item.title,status:'正在加载视频…',playing:true,loadingVideo:true});
  },
  next() { if (this.data.current + 1 < this.items.length) { this.navigationVersion=(this.navigationVersion || 0)+1; this.urlIndex=0; this.setData({current:this.data.current+1}); this.showItem(); } else this.requestFeed(); },
  previous() { if (this.data.current > 0) { this.navigationVersion=(this.navigationVersion || 0)+1; this.urlIndex=0; this.setData({current:this.data.current-1}); this.showItem(); } else this.setData({status:'已经是最早的一条视频'}); },
  toggle() { const v=wx.createVideoContext('player'); if (!v || !this.data.src) return; if(this.data.playing) v.pause(); else v.play(); },
  onPlaying() { console.log('[douyin-aiui] video playing'); this.setData({status:'播放中',playing:true,loadingVideo:false}); },
  onPause() { this.setData({playing:false}); },
  onTime(e) { const t = Number(e && e.detail && e.detail.currentTime) || 0; if (t > 1 && !this.playbackConfirmed) { this.playbackConfirmed=true; console.log('[douyin-aiui] playback advanced beyond 1 second'); } },
  onEnded() { this.next(); },
  onError(e) { const msg = String(e?.detail?.message || 'unknown').replace(/https?:\/\/[^\s]+/g, '[url]'); console.log('[douyin-aiui] video error: ' + msg);  if (!this.items.length) { this.setData({status:'测试视频播放失败'}); return; } this.urlIndex++; this.showItem(); },
};
</script>
<template>
  <view class="page {{fullscreen ? 'page-fullscreen' : ''}}">
    <view id="video-stage" class="video-stage" bindtap="toggleInfo">
      <video id="player" class="video" src="{{src}}" autoplay="{{true}}" object-fit="contain" bindplaying="onPlaying" bindpause="onPause" bindtimeupdate="onTime" bindended="onEnded" binderror="onError" />
      <text class="loading" ink:if="{{loadingNext || loadingVideo}}">{{loadingNext ? '加载下一条…' : '正在加载视频…'}}</text>
      <view class="info" ink:if="{{infoVisible}}"><text class="title">{{title}}</text><text class="status">{{status}}</text><text class="details">{{details}}</text></view>
      <text class="login-toggle" ink:if="{{!loggedIn}}" catchtap="startLogin">扫码登录</text>
      <text class="login-toggle" ink:if="{{loggedIn}}" catchtap="logout">退出登录</text>
      <text class="fullscreen-toggle" catchtap="toggleFullscreen">{{fullscreen ? '退出全屏' : '全屏'}}</text>
    </view>
    <view class="login-panel" ink:if="{{loginVisible}}">
      <text class="login-title">抖音扫码登录</text>
      <image class="login-qr" ink:if="{{loginQr}}" src="{{loginQr}}" mode="aspectFit" />
      <text class="login-message">{{loginMessage}}</text>
      <view class="login-actions"><text class="login-action" bindtap="startLogin">重新获取</text><text class="login-action" bindtap="closeLogin">继续匿名观看</text></view>
    </view>
  </view>
</template>
<style>
.page { position:relative; width:100%; height:100%; max-height:380px; overflow:clip; background-color:#000; display:flex; flex-direction:column; }
.page-fullscreen { max-height:100%; }
.video-stage { width:100%; min-height:0; flex:1; position:relative; overflow:clip; }
.video { position:absolute; left:0; top:0; width:100%; height:100%; }
.info { position:absolute; left:0; right:0; bottom:0; padding:10px; max-height:96px; overflow:clip; background-color:rgba(0,0,0,0.65); }
.loading { position:absolute; top:12px; left:10px; padding:5px 8px; color:#fff; font-size:14px; background-color:rgba(0,0,0,0.65); }
.fullscreen-toggle { position:absolute; right:8px; top:8px; padding:6px 10px; color:#fff; font-size:14px; background-color:rgba(0,0,0,0.65); }
.login-toggle { position:absolute; left:8px; top:8px; padding:6px 10px; color:#fff; font-size:14px; background-color:rgba(0,0,0,0.65); }
.login-panel { position:absolute; left:0; top:0; width:100%; height:100%; max-height:380px; overflow:clip; background-color:#111; display:flex; flex-direction:column; align-items:center; justify-content:center; }
.login-title { color:#fff; font-size:18px; margin-bottom:6px; }
.login-qr { width:184px; height:184px; flex-shrink:0; background-color:#fff; }
.login-message { color:#fff; font-size:14px; padding:6px 12px; max-height:52px; overflow:clip; }
.login-actions { display:flex; flex-direction:row; justify-content:space-around; width:100%; height:40px; flex-shrink:0; }
.login-action { color:#fff; font-size:14px; padding:8px; }
.title { color:#fff; font-size:16px; }
.status { color:#ffb8c4; font-size:14px; }
.details { color:#aaa; font-size:12px; }
</style>
