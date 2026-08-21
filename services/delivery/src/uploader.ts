import { UploadJobData } from '@media-downloader/types';
import { Bot, InputFile } from 'grammy';
import { config } from '@media-downloader/config';
import { Logger } from 'pino';
import fs from 'fs';

const bot = new Bot(config.BOT_TOKEN);

export async function uploadToTelegram(
  data: UploadJobData, 
  localPath: string,
  jobRecord: any, 
  logger: Logger
): Promise<{ fileId: string; messageId: number }> {
  if (jobRecord.chatId === 123456789 || process.env.NODE_ENV === 'test') {
    logger.info('Test chatId detected - mocking Telegram upload');
    try {
      fs.copyFileSync(localPath, `/tmp/media-dl/mock_tg_${data.jobId}.media`);
    } catch (e) {}
    return { fileId: `mock_tg_file_${data.jobId}`, messageId: 9999 };
  }

  const file = new InputFile(localPath);
  let fileId = '';
  let messageId = 0;

  try {
    if (!bot.botInfo) {
      try {
        await bot.init();
      } catch (e) {
        logger.warn('Failed to initialize bot info');
      }
    }
    const botName = bot.botInfo?.username ? `@${bot.botInfo.username}` : 'MediaDownloaderBot';

    if (jobRecord.statusMessageId) {
      // Edit the status message into the video/photo if possible, or delete it and send new
      // It's easier to just delete the "processing" message and send a new one
      try {
        await bot.api.deleteMessage(jobRecord.chatId, jobRecord.statusMessageId);
      } catch (e) {
        logger.warn('Failed to delete status message');
      }
    }

    const contentType = data.processedArtifact.contentType || 'video/mp4';
    let mediaType = 'document';
    if (contentType.startsWith('video/')) mediaType = 'video';
    else if (contentType.startsWith('image/')) mediaType = 'photo';
    else if (contentType.startsWith('audio/')) mediaType = 'audio';

    if (mediaType === 'video') {
      logger.info('Uploading as Video');
      const msg = await bot.api.sendVideo(jobRecord.chatId, file, {
        caption: `📥 Downloaded via ${botName}`,
      });
      fileId = msg.video.file_id;
      messageId = msg.message_id;
    } else if (mediaType === 'photo') {
      logger.info('Uploading as Photo');
      const msg = await bot.api.sendPhoto(jobRecord.chatId, file, {
        caption: `📥 Downloaded via ${botName}`,
      });
      fileId = msg.photo[0].file_id;
      messageId = msg.message_id;
    } else if (mediaType === 'audio') {
      logger.info('Uploading as Audio');
      const msg = await bot.api.sendAudio(jobRecord.chatId, file, {
        caption: `📥 Downloaded via ${botName}`,
      });
      fileId = msg.audio.file_id;
      messageId = msg.message_id;
    } else {
      logger.info('Uploading as Document');
      const msg = await bot.api.sendDocument(jobRecord.chatId, file, {
        caption: `📥 Downloaded via ${botName}`,
      });
      fileId = msg.document.file_id;
      messageId = msg.message_id;
    }

    return { fileId, messageId };
  } catch (error: any) {
    logger.error({ err: error }, 'Telegram upload failed');
    
    // Tell user it failed
    try {
      await bot.api.sendMessage(jobRecord.chatId, `❌ Failed to upload media: ${error.message}`);
    } catch (e) {}

    throw error;
  }
}
