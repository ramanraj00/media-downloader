const fs = require('fs');
const file = 'services/media-processor/src/worker.ts';
let code = fs.readFileSync(file, 'utf-8');
code = code.replace(/min'\\(320,ih\\)'/g, "'min(320,ih)'");
fs.writeFileSync(file, code);
