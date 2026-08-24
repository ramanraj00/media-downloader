const fs = require('fs');
let code = fs.readFileSync('services/downloader/src/platforms/adapter.ts', 'utf-8');

const target = `'--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',`;
const replacement = target + `\n      '-S', 'vcodec:h264,res,acodec:m4a',`;

code = code.replace(target, replacement);
fs.writeFileSync('services/downloader/src/platforms/adapter.ts', code);
console.log("Patched adapter.ts");
