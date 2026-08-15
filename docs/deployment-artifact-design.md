# Compact deployment artifact design

## Problem

The readable `contracts/access_seal.py` source is about 73 KB. Bradbury rejects
its deployment during gas estimation with `BlockPubdataLimitReached`, before a
transaction is submitted. Changing wallets or using the CLI cannot bypass this
chain-level limit.

## Decision

Keep the readable contract as the reviewed source of truth and generate a
deterministic compact deployment artifact. The artifact must preserve the
dependency header, public method names, argument and return annotations,
storage annotations, global names, strings, constants, and executable
semantics. Local-variable renaming and syntax/layout compaction are allowed,
except that Python's conventional `self` method parameter is preserved because
the GenVM schema linter requires it by name.

The initial hard artifact budget is 48,000 UTF-8 bytes. The measured safe
profile is approximately 44.8 KB, leaving headroom for deployment encoding.
Deployment fails closed when the artifact is absent, stale, over budget, or not
reproducible from the readable source.

## Components and data flow

1. A pinned Python minifier dependency transforms the readable source using a
   fixed option set. The GenLayer dependency header is restored byte-for-byte.
2. A generator writes the compact artifact atomically and emits its source and
   artifact SHA-256 hashes.
3. Direct tests deploy the compact artifact against the existing full contract
   behavior suite.
4. A parity test requires the readable and compact sources to expose identical
   GenVM schemas and requires regeneration to be byte-for-byte deterministic.
5. Deployment and verification scripts read only the compact artifact and bind
   both readable-source and artifact hashes in the deployment manifest.
6. Proof collection verifies both tracked files and both hashes against the
   exact public Git commit and live deployed code.

## Failure handling

- Missing or unpinned minifier: fail before generation.
- Changed readable source without regeneration: fail before tests/deployment.
- Schema difference, syntax error, lint error, or artifact over 48,000 bytes:
  fail before deployment.
- Live code mismatch with the compact artifact: fail readback and proof
  collection.
- Bradbury still rejects the compact artifact: do not weaken contract logic;
  measure the new boundary and reconsider the packaging architecture.

## Verification

Implementation follows RED/GREEN tests for deterministic generation, stale
artifact rejection, size enforcement, dependency-header preservation, schema
parity, and deployment-source selection. Existing direct and integration suites
then run against the artifact. After focused checks pass, run one final complete
gate and perform one Bradbury deployment attempt with finalized transaction,
deployed-code/schema readback, and accounting readback.

## Non-goals

This change does not alter AccessSeal decisions, evidence rules, custody,
settlement, recovery, frontend APIs, or contract classification. It does not
split the system into multiple contracts and does not introduce an upgrade
authority.
