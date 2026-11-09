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
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
# The public, idempotent download can be reset by the remote peer (curl 56).
# Retry transport errors within a bound; install only after fingerprint validation.
curl --fail --silent --show-error --location --retry 3 --retry-all-errors --connect-timeout 20 --max-time 90 --retry-max-time 240 https://www.postgresql.org/media/keys/ACCC4CF8.asc -o "$temporary/pgdg.asc"
fingerprint=$(gpg --show-keys --with-colons "$temporary/pgdg.asc" | awk -F: '$1=="fpr" {print $10; exit}')
test "$fingerprint" = B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
sudo install -m 0644 "$temporary/pgdg.asc" "$key"
printf 'deb [signed-by=%s] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' "$key" "$VERSION_CODENAME" | sudo tee /etc/apt/sources.list.d/staffly-pgdg.list >/dev/null
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends postgresql-18 postgresql-contrib-18
sudo locale-gen en_US.UTF-8
/usr/lib/postgresql/18/bin/initdb --version
