# Planning preview: implicit current departure

Base source: `41ddfaf329b52fc9ca4b821fe270ea25b4bf4e49`.
This release changes only the situation API source, its synthetic regressions,
and this release note. It does not deploy or modify engine configuration.

Evidence: Root native pair `85e5b616-0c69-4cba-a362-8f8e5b91c8ef`, receipt
`30543105e33c5dcf7678bd622713d752d620b6280d0d25c613df5cfeffbea546`.
Both public builder-like baselines returned warning 401; the otherwise identical
type0 departure variants returned trips with empty warnings. This is not a
historical 6f replay, proof of closure/TEC handling, or production acceptance.

## Narrow behavior

The current-only `knownClosureRoute` supplies private `knownClosureCurrentDeparture`
for ordinary road routes, alternatives and assisted planning. It serializes native `date_time:{type:0}`
even without usable live flow. It does not supply `prioritize_bidirectional`.
The public normalized query and canonical hashes remain unchanged: the current-only path's
implicit current departure becomes explicit only at the native adapter boundary.
The generic parser still rejects the string `now`; a caller cannot select the
private option through HTTP fields. Legacy/non-known-closure absent time and
explicit future/arrival rejection behavior are preserved. This does not add
scheduled or arrive-by routing support. This scope supersedes preview-only
commit `3c27fbc`: Jizda's normal preview uses the ordinary route endpoint.
The current-only guard rejects explicit non-current departure before status or
native work. Its single-flight coalesces only in-flight identical requests (no
retained result), with the existing request/dataset/version/snapshot/traffic
revision key unchanged. Every caller retains all final validation.
This does not claim that a separate native 171 unlocatable-origin error is fixed.

Live `current` speed types still independently require usable overlay evidence.
No changes to warning 401 rejection, malformed/geometry checks, vehicle/access
flags, snap limits, dataset/closure guards, cache fences, authentication or
measurement intake. No retry or fallback is added.

## Root-only release and acceptance

Build only the situation API image from the exact release source. Pin the image
identity and existing running image identity before the one approved image-only
transition. Do not include unrelated working-tree diagnostics. Preserve all
current config/environment, networks, ports, volumes, resources and credentials.
No DB migration or data change is required. Root records the final image hash;
there is no image identity or production PASS supplied by this source package.

Perform bounded public planning canaries through the real authenticated path,
checking actual route, current dataset, mapped/closure evidence and unchanged
error guards; local mocks/native pair are not substitutes. On failed acceptance,
Root restores the exact previously pinned image with unchanged configuration.
Do not enable Jizda/TestFlight or relax any guard as part of rollback or testing.
