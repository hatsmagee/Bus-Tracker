'use strict';
const assert = require('assert');
const { isBlockedModel, extractJson } = require('../lib/aihorde');

module.exports = {
  'LLaMA2 models are blocked (user rule)'() {
    assert.strictEqual(isBlockedModel('koboldcpp/LLaMA2-13B-Psyfighter2'), true);
    assert.strictEqual(isBlockedModel('llama-2-7b'), true);
    assert.strictEqual(isBlockedModel('Llama 2 70B'), true);
  },
  'non-LLaMA2 models are allowed'() {
    assert.strictEqual(isBlockedModel('koboldcpp/LLaMA3-8B'), false);
    assert.strictEqual(isBlockedModel('Mistral-7B'), false);
    assert.strictEqual(isBlockedModel('Qwen2.5-14B'), false);
  },
  'extractJson parses a fenced block'() {
    const out = extractJson('here you go:\n```json\n{"a":1}\n```\nthanks');
    assert.strictEqual(out.a, 1);
  },
  'extractJson parses raw json'() {
    assert.strictEqual(extractJson('{"b":2}').b, 2);
  },
  'extractJson parses embedded json'() {
    assert.strictEqual(extractJson('noise {"c":3} more').c, 3);
  },
  'extractJson throws on non-json'() {
    assert.throws(() => extractJson('no json here'));
  },
};
