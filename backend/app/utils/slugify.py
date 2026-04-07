import re


def slugify(name: str) -> str:
    """Convert a node name to a slug for use in output references."""
    s = name.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    return s.strip("_")
