import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from gltest.direct import create_address

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from scripts.glsim_support import scoped_fd0_injection


if sys.platform == "win32":
    # genlayer-test 0.29.2 replaces fd0 with an open tempfile, then unlinks it.
    # Windows forbids that unlink, so keep the SDK behavior and suppress only
    # the expected cleanup error for the exact injection tempfile.
    from gltest.direct import loader as direct_loader

    _sdk_inject_message_to_fd0 = direct_loader._inject_message_to_fd0

    def _inject_message_to_fd0_on_windows(vm: Any) -> None:
        scoped_fd0_injection(_sdk_inject_message_to_fd0, vm)

    direct_loader._inject_message_to_fd0 = _inject_message_to_fd0_on_windows


CONTRACT_PATH = "contracts/access_seal_deploy.py"


class _Invocation:
    def __init__(
        self,
        target: Callable[..., Any],
        vm: Any,
        sender: Any | None,
    ) -> None:
        self._target = target
        self._vm = vm
        self._sender = sender

    def __call__(self, *args: Any, value: int = 0) -> Any:
        previous_value = self._vm.value
        try:
            self._vm.value = value
            from genlayer import gl

            gl.message_raw["datetime"] = self._vm.get_message_raw()["datetime"]
            if self._sender is None:
                return self._target(*args)
            with self._vm.prank(self._sender):
                return self._target(*args)
        finally:
            self._vm.value = previous_value

    def reverts(
        self,
        *args: Any,
        value: int = 0,
        message: str | None = None,
    ) -> None:
        from genlayer import gl

        with pytest.raises(gl.vm.UserError) as error:
            self(*args, value=value)
        if message is not None:
            assert error.value.message == message


class ContractHarness:
    def __init__(self, contract: Any, vm: Any, sender: Any | None = None) -> None:
        self._contract = contract
        self._vm = vm
        self._sender = sender

    def as_(self, sender: Any) -> "ContractHarness":
        return ContractHarness(self._contract, self._vm, sender)

    def __getattr__(self, name: str) -> Any:
        target = getattr(self._contract, name)
        if callable(target):
            return _Invocation(target, self._vm, self._sender)
        return target

    def get_case_json(self, case_id: str) -> dict[str, Any]:
        return json.loads(self._contract.get_case(case_id))


@pytest.fixture
def contract(direct_deploy: Callable[..., Any], direct_vm: Any) -> ContractHarness:
    # direct_vm creates its default sender before the pinned SDK path is installed.
    # That probe can leave the empty compatibility `genlayer` package cached.
    sys.modules.pop("genlayer", None)
    return ContractHarness(direct_deploy(CONTRACT_PATH), direct_vm)


@pytest.fixture
def buyer(contract: ContractHarness) -> Any:
    return create_address("accessseal-buyer")


@pytest.fixture
def vendor(contract: ContractHarness) -> Any:
    return create_address("accessseal-vendor")


@pytest.fixture
def outsider(contract: ContractHarness) -> Any:
    return create_address("accessseal-outsider")
