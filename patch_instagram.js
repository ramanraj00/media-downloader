const fs = require('fs');
let code = fs.readFileSync('services/downloader/src/platforms/instagram.ts', 'utf-8');

code = code.replace(
`      if (e instanceof AuthRequiredError) {
        this.logger.warn('Cobalt reported Auth Required. Falling back to yt-dlp...');
        return await this.tryYtDlp(url, outputDir, jobId);
      }
      // If it's a permanent error, we just throw it
      if (!e.isRetryable) {
        throw e;
      }
      // other retryable errors also throw
      throw e;`,
`      this.logger.warn({ err: e }, 'Cobalt failed. Falling back to yt-dlp...');
      return await this.tryYtDlp(url, outputDir, jobId);`
);

fs.writeFileSync('services/downloader/src/platforms/instagram.ts', code);
