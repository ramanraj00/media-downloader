const fs = require('fs');
let code = fs.readFileSync('services/downloader/src/platforms/cobalt.ts', 'utf-8');

const target = `videoQuality: '1080'`;
const replacement = `videoQuality: '720'`;

code = code.replace(target, replacement);
fs.writeFileSync('services/downloader/src/platforms/cobalt.ts', code);
console.log("Patched cobalt.ts");
