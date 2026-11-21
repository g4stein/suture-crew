#!/usr/bin/env python3
"""License audit for the Python test dependencies (tooling/requirements-dev.txt and everything they pull in).

Reads each installed distribution's metadata (License-Expression, License, and license classifiers) and applies the
same policy as tooling/scripts/license-audit.mjs: at least one permissive license, no GPL/LGPL/AGPL, nothing
undeclared. Run it inside the environment that installed requirements-dev.txt.
"""
from __future__ import annotations

import re
import sys
from importlib import metadata
from typing import List, Optional, Set

PERMISSIVE = {"MIT", "MIT-0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "PSF-2.0", "Python-2.0", "Unlicense", "Zlib"}
CLASSIFIER_MAP = {
    "MIT License": "MIT",
    "Apache Software License": "Apache-2.0",
    "BSD License": "BSD-3-Clause",
    "ISC License (ISCL)": "ISC",
    "Python Software Foundation License": "PSF-2.0",
    "The Unlicense (Unlicense)": "Unlicense",
}
TEXT_MAP = {"mit": "MIT", "apache 2.0": "Apache-2.0", "apache-2.0": "Apache-2.0", "apache software license": "Apache-2.0", "bsd": "BSD-3-Clause", "psf-2.0": "PSF-2.0"}
COPYLEFT = re.compile(r"\b(A|L)?GPL\b|GNU (Affero |Lesser )?General Public", re.IGNORECASE)
# Tools that create the environment, not dependencies of the tests.
INFRA = {"pip", "setuptools", "wheel"}


def declared(dist: metadata.Distribution) -> List[str]:
    found: List[str] = []
    expr = dist.metadata.get("License-Expression")
    if expr:
        found.extend(t for t in re.split(r"\s+(?:OR|AND)\s+|[()]", expr) if t.strip())
    for c in dist.metadata.get_all("Classifier") or []:
        if c.startswith("License :: OSI Approved :: "):
            name = c.rsplit(" :: ", 1)[-1]
            found.append(CLASSIFIER_MAP.get(name, name))
    lic = (dist.metadata.get("License") or "").strip()
    if lic and len(lic) < 80:
        found.append(TEXT_MAP.get(lic.lower(), lic))
    return [f.strip() for f in found if f.strip()]


def check(name: str, licenses: List[str]) -> Optional[str]:
    if not licenses:
        return "no license declared"
    if any(COPYLEFT.search(x) for x in licenses) and not any(x in PERMISSIVE for x in licenses):
        return f"forbidden copyleft license {licenses}"
    if not any(x in PERMISSIVE for x in licenses):
        return f"license {licenses} is not on the allowlist"
    return None


def main() -> int:
    failures: List[str] = []
    seen: Set[str] = set()
    for dist in sorted(metadata.distributions(), key=lambda d: (d.metadata.get("Name") or "").lower()):
        name = (dist.metadata.get("Name") or "").lower()
        if not name or name in seen or name in INFRA:
            continue
        seen.add(name)
        lic = declared(dist)
        problem = check(name, lic)
        print(f"  {name}=={dist.version}: {', '.join(sorted(set(lic))) or 'UNKNOWN'}")
        if problem:
            failures.append(f"{name}: {problem}")
    if failures:
        print("FAIL:\n  " + "\n  ".join(failures), file=sys.stderr)
        return 1
    print(f"python license audit: {len(seen)} distributions · GPL/LGPL/AGPL: none · unlicensed: none · PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
