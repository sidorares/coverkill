# Changelog

## [0.3.0](https://github.com/sidorares/coverkill/compare/v0.2.0...v0.3.0) (2026-08-23)


### ⚠ BREAKING CHANGES

* `coverkill collect` writes report v2 instead of v1. v1 reports are still read, and buildCoverageReport() still emits v1 for consumers pinned to that shape.

### Features

* accept raw V8 ScriptCoverage as the report format (report v2) ([639f740](https://github.com/sidorares/coverkill/commit/639f74016999cfa0c5e8376271bcf8760f1e4148)), closes [#3](https://github.com/sidorares/coverkill/issues/3)
* add `coverkill merge` to union coverage across runs ([89a45d2](https://github.com/sidorares/coverkill/commit/89a45d208f11e85914536e2bb9cd6fa6f42ed38b))
* add `coverkill merge` to union coverage across runs ([c7fd44e](https://github.com/sidorares/coverkill/commit/c7fd44ed1eed3be54b642089ccd50ecef72cca44)), closes [#5](https://github.com/sidorares/coverkill/issues/5)
* loud stub modes — pruned paths announce themselves (throw/beacon) ([13456b8](https://github.com/sidorares/coverkill/commit/13456b86c94cd1aa7545fbe815a50c5b19fa7de1))
* loud stub modes — pruned paths throw or beacon instead of silently no-op'ing ([d1be6c3](https://github.com/sidorares/coverkill/commit/d1be6c3254eaab9988f4afa2884c59e65ce8c7eb)), closes [#6](https://github.com/sidorares/coverkill/issues/6)


### Bug Fixes

* address adversarial hunt round 3 findings ([993cbf8](https://github.com/sidorares/coverkill/commit/993cbf8a55c6b751e60a6e4d179dcfa82c94e23a))
* address all verified failures from adversarial hunt round 1 ([efda67c](https://github.com/sidorares/coverkill/commit/efda67c385bd314b6e1b5fe2b44c906a6d58a914))
* address all verified failures from adversarial hunt round 2 ([d57c7ec](https://github.com/sidorares/coverkill/commit/d57c7ec3b0a9e17c9511862d07cfa54cfa81238d))
* anchor coverage gitignore pattern, add missing src/coverage files ([0861b84](https://github.com/sidorares/coverkill/commit/0861b84a0c8d6b08ce6233ff66460c3c6474a534))
* correct V8 coverage semantics and rebuild both pruners for safety ([7201308](https://github.com/sidorares/coverkill/commit/7201308ed5872d041ccf0fabb3f8e614832cada1))
