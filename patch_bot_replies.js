const fs = require('fs');
let code = fs.readFileSync('apps/bot/src/handlers/download.ts', 'utf-8');

// 1. Remove unsupported message
code = code.replace(
  "      await ctx.reply('❌ No supported platforms found in your message. Supported: Instagram, Twitter, TikTok, Reddit.');\n",
  ""
);

// 2. Replace statusMsg and submitJobToApi
const target2 = `        // Send initial progress message
        const statusMsg = await ctx.reply('⏳ Requesting download...');
        
        // Call API Service
        const response = await submitJobToApi({
          url,
          userId: ctx.from.id,
          chatId: ctx.chat.id,
          statusMessageId: statusMsg.message_id
        });`;

const replacement2 = `        // Call API Service
        const response = await submitJobToApi({
          url,
          userId: ctx.from.id,
          chatId: ctx.chat.id,
          statusMessageId: undefined
        });`;
code = code.replace(target2, replacement2);

// 3. Remove deleteMessage since statusMsg is gone
const target3 = `        if (response.isDuplicate && response.telegramFileId) {
          await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});`;

const replacement3 = `        if (response.isDuplicate && response.telegramFileId) {`;
code = code.replace(target3, replacement3);


// 4. Replace success text update
const target4 = `          } catch (err) {
            await ctx.api.editMessageText(
              ctx.chat.id,
              statusMsg.message_id,
              '❌ Failed to send cached media.'
            ).catch(() => {});
          }
          continue;
        }

        // We could edit statusMsg here if we wanted, but the delivery service will do it
      } catch (error) {
        logger.error({ err: error, url }, 'Failed to submit download job');
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await ctx.reply(errorMessage);
      }`;

const replacement4 = `          } catch (err) {
            logger.error({ err }, 'Failed to send cached media.');
          }
          continue;
        }

        // We could send a chat action here
        await ctx.replyWithChatAction('upload_video').catch(() => {});

      } catch (error) {
        logger.error({ err: error, url }, 'Failed to submit download job');
      }`;

code = code.replace(target4, replacement4);

fs.writeFileSync('apps/bot/src/handlers/download.ts', code);
console.log("Patched download.ts");
