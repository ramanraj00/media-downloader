const fs = require('fs');
let code = fs.readFileSync('packages/core/src/platform.ts', 'utf-8');

code = code.replace(
  "/t\\.co/i,",
  "/\\\\/\/t\\\\.co\\\\//i," // matches //t.co/
);

fs.writeFileSync('packages/core/src/platform.ts', code);
