#!/bin/bash
set -euo pipefail

PROFILE="${1:-build}"

iptables -F OUTPUT 2>/dev/null || true
iptables -F INPUT 2>/dev/null || true

iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A INPUT -p udp --sport 53 -j ACCEPT

iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

ipset destroy allowed-domains 2>/dev/null || true
ipset create allowed-domains hash:net

for domain in \
  "api.anthropic.com" \
  "statsig.anthropic.com" \
  "statsig.com" \
  "sentry.io"; do
  ips=$(dig +noall +answer A "$domain" 2>/dev/null | awk '$4 == "A" {print $5}')
  for ip in $ips; do
    ipset add allowed-domains "$ip" 2>/dev/null || true
  done
done

case "$PROFILE" in
  research)
    iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT
    iptables -A OUTPUT -p tcp --dport 80 -j ACCEPT
    ;;

  build)
    gh_ranges=$(curl -s --connect-timeout 5 https://api.github.com/meta 2>/dev/null || echo "")
    if [ -n "$gh_ranges" ] && echo "$gh_ranges" | jq -e '.web' >/dev/null 2>&1; then
      echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' 2>/dev/null | \
        aggregate -q 2>/dev/null | while read -r cidr; do
          ipset add allowed-domains "$cidr" 2>/dev/null || true
        done
    fi

    for domain in \
      "registry.npmjs.org" \
      "pypi.org" \
      "files.pythonhosted.org" \
      "crates.io" \
      "static.crates.io" \
      "dl.google.com" \
      "deb.nodesource.com"; do
      ips=$(dig +noall +answer A "$domain" 2>/dev/null | awk '$4 == "A" {print $5}')
      for ip in $ips; do
        ipset add allowed-domains "$ip" 2>/dev/null || true
      done
    done

    iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT
    ;;

  none)
    iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT
    ;;
esac

if [ "$PROFILE" != "research" ]; then
  iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited
fi

iptables -P INPUT DROP
iptables -P FORWARD DROP

echo "Firewall profile '$PROFILE' applied"
