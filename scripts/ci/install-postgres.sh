#!/usr/bin/env bash
set -euo pipefail

# Run only on a disposable Ubuntu Actions runner/container, never on a server.
# shellcheck source=/dev/null
source /etc/os-release
test "$ID" = ubuntu
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends curl ca-certificates gnupg locales tzdata tzdata-legacy
sudo install -d /usr/share/postgresql-common/pgdg
key=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
sudo curl --fail --silent --show-error --location https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$key"
fingerprint=$(gpg --show-keys --with-colons "$key" | awk -F: '$1=="fpr" {print $10; exit}')
test "$fingerprint" = B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
printf 'deb [signed-by=%s] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' "$key" "$VERSION_CODENAME" | sudo tee /etc/apt/sources.list.d/staffly-pgdg.list >/dev/null
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends postgresql-18 postgresql-contrib-18
sudo locale-gen en_US.UTF-8
/usr/lib/postgresql/18/bin/initdb --version
