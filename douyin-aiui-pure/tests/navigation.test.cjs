const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const item = id => ({id, title:id, urls:['https://example.com/' + id + '.mp4']});
const response = ids => JSON.stringify({aweme_list: ids.map(id => ({aweme_id:id,desc:id,video:{play_addr_h264:{url_list:['https://example.com/' + id + '.mp4']}}}))});
function player(ids = ['1', '2']) {
  const pending = [];
  const context = {console:{log(){}}, wx:{request({success}) {success({statusCode:200,cookies:[],data:''});}},
    fetch: () => new Promise(resolve => pending.push(resolve))};
  const source = fs.readFileSync('pages/index/index.ink','utf8').split('<script setup>')[1].split('</script>')[0].replace('export default {','globalThis.page = {');
  vm.runInNewContext(source,context);
  const page = context.page;
  page.items = ids.map(item);
  page.data = {...page.data,current:ids.length - 1,count:ids.length};
  page.setData = value => Object.assign(page.data,value);
  page.urlIndex = 0;
  page.showItem();
  return {page,pending};
}
async function complete(pending, ids, index = 0) {
  await new Promise(resolve => setImmediate(resolve));
  pending[index]({status:200,text:async () => response(ids)});
  await new Promise(resolve => setImmediate(resolve));
}

test('next batch preserves previous videos and up can cross the batch boundary', async () => {
  const {page,pending} = player();
  page.next();
  assert.equal(page.data.loadingNext,true);
  await complete(pending,['3','4']);
  assert.equal(page.data.loadingNext,false);
  assert.equal(page.items.length,4);
  assert.equal(page.data.src,'https://example.com/3.mp4');
  page.previous();
  assert.equal(page.data.src,'https://example.com/2.mp4');
});

test('rapid next requests at the boundary share one feed request', async () => {
  const {page,pending} = player();
  page.next(); page.next(); page.next();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length,1);
  await complete(pending,['3']);
  assert.equal(page.items.length,3);
});

test('a late batch response does not override a user who already moved back', async () => {
  const {page,pending} = player();
  page.next();
  page.previous();
  await complete(pending,['3']);
  assert.equal(page.items.length,3);
  assert.equal(page.data.current,0);
  assert.equal(page.data.src,'https://example.com/1.mp4');
});

test('overlapping batches do not replay duplicates', async () => {
  const {page,pending} = player();
  page.next();
  await complete(pending,['2','3']);
  assert.deepEqual(Array.from(page.items, value => value.id),['1','2','3']);
  assert.equal(page.data.src,'https://example.com/3.mp4');
});

test('video loading feedback clears on playback and when all candidates fail', () => {
  const {page} = player();
  assert.equal(page.data.loadingVideo,true);
  page.onPlaying();
  assert.equal(page.data.loadingVideo,false);
  page.previous();
  assert.equal(page.data.loadingVideo,true);
  page.onError({detail:{message:'failed'}});
  assert.equal(page.data.loadingVideo,false);
});

test('a batch containing only old videos preserves the current video and allows retry', async () => {
  const {page,pending} = player();
  page.next();
  await complete(pending,['1','2']);
  assert.equal(page.data.current,1);
  assert.equal(page.data.src,'https://example.com/2.mp4');
  page.next();
  await complete(pending,['3'],1);
  assert.equal(page.data.src,'https://example.com/3.mp4');
});
