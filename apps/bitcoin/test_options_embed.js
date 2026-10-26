'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, 'dashboard/dist/terminal-embed.js'), 'utf8');

function fixture(mode = 'embedded', withBody = true) {
  const messages = [], windowListeners = new Map(), documentListeners = new Map();
  const mutations = [], resizes = [], frames = [];
  const body = {focused: false, scrollHeight: 1200, classList: {contains(name) { return name === 'quote-focus' && body.focused; }}};
  const documentElement = {scrollHeight: 1200};
  const document = {
    body: withBody ? body : null, documentElement, hidden: false,
    addEventListener(type, handler) { documentListeners.set(type, handler); }
  };
  const origin = 'http://127.0.0.1:8766';
  const parent = {location: {origin}, postMessage(message, target) { messages.push({message, target}); }};
  if (mode === 'foreign') parent.location.origin = 'https://example.test';
  if (mode === 'inaccessible') Object.defineProperty(parent, 'location', {get() { throw new Error('cross-origin'); }});
  const window = {
    location: {origin: mode === 'opaque' ? 'null' : origin}, parent,
    innerHeight: 700,
    addEventListener(type, handler) { windowListeners.set(type, handler); },
    requestAnimationFrame(handler) { frames.push(handler); return frames.length; }
  };
  if (mode === 'standalone') window.parent = window;
  class MutationObserver {
    constructor(callback) { this.callback = callback; mutations.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
  }
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = []; resizes.push(this); }
    observe(target) { this.targets.push(target); }
  }
  vm.runInNewContext(source, {window, document, MutationObserver, ResizeObserver});
  return {
    window, document, body, parent, messages, mutations, resizes, frames,
    flush() { frames.splice(0).forEach(handler => handler()); },
    fire(type, data) { windowListeners.get(type)?.(data); },
    fireDocument(type) { documentListeners.get(type)?.(); },
    setHeight(height) { body.scrollHeight = documentElement.scrollHeight = height; }
  };
}

let checks = 0;
function test(name, run) {
  run(); checks++;
  process.stdout.write('PASS ' + name + '\n');
}

test('standalone and foreign parents create no bridge or observers', () => {
  for (const mode of ['standalone', 'foreign', 'inaccessible', 'opaque']) {
    const f = fixture(mode);
    assert.equal(f.frames.length + f.mutations.length + f.resizes.length, 0);
    assert.equal(f.messages.length, 0);
  }
});

test('same-origin embedding publishes focus and informational height once', () => {
  const f = fixture(); f.flush();
  assert.equal(f.messages.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(f.messages)), [
    {message: {type:'options-focus', focused:false}, target:'http://127.0.0.1:8766'},
    {message: {type:'options-height', height:1200, infoOnly:true}, target:'http://127.0.0.1:8766'}
  ]);
  assert.equal(f.resizes[0].targets.length, 2);
});

test('multiple layout mutations coalesce without unchanged message floods', () => {
  const f = fixture(); f.flush();
  for (let i = 0; i < 20; i++) f.mutations[0].callback();
  assert.equal(f.frames.length, 1);
  f.flush(); assert.equal(f.messages.length, 2);
});

test('entering and exiting focus reports child state without changing DOM', () => {
  const f = fixture(); f.flush();
  f.body.focused = true; f.mutations[0].callback(); f.flush();
  assert.equal(f.messages[2].message.type, 'options-focus');
  assert.equal(f.messages[2].message.focused, true);
  assert.equal(f.messages[3].message.height, 700);
  f.body.focused = false; f.mutations[0].callback(); f.flush();
  assert.equal(f.messages[4].message.focused, false);
  assert.equal(f.messages[5].message.height, 1200);
  assert.equal(f.body.focused, false);
});

test('informational height can decrease and remains independent of commands', () => {
  const f = fixture(); f.flush();
  f.setHeight(900.1); f.resizes[0].callback(); f.flush();
  assert.equal(f.messages.at(-1).message.height, 901);
  assert.equal(f.messages.at(-1).message.infoOnly, true);
  f.fire('message', {source:f.parent, origin:f.window.location.origin, data:{type:'options-set-focus',focused:true}});
  f.flush(); assert.equal(f.body.focused, false);
});

test('only the same-origin parent may request fresh state', () => {
  const f = fixture(); f.flush();
  const valid = {source:f.parent, origin:f.window.location.origin, data:{type:'options-request-state'}};
  f.fire('message', {...valid, origin:'https://example.test'});
  f.fire('message', {...valid, source:{}});
  f.fire('message', {...valid, data:null});
  f.flush(); assert.equal(f.messages.length, 2);
  f.fire('message', valid); f.fire('message', valid);
  assert.equal(f.frames.length, 1);
  f.flush(); assert.equal(f.messages.length, 4);
});

test('hidden-frame return and browser restoration replay current state', () => {
  const f = fixture(); f.flush();
  f.document.hidden = true; f.fireDocument('visibilitychange'); f.flush();
  assert.equal(f.messages.length, 2);
  f.document.hidden = false; f.fireDocument('visibilitychange'); f.flush();
  assert.equal(f.messages.length, 4);
  f.fire('pageshow'); f.flush(); assert.equal(f.messages.length, 6);
});

test('early injection waits for the body before observing or reporting', () => {
  const f = fixture('embedded', false); f.flush();
  assert.equal(f.messages.length + f.mutations.length + f.resizes.length, 0);
  f.document.body = f.body; f.fireDocument('DOMContentLoaded'); f.flush();
  assert.equal(f.messages.length, 2);
  f.fireDocument('DOMContentLoaded'); f.flush(); assert.equal(f.messages.length, 2);
});

process.stdout.write(checks + ' options embed checks passed\n');
