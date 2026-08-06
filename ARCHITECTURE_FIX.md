# Architecture Fix: doc-tools.js Integration

## Before Integration (BROKEN ❌)

```
┌─────────────────────────────────────────────────────────┐
│  Claude Desktop                                          │
└────────────────┬────────────────────────────────────────┘
                 │ MCP Protocol (stdio)
                 │ tools/call: read_doc
┌────────────────▼────────────────────────────────────────┐
│  mcp-server-local.js                                     │
│  - Receives MCP request                                  │
│  - Validates with Zod                                    │
└────────────────┬────────────────────────────────────────┘
                 │ HTTPS POST
                 │ https://localhost:43098/api/word/read-doc
┌────────────────▼────────────────────────────────────────┐
│  server.cjs (Express)                                    │
│  - POST /api/word/read-doc handler                       │
│  - Broadcasts via WebSocket                              │
└────────────────┬────────────────────────────────────────┘
                 │ WebSocket message
                 │ { requestId, action: 'read_doc', params }
┌────────────────▼────────────────────────────────────────┐
│  taskpane.js                                             │
│  - ws.onmessage receives event                           │
│  - Calls handleToolRequest('read_doc', params)           │
│                                                           │
│  handleToolRequest() {                                   │
│    case 'read_doc':                                      │
│      markDocRead();        ❌ UNDEFINED!                 │
│      return await readDoc(params);  ❌ UNDEFINED!        │
│  }                                                        │
└──────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  doc-tools.js (ORPHANED, NEVER CALLED)                   │
│  - export function readDoc() { ... } ⚠️                  │
│  - export function editDoc() { ... } ⚠️                  │
│  - export function markDocRead() { ... } ⚠️              │
└──────────────────────────────────────────────────────────┘

Result: ReferenceError: readDoc is not defined
```

---

## After Integration (FIXED ✅)

```
┌─────────────────────────────────────────────────────────┐
│  Claude Desktop                                          │
└────────────────┬────────────────────────────────────────┘
                 │ MCP Protocol (stdio)
                 │ tools/call: read_doc
┌────────────────▼────────────────────────────────────────┐
│  mcp-server-local.js                                     │
│  - Receives MCP request                                  │
│  - Validates with Zod                                    │
└────────────────┬────────────────────────────────────────┘
                 │ HTTPS POST
                 │ https://localhost:43098/api/word/read-doc
┌────────────────▼────────────────────────────────────────┐
│  server.cjs (Express)                                    │
│  - POST /api/word/read-doc handler                       │
│  - Broadcasts via WebSocket                              │
└────────────────┬────────────────────────────────────────┘
                 │ WebSocket message
                 │ { requestId, action: 'read_doc', params }
┌────────────────▼────────────────────────────────────────┐
│  taskpane.js                                             │
│  - IMPORTS: import { readDoc, editDoc } from             │
│             './modules/doc-tools.js'                     │
│                                                           │
│  - INITIALIZATION: initDocToolsDependencies({            │
│      anonymizeText: ...,                                 │
│      draftConclusionsState: ...                          │
│    })                                                     │
│                                                           │
│  - ws.onmessage receives event                           │
│  - Calls handleToolRequest('read_doc', params)           │
│                                                           │
│  handleToolRequest() {                                   │
│    case 'read_doc':                                      │
│      markDocRead();        ✅ IMPORTED from doc-tools    │
│      return await readDoc(params);  ✅ IMPORTED          │
│  }                                                        │
└────────────────┬────────────────────────────────────────┘
                 │ Function call
                 │ readDoc(params)
┌────────────────▼────────────────────────────────────────┐
│  doc-tools.js (NOW INTEGRATED ✅)                        │
│  - export function readDoc(params) {                     │
│      await Word.run(async (context) => {                 │
│        // Read document with Office.js                   │
│        // Apply anonymization if needed                  │
│        // Return markdown                                │
│      });                                                  │
│    }                                                      │
│  - Uses deps.anonymizeText for privacy                   │
│  - Uses deps.draftConclusionsState for templates         │
└────────────────┬────────────────────────────────────────┘
                 │ Office.js API
┌────────────────▼────────────────────────────────────────┐
│  Microsoft Word Document                                 │
│  - Read paragraphs                                       │
│  - Get styles, formatting, footnotes                     │
│  - Return as Markdown                                    │
└──────────────────────────────────────────────────────────┘

Result: ✅ Document read successfully, anonymized if needed
```

---

## Key Changes

| Component | Before | After |
|-----------|--------|-------|
| **taskpane.js imports** | ❌ No doc-tools import | ✅ Imports readDoc, editDoc, etc. |
| **doc-tools initialization** | ❌ Never initialized | ✅ Dependencies injected via initDocToolsDependencies() |
| **handleToolRequest()** | ❌ Calls undefined readDoc() | ✅ Calls imported readDoc() |
| **Anonymization** | ❌ Not working in doc-tools | ✅ Works via deps.anonymizeText |
| **Template state** | ❌ Not accessible in doc-tools | ✅ Works via deps.draftConclusionsState |

---

## Data Flow: Read Document with Anonymization

### Step-by-Step Flow

1. **User asks Claude Desktop**: "Read the Word document"

2. **Claude Desktop**: Sends MCP `tools/call` request via stdio

3. **mcp-server-local.js**:
   - Receives request
   - Validates parameters with Zod
   - Makes HTTPS POST to server.cjs

4. **server.cjs**:
   - Receives POST on `/api/word/read-doc`
   - Broadcasts WebSocket message to all Word clients

5. **taskpane.js**:
   - `ws.onmessage` receives event
   - Parses: `{ requestId: "123", action: "read_doc", params: {} }`
   - Calls: `handleToolRequest("read_doc", {})`

6. **handleToolRequest()**:
   - Calls: `markDocRead()` ← imported from doc-tools.js ✅
   - Calls: `readDoc({})` ← imported from doc-tools.js ✅

7. **doc-tools.js → readDoc()**:
   - Calls: `Word.run(async (context) => { ... })`
   - Reads all paragraphs via Office.js
   - Formats as Markdown with indexes
   - Calls: `deps.anonymizeText(text, 'anonymize')` ← provided by taskpane.js
   - Returns anonymized Markdown

8. **taskpane.js**:
   - Receives result from `readDoc()`
   - Sends WebSocket message back: `{ requestId: "123", result: "..." }`

9. **server.cjs**:
   - Receives WebSocket response
   - Returns HTTPS response to mcp-server-local.js

10. **mcp-server-local.js**:
    - Receives HTTPS response
    - Formats as MCP result
    - Sends to Claude Desktop via stdio

11. **Claude Desktop**:
    - Receives document content
    - Displays to user or processes with AI

---

## Anonymization Flow Detail

When `readDoc()` is called with an active anonymization mapping:

```javascript
// IN taskpane.js (initialization)
initDocToolsDependencies({
    anonymizeText: async (text, mode) => {
        // Access taskpane.js variables
        const mapping = anonymization.mapping;

        if (mode === 'anonymize') {
            // Replace real names with "Partie A", "Partie B"
            for (const [original, anonymized] of Object.entries(mapping)) {
                text = text.replace(new RegExp(original, 'g'), anonymized);
            }
        }

        return text;
    }
});

// IN doc-tools.js → readDoc()
async function readDoc(params) {
    await Word.run(async (context) => {
        // ... read document ...
        const documentText = "M. Jean Dupont a signé le contrat.";

        // Apply anonymization before returning
        const anonymizedText = await deps.anonymizeText(
            documentText,
            'anonymize'
        );

        // Returns: "Partie A a signé le contrat."
        return anonymizedText;
    });
}
```

**Why this works**:
- `deps.anonymizeText` is a **closure** that captures `anonymization.mapping` from taskpane.js
- `doc-tools.js` doesn't need to know about taskpane.js internals
- Clean separation of concerns

---

## Template State Flow Detail

When using the drafting workflow:

```javascript
// IN taskpane.js (state)
const draftConclusionsState = {
    templateInjected: true,
    templateName: "01 - Modèle Assignation.docx",
    placeholdersProvided: {
        "FAITS": true,
        "PRETENTIONS": true
    }
};

// IN taskpane.js (initialization)
initDocToolsDependencies({
    get draftConclusionsState() {
        return draftConclusionsState; // Returns live reference
    }
});

// IN doc-tools.js → validatePlaceholderContent()
async function validatePlaceholderContent(placeholderName, content) {
    const draftState = deps?.draftConclusionsState;

    if (draftState && draftState.templateInjected) {
        const templateName = draftState.templateName; // "01 - Modèle..."
        const guidelinesFile = templateName.replace('.docx', '.json');

        // Fetch validation rules from template JSON
        const response = await fetch(`/api/resources/${guidelinesFile}`);
        // ... validate content against rules ...
    }
}
```

**Why this works**:
- Getter function returns **live reference** to state
- Changes in taskpane.js are immediately visible in doc-tools.js
- No need for explicit state synchronization

---

## Benefits of This Integration

### 1. **Modularity** ✅
- Office.js code centralized in `doc-tools.js`
- Easier to test, maintain, and understand
- Clear separation: taskpane.js = UI, doc-tools.js = Word operations

### 2. **Anonymization** ✅
- LLM receives anonymized text automatically
- Privacy protection for sensitive legal documents
- No changes needed in MCP server or Claude Desktop

### 3. **Template Validation** ✅
- Legal documents can enforce content rules
- Example: "FAITS section must contain footnotes"
- Prevents incomplete legal documents

### 4. **Maintainability** ✅
- Single source of truth for Word operations
- Future refactoring easier (already partially done)
- Aligns with architecture document goals

### 5. **AI Agent Compatibility** ✅
- `doc-tools.js` is small enough to fit in LLM context (58KB)
- AI agents can understand and modify it
- `taskpane.js` remains large, but this is a step toward refactoring

---

## Common Questions

### Q: Why not import doc-tools.js directly in mcp-server-local.js?
**A**: Because `doc-tools.js` depends on:
- Office.js (browser API, not available in Node.js)
- `Word.run()` context (only exists inside Word add-in)
- Browser ES6 modules (Node.js would need different syntax)

It **must** run in the Word task pane (browser context).

---

### Q: Why have both `localTools.read_doc()` and imported `readDoc()`?
**A**: Legacy code. `localTools.read_doc()` makes a fetch call, creating a circular loop. The imported `readDoc()` directly executes Office.js. Eventually, `localTools` should be refactored to use imported functions.

---

### Q: What if anonymization.mapping is empty?
**A**: The anonymizeText function checks and returns original text:
```javascript
if (!anonymization.mapping || Object.keys(anonymization.mapping).length === 0) {
    return text; // No anonymization
}
```

---

### Q: Can I skip the initialization step?
**A**: No. Without `initDocToolsDependencies()`, `deps` will be `null` in doc-tools.js, and:
- Anonymization will silently fail (returns unanonymized text)
- Template validation won't work (can't access draftConclusionsState)

---

## Next Steps

After this integration is complete:

1. ✅ **Test thoroughly** with Claude Desktop MCP tools
2. ⏭️ Refactor `localTools` to use imported doc-tools functions
3. ⏭️ Continue breaking up `taskpane.js` monolith (see docs/architecture.md)
4. ⏭️ Add tests for doc-tools integration
5. ⏭️ Consider TypeScript for better type safety

---

**Document Status**: Ready for implementation
**Complexity**: Low (3 code additions)
**Risk**: Low (additive changes only)
**Impact**: High (unblocks MCP functionality)
