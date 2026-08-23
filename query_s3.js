const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
const client = new S3Client({ region: 'ap-south-1' });
async function run() {
  const hash = '15178b94911842bc4659c8636d07a2df743d77555098c873e0c289b073d0e950';
  const command = new HeadObjectCommand({
    Bucket: 'media-downloader-artifacts-200845569642-ap-south-1',
    Key: `artifacts/${hash}`
  });
  const result = await client.send(command);
  console.log(result.ContentType);
  process.exit(0);
}
run().catch(console.error);
