const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const response = ids => ({status:200,text:async()=>JSON.stringify({status_code:0,aweme_list:ids.map(id=>({aweme_id:id,desc:id,video:{play_addr_h264:{url_list:['https://example.com/'+id+'.mp4']}}}))})});
function player(ids=['1','2']) {
  const pending=[];
  const src=fs.readFileSync('pages/index/index.ink','utf8').split('<script setup>')[1].split('</script>')[0].replace('export default {','globalThis.page = {');
  const context={console:{log(){}},fetch:(url,options)=>new Promise((resolve,reject)=>pending.push({url,options,resolve,reject}))};
  vm.runInNewContext(src,context);const page=context.page;
  page.data={...page.data};page.setData=u=>Object.assign(page.data,u);
  page.items=ids.map(id=>({id,title:id,urls:['https://example.com/'+id+'.mp4']}));
  page.feedSessionHeaders={Cookie:'ttwid=guest'};page.urlIndex=0;page.showItem();
  return {page,pending};
}
const flush=()=>new Promise(setImmediate);
test('playing first video fetches ahead silently without changing video, status or source',async()=>{
 const {page,pending}=player();page.onPlaying();
 assert.equal(pending.length,1);assert.equal(page.data.status,'播放中');assert.equal(page.data.loadingNext,false);
 const source=page.data.src;pending[0].resolve(response(['3','4']));await flush();
 assert.equal(page.items.length,4);assert.equal(page.data.count,4);assert.equal(page.data.current,0);assert.equal(page.data.src,source);assert.equal(page.data.status,'播放中');
 page.next();page.next();assert.equal(page.data.src,'https://example.com/3.mp4');assert.equal(pending.length,1);
});
test('repeated playing events share one prefetch and do not fetch again for the same video',async()=>{
 const {page,pending}=player();page.onPlaying();page.onPlaying();assert.equal(pending.length,1);
 pending[0].resolve(response(['3']));await flush();page.onPlaying();assert.equal(pending.length,1);
});
test('two or more already cached next videos need no network refill',()=>{
 const {page,pending}=player(['1','2','3','4']);page.onPlaying();assert.equal(pending.length,0);
 page.next();page.next();page.onPlaying();assert.equal(pending.length,1);
});
test('navigation at empty boundary waits for the existing prefetch without another request',async()=>{
 const {page,pending}=player(['1']);page.onPlaying();assert.equal(pending.length,1);
 page.next();page.next();assert.equal(page.data.loadingNext,true);assert.equal(pending.length,1);
 pending[0].resolve(response(['2','3']));await flush();
 assert.equal(page.data.src,'https://example.com/2.mp4');assert.equal(page.data.loadingNext,false);
});
test('moving back cancels an automatic jump when the pending prefetch finishes',async()=>{
 const {page,pending}=player();page.onPlaying();page.next();page.next();page.previous();
 assert.equal(page.data.loadingNext,false);pending[0].resolve(response(['3']));await flush();assert.equal(page.data.current,0);assert.equal(page.data.src,'https://example.com/1.mp4');
});
test('background failure leaves playing state and permits an explicit boundary retry',async()=>{
 const {page,pending}=player(['1']);page.onPlaying();pending[0].reject(Error('offline'));await flush();
 assert.equal(page.data.status,'播放中');assert.equal(page.data.playing,true);assert.equal(page.data.loadingNext,false);
 page.onPlaying();assert.equal(pending.length,1);page.next();assert.equal(pending.length,2);
 pending[1].resolve(response(['2']));await flush();assert.equal(page.data.current,1);
});
test('duplicates and empty prefetch do not replace status or start a retry loop',async()=>{
 const {page,pending}=player();page.onPlaying();pending[0].resolve(response(['1','2']));await flush();
 assert.equal(page.items.length,2);assert.equal(page.data.status,'播放中');assert.equal(pending.length,1);
 page.next();page.onPlaying();assert.equal(pending.length,2);pending[1].resolve(response([]));await flush();assert.equal(page.data.status,'播放中');
});
test('prefetch retains previous videos and de-duplicates overlap',async()=>{
 const {page,pending}=player();page.onPlaying();pending[0].resolve(response(['2','3','4']));await flush();
 assert.deepEqual(Array.from(page.items,x=>x.id),['1','2','3','4']);page.next();page.next();page.previous();assert.equal(page.data.current,1);
});
test('an unloaded page ignores an outstanding prefetch response',async()=>{
 const {page,pending}=player();page.onPlaying();page.onUnload();pending[0].resolve(response(['3']));await flush();assert.equal(page.items.length,2);
});
test('old login query and L key no longer request login',()=>{
 const {page,pending}=player();let feeds=0;page.requestFeed=()=>{feeds++;};page.onLoad({login:'1'});
 page.onKeyUp({code:'KeyL',preventDefault(){throw Error('unexpected key interception');}});
 assert.equal(feeds,1);assert.equal(pending.length,0);assert.equal(page.data.loginVisible,undefined);
});

test('previous at the first video cancels a queued boundary advance',async()=>{
 const {page,pending}=player(['1']);page.onPlaying();page.next();page.previous();
 assert.equal(page.data.loadingNext,false);pending[0].resolve(response(['2']));await flush();assert.equal(page.data.current,0);assert.equal(page.items.length,2);
});
test('failure becomes visible when a user is waiting for a background refill',async()=>{
 const {page,pending}=player(['1']);page.onPlaying();page.next();pending[0].reject(Error('offline'));await flush();
 assert.match(page.data.status,/推荐请求失败/);assert.equal(page.data.loadingNext,false);assert.equal(page.data.src,'https://example.com/1.mp4');
});
