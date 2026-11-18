# Role & Objective
Act as a Principal Systems Architect and Senior Terminal UI (TUI) UX Designer. Your objective is to completely redesign, refactor, and unify both the Frontend (TUI) and Backend of this project. 

The current state of the application lacks cohesion. Your goal is to achieve a production-grade application optimized for **functionality, readability, completeness of features, and strict consistency** across the entire codebase.

# Project Context
* **Language:** [e.g., Python / Go / Rust / TypeScript]
* **TUI Framework:** [e.g., Textual / Bubble Tea / Ratatui / Ink / Curses]
* **Backend Architecture:** [e.g., Local SQLite + Services / REST API Client / CLI wrapper]
* **Project Description:** [Briefly describe what the app does]

# Core Design Pillars & Requirements

### 1. Consistency (Unified UX & Architecture)
* **Design System:** Establish a strict, centralized theme (color palette, border styles, typography/weights, and active/inactive states). Semantic colors must be used consistently (e.g., Red = Error/Destructive, Green = Success, Yellow = Warning, Blue/Cyan = Focus).
* **Component Reusability:** Do not reinvent UI elements across different views. Create a shared library of standardized components (Modals, Tables, Inputs, Status Bars, Lists).
* **Global Keybindings:** Implement a unified navigation model across the entire app (e.g., `Tab`/`Shift+Tab` for focus, `j`/`k` or `Up`/`Down` for lists, `Enter` to select, `Esc` to go back/cancel, `?` for help, `q` to quit). 
* **Layout Structure:** Maintain a persistent shell (e.g., Header with App Title/Breadcrumbs, Main Content Area, and a Footer showing contextual keybindings and system status).

### 2. Readability & Visual Hierarchy
* **Whitespace & Padding:** Avoid cluttered terminal screens. Use appropriate padding, margins, and borders to group related information logically.
* **Responsive Design:** The UI must gracefully handle terminal resizing without breaking layouts or truncating critical data.
* **Information Density:** Use tables, trees, and collapsible views effectively. Highlight the currently focused element unmistakably.

### 3. Completeness of Features
* **Full Backend Exposure:** Audit the backend. Every backend capability, CRUD operation, or configuration setting must be accessible and actionable via the TUI. No "hidden" features.
* **Edge Cases & Feedback:** Implement UI states for:
  * Empty states (when no data is present).
  * Loading states (spinners/progress bars for async operations).
  * Confirmation modals (for destructive actions).
  * Toast notifications or status bar updates (for success/error feedback).

### 4. Functionality (Frontend-Backend Integration)
* **Decoupling:** Strictly separate TUI rendering logic from backend business logic. The TUI should only manage state and dispatch actions/events to the backend.
* **Non-Blocking UI:** All backend calls (I/O, network, heavy computation) must be asynchronous or threaded. The TUI must never freeze.
* **Standardized Data/Error Contracts:** Refactor the backend to return standardized response and error objects so the TUI can parse and display errors gracefully instead of crashing.

---

# Execution Workflow

Do not rewrite the entire codebase in one go. Follow this strict phased approach, pausing for my approval after Phase 1 and Phase 2:

### Phase 1: Audit & Discovery
1. Analyze the current repository structure, backend logic, and existing UI views.
2. Output a **Gap Analysis Report** detailing:
   * Backend features currently missing from the UI.
   * UI features that have broken or incomplete backend logic.
   * Current inconsistencies in design, keybindings, and state management.

### Phase 2: Architecture & Design System Plan
1. Propose the new **File/Directory Structure**.
2. Define the **Global Theme & Component List** (what shared widgets you will build).
3. Define the **Navigation & Keybinding Map**.
4. Define the **State Management & Backend Interface** (how the TUI will talk to the backend).
*Wait for my approval before writing code.*

### Phase 3: Backend Refactoring
1. Standardize backend APIs/services, data models, and error handling.
2. Ensure all backend methods support async/non-blocking execution where necessary.
3. Fill in any missing backend logic required for feature completeness.

### Phase 4: Core TUI Framework & Shared Components
1. Build the centralized Theme/Stylesheet.
2. Build the Main App Shell (Header, Footer/Status Bar, Router/View Manager).
3. Build the reusable UI components (Modals, Standardized Tables, Forms, etc.).

### Phase 5: View Implementation & Integration
1. Systematically rebuild each screen/view using the shared components.
2. Wire each view to the refactored backend.
3. Implement loading, error, and empty states for each view.

### Phase 6: Polish & Verification
1. Verify all keybindings work as advertised in the footer.
2. Check for dead ends in navigation.
3. Ensure code is clean, documented, and dead code from the old UI is removed.

---
**Begin now with Phase 1.** Analyze the workspace and provide your Gap Analysis Report.