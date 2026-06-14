import base64
import urllib.parse
import requests
import json

class Parser:
    """
    Component: Parser
    Responsible for fetching and parsing subscription links into structured node objects.
    Supports VLESS, TUIC, and Hysteria2 protocols.
    Supports both standard line-based links and Sing-Box JSON format.
    """
    def fetch_and_parse(self, url):
        print(f"Fetching subscription from: {url}")
        try:
            headers = {
                'User-Agent': 'ClashMeta/1.0',
            }
            resp = requests.get(url, headers=headers, timeout=15)
            resp.raise_for_status()
            content = resp.text.strip()

            # Try parsing as JSON (Sing-Box format) first
            try:
                json_data = json.loads(content)
                if 'outbounds' in json_data:
                    print("Detected Sing-Box JSON format.")
                    return self.parse_singbox_json(json_data)
            except json.JSONDecodeError:
                pass

            # Helper to add padding
            def decode_base64(s):
                s = s.strip()
                missing_padding = len(s) % 4
                if missing_padding:
                    s += '=' * (4 - missing_padding)
                return base64.b64decode(s).decode('utf-8')

            try:
                decoded = decode_base64(content)
            except Exception:
                # Assume plaintext list if decoding fails
                decoded = content

            lines = decoded.splitlines()
            nodes = []
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    node = self.parse_node(line)
                    if node:
                        nodes.append(node)
                except Exception as e:
                    print(f"Failed to parse line {line}: {e}")
            return nodes
        except Exception as e:
            print(f"Error fetching/parsing subscription: {e}")
            return []

    def _first_param(self, params, *names, default=''):
        for name in names:
            value = params.get(name)
            if value:
                return value[0]
        return default

    def _parse_bool(self, value, default=False):
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in ['1', 'true', 'yes', 'on']

    def _parse_alpn(self, params):
        alpn = self._first_param(params, 'alpn', default='')
        if not alpn:
            return None
        return [x.strip() for x in urllib.parse.unquote(alpn).split(',') if x.strip()]

    def parse_singbox_json(self, data):
        nodes = []
        outbounds = data.get('outbounds', [])
        for out in outbounds:
            node_type = out.get('type')
            # Ignore selector, urltest, direct, block etc. Only interested in proxy types.
            if node_type not in ['vless', 'tuic', 'hysteria2', 'trojan']:
                continue

            try:
                if node_type == 'vless':
                    nodes.append(self.parse_singbox_vless(out))
                elif node_type == 'tuic':
                    nodes.append(self.parse_singbox_tuic(out))
                elif node_type == 'hysteria2':
                    nodes.append(self.parse_singbox_hy2(out))
                elif node_type == 'trojan':
                    nodes.append(self.parse_singbox_trojan(out))
            except Exception as e:
                print(f"Failed to parse singbox node {out.get('tag', 'unknown')}: {e}")
        return nodes

    def parse_singbox_vless(self, out):
        tls = out.get('tls', {})
        reality = tls.get('reality', {})

        # Determine UDP support based on Sing-Box 'network' field (traffic type restriction)
        # and 'udp_over_tcp' setting.
        udp_support = True
        sb_network = out.get('network') # Sing-Box network restriction (tcp/udp)
        if sb_network:
            if isinstance(sb_network, str):
                sb_network = [sb_network]
            if 'udp' not in sb_network:
                udp_support = False

        if out.get('udp_over_tcp') is False:
            udp_support = False

        node = {
            'name': out['tag'],
            'type': 'vless',
            'server': out['server'],
            'port': out['server_port'],
            'uuid': out['uuid'],
            'network': out.get('transport', {}).get('type', 'tcp'), # Clash transport type
            'udp': udp_support,
            'tls': tls.get('enabled', False),
        }

        # If transport is empty or creates 'tcp' type implicitly
        if not node['network']:
             node['network'] = 'tcp'

        if node['tls']:
            node['servername'] = tls.get('server_name', '')

            if reality.get('enabled'):
                node['flow'] = out.get('flow', '') # flow is top level in vless singbox
                if not node['flow']: # sometimes flow is missing or empty
                     pass

                # In clash meta, reality implies tls=true, but specific fields
                # We need to map reality-opts
                node['client-fingerprint'] = tls.get('utls', {}).get('fingerprint', 'chrome')
                node['reality-opts'] = {
                    'public-key': reality.get('public_key'),
                    'short-id': reality.get('short_id')
                }

        # flow is also top level for vless+vision without reality?
        # In the example: "flow": "xtls-rprx-vision"
        if out.get('flow'):
            node['flow'] = out['flow']

        return node

    def parse_singbox_tuic(self, out):
        tls = out.get('tls', {})

        node = {
            'name': out['tag'],
            'type': 'tuic',
            'server': out['server'],
            'port': out['server_port'],
            'uuid': out.get('uuid'),
            'password': out.get('password'),
            'sni': tls.get('server_name', ''),
            'skip-cert-verify': tls.get('insecure', False),
            'congestion-controller': out.get('congestion_control', 'bbr'),
            'udp-relay-mode': 'native' # Default or logic to map? Singbox might not show this.
        }

        if tls.get('alpn'):
             node['alpn'] = tls['alpn']

        return node

    def parse_singbox_hy2(self, out):
        tls = out.get('tls', {})
        obfs = out.get('obfs', {})

        node = {
            'name': out['tag'],
            'type': 'hysteria2',
            'server': out['server'],
            'port': out['server_port'],
            'password': out.get('password'),
            'alpn': tls.get('alpn', ['h3']),
            'ports': out.get('ports', '20000-50000'),
            'skip-cert-verify': tls.get('insecure', False),
            'udp': True,
            'fast-open': False,
        }

        if tls.get('server_name'): # Check if present
             node['sni'] = tls['server_name']

        if tls.get('alpn'):
             node['alpn'] = tls['alpn']

        if obfs.get('type'):
            node['obfs'] = obfs['type']
            node['obfs-password'] = obfs.get('password')

        return node

    def parse_singbox_trojan(self, out):
        tls = out.get('tls', {})

        # Determine UDP support based on Sing-Box 'network' field
        udp_support = True
        sb_network = out.get('network')
        if sb_network:
            if isinstance(sb_network, str):
                sb_network = [sb_network]
            if 'udp' not in sb_network:
                udp_support = False

        node = {
            'name': out['tag'],
            'type': 'trojan',
            'server': out['server'],
            'port': out['server_port'],
            'password': out['password'],
            'udp': udp_support,
            'sni': tls.get('server_name', ''),
            'skip-cert-verify': tls.get('insecure', False),
            'network': out.get('transport', {}).get('type', 'tcp')
        }

        if tls.get('alpn'):
             node['alpn'] = tls['alpn']

        if tls.get('utls') and tls['utls'].get('fingerprint'):
             node['client-fingerprint'] = tls['utls']['fingerprint']

        # Checking for ws/grpc options if transport is not tcp?
        # Standard Clash Trojan usually implies TCP+TLS.
        # But if transport type is 'ws' or 'grpc', we need to map those.
        # Singbox example shows "transport": {}, which implies TCP.

        return node

    def parse_node(self, line):
        if line.startswith('vless://'):
            return self.parse_vless(line)
        elif line.startswith('tuic://'):
            return self.parse_tuic(line)
        elif line.startswith('hysteria2://') or line.startswith('hy2://'):
            return self.parse_hy2(line)
        elif line.startswith('trojan://'):
            return self.parse_trojan(line)
        return None

    def parse_vless(self, url):
        parsed = urllib.parse.urlparse(url)
        params = urllib.parse.parse_qs(parsed.query)

        node = {
            'name': urllib.parse.unquote(parsed.fragment),
            'type': 'vless',
            'server': parsed.hostname,
            'port': parsed.port,
            'uuid': parsed.username,
            'network': params.get('type', ['tcp'])[0],
            'udp': True,
            'tls': False # default
        }

        # Handle explicit UDP flag in URL
        if 'udp' in params:
             val = params['udp'][0].lower()
             node['udp'] = val in ['1', 'true', 'on']

        security = params.get('security', [''])[0]
        if security == 'tls' or security == 'reality':
            node['tls'] = True
            node['servername'] = params.get('sni', [''])[0]

        if security == 'reality':
            node['flow'] = params.get('flow', [''])[0]
            node['client-fingerprint'] = params.get('fp', ['chrome'])[0]
            node['reality-opts'] = {
                'public-key': params.get('pbk', [''])[0],
                'short-id': params.get('sid', [''])[0]
            }
            # Remove empty short-id if not present logic? standard says optional.
            if not node['reality-opts'].get('short-id'):
                del node['reality-opts']['short-id']

        if params.get('flow') and 'reality' not in security:
             node['flow'] = params.get('flow')[0]

        return node

    def parse_trojan(self, url):
        parsed = urllib.parse.urlparse(url)
        params = urllib.parse.parse_qs(parsed.query)

        # Check both insecure flags
        allow_insecure = params.get('allow_insecure', ['0'])[0] == '1'
        insecure = params.get('insecure', ['0'])[0] == '1'

        node = {
            'name': urllib.parse.unquote(parsed.fragment),
            'type': 'trojan',
            'server': parsed.hostname,
            'port': parsed.port,
            'password': parsed.password if parsed.password else parsed.username,
            'udp': True, # Enforce True as per example
            'sni': params.get('sni', [''])[0],
            'skip-cert-verify': allow_insecure or insecure,
            # Trojan usually implies TCP, but Clash Meta handles 'network' if provided (ws/grpc)
            # Remove network field to match strict example requirements if desired,
            # but usually Parser shouldn't be too destructive.
            # However, user complained about network field before.
            # Generator handles cleanup, so we can leave 'network' here or remove it.
            # But let's keep it clean.
            'client-fingerprint': params.get('fp', ['chrome'])[0]
        }

        if 'udp' in params:
             val = params['udp'][0].lower()
             node['udp'] = val in ['1', 'true', 'on']

        alpn = params.get('alpn', [])
        if alpn:
             val = alpn[0]
             if ',' in val:
                 node['alpn'] = val.split(',')
             else:
                 node['alpn'] = [val]

        return node

    def parse_tuic(self, url):
        parsed = urllib.parse.urlparse(url)
        params = urllib.parse.parse_qs(parsed.query)

        # Check both insecure flags
        allow_insecure = params.get('allow_insecure', ['0'])[0] == '1'
        insecure = params.get('insecure', ['0'])[0] == '1'

        node = {
            'name': urllib.parse.unquote(parsed.fragment),
            'type': 'tuic',
            'server': parsed.hostname,
            'port': parsed.port,
            'uuid': parsed.username,
            'password': parsed.password,
            'sni': params.get('sni', [''])[0],
            'skip-cert-verify': allow_insecure or insecure,
            'congestion-controller': params.get('congestion_control', ['bbr'])[0],
            'udp-relay-mode': params.get('udp_relay_mode', ['native'])[0]
        }

        alpn = params.get('alpn', [])
        if alpn:
             val = alpn[0]
             if ',' in val:
                 node['alpn'] = val.split(',')
             else:
                 node['alpn'] = [val]

        return node

    def parse_hy2(self, url):
        parsed = urllib.parse.urlparse(url)
        params = urllib.parse.parse_qs(parsed.query)

        # hy2://user:pass@host:port or hy2://pass@host:port
        # If user is present, it might be ignored or used as auth depending on server implementation,
        # but standard hy2 usually just uses a password/auth string.
        # If urrlib parses "user:pass", username=user, password=pass.
        # If "pass@...", username=pass, password=None.

        password = parsed.password if parsed.password else parsed.username
        alpn = self._parse_alpn(params)
        skip_cert_verify = self._parse_bool(self._first_param(params, 'insecure', 'allow_insecure', 'skip-cert-verify', 'skip_cert_verify'), False)
        fast_open_raw = self._first_param(params, 'fast-open', 'fastopen', default='0')
        ports = self._first_param(params, 'ports', default='20000-50000')

        node = {
            'name': urllib.parse.unquote(parsed.fragment),
            'type': 'hysteria2',
            'server': parsed.hostname,
            'port': parsed.port,
            'password': password,
            'alpn': alpn or ['h3'],
            'ports': ports,
            'skip-cert-verify': skip_cert_verify,
            'udp': True,
            'obfs': None,
            'obfs-password': None,
            'fast-open': False,
        }

        sni = params.get('sni', [''])[0]
        if sni:
            node['sni'] = sni

        obfs = self._first_param(params, 'obfs', 'obfs-type', 'obfs_type', default='')
        if obfs:
            node['obfs'] = obfs
            node['obfs-password'] = params.get('obfs-password', [''])[0]
        else:
            del node['obfs']
            del node['obfs-password']

        if self._parse_bool(fast_open_raw, False):
            node['fast-open'] = True

        return node
