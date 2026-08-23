const fs = require('fs');
let code = fs.readFileSync('services/downloader/src/platforms/cobalt.ts', 'utf-8');

const target = `      let ext = 'mp4';
      if (filename.includes('.')) {
         ext = filename.split('.').pop() || 'mp4';
      }`;
const replacement = `      let ext = 'mp4';
      if (filename.includes('.')) {
         ext = filename.split('.').pop() || 'mp4';
      } else if (data?.url && data.url.includes('.')) {
         // Extract from URL (e.g. redirect to .jpg)
         const urlExt = new URL(data.url).pathname.split('.').pop();
         if (urlExt && ['jpg', 'jpeg', 'png', 'webp', 'mp4', 'webm', 'gif'].includes(urlExt.toLowerCase())) {
            ext = urlExt.toLowerCase();
         }
      }`;

code = code.replace(target, replacement);
fs.writeFileSync('services/downloader/src/platforms/cobalt.ts', code);
