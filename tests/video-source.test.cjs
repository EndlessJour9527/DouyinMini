const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/src/main/assets/hongguo/douyin_hongguo.js', 'utf8');
const context = vm.createContext({isGimbalQualityEnhanced:()=>true});
const constants = source.match(/var (?:TARGET_RESOLUTION|MAX_VIDEO_SHORT_EDGE) = [^;]+;/g).join('\n');
vm.runInContext(constants + source.slice(source.indexOf('  function normalizeHttps'), source.indexOf('  function extractCoverUrl')), context);
const addr = (edge, url) => ({width: edge * 16 / 9, height: edge, url_list: [url]});
const rate = (edge, bps, url, rest={}) => ({play_addr:addr(edge,url),bit_rate:bps,...rest});

test('prefers 1080p AVC and high bitrate, with 720/540 fallback', () => {
  const video = {bit_rate:[rate(540,800000,'https://cdn/540'),rate(1080,1000000,'https://cdn/1080-low'),
    rate(1080,4000000,'https://cdn/1080-high'),rate(720,2000000,'https://cdn/720')]};
  assert.deepEqual(Array.from(context.extractPlayUrls(video)),
    ['https://cdn/1080-high','https://cdn/1080-low','https://cdn/720','https://cdn/540']);
  assert.equal(video.__hgSelectedQuality, '1080P');
});

test('preserves quality order across direct and redirect CDNs', () => {
  const video={bit_rate:[rate(1080,4000000,'https://cdn/high'),
    rate(540,500000,'https://www.douyin.com/aweme/v1/play?video_id=low')]};
  assert.equal(context.extractPlayUrls(video)[0], 'https://cdn/high');
});

test('excludes silent DASH and oversized sources, deduplicates URLs', () => {
  const video={bit_rate:[rate(1080,9000000,'https://cdn/silent',{format:'dash'}),
    rate(2160,10000000,'https://cdn/4k'),rate(720,1000000,'https://cdn/720'),
    rate(720,1000000,'https://cdn/720')]};
  assert.deepEqual(Array.from(context.extractPlayUrls(video)),['https://cdn/720']);
});

test('off restores the original 540p cap, low-bitrate order and global redirect priority', () => {
  const video={bit_rate:[rate(1080,4000000,'https://cdn/hd'),rate(720,2000000,'https://cdn/720'),
    rate(540,900000,'https://cdn/540-high'),rate(540,300000,'https://cdn/540-low'),
    rate(480,200000,'https://www.douyin.com/aweme/v1/play?video_id=480')]};
  assert.deepEqual(Array.from(context.extractPlayUrls(video,false)),[
    'https://www.douyin.com/aweme/v1/play?video_id=480','https://cdn/540-low','https://cdn/540-high']);
});

test('a cached metadata object can select both profiles without retaining HD URLs in off', () => {
  const video={bit_rate:[rate(1080,4000000,'https://cdn/hd'),rate(540,300000,'https://cdn/original')]};
  assert.equal(context.extractPlayUrls(video,true)[0],'https://cdn/hd');
  assert.deepEqual(Array.from(context.extractPlayUrls(video,false)),['https://cdn/original']);
  assert.equal(context.extractPlayUrls(video,true)[0],'https://cdn/hd');
});

vm.runInContext(source.slice(source.indexOf('  function selectItemQuality'),source.indexOf('  function applyQualityProfile')), context);
test('quality changes invalidate old cached HD URLs and preserve profile lists', () => {
  const stale={urls:['https://cdn/old-hd']};
  context.selectItemQuality(stale,false);
  assert.deepEqual(Array.from(stale.urls),[]);
  const item={urls:['https://cdn/hd'],sourceQualityEnhanced:true,qualityProfiles:{
    original:{urls:['https://cdn/540'],label:'540P'},enhanced:{urls:['https://cdn/hd'],label:'1080P'}}};
  context.selectItemQuality(item,false);
  assert.deepEqual(Array.from(item.urls),['https://cdn/540']);
  item.urls.push('https://cdn/temporary');
  assert.equal(item.qualityProfiles.original.urls.length,1);
  context.selectItemQuality(item,true);
  assert.deepEqual(Array.from(item.urls),['https://cdn/hd']);
});

function switchingHarness(item, paused=false) {
  const pending=[],started=[];
  const video={currentTime:42.25,paused,pause(){this.paused=true;},removeAttribute(){},load(){}};
  const preload={paused:false,pause(){this.paused=true;},removeAttribute(){this.cleared=true;},load(){}};
  const ctx=vm.createContext({qualityProfileEnabled:true,qualitySwitchVersion:0,qualityResume:null,
    nativeQuality:false,isGimbalQualityEnhanced:()=>ctx.nativeQuality,
    state:{queue:[item],pendingPool:[],view:'player',preloadedUrl:'https://cdn/old-hd'},
    dom:{video,preloadVideo:preload},currentItem:()=>item,setTimeout:()=>0,
    clearVideoStallTimer(){},renderCommandMenu(){},syncGimbalActivity(){},showStageStatus(){},
    startVideoUrl:value=>started.push(value),fetchAwemeDetail:(id,callback)=>pending.push(callback)});
  vm.runInContext(source.slice(source.indexOf('  function selectItemQuality'),source.indexOf('  function toggleGimbalMode')),ctx);
  return {ctx,video,preload,pending,started};
}

test('a quality change retains the exact paused position and clears the preloader', () => {
  const item={id:'123456',sourceQualityEnhanced:true,urls:['hd'],qualityProfiles:{original:{urls:['sd'],label:'540P'}}};
  const {ctx,video,preload,started}=switchingHarness(item,true);
  ctx.applyQualityProfile(false);
  assert.equal(ctx.qualityResume.time,42.25);
  assert.equal(ctx.qualityResume.paused,true);
  assert.equal(video.paused,true);
  assert.equal(preload.cleared,true);
  assert.equal(ctx.state.preloadedUrl,'');
  assert.equal(started.length,1);
  assert.deepEqual(Array.from(started[0].urls),['sd']);
});

test('rapid switches discard a late detail response from the previous quality', () => {
  const item={id:'123456',sourceQualityEnhanced:true,urls:['old-hd']};
  const {ctx,pending,started}=switchingHarness(item);
  ctx.applyQualityProfile(false);
  ctx.nativeQuality=true;
  ctx.applyQualityProfile(true);
  pending[0]({id:item.id,urls:['stale-sd']});
  assert.equal(started.length,0);
  pending[1]({id:item.id,urls:['current-hd']});
  assert.equal(started.length,1);
  assert.deepEqual(started[0].urls,['current-hd']);
});
