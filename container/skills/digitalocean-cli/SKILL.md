# DigitalOcean CLI

You have access to `doctl` (DigitalOcean CLI). Authentication is handled automatically via the OneCLI gateway.

## Common Operations

```bash
# List droplets
doctl compute droplet list

# Get droplet details
doctl compute droplet get <droplet-id>

# Create a droplet
doctl compute droplet create <name> --region <region> --size <size> --image <image>

# List databases
doctl databases list

# List domains
doctl compute domain list

# List Kubernetes clusters
doctl kubernetes cluster list

# List apps
doctl apps list

# Check account info
doctl account get
```

## Direct API Access

You can also call the DigitalOcean API directly. The OneCLI gateway injects auth for `api.digitalocean.com`:

```bash
curl -s https://api.digitalocean.com/v2/droplets | jq .
```
