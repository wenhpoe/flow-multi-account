const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const accountServicePath = path.resolve(__dirname, '../core/accountService.js');
const deviceState = require('../core/deviceState');
const controlPlane = require('../core/controlPlane');

const originalFetch = global.fetch;
const originalReadDeviceState = deviceState.readDeviceState;
const originalWriteDeviceState = deviceState.writeDeviceState;
const originalNormalizeUrl = deviceState.normalizeUrl;
const originalIsActivated = deviceState.isActivated;
const originalGetBaseUrl = controlPlane.getBaseUrl;

function loadFreshAccountService() {
  delete require.cache[accountServicePath];
  return require(accountServicePath);
}

function restorePatchedState() {
  global.fetch = originalFetch;
  deviceState.readDeviceState = originalReadDeviceState;
  deviceState.writeDeviceState = originalWriteDeviceState;
  deviceState.normalizeUrl = originalNormalizeUrl;
  deviceState.isActivated = originalIsActivated;
  controlPlane.getBaseUrl = originalGetBaseUrl;
  delete require.cache[accountServicePath];
}

test.afterEach(() => {
  restorePatchedState();
});

test('validateDeviceAccess retries once after timeout and preserves activation', async () => {
  let fetchCalls = 0;
  const writes = [];
  deviceState.readDeviceState = () => ({
    machineId: 'machine-1',
    token: 'token-1',
    serverUrl: 'http://127.0.0.1:3123',
    allowedProfiles: [],
  });
  deviceState.writeDeviceState = (patch) => {
    writes.push(patch);
    return patch;
  };
  deviceState.normalizeUrl = (value) => String(value || '').trim() || 'http://127.0.0.1:3123';
  deviceState.isActivated = () => true;
  controlPlane.getBaseUrl = () => 'http://127.0.0.1:3123';
  global.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      const err = new Error('timeout');
      err.name = 'AbortError';
      throw err;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        machineId: 'machine-1',
        activatedAt: '2026-06-04T22:00:00.000+08:00',
        lastSeenAt: '2026-06-04T22:00:01.000+08:00',
        allowedProfiles: ['522'],
      }),
    };
  };

  const accountService = loadFreshAccountService();
  const result = await accountService.validateDeviceAccess({
    force: true,
    maxAgeMs: 0,
  });

  assert.equal(fetchCalls, 2);
  assert.equal(result.state, 'active');
  assert.equal(result.canUseApp, true);
  assert.deepEqual(result.allowedProfiles, ['522']);
  assert.deepEqual(writes.at(-1), {
    serverUrl: 'http://127.0.0.1:3123',
    allowedProfiles: ['522'],
  });
});
