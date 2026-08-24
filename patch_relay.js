const fs = require('fs');
let code = fs.readFileSync('services/relay/src/index.ts', 'utf-8');

const target = `        const botToken = config.BOT_TOKEN;
        if (botToken) {
          // Forward the pre-uploaded fileId to the user via Telegram Bot API
          const response = await fetch(\`https://api.telegram.org/bot\${botToken}/sendVideo\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: payload.chatId,
              video: payload.telegramFileId,
              reply_to_message_id: payload.statusMessageId,
              caption: '✅ Your media is ready!'
            })
          });
          
          if (!response.ok) {
            const rawErrText = await response.text();
            // Security: Redact bot token from error text just in case Telegram echoes it
            const errText = rawErrText.replace(new RegExp(botToken, 'g'), '[REDACTED_TOKEN]');

            if (response.status >= 500 || response.status === 429) {
              // 5xx (Telegram server error) or 429 (rate limit) -> Transient, retry with backoff
              throw new Error(\`Telegram API Error: \${response.status} \${errText}\`);
            } else if (response.status === 401 || response.status === 404) {
              // Configuration errors -> Alert/Fail, discard event
              logger.error({ errText, status: response.status, eventId: claimedEvent.id }, 'Configuration Error (Invalid Bot Token or Endpoint), discarding event');
              await db.update(outboxEvents)
                .set({ status: 'discarded', lastError: \`Telegram Config Error \${response.status}: \${errText}\`, updatedAt: new Date() })
                .where(eq(outboxEvents.id, claimedEvent.id));
              return;
            } else {
              // 400 (invalid request) or 403 (bot blocked) -> Permanent rejection, discard event
              logger.warn({ errText, status: response.status, eventId: claimedEvent.id }, 'Permanent Telegram rejection (e.g. Bot Blocked), discarding event');
              await db.update(outboxEvents)
                .set({ status: 'discarded', lastError: \`Telegram Rejection \${response.status}: \${errText}\`, updatedAt: new Date() })
                .where(eq(outboxEvents.id, claimedEvent.id));
              return;
            }
          }
        }`;

const replacement = `        // The Delivery service already directly sends the video/photo to the user via bot.api.
        // There is no need to send it again here. This event is strictly for webhooks if we add them later.`;

code = code.replace(target, replacement);

fs.writeFileSync('services/relay/src/index.ts', code);
console.log('Patched Relay');
