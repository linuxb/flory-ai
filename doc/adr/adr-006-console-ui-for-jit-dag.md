# ADR-006: Console UI for JIT-DAG Visualization and Monitoring

## Status
Proposed

## Context
Flory orchestrates dynamic, JIT-generated DAGs where vertices (Planners, Tool Callers, and Routers) are appended progressively based on runtime execution. As workflows increase in complexity (e.g., nesting planners, evaluating conditional router policies, and executing distributed transactions), it becomes impossible to debug or monitor the system solely by reading the raw append-only `event_log`.

We need a dedicated Console UI to visualize these workflows in real-time. The goal is to provide operators and developers with a clear, interactive visual representation of the DAG, deeply integrated with Flory’s transaction safety and replay mechanics.

## Proposed Decision
Design and implement the **Flory Console**, a web-based UI inspired by the design language of GCP's Vertex AI Model Garden. The console will adopt a Google Material Design layout that **must support automatic light/dark theme adaptability**, aligning with the repository's convention for diagrams.

*(Note: Upon acceptance of this ADR, this style guideline and the mockup image below will be merged into an authoritative design document to prevent the asset from becoming an orphan.)*

![Flory Console Mockup](../ui-mockups/flory_dag_console.jpg)

### 1. Interactive JIT-DAG Canvas (Main View)
- **Vertex AI Node Styling:** Vertices will be rendered as Material Design cards. Each card will feature a left-edge color indicator (e.g., Green for Success, Amber for Running, Red for Failed) and standard GCP material icons denoting the node type (Planner, Tool, Router).
- **Dynamic JIT Expansion:** The canvas dynamically "grows" in real-time. When the TypeScript Engine appends `subgraph/frozen` to the event log, the corresponding parent node on the canvas visually unfolds its subsequent branches with smooth layout animations, natively supporting progressive disclosure.
- **Transaction Scope Boundaries:** The canvas uses subtle background dash-boxes or vertical division lines (adapting their neutral ink to the current theme) to explicitly demarcate `txn/pivot-passed` boundaries. 
- **Canvas Controls:** Includes standard Vertex AI pipeline controls (Zoom in/out, Pan, Fit-to-screen, and a collapsible Mini-map in the bottom-right corner).

### 2. Vertex Inspector (Right Slide-out Drawer)
Consistent with GCP consoles, clicking any vertex does not open a modal, but rather triggers a right-side slide-out drawer. The drawer organizes dense information using tabs:
- **'Details' Tab:** Shows execution status badges, node execution duration, and metadata.
- **'Payload' Tab (JSON View):** 
  - *For Planners:* Displays the assembled prompt and the raw LLM completion.
  - *For Tool Callers:* Displays the exact input parameters and the JSON result returned by the Go Coordinator.
  - *For Routers (Policy Engine):* Displays the exact rule condition matched to trigger the route.
- **'Logs' Tab:** Streams raw execution logs specific to that vertex (e.g., standard output from the Go Executor).

### 3. Data Binding (Unidirectional Data Flow & Dumb Renderer)
The UI does not maintain its own state database, nor does it fold events itself. Per the core architecture (single canonical projector), implementing a second fold pipeline in the browser is strictly forbidden. Instead, the Console acts as a dumb renderer. The TypeScript Engine computes the `surface(stream_seq)` using the canonical versioned projection pipeline and streams the resulting surface JSON to the Console via Server-Sent Events (SSE) or WebSocket. The Console simply subscribes and renders the updated state.

## Rationale
- **Fits the Event Log Model:** Moving backward or forward in time (via Fork/Replay) simply means re-rendering the DAG canvas at a different `stream_seq`. The UI remains a pure projection of the backend.
- **Cognitive Load:** The Vertex AI style is proven for handling complex machine-learning and orchestration pipelines. It emphasizes readability for highly nested or heavily branched graphs.
- **Operational Safety:** Highlighting transaction boundaries (Pivots) prevents operators from misunderstanding why a workflow is moving forward with compensation instead of rolling back.

## Consequences
- **Engineering Effort:** Requires standing up a front-end service (likely React/TypeScript) and a read-only API gateway that serves the `surface` projection to the frontend.
- **Real-time Updates:** To show the JIT expansion smoothly, the Console will need a Server-Sent Events (SSE) or WebSocket connection to stream `event_log` appends to the client.

## Rejected Alternatives
- **Command-Line Interface (CLI) Only:** While a CLI is useful for triggering runs, it is insufficient for visualizing a branched, nested, running DAG and diagnosing complex pivot/compensation states.
- **Using Existing Tools (e.g., Argo Workflows UI or Airflow UI):** These tools assume statically defined workflows at submission time. Flory's JIT-DAG structure, where the graph shape is unknown until an LLM or Router decides it, cannot be mapped cleanly into standard static DAG visualizers. A custom Console is required to handle progressive disclosure natively.
