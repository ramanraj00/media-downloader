const fs = require('fs');
let code = fs.readFileSync('services/downloader/src/platforms/twitter.ts', 'utf-8');

// Insert tryVxTwitter into the extract method before throwing
const extractTarget = `    const bestError = this.pickMostSpecificError(cobaltError!, ytdlpError!);
    throw bestError;`;
const extractReplacement = `    // Tier 3: Fall back to vxTwitter API (Great for images that yt-dlp misses)
    try {
      return await this.tryVxTwitter(url, outputDir);
    } catch (err: any) {
      logger.warn({ url, errorType: err.constructor.name }, 'vxTwitter extraction also failed');
    }

    const bestError = this.pickMostSpecificError(cobaltError!, ytdlpError!);
    throw bestError;`;
code = code.replace(extractTarget, extractReplacement);

// Add tryVxTwitter method
const methodReplacement = `  private async tryVxTwitter(url: string, outputDir: string): Promise<import("@media-downloader/types").ExtractionResult> {
    logger.info({ url }, 'Tier 3: Attempting vxTwitter extraction (Image fallback)');
    
    // Convert url to api.vxtwitter.com
    let vxUrl = url.replace('twitter.com', 'vxtwitter.com').replace('x.com', 'vxtwitter.com');
    // Ensure we are calling the API
    const match = vxUrl.match(/vxtwitter\\.com\\/(.*?)\\/status\\/(\\d+)/);
    if (!match) throw new PermanentError('Invalid Twitter URL for vxTwitter');
    const apiUrl = \`https://api.vxtwitter.com/\${match[1]}/status/\${match[2]}\`;

    const res = await fetch(apiUrl);
    if (!res.ok) throw new PermanentError(\`vxTwitter API returned \${res.status}\`);
    const data = await res.json();
    
    if (!data.hasMedia || !data.media_extended || data.media_extended.length === 0) {
       throw new ContentNotFoundError('No media found in vxTwitter response', 'twitter');
    }

    // Prefer video if available, else first image
    const media = data.media_extended.find((m: any) => m.type === 'video') || data.media_extended[0];
    const mediaUrl = media.url;
    
    // Download the media
    const ext = mediaUrl.split('.').pop()?.split('?')[0] || 'jpg';
    const filePath = path.join(outputDir, \`vxtwitter_\${match[2]}.\${ext}\`);
    
    const mediaRes = await fetch(mediaUrl);
    if (!mediaRes.ok) throw new PermanentError(\`Failed to download media from \${mediaUrl}\`);
    
    const buffer = await mediaRes.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(buffer));
    
    return {
      status: 'success',
      source: 'vxtwitter',
      filePath,
      metadata: {
        url,
        platform: this.platform,
        title: data.text,
        fileSize: buffer.byteLength,
        ext,
        hasVideo: media.type === 'video',
        hasAudio: media.type === 'video',
      }
    };
  }

  private pickMostSpecificError`;

code = code.replace('  private pickMostSpecificError', methodReplacement);
fs.writeFileSync('services/downloader/src/platforms/twitter.ts', code);
