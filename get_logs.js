const { CloudWatchLogsClient, GetLogEventsCommand } = require("@aws-sdk/client-cloudwatch-logs");
const client = new CloudWatchLogsClient({ region: "ap-south-1" });

async function getLogs(logGroupName) {
  try {
    const data = await client.send(new GetLogEventsCommand({
      logGroupName,
      logStreamName: "bot/bot-container/recent", // Wait, stream name varies. We need to describe log streams first.
    }));
    return data;
  } catch (e) { return null; }
}
