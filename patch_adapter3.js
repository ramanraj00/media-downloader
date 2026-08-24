const fs = require('fs');
let code = fs.readFileSync('services/downloader/src/platforms/adapter.ts', 'utf-8');

const target = `      '-S', 'vcodec:h264,res,acodec:m4a',`;
const replacement = `      '-S', 'res:720,vcodec:h264,acodec:m4a',`;

code = code.replace(target, replacement);
fs.writeFileSync('services/downloader/src/platforms/adapter.ts', code);
console.log("Patched adapter.ts res:720");
