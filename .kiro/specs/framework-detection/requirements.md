# Requirements Document

## Introduction

This feature adds automatic framework detection capability to the DevGraph AI backend ingestion pipeline. When a user provides a repository path or URL, the system analyzes the repository's files and metadata to identify which backend framework(s) are in use — specifically: Express.js, Node.js, Next.js, NestJS, FastAPI, Django, and Flask. The detected framework is stored as a property on the Service node in the graph and returned in the ingest response, enabling downstream consumers (graph queries, AI analysis) to reason about the technology stack.

## Glossary

- **FrameworkDetector**: The service component responsible for analyzing repository files and returning a detected framework.
- **FrameworkResult**: A structured data object containing the detected framework name and a confidence score.
- **Service**: A repository-level graph node representing a codebase being ingested.
- **IngestRequest**: The API payload received by the `/ingest` endpoint.
- **IngestResponse**: The API response returned by the `/ingest` endpoint.
- **Indicator**: A file, directory name, or dependency entry used as evidence for framework detection.
- **Confidence Score**: A numeric value between 0.0 and 1.0 representing how certain the detector is about a framework match.
- **repo_path**: The local filesystem path to the cloned repository being ingested.

---

## Requirements

### Requirement 1: Detect Backend Frameworks from Repository Files

**User Story:** As a developer, I want the system to automatically detect the backend framework used in a repository, so that I can understand the technology stack without manually inspecting files.

#### Acceptance Criteria

1. WHEN a repository is ingested, THE FrameworkDetector SHALL analyze the repository's files to detect the presence of Express.js, Node.js, Next.js, NestJS, FastAPI, Django, or Flask.
2. WHEN framework detection completes, THE FrameworkDetector SHALL return a FrameworkResult containing the detected framework name and a confidence score between 0.0 and 1.0.
3. IF no supported framework is detected, THEN THE FrameworkDetector SHALL return a FrameworkResult with framework name "unknown" and confidence score 0.0.
4. WHEN multiple supported frameworks are detected, THE FrameworkDetector SHALL return the framework with the highest confidence score.
5. THE FrameworkDetector SHALL support detection for all seven frameworks: Express.js, Node.js, Next.js, NestJS, FastAPI, Django, Flask.

---

### Requirement 2: Use File-Based Indicators for Detection

**User Story:** As a developer, I want framework detection to use concrete file-based signals, so that the results are reliable and reproducible.

#### Acceptance Criteria

1. WHEN detecting Node.js-based frameworks (Express.js, Next.js, NestJS, Node.js), THE FrameworkDetector SHALL inspect `package.json` for dependency entries matching known framework package names.
2. WHEN detecting Python-based frameworks (FastAPI, Django, Flask), THE FrameworkDetector SHALL inspect `requirements.txt`, `Pipfile`, `pyproject.toml`, or `setup.py` for matching package names.
3. WHEN a `package.json` file is present, THE FrameworkDetector SHALL parse the `dependencies` and `devDependencies` fields for framework indicators.
4. WHEN a Python dependency file is present, THE FrameworkDetector SHALL scan its content for framework-specific package names using case-insensitive matching.
5. THE FrameworkDetector SHALL also inspect directory structure and configuration files (e.g., `manage.py` for Django, `next.config.js` for Next.js, `nest-cli.json` for NestJS) as secondary indicators.

---

### Requirement 3: Assign Confidence Scores to Detection Results

**User Story:** As a developer, I want each framework detection result to include a confidence score, so that I can understand how certain the system is about its findings.

#### Acceptance Criteria

1. THE FrameworkDetector SHALL assign a higher confidence score when multiple independent indicators for the same framework are found.
2. THE FrameworkDetector SHALL assign a lower confidence score when only a single weak indicator is found.
3. WHEN a primary indicator (dependency file entry) is found, THE FrameworkDetector SHALL contribute at least 0.6 to that framework's confidence score.
4. WHEN a secondary indicator (config file or directory) is found, THE FrameworkDetector SHALL contribute 0.2 to that framework's confidence score.
5. THE FrameworkDetector SHALL cap the final confidence score at 1.0.

---

### Requirement 4: Integrate Detection into Ingest Pipeline

**User Story:** As a developer, I want framework detection to run automatically during repository ingestion, so that no extra step is needed.

#### Acceptance Criteria

1. WHEN the `/ingest` endpoint processes a request with a `repo_path`, THE Ingest endpoint SHALL invoke the FrameworkDetector with that path before returning the response.
2. WHEN framework detection completes, THE Ingest endpoint SHALL include the detected framework name and confidence score in the IngestResponse.
3. IF framework detection fails due to an exception, THEN THE Ingest endpoint SHALL log the error and continue processing, returning "unknown" as the framework in the response.
4. WHEN the Service node is upserted to Neo4j, THE graph_service SHALL store the detected framework name as a property on the Service node.

---

### Requirement 5: Use LLM (Gemini) as a Fallback Detection Strategy

**User Story:** As a developer, I want the system to use an LLM when file-based indicators are insufficient, so that framework detection still produces a useful result even for unconventional repository layouts.

#### Acceptance Criteria

1. WHEN file-based detection produces a FrameworkResult with confidence score below 0.5, THE FrameworkDetector SHALL invoke the GeminiService with a prompt describing the repository's file list to infer the framework.
2. WHEN the GeminiService returns a framework name matching a supported framework, THE FrameworkDetector SHALL update the FrameworkResult with the LLM-inferred framework and a confidence score of 0.5.
3. IF the GeminiService is unavailable or returns an unrecognized framework name, THEN THE FrameworkDetector SHALL retain the file-based FrameworkResult without modification.
4. WHERE the `GEMINI_API_KEY` setting is empty, THE FrameworkDetector SHALL skip LLM-based detection entirely and rely solely on file-based indicators.

---

### Requirement 6: Handle Missing or Unreadable Dependency Files

**User Story:** As a developer, I want the system to handle incomplete or missing dependency files gracefully, so that ingestion does not fail on partial repositories.

#### Acceptance Criteria

1. IF a dependency file (e.g., `package.json`, `requirements.txt`) is missing, THEN THE FrameworkDetector SHALL skip that indicator without raising an exception.
2. IF a dependency file is present but contains malformed content, THEN THE FrameworkDetector SHALL log a warning and skip that file without propagating the error.
3. IF no files can be read at the given `repo_path`, THEN THE FrameworkDetector SHALL return a FrameworkResult with framework "unknown" and confidence 0.0.
4. THE FrameworkDetector SHALL complete detection within a bounded execution time regardless of repository size.
