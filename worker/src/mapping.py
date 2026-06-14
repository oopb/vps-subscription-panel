import json
import os
import random

MAPPING_FILE = "ipv6_mapping.json"

class IPv6Mapper:
    def __init__(self):
        self.mapping = self._load_mapping()

    def _load_mapping(self):
        if os.path.exists(MAPPING_FILE):
            try:
                with open(MAPPING_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception as e:
                print(f"Error loading IPv6 mapping: {e}")
                return {}
        return {}

    def save_mapping(self):
        try:
            with open(MAPPING_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.mapping, f, indent=2)
        except Exception as e:
            print(f"Error saving IPv6 mapping: {e}")

    def add_record(self, ipv4, ipv6):
        if not ipv4 or not ipv6:
            return

        if ipv4 not in self.mapping:
            self.mapping[ipv4] = []

        if ipv6 not in self.mapping[ipv4]:
            self.mapping[ipv4].append(ipv6)
            print(f"Recorded IPv6 mapping: {ipv4} -> {ipv6}")

    def get_ipv6(self, ipv4):
        if ipv4 in self.mapping and self.mapping[ipv4]:
            return random.choice(self.mapping[ipv4])
        return None
