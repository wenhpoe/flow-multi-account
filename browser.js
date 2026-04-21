const { chromium } = require('playwright-core');
const { getScreenSize, buildLaunchArgs } = require('./screen');

function preferredChannel() {
  if (process.env.PLAYWRIGHT_CHANNEL) return process.env.PLAYWRIGHT_CHANNEL;
  if (process.env.USE_SYSTEM_CHROME === '1') return 'chrome';
  return null;
}

async function launchChromium({ extraArgs = [], screenSize = getScreenSize(), trySystemChrome = false } = {}) {
  const baseOptions = {
    headless: false,
    args: buildLaunchArgs(screenSize, extraArgs)
  };

  const allowTrySystem = process.env.TRY_SYSTEM_CHROME !== '0';
  const channel = preferredChannel() || (trySystemChrome && allowTrySystem ? 'chrome' : null);
  if (channel) {
    try {
      return await chromium.launch({ ...baseOptions, channel });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      throw new Error(
        `启动系统浏览器失败（channel="${channel}"）。请确认已安装 Google Chrome。\n` +
          `原始错误：${msg}`
      );
    }
  }

  if (process.env.ALLOW_BUNDLED_BROWSER === '1') {
    return chromium.launch(baseOptions);
  }
  throw new Error('未配置系统 Chrome（建议设置 USE_SYSTEM_CHROME=1），且未允许使用内置浏览器。');
}

module.exports = { launchChromium };
