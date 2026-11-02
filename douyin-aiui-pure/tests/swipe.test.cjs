const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function player(current = 1) {
  const source = fs.readFileSync('pages/index/index.ink', 'utf8')
    .split('<script setup>')[1].split('</script>')[0]
    .replace('export default {', 'globalThis.page = {');
  const context = {console: {log() {}}};
  vm.runInNewContext(source, context);
  const page = context.page, video = {entityId: 10, clientWidth: 480, clientHeight: 280}, controls = {entityId: 20};
  page.data = {...page.data, current};
  page.items = [0, 1, 2].map(i => ({title: 'Video ' + i, urls: ['https://example.com/' + i + '.mp4']}));
  page.urlIndex = 0;
  page.setData = value => Object.assign(page.data, value);
  page.querySelector = selector => selector === '#video-stage' ? video : controls;
  const listeners = {};
  page.addEventListener = (type, listener) => { listeners[type] = listener; };
  page.onReady();
  function emit(type, x, y, options = {}) {
    listeners[type]({clientX: x, clientY: y, pointerId: 1, button: 0,
      composedPath: () => [video, page], preventDefault() {}, ...options});
  }
  return {page, emit, controls};
}

test('swiping up plays the previous video and consumes a release only once', () => {
  const {page, emit} = player();
  emit('pointerdown', 100, 160);
  emit('pointerup', 105, 60);
  assert.equal(page.data.current, 0);
  assert.equal(page.data.src, 'https://example.com/0.mp4');
  emit('pointerup', 105, 60);
  assert.equal(page.data.current, 0);
});

test('swiping down plays the next video', () => {
  const {page, emit} = player();
  emit('pointerdown', 100, 60);
  emit('pointerup', 105, 160);
  assert.equal(page.data.current, 2);
  assert.equal(page.data.src, 'https://example.com/2.mp4');
});

test('event targets wrapped separately by Ink still identify the video entity', () => {
  const {page, emit} = player();
  emit('pointerdown', 100, 60, {composedPath: () => [{entityId: 10}]});
  emit('pointerup', 100, 160);
  assert.equal(page.data.current, 2);
});

test('older Ink page-level pointer events use video bounds and exclude controls', () => {
  const {page, emit} = player();
  const legacy = {target: page, composedPath: () => [page]};
  emit('pointerdown', 100, 330, legacy);
  emit('pointerup', 100, 200, legacy);
  assert.equal(page.data.current, 1);
  emit('pointerdown', 100, 60, legacy);
  emit('pointerup', 100, 160, legacy);
  assert.equal(page.data.current, 2);
});

test('short and predominantly horizontal gestures do not switch videos', () => {
  const {page, emit} = player();
  for (const [x, y] of [[103, 125], [220, 165], [180, 170]]) {
    emit('pointerdown', 100, 100);
    emit('pointerup', x, y);
    assert.equal(page.data.current, 1);
  }
});

test('cancelled and multi-pointer gestures do not switch videos', () => {
  const {page, emit} = player();
  emit('pointerdown', 100, 100);
  emit('pointercancel', 100, 100);
  emit('pointerup', 100, 200);
  assert.equal(page.data.current, 1);
  emit('pointerdown', 100, 100);
  emit('pointerdown', 100, 100, {pointerId: 2});
  emit('pointerup', 100, 200, {pointerId: 2});
  emit('pointerup', 100, 200);
  assert.equal(page.data.current, 1);
});

test('button-area drags and secondary mouse presses do not switch videos', () => {
  const {page, emit, controls} = player();
  emit('pointerdown', 100, 100, {composedPath: () => [controls, page]});
  emit('pointerup', 100, 200);
  emit('pointerdown', 100, 100, {button: 2});
  emit('pointerup', 100, 200, {button: 2});
  assert.equal(page.data.current, 1);
});

test('a release from another pointer cannot complete the active gesture', () => {
  const {page, emit} = player();
  emit('pointerdown', 100, 100);
  emit('pointerup', 100, 200, {pointerId: 2});
  assert.equal(page.data.current, 1);
  emit('pointerup', 100, 200);
  assert.equal(page.data.current, 2);
});

test('up at the first item keeps it selected', () => {
  const {page, emit} = player(0);
  emit('pointerdown', 100, 160);
  emit('pointerup', 100, 60);
  assert.equal(page.data.current, 0);
});

test('ArrowUp and ArrowDown follow the same direction and consume default scrolling', () => {
  const {page} = player();
  let prevented = 0;
  page.onKeyUp({code: 'ArrowUp', preventDefault() { prevented++; }});
  assert.equal(page.data.current, 0);
  page.onKeyUp({code: 'ArrowDown', preventDefault() { prevented++; }});
  assert.equal(page.data.current, 1);
  page.onKeyUp({code: 'KeyA', preventDefault() { prevented++; }});
  assert.equal(prevented, 2);
});
