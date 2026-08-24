const fs = require('fs');
const file = 'services/delivery/src/uploader.ts';
let code = fs.readFileSync(file, 'utf-8');

const target1 = `const msg = await bot.api.sendVideo(jobRecord.chatId, file, {
        caption: \`📥 Downloaded via \${botName}\`,
      });`;

const replacement1 = `
      let thumbInput = undefined;
      if (data.thumbArtifact) {
         try {
           const thumbStream = await s3.getArtifactStream(data.thumbArtifact.bucket, data.thumbArtifact.key);
           thumbInput = new InputFile(thumbStream);
         } catch(e) {
           logger.warn('Failed to stream thumb artifact');
         }
      }
      
      const msg = await bot.api.sendVideo(jobRecord.chatId, file, {
        caption: \`📥 Downloaded via \${botName}\`,
        width: data.width,
        height: data.height,
        duration: data.duration ? Math.round(data.duration) : undefined,
        thumb: thumbInput
      });`;

code = code.replace(target1, replacement1);
fs.writeFileSync(file, code);
console.log('Patched delivery');
