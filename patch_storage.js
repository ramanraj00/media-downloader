const fs = require('fs');
const file = 'packages/core/src/storage.ts';
let code = fs.readFileSync(file, 'utf-8');

code = code.replace("async init() {\\n    await fs.mkdir(this.baseDir, { recursive: true });\\n  }", "init() {\\n    require('fs').mkdirSync(this.baseDir, { recursive: true });\\n  }");

fs.writeFileSync(file, code);

// Remove top level await in all services
const { execSync } = require('child_process');
execSync("find services packages apps -type f -name '*.ts' -exec sed -i '' 's/await s3.init();//g' {} +");
