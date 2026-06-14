from ruamel.yaml import YAML

class Generator:
    """
    Component: Filler & Combiner
    Responsible for:
    1. Filling the parsed subscription nodes into the template.
    2. Combining nodes into proxy groups.
    3. Generating the final YAML configuration file.
    """
    def __init__(self, template_path):
        self.template_path = template_path
        self.yaml = YAML()
        self.yaml.preserve_quotes = True
        self.yaml.indent(mapping=2, sequence=4, offset=2)

    def _normalize_hysteria2(self, node):
        normalized = {
            'name': node['name'],
            'type': 'hysteria2',
            'server': node['server'],
            'port': node['port'],
            'password': node.get('password'),
            'alpn': node.get('alpn', ['h3']),
            'ports': node.get('ports', '20000-50000'),
            'skip-cert-verify': bool(node.get('skip-cert-verify', False)),
            'udp': True,
        }

        if node.get('obfs'):
            normalized['obfs'] = node['obfs']

        if node.get('obfs-password'):
            normalized['obfs-password'] = node['obfs-password']

        normalized['fast-open'] = bool(node.get('fast-open', False))

        if node.get('sni'):
            normalized['sni'] = node['sni']

        return normalized

    def generate(self, proxies, output_path, skip_groups=False):
        print(f"Reading template from {self.template_path}")
        with open(self.template_path, 'r', encoding='utf-8') as f:
            data = self.yaml.load(f)

        # Collect old node names to cleanly distinguish them from static sub-group items like AUTO, DIRECT
        old_node_names = {p['name'] for p in data.get('proxies', [])} if 'proxies' in data else set()

        # 1. Update proxies
        # Replaces the entire proxies list
        data['proxies'] = proxies

        proxy_names = [p['name'] for p in proxies]

        if 'proxy-groups' in data:
            if skip_groups:
                print("Filtering proxy-groups: Keeping only PROXY.")
                data['proxy-groups'] = [g for g in data['proxy-groups'] if g['name'] == 'PROXY']

                if 'rules' in data and data['rules']:
                    print("Filtering rules: Keeping DIRECT, REJECT, and final MATCH,PROXY.")
                    # Iterate backwards to remove items in-place
                    for i in range(len(data['rules']) - 1, -1, -1):
                        rule = data['rules'][i]
                        if not isinstance(rule, str):
                            continue

                        parts = [x.strip() for x in rule.split(',')]
                        target = None
                        keep = False
                        is_match = False

                        if len(parts) >= 2:
                            if parts[0] == 'MATCH':
                                target = parts[1]
                                is_match = True
                            elif len(parts) >= 3:
                                target = parts[2]

                        if target:
                            if target in ['DIRECT', 'REJECT']:
                                keep = True
                            elif target == 'PROXY':
                                # Only keep PROXY if it is the MATCH (fallback) rule
                                if is_match:
                                    keep = True

                        if not keep:
                            del data['rules'][i]

            for group in data['proxy-groups']:
                if 'proxies' in group:
                    # Strategy: Preserve built-in/other group names, replace old nodes with new ones.

                    new_group_proxies = []
                    for p_name in group['proxies']:
                        if p_name not in old_node_names:
                            new_group_proxies.append(p_name)

                    # Append all the new proxy_names (so the group now contains the new nodes in default parsed order).
                    new_group_proxies.extend(proxy_names)

                    # Deduplicate while preserving order
                    group['proxies'] = list(dict.fromkeys(new_group_proxies))

        # Final cleanup of proxies to match user's request (no network field, use udp: true/false)
        # Iterate over the modified proxy list in data['proxies']
        cleaned_proxies = []
        for p in data['proxies']:
            # Rename server_port to port if present
            if 'server_port' in p:
                p['port'] = p.pop('server_port')

            # We need to STRICTLY follow the example.
            # Example VLESS HAS 'network' field.
            # Example TUIC does NOT have 'udp' field.
            # Example Hysteria2 HAS 'udp' field.
            # Example Trojan HAS 'udp' field.
            # Previously we were deleting 'network' unconditionally.

            # Remove 'network' ONLY if type is NOT vless (or if default behavior implied).
            # But the user asked to strictly follow example nodes.
            # VLESS example: network: tcp
            # So for VLESS we keep it. For others?
            # TUIC/Hy2/Trojan examples DO NOT show 'network'.
            if p.get('type') != 'vless' and 'network' in p:
                del p['network']

            # Remove other potentially unwanted fields from raw parsing if they leak
            for field in ['stack', 'strict_route', 'platform', 'inbounds', 'outbounds']:
                if field in p:
                    del p[field]

            # Ensure udp field logic
            # TUIC example does NOT have udp: true.
            if p.get('type') == 'tuic' and 'udp' in p:
                 del p['udp']

            # Normalize hysteria2 nodes to the example format.
            if p.get('type') == 'hysteria2':
                 p = self._normalize_hysteria2(p)

            cleaned_proxies.append(p)

        data['proxies'] = cleaned_proxies

        print(f"Writing output to {output_path}")
        with open(output_path, 'w', encoding='utf-8') as f:
            self.yaml.dump(data, f)
