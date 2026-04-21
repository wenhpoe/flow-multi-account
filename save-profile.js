const readline = require('readline');
const { getScreenSize, buildContextOptions } = require('./screen');
const { launchChromium } = require('./browser');
const profiles = require('./core/profiles');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(text) {
  return new Promise((resolve) => rl.question(text, resolve));
}

async function saveProfile() {
  const nameRaw = await question('请输入要保存的账号名称（如 账号A）：');
  let name;
  try {
    name = profiles.sanitizeProfileName(nameRaw);
  } catch (err) {
    console.error('❌ ' + (err.message || '账号名称非法'));
    rl.close();
    process.exitCode = 1;
    return;
  }

  console.log('\n正在启动浏览器... 请登录 Google 账号并打开 Flow');
  console.log('登录完成后，回到终端按回车键保存...');

  const screenSize = getScreenSize();
  const browser = await launchChromium({ screenSize, trySystemChrome: true });
  const context = await browser.newContext(buildContextOptions({ screenSize }));
  const page = await context.newPage();

  const flowUrl = 'https://labs.google/fx/tools/flow';
  const gotoTimeoutMs = process.env.GOTO_TIMEOUT_MS ? Number(process.env.GOTO_TIMEOUT_MS) : 120000;
  page.setDefaultNavigationTimeout(Number.isFinite(gotoTimeoutMs) ? gotoTimeoutMs : 120000);

  try {
    await page.goto(flowUrl, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    console.warn(`⚠️ 打开 ${flowUrl} 超时/失败（不影响保存）。你可以在已打开的窗口里手动刷新或直接登录后继续。`);
  }

  await new Promise((resolve) => rl.once('line', resolve));

  const storageState = await context.storageState();
  profiles.writeStorageState(name, storageState);

  console.log(`✅ 账号 "${name}" 已保存！`);
  await browser.close();
  rl.close();
}

saveProfile().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  rl.close();
});
