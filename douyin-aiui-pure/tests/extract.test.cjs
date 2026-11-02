const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('pages/index/index.ink', 'utf8');
const fn = source.slice(source.indexOf('function extract(data)'), source.indexOf('\nexport default'));
const extract = vm.runInNewContext(fn + '\nextract');
test('deduplicates videos and excludes H.265 and DASH candidates', () => {
  const rate = (url, extra = {}) => ({play_addr:{url_list:[url]}, ...extra});
  const video = {aweme_id:'123456',desc:'video',video:{play_addr_h264:{url_list:['https://cdn.test/a']},bit_rate:[rate('https://cdn.test/b',{is_h265:1}),rate('https://cdn.test/c',{format:'dash'}),rate('https://cdn.test/d') ]}};
  const result = JSON.parse(JSON.stringify(extract({data:{aweme_list:[video,video]}})));
  assert.equal(result.length,1);
  assert.deepEqual(result[0].urls,['https://cdn.test/a','https://cdn.test/d']);
});
test('returns empty list for missing video addresses', () => {
  assert.equal(extract({aweme_list:[{aweme_id:'123',video:{}}]}).length,0);
});
