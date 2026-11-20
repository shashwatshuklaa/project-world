# Project World (MERN Stack)

A modern full-stack digital marketplace for academic, engineering, and tech projects built entirely with the **MERN** stack (MongoDB, Express, React, Node.js) and TypeScript.

---

## 1. Architecture Overview

This project is structured as an independent monorepo with distinct frontend and backend workspaces:

```
project_world/
├── client/       # React + Vite + TypeScript (Frontend SPA)
├── server/       # Node.js + Express + TypeScript (REST API Backend)
├── .env.example  # Environment variable template
├── .gitignore    # Global repository ignore rules
├── package.json  # Root development scripts
└── README.md     # Project documentation
```

### Client Responsibilities (`client/`)
- Single Page Application (SPA) powered by **React** and **Vite**.
- Client-side routing with **React Router**.
- Global state management for shopping cart, user sessions, and theme toggling.
- Responsive, modern UI using **Tailwind CSS**.
- Communicates with the backend REST API via standard HTTP requests.

### Server Responsibilities (`server/`)
- Robust RESTful API server powered by **Express.js** and **Node.js**.
- Database interactions and data models using **Mongoose** and **MongoDB**.
- Request validation, business logic execution, and centralized error handling.
- Secure authentication handling with HTTP-only cookies and JWTs.
- Tamper-proof payment orchestration with **Razorpay**.

---

## 2. Prerequisites

- **Node.js**: v18.0.0 or higher (v20+ recommended)
- **npm**: v9.0.0 or higher
- **MongoDB**: Local MongoDB instance or MongoDB Atlas cluster

---

## 3. Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/shashwatshuklaa/project-world.git
   cd project_world
   ```

2. **Install all dependencies (root, client, and server):**
   ```bash
   npm run install:all
   npm install
   ```

3. **Configure Environment Variables:**
   Copy `.env.example` to create local environment files where needed:
   ```bash
   cp .env.example .env
   ```

---

## 4. Development Commands

From the root directory:

| Command | Action |
| :--- | :--- |
| `npm run dev` | Runs both client (`http://localhost:5173`) and server (`http://localhost:5000`) concurrently |
| `npm run dev:client` | Starts Vite client development server only |
| `npm run dev:server` | Starts Express backend development server only (with hot-reloading) |
| `npm run build` | Builds both server and client for production |
| `npm run build:client` | Builds optimized client production bundle into `client/dist/` |
| `npm run build:server` | Compiles server TypeScript into `server/dist/` |
| `npm run start` | Runs the compiled production server |

---

## 5. Health Check Endpoint

To verify that the backend server is running:

```bash
curl http://localhost:5000/api/health
```

Expected Response:
```json
{
  "status": "ok",
  "message": "ProjectWorld MERN Backend is running",
  "timestamp": "..."
}
```
