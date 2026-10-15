# Open Fabric – Backend API Deployment Service

> ⚡ **Deployment Notice**: This repository is dedicated solely to the **Backend Deployment Service** of the Open Fabric Transaction Reconciliation Platform (hosted on Render).
>
> 📁 **Main Repository & Test Datasets**: For the complete monorepo, architectural documentation, and all individual test scenario CSV files (`scenario_1.csv` through `scenario_7.csv`, plus `all_scenarios_1_to_7.csv`), please visit the **Main Monorepo**:  
> 👉 **[OF-assement on GitHub](https://github.com/kishore2818/OF-assement)**

[![Live Backend API](https://img.shields.io/badge/⚡%20Backend%20API-Render%20Online-0F1B4C?style=for-the-badge&logo=render&logoColor=white)](https://of-backend.onrender.com)
[![Live Frontend App](https://img.shields.io/badge/🌐%20Live%20App-Vercel%20Online-1EC8A5?style=for-the-badge&logo=vercel&logoColor=white)](https://of-frontend.vercel.app/)
[![Main Monorepo](https://img.shields.io/badge/📦%20Main%20Repo-OF--assement-0F1B4C?style=for-the-badge&logo=github&logoColor=white)](https://github.com/kishore2818/OF-assement)

---

## 🌐 Live Production Endpoints
- **Base Backend API**: `https://of-backend.onrender.com`
- **Frontend Dashboard**: `https://of-frontend.vercel.app`
- **Default Auditor Login**: Email `admin@openfabric.co` | Password `admin123`

---

## 🧪 Testing Scenarios (Deployed & Local)

You can test all business reconciliation scenarios using the pre-packaged dataset CSV files located in the [Main Monorepo](https://github.com/kishore2818/OF-assement):

| Scenario | Dataset File | Description |
| :--- | :--- | :--- |
| **Scenario 1** | `scenario_1.csv` | Exact 1-to-1 match via lifecycle ID |
| **Scenario 2** | `scenario_2.csv` | Partial under-settlement warning |
| **Scenario 3** | `scenario_3.csv` | Legitimate return credit / refund |
| **Scenario 4** | `scenario_4.csv` | Critical over-settlement detection |
| **Scenario 5** | `scenario_5.csv` | Missing lifecycle ID with composite key fallback |
| **Scenario 6** | `scenario_6.csv` | Multi-tranche settlement progression |
| **Scenario 7** | `scenario_7.csv` | Complex partial settlement + refund |
| **Master Batch**| `all_scenarios_1_to_7.csv` | Ingests all 10 records simultaneously |

### Testing on Deployed Site:
1. Open the [Live Web Application](https://of-frontend.vercel.app/).
2. Log in (`admin` / `admin`).
3. Click **Reconcile New Data** in the top navbar.
4. Upload any scenario CSV file or paste the CSV content to test live execution.

### Testing Locally:
```bash
# 1. Install dependencies
npm install

# 2. Start local backend server (port 4000)
npm run dev
# Server runs on http://localhost:4000

# 3. Run automated test suite
npm test
```

---

## 📦 Core Architecture
- **Framework**: Express.js with TypeScript (`tsx`, `esbuild`)
- **Database**: SQLite via `better-sqlite3` v13.0.3 with foreign keys & migrations
- **Authentication**: JWT Bearer Tokens (`jsonwebtoken`, `bcryptjs`)
- **Engine**: Two-tier deterministic reconciliation engine with cents-integer arithmetic for zero drift.
