from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

import python_minifier


READABLE_RELATIVE = Path("contracts/access_seal.py")
ARTIFACT_RELATIVE = Path("contracts/access_seal_deploy.py")
MAX_ARTIFACT_BYTES = 48_000
DEPENDENCY_HEADER = re.compile(r'^#\s*\{\s*"Depends"\s*:')
MINIFIER_OPTIONS = {
    "remove_annotations": False,
    "rename_locals": True,
    "preserve_locals": ["self"],
    "rename_globals": False,
    "hoist_literals": False,
    "constant_folding": True,
    "combine_imports": True,
    "prefer_single_line": True,
}


class ArtifactError(RuntimeError):
    pass


@dataclass(frozen=True)
class ArtifactMetadata:
    readableSha256: str
    artifactSha256: str
    artifactBytes: int


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def build_artifact(source: str, filename: str = "access_seal.py") -> str:
    lines = source.splitlines()
    if not lines or not DEPENDENCY_HEADER.match(lines[0]):
        raise ArtifactError("readable contract dependency header is missing or invalid")
    if any(DEPENDENCY_HEADER.match(line) for line in lines[1:]):
        raise ArtifactError("readable contract has multiple dependency headers")
    body = "\n".join(lines[1:]) + "\n"
    compact = f"{lines[0]}\n{python_minifier.minify(body, filename=filename, **MINIFIER_OPTIONS)}"
    encoded = compact.encode("utf-8")
    if len(encoded) > MAX_ARTIFACT_BYTES:
        raise ArtifactError(f"deployment artifact exceeds {MAX_ARTIFACT_BYTES} bytes")
    compile(compact, filename, "exec")
    return compact


def verify_artifact(repo_root: Path, *, write: bool) -> ArtifactMetadata:
    readable = repo_root / READABLE_RELATIVE
    artifact = repo_root / ARTIFACT_RELATIVE
    try:
        readable_bytes = readable.read_bytes()
    except FileNotFoundError as error:
        raise ArtifactError("readable contract source is missing") from error
    expected = build_artifact(readable_bytes.decode("utf-8"), str(readable)).encode("utf-8")

    if write:
        artifact.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{artifact.name}.", suffix=".tmp", dir=artifact.parent
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(expected)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, artifact)
        finally:
            temporary.unlink(missing_ok=True)
    else:
        try:
            actual = artifact.read_bytes()
        except FileNotFoundError as error:
            raise ArtifactError("deployment artifact is missing") from error
        if actual != expected:
            raise ArtifactError("deployment artifact is stale")

    return ArtifactMetadata(
        readableSha256=_sha256(readable_bytes),
        artifactSha256=_sha256(expected),
        artifactBytes=len(expected),
    )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the deterministic AccessSeal deployment artifact")
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        metadata = verify_artifact(args.repo_root.resolve(), write=args.write)
    except (ArtifactError, UnicodeDecodeError, SyntaxError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(asdict(metadata), separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
