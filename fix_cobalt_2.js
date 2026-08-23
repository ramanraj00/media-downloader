const fs = require('fs');
let code = fs.readFileSync('services/downloader/src/platforms/cobalt.ts', 'utf-8');

// I put `let ext = 'mp4';` inside the `try` block but maybe I referenced it outside?
// Wait, the error is:
// services/downloader/src/platforms/cobalt.ts(91,78): error TS2552: Cannot find name 'ext'. Did you mean 'Text'?
// Because I put `let ext` inside `try {` block at line 83? No wait, `try {` starts at line 36.
// But `try {` does contain line 91! Why can't it find `ext`?
// Let me look at line 83-93 of cobalt.ts
