const fs = require('fs');
let code = fs.readFileSync('apps/bot/src/handlers/download.ts', 'utf-8');

code = code.replace(
`        if (response.isDuplicate && response.telegramFileId) {
          // It's already in our cache! We could instantly send it, but that logic is best 
          // handled by the delivery worker checking idempotency. We'll just update status.
          await ctx.api.editMessageText(
            ctx.chat.id, 
            statusMsg.message_id, 
            '✅ Found in cache! Processing...'
          );
        }`,
`        if (response.isDuplicate && response.telegramFileId) {
          await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
          try {
             await ctx.replyWithVideo(response.telegramFileId, {
               caption: \`📥 Downloaded via @therealretardbot\`,
             });
          } catch (e) {
             // Fallback to photo if Telegram stored it as photo
             await ctx.replyWithPhoto(response.telegramFileId, {
                caption: \`📥 Downloaded via @therealretardbot\`,
             });
          }
          continue;
        }`
);

fs.writeFileSync('apps/bot/src/handlers/download.ts', code);
