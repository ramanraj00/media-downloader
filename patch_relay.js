const fs = require('fs');
let code = fs.readFileSync('services/relay/src/index.ts', 'utf-8');

code = code.replace(
`logger.info({ jobId, queueName, failedReason }, 'Job marked FAILED_PERMANENTLY and quota released');`,
`logger.info({ jobId, queueName, failedReason }, 'Job marked FAILED_PERMANENTLY and quota released');
          
          if (currentJob.chatId && currentJob.statusMessageId) {
            const tgUrl = \`https://api.telegram.org/bot\${config.TELEGRAM_BOT_TOKEN}/editMessageText\`;
            fetch(tgUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: currentJob.chatId,
                message_id: currentJob.statusMessageId,
                text: '❌ Failed to process request.\\n(Could not find any media, or the link is private)'
              })
            }).catch(e => logger.error({ err: e }, 'Failed to send failure notification to Telegram'));
          }`
);

fs.writeFileSync('services/relay/src/index.ts', code);
