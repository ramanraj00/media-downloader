import { Context } from 'grammy';

export async function startCommand(ctx: Context) {
  const msg = 
    `👋 *Welcome to the Media Downloader Bot!*\n\n` +
    `Send me a link and I'll download the media for you.\n\n` +
    `🟢 *Supported Platforms:*\n` +
    `📸 Instagram — Reels, Posts, Stories\n` +
    `🐦 Twitter/X — Videos, GIFs, Images\n` +
    `🎵 TikTok — Videos (no watermark)\n` +
    `🤖 Reddit — Videos, GIFs, Images\n\n` +
    `Just paste the link — that's it!\n` +
    `Use /help for tips and details.`;
    
  await ctx.reply(msg, { parse_mode: 'Markdown' });
}

export async function helpCommand(ctx: Context) {
  const msg = 
    `ℹ️ *How to Use*\n\n` +
    `1️⃣ Copy the link of the post/reel/video you want\n` +
    `2️⃣ Paste it here\n` +
    `3️⃣ Wait for the download\n\n` +
    `💡 *Tips:*\n` +
    `• You can send multiple URLs in one message\n` +
    `• Public content only — private accounts won't work\n` +
    `• Max file size: 50MB (Telegram limit)\n` +
    `• Large videos are auto-compressed\n`;
    
  await ctx.reply(msg, { parse_mode: 'Markdown' });
}
