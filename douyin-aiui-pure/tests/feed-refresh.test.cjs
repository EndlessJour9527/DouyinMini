const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function player() {
  const urls = [], sessions = [];
  let answer;
  const context = {console:{log(){}},wx:{request(options) {
    sessions.push(options.url);
    options.success({statusCode:200,data:'',cookies:options.url.includes('ttwid.') ? ['ttwid=guest; Path=/'] : ['__ac_nonce=nonce; Path=/']});
  }},fetch:async (url, options) => {
    urls.push({url,headers:options.headers});
    const index = new URL(url).searchParams.get('refresh_index');
    return {status:200,text:async () => JSON.stringify(answer || {status_code:0,aweme_list:[{aweme_id:index,video:{play_addr_h264:{url_list:['https://example.com/' + index]}}}]})};
  }};
  const source = fs.readFileSync('pages/index/index.ink','utf8').split('<script setup>')[1].split('</script>')[0].replace('export default {','globalThis.page = {');
  vm.runInNewContext(source,context);
  const page = context.page;
  page.data = {...page.data};
  page.setData = value => Object.assign(page.data,value);
  return {page,urls,sessions,respond: value => { answer = value; }};
}

test('consecutive refreshes advance the request index and receive different batches', async () => {
  const {page,urls} = player();
  await page.requestFeed();
  await page.requestFeed();
  assert.deepEqual(urls.map(({url}) => new URL(url).searchParams.get('refresh_index')),['0','1']);
  assert.deepEqual(Array.from(page.items, item => item.id),['0','1']);
});

test('refreshing keeps the same anonymous session instead of registering again', async () => {
  const {page,urls,sessions} = player();
  await page.requestFeed();
  await page.requestFeed();
  assert.equal(sessions.filter(url => url.includes('ttwid.')).length,1);
  assert.equal(urls[0].headers.Cookie,urls[1].headers.Cookie);
});

test('an empty response and a repeated response produce different diagnoses', async () => {
  const {page,respond} = player();
  await page.requestFeed();
  respond({status_code:0,aweme_list:[]});
  await page.requestFeed();
  assert.match(page.data.status,/未返回可播放/);
  respond({status_code:0,aweme_list:[{aweme_id:'0',video:{play_addr_h264:{url_list:['https://example.com/0']}}}]});
  await page.requestFeed();
  assert.match(page.data.status,/重复/);
  assert.equal(page.items.length,1);
});

test('a nonzero API status is not described as no new videos', async () => {
  const {page,respond} = player();
  respond({status_code:4,aweme_list:[]});
  await page.requestFeed();
  assert.match(page.data.status,/接口.*不可用/);
  assert.match(page.data.details,/status_code=4/);
});
