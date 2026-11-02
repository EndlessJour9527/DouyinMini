const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function page() {
  const source = fs.readFileSync('pages/index/index.ink', 'utf8')
    .split('<script setup>')[1].split('</script>')[0]
    .replace('export default {', 'globalThis.page = {');
  const context = {console: {log() {}}};
  vm.runInNewContext(source, context);
  const page = context.page;
  page.data = {...page.data, src: 'https://example.com/video.mp4', playing: true};
  page.setData = value => Object.assign(page.data, value);
  return page;
}

test('fullscreen can be entered and exited without changing the video or playback', () => {
  const p = page();
  assert.equal(p.data.fullscreen, false);
  p.toggleFullscreen();
  assert.equal(p.data.fullscreen, true);
  p.toggleFullscreen();
  assert.equal(p.data.fullscreen, false);
  assert.equal(p.data.src, 'https://example.com/video.mp4');
  assert.equal(p.data.playing, true);
});

test('tapping the video hides and restores its text without pausing', () => {
  const p = page();
  assert.equal(p.data.infoVisible, true);
  p.toggleInfo();
  assert.equal(p.data.infoVisible, false);
  assert.equal(p.data.playing, true);
  p.toggleInfo();
  assert.equal(p.data.infoVisible, true);
});

test('glasses single-click Enter hides and restores text without default activation', () => {
  const p = page();
  let prevented = 0;
  const click = () => p.onKeyUp({code:'Enter', preventDefault() { prevented++; }});
  click();
  assert.equal(p.data.infoVisible, false);
  click();
  assert.equal(p.data.infoVisible, true);
  assert.equal(prevented, 2);
  assert.equal(p.data.playing, true);
});

test('hidden text stays hidden across fullscreen changes and video switches', () => {
  const p = page();
  p.items = [{title: 'First', urls: ['one']}, {title: 'Second', urls: ['two']}];
  p.urlIndex = 0;
  p.toggleInfo();
  p.toggleFullscreen();
  p.next();
  assert.equal(p.data.current, 1);
  assert.equal(p.data.src, 'two');
  assert.equal(p.data.fullscreen, true);
  assert.equal(p.data.infoVisible, false);
});

test('Backspace and Escape exit fullscreen before default page navigation', () => {
  const p = page();
  let prevented = 0;
  for (const code of ['Backspace', 'Escape']) {
    p.toggleFullscreen();
    p.onKeyUp({code, preventDefault() { prevented++; }});
    assert.equal(p.data.fullscreen, false);
  }
  p.onKeyUp({code: 'Backspace', preventDefault() { prevented++; }});
  assert.equal(prevented, 2);
});
