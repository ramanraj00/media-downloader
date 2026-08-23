const fs = require('fs');
let code = fs.readFileSync('services/downloader/src/platforms/cobalt.ts', 'utf-8');
const target = `         const urlExt = new URL(data.url).pathname.split('.').pop();`;
const replacement = `         let urlExt;
         try { urlExt = new URL(data.url).pathname.split('.').pop(); } catch(e) {}`;
code = code.replace(target, replacement);
fs.writeFileSync('services/downloader/src/platforms/cobalt.ts', code);
