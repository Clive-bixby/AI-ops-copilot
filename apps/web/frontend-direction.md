web application/stitch/projects/16396892379763216588/screens/89e6f98a573345fb9f1461357b215b99

# AI Ops Copilot: Developer Handoff Package

This document provides complete technical specifications for implementing the AI Ops Copilot frontend. It is designed for consumption by AI coding agents or frontend developers.

---

## 1. Project Overview

**Product Name:** OpsCommand (AI Ops Copilot)
**Target Users:** DevOps, SRE, Platform Engineering, Incident Response.
**Design Aesthetic:** Modern, premium, high-density, AI-native.
**Tech Stack Recommendation:** React, TypeScript, Tailwind CSS, shadcn/ui, React Router, TanStack Query.

---

## 2. Design System Specification

### Colors

**Base Theme:** Dark Mode Only

- **Surface:** `#131314` (Page Background)
- **Surface Dim:** `#131314` (Deep Panels)
- **Surface Bright:** `#39393a` (High Contrast Panels)
- **Surface Container Lowest:** `#0e0e0f` (Sidebar)
- **Surface Container Low:** `#1c1b1c` (Cards Base)
- **Primary:** `#3b82f6` (Electric Blue - Action Accent)
- **Secondary Container:** `#4f319c` (Active Nav Highlight)
- **AI Accent:** Gradient `from-[#8b5cf6] to-[#6366f1]` (Purple/Violet)
- **Success:** `#10b981` (Emerald)
- **Warning:** `#f59e0b` (Amber)
- **Error/Critical:** `#ef4444` (Red)

### Typography (Inter Sans-Serif)

- **Headline XL:** 36px / 44px (Bold, -0.02em tracking)
- **Headline LG:** 28px / 36px (Semi-bold, -0.01em tracking)
- **Body MD:** 16px / 24px (Regular)
- **Body SM:** 14px / 20px (Regular)
- **Code SM:** 12px / 16px (JetBrains Mono, Medium)
- **Label Caps:** 11px / 16px (Bold, 0.05em tracking, Uppercase)

### Spacing & Geometry

- **Scale:** 4px (base), 8px (sm), 16px (md), 24px (lg), 32px (xl).
- **Border Radius:** `ROUND_FOUR` (4px for inputs/small cards), 8px (standard cards), 12px (modals/sections).
- **Shadows:** Soft, low-alpha black shadows for depth; glassmorphism (`backdrop-blur-xl`) for navigation bars.

---

## 3. Screen Inventory & Specifications

### [SCREEN_7] Command Center (Home)

- **Purpose:** Mission control "Awareness" layer.
- **Layout:** 3-column Bento Grid.
- **Key Modules:**
  - **AI Briefing Panel (Large):** Summarizes active incidents and root causes. Gradient border.
  - **System Health:** Small status indicators (Auth API, Core DB, Checkout).
  - **Active Incidents List:** Severity-weighted (SEV-2, SEV-4) list with time-elapsed counters.
  - **Live Log Stream:** Filtered view of ERRORS/WARNINGS.
- **Interactions:** Clicking an Incident card routes to the Investigation Workspace.

### [SCREEN_5] AI Copilot Workspace

- **Purpose:** Contextual Root Cause Analysis.
- **Layout:** 2-column split (60/40).
- **Left Column:** Chat interface with message bubbles, typing indicators, and markdown support.
- **Right Column (Evidence Explorer):**
  - **Incident Timeline:** Vertical dot-connector timeline.
  - **Evidence Cards:** Visual cards for Config Drift (code diff) and Latency Spikes (bar charts).
  - **Runbook Shortcuts:** Link to Knowledge Base.

### [SCREEN_4] Incident Investigation

- **Purpose:** Deep-dive triage.
- **Layout:** Header + 3-column body.
- **Left:** Filtered logs specific to the incident service.
- **Center:** Detailed event timeline with interactive "Copilot Insights" markers.
- **Right:** AI Root Cause Analysis panel with "Confidence Match" radial gauge.
- **Bottom:** Recommended Actions (Runbook steps vs. Scale-up buttons).

### [SCREEN_2] Logs Explorer

- **Purpose:** High-performance telemetry inspection.
- **Layout:** Header search + Histogram + Tabular Stream + Details Pane.
- **Features:**
  - **Log Volume Histogram:** 15m window with color-coded density (Green/Red).
  - **Streaming Console:** Monospaced rows with Timestamp, Level, Service, and Message.
  - **Details Sidebar:** JSON viewer and "Copilot Analysis" box with "Fix with AI" CTA.

### [SCREEN_6] Knowledge Base

- **Purpose:** Documentation and SOP management.
- **Layout:** Search-focused grid.
- **Features:**
  - **Runbook Cards:** AI-generated summary, usage count, and "Verified" badges.
  - **Quick Preview Pane:** Side-drawer for reading SOP content (Markdown) with code blocks and "Execute" actions.

---

## 4. Component Inventory

| Component Name      | Type      | Key Props                   | Behavior                                                   |
| :------------------ | :-------- | :-------------------------- | :--------------------------------------------------------- |
| **TopNavBar**       | Layout    | `title`, `user`             | Sticky top, blurred BG, global search input.               |
| **SideNavBar**      | Layout    | `activeRoute`               | Fixed left, narrow icons + labels, highlight active state. |
| **BentoCard**       | Container | `title`, `size`, `variant`  | Wrapper for Command Center modules; subtle borders.        |
| **SeverityBadge**   | Display   | `level` (SEV-1 to 5)        | Color-coded pill with pulse animation for SEV-1.           |
| **LogLine**         | Data      | `timestamp`, `level`, `msg` | Hover highlight, click-to-expand details.                  |
| **AIResponse**      | Chat      | `content`, `sources`        | Gradient border, typing effect, source card citations.     |
| **HealthIndicator** | Status    | `service`, `status`         | Dot indicator (Green/Yellow/Red) + % label.                |

---

## 5. Implementation Guidance

### Route Structure

- `/` -> `CommandCenter`
- `/investigations/:id` -> `IncidentInvestigation`
- `/copilot` -> `AICopilotWorkspace`
- `/logs` -> `LogsExplorer`
- `/knowledge` -> `KnowledgeBase`

### Architecture Recommendations

1. **State Management:** Use `TanStack Query` for log streaming and incident data fetching.
2. **AI Mocking:** Use a `useTypewriter` hook for AI responses to simulate real-time generation.
3. **Responsive Rule:** The 3-column layouts on desktop should collapse to a single-column stack on mobile. Sidebars become bottom-navigation tabs or hamburger menus.
4. **Accessibility:** Ensure all log lines are keyboard-navigable; use `aria-live` regions for streaming log updates.
