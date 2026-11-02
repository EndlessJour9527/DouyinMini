<script setup>
const BASE = 'https://www.douyin.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Referer': 'https://www.douyin.com/',
};
const FEED = BASE + '/aweme/v1/web/tab/feed/?device_platform=webapp&aid=6383&channel=channel_pc_web&count=6&refresh_index=0&update_version_code=170400&pc_client_type=1&version_code=170400&version_name=17.4.0&cookie_enabled=true&platform=PC';
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
  data: { title:'纯 AIUI 抖音推荐验证', status:'正在请求抖音…', details:'', src:'', playing:false, current:0, count:0 },
  onLoad(query) {
    this.items = []; this.urlIndex = 0;
    if (query && query.mode === 'player-test') {
      const testVideoUrl = String(query.testVideoUrl || '');
      if (!/^https:\/\//.test(testVideoUrl)) {
        this.setData({status:'请通过 testVideoUrl 指定有权使用的 HTTPS 测试视频',src:'',playing:false});
        return;
      }
      this.setData({title:'AIUI 播放器验证素材',status:'正在加载指定测试视频…',src:testVideoUrl,playing:true});
    } else this.requestFeed();
  },
  async requestFeed() {
    this.setData({status:'正在建立匿名会话…', details:''});
    try {
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
      this.setData({status:'正在请求推荐接口…'});
      const response = await fetch(FEED, {headers, timeout:15000});
      const body = await response.text();
      let data; try { data = JSON.parse(body); } catch (_) {
        const description = 'HTTP ' + response.status + (body.trim() === 'blocked' ? '，服务返回 blocked' : '，响应非 JSON，长度 ' + body.length) + (challenge ? '；首页要求会话校验' : '');
        console.log('[douyin-aiui] feed ' + description);
        this.setData({status:'推荐请求未返回视频', details:description}); return;
      }
      const items = extract(data);
      const details = 'HTTP ' + response.status + '，status_code=' + String(data.status_code ?? '无') + '，可播放候选=' + items.length;
      console.log('[douyin-aiui] feed ' + details);
      if (!items.length) { this.setData({status:'未获取到可播放推荐', details}); return; }
      this.items = items; this.urlIndex = 0;
      this.setData({count:items.length,current:0,details}); this.showItem();
    } catch (e) {
      const message = '网络请求失败或超时';
      console.log('[douyin-aiui] request error: ' + message);
      this.setData({status:'推荐请求失败',details:message});
    }
  },
  showItem() {
    const item = this.items[this.data.current]; if (!item) return;
    if (this.urlIndex >= item.urls.length) { this.setData({status:'该视频的候选线路均失败'}); return; }
    this.setData({src:item.urls[this.urlIndex],title:item.title,status:'正在加载视频…',playing:true});
  },
  next() { if (this.data.current + 1 < this.items.length) { this.urlIndex=0; this.setData({current:this.data.current+1}); this.showItem(); } else this.requestFeed(); },
  previous() { if (this.data.current > 0) { this.urlIndex=0; this.setData({current:this.data.current-1}); this.showItem(); } },
  toggle() { const v=wx.createVideoContext('player'); if (!v || !this.data.src) return; if(this.data.playing) v.pause(); else v.play(); },
  onPlaying() { console.log('[douyin-aiui] video playing'); this.setData({status:'播放中',playing:true}); },
  onPause() { this.setData({playing:false}); },
  onTime(e) { const t = Number(e && e.detail && e.detail.currentTime) || 0; if (t > 1 && !this.playbackConfirmed) { this.playbackConfirmed=true; console.log('[douyin-aiui] playback advanced beyond 1 second'); } },
  onEnded() { this.next(); },
  onError(e) { const msg = String(e?.detail?.message || 'unknown').replace(/https?:\/\/[^\s]+/g, '[url]'); console.log('[douyin-aiui] video error: ' + msg);  if (!this.items.length) { this.setData({status:'测试视频播放失败'}); return; } this.urlIndex++; this.showItem(); },
};
</script>
<template>
  <view class="page">
    <video id="player" class="video" src="{{src}}" autoplay="{{true}}" object-fit="contain" bindplaying="onPlaying" bindpause="onPause" bindtimeupdate="onTime" bindended="onEnded" binderror="onError" />
    <view class="info"><text class="title">{{title}}</text><text class="status">{{status}}</text><text class="details">{{details}}</text></view>
    <view class="controls"><text class="button" bindtap="previous">上一条</text><text class="button" bindtap="toggle">播放 / 暂停</text><text class="button" bindtap="next">下一条 / 重试</text></view>
  </view>
</template>
<style>
.page { width:100%; height:100%; background-color:#000; display:flex; flex-direction:column; }
.video { width:100%; flex:1; }
.info { padding:10px; }
.title { color:#fff; font-size:16px; }
.status { color:#ffb8c4; font-size:14px; }
.details { color:#aaa; font-size:12px; }
.controls { height:48px; display:flex; flex-direction:row; justify-content:space-around; align-items:center; background-color:#222; }
.button { color:#fff; font-size:14px; padding:8px; }
</style>
