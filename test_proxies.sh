proxies=(
  "171.240.15.234:8080"
  "82.86.112.52:999"
  "103.118.85.75:6321"
  "180.194.9.255:8081"
  "147.189.169.226:8118"
  "124.105.87.12:8087"
  "190.26.255.30:999"
  "180.191.234.124:8080"
  "200.48.35.122:999"
  "130.0.238.207:10001"
)
url="https://www.tiktok.com/@mrbeast/video/7279140417936903466"

for p in "${proxies[@]}"; do
  echo "Testing proxy http://$p..."
  out=$(yt-dlp --proxy "http://$p" --dump-json --no-simulate "$url" 2>&1)
  if echo "$out" | grep -q "Unexpected response from webpage request"; then
    echo "  -> Failed (GeoBlocked)"
  elif echo "$out" | grep -q "Your IP address is blocked"; then
    echo "  -> Failed (IP Blocked)"
  elif echo "$out" | grep -q "title"; then
    echo "  -> SUCCESS!"
    echo "http://$p" > working_proxy.txt
    break
  else
    echo "  -> Failed (Connection/Timeout)"
  fi
done
