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

### Server Variables (`server/.env`)

| Variable | Description | Example |
| :--- | :--- | :--- |
| `PORT` | Server listening port | `5000` |
| `NODE_ENV` | Environment (`development` or `production`) | `development` |
| `CLIENT_URL` | Allowed CORS origin for frontend | `http://localhost:5173` |
| `MONGODB_URI` | MongoDB connection string (isolated database) | `mongodb://localhost:27017/projectworld_mern` |
| `JWT_SECRET` | Secret key for signing authentication JWTs | Minimum 32-character random string |
| `RAZORPAY_KEY_ID` | Razorpay public key ID | `rzp_test_...` |
| `RAZORPAY_KEY_SECRET` | Razorpay private secret key | — |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay webhook signature secret | — |

### Client Variables (`client/.env`)

| Variable | Description | Example |
| :--- | :--- | :--- |
| `VITE_API_URL` | Base URL for backend REST API proxy | `http://localhost:5000/api` |
| `VITE_RAZORPAY_KEY_ID` | Razorpay public key ID for client checkout | `rzp_test_...` |

---

## 4. Development Commands

From the root directory:

| Command | Action |
| :--- | :--- |
| `npm run dev` | Runs both client (`http://localhost:5173`) and server (`http://localhost:5000`) concurrently |
| `npm run dev:client` | Starts Vite client development server only |
| `npm run dev:server` | Starts Express backend development server only (with hot-reloading) |
| `npm test` | Runs both backend and frontend automated test suites (`npm run test:server && npm run test:client`) |
| `npm run test:server` | Runs backend automated test suite only (`tsx --test`) |
| `npm run test:client` | Runs frontend automated test suite only (`tsx --test`) |
| `npm run worker:recovery` | Starts the background payment and refund recovery worker (development) |
| `npm run worker:recovery:prod` | Runs the compiled background payment recovery worker (production) |
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

---

## 6. Background Payment & Refund Recovery Worker (Phase 8.3 Step 6)

The background payment recovery subsystem automatically reconciles interrupted, uncertain, or delayed payment and refund operations across transient network drops, worker crashes, and missing webhooks.

### Core Architecture & Sweep Phases

Each recurring sweep pass executes 5 structured recovery phases:

1. **Phase A: Expired Webhook Recovery (`sweepExpiredWebhookEvents`)**
   - Finds `WebhookEvent` records stuck in `processing` whose leases have expired.
   - If `attempts < maxRetries`: resets lease fields (`leaseWorkerId`, `leaseToken`, `leaseExpiresAt` to `null`), making the event immediately eligible for atomic claim on redelivery or retry.
   - If `attempts >= maxRetries`: marks event `failed` with descriptive error to prevent infinite lease churn.

2. **Phase B: Expired Refund Job Lease Recovery (`sweepExpiredRefundJobLeases`)**
   - Sweeps `RefundJob` records in `processing` whose worker leases expired.
   - `apiDispatched: false`: safely resets to `pending` (worker crashed before HTTP request left host).
   - `apiDispatched: true`: transitions to `uncertain` state for authoritative gateway inquiry (never creates a duplicate refund).

3. **Phase C: Uncertain Refund Job Authoritative Reconciliation (`sweepUncertainRefundJobs`)**
   - Atomically claims exclusive lease on `uncertain` jobs.
   - Queries Razorpay API authoritatively via official SDK (`fetchAuthoritativeGatewayRefund` or payment refunds inquiry).
   - Gateway `processed`: invokes `processRefundSettlement` to transition `Order` confirmed accounting and marks job `succeeded`.
   - Gateway `failed`: invokes `processRefundFailure` to release reserved capacity on `Order` and marks job `manual_review`.
   - Gateway `pending`: retains `uncertain` status, clears lease for subsequent sweep.
   - Gateway reports refund not found (e.g. 404): resets to `failed_retryable` for dispatch retry if retries remaining; escalates to `manual_review` if retries exhausted.

4. **Phase D: Dispatched Refund Settlement Reconciliation (`reconcilePendingRefundSettlements`)**
   - Reconciles refunds where `Refund.status === 'pending'` and `providerRefundId` is known, authoritatively settling them if incoming webhooks were lost or delayed.

5. **Phase E: Retryable Refund Job Dispatch (`sweepAndDispatchRetryableJobs`)**
   - Sweeps `pending` and `failed_retryable` jobs.
   - Enforces exponential backoff cooldown (`baseBackoffMs * 2^(attempts - 1)`).
   - Reuses the exact same persisted `providerIdempotencyKey` (`X-Refund-Idempotency` header) across all retries.
   - Escalates to `manual_review` when `attempts >= maxRetries`.

### Recovery Configuration Settings

Configured via environment variables in `server/.env` or programmatically:

| Variable | Description | Default | Allowed Range |
| :--- | :--- | :--- | :--- |
| `RECOVERY_SWEEP_INTERVAL_MS` | Recurring interval between sweep passes | `30000` (30s) | $\ge 1000\text{ ms}$ |
| `RECOVERY_BATCH_SIZE` | Maximum records processed per phase per sweep | `50` | $1 - 500$ |
| `RECOVERY_LEASE_DURATION_MS` | Lease duration for worker fencing | `60000` (60s) | $\ge 5000\text{ ms}$ |
| `RECOVERY_MAX_RETRIES` | Max retries before escalating to `manual_review` | `3` | $1 - 50$ |
| `RECOVERY_BASE_BACKOFF_MS` | Base multiplier for exponential backoff | `5000` (5s) | $\ge 500\text{ ms}$ |
| `RECOVERY_MAX_BACKOFF_MS` | Maximum backoff cooldown ceiling | `300000` (5m) | $\ge \text{baseBackoffMs}$ |
| `RECOVERY_WORKER_ID` | Identifier for current worker instance | Auto-generated UUID | Non-empty string |

### How to Run Locally

From the `server/` directory:
```bash
# Run in development with TypeScript execution
npm run worker:recovery

# Run in production using compiled output
npm run worker:recovery:prod
```

Or from repository root:
```bash
npm run worker:recovery --prefix server
```

### Safety & Concurrency Guarantees

- **No In-Memory Locks for Cross-Process Correctness**: Distributed multi-process safety relies entirely on atomic database operations (`findOneAndUpdate` with `leaseExpiresAt` and unique UUID `leaseToken`).
- **Stale Worker Fencing**: A worker whose lease expired or was superseded cannot overwrite a newer worker's state (`leaseToken` mismatch rejection).
- **In-Process Overlap Prevention**: The `isSweeping` guard ensures a single worker instance never overlaps sweeps.
- **Provider Idempotency**: Stable `X-Refund-Idempotency` header keys (32-character hexadecimal sha256 digests) are persisted before first external HTTP dispatch and reused across retries.
- **Transactional Accounting**: All ledger updates are atomic via MongoDB transactions; duplicate settlements return idempotent responses without double-counting.
- **Graceful Shutdown**: Handles `SIGINT` and `SIGTERM`, stopping background timers and awaiting in-flight sweeps before disconnecting from the database.

---

## 7. Order History & Order Details API (Phase 8.4)

The backend provides authenticated REST endpoints allowing users to securely review their past orders and individual order details.

### Security & Privacy Guarantees
1. **Strict Authentication**: All order routes require authenticated sessions via HTTP-only cookie (`auth_token`) or `Authorization: Bearer <token>` header. Unauthenticated requests return HTTP 401.
2. **Database-Level Ownership Enforcement**: Queries enforce `userId: req.user.id` at the database level. Query parameter injection of user IDs (e.g. `?userId=...`) is strictly prohibited and rejected via Zod schema validation.
3. **No Information Leakage**: Requesting an order belonging to another user returns HTTP 404 (`Order not found.`), identical to nonexistent orders.
4. **Canonical Historical Price Integrity**: Item prices and order totals use canonical values stored in the `Order` document snapshot at purchase time; they are never recalculated from current catalog `Project` prices.
5. **Sensitive Field Sanitization**: Internal dual-ledger accounting fields (`totalCapturedPaise`, `confirmedRefundPaise`, etc.), internal gateway receipts (`receipt`), HMAC signatures (`razorpaySignature`), worker lease tokens, provider idempotency keys, and webhook records are strictly stripped from all responses.
6. **Customer-Facing Status Mapping**: Internal payment-processing and security states (`security_discrepancy`, `held_for_review`, `creating`, `unknown`, `duplicate_charge_detected`, `retryable_failure`) are never exposed over the API. They are mapped cleanly to customer-facing statuses (`pending`, `captured`, `failed`, `refunded`, `partially_refunded`, `refund_pending`). Filtering probes using internal-only states are strictly rejected with HTTP 400.

### Endpoints

| Method | Endpoint | Access | Query Parameters | Description |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/orders` | Authenticated | `page`, `limit`, `status`, `paymentStatus` | Returns paginated order history for the authenticated user, sorted newest first. |
| `GET` | `/api/orders/:id` | Authenticated | None | Returns complete order details for a specific order owned by the authenticated user. `:id` must be a valid 24-character hexadecimal MongoDB ObjectId. |

### Query Parameters for `GET /api/orders`

- `page` *(optional, default: `1`)*: Positive integer $> 0$.
- `limit` *(optional, default: `10`, max: `50`)*: Number of orders per page.
- `status` *(optional)*: Filter by customer-facing order lifecycle status: `pending`, `processing`, `completed`, `failed`, `cancelled`, `refunded`.
- `paymentStatus` *(optional)*: Filter by customer-facing payment status: `pending`, `captured`, `failed`, `refunded`, `partially_refunded`, `refund_pending`. Probing with internal states is rejected with HTTP 400.

### Example Response: `GET /api/orders`

```json
{
  "success": true,
  "orders": [
    {
      "_id": "674000000000000000000012",
      "id": "674000000000000000000012",
      "orderId": "ord_1234567890abcdef1234567890abcdef",
      "createdAt": "2026-11-22T14:00:00.000Z",
      "updatedAt": "2026-11-22T14:05:00.000Z",
      "status": "completed",
      "paymentStatus": "captured",
      "totalAmount": 7000,
      "currency": "INR",
      "items": [
        {
          "projectId": "674000000000000000000002",
          "projectSlug": "eng-rc-001",
          "title": "Off-Road RC Crawler",
          "price": 3500,
          "quantity": 2,
          "customization": "Matte black chassis",
          "category": "Engineering",
          "subcategory": "RC",
          "image": "/projects/rc1.png"
        }
      ],
      "itemCount": 2,
      "paidAt": "2026-11-22T14:02:00.000Z",
      "paymentMethod": "upi",
      "razorpayOrderId": "order_xyz123",
      "razorpayPaymentId": "pay_abc456",
      "refundSummary": {
        "isRefunded": false,
        "isPartiallyRefunded": false,
        "refundedAmount": 0
      }
    }
  ],
  "pagination": {
    "total": 1,
    "page": 1,
    "limit": 10,
    "totalPages": 1,
    "hasNextPage": false,
    "hasPrevPage": false
  }
}
```

### Example Response: `GET /api/orders/:id`

```json
{
  "success": true,
  "order": {
    "_id": "674000000000000000000012",
    "id": "674000000000000000000012",
    "orderId": "ord_1234567890abcdef1234567890abcdef",
    "createdAt": "2026-11-22T14:00:00.000Z",
    "updatedAt": "2026-11-22T14:05:00.000Z",
    "status": "completed",
    "paymentStatus": "captured",
    "totalAmount": 7000,
    "currency": "INR",
    "items": [
      {
        "projectId": "674000000000000000000002",
        "projectSlug": "eng-rc-001",
        "title": "Off-Road RC Crawler",
        "price": 3500,
        "quantity": 2,
        "customization": "Matte black chassis",
        "category": "Engineering",
        "subcategory": "RC",
        "image": "/projects/rc1.png"
      }
    ],
    "itemCount": 2,
    "paidAt": "2026-11-22T14:02:00.000Z",
    "paymentMethod": "upi",
    "razorpayOrderId": "order_xyz123",
    "razorpayPaymentId": "pay_abc456",
    "refundSummary": {
      "isRefunded": false,
      "isPartiallyRefunded": false,
      "refundedAmount": 0
    }
  }
}
```

---

## 8. Frontend Checkout & Razorpay Integration (Phase 8.5)

The frontend connects the persistent server-backed shopping cart to the backend payment reservation and Razorpay payment gateway.

### Core Architecture & Guarantees
1. **Never Trusts Client Prices**: The checkout flow never calculates or submits item prices or totals from the frontend; the backend computes canonical prices from MongoDB catalog records.
2. **Idempotency Protection**: Generates cryptographically secure, user-scoped idempotency keys (`chk_<timestamp>_<randomHex>`) matching `/^[a-zA-Z0-9_-]+$/`. The exact same key is reused across retries of the same uncompleted checkout attempt.
3. **Safe SDK Loading**: Dynamically loads `https://checkout.razorpay.com/v1/checkout.js` with singleton promise caching and handles network failures gracefully.
4. **Modal Dismissal Safety**: Closing or dismissing the modal sets status to `cancelled` and preserves all cart items (never clears the cart).
5. **Authoritative Backend Verification**: The browser callback alone is never treated as proof of payment. Payment details (`orderId`, `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`) are verified by `POST /api/orders/verify-payment`.
6. **No False Success on Uncertainty**: If backend verification times out or returns HTTP 504/503/429 (`resolutionNeeded: true`), the UI informs the customer that verification is pending and advises checking order history before re-paying.
7. **Cart Reconciliation**: Authoritative post-payment cart state is synchronized via `refreshCart()`, preserving any newly added items per backend reconciliation.

---

## 9. Order History & Order Details Frontend (Phase 8.6)

Customers can review past purchases and inspect individual order details through dedicated authenticated pages.

### Client Routes

| Route | Access | Component | Description |
| :--- | :--- | :--- | :--- |
| `/orders` | Authenticated | `OrderHistoryPage` | Paginated list of customer orders with status filters, item summaries, canonical totals, and pagination. |
| `/orders/:id` | Authenticated | `OrderDetailPage` | Detailed order receipt with item breakdown, customization notes, historical unit prices, payment metadata, and refund summaries. `:id` must be a 24-character hexadecimal MongoDB ObjectId. |

### Security & UX Principles
- **No Internal Leaks**: Internal states (`security_discrepancy`, `held_for_review`, `creating`, `unknown`, `duplicate_charge_detected`, `retryable_failure`) and dual-ledger paise fields are strictly absent from UI and customer responses.
- **Accessible Badges**: Statuses are styled using `OrderStatusBadge` and `PaymentStatusBadge` with standard color mappings (Paid, Pending, Failed, Refunded, Partially Refunded).
- **Protected Routing**: Unauthenticated access to `/orders` or `/orders/:id` automatically redirects to `/login`, preserving destination state for post-login redirection.

---

## 10. Production Deployment Requirements

Before deploying ProjectWorld to production infrastructure, the following prerequisites must be met:

1. **Production Environment Configuration**:
   - Supply actual production credentials for `JWT_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`.
   - Never commit `.env` files to source control.
2. **MongoDB Replica-Set Support for Transactions**:
   - The payment capture, refund reservation, and dual-ledger accounting subsystems rely on multi-document MongoDB transactions (`session.withTransaction`).
   - Production requires a MongoDB replica set (MongoDB 4.2+ or MongoDB Atlas). Standalone single-node MongoDB without replica-set initiation (`rs.initiate()`) does not support transactions.
3. **Managed Background Recovery Worker**:
   - The recovery worker (`npm run worker:recovery:prod`) must run as an independent, supervised background daemon (via PM2, systemd, or a containerized worker pod) with health monitoring and automatic restart policies.
4. **Development Boundaries & Status**:
   - Automated tests run against in-memory models and mock gateway harnesses.
   - Live MongoDB Atlas connections, live Razorpay gateway transactions, domain DNS routing, and cloud hosting deployments have intentionally not been executed in accordance with milestone constraints.



