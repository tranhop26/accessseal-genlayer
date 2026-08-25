import json
from hashlib import sha256

import pytest

from test_adjudication import open_reviewable_case


PROFILE_HASH = "0x" + "11" * 32
FLOWS_HASH = "0x" + "22" * 32
PROFILE_VERSION = "accessseal-static/1"
ORIGIN = "https://fixture.accessseal.local"
ESCROW = 50_000
RELEASE_DIGEST = "sha256:" + "a" * 64
PAYLOAD_DIGEST = "sha256:" + "b" * 64
MEDIA_TYPES = {
    "RELEASE_MANIFEST": "application/json",
    "HTML_BUNDLE": "text/html",
    "SCREENSHOT": "image/png",
    "DOM_FACTS": "application/json",
    "SCANNER_REPORT": "application/json",
    "CRITICAL_FLOW_TRACE": "application/json",
}
PAYLOAD_PATHS = {
    "RELEASE_MANIFEST": "/.well-known/accessseal/release-manifest.json",
    "HTML_BUNDLE": "/evidence/index.html",
    "SCREENSHOT": "/evidence/home.png",
    "DOM_FACTS": "/evidence/dom-facts.json",
    "SCANNER_REPORT": "/evidence/scanner-report.json",
    "CRITICAL_FLOW_TRACE": "/evidence/critical-flow.json",
}
FIXTURE_HASH = (
    "sha256:13be58c176c1258e5e708362c3c8b0b9"
    "7750ccf4552632b95b4fe2a0f2840913"
)
REQUIRED_EARLY_SEAL_TYPES = (
    "RELEASE_MANIFEST",
    "HTML_BUNDLE",
    "SCREENSHOT",
    "DOM_FACTS",
    "SCANNER_REPORT",
    "CRITICAL_FLOW_TRACE",
)


FIXTURE_ENVELOPE = {
    "schemaVersion": "accessseal-evidence/1",
    "chainId": "localnet",
    "contract": "0x0000000000000000000000000000000000000001",
    "caseId": "case-1",
    "epoch": 0,
    "action": "OPEN_RELEASE",
    "subjectOrigin": ORIGIN,
    "profileVersion": PROFILE_VERSION,
    "releaseDigest": RELEASE_DIGEST,
    "evidenceType": "RELEASE_MANIFEST",
    "issuer": "0x0000000000000000000000000000000000000002",
    "payloadUri": ORIGIN + PAYLOAD_PATHS["RELEASE_MANIFEST"],
    "payloadSha256": RELEASE_DIGEST,
    "mediaType": MEDIA_TYPES["RELEASE_MANIFEST"],
    "observedAt": 1000,
    "submittedAt": 1010,
    "expiresAt": 1600,
    "nonce": "release-0",
}


def compact_json(value):
    return json.dumps(value, separators=(",", ":"))


def independent_hash(value):
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"))
    return "sha256:" + sha256(canonical.encode()).hexdigest()


def funded_case(contract, direct_vm, buyer, vendor, origin=ORIGIN):
    direct_vm.warp("2026-08-13T00:00:00+00:00")
    case_id = contract.as_(buyer).create_case(
        "evidence-release-001",
        vendor,
        PROFILE_HASH,
        FLOWS_HASH,
        origin,
        1_800,
        7_200,
        2,
        ESCROW,
    )
    terms_hash = contract.get_case_json(case_id)["termsHash"]
    contract.as_(vendor).accept_terms(case_id, terms_hash)
    contract.as_(buyer).fund(case_id, value=ESCROW)
    return case_id


def envelope_for(harness, case_id, issuer_address, **overrides):
    case = harness.get_case_json(case_id)
    evidence_type = overrides.get("evidenceType", "RELEASE_MANIFEST")
    payload_digest = (
        RELEASE_DIGEST
        if evidence_type == "RELEASE_MANIFEST"
        else PAYLOAD_DIGEST
    )
    value = {
        "schemaVersion": "accessseal-evidence/1",
        "chainId": str(case["chainId"]),
        "contract": case["contractAddress"],
        "caseId": case_id,
        "epoch": 0,
        "action": "OPEN_RELEASE",
        "subjectOrigin": ORIGIN,
        "profileVersion": PROFILE_VERSION,
        "releaseDigest": RELEASE_DIGEST,
        "evidenceType": evidence_type,
        "issuer": issuer_address.as_hex.lower(),
        "payloadUri": ORIGIN
        + PAYLOAD_PATHS.get(evidence_type, "/evidence/unknown.json"),
        "payloadSha256": payload_digest,
        "mediaType": MEDIA_TYPES.get(evidence_type, "application/json"),
        "observedAt": 1_786_579_000,
        "submittedAt": 1_786_579_100,
        "expiresAt": 1_786_580_000,
        "nonce": "release-0",
    }
    value.update(overrides)
    return value


def open_complete_early_seal_profile(
    contract,
    case_id,
    vendor,
    *,
    omit_type=None,
    expires_at=1_786_580_000,
    expires_at_by_type=None,
):
    if expires_at_by_type is None:
        expires_at_by_type = {}
    release = envelope_for(
        contract,
        case_id,
        vendor,
        expiresAt=expires_at_by_type.get("RELEASE_MANIFEST", expires_at),
    )
    contract.as_(vendor).open_evidence(case_id, compact_json(release))
    for evidence_type in REQUIRED_EARLY_SEAL_TYPES[1:]:
        if evidence_type == omit_type:
            continue
        contract.as_(vendor).append_evidence(
            case_id,
            compact_json(
                envelope_for(
                    contract,
                    case_id,
                    vendor,
                    action="APPEND_EVIDENCE",
                    evidenceType=evidence_type,
                    expiresAt=expires_at_by_type.get(evidence_type, expires_at),
                    nonce="early-seal-" + evidence_type.lower(),
                )
            ),
        )


def case_evidence_and_accounting(contract, case_id):
    case = contract.get_case_json(case_id)
    # `readAt` is an authoritative view-time clock, not mutable case state.
    case.pop("readAt")
    return (
        case,
        json.loads(contract.get_evidence(case_id, 0)),
        json.loads(contract.get_accounting()),
    )


def test_canonical_evidence_hash_matches_fixed_sha256_vector(contract):
    shuffled = dict(reversed(list(FIXTURE_ENVELOPE.items())))

    assert contract.canonical_evidence_hash(compact_json(shuffled)) == FIXTURE_HASH


def test_canonical_evidence_hash_matches_utf8_json_vector(contract):
    envelope = {**FIXTURE_ENVELOPE, "nonce": "รีลีส-0"}

    assert contract.canonical_evidence_hash(compact_json(envelope)) == (
        "sha256:f57d8fb896c7b8a67c6afaaa3eb086ab"
        "73e6ffcfc9a2d6272d1ff808de77c496"
    )


def test_canonical_evidence_hash_matches_non_bmp_nonce_vector(contract):
    envelope = {**FIXTURE_ENVELOPE, "nonce": "release-😀"}

    assert contract.canonical_evidence_hash(compact_json(envelope)) == (
        "sha256:34e76021986d578b2b87ba04a5dd20dd7"
        "2dace32c71d0d3529fc1507ac070b9d"
    )


@pytest.mark.parametrize(
    ("transform", "message"),
    [
        (
            lambda envelope: {
                key: value
                for key, value in envelope.items()
                if key != "payloadUri"
            },
            "evidence envelope fields do not match schema",
        ),
        (
            lambda envelope: {**envelope, "payloadSize": 123},
            "evidence envelope fields do not match schema",
        ),
        (
            lambda envelope: {**envelope, "payloadUri": 7},
            "evidence envelope field types are invalid",
        ),
        (
            lambda envelope: {**envelope, "payloadSha256": False},
            "evidence envelope field types are invalid",
        ),
        (
            lambda envelope: {**envelope, "mediaType": ["application/json"]},
            "evidence envelope field types are invalid",
        ),
        (
            lambda envelope: {**envelope, "payloadSha256": "sha256:ABC"},
            "payload SHA-256 must be a lowercase sha256 digest",
        ),
        (
            lambda envelope: {
                **envelope,
                "payloadSha256": "sha256:" + "A" * 64,
            },
            "payload SHA-256 must be a lowercase sha256 digest",
        ),
    ],
    ids=(
        "missing",
        "extra",
        "uri-type",
        "hash-type",
        "media-type",
        "malformed-hash",
        "uppercase-hash",
    ),
)
def test_open_rejects_malformed_payload_fields_without_mutation(
    contract, direct_vm, buyer, vendor, transform, message
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    envelope = transform(envelope_for(contract, case_id, vendor))

    contract.as_(vendor).open_evidence.reverts(
        case_id,
        compact_json(envelope),
        message=message,
    )

    assert contract.get_case_json(case_id)["lifecycle"] == "FUNDED"
    contract.get_evidence.reverts(
        case_id,
        0,
        message="evidence epoch does not exist",
    )


@pytest.mark.parametrize(
    ("payload_uri", "message"),
    [
        (
            "http://fixture.accessseal.local/evidence/release.json",
            "payload URI must use HTTPS",
        ),
        (
            "https://user:password@fixture.accessseal.local/evidence/release.json",
            "payload URI must not contain credentials",
        ),
        (
            "https://fixture.accessseal.local/evidence/release.json#proof",
            "payload URI must not contain a fragment",
        ),
        (
            "https://fixture.accessseal.local/evidence/%2e%2e/release.json",
            "payload URI must not contain percent escapes",
        ),
        (
            'https://fixture.accessseal.local/evidence/release.json?name="proof"',
            "payload URI must not contain a query",
        ),
        (
            "https://fixture.accessseal.local/evidence/release.json?version=1",
            "payload URI must not contain a query",
        ),
        (
            "https://other.example/evidence/release.json",
            "payload URI origin does not match case",
        ),
        (
            "https://127.0.0.1/evidence/release.json",
            "payload URI host must use lowercase DNS labels",
        ),
        (
            "https://[::1]/evidence/release.json",
            "payload URI host must use lowercase DNS labels",
        ),
        (
            "https://tést.example/evidence/release.json",
            "payload URI must use the restricted ASCII profile",
        ),
        (
            json.loads('"https://fixture.\\ud800/evidence/release.json"'),
            "payload URI must use the restricted ASCII profile",
        ),
        (
            "https://xn--tst-bma.example/evidence/release.json",
            "payload URI host must use lowercase DNS labels",
        ),
        (
            "https://FIXTURE.accessseal.local/evidence/release.json",
            "payload URI must be normalized",
        ),
        (
            "https://fixture.accessseal.local:443/evidence/release.json",
            "payload URI must be normalized",
        ),
        (
            "https://fixture.accessseal.local:8443/evidence/release.json",
            "payload URI origin does not match case",
        ),
        (
            "https://fixture.accessseal.local/evidence\\release.json",
            "payload URI must be normalized",
        ),
        (
            "https://fixture.accessseal.local/evidence/release%20file.json",
            "payload URI must not contain percent escapes",
        ),
        (
            "https://fixture.accessseal.local/evidence//release.json",
            "payload URI must be normalized",
        ),
        (
            "https://fixture.accessseal.local/evidence/./release.json",
            "payload URI must be normalized",
        ),
        (
            "https://fixture.accessseal.local/evidence/../release.json",
            "payload URI must be normalized",
        ),
        (
            "https:///evidence/release.json",
            "payload URI must be normalized",
        ),
        (
            ORIGIN + "/" + "x" * 2_049,
            "payload URI must contain 1 to 2048 UTF-8 bytes",
        ),
    ],
    ids=(
        "non-https",
        "credentials",
        "fragment",
        "encoded-dot-segment",
        "quoted-query",
        "query",
        "cross-origin",
        "ipv4",
        "ipv6",
        "unicode-idn",
        "escaped-lone-surrogate",
        "punycode-idn",
        "not-normalized",
        "default-port",
        "nondefault-port-origin-mismatch",
        "backslash",
        "percent",
        "repeated-slash",
        "dot-segment",
        "dot-dot-segment",
        "malformed",
        "too-long",
    ),
)
def test_open_rejects_unretrievable_payload_uris_without_mutation(
    contract, direct_vm, buyer, vendor, payload_uri, message
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    envelope = envelope_for(
        contract,
        case_id,
        vendor,
        payloadUri=payload_uri,
    )

    contract.as_(vendor).open_evidence.reverts(
        case_id,
        compact_json(envelope),
        message=message,
    )

    assert contract.get_case_json(case_id)["lifecycle"] == "FUNDED"
    contract.get_evidence.reverts(
        case_id,
        0,
        message="evidence epoch does not exist",
    )


@pytest.mark.parametrize(
    "hostname",
    (
        "0x7f000001",
        "0x7f.0.0.1",
        "2130706433",
        "127.1",
        "0177.0.0.1",
        "example.123",
        "example.c0m",
        "localhost",
        "example.c",
    ),
    ids=(
        "legacy-hex-integer-ipv4",
        "legacy-dotted-hex-ipv4",
        "legacy-decimal-integer-ipv4",
        "legacy-shortened-ipv4",
        "legacy-dotted-octal-ipv4",
        "numeric-tld",
        "mixed-numeric-tld",
        "single-label",
        "one-character-tld",
    ),
)
def test_payload_uri_restricted_profile_rejects_non_dns_hosts_without_mutation(
    contract, direct_vm, buyer, vendor, hostname
):
    origin = "https://" + hostname
    case_id = funded_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        origin=origin,
    )
    envelope = envelope_for(
        contract,
        case_id,
        vendor,
        subjectOrigin=origin,
        payloadUri=origin + "/evidence/release.json",
    )

    contract.as_(vendor).open_evidence.reverts(
        case_id,
        compact_json(envelope),
        message="payload URI host must use lowercase DNS labels",
    )

    assert contract.get_case_json(case_id)["lifecycle"] == "FUNDED"
    contract.get_evidence.reverts(
        case_id,
        0,
        message="evidence epoch does not exist",
    )


@pytest.mark.parametrize(
    ("origin", "payload_uri"),
    [
        (ORIGIN, ORIGIN + "/"),
        (ORIGIN, ORIGIN + "/.well-known/accessseal/release-manifest.json"),
        (ORIGIN, ORIGIN + "/Evidence/path_1-file.json"),
        (
            "https://proof.co",
            "https://proof.co/evidence/release.json",
        ),
        (
            "https://fixture.accessseal.local:8443",
            "https://fixture.accessseal.local:8443/evidence/release.json",
        ),
    ],
    ids=(
        "root",
        "manifest",
        "path-allowlist",
        "valid-multi-label-dns",
        "nondefault-port",
    ),
)
def test_payload_uri_restricted_profile_accepts_canonical_paths(
    contract, direct_vm, buyer, vendor, origin, payload_uri
):
    case_id = funded_case(contract, direct_vm, buyer, vendor, origin=origin)
    envelope = envelope_for(
        contract,
        case_id,
        vendor,
        subjectOrigin=origin,
        payloadUri=payload_uri,
    )

    contract.as_(vendor).open_evidence(case_id, compact_json(envelope))

    assert contract.get_case_json(case_id)["lifecycle"] == "EVIDENCE_OPEN"


@pytest.mark.parametrize(
    ("nonce", "message"),
    [
        (
            "😀" * 33,
            "evidence nonce must contain 1 to 128 UTF-8 bytes",
        ),
        (
            "\ud800",
            "evidence nonce must contain only Unicode scalar values",
        ),
        (
            "\udc00",
            "evidence nonce must contain only Unicode scalar values",
        ),
        (
            "\ud800x",
            "evidence nonce must contain only Unicode scalar values",
        ),
    ],
    ids=(
        "over-128-utf8-bytes",
        "lone-high-surrogate",
        "lone-low-surrogate",
        "malformed-surrogate-pair",
    ),
)
def test_nonce_rejects_byte_overflow_and_lone_surrogate_before_hashing(
    contract, direct_vm, buyer, vendor, nonce, message
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    envelope = envelope_for(contract, case_id, vendor, nonce=nonce)

    contract.as_(vendor).open_evidence.reverts(
        case_id,
        compact_json(envelope),
        message=message,
    )

    assert contract.get_case_json(case_id)["lifecycle"] == "FUNDED"
    contract.get_evidence.reverts(
        case_id,
        0,
        message="evidence epoch does not exist",
    )


@pytest.mark.parametrize("evidence_type", tuple(MEDIA_TYPES))
def test_evidence_type_requires_fixed_media_type_without_mutation(
    contract, direct_vm, buyer, vendor, evidence_type
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    if evidence_type == "RELEASE_MANIFEST":
        envelope = envelope_for(
            contract,
            case_id,
            vendor,
            mediaType="application/octet-stream",
        )
        invocation = contract.as_(vendor).open_evidence
    else:
        release = envelope_for(contract, case_id, vendor)
        contract.as_(vendor).open_evidence(case_id, compact_json(release))
        envelope = envelope_for(
            contract,
            case_id,
            vendor,
            action="APPEND_EVIDENCE",
            evidenceType=evidence_type,
            mediaType="application/octet-stream",
            nonce=f"wrong-media-{evidence_type.lower()}",
        )
        invocation = contract.as_(vendor).append_evidence

    invocation.reverts(
        case_id,
        compact_json(envelope),
        message="evidence media type does not match evidence type",
    )

    if evidence_type == "RELEASE_MANIFEST":
        assert contract.get_case_json(case_id)["lifecycle"] == "FUNDED"
        contract.get_evidence.reverts(
            case_id,
            0,
            message="evidence epoch does not exist",
        )
    else:
        evidence = json.loads(contract.get_evidence(case_id, 0))
        assert len(evidence["envelopes"]) == 1
        assert contract.get_case_json(case_id)["lifecycle"] == "EVIDENCE_OPEN"


def test_open_requires_manifest_payload_hash_to_equal_release_digest(
    contract, direct_vm, buyer, vendor
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    envelope = envelope_for(
        contract,
        case_id,
        vendor,
        payloadSha256=PAYLOAD_DIGEST,
    )

    contract.as_(vendor).open_evidence.reverts(
        case_id,
        compact_json(envelope),
        message="release manifest payload hash must equal release digest",
    )

    assert contract.get_case_json(case_id)["lifecycle"] == "FUNDED"


def test_evidence_uses_absolute_utc_block_time(
    contract, direct_vm, buyer, vendor
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    envelope = envelope_for(
        contract,
        case_id,
        vendor,
        observedAt=1_786_579_100,
        submittedAt=1_786_579_200,
        expiresAt=1_786_580_000,
    )

    contract.as_(vendor).open_evidence(case_id, compact_json(envelope))

    assert contract.get_case_json(case_id)["lifecycle"] == "EVIDENCE_OPEN"


def test_vendor_opens_append_only_evidence_for_funded_case(
    contract, direct_vm, buyer, vendor
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    envelope = envelope_for(contract, case_id, vendor)
    expected_hash = independent_hash(envelope)

    contract.as_(vendor).open_evidence(case_id, compact_json(envelope))

    case = contract.get_case_json(case_id)
    evidence = json.loads(contract.get_evidence(case_id, 0))
    assert case["lifecycle"] == "EVIDENCE_OPEN"
    assert evidence == {
        "caseId": case_id,
        "epoch": 0,
        "envelopes": [envelope],
        "hashes": [expected_hash],
        "releaseDigest": RELEASE_DIGEST,
    }


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ({"chainId": "999"}, "evidence chain does not match case"),
        (
            {"contract": "0x" + "ff" * 20},
            "evidence contract does not match case",
        ),
        ({"caseId": "wrong-case"}, "evidence case does not match"),
        ({"epoch": 1}, "evidence epoch does not match current epoch"),
        ({"action": "APPEND_EVIDENCE"}, "evidence action is not allowed"),
        (
            {"subjectOrigin": "https://wrong.example"},
            "evidence origin does not match case",
        ),
        (
            {"profileVersion": "accessseal-static/2"},
            "evidence profile version is not allowed",
        ),
        (
            {"releaseDigest": "sha256:bad"},
            "release digest must be a sha256 digest",
        ),
        (
            {"issuer": "0x" + "ee" * 20},
            "evidence issuer must be the vendor",
        ),
    ],
    ids=(
        "chain",
        "contract",
        "case",
        "epoch",
        "action",
        "origin",
        "profile",
        "digest",
        "issuer",
    ),
)
def test_open_rejects_wrong_evidence_domain_without_advancing_state(
    contract, direct_vm, buyer, vendor, mutation, message
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    envelope = envelope_for(contract, case_id, vendor, **mutation)

    contract.as_(vendor).open_evidence.reverts(
        case_id,
        compact_json(envelope),
        message=message,
    )
    assert contract.get_case_json(case_id)["lifecycle"] == "FUNDED"
    contract.get_evidence.reverts(
        case_id,
        0,
        message="evidence epoch does not exist",
    )


@pytest.mark.parametrize(
    ("times", "message"),
    [
        (
            {
                "observedAt": 1_786_579_000,
                "submittedAt": 1_786_579_201,
                "expiresAt": 1_786_580_000,
            },
            "evidence submission is in the future",
        ),
        (
            {
                "observedAt": 1_786_577_399,
                "submittedAt": 1_786_577_400,
                "expiresAt": 1_786_580_000,
            },
            "evidence observation is stale",
        ),
        (
            {
                "observedAt": 1_786_579_100,
                "submittedAt": 1_786_579_000,
                "expiresAt": 1_786_580_000,
            },
            "evidence timestamps are not ordered",
        ),
    ],
    ids=("future", "stale", "inverted"),
)
def test_open_rejects_invalid_time_envelopes_without_advancing_state(
    contract, direct_vm, buyer, vendor, times, message
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    envelope = envelope_for(contract, case_id, vendor, **times)

    contract.as_(vendor).open_evidence.reverts(
        case_id,
        compact_json(envelope),
        message=message,
    )
    assert contract.get_case_json(case_id)["lifecycle"] == "FUNDED"


@pytest.mark.parametrize(
    ("method", "warp_to", "now", "message"),
    [
        (
            "open",
            "2026-08-13T00:30:01+00:00",
            1_786_581_001,
            "evidence submission deadline has expired",
        ),
        (
            "open",
            "2026-08-13T02:00:00+00:00",
            1_786_586_400,
            "case hard deadline has expired",
        ),
        (
            "append",
            "2026-08-13T00:30:01+00:00",
            1_786_581_001,
            "evidence submission deadline has expired",
        ),
        (
            "append",
            "2026-08-13T02:00:00+00:00",
            1_786_586_400,
            "case hard deadline has expired",
        ),
    ],
    ids=("open-evidence", "open-hard", "append-evidence", "append-hard"),
)
def test_evidence_writes_reject_fresh_envelopes_after_absolute_cutoffs(
    contract, direct_vm, buyer, vendor, method, warp_to, now, message
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    release = envelope_for(contract, case_id, vendor)
    if method == "append":
        contract.as_(vendor).open_evidence(case_id, compact_json(release))
    direct_vm.warp(warp_to)
    if method == "open":
        envelope = {
            **release,
            "observedAt": now - 1,
            "submittedAt": now,
            "expiresAt": now + 600,
        }
        invocation = contract.as_(vendor).open_evidence
    else:
        envelope = envelope_for(
            contract,
            case_id,
            vendor,
            action="APPEND_EVIDENCE",
            evidenceType="DOM_FACTS",
            observedAt=now - 1,
            submittedAt=now,
            expiresAt=now + 600,
            nonce="after-cutoff",
        )
        invocation = contract.as_(vendor).append_evidence

    invocation.reverts(case_id, compact_json(envelope), message=message)

    if method == "open":
        assert contract.get_case_json(case_id)["lifecycle"] == "FUNDED"
        contract.get_evidence.reverts(
            case_id,
            0,
            message="evidence epoch does not exist",
        )
    else:
        evidence = json.loads(contract.get_evidence(case_id, 0))
        assert evidence["envelopes"] == [release]
        assert contract.get_case_json(case_id)["lifecycle"] == "EVIDENCE_OPEN"


def test_only_vendor_can_open_evidence(
    contract, direct_vm, buyer, vendor, outsider
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    envelope = envelope_for(contract, case_id, vendor)

    contract.as_(outsider).open_evidence.reverts(
        case_id,
        compact_json(envelope),
        message="only the vendor can open evidence",
    )
    assert contract.get_case_json(case_id)["lifecycle"] == "FUNDED"


@pytest.mark.parametrize(
    ("transform", "message"),
    [
        (lambda envelope: "{", "evidence envelope must be valid JSON"),
        (
            lambda envelope: compact_json(
                {key: value for key, value in envelope.items() if key != "nonce"}
            ),
            "evidence envelope fields do not match schema",
        ),
        (
            lambda envelope: compact_json({**envelope, "unexpected": True}),
            "evidence envelope fields do not match schema",
        ),
        (
            lambda envelope: compact_json(
                {**envelope, "schemaVersion": "accessseal-evidence/2"}
            ),
            "evidence schema version is not allowed",
        ),
        (
            lambda envelope: compact_json({**envelope, "epoch": "0"}),
            "evidence envelope field types are invalid",
        ),
        (
            lambda envelope: compact_json({**envelope, "epoch": -1}),
            "evidence integer fields must be safe nonnegative integers",
        ),
        (
            lambda envelope: compact_json(
                {**envelope, "observedAt": 9_007_199_254_740_992}
            ),
            "evidence integer fields must be safe nonnegative integers",
        ),
        (
            lambda envelope: compact_json(
                {**envelope, "nonce": "x" * 4_096}
            ),
            "evidence envelope exceeds size limit",
        ),
    ],
    ids=(
        "json",
        "missing",
        "extra",
        "schema",
        "types",
        "negative",
        "unsafe-integer",
        "size",
    ),
)
def test_open_accepts_only_bounded_fixed_schema(
    contract, direct_vm, buyer, vendor, transform, message
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    envelope_json = transform(envelope_for(contract, case_id, vendor))

    contract.as_(vendor).open_evidence.reverts(
        case_id,
        envelope_json,
        message=message,
    )
    assert contract.get_case_json(case_id)["lifecycle"] == "FUNDED"


def test_vendor_appends_allowlisted_evidence_to_open_epoch(
    contract, direct_vm, buyer, vendor
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    release = envelope_for(contract, case_id, vendor)
    scanner = envelope_for(
        contract,
        case_id,
        vendor,
        action="APPEND_EVIDENCE",
        evidenceType="SCANNER_REPORT",
        nonce="scanner-0",
    )
    contract.as_(vendor).open_evidence(case_id, compact_json(release))

    contract.as_(vendor).append_evidence(case_id, compact_json(scanner))

    evidence = json.loads(contract.get_evidence(case_id, 0))
    assert evidence["envelopes"] == [release, scanner]
    assert evidence["hashes"] == [
        independent_hash(release),
        independent_hash(scanner),
    ]
    assert contract.get_case_json(case_id)["lifecycle"] == "EVIDENCE_OPEN"


def test_append_stores_its_own_payload_binding_to_the_epoch_manifest(
    contract, direct_vm, buyer, vendor
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    release = envelope_for(contract, case_id, vendor)
    facts = envelope_for(
        contract,
        case_id,
        vendor,
        action="APPEND_EVIDENCE",
        evidenceType="DOM_FACTS",
        payloadUri=ORIGIN + "/evidence/keyboard/v1/dom-facts.json",
        payloadSha256="sha256:" + "c" * 64,
        nonce="dom-payload-0",
    )
    contract.as_(vendor).open_evidence(case_id, compact_json(release))

    contract.as_(vendor).append_evidence(case_id, compact_json(facts))

    evidence = json.loads(contract.get_evidence(case_id, 0))
    assert evidence["envelopes"][1] == facts
    assert evidence["envelopes"][1]["releaseDigest"] == RELEASE_DIGEST
    assert evidence["envelopes"][1]["payloadUri"] == (
        ORIGIN + "/evidence/keyboard/v1/dom-facts.json"
    )
    assert evidence["envelopes"][1]["payloadSha256"] == "sha256:" + "c" * 64
    assert evidence["envelopes"][1]["mediaType"] == "application/json"


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (
            {"payloadUri": "http://fixture.accessseal.local/evidence/facts.json"},
            "payload URI must use HTTPS",
        ),
        (
            {"payloadUri": "https://other.example/evidence/facts.json"},
            "payload URI origin does not match case",
        ),
        (
            {"payloadSha256": "sha256:" + "C" * 64},
            "payload SHA-256 must be a lowercase sha256 digest",
        ),
        (
            {"mediaType": "text/html"},
            "evidence media type does not match evidence type",
        ),
    ],
    ids=("non-https", "cross-origin", "payload-hash", "media"),
)
def test_append_rejects_invalid_payload_bindings_without_mutation(
    contract, direct_vm, buyer, vendor, mutation, message
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    release = envelope_for(contract, case_id, vendor)
    contract.as_(vendor).open_evidence(case_id, compact_json(release))
    appended = envelope_for(
        contract,
        case_id,
        vendor,
        action="APPEND_EVIDENCE",
        evidenceType="DOM_FACTS",
        nonce="invalid-payload",
        **mutation,
    )

    contract.as_(vendor).append_evidence.reverts(
        case_id,
        compact_json(appended),
        message=message,
    )

    evidence = json.loads(contract.get_evidence(case_id, 0))
    assert evidence["envelopes"] == [release]
    assert contract.get_case_json(case_id)["lifecycle"] == "EVIDENCE_OPEN"


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (
            {"evidenceType": "LIVE_ORIGIN_OBSERVATION"},
            "evidence type is not vendor-submission allowlisted",
        ),
        (
            {"releaseDigest": "sha256:" + "b" * 64},
            "evidence release digest does not match epoch",
        ),
        (
            {"issuer": "0x" + "ee" * 20},
            "evidence issuer must be the vendor",
        ),
    ],
    ids=("independent-type", "release", "issuer"),
)
def test_append_rejects_unbound_or_nonallowlisted_vendor_evidence(
    contract, direct_vm, buyer, vendor, mutation, message
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    release = envelope_for(contract, case_id, vendor)
    contract.as_(vendor).open_evidence(case_id, compact_json(release))
    append_overrides = {
        "action": "APPEND_EVIDENCE",
        "evidenceType": "SCANNER_REPORT",
        "nonce": "append-0",
        **mutation,
    }
    appended = envelope_for(contract, case_id, vendor, **append_overrides)

    contract.as_(vendor).append_evidence.reverts(
        case_id,
        compact_json(appended),
        message=message,
    )
    evidence = json.loads(contract.get_evidence(case_id, 0))
    assert evidence["envelopes"] == [release]
    assert contract.get_case_json(case_id)["lifecycle"] == "EVIDENCE_OPEN"


def test_only_vendor_can_append_evidence(
    contract, direct_vm, buyer, vendor, outsider
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    release = envelope_for(contract, case_id, vendor)
    contract.as_(vendor).open_evidence(case_id, compact_json(release))
    appended = envelope_for(
        contract,
        case_id,
        vendor,
        action="APPEND_EVIDENCE",
        evidenceType="SCANNER_REPORT",
        nonce="append-0",
    )

    contract.as_(outsider).append_evidence.reverts(
        case_id,
        compact_json(appended),
        message="only the vendor can append evidence",
    )
    assert len(json.loads(contract.get_evidence(case_id, 0))["envelopes"]) == 1


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ({"chainId": "999"}, "evidence chain does not match case"),
        (
            {"contract": "0x" + "ff" * 20},
            "evidence contract does not match case",
        ),
        ({"caseId": "wrong-case"}, "evidence case does not match"),
        ({"epoch": 1}, "evidence epoch does not match current epoch"),
        ({"action": "OPEN_RELEASE"}, "evidence action is not allowed"),
        (
            {"subjectOrigin": "https://wrong.example"},
            "evidence origin does not match case",
        ),
        (
            {"profileVersion": "accessseal-static/2"},
            "evidence profile version is not allowed",
        ),
        (
            {"submittedAt": 1_786_579_201},
            "evidence submission is in the future",
        ),
        (
            {
                "observedAt": 1_786_577_399,
                "submittedAt": 1_786_577_400,
            },
            "evidence observation is stale",
        ),
        (
            {
                "observedAt": 1_786_579_100,
                "submittedAt": 1_786_579_000,
            },
            "evidence timestamps are not ordered",
        ),
        (
            {"schemaVersion": "accessseal-evidence/2"},
            "evidence schema version is not allowed",
        ),
        (
            {"nonce": "x" * 4_096},
            "evidence envelope exceeds size limit",
        ),
        ({"nonce": ""}, "evidence nonce must contain 1 to 128 UTF-8 bytes"),
        (
            {"nonce": "x" * 129},
            "evidence nonce must contain 1 to 128 UTF-8 bytes",
        ),
    ],
    ids=(
        "chain",
        "contract",
        "case",
        "epoch",
        "action",
        "origin",
        "profile",
        "future",
        "stale",
        "inverted",
        "schema",
        "size",
        "empty-nonce",
        "long-nonce",
    ),
)
def test_append_rejects_invalid_envelopes_without_mutating_evidence(
    contract, direct_vm, buyer, vendor, mutation, message
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    release = envelope_for(contract, case_id, vendor)
    contract.as_(vendor).open_evidence(case_id, compact_json(release))
    append_overrides = {
        "action": "APPEND_EVIDENCE",
        "evidenceType": "DOM_FACTS",
        "nonce": "append-invalid",
        **mutation,
    }
    appended = envelope_for(contract, case_id, vendor, **append_overrides)

    contract.as_(vendor).append_evidence.reverts(
        case_id,
        compact_json(appended),
        message=message,
    )

    evidence = json.loads(contract.get_evidence(case_id, 0))
    assert evidence["envelopes"] == [release]
    assert contract.get_case_json(case_id)["lifecycle"] == "EVIDENCE_OPEN"


@pytest.mark.parametrize(
    ("replay_mutation", "message"),
    [
        ({}, "evidence type is already present"),
        (
            {
                "evidenceType": "HTML_BUNDLE",
                "mediaType": "text/html",
                "payloadUri": ORIGIN + "/evidence/index.html",
            },
            "evidence nonce already used for action",
        ),
    ],
    ids=("type-before-hash", "nonce-different-type"),
)
def test_append_rejects_duplicate_type_or_action_nonce(
    contract, direct_vm, buyer, vendor, replay_mutation, message
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    release = envelope_for(contract, case_id, vendor)
    contract.as_(vendor).open_evidence(case_id, compact_json(release))
    first = envelope_for(
        contract,
        case_id,
        vendor,
        action="APPEND_EVIDENCE",
        evidenceType="SCANNER_REPORT",
        nonce="same-nonce",
    )
    contract.as_(vendor).append_evidence(case_id, compact_json(first))
    replay = {**first, **replay_mutation}

    if replay_mutation:
        assert independent_hash(first) != independent_hash(replay)

    contract.as_(vendor).append_evidence.reverts(
        case_id,
        compact_json(replay),
        message=message,
    )
    assert len(json.loads(contract.get_evidence(case_id, 0))["envelopes"]) == 2


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (
            {"evidenceType": "SCANNER_REPORT"},
            "open evidence must be a release manifest",
        ),
        ({"nonce": ""}, "evidence nonce must contain 1 to 128 UTF-8 bytes"),
        (
            {"nonce": "x" * 129},
            "evidence nonce must contain 1 to 128 UTF-8 bytes",
        ),
    ],
    ids=("type", "empty-nonce", "long-nonce"),
)
def test_open_requires_release_manifest_and_bounded_nonce(
    contract, direct_vm, buyer, vendor, mutation, message
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    envelope = envelope_for(contract, case_id, vendor, **mutation)

    contract.as_(vendor).open_evidence.reverts(
        case_id,
        compact_json(envelope),
        message=message,
    )
    assert contract.get_case_json(case_id)["lifecycle"] == "FUNDED"


def test_buyer_seals_exact_complete_fresh_evidence_profile_before_cutoff(
    contract, direct_vm, buyer, vendor
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    open_complete_early_seal_profile(contract, case_id, vendor)

    contract.as_(buyer).close_evidence(case_id)

    case = contract.get_case_json(case_id)
    assert case["lifecycle"] == "EVIDENCE_SEALED"
    assert case["evidenceSealed"] is True
    assert case["evidenceSealedAt"] == 1_786_579_200
    assert case["evidenceSealedBy"] == str(buyer).lower()
    evidence = json.loads(contract.get_evidence(case_id, 0))
    assert [item["evidenceType"] for item in evidence["envelopes"]] == list(
        REQUIRED_EARLY_SEAL_TYPES
    )


@pytest.mark.parametrize("actor", ("vendor", "outsider"))
def test_early_seal_rejects_nonbuyer_without_mutating_readback(
    contract, direct_vm, buyer, vendor, outsider, actor
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    open_complete_early_seal_profile(contract, case_id, vendor)
    before = case_evidence_and_accounting(contract, case_id)

    contract.as_({"vendor": vendor, "outsider": outsider}[actor]).close_evidence.reverts(
        case_id,
        message="only the buyer can close evidence",
    )

    assert case_evidence_and_accounting(contract, case_id) == before


@pytest.mark.parametrize("omitted_type", REQUIRED_EARLY_SEAL_TYPES[1:])
def test_early_seal_rejects_each_missing_required_supporting_type_without_mutation(
    contract, direct_vm, buyer, vendor, omitted_type
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    open_complete_early_seal_profile(
        contract,
        case_id,
        vendor,
        omit_type=omitted_type,
    )
    before = case_evidence_and_accounting(contract, case_id)

    contract.as_(buyer).close_evidence.reverts(
        case_id,
        message="evidence profile is incomplete",
    )

    assert case_evidence_and_accounting(contract, case_id) == before


def test_append_rejects_duplicate_type_before_consuming_evidence_domain(
    contract, direct_vm, buyer, vendor
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    release = envelope_for(contract, case_id, vendor)
    first = envelope_for(
        contract,
        case_id,
        vendor,
        action="APPEND_EVIDENCE",
        evidenceType="SCANNER_REPORT",
        nonce="scanner-first",
    )
    duplicate_type = {
        **first,
        "nonce": "scanner-second",
        "payloadUri": ORIGIN + "/evidence/scanner-report-second.json",
    }
    contract.as_(vendor).open_evidence(case_id, compact_json(release))
    contract.as_(vendor).append_evidence(case_id, compact_json(first))
    before = case_evidence_and_accounting(contract, case_id)

    contract.as_(vendor).append_evidence.reverts(
        case_id,
        compact_json(duplicate_type),
        message="evidence type is already present",
    )

    assert case_evidence_and_accounting(contract, case_id) == before


def test_close_evidence_rejects_one_expired_supporting_envelope_at_seal_time(
    contract, direct_vm, buyer, vendor
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    open_complete_early_seal_profile(
        contract,
        case_id,
        vendor,
        expires_at=1_786_581_000,
        expires_at_by_type={"DOM_FACTS": 1_786_580_000},
    )
    direct_vm.warp("2026-08-13T00:13:20+00:00")
    before = case_evidence_and_accounting(contract, case_id)

    contract.as_(buyer).close_evidence.reverts(
        case_id,
        message="evidence profile contains expired evidence",
    )

    assert case_evidence_and_accounting(contract, case_id) == before


def test_early_seal_rejects_manifestless_cure_epoch_without_mutation(
    contract, direct_vm, buyer, vendor
):
    from genlayer import Address

    case_id, _release = open_reviewable_case(
        contract,
        direct_vm,
        buyer,
        vendor,
        supporting_evidence=("HTML_BUNDLE",),
        salt="manifestless-cure-epoch",
    )
    contract.request_review(case_id)
    finality = json.loads(contract.get_review_finality(case_id))
    self_address = Address(contract.get_case_json(case_id)["contractAddress"])
    contract.as_(self_address).confirm_review_finality(
        case_id,
        finality["epoch"],
        finality["attempt"],
        finality["proofId"],
    )
    contract.as_(vendor).start_cure(case_id)
    assert contract.get_case_json(case_id)["epoch"] == 1
    assert contract.get_case_json(case_id)["lifecycle"] == "EVIDENCE_OPEN"
    before_case = contract.get_case_json(case_id)
    before_evidence = json.loads(contract.get_evidence(case_id, 0))
    before_accounting = json.loads(contract.get_accounting())
    contract.get_evidence.reverts(
        case_id,
        1,
        message="evidence epoch does not exist",
    )

    contract.as_(buyer).close_evidence.reverts(
        case_id,
        message="evidence profile is incomplete",
    )

    assert contract.get_case_json(case_id) == before_case
    assert json.loads(contract.get_evidence(case_id, 0)) == before_evidence
    assert json.loads(contract.get_accounting()) == before_accounting
    contract.get_evidence.reverts(
        case_id,
        1,
        message="evidence epoch does not exist",
    )


def test_close_evidence_rejects_hard_deadline_without_mutating_readback(
    contract, direct_vm, buyer, vendor
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    open_complete_early_seal_profile(contract, case_id, vendor)
    direct_vm.warp("2026-08-13T02:00:00+00:00")
    before = case_evidence_and_accounting(contract, case_id)

    contract.as_(buyer).close_evidence.reverts(
        case_id,
        message="case hard deadline has expired",
    )

    assert case_evidence_and_accounting(contract, case_id) == before


def test_close_evidence_rejects_second_close_without_mutating_readback(
    contract, direct_vm, buyer, vendor
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    open_complete_early_seal_profile(contract, case_id, vendor)
    contract.as_(buyer).close_evidence(case_id)
    before = case_evidence_and_accounting(contract, case_id)

    contract.as_(buyer).close_evidence.reverts(
        case_id,
        message="evidence is not open",
    )

    assert case_evidence_and_accounting(contract, case_id) == before


def test_append_rejects_after_early_seal_without_mutating_readback(
    contract, direct_vm, buyer, vendor
):
    case_id = funded_case(contract, direct_vm, buyer, vendor)
    open_complete_early_seal_profile(contract, case_id, vendor)
    contract.as_(buyer).close_evidence(case_id)
    appended = envelope_for(
        contract,
        case_id,
        vendor,
        action="APPEND_EVIDENCE",
        evidenceType="DOM_FACTS",
        nonce="post-seal",
    )
    before = case_evidence_and_accounting(contract, case_id)

    contract.as_(vendor).append_evidence.reverts(
        case_id,
        compact_json(appended),
        message="evidence is not open",
    )

    assert case_evidence_and_accounting(contract, case_id) == before
