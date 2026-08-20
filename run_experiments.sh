#!/bin/bash
set -e

mkdir -p /tmp/ffmpeg_tests
cd /tmp/ffmpeg_tests

echo "Generating synthetic 10s video..."
ffmpeg -v quiet -y -f lavfi -i testsrc=duration=10:size=640x360:rate=30 -c:v libx264 v10.mp4
echo "Generating synthetic 30s video..."
ffmpeg -v quiet -y -f lavfi -i testsrc=duration=30:size=640x360:rate=30 -c:v libx264 v30.mp4

echo "Generating synthetic 10s audio..."
ffmpeg -v quiet -y -f lavfi -i sine=frequency=1000:duration=10 -c:a aac a10.m4a
echo "Generating synthetic 30s audio..."
ffmpeg -v quiet -y -f lavfi -i sine=frequency=1000:duration=30 -c:a aac a30.m4a

# Scenario 1: Video 10s, Audio 30s
echo "Assembling Scenario 1: v10 + a30 -> input1.mp4"
ffmpeg -v quiet -y -i v10.mp4 -i a30.m4a -c copy -map 0:v:0 -map 1:a:0 input1.mp4

# Scenario 2: Video 30s, Audio 10s
echo "Assembling Scenario 2: v30 + a10 -> input2.mp4"
ffmpeg -v quiet -y -i v30.mp4 -i a10.m4a -c copy -map 0:v:0 -map 1:a:0 input2.mp4

# Scenario 3: Multiple audio tracks
echo "Generating synthetic 10s audio (Hindi beep)..."
ffmpeg -v quiet -y -f lavfi -i sine=frequency=440:duration=10 -c:a aac a10_hi.m4a
echo "Assembling Scenario 3: v10 + a10 (Eng) + a10_hi (Hin) -> input3.mp4"
ffmpeg -v quiet -y -i v10.mp4 -i a10.m4a -i a10_hi.m4a -map 0:v -map 1:a -map 2:a -c copy -metadata:s:a:0 language=eng -metadata:s:a:1 language=hin input3.mp4

transcode() {
  input=$1
  output=$2
  echo "------------------------------------------------"
  echo "Transcoding $input to $output using current pipeline..."
  
  # Exact command from codebase (using pass 1 and pass 2)
  ffmpeg -v quiet -y -i "$input" -c:v libx264 -preset medium -b:v 1M -pass 1 -an -f mp4 /dev/null
  ffmpeg -v quiet -y -i "$input" -c:v libx264 -preset medium -b:v 1M -pass 2 -c:a aac -b:a 128k -movflags +faststart "$output"
  
  echo "FFPROBE RESULTS FOR $output:"
  ffprobe -v quiet -print_format json -show_format -show_streams "$output" > "${output}_probe.json"
  
  echo "Streams found:"
  cat "${output}_probe.json" | jq -c '.streams[] | {index, codec_type, duration}'
  
  echo "Format duration:"
  cat "${output}_probe.json" | jq -r '.format.duration'
}

echo "Running transcode tests..."
transcode input1.mp4 output1.mp4
transcode input2.mp4 output2.mp4
transcode input3.mp4 output3.mp4

echo "DONE."
