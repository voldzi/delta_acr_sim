# Test strategy

**Status:** Baseline dokumentace

## Úrovně testů

- unit testy validátorů a generátorů
- contract testy OpenAPI/JSON Schema
- integration testy publisheru a mock COP
- load testy event rate a queue
- AI guardrail testy
- UI smoke testy
- acceptance testy MVP scénářů

## Priorita

První implementační krok má testovat kontrakty, publisher safety gates a AI guardrails dříve než bohaté UI chování.

## Graph-native traffic promotion

Run `python3 deploy/valhalla/test-native-canary-ab.py` and
`python3 deploy/valhalla/test-native-live-selection.py`, followed by the existing
traffic updater/expiry/physical-archive suites. The selection tests cover
default-off, root-only file ownership, strict approval, graph/static rotation,
changed graph/baseline, whole-edge/reference/cross-candidate conflicts and
fingerprint invalidation. A full synthetic archive activation/rollback test
preserves the baseline bytes and physically zeros the added edge on return.
The bound, private same-flow pilot is separate from fixture tests and does not
replace operator geographic acceptance or independent actual trip-time evidence.
