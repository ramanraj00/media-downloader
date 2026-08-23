url="https://www.tiktok.com/@mrbeast/video/7279140417936903466"
while read p; do
  p=$(echo "$p" | tr -d '\r')
  echo "Testing proxy socks5://$p..."
  out=$(yt-dlp --proxy "socks5://$p" --dump-json --no-simulate "$url" 2>&1)
  if echo "$out" | grep -q "Unexpected response from webpage request"; then
    echo "  -> Failed (GeoBlocked)"
  elif echo "$out" | grep -q "Your IP address is blocked"; then
    echo "  -> Failed (IP Blocked)"
  elif echo "$out" | grep -q "title"; then
    echo "  -> SUCCESS!"
    echo "socks5://$p" > working_proxy.txt
    break
  else
    echo "  -> Failed (Connection/Timeout)"
  fi
done < proxies.txt
