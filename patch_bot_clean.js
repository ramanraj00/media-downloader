const fs = require('fs');
let code = fs.readFileSync('apps/bot/src/handlers/download.ts', 'utf-8');

const target = `          } catch (e) {
             // Fallback to photo if Telegram stored it as photo
             await ctx.replyWithPhoto(response.telegramFileId, {
                caption: \`📥 Downloaded via @therealretardbot\`,
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

        logger.info({ jobId: response.jobId, url }, 'Job submitted successfully');`;

const replacement = `          } catch (e) {
             // Fallback to photo if Telegram stored it as photo
             await ctx.replyWithPhoto(response.telegramFileId, {
                caption: \`📥 Downloaded via @therealretardbot\`,
             });
          }
          continue;
        }

        logger.info({ jobId: response.jobId, url }, 'Job submitted successfully');`;

code = code.replace(target, replacement);
fs.writeFileSync('apps/bot/src/handlers/download.ts', code);
console.log("Patched download.ts");
