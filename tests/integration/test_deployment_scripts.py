from __future__ import annotations

import json
import subprocess
from pathlib import Path

def test_real_genlayerjs_local_deploy_source_schema_and_accounting_readback(
    glsim_server,
):
    manifest_path = Path("work/deployments/localnet.json")
    proof_path = Path("work/evidence/task7-local-deployment.json")
    manifest_path.unlink(missing_ok=True)
    proof_path.unlink(missing_ok=True)
    completed = subprocess.run(
        ["node", "--import", "tsx", "tests/scripts/local-deployment-proof.ts"],
        check=False,
        capture_output=True,
        text=True,
        timeout=45,
    )
    assert completed.returncode == 0, completed.stderr
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    proof = json.loads(proof_path.read_text(encoding="utf-8"))
    assert proof["schemaVersion"] == "accessseal-local-deployment-proof/1"
    assert proof["network"] == "localnet"
    assert proof["chainId"] == 61127
    assert proof["transactionStatus"] == "FINALIZED"
    assert proof["executionResult"] == "FINISHED_WITH_RETURN"
    assert proof["contractAddress"] == manifest["contractAddress"]
    assert proof["deploymentTransaction"] == manifest["deploymentTransaction"]
    assert proof["readableSourceSha256"] == manifest["readableSourceSha256"]
    assert proof["deploymentArtifactSha256"] == manifest["deploymentArtifactSha256"]
    assert proof["sourceSha256"] == manifest["sourceSha256"]
    assert proof["sourceSha256"] == proof["deploymentArtifactSha256"]
    assert proof["schemaSha256"] == manifest["schemaSha256"]
    assert proof["accounting"] == {
        "dispatchedPayouts": 0,
        "dispatchedRefunds": 0,
        "pendingDispatch": 0,
        "reserved": 0,
        "totalDeposits": 0,
    }
