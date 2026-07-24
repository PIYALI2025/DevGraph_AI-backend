# Design Document: Framework Detection

## Overview

The Framework Detection feature adds an automated capability to the DevGraph AI ingestion pipeline that identifies the backend framework used in a repository. When a repository is ingested via the `/ingest` endpoint, the `FrameworkDetector` service analyzes the repository's dependency files, configuration files, and directory structure to determine which of the seven supported frameworks — Express.js, Node.js, Next.js, NestJS, FastAPI, Django, Flask — is in use. It returns a structured `FrameworkResult` with the framework name and a confidence score. If file-based signals are weak (confidence < 0.5) and a Gemini API key is configured, it falls back to an LLM prompt for a best-effort inference.

---

## Architecture

```mermaid
flowchart TD
    A[POST /ingest] --> B[IngestEndpoint]
    B --> C[FrameworkDetector.detect(repo_path)]
    C --> D[Read package.json / requirements.txt / pyproject.toml / Pipfile / setup.py]
    D --> E{Score >= 0.5?}
    E -- Yes --> F[Return FrameworkResult]
    E -- No --> G{GEMINI_API_KEY set?}
    G -- No --> F
    G -- Yes --> H[GeminiService.infer_framework(file_list)]
    H --> F
    F --> I[IngestEndpoint stores framework on ServiceNode]
    I --> J[graph_service.upsert_service with framework property]
    I --> K[Return IngestResponse with framework fields]
```

The `FrameworkDetector` is a pure, synchronous service with no external I/O dependencies beyond filesystem reads. The Gemini fallback is async and isolated behind a guard so the core detection path has no network dependency.

---

## Components and Interfaces

### FrameworkResult (Data Model)

```python
@dataclass
class FrameworkResult:
    framework: str        # e.g. "fastapi", "express", "unknown"
    confidence: float     # 0.0 – 1.0
```

### FrameworkDetector (Service)

**Location**: `backend/app/services/framework_detector.py`

**Public interface**:

```python
class FrameworkDetector:
    def detect(self, repo_path: str) -> FrameworkResult:
        """
        Synchronous file-based framework detection.
        Reads dependency and config files at repo_path.
        Returns FrameworkResult with best-matching framework and confidence score.
        """

    async def detect_with_llm_fallback(
        self,
        repo_path: str,
        gemini_service: GeminiService
    ) -> FrameworkResult:
        """
        Runs file-based detection first.
        If confidence < 0.5 and GeminiService is available, invokes LLM fallback.
        """
```

### GeminiService extension

A new method `infer_framework` is added to the existing `GeminiService`:

```python
async def infer_framework(self, file_list: list[str]) -> str:
    """
    Given a list of filenames/paths from a repository, asks Gemini to infer
    the most likely backend framework. Returns a normalized framework name string.
    """
```

### IngestResponse (updated)

Two new fields are added to the existing `IngestResponse` Pydantic model:

```python
class IngestResponse(BaseModel):
    ...
    detected_framework: str         # e.g. "fastapi", "unknown"
    framework_confidence: float     # 0.0 – 1.0
```

### ServiceNode (updated)

The `ServiceNode` model and its graph upsert query gain a `framework` property:

```python
class ServiceNode(BaseModel):
    name: str
    repo_url: str
    framework: str = "unknown"
```

---

## Data Models

### Detection Indicator Registry

The detector uses a static registry mapping each framework to its indicators:

```python
FRAMEWORK_INDICATORS = {
    "express": {
        "primary": [("package.json", "dependencies.express")],
        "secondary": [],
    },
    "nextjs": {
        "primary": [("package.json", "dependencies.next")],
        "secondary": [("next.config.js", None), ("next.config.ts", None)],
    },
    "nestjs": {
        "primary": [("package.json", "dependencies.@nestjs/core")],
        "secondary": [("nest-cli.json", None)],
    },
    "nodejs": {
        "primary": [("package.json", None)],   # presence alone is a signal
        "secondary": [],
    },
    "fastapi": {
        "primary": [("requirements.txt", "fastapi"), ("pyproject.toml", "fastapi")],
        "secondary": [],
    },
    "django": {
        "primary": [("requirements.txt", "django"), ("pyproject.toml", "django")],
        "secondary": [("manage.py", None)],
    },
    "flask": {
        "primary": [("requirements.txt", "flask"), ("pyproject.toml", "flask"),
                    ("Pipfile", "flask"), ("setup.py", "flask")],
        "secondary": [],
    },
}
```

**Scoring rules**:
- Primary indicator found: +0.6
- Secondary indicator found: +0.2
- Final score capped at 1.0

### Confidence Score Accumulation

For each framework, the detector independently accumulates a score from its matching indicators, then selects the framework with the maximum score as the winner. If the winning score is 0.0, the result is `("unknown", 0.0)`.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Confidence invariant

*For any* repository path (real or mock), the `FrameworkResult` returned by `FrameworkDetector.detect()` SHALL have a `confidence` value in the closed interval `[0.0, 1.0]`.

**Validates: Requirements 1.2, 3.5**

---

### Property 2: Winner has maximum confidence

*For any* repository where multiple frameworks receive non-zero scores, the framework name returned in the `FrameworkResult` SHALL be the one with the strictly highest accumulated confidence score.

**Validates: Requirements 1.4**

---

### Property 3: JS dependency detection

*For any* `package.json` content that includes a known framework package (express, next, @nestjs/core) in `dependencies` or `devDependencies`, the detector SHALL return a `FrameworkResult` for the corresponding framework with confidence > 0.0.

**Validates: Requirements 2.1, 2.3**

---

### Property 4: Python dependency detection

*For any* `requirements.txt` or `pyproject.toml` content containing a known Python framework package name (fastapi, django, flask), the detector SHALL return a `FrameworkResult` for the corresponding framework with confidence > 0.0.

**Validates: Requirements 2.2**

---

### Property 5: Case-insensitive Python package matching

*For any* string that is a case variant of a supported Python package name (e.g. "Flask", "FLASK", "flask"), the detection result SHALL be the same framework regardless of the casing used in the dependency file.

**Validates: Requirements 2.4**

---

### Property 6: Monotonicity of confidence

*For any* repository mock, adding an additional valid indicator for a framework SHALL result in a confidence score greater than or equal to the score without that indicator.

**Validates: Requirements 3.1**

---

### Property 7: Primary indicator lower bound

*For any* repository containing exactly one primary indicator for a supported framework and no other indicators, the detected framework SHALL have a confidence score of exactly 0.6.

**Validates: Requirements 3.3**

---

### Property 8: LLM fallback is triggered when file-based score is below threshold

*For any* repository where file-based detection yields confidence < 0.5, `detect_with_llm_fallback` SHALL call `GeminiService.infer_framework` exactly once (when the key is configured).

**Validates: Requirements 5.1**

---

### Property 9: IngestResponse always contains framework fields

*For any* valid `IngestRequest`, the `IngestResponse` SHALL always contain non-null `detected_framework` and `framework_confidence` fields.

**Validates: Requirements 4.2**

---

## Error Handling

| Scenario | Behavior |
|---|---|
| `repo_path` does not exist | Detector returns `("unknown", 0.0)` without raising |
| `package.json` is malformed JSON | Log warning, skip file, continue with other indicators |
| Python dep file is unreadable | Log warning, skip file, continue |
| `GeminiService.infer_framework` raises | Log warning, retain file-based result |
| `GEMINI_API_KEY` is empty | Skip LLM fallback entirely |
| No indicators found anywhere | Return `FrameworkResult(framework="unknown", confidence=0.0)` |

All exceptions are caught at the boundary of each indicator check so that a single bad file never aborts the full detection run. The ingest endpoint also wraps the entire `detect_with_llm_fallback` call in a try/except so a total detector failure degrades gracefully to `"unknown"`.

---

## Testing Strategy

### Dual Testing Approach

Both **unit tests** and **property-based tests** are used:

- Unit tests verify concrete examples: each of the 7 frameworks is correctly identified from a representative fixture, config-file-only repos, malformed file handling, empty repo, and Gemini fallback scenarios.
- Property tests verify universal invariants across generated inputs: confidence range, winner selection, monotonicity, score bounds, case-insensitivity.

### Property-Based Testing Library

**Library**: `hypothesis` (Python)  
**Configuration**: minimum 100 examples per property (`@settings(max_examples=100)`)

### Property Test Annotations

Each property test is tagged with:

```
# Feature: framework-detection, Property N: <property_text>
```

### Test File Location

`backend/tests/test_framework_detector.py`

### Unit Test Coverage Targets

- `detect()` returns correct framework for each of the 7 supported frameworks (7 fixture-based examples)
- `detect()` returns `("unknown", 0.0)` for an empty directory
- `detect()` handles malformed `package.json` without raising
- `detect()` handles malformed `requirements.txt` without raising
- `detect_with_llm_fallback()` calls Gemini when score < 0.5
- `detect_with_llm_fallback()` skips Gemini when `GEMINI_API_KEY` is empty
- `detect_with_llm_fallback()` retains file-based result when Gemini raises
- Ingest endpoint response includes `detected_framework` and `framework_confidence`
- `ServiceNode` stored with `framework` property in Neo4j upsert query

### Property Test Coverage Targets (one test per property)

| Property | Test name |
|---|---|
| P1: Confidence invariant | `test_confidence_always_in_range` |
| P2: Winner has max confidence | `test_winner_has_max_confidence` |
| P3: JS dep detection | `test_js_dependency_detection` |
| P4: Python dep detection | `test_python_dependency_detection` |
| P5: Case-insensitive matching | `test_python_package_case_insensitive` |
| P6: Monotonicity | `test_confidence_monotonicity` |
| P7: Primary indicator lower bound | `test_primary_indicator_score_floor` |
| P8: LLM fallback triggered | `test_llm_fallback_triggered_below_threshold` |
| P9: IngestResponse fields always present | `test_ingest_response_has_framework_fields` |
