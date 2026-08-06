# PieceMaker Brownfield Architecture Document

## Introduction

This document captures the **CURRENT STATE** of the PieceMaker Word Assistant codebase, including technical debt, architectural constraints, and real-world patterns. It serves as the primary reference for AI agents and developers working on the project, particularly for the planned architectural reorganization.

**Document Purpose:** Enable AI-driven refactoring and legal-focused development by documenting the actual architecture as it exists today.

### Document Scope

**PRIMARY FOCUS:** Architecture reorganization to address monolithic frontend (taskpane.js - 8,480 lines, 122 functions)

This documentation emphasizes:
- Current monolithic structure and its problems
- Word Add-in + MCP integration architecture (the complex association)
- Legal workflow features (research & drafting)
- Refactoring impact analysis and recommended structure

### Change Log

| Date       | Version | Description                         | Author   |
| ---------- | ------- | ----------------------------------- | -------- |
| 2026-01-21 | 1.0     | Initial brownfield analysis         | Winston  |

---

## Executive Summary

**Project:** PieceMaker Word Assistant
**Type:** Electron Desktop App + Microsoft Word Add-in + MCP Server
**Purpose:** Legal assistant for Word (research & drafting workflows)
**Primary Language:** JavaScript (Node.js)
**Total Codebase:** ~39,000 lines (excluding node_modules)

### Critical Architectural Issues

1. **MONOLITHIC FRONTEND** ⚠️ CRITICAL
   - `taskpane.js`: 338KB, 8,480 lines, 122 functions
   - Violates all modern frontend architecture principles
   - Difficult to maintain, test, or extend
   - Blocks AI agent development (exceeds context windows)

2. **No Architectural Documentation** (addressed by this document)
3. **Zero Test Coverage** (all .test files are from dependencies)
4. **Complex Add-in + MCP Integration** (requires deep understanding)
5. **Legal Data Security Compliance** (GDPR concerns not addressed)

### Strengths

✅ **Functional and Feature-Rich** - System is operational with extensive capabilities
✅ **Clear Domain Focus** - Well-designed legal workflows
✅ **Multiple AI Provider Support** - Claude, OpenAI, Mistral, Ollama
✅ **MCP Protocol Integration** - Modern architecture for AI tool access
✅ **Specific Version Pinning** - All dependencies have exact versions

---

## Quick Reference - Key Files and Entry Points

### Critical Files for Understanding the System

**Electron Application:**
- **Main Process:** `main.js` (1,045 lines) - Window management, server spawning, updates
- **Renderer Process:** `index.html` + `renderer.js` - Electron UI (startup screen)
- **Configuration:** `config.js` - Application configuration management

**Word Add-in (Core Application):**
- **Frontend Monolith:** `addon/taskpane.js` ⚠️ (8,480 lines, 122 functions) - **REFACTORING TARGET**
- **HTML Entry:** `addon/taskpane.html` - UI structure, modal definitions
- **Styles:** `addon/taskpane.css` (30KB) - All styling (no CSS framework)
- **Manifest:** `addon/manifest.xml` - Office Add-in configuration

**Backend Services:**
- **Main Server:** `addon/server.cjs` (4,323 lines) - Express.js REST API, 40+ endpoints
- **MCP Server:** `addon/mcp-server-local.js` (29KB) - MCP protocol implementation for Claude Desktop
- **Document Tools:** `addon/doc-tools.js` (58KB) - Word document manipulation utilities
- **Text Extraction:** `addon/extraction.js` (13KB) - PDF/DOCX text extraction
- **Ollama Analyzer:** `addon/ollama-analyzer.js` (9.5KB) - Local AI analysis
- **Markdown Converter:** `addon/word-markdown-converter.js` (8.8KB) - Word ↔ Markdown

**Build & Deployment:**
- **Package Definition:** `package.json` - Dependencies, scripts, electron-builder config
- **Build Scripts:** `build.sh`, `build.bat` - Platform-specific builds
- **Update Manager:** `UpdateManager.js` - Auto-update functionality

**Output & Data:**
- **File Storage:** `addon/output/` - Generated files, mappings, compilations
- **Certificates:** `*.crt`, `*.key` - HTTPS self-signed certificates

### Refactoring Target Areas

These files/modules will be affected by the architectural reorganization:

**Primary Target:**
- `addon/taskpane.js` - Must be split into modular components

**Dependencies to Preserve:**
- `addon/doc-tools.js` - Already reasonably modular
- `addon/server.cjs` - Backend API (minor refactoring may be needed)
- `addon/mcp-server-local.js` - MCP integration (stable, don't break)

**New Structure Needed:**
- `/addon/src/components/` - UI components
- `/addon/src/services/` - Business logic services
- `/addon/src/state/` - State management
- `/addon/src/utils/` - Shared utilities
- `/addon/src/legal/` - Legal workflow logic

---

## High Level Architecture

### Technical Summary

**Architecture Style:** Multi-Process Desktop Application
- **Electron Main Process:** Application lifecycle, native integration
- **Electron Renderer:** Startup/settings UI
- **Word Add-in:** Task pane application running in Word
- **Express Server:** REST API for add-in backend
- **MCP Server:** Stdio-based MCP protocol server for Claude Desktop
- **WebSocket:** Real-time communication between add-in and server

### System Context Diagram

```
┌──────────────────────────────────────────────────────────┐
│              PieceMaker Electron Application              │
│                                                            │
│  ┌─────────────────┐         ┌────────────────────────┐  │
│  │  Main Process   │ spawns  │   Express Server       │  │
│  │  (main.js)      │────────▶│   (server.cjs)         │  │
│  │                 │         │   Port: 43098 (HTTPS)  │  │
│  │ - Window mgmt   │         │   - 40+ REST endpoints │  │
│  │ - Auto-update   │         │   - WebSocket server   │  │
│  │ - Server spawn  │         │   - AI API proxies     │  │
│  └────────┬────────┘         └──────────┬─────────────┘  │
│           │                             │                 │
│           │ spawns                      │                 │
│           │                             │                 │
│  ┌────────▼────────┐                    │                 │
│  │  MCP Server     │                    │                 │
│  │  (stdio)        │                    │                 │
│  │                 │                    │                 │
│  │  Exposes Word   │                    │                 │
│  │  tools to       │                    │                 │
│  │  Claude Desktop │                    │                 │
│  └─────────────────┘                    │                 │
└──────────────────────────────────────────┼─────────────────┘
                                           │
                                           │ HTTPS/WSS
                                           │
                        ┌──────────────────▼──────────────────┐
                        │   Microsoft Word                     │
                        │                                      │
                        │   ┌────────────────────────────┐    │
                        │   │   PieceMaker Add-in        │    │
                        │   │   (Task Pane)              │    │
                        │   │                            │    │
                        │   │   taskpane.html            │    │
                        │   │   taskpane.js ⚠️ 8,480 L   │    │
                        │   │   - Chat UI                │    │
                        │   │   - Legal workflows        │    │
                        │   │   - Document tools         │    │
                        │   │   - Settings               │    │
                        │   └────────────────────────────┘    │
                        │                                      │
                        │   Office.js API                      │
                        │   (Word Document Manipulation)       │
                        └──────────────────────────────────────┘
                                           │
                        ┌──────────────────▼──────────────────┐
                        │   External Services                  │
                        │                                      │
                        │   - Claude API (Anthropic)           │
                        │   - OpenAI API                       │
                        │   - Mistral AI API                   │
                        │   - Ollama (Local)                   │
                        │   - MCP Remote Server                │
                        │     (festival-letino-app.com)        │
                        └──────────────────────────────────────┘
```

### Actual Tech Stack

| Category               | Technology                  | Version       | Notes                                    |
| ---------------------- | --------------------------- | ------------- | ---------------------------------------- |
| **Runtime**            | Electron                    | 27.0.0        | Main application framework               |
|                        | Node.js                     | (via Electron)| Backend JavaScript runtime               |
| **Frontend (Add-in)**  | Office.js                   | 1.1           | Microsoft Word API                       |
|                        | Vanilla JavaScript          | ES6+          | No framework (⚠️ technical debt)         |
|                        | HTML5 / CSS3                | -             | Direct DOM manipulation                  |
| **Backend**            | Express.js                  | 4.18.0        | REST API server                          |
|                        | ws (WebSocket)              | 8.14.0        | Real-time communication                  |
|                        | HTTPS (built-in)            | -             | Self-signed certificates                 |
| **AI Integration**     | @modelcontextprotocol/sdk   | 1.0.4         | MCP protocol implementation              |
|                        | Ollama                      | 0.6.3         | Local LLM integration                    |
| **Document Processing**| JSZip                       | 3.10.1        | ZIP/DOCX file handling                   |
|                        | Mammoth                     | 1.11.0        | DOCX to HTML/text conversion             |
|                        | pdf-lib                     | 1.17.1        | PDF manipulation                         |
|                        | pdfjs-dist                  | 5.4.449       | PDF text extraction                      |
| **Validation**         | Zod                         | 4.2.1         | Schema validation (MCP)                  |
|                        | zod-to-json-schema          | 3.25.1        | Zod → JSON Schema conversion             |
| **Build System**       | Webpack                     | 5.95.0        | Bundling (underutilized)                 |
|                        | Babel                       | 7.24.0        | JavaScript transpilation                 |
|                        | TypeScript                  | 5.4.2         | Type definitions only (no TS files)      |
|                        | electron-builder            | 24.6.0        | Application packaging                    |
| **Storage**            | electron-store              | 8.2.0         | Persistent settings storage              |
| **Development**        | webpack-dev-server          | 5.1.0         | Hot reload for development               |
|                        | office-addin-debugging      | 6.0.3         | Word add-in debugging tools              |

### Repository Structure Reality Check

- **Type:** Single repository (monorepo-style with separate concerns)
- **Package Manager:** npm
- **Notable Structure:**
  - Electron app at root (`main.js`, `renderer.js`, `index.html`)
  - Word add-in in `/addon` subfolder
  - No `/src` directory (flat structure)
  - Build artifacts in `/dist`
  - Configuration scattered (no centralized `/config`)

---

## Source Tree and Module Organization

### Project Structure (Actual)

```text
PieceMaker_Claude_CLI/
├── main.js                      # Electron main process (1,045 lines)
├── index.html                   # Electron renderer UI (startup screen)
├── renderer.js                  # Electron renderer logic
├── config.js                    # Application configuration
├── UpdateManager.js             # Auto-update functionality
├── package.json                 # Dependencies and build config
│
├── addon/                       # ⚠️ WORD ADD-IN - REFACTORING FOCUS
│   ├── manifest.xml             # Office Add-in manifest
│   ├── taskpane.html            # Add-in UI structure (337 lines)
│   ├── taskpane.css             # Add-in styles (30KB)
│   ├── taskpane.js              # ⚠️ MONOLITHIC UI LOGIC (8,480 lines, 338KB)
│   │                            # Contains: UI, state, business logic, API calls, chat, workflows
│   ├── server.cjs               # Express backend (4,323 lines)
│   ├── mcp-server-local.js      # MCP protocol server (29KB)
│   ├── doc-tools.js             # Word document utilities (58KB)
│   ├── extraction.js            # Text extraction (PDF/DOCX) (13KB)
│   ├── ollama-analyzer.js       # Ollama analysis (9.5KB)
│   ├── word-markdown-converter.js # Markdown conversion (8.8KB)
│   ├── commands.html            # Office commands placeholder
│   ├── output/                  # File storage (PDFs, mappings, compilations)
│   │   ├── [documentId]/        # Per-document storage
│   │   └── resources/           # Templates, guidelines
│   ├── assets/                  # Icons and images
│   └── node_modules → ../node_modules (symlink)
│
├── build/                       # Build resources (icons, entitlements)
├── dist/                        # Build output (Windows/Mac/Linux)
├── scripts/                     # Build and deployment scripts
├── web-bundles/                 # BMad agent bundles
├── .bmad-core/                  # BMad configuration and agents
│   ├── tasks/
│   ├── agents/
│   ├── templates/
│   └── core-config.yaml
├── .claude/                     # Claude Code configuration
└── node_modules/                # Dependencies
```

### The Monolithic Problem: taskpane.js Breakdown

**File:** `addon/taskpane.js` (8,480 lines, 338KB, 122 functions)

This single file contains **EVERYTHING** for the Word add-in frontend:

#### Current Responsibilities (All in One File):

**1. State Management (Global Variables)**
- `let ws = null` - WebSocket connection
- `let chatTabs = []` - Chat tab state
- `let activeTabId = null` - Active tab tracking
- `let isProcessing = false`, `let shouldStop = false` - Processing state
- Anonymization state, mapping state, workflow state, etc.

**2. UI Rendering & DOM Manipulation**
- Chat interface rendering
- Tab system implementation
- Modal management (10+ modals)
- Settings UI
- File list rendering
- Anonymization progress display

**3. Business Logic**
- Legal workflow orchestration (research, drafting)
- Anonymization logic
- Template management
- Document compilation
- Case file management

**4. API Communication**
- REST API calls to server.cjs (40+ endpoints)
- WebSocket event handling
- MCP Remote integration
- AI provider communication (Claude, OpenAI, Mistral, Ollama)

**5. Office.js Integration**
- Word document reading/writing
- Paragraph manipulation
- Track changes handling
- Footnote management

**6. Event Handling**
- Button clicks (20+ buttons)
- Modal open/close
- Tab switching
- File uploads
- Settings changes
- Keyboard shortcuts

**7. Workflow Management**
- Research workflow
- Drafting workflow
- Custom workflow editing
- Prompt management

**8. Legal-Specific Features**
- Document stamping (bordereau de pièces)
- Legal case file structure
- Party management (clients vs. adversaries)
- Legal template system

#### Function Count Analysis

**122 total functions**, including:
- UI helpers (30+)
- Modal management (15+)
- API calls (20+)
- Workflow handlers (10+)
- Chat system (15+)
- Settings (10+)
- Legal workflows (15+)
- Misc utilities (7+)

This is **unsustainable** and violates:
- Single Responsibility Principle (SRP)
- Separation of Concerns
- Modularity best practices
- Testability requirements
- AI agent context window limits

---

## Data Models and APIs

### Data Models

PieceMaker uses **file-based storage** (no database). Key data structures:

#### 1. Chat Tab Model (In-Memory)
```javascript
{
  id: number,
  type: 'dossier' | 'chat',
  llmProvider: string,  // 'claude', 'openai', 'mistral', 'ollama'
  llmModel: string,
  conversationHistory: array,
  chatContent: string  // HTML snapshot
}
```

#### 2. Anonymization Mapping (File-Based)
**Location:** `addon/output/[documentId]/anonymization-mapping.json`
```javascript
{
  documentId: string,
  parties: {
    clientes: [{ nom: string, prenoms: string }],
    adverses: [{ nom: string, prenoms: string }]
  },
  mappings: {
    "Original Text": "Anonymized Text"
  }
}
```

#### 3. Case File Structure (File-Based)
**Location:** `addon/output/[documentId]/pieces-[documentId].json`
```javascript
{
  id: string,
  date_document: string,
  type_document: string,
  filename: string,
  analyse: string,  // Legal analysis of the document
  content: string   // Extracted text
}
```

#### 4. Template Library (File-Based)
**Location:** `addon/output/resources/template-library-[templateName].json`
```javascript
{
  template_name: string,
  placeholders: {
    "{{PLACEHOLDER}}": {
      step: number,
      guideline: [string],
      validation: {
        enabled: boolean,
        rules: [{
          type: 'contains',
          patterns: [string],
          operator: 'OR' | 'AND',
          message: string
        }]
      }
    }
  }
}
```

#### 5. Workflow Guidelines (File-Based)
**Location:** `addon/output/resources/mcp-prompts-[workflow].json`
```javascript
{
  name: string,
  description: string,
  arguments: [{ name: string, description: string, required: boolean }]
}
```

### API Specifications

**Backend:** `addon/server.cjs` - Express.js REST API

#### API Endpoint Categories (40+ total)

**1. Configuration (3 endpoints)**
- `GET /api/mcp-config` - Get MCP configuration
- `GET /health` - Health check
- `OPTIONS *` - CORS preflight

**2. AI Provider Proxies (6 endpoints)**
- `POST /api/mcp` - MCP Remote proxy
- `POST /api/claude` - Claude API proxy
- `POST /api/openai` - OpenAI API proxy
- `POST /api/mistral` - Mistral AI proxy
- `POST /api/ollama` - Ollama proxy
- `GET /api/ollama/models` - List Ollama models

**3. Word Document Operations (4 endpoints)**
- `POST /api/word/edit` - Legacy edit endpoint
- `POST /api/word/read-doc` - Read Word document
- `POST /api/word/edit-doc` - Edit Word document
- `POST /api/word/search-case` - Search case files

**4. Anonymization (11 endpoints)**
- `POST /api/anonymize/process` - Start anonymization job
- `GET /api/anonymize/status/:jobId` - Get job status
- `GET /api/anonymize/jobs` - List all jobs
- `POST /api/anonymize/callback/:jobId` - Job completion callback
- `DELETE /api/anonymize/job/:jobId` - Delete job
- `POST /api/anonymize/text` - Anonymize text snippet
- `GET /api/anonymize/compilation/:documentId` - Get compilation
- `POST /api/anonymize/search/:documentId` - Search in compilation
- `GET /api/anonymize/document/:documentId/:itemId` - Get specific document
- `GET /api/anonymize/files/:documentId` - List files
- `DELETE /api/anonymize/files/:documentId` - Delete all files
- `GET /api/anonymize/mapping/:documentId` - Get mapping
- `PUT /api/anonymize/mapping/:documentId` - Update mapping
- `DELETE /api/anonymize/mapping/:documentId` - Delete mapping

**5. Ollama Analysis (2 endpoints)**
- `POST /api/ollama/analyze` - Analyze single document
- `POST /api/ollama/analyze-documents` - Batch analyze

**6. Legal Workflows (7 endpoints)**
- `POST /api/word/get-resource` - Get template resource
- `POST /api/word/draft-conclusions` - Draft legal document
- `POST /api/word/template-library` - Manage template library
- `POST /api/word/stamping` - Stamp documents (bordereau)
- `POST /api/word/call-ollama` - Trigger Ollama analysis
- `GET /api/resources` - List available resources
- `POST /api/save-compilation` - Save document compilation

**7. Tampon (Stamp) Configuration (3 endpoints)**
- `POST /api/tampon/save` - Save stamp image
- `GET /api/tampon/load` - Load stamp image
- `DELETE /api/tampon/delete` - Delete stamp

**8. Deprecated/Legacy (1 endpoint)**
- `POST /api/stamping` - Old stamping endpoint

#### MCP Server Tools (Exposed to Claude Desktop)

**File:** `addon/mcp-server-local.js`

MCP tools available via stdio transport:

1. **`read_doc`** - Read Word document with markdown formatting
2. **`edit_doc`** - Edit Word document (insert/delete operations)
3. **`read_case`** - Read legal case files and metadata
4. **`get_resource`** - Get templates and guidelines
5. **`draft`** - Legal drafting workflow
6. **`template_library`** - Manage template library
7. **`Stamping`** - Create stamped bordereau de pièces
8. **`Call_Ollama`** - Trigger Ollama analysis

All MCP tools are **proxied through WebSocket** to the Word add-in, which executes them using Office.js APIs.

---

## Technical Debt and Known Issues

### Critical Technical Debt

#### 1. Monolithic Frontend ⚠️ CRITICAL PRIORITY
**File:** `addon/taskpane.js` (8,480 lines)

**Problems:**
- Violates Single Responsibility Principle
- Difficult to test (no tests exist)
- Difficult to debug (complex state interactions)
- Difficult to extend (changes risk breaking unrelated features)
- Blocks AI agent development (exceeds LLM context windows)
- Poor developer onboarding (takes days to understand)
- No code splitting (338KB loaded on startup)

**Impact:** HIGH - This is the #1 blocker for maintainability and future development

**Recommended Fix:** Modular refactoring (see Refactoring Plan section below)

#### 2. No Test Coverage ⚠️ CRITICAL
**Current State:** 0 project tests (all `.test.js` files are from node_modules)

**Problems:**
- No safety net for refactoring
- Regressions are not caught
- Difficult to validate changes
- AI agents cannot verify their work

**Impact:** HIGH - Makes any code change high-risk

**Recommended Fix:**
- Set up Jest testing framework
- Write integration tests for critical paths
- Target 60% backend coverage, 40% frontend coverage

#### 3. No Structured Logging
**Current State:** `console.log()` statements scattered throughout

**Problems:**
- Difficult to debug production issues
- No log levels (debug, info, warn, error)
- No log aggregation or searchability
- Logs mixed with other console output

**Impact:** MEDIUM - Hampers debugging and monitoring

**Recommended Fix:** Implement Winston or Pino with structured logging

#### 4. File-Based Storage (No Database)
**Current State:** All data stored as JSON files in `addon/output/`

**Problems:**
- No transactional integrity
- No concurrent access control
- No query capabilities
- File corruption risk
- No backup/restore mechanism

**Impact:** MEDIUM - Works for small scale, problematic at scale

**Note:** May be acceptable for MVP, but consider SQLite for future

#### 5. Security & Compliance Gaps
**Problems:**
- API keys stored in electron-store (not encrypted)
- No data encryption at rest
- No GDPR compliance documentation
- No audit trails for legal document access
- Self-signed HTTPS certificates (development-only)

**Impact:** HIGH - Legal liability risk (handling client legal documents)

**Recommended Fix:** Security audit + compliance review

#### 6. Global State Management
**Current State:** Global variables in taskpane.js

**Problems:**
- State scattered across 100+ variables
- No single source of truth
- Difficult to track state changes
- Race conditions possible
- Cannot time-travel debug

**Impact:** MEDIUM-HIGH - Makes debugging and state management difficult

**Recommended Fix:** Implement centralized state management (Redux, Zustand, or Context API)

### Workarounds and Gotchas

#### Environment Variables
- **GOTCHA:** MCP configuration passed via `process.env` from main.js to server.cjs
- **Why:** Electron child processes don't inherit environment automatically
- **Code Location:** `main.js` lines 90-115

#### HTTPS Self-Signed Certificates
- **GOTCHA:** Must trust certificates manually on first run
- **Why:** Word add-ins require HTTPS, but we use localhost
- **Files:** `addon/localhost.crt`, `addon/localhost.key`, `addon/piecemaker-ca.crt`
- **Code Location:** `addon/server.cjs` lines 3900-3920

#### Office.js Async Patterns
- **GOTCHA:** All Office.js operations must use `Word.run(async (context) => { ... })`
- **Why:** Office.js uses batched execution model
- **Impact:** Cannot use normal async/await patterns directly
- **Code Location:** Throughout `addon/doc-tools.js`, `addon/taskpane.js`

#### WebSocket Reconnection
- **GOTCHA:** WebSocket connection must be manually reconnected on server restart
- **Code Location:** `addon/taskpane.js` lines 800-850 (WebSocket initialization)

#### BOM (Byte Order Mark) Handling
- **GOTCHA:** Windows creates BOM in UTF-8 files, must strip it
- **Why:** Causes JSON parsing errors
- **Code Location:** `addon/server.cjs` lines 36-48 (`stripBOM` function)

#### Word Numbering Removal
- **GOTCHA:** Word automatically adds numbering to headings, must be stripped for clean markdown
- **Code Location:** `addon/doc-tools.js` `removeWordNumbering()` function

#### Placeholder Validation
- **GOTCHA:** Template placeholders have complex validation rules that must be checked
- **Why:** Legal documents require specific content (e.g., footnotes for case law)
- **Code Location:** `addon/doc-tools.js` `validatePlaceholderContent()`

---

## Integration Points and External Dependencies

### External Services

| Service        | Purpose                    | Integration Type | Authentication         | Key Files                           |
| -------------- | -------------------------- | ---------------- | ---------------------- | ----------------------------------- |
| Claude API     | AI research & drafting     | REST API         | API Key (Bearer token) | `addon/server.cjs` `/api/claude`    |
| OpenAI API     | AI research & drafting     | REST API         | API Key (Bearer token) | `addon/server.cjs` `/api/openai`    |
| Mistral AI     | AI research & drafting     | REST API         | API Key (Bearer token) | `addon/server.cjs` `/api/mistral`   |
| Ollama         | Local AI analysis          | REST API         | None (localhost)       | `addon/server.cjs` `/api/ollama`    |
| MCP Remote     | Remote MCP tool hosting    | JSON-RPC/HTTP    | X-API-Key header       | `addon/server.cjs` `/api/mcp`       |
| Claude Desktop | MCP protocol client        | stdio (MCP)      | None (local process)   | `addon/mcp-server-local.js`         |

**External Service Endpoints:**
- **MCP Remote:** `https://mcp.festival-letino-app.com/mcp-remote/mcp`
- **Claude API:** `https://api.anthropic.com/v1/messages`
- **OpenAI API:** `https://api.openai.com/v1/chat/completions`
- **Mistral API:** `https://api.mistral.ai/v1/chat/completions`
- **Ollama:** `http://localhost:11434` (configurable)

### Internal Integration Points

#### 1. Electron ↔ Word Add-in Communication
**Pattern:** HTTPS REST API + WebSocket

```
Electron Main Process (main.js)
    ↓ spawns
Express Server (server.cjs) on port 43098
    ↓ HTTPS REST + WebSocket
Word Add-in (taskpane.js)
```

**Key Headers:**
- `Access-Control-Allow-Origin: *` (CORS enabled for localhost)
- `Content-Type: application/json`
- `X-API-Key: <mcp-api-key>` (for MCP Remote only)

#### 2. MCP Protocol Integration
**Pattern:** Stdio transport (stdin/stdout)

```
Claude Desktop
    ↓ stdio (MCP protocol)
MCP Server (mcp-server-local.js)
    ↓ HTTPS API calls
Express Server (server.cjs)
    ↓ WebSocket
Word Add-in (taskpane.js)
    ↓ Office.js
Word Document
```

**Tool Execution Flow:**
1. Claude Desktop sends MCP `tools/call` request via stdio
2. MCP server processes request, makes HTTPS call to server.cjs
3. Server broadcasts WebSocket message to connected add-in clients
4. Add-in executes Office.js operations
5. Result returned through WebSocket → HTTPS → stdio → Claude Desktop

**Critical Files:**
- `addon/mcp-server-local.js` - MCP protocol implementation
- `addon/server.cjs` - Proxy between MCP and Word add-in
- `addon/taskpane.js` - Office.js execution

#### 3. WebSocket Event System
**Connection:** `wss://localhost:43098`

**Events (Server → Client):**
- `message` - Chat messages from AI
- `mcpToolCall` - Execute MCP tool in Word
- `anonymizationProgress` - Anonymization job progress
- `statusUpdate` - General status updates

**Events (Client → Server):**
- `register` - Register as Word client
- `toolResponse` - MCP tool execution result
- `heartbeat` - Keep connection alive

**Code Location:** `addon/server.cjs` lines 3800-3900, `addon/taskpane.js` lines 800-900

#### 4. Office.js API Usage
**Pattern:** Batched execution with context

All Word document operations use:
```javascript
await Word.run(async (context) => {
  // Queue operations
  await context.sync(); // Execute batch
});
```

**Key Office.js Objects:**
- `context.document.body.paragraphs` - All document paragraphs
- `paragraph.style` - Heading styles
- `paragraph.getReviewedText()` - Get text with track changes applied
- `context.document.getComments()` - Document comments
- `paragraph.footnotes` - Footnote references

**Code Location:** `addon/doc-tools.js` (primary Office.js abstraction layer)

---

## Development and Deployment

### Local Development Setup

**Prerequisites:**
- Node.js 16.x or higher
- Microsoft Word (Windows or Mac)
- (Optional) Ollama for local AI

**Setup Steps:**

1. **Clone and Install:**
   ```bash
   git clone <repository>
   cd PieceMaker_Claude_CLI
   npm install
   ```

2. **Configure Settings:**
   - Launch application (it will create default config)
   - Open settings and configure:
     - AI provider API keys
     - MCP Remote API key (if using)
     - Ollama URL (if using local AI)

3. **Trust Self-Signed Certificates:**
   - **Windows:** Run `verify-files.js`
   - **Mac:** Run `verify.js`
   - Or manually trust `addon/piecemaker-ca.crt`

4. **Sideload Add-in into Word:**
   ```bash
   npm start  # Launches Electron app (starts servers)
   ```
   - Open Microsoft Word
   - Go to Insert → Get Add-ins → Upload My Add-in
   - Upload `addon/manifest.xml`
   - PieceMaker task pane appears in Word

5. **Development Workflow:**
   - Edit files in `addon/`
   - Refresh Word add-in (F5 or reload task pane)
   - Check console in Word Developer Tools (F12 in task pane)
   - Check server logs in Electron app console

**Known Setup Issues:**
- Certificate trust errors: Re-run certificate generation scripts
- Port 43098 already in use: Kill existing process
- Word doesn't load add-in: Clear Office cache (`~/Library/Containers/com.microsoft.Word/Data/` on Mac)

### Build and Deployment Process

**Build Commands:**

```bash
# Development build
npm start                    # Launch Electron app (no build)

# Production builds
npm run build                # Build for current platform
npm run build:win            # Windows (NSIS + portable)
npm run build:mac            # macOS (DMG + zip)
npm run build:all            # All platforms

# Signed builds (requires certificates)
npm run build:win-signed     # Windows with code signing
npm run build:mac-signed     # macOS with Apple Developer ID
```

**Build Configuration:** `package.json` → `build` section

**Output Directory:** `dist/`

**Build Artifacts:**
- **Windows:** `PieceMaker-Setup-{version}.exe`, `PieceMaker-{version}-Portable.exe`
- **Mac:** `PieceMaker-{version}.dmg`, `PieceMaker-{version}.zip`
- **Linux:** `.AppImage`, `.deb`, `.snap`

**Code Signing:**
- **Windows:** Requires `piecemaker-cert.pfx` with password "droit"
- **Mac:** Requires "PieceMaker Developer Certificate" in Keychain
- **Config:** `package.json` lines 110-154

**Deployment Environments:**
- **Development:** Local (`npm start`)
- **Production:** Standalone installer (electron-builder)
- **No staging/CI/CD:** Manual deployment only

**Update Mechanism:**
- Auto-update via `UpdateManager.js`
- Checks GitHub releases for new versions
- Downloads and installs updates automatically
- **Note:** Update server URL must be configured

---

## Testing Reality

### Current Test Coverage

**Unit Tests:** 0% (None exist)
**Integration Tests:** 0% (None exist)
**E2E Tests:** 0% (None exist)
**Manual Testing:** Primary QA method

**⚠️ CRITICAL:** All `.test.js` and `.spec.js` files found are from `node_modules` dependencies. The project itself has **zero tests**.

### Testing Challenges

1. **Office.js Mocking:** Difficult to mock Office.js APIs outside Word
2. **WebSocket Testing:** Real-time communication hard to test in isolation
3. **File System State:** Tests would need to manage `addon/output/` state
4. **AI API Mocking:** External AI APIs expensive to call in tests

### Recommended Testing Strategy

**Phase 1: Backend Unit Tests (Priority)**
- Test `addon/server.cjs` API endpoints
- Test `addon/doc-tools.js` utility functions
- Test `addon/mcp-server-local.js` MCP tool definitions
- Framework: Jest
- Target: 60% coverage

**Phase 2: Integration Tests**
- Test WebSocket communication
- Test MCP protocol flows
- Test file storage operations
- Framework: Jest + supertest
- Target: Critical paths covered

**Phase 3: Frontend Unit Tests**
- Test individual components (after refactoring)
- Test state management
- Test UI helpers
- Framework: Jest + jsdom or Vitest

**Phase 4: E2E Tests**
- Test full user workflows
- Test add-in within Word (Playwright for Office Add-ins)
- Test Electron app launch
- Framework: Spectron (Electron) or Playwright

**Blocked Until:** Refactoring completes (cannot test monolithic taskpane.js effectively)

---

## Refactoring Plan: Breaking Up the Monolith

### Problem Statement

`addon/taskpane.js` is 8,480 lines (338KB) with 122 functions, containing:
- UI rendering logic
- State management (global variables)
- Business logic (legal workflows)
- API communication
- Office.js integration
- Event handling
- Modal management

This violates modern architecture principles and blocks:
- Maintainability
- Testability
- AI agent development
- Team collaboration

### Recommended Modular Architecture

**New Directory Structure:**

```text
addon/
├── src/
│   ├── components/          # UI Components
│   │   ├── chat/
│   │   │   ├── ChatContainer.js
│   │   │   ├── ChatTabs.js
│   │   │   ├── ChatMessage.js
│   │   │   └── ChatInput.js
│   │   ├── legal/
│   │   │   ├── DossierPanel.js
│   │   │   ├── PartiesManager.js
│   │   │   ├── CaseFileList.js
│   │   │   └── StampingWorkflow.js
│   │   ├── modals/
│   │   │   ├── SettingsModal.js
│   │   │   ├── FilesModal.js
│   │   │   ├── WorkflowModal.js
│   │   │   ├── MappingModal.js
│   │   │   └── TamponModal.js
│   │   └── common/
│   │       ├── Button.js
│   │       ├── Select.js
│   │       └── FileUpload.js
│   │
│   ├── services/            # Business Logic
│   │   ├── api/
│   │   │   ├── aiService.js           # AI provider calls
│   │   │   ├── mcpService.js          # MCP communication
│   │   │   ├── documentService.js     # Document API calls
│   │   │   └── websocketService.js    # WebSocket management
│   │   ├── legal/
│   │   │   ├── anonymizationService.js
│   │   │   ├── templateService.js
│   │   │   ├── stampingService.js
│   │   │   └── workflowService.js
│   │   └── office/
│   │       ├── documentReader.js      # Word reading
│   │       ├── documentWriter.js      # Word writing
│   │       └── officeHelpers.js       # Office.js utilities
│   │
│   ├── state/               # State Management
│   │   ├── chatState.js     # Chat tabs, messages, history
│   │   ├── settingsState.js # User settings, API keys
│   │   ├── dossierState.js  # Legal case state
│   │   └── uiState.js       # Modal visibility, loading states
│   │
│   ├── utils/               # Shared Utilities
│   │   ├── dom.js           # DOM helpers
│   │   ├── validation.js    # Input validation
│   │   ├── formatting.js    # Text formatting
│   │   └── constants.js     # Constants and config
│   │
│   └── main.js              # Entry point (imports and initializes)
│
├── taskpane.html            # HTML structure (keep)
├── taskpane.css             # Styles (keep)
├── server.cjs               # Backend (keep)
├── mcp-server-local.js      # MCP server (keep)
├── doc-tools.js             # Document utilities (keep, maybe refactor)
├── extraction.js            # Text extraction (keep)
├── ollama-analyzer.js       # Ollama (keep)
└── word-markdown-converter.js # Converter (keep)
```

### Refactoring Strategy

**Approach:** Incremental refactoring (Strangler Fig pattern)
- Extract modules one at a time
- Keep old code working until new module is tested
- Gradually migrate functionality
- Use feature flags if needed

**Phase 1: Foundation (Week 1-2)**

1. **Set up build system:**
   - Configure Webpack for ES6 modules
   - Set up source maps
   - Configure development/production builds

2. **Create state management:**
   - Extract global variables to state modules
   - Implement simple state manager (or use Zustand/Redux)
   - Create getters/setters for state

3. **Extract WebSocket service:**
   - Move WebSocket logic to `services/api/websocketService.js`
   - Create clean API for WebSocket communication
   - Test WebSocket separately

**Phase 2: Services (Week 3-4)**

4. **Extract API services:**
   - `services/api/aiService.js` - AI provider calls
   - `services/api/mcpService.js` - MCP communication
   - `services/api/documentService.js` - Document API calls

5. **Extract Office.js services:**
   - `services/office/documentReader.js` - Reading operations
   - `services/office/documentWriter.js` - Writing operations
   - Move logic from `doc-tools.js` if appropriate

6. **Extract legal services:**
   - `services/legal/anonymizationService.js`
   - `services/legal/templateService.js`
   - `services/legal/workflowService.js`

**Phase 3: Components (Week 5-7)**

7. **Extract chat components:**
   - `components/chat/ChatContainer.js`
   - `components/chat/ChatTabs.js`
   - `components/chat/ChatMessage.js`
   - `components/chat/ChatInput.js`

8. **Extract modal components:**
   - `components/modals/SettingsModal.js` (complex - many fields)
   - `components/modals/FilesModal.js`
   - `components/modals/WorkflowModal.js`
   - Others...

9. **Extract legal components:**
   - `components/legal/DossierPanel.js`
   - `components/legal/PartiesManager.js`
   - `components/legal/CaseFileList.js`

**Phase 4: Integration & Testing (Week 8-9)**

10. **Update main.js:**
    - Import all modules
    - Initialize application
    - Wire up event handlers

11. **Write tests:**
    - Unit tests for services
    - Component tests for UI
    - Integration tests for workflows

12. **Performance optimization:**
    - Code splitting
    - Lazy loading for modals
    - Bundle size analysis

**Phase 5: Cleanup (Week 10)**

13. **Remove old code:**
    - Delete original `taskpane.js`
    - Update HTML imports
    - Clean up dead code

14. **Documentation:**
    - Update this architecture doc
    - Create component documentation
    - Document new patterns

### Migration Checklist

**For Each Module:**
- [ ] Extract to new file
- [ ] Create clean API/interface
- [ ] Update imports in other files
- [ ] Write unit tests
- [ ] Test in Word add-in
- [ ] Update documentation
- [ ] Mark old code as deprecated
- [ ] Remove old code after validation

### Expected Benefits After Refactoring

✅ **Maintainability:** Each module <500 lines, clear responsibilities
✅ **Testability:** Can unit test services and components independently
✅ **AI Agent Suitability:** Modules fit in LLM context windows
✅ **Developer Onboarding:** Clear structure, easier to understand
✅ **Performance:** Code splitting reduces initial load
✅ **Collaboration:** Multiple developers can work on different modules
✅ **Debugging:** Easier to isolate issues

### Risks and Mitigation

**Risk 1: Breaking Existing Functionality**
- **Mitigation:** Incremental refactoring, keep old code until tested
- **Mitigation:** Write integration tests before major changes

**Risk 2: WebSocket State Synchronization**
- **Mitigation:** Careful state management design
- **Mitigation:** Test WebSocket events thoroughly

**Risk 3: Office.js Async Complexity**
- **Mitigation:** Keep Office.js abstraction in services layer
- **Mitigation:** Don't break batching patterns

**Risk 4: Time Estimation Uncertainty**
- **Mitigation:** 10-week estimate is aggressive, plan for 12-14 weeks
- **Mitigation:** Prioritize critical paths first (chat, legal workflows)

---

## Legal Workflow Features (Domain Logic)

### Core Legal Workflows

PieceMaker is designed for legal professionals working in Word. The two primary workflows are:

#### 1. Research Workflow 🔍

**Purpose:** Legal research with AI assistance

**Steps:**
1. User asks legal question in chat
2. AI searches legal databases (via MCP tools if configured)
3. AI analyzes case law, statutes, jurisprudence
4. AI provides citations and references
5. User can insert findings into Word document

**Key Features:**
- Multi-tab chat interface (separate research conversations)
- Document upload for context (PDFs, DOCX)
- Legal citation formatting
- Footnote insertion for references
- Case file integration

**Code Location:**
- `addon/taskpane.js` - Research workflow UI and logic
- Workflow guidelines: `addon/output/resources/mcp-prompts-research.json`
- MCP tools: `addon/mcp-server-local.js` (if using Claude Desktop)

#### 2. Drafting Workflow ✏️

**Purpose:** AI-assisted legal document drafting

**Steps:**
1. User selects document type (assignment, conclusions, etc.)
2. System loads template with placeholders
3. AI fills placeholders based on case context
4. User reviews and edits
5. System validates required content (e.g., footnotes for case law)
6. Final document generated

**Key Features:**
- Template library system
- Placeholder management ({{PLACEHOLDER}})
- Validation rules (e.g., must contain footnotes)
- Step-by-step workflow
- Track changes integration

**Code Location:**
- `addon/taskpane.js` - Drafting workflow UI
- Template management: MCP tool `draft` and `template_library`
- Validation: `addon/doc-tools.js` `validatePlaceholderContent()`
- Guidelines: `addon/output/resources/mcp-prompts-drafting.json`

### Specialized Legal Features

#### 3. Anonymization 🔒

**Purpose:** Anonymize legal documents for data protection (GDPR)

**Process:**
1. User defines parties (clients vs. adversaries)
2. User uploads case files (PDFs, DOCX)
3. Ollama AI extracts entities (names, addresses, companies, emails, phones)
4. System generates anonymization mapping
5. User validates mapping
6. System creates anonymized compilation

**Entities Detected:**
- Persons (first name, last name)
- Companies (société)
- Addresses
- Emails
- Phone numbers
- Dates

**Code Location:**
- Frontend: `addon/taskpane.js` anonymization functions
- Backend: `addon/server.cjs` `/api/anonymize/*` endpoints
- Analysis: `addon/ollama-analyzer.js`
- Storage: `addon/output/[documentId]/`

#### 4. Document Stamping (Bordereau de Pièces) 🖼️

**Purpose:** Create stamped legal exhibits (French legal practice)

**Process:**
1. User uploads exhibit files (PDFs)
2. User configures stamp image
3. User orders exhibits
4. System stamps each file with "Pièce n°X"
5. System generates compilation PDF

**Code Location:**
- MCP tool: `Stamping` in `addon/mcp-server-local.js`
- Backend: `addon/server.cjs` `/api/word/stamping`
- Stamp config: `addon/server.cjs` `/api/tampon/*`

#### 5. Case File Management 📁

**Purpose:** Organize legal case documents with metadata

**Structure:**
```json
{
  "id": "0001",
  "date_document": "2025-03-12",
  "type_document": "Jugement",
  "filename": "jugement.pdf",
  "analyse": "Décision condamnant le défendeur...",
  "content": "Full extracted text..."
}
```

**Features:**
- Search case files (keyword, date range, exact match)
- Edit metadata (date, type, analysis)
- Automatic analysis via Ollama
- Read full document content

**Code Location:**
- MCP tool: `read_case` in `addon/mcp-server-local.js`
- Backend: `addon/server.cjs` `/api/word/search-case`
- Analysis: `addon/ollama-analyzer.js`

#### 6. Template Library System 📄

**Purpose:** Manage legal document templates with placeholders

**Template Structure:**
- DOCX template file with `{{PLACEHOLDERS}}`
- JSON configuration with guidelines and validation
- Step-by-step workflow for filling

**Placeholder Example:**
```json
{
  "{{FAITS}}": {
    "step": 1,
    "guideline": [
      "Résumé chronologique des faits",
      "Mentionner les dates importantes",
      "Citer les pièces justificatives"
    ],
    "validation": {
      "enabled": true,
      "rules": [{
        "type": "contains",
        "patterns": ["[^footnote:"],
        "operator": "OR",
        "message": "Les faits doivent contenir des références aux pièces"
      }]
    }
  }
}
```

**Code Location:**
- MCP tools: `draft`, `template_library`
- Backend: `addon/server.cjs` `/api/word/draft-conclusions`, `/api/word/template-library`
- Frontend: Workflow modal in `addon/taskpane.js`

---

## MCP Integration Deep Dive

### What is MCP?

**MCP (Model Context Protocol)** is an open protocol for AI assistants to access tools and resources. PieceMaker implements MCP to enable Claude Desktop to interact with Word documents.

### MCP Architecture in PieceMaker

```
┌──────────────────────────────────────────────┐
│          Claude Desktop                       │
│          (MCP Client)                         │
└────────────────┬─────────────────────────────┘
                 │ stdio (stdin/stdout)
                 │ JSON-RPC messages
┌────────────────▼─────────────────────────────┐
│     addon/mcp-server-local.js                 │
│     (MCP Server via @modelcontextprotocol/sdk)│
│                                                │
│  - Exposes 8 tools (read_doc, edit_doc, etc.) │
│  - Handles MCP protocol (tools/list, etc.)    │
│  - Proxies requests to Word add-in            │
└────────────────┬─────────────────────────────┘
                 │ HTTPS POST
                 │ https://localhost:43098/api/word/*
┌────────────────▼─────────────────────────────┐
│     addon/server.cjs                          │
│     (Express REST API)                        │
│                                                │
│  - Receives MCP tool requests                 │
│  - Broadcasts via WebSocket to Word clients   │
└────────────────┬─────────────────────────────┘
                 │ WebSocket (wss://)
                 │ Event: mcpToolCall
┌────────────────▼─────────────────────────────┐
│     addon/taskpane.js                         │
│     (Word Add-in Frontend)                    │
│                                                │
│  - Receives WebSocket event                   │
│  - Executes Office.js operations              │
│  - Returns result via WebSocket               │
└────────────────┬─────────────────────────────┘
                 │ Office.js API
┌────────────────▼─────────────────────────────┐
│          Microsoft Word Document              │
└──────────────────────────────────────────────┘
```

### MCP Tool Execution Flow (Example: read_doc)

1. **Claude Desktop:** User asks "Read the Word document"
2. **Claude Desktop:** Calls MCP tool `read_doc` via stdio JSON-RPC
   ```json
   {
     "jsonrpc": "2.0",
     "method": "tools/call",
     "params": {
       "name": "read_doc",
       "arguments": {}
     }
   }
   ```
3. **mcp-server-local.js:** Receives request, validates with Zod schema
4. **mcp-server-local.js:** Makes HTTPS POST to `https://localhost:43098/api/word/read-doc`
5. **server.cjs:** Receives POST, broadcasts WebSocket event:
   ```javascript
   ws.send(JSON.stringify({
     type: 'mcpToolCall',
     tool: 'read_doc',
     params: {}
   }));
   ```
6. **taskpane.js:** WebSocket event handler receives `mcpToolCall`
7. **taskpane.js:** Calls `readDoc()` function (Office.js)
   ```javascript
   await Word.run(async (context) => {
     const body = context.document.body;
     const paragraphs = body.paragraphs;
     paragraphs.load('text,style');
     await context.sync();
     // Format as markdown...
   });
   ```
8. **taskpane.js:** Returns result via WebSocket to server
9. **server.cjs:** Returns HTTPS response to mcp-server-local.js
10. **mcp-server-local.js:** Returns MCP result to Claude Desktop via stdio
11. **Claude Desktop:** Receives markdown document content

**Total Latency:** ~500ms-2s depending on document size

### MCP Tools Available

| Tool              | Purpose                          | Input                       | Output                  |
| ----------------- | -------------------------------- | --------------------------- | ----------------------- |
| `read_doc`        | Read Word document as markdown   | list_headings, heading, indexes | Markdown text with indexes |
| `edit_doc`        | Edit Word document               | operation, target_index, text | Success status          |
| `read_case`       | Read legal case files            | query, search_mode          | Case file list/content  |
| `get_resource`    | Get templates/guidelines         | filename, action            | Resource content        |
| `draft`           | Legal drafting workflow          | action, placeholder, content | Drafting status         |
| `template_library`| Manage template library          | action, template_name       | Template info           |
| `Stamping`        | Stamp legal exhibits             | pieces (array of IDs)       | Stamped PDF             |
| `Call_Ollama`     | Trigger Ollama analysis          | (none)                      | Analysis trigger status |

### MCP Remote Integration

**Purpose:** Access remote MCP tools hosted on festival-letino-app.com

**Flow:**
```
taskpane.js → server.cjs /api/mcp → MCP Remote Server
```

**Authentication:** X-API-Key header (configured in settings)

**Use Case:** Access legal databases, jurisprudence search, or other centralized legal tools

**Code Location:** `addon/server.cjs` lines 89-150 (`/api/mcp` proxy endpoint)

---

## Appendix - Useful Commands and Scripts

### Frequently Used Commands

```bash
# Development
npm start                    # Launch Electron app (dev mode)
npm run dev                  # Same as npm start

# Building
npm run build                # Build for current platform
npm run build:win            # Windows installers
npm run build:mac            # macOS DMG/zip
npm run build:all            # All platforms

# Testing (not configured yet)
npm test                     # Would run tests (none exist)

# Linting (not configured)
npm run lint                 # Would run linter (not configured)
```

### Certificate Management

```bash
# Generate new certificates (Mac/Linux)
./create-certificate.sh

# Generate new certificates (Windows PowerShell)
.\create-certificate-windows.ps1

# Verify certificates
node verify.js              # Mac
node verify-files.js        # Windows
```

### Word Add-in Development

```bash
# Sideload add-in (manual)
# 1. npm start
# 2. Word → Insert → Get Add-ins → Upload My Add-in
# 3. Select addon/manifest.xml

# Clear Office cache (Mac)
rm -rf ~/Library/Containers/com.microsoft.Word/Data/

# Clear Office cache (Windows)
# Delete: C:\Users\<username>\AppData\Local\Microsoft\Office\16.0\Wef\
```

### Debugging and Troubleshooting

**Check server logs:**
```bash
# Electron console shows server.cjs logs
# Look for errors starting with [SERVER] or [MCP]
```

**Debug Word add-in:**
```
1. Right-click in task pane
2. Select "Inspect" (opens DevTools)
3. Check Console for JavaScript errors
4. Check Network tab for API calls
```

**WebSocket connection issues:**
```bash
# Check if server is running
curl -k https://localhost:43098/health

# Check WebSocket connection (in browser console)
const ws = new WebSocket('wss://localhost:43098');
ws.onopen = () => console.log('Connected');
ws.onerror = (e) => console.error('Error', e);
```

**Common Issues:**

| Issue | Solution |
|-------|----------|
| "Add-in won't load" | Clear Office cache, restart Word |
| "Certificate error" | Re-run certificate generation script, trust CA |
| "Port 43098 in use" | Kill process: `lsof -ti:43098 \| xargs kill -9` |
| "WebSocket won't connect" | Check HTTPS server is running, check firewall |
| "MCP tools not working" | Check mcp-server-local.js is running, check stdio logs |
| "AI API errors" | Verify API keys in settings, check network |

---

## AI Agent Development Guidelines

### For Legal-Focused AI Agents

PieceMaker is designed for AI agents working on **legal research, analysis, and drafting** tasks. When developing with AI agents:

**DO:**
- ✅ Focus on legal domain logic (research, drafting workflows)
- ✅ Preserve legal citation formatting
- ✅ Maintain document structure (headings, footnotes)
- ✅ Use MCP tools when available (read_doc, edit_doc, draft)
- ✅ Test with real legal documents (anonymized)
- ✅ Validate placeholder content (legal documents have requirements)
- ✅ Use structured legal templates

**DON'T:**
- ❌ Modify Office.js batching patterns (will break)
- ❌ Break WebSocket event flow (critical for MCP)
- ❌ Skip validation rules (legal documents need citations, etc.)
- ❌ Remove track changes (lawyers need audit trails)
- ❌ Simplify legal workflows without domain expert review

### AI Agent Context Limitations

**Current Problem:** `taskpane.js` (8,480 lines) exceeds most LLM context windows

**Workarounds (Pre-Refactoring):**
1. Focus agents on specific functions (extract relevant code)
2. Use `doc-tools.js` for Office.js operations (more modular)
3. Work on backend (`server.cjs`) or MCP server instead
4. Wait for refactoring to complete

**Post-Refactoring:** Each module will be <500 lines, suitable for AI agents

### Recommended AI Agent Workflows

**1. Legal Research Enhancement:**
- Agent reads user question
- Agent searches case law (MCP tool: read_case)
- Agent drafts response with citations
- Agent inserts into Word (MCP tool: edit_doc)

**2. Legal Drafting Assistance:**
- Agent loads template (MCP tool: draft, action: check_template)
- Agent fills placeholders step-by-step
- Agent validates content (must have footnotes, etc.)
- Agent finalizes document

**3. Document Analysis:**
- Agent reads Word document (MCP tool: read_doc)
- Agent extracts key information
- Agent generates summary or analysis
- Agent can insert findings back into document

---

## Conclusion

This brownfield architecture document captures the **actual state** of PieceMaker as of January 21, 2026. The system is **functional and feature-rich** but suffers from critical architectural debt, particularly the monolithic `taskpane.js` file.

### Immediate Next Steps

1. **Use this document** as the source of truth for architecture
2. **Begin refactoring** using the plan in "Refactoring Plan" section
3. **Set up testing** framework (Jest) before major changes
4. **Security audit** for legal data compliance (GDPR)
5. **Incremental migration** - don't attempt big-bang rewrite

### Success Metrics

The refactoring will be considered successful when:
- ✅ All modules are <500 lines
- ✅ AI agents can work on individual modules
- ✅ 60% test coverage achieved
- ✅ No functionality lost
- ✅ Performance improved (code splitting)
- ✅ Developer onboarding time reduced from days to hours

---

**Document Status:** Living document - update as architecture evolves
**Maintained By:** Architecture team / AI agents
**Last Updated:** 2026-01-21
**Next Review:** After Phase 1 refactoring completion
