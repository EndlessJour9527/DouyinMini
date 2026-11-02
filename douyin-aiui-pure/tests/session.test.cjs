const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function runPage(home, body) {
  const src = fs.readFileSync('pages/index/index.ink', 'utf8').split('<script setup>')[1].split('</script>')[0].replace('export default {', 'globalThis.page = {');
  let requestHeaders;
  const context = { console: {log() {}}, wx: {request({url, success}) {success(url.includes('ttwid.bytedance.com') ? {statusCode:200, cookies:['ttwid=guest; Path=/']} : home);}}, fetch: async (_url, options) => {
    requestHeaders = options.headers;
    return {status: 200, text: async () => body};
  }};
  vm.runInNewContext(src, context);
  const page = context.page;
  page.data = {...page.data};
  page.setData = update => Object.assign(page.data, update);
  return page.requestFeed().then(() => ({page, requestHeaders}));
}

test('reports a challenged session and sends only the last value of duplicate cookies', async () => {
  const {page, requestHeaders} = await runPage({statusCode:200, cookies:['__ac_nonce=old; Path=/', '__ac_nonce=new; Path=/'], data:'__ac_nonce __ac_signature'}, 'blocked');
  assert.equal(requestHeaders.Cookie, '__ac_nonce=new; ttwid=guest');
  assert.match(page.data.details, /blocked/);
  assert.match(page.data.details, /首页要求会话校验/);
  assert.equal(page.data.src, '');
});
