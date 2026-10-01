#!/usr/bin/env bash
set -euo pipefail
[[ $(hostname) == workstation2 ]]
[[ $(id -un) == ngsupb ]]
[[ $(sudo -n docker version --format '{{.Server.Version}}') == 29.7.2 ]]
[[ -z $(sudo -n docker ps -aq) ]]
[[ -z $(sudo -n docker volume ls -q) ]]
[[ -z $(sudo -n docker network ls -q --filter type=custom) ]]
[[ $(sudo -n docker image ls --format '{{.Repository}}:{{.Tag}}') == alpine:3.22 ]]
sudo -n docker image rm alpine:3.22
[[ $(findmnt -n -o SOURCE --target /var/lib/docker) == dc-proof-docker ]]
sudo -n systemctl stop docker.service docker.socket containerd.service
sudo -n umount /var/lib/docker
sudo -n env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo -n rm -rf -- /var/lib/docker /var/lib/containerd
sudo -n rm -f -- /etc/apt/sources.list.d/docker.sources /etc/apt/keyrings/docker.asc
rm -f -- /tmp/docker-source-proof.py /tmp/docker-reconnect-proof.py /tmp/docker-stream-proof.mjs /tmp/dc-proof-apt-update.log /tmp/dc-proof-apt-install.log
for p in /var/lib/docker /var/lib/containerd /etc/apt/sources.list.d/docker.sources /etc/apt/keyrings/docker.asc; do
  [[ ! -e "$p" ]]
  echo "ABSENT $p"
done
if command -v docker; then exit 1; fi
for package in docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; do
  status=$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true)
  [[ "$status" != installed ]]
done
systemctl show devchain-host.service -p MainPID -p ActiveState
id
df -B1 /
