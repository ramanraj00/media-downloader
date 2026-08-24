const fs = require('fs');
let code = fs.readFileSync('services/downloader/src/platforms/adapter.ts', 'utf-8');

const target = `      '--extractor-retries', '3',`;
const replacement = target + `\n      '--max-filesize', '50M',`;

code = code.replace(target, replacement);
fs.writeFileSync('services/downloader/src/platforms/adapter.ts', code);
console.log("Patched adapter.ts size limit");
