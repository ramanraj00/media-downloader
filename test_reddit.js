const { execSync } = require('child_process');
console.log("\nTesting yt-dlp...");
try {
  const ytdlpRes = execSync('yt-dlp --dump-json "https://www.reddit.com/r/MadeMeSmile/comments/6t7wi5/wait_for_it/"').toString();
  const data = JSON.parse(ytdlpRes);
  console.log("yt-dlp success. Title:", data.title);
} catch (e) { 
  console.error("yt-dlp Error stdout:", e.stdout?.toString()); 
  console.error("yt-dlp Error stderr:", e.stderr?.toString()); 
}
process.exit(0);
