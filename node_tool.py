"""
Utility to detect node ingress/egress information, filter active nodes,
and rename them using a consistent pattern.

Usage examples::

    python node_tool.py examples/nodes.json
    python node_tool.py examples/nodes.json -o filtered.json --latency-threshold 350
    python node_tool.py examples/nodes.json --pattern "{flag}-{entry}->{exit}-{ip}"
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


PLACEHOLDER_KEYS = {"name", "flag", "ip", "entry", "exit"}


@dataclass
class Node:
    name: str
    flag: Optional[str]
    ip: Optional[str]
    entry: Optional[str]
    exit: Optional[str]
    latency_ms: Optional[float]
    active: bool

    @classmethod
    def from_dict(cls, data: Dict[str, Any], latency_threshold: Optional[float]) -> "Node":
        name = str(data.get("name", "")).strip() or "unnamed"
        flag = cls._normalize_optional(data.get("flag") or data.get("emoji"))
        ip = cls._normalize_optional(data.get("ip") or data.get("address"))
        entry = cls._first_non_empty(
            data,
            ["entry", "ingress", "inbound", "source", "from"],
        )
        exit = cls._first_non_empty(
            data,
            ["exit", "egress", "destination", "to", "outbound"],
        )

        latency_ms = cls._parse_latency(data.get("latency_ms") or data.get("latency"))
        status_value = str(data.get("status", "")).lower().strip()
        is_marked_active = bool(data.get("active", data.get("enabled", data.get("up", True))))
        status_is_healthy = status_value in {"", "active", "up", "alive", "ok", "online"}

        latency_is_healthy = (
            latency_threshold is None
            or (latency_ms is not None and latency_ms <= latency_threshold)
        )

        return cls(
            name=name,
            flag=flag,
            ip=ip,
            entry=entry,
            exit=exit,
            latency_ms=latency_ms,
            active=is_marked_active and status_is_healthy and latency_is_healthy,
        )

    @staticmethod
    def _normalize_optional(value: Any) -> Optional[str]:
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    @staticmethod
    def _first_non_empty(data: Dict[str, Any], keys: Iterable[str]) -> Optional[str]:
        for key in keys:
            value = data.get(key)
            if value is None:
                continue
            text = str(value).strip()
            if text:
                return text
        return None

    @staticmethod
    def _parse_latency(value: Any) -> Optional[float]:
        if value is None:
            return None
        if isinstance(value, (int, float)):
            return float(value)
        text = str(value).strip().lower()
        if text.endswith("ms"):
            text = text[:-2]
        try:
            return float(text)
        except ValueError:
            return None

    def renamed(self, pattern: str) -> str:
        filled = {
            "name": self.name,
            "flag": self.flag or "",
            "ip": self.ip or "",
            "entry": self.entry or "",
            "exit": self.exit or "",
        }
        missing = PLACEHOLDER_KEYS.difference(filled)
        if missing:
            raise ValueError(f"Missing placeholders: {', '.join(sorted(missing))}")
        return pattern.format(**filled)

    def to_dict(self, pattern: str) -> Dict[str, Any]:
        renamed = self.renamed(pattern)
        return {
            "name": renamed,
            "original_name": self.name,
            "flag": self.flag,
            "ip": self.ip,
            "entry": self.entry,
            "exit": self.exit,
            "latency_ms": self.latency_ms,
            "active": self.active,
            "route": f"{self.entry or '?'}->{self.exit or '?'}",
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Detect node ingress/egress, filter for active nodes, and rename nodes using "
            "a custom pattern."
        )
    )
    parser.add_argument("input", type=Path, help="Path to a JSON file containing a list of nodes.")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Where to write the transformed nodes. Defaults to stdout as JSON.",
    )
    parser.add_argument(
        "--pattern",
        default="{flag} {name} {entry}->{exit} ({ip})",
        help=(
            "Pattern for the new name. Available placeholders: {name}, {flag}, {ip}, {entry}, {exit}. "
            "Defaults to '{flag} {name} {entry}->{exit} ({ip})'."
        ),
    )
    parser.add_argument(
        "--latency-threshold",
        type=float,
        help="Only mark nodes active when latency (ms) is at or below this threshold.",
    )
    parser.add_argument(
        "--include-inactive",
        action="store_true",
        help="Keep inactive nodes in the output instead of filtering them out.",
    )
    return parser.parse_args()


def load_nodes(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        raise FileNotFoundError(f"Input file not found: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("Input data must be a JSON list of node objects")
    return data


def transform_nodes(
    raw_nodes: Iterable[Dict[str, Any]],
    pattern: str,
    latency_threshold: Optional[float],
    include_inactive: bool,
) -> List[Dict[str, Any]]:
    nodes = [Node.from_dict(item, latency_threshold) for item in raw_nodes]
    if not include_inactive:
        nodes = [node for node in nodes if node.active]
    return [node.to_dict(pattern) for node in nodes]


def main() -> None:
    args = parse_args()
    raw_nodes = load_nodes(args.input)
    transformed = transform_nodes(
        raw_nodes,
        pattern=args.pattern,
        latency_threshold=args.latency_threshold,
        include_inactive=args.include_inactive,
    )

    serialized = json.dumps(transformed, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(serialized + "\n", encoding="utf-8")
    else:
        print(serialized)


if __name__ == "__main__":
    main()
