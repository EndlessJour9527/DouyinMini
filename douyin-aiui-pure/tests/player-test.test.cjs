const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function load(query) {
  const source = fs.readFileSync('pages/index/index.ink', 'utf8')
    .split('<script setup>')[1].split('</script>')[0]
    .replace('export default {', 'globalThis.page = {');
  const context = {console: {log() {}}};
  vm.runInNewContext(source, context);
  const page = context.page;
  page.data = {...page.data};
  page.setData = value => Object.assign(page.data, value);
  let feedRequested = false;
  page.requestFeed = () => { feedRequested = true; };
  page.onLoad(query);
  return {page, feedRequested};
}
test('test mode without a video URL makes no request or default playback', () => {
  const {page, feedRequested} = load({mode: 'player-test'});
  assert.equal(page.data.src, '');
  assert.equal(page.data.playing, false);
  assert.equal(feedRequested, false);
});
test('test mode rejects an insecure video URL', () => {
  const {page, feedRequested} = load({mode: 'player-test', testVideoUrl: 'http://example.com/video.mp4'});
  assert.equal(page.data.src, '');
  assert.equal(feedRequested, false);
});
test('test mode uses only the supplied HTTPS video', () => {
  const url = 'https://example.com/video.mp4';
  const {page, feedRequested} = load({mode: 'player-test', testVideoUrl: url});
  assert.equal(page.data.src, url);
  assert.equal(page.data.playing, true);
  assert.equal(feedRequested, false);
});
test('normal mode still requests the feed', () => {
  assert.equal(load({}).feedRequested, true);
});
