#!/bin/bash
dnf install -y squid
sed -i 's/http_access deny all/http_access allow all/' /etc/squid/squid.conf
systemctl enable squid
systemctl start squid
