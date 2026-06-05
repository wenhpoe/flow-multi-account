const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveProvider,
  listEnabledProviders,
  resolveConstraints,
  requiresReferenceImage,
} = require('../public/channelCatalogState');

test('resolveProvider prefers explicit provider when it is enabled', () => {
  const channel = {
    key: 'seedance',
    selected_provider: '2',
    providers: [
      { key: '1', enabled: true },
      { key: '2', enabled: true },
    ],
  };

  assert.equal(resolveProvider(channel, '1'), '1');
});

test('resolveProvider falls back to channel selected_provider', () => {
  const channel = {
    key: 'seedance',
    selected_provider: '2',
    providers: [
      { key: '1', enabled: true },
      { key: '2', enabled: true },
    ],
  };

  assert.equal(resolveProvider(channel, ''), '2');
});

test('listEnabledProviders removes disabled providers', () => {
  const channel = {
    providers: [
      { key: '1', enabled: false },
      { key: '2', enabled: true },
    ],
  };

  assert.deepEqual(listEnabledProviders(channel).map((item) => item.key), ['2']);
});

test('requiresReferenceImage falls back to channel-level constraint', () => {
  const channel = {
    selected_provider: '1',
    constraints: { requires_image: true },
    providers: [
      { key: '1', enabled: true },
    ],
  };

  assert.equal(requiresReferenceImage(channel, '1'), true);
});

test('provider constraints can relax a stricter channel default', () => {
  const channel = {
    selected_provider: '2',
    constraints: { requires_image: true },
    providers: [
      { key: '1', enabled: true, constraints: { requires_image: true } },
      { key: '2', enabled: true, constraints: { requires_image: false } },
    ],
  };

  assert.deepEqual(resolveConstraints(channel, '2'), { requires_image: false });
  assert.equal(requiresReferenceImage(channel, '2'), false);
  assert.equal(requiresReferenceImage(channel, '1'), true);
});

test('provider extra.constraints also overrides channel constraints', () => {
  const channel = {
    selected_provider: '2',
    constraints: { requires_image: true, requires_prompt: true },
    providers: [
      { key: '2', enabled: true, extra: { constraints: { requires_image: false } } },
    ],
  };

  assert.deepEqual(resolveConstraints(channel, '2'), {
    requires_image: false,
    requires_prompt: true,
  });
});
