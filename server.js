const express = require('express');
const path = require('path');
require('./core/loadEnv')();
const profiles = require('./core/profiles');
const flowWindow = require('./core/flowWindow');
const profileCapture = require('./core/profileCapture');
const chatGeneration = require('./core/chatGeneration');

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '25mb' }));

// ==================== API ====================

app.get('/profiles', (req, res) => {
  res.json(profiles.listProfiles());
});

app.post('/open/:profile', async (req, res) => {
  const profileName = req.params.profile;
  try {
    const hasBrowser = flowWindow.getFlowState().hasBrowser;
    if (!hasBrowser) console.log('🚀 首次启动浏览器窗口...');
    else console.log(`🔄 正在打开账号: ${profileName}`);

    const { warning, activeProfile, proxy, sessionId } = await flowWindow.openFlowWithProfile(profileName);
    res.json({ success: true, message: `已打开 ${activeProfile}`, warning, proxy, sessionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '切换失败' });
  }
});

app.post('/close', async (req, res) => {
  try {
    await flowWindow.closeAllFlowWindows();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '关闭失败' });
  }
});

app.post('/close/:sessionId', async (req, res) => {
  try {
    const result = await flowWindow.closeFlowSession(req.params.sessionId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '关闭失败' });
  }
});

app.post('/focus/:sessionId', async (req, res) => {
  try {
    const result = await flowWindow.focusFlowSession(req.params.sessionId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '聚焦失败' });
  }
});

app.post('/quit', async (req, res) => {
  try {
    await flowWindow.quitBrowser();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '退出失败' });
  }
});

app.get('/status', async (req, res) => {
  try {
    res.json({
      flow: flowWindow.getFlowState(),
      capture: profileCapture.getCaptureState(),
      chat: await chatGeneration.getState(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '获取状态失败' });
  }
});

app.get('/chat/state', async (req, res) => {
  try {
    res.json(await chatGeneration.getState());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '获取聊天状态失败' });
  }
});

app.get('/chat/targets', async (req, res) => {
  try {
    res.json(await chatGeneration.listTargetMachines());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '获取执行机列表失败' });
  }
});

app.post('/chat/settings', (req, res) => {
  try {
    res.json(chatGeneration.updateSettings(req.body || {}));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '保存聊天设置失败' });
  }
});

app.post('/chat/send', async (req, res) => {
  try {
    res.json(await chatGeneration.sendMessage(req.body || {}));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '发送生成任务失败' });
  }
});

app.post('/chat/clear', (req, res) => {
  try {
    res.json(chatGeneration.clearHistory());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '清空聊天记录失败' });
  }
});

app.get('/chat/assets/:assetId', async (req, res) => {
  try {
    const result = await chatGeneration.getAssetData(req.params.assetId);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(404).json({ error: err.message || '图片资源不存在' });
  }
});

app.delete('/profiles/:profile', (req, res) => {
  try {
    profiles.deleteProfile(req.params.profile);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '删除失败' });
  }
});

app.post('/capture/start/:profile', async (req, res) => {
  try {
    const result = await profileCapture.startCapture(req.params.profile);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '启动保存失败' });
  }
});

app.post('/capture/finish', async (req, res) => {
  try {
    const result = await profileCapture.finishCapture();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '保存失败' });
  }
});

app.post('/capture/cancel', async (req, res) => {
  try {
    await profileCapture.cancelCapture();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '取消失败' });
  }
});

app.listen(PORT, () => {
  console.log('🚀 Flow 多账号管理器已启动（多窗口模式：可同时打开多个账号窗口）');
  console.log(`📍 请在浏览器打开: http://localhost:${PORT}`);
  console.log('提示：每次“打开”都会新建一个独立窗口（不同账号互不影响）');
});
