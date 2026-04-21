const deviceState = require('./deviceState');

function getBaseUrl() {
  // Prefer device.json configured serverUrl (Electron desktop mode),
  // fallback to env / localhost for dev.
  const s = deviceState.readDeviceState();
  return deviceState.normalizeUrl(s.serverUrl);
}

module.exports = { getBaseUrl };

