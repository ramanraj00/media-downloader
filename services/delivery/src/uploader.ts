import { UploadJobData } from '@media-downloader/types';
import { Bot, InputFile } from 'grammy';
import { config } from '@media-downloader/config';
import { Logger } from 'pino';

const bot = new Bot(config.BOT_TOKEN);

export async function uploadToTelegram(
  data: UploadJobData, 
  jobRecord: any, 
  logger: Logger
): Promise<string> {
  const file = new InputFile(data.processedPath);
  let fileId = '';

  try {
    if (jobRecord.statusMessageId) {
      // Edit the status message into the video/photo if possible, or delete it and send new
      // It's easier to just delete the "processing" message and send a new one
      try {
        await bot.api.deleteMessage(jobRecord.chatId, jobRecord.statusMessageId);
      } catch (e) {
        logger.warn('Failed to delete status message');
      }
    }

    if (data.mediaType === 'video') {
      logger.info('Uploading as Video');
      const msg = await bot.api.sendVideo(jobRecord.chatId, file, {
        caption: `📥 Downloaded via @${bot.botInfo?.username || 'Bot'}`,
      });
      fileId = msg.video.file_id;
    } else if (data.mediaType === 'photo') {
      logger.info('Uploading as Photo');
      const msg = await bot.api.sendPhoto(jobRecord.chatId, file, {
        caption: `📥 Downloaded via @${bot.botInfo?.username || 'Bot'}`,
      });
      fileId = msg.photo[0].file_id;
    } else if (data.mediaType === 'audio') {
      logger.info('Uploading as Audio');
      const msg = await bot.api.sendAudio(jobRecord.chatId, file, {
        caption: `📥 Downloaded via @${bot.botInfo?.username || 'Bot'}`,
      });
      fileId = msg.audio.file_id;
    } else {
      logger.info('Uploading as Document');
      const msg = await bot.api.sendDocument(jobRecord.chatId, file, {
        caption: `📥 Downloaded via @${bot.botInfo?.username || 'Bot'}`,
      });
      fileId = msg.document.file_id;
    }

    return fileId;
  } catch (error: any) {
    logger.error({ err: error }, 'Telegram upload failed');
    
    // Tell user it failed
    try {
      await bot.api.sendMessage(jobRecord.chatId, `❌ Failed to upload media: ${error.message}`);
    } catch (e) {}

    throw error;
  }
}
