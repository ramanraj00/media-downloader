const fs = require('fs');

function fix(file) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/import \{ exec \}/g, "import { execFile }");
  content = content.replace(/const execAsync = promisify\(exec\)/g, "const execFileAsync = promisify(execFile)");
  content = content.replace(/const command = `yt-dlp \$\{opts\.join\(' '\)\} --dump-json --no-simulate "\$\{url\}"`;/g, "const finalOpts = [...opts, '--dump-json', '--no-simulate', url];");
  content = content.replace(/await execAsync\(command, /g, "await execFileAsync('yt-dlp', finalOpts, ");
  content = content.replace(/opts\.push\('--proxy', `'\$\{options\.proxy\}'`\);/g, "opts.push('--proxy', options.proxy);");
  content = content.replace(/opts\.push\('--cookies', `'\$\{options\.cookies\}'`\);/g, "opts.push('--cookies', options.cookies);");
  fs.writeFileSync(file, content);
}

['services/downloader/src/platforms/reddit.ts', 'services/downloader/src/platforms/tiktok.ts'].forEach(fix);

let adapter = fs.readFileSync('services/downloader/src/platforms/adapter.ts', 'utf8');
adapter = adapter.replace(/'-o', `'\$\{outputDir\}\/%\(id\)s\.%\(ext\)s'`/g, "'-o', `${outputDir}/%(id)s.%(ext)s`");
adapter = adapter.replace(/'--add-header', `'(.*?)'`/g, "'--add-header', '$1'");
fs.writeFileSync('services/downloader/src/platforms/adapter.ts', adapter);
