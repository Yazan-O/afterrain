"""Registry of every number the app or the writeup may show, with where it came from."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Numbers:
    rows: dict[str, dict[str, Any]] = field(default_factory=dict)

    def add(self, key: str, value: Any, counts: str, sources: list[str], function: str) -> None:
        if key in self.rows:
            raise KeyError(f"duplicate number id {key}")
        if isinstance(value, float):
            value = round(value, 4)
        self.rows[key] = {"value": value, "counts": counts, "sources": sources, "function": function}

    def to_json(self) -> dict[str, Any]:
        return dict(sorted(self.rows.items()))
