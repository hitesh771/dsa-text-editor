# 🚀 Collaborative Text Editor

<div align="center">

**A production-grade, real-time collaborative text editor built with advanced data structures, operational transformation, persistent SQLite revision storage, and decoupled binary asset management.**

[![Node.js](https://img.shields.io/badge/Node.js-20+-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-WAL%20Mode-blue.svg)](https://sqlite.org/)
[![Tests](https://img.shields.io/badge/Tests-79%20Passing-success.svg)](#-automated-testing)

[Features](#-features) • [Architecture](#-architecture) • [Data Structures & Algorithms](#-data-structures--algorithms) • [Multi-Client Setup](#-multi-client-local-setup) • [Testing](#-automated-testing) • [Project Structure](#-project-structure)

</div>

---

## 📖 Overview

This project implements an authoritative, distributed collaborative text editing system that guarantees conflict-free document convergence across multiple concurrent browser clients running on distinct network origins.

Built around a mathematically balanced **AVL Rope**, an **Operational Transformation (OT) Engine with non-subsuming split deletion**, an **Augmented AVL Interval Tree** for real-time collaborator selection tracking, a **Fenwick Tree** revision index, durable **SQLite revision & snapshot persistence**, and an **HTTP Asset Management System**.

---

## ✨ Features

### 1. Document & Text Architecture
- **Client & Server AVL Rope**: True balanced binary tree maintaining strict $O(\log n)$ depth under thousands of sequential and random edits. Both client and server represent document state via independent in-memory Ropes.
- **Atomic Embed References**: Images, PDFs, and uploaded files occupy exactly 1 logical unit in the Rope, while raw binary data is stored completely separately.
- **UTF-16 Positional Alignment**: Unified coordinate space shared across browser selection ranges, Rope leaves, and revision operations, preserving surrogate pairs and emojis.

### 2. Operational Transformation (OT) & Queues
- **Authoritative Server Pipeline**: Server validates base revisions, slices intervening history, transforms incoming operations, and atomically commits them to the master Rope.
- **Jupiter Client Queue Lifecycle**: Keystrokes are immediately applied optimistically to the local Rope. The first operation enters an in-flight `outstandingOp` awaiting server ACK, while subsequent typing is enqueued in a secondary `bufferQueue` and promoted sequentially upon ACK receipt.
- **Non-Subsuming Split Deletion**: When a user deletes a range $[D, D + L_D)$ and another user concurrently inserts text inside that range, the deletion is dynamically split into two distinct sub-operations around the insertion, completely preserving the inserted content without subsuming or corrupting it.
- **Deterministic Tie-Breaking**: Same-position simultaneous insertions are ordered deterministically using client identifiers.

### 3. Selection Tracking & Presence
- **Augmented AVL Interval Tree**: Indexes active collaborators' selection ranges $[start, end)$ in $O(\log n)$ time.
- **Overlap Detection**: Subtree maximum endpoint pruning detects intersecting user selections in real time.
- **Edit Shifting (`shiftAll`)**: Every committed operation automatically shifts active selection intervals in the tree to keep collaborator selections in sync with the current document revision.
- **Stale Presence Cleanup**: Automatically purges disconnected or stale user intervals using time-to-live (TTL) expiration.

### 4. Persistent Revision Manager & Crash Recovery
- **ACID SQLite Storage**: Uses SQLite with Write-Ahead Logging (`WAL`) to atomically commit operations, update global revisions, and store ordered operation logs.
- **Duplicate Detection**: Processed operation IDs prevent duplicate applications and provide idempotent ACK recovery for dropped network packets.
- **Periodic Snapshots**: Automatically creates snapshots every 10 revisions containing serialized document pieces and embed references.
- **Crash Recovery**: Server rebuilds authoritative master documents on startup by loading the latest snapshot and replaying subsequent operations.
- **History Gap Recovery**: Reconnecting clients request missed revision ranges via `history_request` and catch up seamlessly.

### 5. Decoupled Asset Management
- **Persistent Local File Storage**: External storage directory decoupling heavy binary bytes from document text.
- **Magic Byte Signature Validation**: Enforces content validation using binary headers (PNG, JPEG, PDF, CSV), rejecting spoofed or malformed files.
- **Image Metadata Extraction**: Automatically parses image dimensions (width/height) from PNG `IHDR` and JPEG `SOF` chunks, computing SHA-256 checksums.
- **Dual CSV Handling**:
  - **Pasted CSV**: Intercepted as text and processed through character-level OT.
  - **Uploaded CSV**: Stored as an external asset and represented by an atomic `EmbedRef` with download endpoints.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           AUTHORITATIVE BACKEND                         │
│                           (Node.js • Port 8080)                         │
│                                                                         │
│   ┌────────────────────┐   ┌───────────────────┐   ┌────────────────┐   │
│   │  Master AVL Rope   │   │     OT Engine     │   │  Interval Tree │   │
│   │  O(log n) Document │   │  Split Deletion   │   │  Presence/     │   │
│   │  + Embed Leaves    │   │  Tie-Breaking     │   │  Overlap Index │   │
│   └─────────┬──────────┘   └─────────┬─────────┘   └────────┬───────┘   │
│             │                        │                      │           │
│   ┌─────────┴────────────────────────┴──────────────────────┴───────┐   │
│   │                 Persistence Manager (node:sqlite)                │   │
│   │      WAL Mode • Atomic Transactions • Snapshots • Op History    │   │
│   └──────────────────────────────────┬──────────────────────────────┘   │
│                                      │                                  │
│   ┌──────────────────────────────────┴──────────────────────────────┐   │
│   │                 Asset Manager (server/uploads/)                 │   │
│   │       Magic Byte Validation • SHA-256 • Image Dimensions        │   │
│   └──────────────────────────────────┬──────────────────────────────┘   │
│                                      │                                  │
│           HTTP REST (Assets) ◄───────┴───────► WebSocket (OT)           │
└───────────────────────▲──────────────────────────────▲──────────────────┘
                        │                              │
        ┌───────────────┴───────────────┐              │
        │ HTTP REST                     │ WebSockets   │ WebSockets
        │ /api/assets                   │ ws://...     │ ws://...
        ▼                               ▼              ▼
┌──────────────────┐           ┌──────────────────┐  ┌──────────────────┐
│ Frontend Client A│           │ Frontend Client B│  │ Frontend Client C│
│ (localhost:5173) │           │ (localhost:5174) │  │ (localhost:5175) │
│                  │           │                  │  │                  │
│ • Local AVL Rope │           │ • Local AVL Rope │  │ • Local AVL Rope │
│ • In-flight Op   │           │ • In-flight Op   │  │ • In-flight Op   │
│ • Buffer Queue   │           │ • Buffer Queue   │  │ • Buffer Queue   │
│ • Rich Editor UI │           │ • Rich Editor UI │  │ • Rich Editor UI │
└──────────────────┘           └──────────────────┘  └──────────────────┘
```

---

## 🌲 Data Structures & Algorithms

### 1. AVL-Balanced Rope (`shared/rope.ts`)
- **Node Structure**: Internal nodes maintain `weight` (left subtree length), `totalLength`, and `height`. Leaves store either UTF-16 text chunks or atomic `EmbedRef` records.
- **Strict AVL Balancing**: Every insertion and deletion executes single (`rotateLeft`, `rotateRight`) or double rotations whenever balance factor $|h_L - h_R| > 1$.
- **Subtree Split and Concatenation**: Splits in $O(\log n)$ time; joins two trees $T_1$ and $T_2$ in $O(|h_1 - h_2|)$ time along tree spines.
- **Complexity**:
  - `insert(pos, text)`: $O(\log n)$
  - `insertEmbed(pos, embed)`: $O(\log n)$
  - `delete(pos, len)`: $O(\log n)$
  - `charAt(pos)`: $O(\log n)$
  - `substring(start, end)`: $O(\log n)$

### 2. Operational Transformation Engine (`shared/transform.ts`)
- **Insert vs. Insert**: Deterministic tie-breaking by `clientId`:
  $$\text{If } pos_B < pos_A \lor (pos_B = pos_A \land clientId_B < clientId_A) \implies pos_A' = pos_A + len_B$$
- **Insert vs. Delete**: An insertion at $P$ inside concurrently deleted range $[D, D + L_D)$ is preserved and lands at $pos = D$.
- **Delete vs. Insert (Non-Subsuming Split)**: A deletion spanning an insert is divided around the inserted text:
  1. Delete range $[D, P)$ of length $P - D$.
  2. Delete range $[D + len_I, D + L_D)$ of length $(D + L_D) - P$.
- **Delete vs. Delete**: Range intersection and relative set differences adjust deletion boundaries without double deletions or inverted bounds.

### 3. Augmented AVL Interval Tree (`shared/intervalTree.ts`)
- **Half-Open Convention**: Stores user selections as $[start, end)$.
- **Subtree Max Augmentation**: Each node tracks $node.max = \max(node.end, left.max, right.max)$.
- **$O(\log n)$ Search**: Prunes subtrees where $left.max \le query.start$.
- **Complete Deletion**: Deletes by `clientId` using two-child successor substitution and rebalances up the ancestor spine.
- **Position Shifting (`shiftAll`)**: Dynamically shifts selection boundaries when document edits occur.

### 4. Fenwick Tree (`server/src/transformEngine.ts`)
- Repurposed as a `RevisionDeltaIndex` to track net length deltas across committed revisions in $O(\log R)$ time, enabling rapid history position reconstruction.

### 5. Persistent Revision Manager (`server/src/persistence.ts`)
- SQLite database in `server/data/collab.sqlite` with Write-Ahead Logging (`WAL`).
- Commits operations inside atomic `BEGIN IMMEDIATE` transactions.
- Idempotently acknowledges duplicate operation IDs during lost-ACK scenarios.
- Automatically captures full document snapshots every 10 revisions.

---

## 💻 Multi-Client Local Setup

Run independent frontend clients in separate terminals on the same machine connecting to **one shared collaboration backend**.

### Prerequisites
- Node.js 20+ (with native `--experimental-strip-types` and `node:sqlite`)
- npm

---

### Step-by-Step Terminal Execution

#### Terminal 1 — Start Shared Collaboration Server (Port 8080)
```powershell
node --experimental-strip-types server/src/index.ts
```
*(Starts WebSocket server and HTTP REST API on `http://localhost:8080`)*

#### Terminal 2 — Start Frontend Client A (Port 5173)
```powershell
npm --prefix client run dev:a
```
*(Runs: `vite --port 5173 --strictPort`)*

#### Terminal 3 — Start Frontend Client B (Port 5174)
```powershell
npm --prefix client run dev:b
```
*(Runs: `vite --port 5174 --strictPort`)*

#### Terminal 4 — Start Frontend Client C (Port 5175)
```powershell
npm --prefix client run dev:c
```
*(Runs: `vite --port 5175 --strictPort`)*

---

### Browser Access URLs

Open all three separate browser windows with the same document ID:

* **Client A**: [http://localhost:5173/?doc=demo](http://localhost:5173/?doc=demo)
* **Client B**: [http://localhost:5174/?doc=demo](http://localhost:5174/?doc=demo)
* **Client C**: [http://localhost:5175/?doc=demo](http://localhost:5175/?doc=demo)

All clients connect to the shared backend at `ws://localhost:8080` and `http://localhost:8080`.

---

## 🧪 Automated Testing

The repository contains automated test suites covering all four phases.

### Run All Tests
```powershell
node --experimental-strip-types --test test/rope.phase1.test.ts server/test/rope.test.ts test/e2e.test.ts test/fenwick.edge.test.ts test/benchmark.test.ts test/ot.phase2.test.ts test/phase3.test.ts test/phase4.test.ts
```

### Test Suite Summary

```
▶ Server Rope Data Structure (AVL-Balanced) .................. 15/15 PASS
▶ Performance Benchmarks ..................................... 7/7 PASS
▶ E2E: Two-client scenario & Concurrent Edits ................ 4/4 PASS
▶ Fenwick Tree - Edge Cases .................................. 11/11 PASS
▶ Phase 1: AVL Rope Core & Balancing Invariants .............. 12/12 PASS
▶ Phase 2: Authoritative OT, Queues & Convergence ............ 8/8 PASS
▶ Phase 3: Asset Management, Embeds, Interval Tree & Presence  14/14 PASS
▶ Phase 4: Persistence, Snapshots, Gap Recovery & Multi-Client 8/8 PASS

Total: 79 passed, 0 failed, 0 skipped
```

---

## 📁 Project Structure

```
dsa-text-editor/
├── package.json                   # Root scripts for server and clients
├── server/
│   ├── package.json               # Server package configuration
│   ├── src/
│   │   ├── index.ts               # Server startup entry point
│   │   ├── server.ts              # CollabServer: HTTP REST & WebSocket room hub
│   │   ├── persistence.ts         # SQLite Persistence Manager & atomic commits
│   │   ├── assetManager.ts        # Persistent asset storage & magic byte validation
│   │   ├── intervalTree.ts        # Interval Tree re-export
│   │   ├── rope.ts                # Server Rope re-export
│   │   ├── transform.ts           # Server OT re-export
│   │   ├── transformEngine.ts     # Fenwick Tree RevisionDeltaIndex
│   │   └── types.ts               # Server type re-exports
│   └── test/
│       └── rope.test.ts           # Server Rope unit tests
├── client/
│   ├── package.json               # Frontend dependencies & multi-port scripts
│   ├── vite.config.ts             # Vite configuration with strictPort
│   └── src/
│       ├── main.tsx               # Client React entry point
│       ├── App.tsx                # App container, URL room routing & presence state
│       ├── RichEditor.tsx         # Rope-driven editor, embeds, paste & selection
│       ├── otClient.ts            # Jupiter client OT state machine & queues
│       ├── connection.ts          # WebSocket transport & history catch-up
│       ├── intervalTree.ts        # Client Interval Tree re-export
│       ├── cursorManager.ts       # Cursor rendering and color management
│       ├── components/
│       │   ├── Toolbar.tsx        # Formatting & asset upload buttons
│       │   ├── StatusBar.tsx      # Caret position & document length
│       │   └── ClientsDropdown.tsx# Active collaborators list
│       └── styles.css             # Editor, embed badges, and cursor styles
├── shared/
│   ├── rope.ts                    # Canonical AVL Rope data structure
│   ├── transform.ts               # Canonical OT engine with split deletion
│   ├── intervalTree.ts            # Canonical Augmented AVL Interval Tree
│   └── types.ts                   # Canonical shared TypeScript interfaces
└── test/
    ├── rope.phase1.test.ts        # Phase 1: AVL balancing & embed tests
    ├── ot.phase2.test.ts          # Phase 2: OT convergence & queue tests
    ├── phase3.test.ts             # Phase 3: Asset manager & Interval Tree tests
    ├── phase4.test.ts             # Phase 4: SQLite persistence & gap recovery tests
    ├── e2e.test.ts                # End-to-end integration tests
    ├── fenwick.edge.test.ts       # Fenwick Tree edge cases
    └── benchmark.test.ts          # Performance benchmark suite
```

---

## 🛠️ Tech Stack

- **Backend**: Node.js 20+, TypeScript, WebSocket (`ws`), SQLite (`node:sqlite`)
- **Frontend**: React 18, Vite 4, TypeScript, HTML5 ContentEditable
- **Data Structures**: AVL Rope, Augmented AVL Interval Tree, Fenwick Tree
- **Protocol**: JSON over WebSockets + HTTP multipart/stream REST
- **Persistence**: SQLite (WAL mode) + Local filesystem asset storage
