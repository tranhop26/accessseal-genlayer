import json
from datetime import datetime

import pytest

from conftest import _Invocation


PROFILE_HASH = "0x" + "11" * 32
FLOWS_HASH = "0x" + "22" * 32
ORIGIN = "https://buyer.example"
ESCROW = 50_000
FIXED_CONTRACT_ADDRESS = "0x00000000000000000000000000000000000000a5"
FIXED_BUYER_ADDRESS = "0xc53d1da3c1c414d602ed7a090e15320e773bbb5a"
FIXED_VENDOR_ADDRESS = "0xb9e27f39b58cd8146a1fd435791761e4fe4e84f0"
FIXED_CASE_ID = (
    "0xd187a1289ea4122d9f1838da2729b1d139eca698568815a87172489799a5466b"
)


def create_case(contract, buyer, vendor, **overrides):
    values = {
        "salt": "buyer-release-001",
        "vendor": vendor,
        "profile_hash": PROFILE_HASH,
        "flows_hash": FLOWS_HASH,
        "subject_origin": ORIGIN,
        "evidence_deadline": 1_800,
        "hard_deadline": 7_200,
        "max_unresolved_retries": 2,
        "escrow_amount": ESCROW,
    }
    values.update(overrides)
    return contract.as_(buyer).create_case(
        values["salt"],
        values["vendor"],
        values["profile_hash"],
        values["flows_hash"],
        values["subject_origin"],
        values["evidence_deadline"],
        values["hard_deadline"],
        values["max_unresolved_retries"],
        values["escrow_amount"],
    )


def test_reverts_does_not_accept_unrelated_exception(contract, direct_vm):
    def raise_unrelated_type_error():
        raise TypeError("unrelated harness failure")

    invocation = _Invocation(raise_unrelated_type_error, direct_vm, None)
    with pytest.raises(TypeError, match="unrelated harness failure"):
        invocation.reverts()


@pytest.mark.parametrize(
    ("profile_hash", "expected_terms_hash"),
    [
        (
            PROFILE_HASH,
            "0xaeb6252be9f879cdfd42bad5bced5501dcbf599b20c222f0703de0f74f96f8fc",
        ),
        (
            "0x" + "33" * 32,
            "0x4458fb786d7359387df7be2d3ee9cca8491b12c6c6bb6bd1daafcd451003f0f5",
        ),
    ],
    ids=("original-profile", "mutated-profile"),
)
def test_canonical_hashes_match_fixed_known_vectors(
    contract,
    buyer,
    vendor,
    profile_hash,
    expected_terms_hash,
):
    from genlayer import Address, gl

    gl.message = gl.message._replace(
        contract_address=Address(FIXED_CONTRACT_ADDRESS)
    )
    assert buyer.as_hex.lower() == FIXED_BUYER_ADDRESS
    assert vendor.as_hex.lower() == FIXED_VENDOR_ADDRESS
    assert int(gl.message.chain_id) == 1

    case_id = create_case(
        contract,
        buyer,
        vendor,
        profile_hash=profile_hash,
    )
    case = contract.get_case_json(case_id)
    assert case_id == FIXED_CASE_ID
    assert case["termsHash"] == expected_terms_hash


def test_new_case_exposes_initial_evidence_seal_state(
    contract, buyer, vendor
):
    case_id = create_case(contract, buyer, vendor)
    case = contract.get_case_json(case_id)

    assert set(case) == {
        "buyer",
        "caseId",
        "chainId",
        "contractAddress",
        "createdAt",
        "escrowAmount",
        "evidenceDeadline",
        "evidenceCutoff",
        "evidenceSealed",
        "evidenceSealedAt",
        "evidenceSealedBy",
        "flowsHash",
        "hardDeadline",
        "lifecycle",
        "epoch",
        "maxUnresolvedRetries",
        "profileHash",
        "reserved",
        "readAt",
        "reviewContextHash",
        "reviewContextReady",
        "salt",
        "subjectOrigin",
        "termsHash",
        "vendor",
        "vendorAccepted",
    }
    assert case["evidenceSealed"] is False
    assert case["evidenceSealedAt"] == 0
    assert case["evidenceSealedBy"] == "0x0000000000000000000000000000000000000000"
    assert case["reviewContextHash"] == ""
    assert case["reviewContextReady"] is False


def test_case_readback_exposes_exact_authoritative_cutoff_clock_without_changing_terms(
    contract, direct_vm, buyer, vendor
):
    base = "2026-08-13T00:00:00+00:00"
    direct_vm.warp(base)
    case_id = create_case(contract, buyer, vendor, salt="cutoff-readback")
    original = json.loads(contract.get_case(case_id))
    created_at = int(datetime.fromisoformat(base).timestamp())
    cutoff = created_at + 1_800

    assert original["createdAt"] == created_at
    assert original["evidenceCutoff"] == cutoff
    assert original["readAt"] == created_at

    for when, expected_read_at in (
        ("2026-08-13T00:29:59+00:00", cutoff - 1),
        ("2026-08-13T00:30:00+00:00", cutoff),
        ("2026-08-13T00:30:01+00:00", cutoff + 1),
    ):
        direct_vm.warp(when)
        readback = json.loads(contract.get_case(case_id))
        assert readback["createdAt"] == created_at
        assert readback["evidenceCutoff"] == cutoff
        assert readback["readAt"] == expected_read_at
        assert readback["termsHash"] == original["termsHash"]


def test_buyer_vendor_funding_handshake(contract, buyer, vendor, outsider):
    case_id = contract.as_(buyer).create_case(
        "buyer-release-001",
        vendor,
        PROFILE_HASH,
        FLOWS_HASH,
        ORIGIN,
        1_800,
        7_200,
        2,
        ESCROW,
    )

    draft = contract.get_case_json(case_id)
    raw_draft = contract.get_case(case_id)
    assert raw_draft == json.dumps(draft, sort_keys=True, separators=(",", ":"))
    assert draft["caseId"] == case_id
    assert draft["lifecycle"] == "DRAFT"
    assert draft["buyer"] == buyer.as_hex.lower()
    assert draft["vendor"] == vendor.as_hex.lower()
    assert draft["profileHash"] == PROFILE_HASH
    assert draft["flowsHash"] == FLOWS_HASH
    assert draft["reserved"] == 0
    assert draft["vendorAccepted"] is False

    contract.as_(outsider).accept_terms.reverts(
        case_id,
        draft["termsHash"],
        message="only the vendor can accept terms",
    )
    contract.as_(vendor).accept_terms.reverts(
        case_id,
        "0x" + "ff" * 32,
        message="terms hash does not match",
    )
    contract.as_(vendor).accept_terms(case_id, draft["termsHash"])
    contract.as_(outsider).fund.reverts(
        case_id,
        value=ESCROW,
        message="only the buyer can fund",
    )
    contract.as_(buyer).fund(case_id, value=ESCROW)

    funded = contract.get_case_json(case_id)
    assert funded["lifecycle"] == "FUNDED"
    assert funded["reserved"] == ESCROW
    assert funded["vendorAccepted"] is True
    for immutable_field in (
        "buyer",
        "vendor",
        "profileHash",
        "flowsHash",
        "subjectOrigin",
        "evidenceDeadline",
        "hardDeadline",
        "maxUnresolvedRetries",
        "escrowAmount",
        "termsHash",
    ):
        assert funded[immutable_field] == draft[immutable_field]


def test_create_case_accepts_bradbury_string_vendor_calldata(contract, buyer, vendor):
    """Bradbury v0.2.11 currently decodes ABI address arguments as strings."""
    case_id = create_case(
        contract,
        buyer,
        vendor.as_hex,
        salt="bradbury-string-vendor",
    )

    draft = contract.get_case_json(case_id)
    assert draft["vendor"] == vendor.as_hex.lower()


@pytest.mark.parametrize(
    "vendor_text",
    (
        "0x1234",
        "0x" + "gg" * 20,
        "b9e27f39b58cd8146a1fd435791761e4fe4e84f0",
        123,
    ),
)
def test_create_case_rejects_malformed_runtime_vendor_strings(
    contract, buyer, vendor_text
):
    contract.as_(buyer).create_case.reverts(
        "malformed-runtime-vendor",
        vendor_text,
        PROFILE_HASH,
        FLOWS_HASH,
        ORIGIN,
        1_800,
        7_200,
        2,
        ESCROW,
        message="address calldata is invalid",
    )


def test_duplicate_buyer_salt_domain_is_rejected(contract, buyer, vendor):
    create_case(contract, buyer, vendor)

    contract.as_(buyer).create_case.reverts(
        "buyer-release-001",
        vendor,
        "0x" + "33" * 32,
        FLOWS_HASH,
        "https://changed.example",
        2_000,
        8_000,
        3,
        ESCROW + 1,
        message="case domain already exists",
    )


def test_buyer_cannot_be_the_vendor(contract, buyer):
    contract.as_(buyer).create_case.reverts(
        "buyer-release-001",
        buyer,
        PROFILE_HASH,
        FLOWS_HASH,
        ORIGIN,
        1_800,
        7_200,
        2,
        ESCROW,
        message="buyer and vendor must differ",
    )


def test_zero_address_vendor_is_rejected(contract, buyer):
    from genlayer import Address

    zero_vendor = Address(bytes(20))
    contract.as_(buyer).create_case.reverts(
        "buyer-release-001",
        zero_vendor,
        PROFILE_HASH,
        FLOWS_HASH,
        ORIGIN,
        1_800,
        7_200,
        2,
        ESCROW,
        message="vendor must not be the zero address",
    )


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"salt": ""}, "salt must contain 1 to 128 characters"),
        ({"salt": "x" * 129}, "salt must contain 1 to 128 characters"),
        ({"profile_hash": ""}, "profile hash must be a 32-byte hex digest"),
        (
            {"profile_hash": "0x1234"},
            "profile hash must be a 32-byte hex digest",
        ),
        ({"flows_hash": ""}, "flows hash must be a 32-byte hex digest"),
        (
            {"flows_hash": "not-a-hash"},
            "flows hash must be a 32-byte hex digest",
        ),
        (
            {"subject_origin": ""},
            "subject origin must contain 1 to 2048 characters",
        ),
        (
            {"subject_origin": "x" * 2_049},
            "subject origin must contain 1 to 2048 characters",
        ),
        ({"evidence_deadline": 0}, "deadlines must be positive and ordered"),
        (
            {"evidence_deadline": 1_800, "hard_deadline": 1_800},
            "deadlines must be positive and ordered",
        ),
        (
            {"evidence_deadline": 7_200, "hard_deadline": 1_800},
            "deadlines must be positive and ordered",
        ),
        ({"escrow_amount": 0}, "escrow amount must be positive"),
    ],
)
def test_invalid_bound_terms_are_rejected(
    contract, buyer, vendor, overrides, message
):
    values = {
        "salt": "buyer-release-001",
        "vendor": vendor,
        "profile_hash": PROFILE_HASH,
        "flows_hash": FLOWS_HASH,
        "subject_origin": ORIGIN,
        "evidence_deadline": 1_800,
        "hard_deadline": 7_200,
        "max_unresolved_retries": 2,
        "escrow_amount": ESCROW,
    }
    values.update(overrides)

    contract.as_(buyer).create_case.reverts(
        values["salt"],
        values["vendor"],
        values["profile_hash"],
        values["flows_hash"],
        values["subject_origin"],
        values["evidence_deadline"],
        values["hard_deadline"],
        values["max_unresolved_retries"],
        values["escrow_amount"],
        message=message,
    )


def test_funding_before_vendor_consent_is_rejected(contract, buyer, vendor):
    case_id = create_case(contract, buyer, vendor)

    contract.as_(buyer).fund.reverts(
        case_id,
        value=ESCROW,
        message="vendor must accept terms before funding",
    )
    assert contract.get_case_json(case_id)["lifecycle"] == "DRAFT"


@pytest.mark.parametrize("value", [0, ESCROW - 1, ESCROW + 1])
def test_funding_requires_the_exact_positive_locked_amount(
    contract, buyer, vendor, value
):
    case_id = create_case(contract, buyer, vendor)
    terms_hash = contract.get_case_json(case_id)["termsHash"]
    contract.as_(vendor).accept_terms(case_id, terms_hash)

    contract.as_(buyer).fund.reverts(
        case_id,
        value=value,
        message="funding value must equal escrow amount",
    )
    assert contract.get_case_json(case_id)["reserved"] == 0


def test_double_funding_is_rejected(contract, buyer, vendor):
    case_id = create_case(contract, buyer, vendor)
    terms_hash = contract.get_case_json(case_id)["termsHash"]
    contract.as_(vendor).accept_terms(case_id, terms_hash)
    contract.as_(buyer).fund(case_id, value=ESCROW)

    contract.as_(buyer).fund.reverts(
        case_id,
        value=ESCROW,
        message="case is not fundable",
    )


def test_terms_cannot_change_or_be_reaccepted_after_funding(
    contract, buyer, vendor
):
    case_id = create_case(contract, buyer, vendor)
    draft = contract.get_case_json(case_id)
    contract.as_(vendor).accept_terms(case_id, draft["termsHash"])
    contract.as_(vendor).accept_terms(case_id, draft["termsHash"])
    contract.as_(vendor).accept_terms.reverts(
        case_id,
        "0x" + "44" * 32,
        message="terms hash does not match",
    )
    contract.as_(buyer).fund(case_id, value=ESCROW)

    contract.as_(vendor).accept_terms.reverts(
        case_id,
        draft["termsHash"],
        message="terms can only be accepted while draft",
    )
    funded = contract.get_case_json(case_id)
    for immutable_field in (
        "buyer",
        "vendor",
        "salt",
        "profileHash",
        "flowsHash",
        "subjectOrigin",
        "evidenceDeadline",
        "hardDeadline",
        "maxUnresolvedRetries",
        "escrowAmount",
        "termsHash",
    ):
        assert funded[immutable_field] == draft[immutable_field]


def test_vendor_cannot_accept_expired_terms(
    contract, direct_vm, buyer, vendor
):
    direct_vm.warp("2026-08-13T00:00:00+00:00")
    case_id = create_case(contract, buyer, vendor)
    terms_hash = contract.get_case_json(case_id)["termsHash"]
    direct_vm.warp("2026-08-13T00:30:01+00:00")

    contract.as_(vendor).accept_terms.reverts(
        case_id,
        terms_hash,
        message="terms acceptance deadline has expired",
    )
