# Project World (MERN Stack)

A modern full-stack digital marketplace for academic, engineering, and tech projects built entirely with the **MERN** stack (MongoDB, Express, React, Node.js) and TypeScript.

---

## 1. Architecture Overview

This project is structured as an independent monorepo with distinct frontend and backend workspaces:

```
project_world/
├── client/       # React + Vite + TypeScript (Frontend SPA)
├── server/       # Node.js + Express + TypeScript (REST API Backend)
├── .env.example  # Global environment variable template
├── .gitignore    # Global repository ignore rules
├── package.json  # Root development scripts
└── README.md     # Project documentation
```

### Client Responsibilities (`client/`)
- Single Page Application (SPA) powered by **React** and **Vite**.
- Client-side routing with **React Router**.
- Global state management for shopping cart, user sessions, and theme toggling.
- Responsive, modern UI using **Tailwind CSS**.
- Communicates with the backend REST API via standard HTTP requests with credentials.

### Server Responsibilities (`server/`)
- Robust RESTful API server powered by **Express.js** and **Node.js**.
- Database interactions and data models using **Mongoose** and **MongoDB**.
- Request validation with **Zod**, business logic execution, and centralized error handling.
- Secure authentication handling with **HTTP-only cookies** and **JWTs**.
- Tamper-proof payment orchestration with **Razorpay**.

---

## 2. Authentication Architecture (Phase 3)

The backend implements stateless, session-resistant authentication using JSON Web Tokens (JWT) stored exclusively in **HTTP-only, SameSite cookies**.

### Key Security Decisions
1. **HTTP-Only Cookies (`auth_token`)**: Tokens are inaccessible to JavaScript (`document.cookie`), neutralizing XSS token theft. Tokens are never placed in `localStorage`.
2. **Strict Server-Side Authorization**: Roles are never accepted from registration payloads (`role: 'user'` is strictly assigned by the server).
3. **Database-Backed `adminOnly` Verification**: Admin authorization queries the verified MongoDB user document directly rather than trusting client claims.
4. **Password Hashing & Auto-Migration**: New passwords use **bcrypt** (work factor 10). Legacy PBKDF2 accounts are automatically and transparently migrated to bcrypt upon their first successful login.
5. **Brute-Force Rate Limiting**: Sensitive authentication endpoints (`/api/auth/login` and `/api/auth/register`) are throttled by `express-rate-limit` to **10 requests per IP per 15 minutes**, returning HTTP 429 when exceeded. Non-sensitive endpoints (`/logout`, `/me`) are unthrottled.
6. **Cookie Security Options**:
   - `httpOnly: true`
   - `secure: true` in production (HTTPS-only)
   - `sameSite: 'lax'` (development) / `'none'` (cross-site production with HTTPS)
   - `maxAge: 7 days` (matches JWT lifespan)
7. **Input Validation**: All payloads validated with strict **Zod** schemas that strip and reject unknown properties.

### Authentication Endpoints

| Method | Endpoint | Access | Rate Limit | Description |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/register` | Public | 10 req / 15 min | Registers a new user (`name`, `email`, `password`), hashes password, issues JWT, sets HTTP-only cookie. |
| `POST` | `/api/auth/login` | Public | 10 req / 15 min | Validates credentials, auto-migrates PBKDF2 to bcrypt, issues JWT, sets HTTP-only cookie. |
| `POST` | `/api/auth/logout` | Public | None | Clears the `auth_token` HTTP-only cookie with matching options. |
| `GET` | `/api/auth/me` | Authenticated | None | Returns the authenticated user's profile (`id`, `name`, `email`, `role`, `createdAt`). Returns 401 if unauthorized. |

---

## 3. Required Environment Variables

Configure these in `server/.env` (and `.env` at root):

| Variable | Description | Example |
| :--- | :--- | :--- |
| `PORT` | Server listening port | `5000` |
| `NODE_ENV` | Environment (`development` or `production`) | `development` |
| `CLIENT_URL` | Allowed CORS origin for frontend | `http://localhost:5173` |
| `MONGODB_URI` | MongoDB connection string (isolated DB) | `mongodb://localhost:27017/projectworld_mern` |
| `JWT_SECRET` | Secret key for signing authentication JWTs | Minimum 32-character random string |
| `RAZORPAY_KEY_ID` | Razorpay public key ID | `rzp_test_...` |
| `RAZORPAY_KEY_SECRET` | Razorpay private secret key | — |

---

## 4. Development Commands

From the root directory:

| Command | Action |
| :--- | :--- |
| `npm run dev` | Runs both client (`http://localhost:5173`) and server (`http://localhost:5000`) concurrently |
| `npm run dev:client` | Starts Vite client development server only |
| `npm run dev:server` | Starts Express backend development server only (with hot-reloading) |
| `npm test` | Runs the backend automated test suite (`tsx --test`) |
| `npm run seed` | Runs the idempotent project catalog seed script |
| `npm run build` | Builds both server and client for production |
| `npm run build:client` | Builds optimized client production bundle into `client/dist/` |
| `npm run build:server` | Compiles server TypeScript into `server/dist/` |
| `npm run start` | Runs the compiled production server |

---

## 5. Health Check Endpoint

```bash
curl http://localhost:5000/api/health
```

Expected Response:
```json
{
  "status": "ok",
  "message": "ProjectWorld MERN Backend is running",
  "database": "connected",
  "timestamp": "2026-11-21T00:00:00.000Z"
}
```
