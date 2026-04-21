const { execSync } = require('child_process');

function execText(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function parseWxH(text) {
  const m = String(text).match(/(\d+)\s*[x,]\s*(\d+)/i);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function getScreenSizeMacOS() {
  // Finder desktop bounds tends to match the effective UI resolution (better than physical pixels on Retina).
  // Example output: "0, 0, 1440, 900"
  const out = execText(`osascript -e 'tell application "Finder" to get bounds of window of desktop'`);
  const nums = out.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  if (nums.length === 4) {
    const width = Math.max(0, nums[2] - nums[0]);
    const height = Math.max(0, nums[3] - nums[1]);
    if (width && height) return { width, height };
  }
  return null;
}

function getScreenSizeWindows() {
  // PowerShell + WinForms for primary display bounds.
  const out = execText(
    'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \\"$($b.Width)x$($b.Height)\\""'
  );
  return parseWxH(out);
}

function getScreenSizeLinux() {
  // xrandr primary/current mode line with '*'
  const out = execText(`sh -lc "xrandr 2>/dev/null | grep '\\*' | head -n 1 | awk '{print \\$1}'"`);
  return parseWxH(out);
}

function getScreenSize() {
  try {
    if (process.platform === 'darwin') return getScreenSizeMacOS();
    if (process.platform === 'win32') return getScreenSizeWindows();
    return getScreenSizeLinux();
  } catch {
    return null;
  }
}

function buildLaunchArgs(screenSize, extraArgs = []) {
  const args = ['--start-maximized', ...extraArgs];
  if (screenSize?.width && screenSize?.height) {
    args.push(`--window-size=${screenSize.width},${screenSize.height}`, '--window-position=0,0');
  }
  return args;
}

function buildContextOptions({ storageState, screenSize, proxy } = {}) {
  const opts = { viewport: null, acceptDownloads: true };
  if (storageState) opts.storageState = storageState;
  if (screenSize?.width && screenSize?.height) opts.screen = screenSize;
  if (proxy && typeof proxy === 'object' && typeof proxy.server === 'string' && proxy.server) {
    opts.proxy = proxy;
  }
  return opts;
}

module.exports = {
  getScreenSize,
  buildLaunchArgs,
  buildContextOptions
};
