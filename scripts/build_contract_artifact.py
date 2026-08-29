from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import string
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
    "rename_globals": True,
    "hoist_literals": True,
    "constant_folding": True,
    "combine_imports": True,
    "prefer_single_line": True,
}
BEHAVIORAL_PARITY_GLOBALS = {
    "Address",
    "DynArray",
    "Keccak256",
    "TreeMap",
    "gl",
    "sha256",
    "_normalize_blockers",
    "_normalize_missing_evidence",
    "_review_result",
    "_safe_review_candidate",
    "_utf8_size",
    "u256",
}
CALL_ALIASES = {
    ("gl", "vm", "UserError"): "_ARTIFACT_USER_ERROR",
    ("json", "dumps"): "_ARTIFACT_JSON_DUMPS",
    ("json", "loads"): "_ARTIFACT_JSON_LOADS",
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


def _dotted_name(node: ast.expr) -> tuple[str, ...] | None:
    parts: list[str] = []
    current = node
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if not isinstance(current, ast.Name):
        return None
    return (current.id, *reversed(parts))


def _public_contract_method(node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    return any(
        (name := _dotted_name(decorator)) is not None
        and name[:2] == ("gl", "public")
        for decorator in node.decorator_list
    )


class _ArtifactTransformer(ast.NodeTransformer):
    def __init__(self) -> None:
        self.aliases_used: set[str] = set()

    def _strip_private_annotations(
        self,
        node: ast.FunctionDef | ast.AsyncFunctionDef,
    ) -> ast.FunctionDef | ast.AsyncFunctionDef:
        public = node.name == "__init__" or _public_contract_method(node)
        if not public:
            node.returns = None
            for argument in (
                *node.args.posonlyargs,
                *node.args.args,
                *node.args.kwonlyargs,
            ):
                argument.annotation = None
            if node.args.vararg is not None:
                node.args.vararg.annotation = None
            if node.args.kwarg is not None:
                node.args.kwarg.annotation = None
        return self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> ast.AST:
        return self._strip_private_annotations(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> ast.AST:
        return self._strip_private_annotations(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> ast.AST:
        transformed = self.generic_visit(node)
        if not isinstance(transformed, ast.ClassDef):
            return transformed
        private_methods = [
            child.name
            for child in transformed.body
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
            and child.name != "__init__"
            and not _public_contract_method(child)
        ]
        occupied = {
            target.id
            for child in transformed.body
            for target in (
                [child.target] if isinstance(child, ast.AnnAssign) else []
            )
            if isinstance(target, ast.Name)
        } | {
            child.name
            for child in transformed.body
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        candidates = (name for name in string.ascii_letters if name not in occupied)
        method_names = {name: next(candidates) for name in private_methods}
        return _PrivateMethodRenamer(method_names).visit(transformed)

    def visit_Attribute(self, node: ast.Attribute) -> ast.AST:
        transformed = self.generic_visit(node)
        if not isinstance(transformed, ast.Attribute):
            return transformed
        dotted = _dotted_name(transformed)
        alias = CALL_ALIASES.get(dotted or ())
        if alias is None:
            return transformed
        self.aliases_used.add(alias)
        return ast.copy_location(ast.Name(id=alias, ctx=transformed.ctx), transformed)


class _PrivateMethodRenamer(ast.NodeTransformer):
    def __init__(self, names: dict[str, str]) -> None:
        self.names = names

    def visit_FunctionDef(self, node: ast.FunctionDef) -> ast.AST:
        node.name = self.names.get(node.name, node.name)
        return self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> ast.AST:
        node.name = self.names.get(node.name, node.name)
        return self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> ast.AST:
        transformed = self.generic_visit(node)
        if (
            isinstance(transformed, ast.Attribute)
            and isinstance(transformed.value, ast.Name)
            and transformed.value.id in {"self", "_artifact_self"}
        ):
            transformed.attr = self.names.get(transformed.attr, transformed.attr)
        return transformed


def _attribute(parts: tuple[str, ...]) -> ast.expr:
    value: ast.expr = ast.Name(id=parts[0], ctx=ast.Load())
    for part in parts[1:]:
        value = ast.Attribute(value=value, attr=part, ctx=ast.Load())
    return value


def _compactable_source(body: str, filename: str) -> tuple[str, list[str]]:
    tree = ast.parse(body, filename)
    preserved_globals = sorted(
        BEHAVIORAL_PARITY_GLOBALS
        | {
            node.name
            for node in tree.body
            if isinstance(node, ast.ClassDef)
            or (
                isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and not node.name.startswith("_")
            )
        }
    )
    transformer = _ArtifactTransformer()
    transformed = transformer.visit(tree)
    insertion = 0
    while insertion < len(transformed.body) and isinstance(
        transformed.body[insertion], (ast.Import, ast.ImportFrom)
    ):
        insertion += 1
    aliases = [
        ast.Assign(
            targets=[ast.Name(id=alias, ctx=ast.Store())],
            value=_attribute(parts),
        )
        for parts, alias in CALL_ALIASES.items()
        if alias in transformer.aliases_used
    ]
    transformed.body[insertion:insertion] = aliases
    ast.fix_missing_locations(transformed)
    return ast.unparse(transformed), preserved_globals


def _restore_contract_storage_annotations(compact: str, source: str, filename: str) -> str:
    tree = ast.parse(source, filename)
    contract = next(
        (
            node
            for node in tree.body
            if isinstance(node, ast.ClassDef) and node.name == "AccessSeal"
        ),
        None,
    )
    if contract is None:
        return compact
    fields = [
        f"{node.target.id}:{ast.unparse(node.annotation).replace(' ', '')}"
        for node in contract.body
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)
    ]
    if not fields:
        raise ArtifactError("readable contract storage annotations are missing")
    pattern = re.compile(r"(?m)^(class AccessSeal\(gl\.Contract\):\n)\t[^\n]*")
    restored, count = pattern.subn(r"\1\t" + ";".join(fields), compact, count=1)
    if count != 1:
        raise ArtifactError("deployment artifact contract storage declaration is missing")
    return restored


def build_artifact(source: str, filename: str = "access_seal.py") -> str:
    lines = source.splitlines()
    if not lines or not DEPENDENCY_HEADER.match(lines[0]):
        raise ArtifactError("readable contract dependency header is missing or invalid")
    if any(DEPENDENCY_HEADER.match(line) for line in lines[1:]):
        raise ArtifactError("readable contract has multiple dependency headers")
    body = "\n".join(lines[1:]) + "\n"
    compactable, preserved_globals = _compactable_source(body, filename)
    compact_body = python_minifier.minify(
        compactable,
        filename=filename,
        preserve_globals=preserved_globals,
        **MINIFIER_OPTIONS,
    )
    compact = (
        f"{lines[0]}\n"
        f"{_restore_contract_storage_annotations(compact_body, body, filename)}"
    )
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
