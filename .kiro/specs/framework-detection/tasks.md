# Implementation Plan: Framework Detection

## Overview

Implement the framework detection capability as a new `FrameworkDetector` service, extend existing models and the ingest pipeline to carry and persist the detected framework, and add a Gemini LLM fallback for low-confidence results. All changes are additive — no existing behavior is broken.

---

## Tasks

- [x] 1. Add `FrameworkResult` dataclass and update `ServiceNode` and `IngestResponse` models
  - Add `FrameworkResult(framework: str, confidence: float)` dataclass to `backend/app/models/nodes.py`
  - Add `framework: str = "unknown"` field to `ServiceNode` in `backend/app/models/nodes.py`
  - Add `detected_framework: str` and `framework_confidence: float` fields to `IngestResponse` in `backend/app/api/v1/ingest.py`
  - _Requirements: 1.2, 4.2, 4.4_

- [-] 2. Implement `FrameworkDetector` service
  - [x] 2.1 Create `backend/app/services/framework_detector.py` with the `FRAMEWORK_INDICATORS` registry and `FrameworkDetector` class
    - Implement synchronous `detect(repo_path: str) -> FrameworkResult` method
    - Parse `package.json` (dependencies + devDependencies) for JS frameworks
    - Parse `requirements.txt`, `pyproject.toml`, `Pipfile`, `setup.py` for Python frameworks using case-insensitive matching
    - Check secondary indicators (config files/dirs) for extra confidence
    - Score: primary indicator +0.6, secondary +0.2, capped at 1.0
    - Return `FrameworkResult("unknown", 0.0)` when no indicators are found
    - Catch and log all file-read and parse errors per-file without propagating
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.3, 3.4, 3.5, 6.1, 6.2, 6.3_

  - [ ]* 2.2 Write unit tests for `FrameworkDetector.detect()` — all 7 frameworks
    - One fixture-based test per supported framework with representative files
    - Test empty directory → `("unknown", 0.0)`
    - Test malformed `package.json` → no exception raised
    - Test malformed `requirements.txt` → no exception raised
    - _Requirements: 1.1, 1.3, 1.5, 6.1, 6.2_

  - [ ]* 2.3 Write property test: P1 — Confidence invariant
    - **Property 1: Confidence invariant**
    - **Validates: Requirements 1.2**
    - Generate random combinations of indicator files and assert `0.0 <= result.confidence <= 1.0`

  - [ ]* 2.4 Write property test: P2 — Winner has maximum confidence
    - **Property 2: Winner has maximum confidence**
    - **Validates: Requirements 1.4**
    - Generate repos with indicators for multiple frameworks and assert the returned framework has the highest score

  - [ ]* 2.5 Write property test: P3 — JS dependency detection
    - **Property 3: JS dependency detection**
    - **Validates: Requirements 2.1, 2.3**
    - Generate `package.json` content with known framework deps and assert correct framework is returned

  - [ ]* 2.6 Write property test: P4 — Python dependency detection
    - **Property 4: Python dependency detection**
    - **Validates: Requirements 2.2**
    - Generate Python dep file content with known package names and assert correct framework is returned

  - [ ]* 2.7 Write property test: P5 — Case-insensitive Python package matching
    - **Property 5: Case-insensitive matching**
    - **Validates: Requirements 2.4**
    - Generate random casings of known Python package names and assert same framework regardless of casing

  - [ ]* 2.8 Write property test: P6 — Monotonicity of confidence
    - **Property 6: Monotonicity**
    - **Validates: Requirements 3.1**
    - Generate a baseline indicator set and an augmented set; assert augmented score >= baseline score

  - [ ]* 2.9 Write property test: P7 — Primary indicator lower bound
    - **Property 7: Primary indicator lower bound**
    - **Validates: Requirements 3.3**
    - For each framework, generate a repo with exactly one primary indicator and assert confidence == 0.6

- [x] 3. Checkpoint — Ensure all detector unit and property tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Add Gemini LLM fallback to `FrameworkDetector`
  - [ ] 4.1 Add `infer_framework(file_list: list[str]) -> str` async method to `GeminiService` in `backend/app/services/gemini_service.py`
    - Build a prompt listing repository filenames and asking for the most likely backend framework
    - Normalize response to lowercase and validate against known framework names
    - Return `"unknown"` if response is unrecognized
    - _Requirements: 5.2_

  - [x] 4.2 Add `detect_with_llm_fallback(repo_path, gemini_service) -> FrameworkResult` async method to `FrameworkDetector`
    - Call `detect()` first
    - If `result.confidence < 0.5` and `GEMINI_API_KEY` is set, call `gemini_service.infer_framework()`
    - Update result if LLM returns a recognized framework
    - On any exception from Gemini, log warning and retain file-based result
    - Skip LLM call entirely if `GEMINI_API_KEY` is empty
    - _Requirements: 5.1, 5.3, 5.4_

  - [ ]* 4.3 Write unit tests for LLM fallback
    - Test: Gemini called when score < 0.5 and key is set
    - Test: Gemini not called when score >= 0.5
    - Test: Gemini not called when `GEMINI_API_KEY` is empty
    - Test: File-based result retained when Gemini raises
    - Test: Result updated when Gemini returns recognized framework
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [ ]* 4.4 Write property test: P8 — LLM fallback triggered below threshold
    - **Property 8: LLM fallback triggered when file-based score is below threshold**
    - **Validates: Requirements 5.1**
    - Generate repos with no indicators, mock Gemini call, assert it was invoked exactly once

- [x] 5. Wire `FrameworkDetector` into the ingest pipeline
  - [x] 5.1 Instantiate `FrameworkDetector` in `backend/app/api/v1/ingest.py` alongside existing services
    - Call `detector.detect_with_llm_fallback(actual_repo_path, gemini_service)` before file processing loop
    - Wrap call in try/except; on failure log error and use `FrameworkResult("unknown", 0.0)`
    - Pass `framework` to `ServiceNode` constructor
    - Update `graph_service.upsert_service` Cypher query to `SET s.framework = $framework`
    - Populate `detected_framework` and `framework_confidence` in `IngestResponse`
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ]* 5.2 Write unit test for ingest endpoint with framework detection
    - Mock `FrameworkDetector.detect_with_llm_fallback` to return a known result
    - Assert `IngestResponse.detected_framework` and `IngestResponse.framework_confidence` are set correctly
    - Assert `ServiceNode.framework` is passed to the graph upsert
    - _Requirements: 4.1, 4.2, 4.4_

  - [ ]* 5.3 Write property test: P9 — IngestResponse always contains framework fields
    - **Property 9: IngestResponse always contains framework fields**
    - **Validates: Requirements 4.2**
    - Generate varied ingest payloads and assert both framework fields are present and non-null in every response

- [ ] 6. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Property tests use `hypothesis` with `@settings(max_examples=100)` minimum
- Each property test references its corresponding design document property number
- The `FrameworkDetector.detect()` method is synchronous (pure file I/O); only the LLM fallback wrapper is async
- The Gemini fallback gracefully degrades — the ingest pipeline never blocks on LLM availability
