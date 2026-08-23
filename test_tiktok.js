const { TikTokAdapter } = require('./dist/platforms/tiktok.js');
async function run() {
  const adapter = new TikTokAdapter();
  try {
    await adapter.tryYtDlp('https://www.tiktok.com/@mrbeast/video/7279140417936903466', '/tmp');
  } catch (e) {
    console.error("FAILED:", e);
  }
}
run();
