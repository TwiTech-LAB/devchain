import { isIP } from 'node:net';
import { z } from 'zod';

const PveIdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const DiscoverablePveIdentifierSchema = z.union([z.literal(''), PveIdentifierSchema]).default('');
const HostnameLabelPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function isHostnameOrIp(value: string): boolean {
  if (value.startsWith('[') || value.endsWith(']')) {
    return value.startsWith('[') && value.endsWith(']') && isIP(value.slice(1, -1)) === 6;
  }
  if (isIP(value)) return true;

  const hostname = value.endsWith('.') ? value.slice(0, -1) : value;
  return (
    hostname.length > 0 &&
    hostname.length <= 253 &&
    hostname.split('.').every((label) => label.length <= 63 && HostnameLabelPattern.test(label))
  );
}

const ProxmoxAddressSchema = z
  .string()
  .trim()
  .max(254)
  .refine((value) => value === '' || isHostnameOrIp(value), {
    message: 'Address must be a host name or IP address.',
  });

export const ProxmoxSetupBlockQuerySchema = z
  .object({
    pool: PveIdentifierSchema.default('devchain'),
    storage: DiscoverablePveIdentifierSchema,
    imageStorage: DiscoverablePveIdentifierSchema,
    bridge: DiscoverablePveIdentifierSchema,
    node: DiscoverablePveIdentifierSchema,
    address: ProxmoxAddressSchema.optional(),
  })
  .strict();

export type ProxmoxSetupBlockOptions = z.infer<typeof ProxmoxSetupBlockQuerySchema>;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function generateProxmoxSetupBlock(options: ProxmoxSetupBlockOptions): string {
  return `# DevChain Proxmox setup. Command syntax targets Proxmox VE 8.x.
# To issue a replacement token secret, change the final line to: devchain_proxmox_setup --rotate
DEVCHAIN_POOL=${shellQuote(options.pool)}
DEVCHAIN_STORAGE=${shellQuote(options.storage)}
DEVCHAIN_IMAGE_STORAGE=${shellQuote(options.imageStorage)}
DEVCHAIN_BRIDGE=${shellQuote(options.bridge)}
DEVCHAIN_NODE=${shellQuote(options.node)}
DEVCHAIN_DEFAULT_PVE_HOST=${shellQuote(options.address ?? '')}
DEVCHAIN_USER='devchain@pve'
DEVCHAIN_TOKEN_ID='agent'
DEVCHAIN_TOKEN_FULL_ID='devchain@pve!agent'
DEVCHAIN_STORAGE_CONFIG="\${PVE_STORAGE_CFG:-/etc/pve/storage.cfg}"

devchain_json_has() {
  python3 -c 'import json, sys
field, wanted = sys.argv[1:]
try:
    payload = json.load(sys.stdin)
except Exception:
    raise SystemExit(2)
rows = payload if isinstance(payload, list) else [payload]
found = any(isinstance(row, dict) and row.get(field) == wanted for row in rows)
raise SystemExit(0 if found else 1)' "$1" "$2" <<< "$3"
}

devchain_discover() {
  python3 -c 'import ipaddress, json, re, subprocess, sys
node, storage, image_storage, bridge = sys.argv[1:]

def rows(path, *args):
    try:
        payload = json.loads(subprocess.check_output(["pvesh", "get", path, *args, "--output-format", "json"], text=True))
        if not isinstance(payload, list) or any(not isinstance(row, dict) for row in payload):
            raise ValueError("expected a list of objects")
        return payload
    except (subprocess.CalledProcessError, ValueError) as error:
        raise SystemExit("Could not discover " + path + ": " + str(error))

def names(items, key):
    return sorted({row[key] for row in items if isinstance(row.get(key), str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", row[key])})

def choices(values):
    return ", ".join(values) or "none"

def pick(field, override, valid, preferred, reason="is not available"):
    if override and override not in valid:
        raise SystemExit(field + " " + override + " " + reason + "; available: " + choices(valid) + ".")
    if override:
        return override
    if not preferred:
        raise SystemExit(field + " <discover> cannot be selected automatically; available: " + choices(valid) + ". Set an override.")
    return preferred[0]

def default_bridge(items):
    gateways = [row for row in items if row.get("gateway")]
    return gateways[0] if len(gateways) == 1 else (items[0] if len(items) == 1 else None)

nodes = [row for row in rows("/cluster/status") if row.get("type") == "node"]
node_names = names(nodes, "name")
local_nodes = names([row for row in nodes if row.get("local") == 1], "name")
node = pick("Node", node, node_names, local_nodes if len(local_nodes) == 1 else [])
vm_rows = rows("/nodes/" + node + "/storage", "--enabled", "1", "--content", "images", "--format", "1")
vm_names = names([row for row in vm_rows if row.get("active", 0) == 1 and "select_existing" not in row], "storage")
vm_preferred = sorted(vm_names, key=lambda name: (0 if name == "local-lvm" else 1 if name == "local-zfs" else 2, name))
reason = "cannot allocate disks (select_existing)" if any(row.get("storage") == storage and "select_existing" in row for row in vm_rows) else "is not an active allocatable storage on node " + node
storage = pick("VM storage", storage, vm_names, vm_preferred, reason)
image_rows = rows("/nodes/" + node + "/storage", "--enabled", "1")
image_names = names([row for row in image_rows if row.get("active", 0) == 1 and row.get("type") in ("dir", "nfs", "cifs", "cephfs", "btrfs")], "storage")
image_storage = pick("Image storage", image_storage, image_names, sorted(image_names, key=lambda name: (name != "local", name)), "is not an active file storage on node " + node)
network = rows("/nodes/" + node + "/network", "--type", "any_local_bridge")
bridges = [row for row in network if row.get("active", 0) == 1]
bridge_names = names(bridges, "iface")
default = default_bridge(bridges)
bridge = pick("Bridge", bridge, bridge_names, [default["iface"]] if default and default.get("iface") in bridge_names else [], "does not exist or is not active on node " + node)
# The connection targets the node running this block, even with a placement-node override.
local_network = network if node in local_nodes else []
if node not in local_nodes and len(local_nodes) == 1:
    local_network = rows("/nodes/" + local_nodes[0] + "/network", "--type", "any_local_bridge")
local_default = default_bridge([row for row in local_network if row.get("active", 0) == 1])
bridge_ip = ""
try:
    address = ipaddress.ip_interface((local_default or {}).get("cidr", "")).ip
    if address.version == 4:
        bridge_ip = str(address)
except ValueError:
    pass
available = next((row.get("avail") for row in vm_rows if row.get("storage") == storage), None)
free = format(available / (1024 ** 3), ".1f") + " GiB free (information only)" if isinstance(available, (int, float)) else "free space unavailable"
for value in (node, storage, image_storage, bridge, bridge_ip, free):
    print(value)
for candidates, selected in ((node_names, node), (vm_names, storage), (image_names, image_storage), (bridge_names, bridge)):
    print(choices([name for name in candidates if name != selected]))
' "$DEVCHAIN_NODE" "$DEVCHAIN_STORAGE" "$DEVCHAIN_IMAGE_STORAGE" "$DEVCHAIN_BRIDGE"
}

devchain_storage_content() {
  awk -v wanted="$DEVCHAIN_IMAGE_STORAGE" '
    /^[[:space:]]*[^[:space:]#][[:alnum:]_-]*:[[:space:]]+/ {
      if (in_target) exit
      type = $1
      sub(/:$/, "", type)
      in_target = ($2 == wanted)
      next
    }
    in_target && /^[[:space:]]*content[[:space:]]+/ {
      sub(/^[[:space:]]*content[[:space:]]+/, "")
      print
      found_content = 1
      exit
    }
    END {
      if (!in_target || !found_content) exit 1
    }
  ' "$DEVCHAIN_STORAGE_CONFIG"
}

devchain_proxmox_setup() {
  (
  set -Eeuo pipefail
  local rotate=0 arg
  for arg in "$@"; do
    case "$arg" in
      --rotate) rotate=1 ;;
      *) echo 'Usage: devchain_proxmox_setup [--rotate]' >&2; return 2 ;;
    esac
  done

  for arg in pveum pvesm pvesh openssl python3 hostname base64 sed tr awk; do
    if ! command -v "$arg" >/dev/null 2>&1; then
      echo "Required command is missing: $arg" >&2
      return 1
    fi
  done
  if [[ ! -r "$DEVCHAIN_STORAGE_CONFIG" ]]; then
    echo 'Cannot read Proxmox storage configuration.' >&2
    return 1
  fi

  local discovery
  local -a placement
  discovery="$(devchain_discover)" || return 1
  mapfile -t placement <<< "$discovery"
  DEVCHAIN_NODE="\${placement[0]}"
  DEVCHAIN_STORAGE="\${placement[1]}"
  DEVCHAIN_IMAGE_STORAGE="\${placement[2]}"
  DEVCHAIN_BRIDGE="\${placement[3]}"

  local api_host api_port cert_path ca_path fingerprint ca_pem
  api_host="\${PVE_HOST:-\${DEVCHAIN_DEFAULT_PVE_HOST:-\${placement[4]:-$(hostname -f 2>/dev/null || hostname)}}}"
  api_port="\${PVE_PORT:-8006}"
  if [[ -z "$api_host" ]]; then
    echo 'Could not determine the Proxmox host name.' >&2
    return 1
  fi
  if [[ -n "\${PVE_CERT_PATH:-}" ]]; then
    cert_path="$PVE_CERT_PATH"
  elif [[ -r /etc/pve/local/pveproxy-ssl.pem ]]; then
    cert_path=/etc/pve/local/pveproxy-ssl.pem
  else
    cert_path=/etc/pve/local/pve-ssl.pem
  fi
  if [[ ! -r "$cert_path" ]]; then
    echo 'Could not read the Proxmox node certificate.' >&2
    return 1
  fi
  fingerprint="$(openssl x509 -in "$cert_path" -noout -fingerprint -sha256 | sed 's/^[^=]*=//' | tr -d ':' | tr '[:upper:]' '[:lower:]')"
  if [[ ! "$fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
    echo 'Could not read a valid SHA-256 certificate fingerprint.' >&2
    return 1
  fi
  ca_pem=''
  ca_path="\${PVE_ROOT_CA_PATH:-/etc/pve/pve-root-ca.pem}"
  if [[ -n "\${PVE_CERT_PATH:-}" || "$cert_path" == /etc/pve/local/pve-ssl.pem ]]; then
    if [[ -r "$ca_path" ]]; then ca_pem="$(base64 -w0 "$ca_path")"; fi
  fi

  local pools users roles tokens privileges content next_content token_json token_secret
  content="$(devchain_storage_content)" || {
    echo 'Could not read the image storage content list; no storage change was made.' >&2
    return 1
  }
  if [[ ",$content," == *,import,* ]]; then
    next_content="$content"
  else
    next_content="$content,import"
  fi
  if [[ "$next_content" != "$content" ]]; then
    pvesm set "$DEVCHAIN_IMAGE_STORAGE" --content "$next_content" >/dev/null || {
      echo "Image storage $DEVCHAIN_IMAGE_STORAGE could not enable import content; no permissions were changed." >&2
      return 1
    }
  fi

  pools="$(pveum pool list --output-format json)"
  if ! devchain_json_has poolid "$DEVCHAIN_POOL" "$pools"; then
    pveum pool add "$DEVCHAIN_POOL" --comment 'DevChain managed VMs' >/dev/null
  fi

  users="$(pveum user list --output-format json)"
  if ! devchain_json_has userid "$DEVCHAIN_USER" "$users"; then
    pveum user add "$DEVCHAIN_USER" --comment 'DevChain Proxmox VM provider' >/dev/null
  fi

  roles="$(pveum role list --output-format json)"
  privileges='Datastore.AllocateTemplate Datastore.Audit'
  if devchain_json_has roleid 'DevChainImageUpload' "$roles"; then
    pveum role modify DevChainImageUpload --privs "$privileges" >/dev/null
  else
    pveum role add DevChainImageUpload --privs "$privileges" >/dev/null
  fi
  roles="$(pveum role list --output-format json)"
  privileges='Sys.AccessNetwork'
  if devchain_json_has roleid 'DevChainNetFetch' "$roles"; then
    pveum role modify DevChainNetFetch --privs "$privileges" >/dev/null
  else
    pveum role add DevChainNetFetch --privs "$privileges" >/dev/null
  fi

  pveum acl modify "/pool/$DEVCHAIN_POOL" --users "$DEVCHAIN_USER" \
    --roles 'PVEVMAdmin,PVEPoolUser' --propagate 1 >/dev/null
  pveum acl modify "/storage/$DEVCHAIN_STORAGE" --users "$DEVCHAIN_USER" \
    --roles PVEDatastoreUser --propagate 1 >/dev/null
  pveum acl modify "/storage/$DEVCHAIN_IMAGE_STORAGE" --users "$DEVCHAIN_USER" \
    --roles 'PVEDatastoreUser,DevChainImageUpload' --propagate 1 >/dev/null
  pveum acl modify "/sdn/zones/localnetwork/$DEVCHAIN_BRIDGE" --users "$DEVCHAIN_USER" \
    --roles PVESDNUser --propagate 1 >/dev/null
  pveum acl modify "/nodes/$DEVCHAIN_NODE" --users "$DEVCHAIN_USER" \
    --roles DevChainNetFetch --propagate 1 >/dev/null

  printf "Node: %s (alternatives: %s)\\nVM storage: %s — %s (alternatives: %s)\\nImage storage: %s (alternatives: %s)\\nBridge: %s (alternatives: %s)\\nAddress: %s\\n" \\
    "$DEVCHAIN_NODE" "\${placement[6]}" "$DEVCHAIN_STORAGE" "\${placement[5]}" "\${placement[7]}" \\
    "$DEVCHAIN_IMAGE_STORAGE" "\${placement[8]}" "$DEVCHAIN_BRIDGE" "\${placement[9]}" "$api_host" >&2

  tokens="$(pveum user token list "$DEVCHAIN_USER" --output-format json)"
  if devchain_json_has tokenid "$DEVCHAIN_TOKEN_ID" "$tokens"; then
    if [[ "$rotate" -ne 1 ]]; then
      echo 'The existing token was preserved. Change the final line to devchain_proxmox_setup --rotate to issue a replacement secret.' >&2
      return 0
    fi
    pveum user token remove "$DEVCHAIN_USER" "$DEVCHAIN_TOKEN_ID" >/dev/null
  fi
  token_json="$(pveum user token add "$DEVCHAIN_USER" "$DEVCHAIN_TOKEN_ID" \\
    --privsep 0 --output-format json)"
  token_secret="$(python3 -c 'import json, sys
try:
    value = json.load(sys.stdin).get("value")
except Exception:
    raise SystemExit("Proxmox did not return a token value")
if not isinstance(value, str) or not value:
    raise SystemExit("Proxmox did not return a token value")
print(value)' <<< "$token_json")"
  unset token_json

  printf '%s\\0' "$api_host" "$api_port" "$DEVCHAIN_NODE" "$DEVCHAIN_POOL" \\
    "$DEVCHAIN_STORAGE" "$DEVCHAIN_IMAGE_STORAGE" "$DEVCHAIN_BRIDGE" \\
    "$fingerprint" "$DEVCHAIN_TOKEN_FULL_ID" "$token_secret" "$ca_pem" |
    python3 -c 'import sys
from urllib.parse import quote
parts = sys.stdin.buffer.read().split(b"\\0")
if parts and parts[-1] == b"": parts.pop()
if len(parts) != 11: raise SystemExit("Could not construct the connection string")
host, port, node, pool, storage, image_storage, bridge, fp, token_id, secret, ca = [part.decode() for part in parts]
if ":" in host and not host.startswith("["): host = "[" + host + "]"
fields = [("pool", pool), ("storage", storage), ("imageStorage", image_storage), ("bridge", bridge), ("fp", fp)]
query = "&".join(quote(key, safe="") + "=" + quote(value, safe="") for key, value in fields)
query += "&token=" + quote(token_id, safe="@!") + ":" + quote(secret, safe="")
if ca: query += "&ca=" + quote(ca, safe="")
print("devchain-proxmox://" + host + ":" + port + "/" + quote(node, safe="") + "?" + query)'
  unset token_secret
  )
}

devchain_proxmox_setup "$@"
`;
}
