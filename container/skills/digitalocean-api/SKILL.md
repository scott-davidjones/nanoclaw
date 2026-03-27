# DigitalOcean API

Access the DigitalOcean API via `curl`. Authentication is handled automatically by the OneCLI gateway — no tokens needed.

Base URL: `https://api.digitalocean.com/v2`

## Droplets

```bash
# List all droplets
curl -s https://api.digitalocean.com/v2/droplets | jq '.droplets[] | {id, name, status, region: .region.slug, ip: .networks.v4[0].ip_address}'

# Get a specific droplet
curl -s https://api.digitalocean.com/v2/droplets/<id> | jq .droplet

# Create a droplet
curl -s -X POST https://api.digitalocean.com/v2/droplets \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-droplet","region":"lon1","size":"s-1vcpu-1gb","image":"ubuntu-24-04-x64"}'

# Delete a droplet
curl -s -X DELETE https://api.digitalocean.com/v2/droplets/<id>

# Power on/off/reboot
curl -s -X POST https://api.digitalocean.com/v2/droplets/<id>/actions \
  -H 'Content-Type: application/json' \
  -d '{"type":"power_off"}'
```

## Domains & DNS

```bash
# List domains
curl -s https://api.digitalocean.com/v2/domains | jq '.domains[] | {name, ttl}'

# List DNS records
curl -s https://api.digitalocean.com/v2/domains/<domain>/records | jq '.domain_records[] | {id, type, name, data}'

# Create DNS record
curl -s -X POST https://api.digitalocean.com/v2/domains/<domain>/records \
  -H 'Content-Type: application/json' \
  -d '{"type":"A","name":"sub","data":"1.2.3.4","ttl":300}'

# Update DNS record
curl -s -X PUT https://api.digitalocean.com/v2/domains/<domain>/records/<record-id> \
  -H 'Content-Type: application/json' \
  -d '{"data":"5.6.7.8"}'

# Delete DNS record
curl -s -X DELETE https://api.digitalocean.com/v2/domains/<domain>/records/<record-id>
```

## Databases

```bash
# List databases
curl -s https://api.digitalocean.com/v2/databases | jq '.databases[] | {id, name, engine, status, region: .region}'

# Get connection info
curl -s https://api.digitalocean.com/v2/databases/<id> | jq '.database.connection'
```

## Kubernetes

```bash
# List clusters
curl -s https://api.digitalocean.com/v2/kubernetes/clusters | jq '.kubernetes_clusters[] | {id, name, region, status: .status.state}'
```

## Apps

```bash
# List apps
curl -s https://api.digitalocean.com/v2/apps | jq '.apps[] | {id, spec: .spec.name, live_url: .live_url}'
```

## Account

```bash
# Account info
curl -s https://api.digitalocean.com/v2/account | jq .account

# Balance
curl -s https://api.digitalocean.com/v2/customers/my/balance | jq .
```

## Pagination

Most list endpoints support `page` and `per_page` params:
```bash
curl -s 'https://api.digitalocean.com/v2/droplets?page=1&per_page=50' | jq .
```

## Full API reference

For endpoints not listed here, see https://docs.digitalocean.com/reference/api/api-reference/
