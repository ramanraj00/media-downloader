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
      return;
    }

    if (supportedUrls.length === 0) return; // Ignore regular text

    for (const url of supportedUrls) {
      try {
        // Call API Service
        const response = await submitJobToApi({
          url,
          userId: ctx.from.id,
          chatId: ctx.chat.id,
          statusMessageId: undefined
        });

        if (response.isDuplicate && response.telegramFileId) {
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
        }

        logger.info({ jobId: response.jobId, url }, 'Job submitted successfully');
      } catch (error: any) {
        logger.error({ err: error, url }, 'Failed to submit job');
        
        let errorMessage = '❌ Failed to process request.';
        // User requested NO failure messages of any kind
        // We just log it and stay silent
        // await ctx.reply(errorMessage);
      }
    }
  };
}
