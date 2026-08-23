import { Context } from 'grammy';
import { Logger } from 'pino';
import { extractUrls, isSupportedUrl } from '@media-downloader/core';
import { submitJobToApi } from '../services/apiClient';

export function downloadHandler(logger: Logger) {
  return async (ctx: Context) => {
    if (!ctx.message?.text || !ctx.from || !ctx.chat) return;

    const urls = extractUrls(ctx.message.text);
    const supportedUrls = urls.filter(isSupportedUrl);

    if (urls.length > 0 && supportedUrls.length === 0) {
      await ctx.reply('❌ No supported platforms found in your message. Supported: Instagram, Twitter, TikTok, Reddit.');
      return;
    }

    if (supportedUrls.length === 0) return; // Ignore regular text

    for (const url of supportedUrls) {
      try {
        // Send initial progress message
        const statusMsg = await ctx.reply('⏳ Requesting download...');
        
        // Call API Service
        const response = await submitJobToApi({
          url,
          userId: ctx.from.id,
          chatId: ctx.chat.id,
          statusMessageId: statusMsg.message_id
        });

        if (response.isDuplicate && response.telegramFileId) {
          await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
          try {
             await ctx.replyWithVideo(response.telegramFileId, {
               caption: `📥 Downloaded via @therealretardbot`,
             });
          } catch (e) {
             // Fallback to photo if Telegram stored it as photo
             await ctx.replyWithPhoto(response.telegramFileId, {
                caption: `📥 Downloaded via @therealretardbot`,
             });
          }
          continue;
        } else {
          await ctx.api.editMessageText(
            ctx.chat.id, 
            statusMsg.message_id, 
            '⏳ Queued for download. Waiting in line...'
          );
        }

        logger.info({ jobId: response.jobId, url }, 'Job submitted successfully');
      } catch (error: any) {
        logger.error({ err: error, url }, 'Failed to submit job');
        
        let errorMessage = '❌ Failed to process request.';
        if (error.response?.data?.error) {
          errorMessage = `❌ ${error.response.data.error}`;
        } else if (error.message) {
           errorMessage = `❌ ${error.message}`;
        }
        
        await ctx.reply(errorMessage);
      }
    }
  };
}
