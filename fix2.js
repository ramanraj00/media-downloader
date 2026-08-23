const fs = require('fs');

function fix(file) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/import \{ exec \} from 'child_process';/g, "import { execFile } from 'child_process';");
  content = content.replace(/const execAsync = util\.promisify\(exec\);/g, "const execFileAsync = util.promisify(execFile);");
  fs.writeFileSync(file, content);
}

['services/downloader/src/platforms/reddit.ts', 'services/downloader/src/platforms/tiktok.ts'].forEach(fix);
