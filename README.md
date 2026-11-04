# Bucketa

**Smart Buckets — Everything in One Bucket.**

### AI-Powered Financial Intelligence, Business Management & Personal Finance

Bucketa is a local-first financial management platform designed to help small business owners, entrepreneurs, and individuals manage their finances and daily operations through one intelligent workspace.

From tracking income and expenses to managing inventory, recording sales, organizing employees, and monitoring savings, Bucketa brings essential financial workflows together.

At the center of the platform is **Bucky Financial Intelligence**, an AI assistant that helps users analyze their records and perform supported actions through natural-language text and voice instructions.

---

## The Problem

Many small businesses still depend on notebooks, handwritten records, receipts, spreadsheets, and disconnected applications to manage daily financial activities.

Business owners spend valuable time recording transactions, checking inventory, calculating expenses, and organizing financial information.

Individuals face similar challenges when tracking personal spending, managing savings, and working toward financial goals.

Bucketa addresses these challenges by combining financial management, business operations, and AI-powered assistance in one platform.

---

## Meet Bucky Financial Intelligence

### AI-Powered Financial Management & Actions

Bucky Financial Intelligence is Bucketa's intelligent assistant, designed to help users manage business operations and personal finances through natural-language conversations, financial analysis, and actionable commands.

Bucky connects financial intelligence with practical application workflows, enabling users to request supported operations directly through text or voice.

### Intelligent Actions Across Bucketa

**Employee Management**

> Add Michael Anzures to Harbor Mini Market with a monthly salary of $1,500.

Bucky can help prepare employee information, salary details, and supported employee-management operations.

**Inventory Management**

> Add 50 bottles of mineral water to Harbor Mini Market's inventory at $1.50 each.

Bucky can help prepare product information, quantities, prices, and supported inventory operations.

**Financial Recordkeeping**

> Record a $250 electricity expense for Corner Café today.

Bucky can interpret financial instructions and prepare transactions under the appropriate business profile.

**Savings and Budget Management**

> Add $100 to my vacation savings goal.

Bucky can assist with supported savings and bucket operations.

**Financial Analysis and Insights**

> Analyze Harbor Mini Market's sales, expenses, and net cash flow for October 2026.

Bucky can analyze recorded financial data and provide understandable summaries and insights.

### From Instructions to Actions

Bucky is designed to understand user intent, identify the relevant business or personal profile, and prepare supported operations within Bucketa.

Actions that create or modify financial records follow confirmation-based workflows, allowing users to review details before saving changes.

Bucky also provides contextual financial summaries, insights, and natural-language explanations grounded in available records.

*Supported actions depend on the implemented workflow. Some instructions may require clarification, confirmation, or manual completion.*

---

## Key Features

### Business Management

Create and manage separate business profiles with their own financial records, currencies, transactions, and operational information.

### Personal Finance

Track personal income, expenses, savings goals, and financial progress.

### Buckets

Organize money into Savings, Budget, and Allocated buckets.

### Transactions

Record income, expenses, and supported transfers while maintaining a history of financial activity.

### Inventory Management

Manage product records, prices, stock quantities, and inventory status.

### Sales & Point of Sale

Record sales, manage shopping carts, calculate payments and change, and maintain receipts and sales history.

### Employee Management

Organize employee information and supported salary and payment records.

### Bucky Record Scanner

Use Meta AI to extract financial information from receipts, handwritten sales records, and other supported financial documents.

The workflow includes image capture or upload, AI extraction, editable review, uncertainty handling, total reconciliation, and user confirmation before saving.

**Production scanning uses live Meta AI. No fictional mock extraction fallback is provided.**

### Creative Studio

Generate or edit images using Meta AI, with separate camera and image-upload workflows.

### Financial Intelligence

Ask questions about recorded financial information, review summaries, and explore business or personal financial performance.

---

## Built with Meta AI

Bucketa integrates Meta AI models through a Node.js backend.

| Meta Model       | Purpose                      |
| ---------------- | ---------------------------- |
| `muse-spark-1.3` | Bucky Financial Intelligence |
| `muse-spark-1.3` | Bucky Record Scanner         |
| `muse-image-1.0` | Creative Studio              |

### AI Workflow

1. The user submits a question, instruction, or document.
2. Bucketa sends the request to its backend.
3. The backend communicates with the appropriate Meta AI model.
4. The response is validated and presented to the user.
5. Supported record-changing actions require the applicable review and confirmation.

API credentials remain server-side.

AI extraction failures do not silently produce fictional financial records.

---

## Technology Stack

| Component      | Technology                 |
| -------------- | -------------------------- |
| Frontend       | React 19, TypeScript       |
| Build Tool     | Vite                       |
| Backend        | Node.js                    |
| Local Database | IndexedDB                  |
| AI Integration | Meta Model API             |
| User Interface | Responsive web application |

Bucketa stores financial records locally in the browser.

Records are not automatically synchronized across different browsers or devices.

---

## Judge Demo Workspace

Bucketa includes a fictional USD demonstration workspace designed to help judges explore the platform without manually creating financial records.

### Available Demo Profiles

| Profile            | Type                       | Currency |
| ------------------ | -------------------------- | -------- |
| Harbor Mini Market | Retail business            | USD      |
| Corner Café        | Food and beverage business | USD      |
| Alex Morgan        | Personal finance           | USD      |

### Demo Dataset

**Harbor Mini Market**

- 52 financial transactions
- 72 sales records
- Income, expenses, salaries, rent, utilities, and other business activity

**Corner Café**

- 52 financial transactions
- 60 sales records
- Business income, expenses, and sales activity

**Alex Morgan**

- 33 personal financial transactions
- Salary and freelance income
- Personal expenses
- Savings deposits and withdrawals

The demonstration records span **September through November 2026**.

All three demo profiles use USD.

### Loading the Demo

1. Open Bucketa.
2. Navigate to Settings.
3. Select **Load fictional USD judge demo**.
4. Select Harbor Mini Market, Corner Café, or Alex Morgan.
5. Explore the available records and financial summaries.

Demo initialization is designed to add missing demo records without duplicating existing records or overwriting unrelated user data.

**All demonstration financial records are fictional.**

---

## Installation & Local Setup

### Prerequisites

- Node.js and npm
- A modern web browser
- Internet connection for Meta AI requests
- A valid Meta Model API key with access to the required models

### 1. Clone the Repository

```bash
git clone https://github.com/rowellgutierrez/Bucketa.git
cd Bucketa
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Meta AI

Create a local `.env` file using `.env.example` as the configuration reference.

The verified local setup includes:

```dotenv
MODEL_API_KEY=YOUR_META_API_KEY
ENABLE_LIVE_META=1
```

Replace the placeholder with your own Meta API key.

Check `.env.example` for additional configuration options.

**Never publish your actual API key or commit your `.env` file.**

### 4. Start the Backend

Open a terminal:

```bash
npm run server
```

The backend normally runs at:

`http://127.0.0.1:8787`

### 5. Start the Frontend

Open another terminal:

```bash
npm run dev
```

Open the URL shown by Vite, typically:

`http://localhost:5173`

### 6. Verify Live Meta AI

Open a third terminal:

```bash
npm run health
```

A correctly configured backend should report:

```json
{
  "ok": true,
  "modelApiKeyConfigured": true,
  "liveMeta": "enabled",
  "buckyAdvise": {
    "defaultSource": "meta-live",
    "liveModel": "muse-spark-1.3"
  }
}
```

The health check verifies configuration readiness. A real Meta AI request is still required to verify end-to-end operation.

If you change backend code or environment configuration, restart the backend before testing again.

---

## How to Test Bucketa

The following walkthrough is intended for hackathon judges and reviewers.

### Test 1 — Explore the USD Demo Workspace

1. Open Settings.
2. Select **Load fictional USD judge demo**.
3. Select Harbor Mini Market.
4. Review the Home dashboard, transactions, and financial summaries.
5. Switch to Corner Café and Alex Morgan to explore the other profiles.

**Expected:** Financial information is displayed in USD using the fictional demo records.

### Test 2 — Bucky Financial Analysis

Open Bucky Financial Intelligence and enter:

> Analyze Harbor Mini Market's recorded income, expenses, and net cash flow for October 2026 in USD. Do not create or modify any records.

**Expected:** Bucky provides a financial analysis based on available recorded data without changing any records.

### Test 3 — Employee Management Through Bucky

Enter:

> Add Michael Anzures as an employee under Harbor Mini Market with a monthly salary of $1,500.

Verify whether Bucky recognizes the employee, business, and salary, prepares the supported action, and presents the required confirmation.

If the action is completed, check the Employees page for the resulting record.

### Test 4 — Inventory Management Through Bucky

Enter:

> Add 50 bottles of mineral water to Harbor Mini Market's inventory at $1.50 each.

Verify whether Bucky identifies the product, quantity, price, and business.

If the supported action is confirmed and completed, check the Products or Inventory page for the resulting record.

### Test 5 — Financial Recordkeeping Through Bucky

Enter:

> Record a $250 electricity expense for Corner Café today.

Verify the proposed transaction details, including the correct business, expense type, amount, currency, and date.

Confirm the action only if you intend to modify the local demo records.

### Test 6 — Bucky Record Scanner

1. Open Bucky Record Scanner.
2. Select the relevant profile and record type.
3. Upload an image or capture a photo of a financial record.
4. Start the live AI scan.
5. Review the extracted information.
6. Correct any uncertain or incorrect fields.
7. Review the calculated totals.
8. Confirm before saving.

**Expected:** Meta AI extracts information from the supplied document and presents editable records for review.

For a non-destructive demonstration, stop before saving.

### Test 7 — Inventory and Sales

1. Open a business profile.
2. Navigate to Products or Inventory.
3. Review the available products.
4. Open Sales or POS.
5. Add an available product to the cart.
6. Complete a sample sale.
7. Review the receipt and sales history.
8. Check the updated stock quantity.

This test changes local demo records.

### Test 8 — Personal Finance

1. Select Alex Morgan.
2. Open Personal Finance.
3. Review income, expenses, and savings.
4. Ask Bucky:

> Summarize Alex Morgan's recorded personal income and expenses in USD. Do not modify any records.

### Test 9 — Creative Studio

1. Open Creative Studio.
2. Select the available generation or editing workflow.
3. Upload an image or use the camera if required.
4. Enter a suitable instruction.
5. Generate the result.
6. Review the output.

**Note:** Live Meta AI requests may consume API credits.

---

## Automated Tests

Run these commands from the project root.

**Backend tests**

```bash
npm run test:server
```

**Data tests**

```bash
npm run test:data
```

**Application logic tests**

```bash
npm run test:lib
```

**TypeScript verification**

```bash
npx tsc --noEmit
```

**Production build**

```bash
npm run build
```

### Reported Test Results

| Verification              | Result     |
| ------------------------- | ---------- |
| Backend                   | 116 passed |
| Data                      | 23 passed  |
| Library/Application Logic | 256 passed |
| TypeScript                | Passed     |
| Production Build          | Passed     |

**395 automated tests passed in the reported baseline.**

Additional targeted tests passed following the live-only Scanner and demo-workspace repairs.

Automated tests do not replace manual testing of live Meta AI responses.

---

## Troubleshooting

### Live Meta AI Is Not Configured

Check that:

- The backend is running.
- `MODEL_API_KEY` is configured.
- `ENABLE_LIVE_META=1` is set.
- The backend has been restarted after configuration changes.
- `npm run health` reports `"liveMeta": "enabled"`.

### Demo Records Are Missing

Open Settings and select **Load fictional USD judge demo** again.

The demo initialization process can repair missing demo records without duplicating existing entries.

### Scanner Cannot Extract Records

Verify the backend connection, Meta AI configuration, supported image format, and any error returned by the service.

The production Scanner does not substitute fictional extraction results when live scanning fails.

### Financial Records Are Missing on Another Device

Bucketa uses IndexedDB. Financial records are local to the browser and are not automatically synchronized.

---

## Privacy, Security & Limitations

Bucketa is a hackathon prototype demonstrating AI-assisted financial management.

- Financial records are stored locally in the browser.
- Live AI requests are sent through the configured backend.
- Meta API credentials are kept server-side.
- Users review extracted records before saving.
- Supported financial modifications require confirmation.
- AI-generated information may contain errors and should be verified.
- The judge demo uses fictional data.
- Local records are not automatically backed up or synchronized.
- Bucketa is not a substitute for professional accounting or financial advice.

---

## Our Vision

### One Intelligent Assistant. Multiple Financial Workflows. One Unified Platform.

Bucketa envisions a future where business owners and individuals can manage everyday financial activities through natural-language instructions.

Instead of navigating multiple disconnected tools, users should be able to ask about sales, record expenses, manage inventory, organize employees, track savings, and understand their financial performance in one place.

**Our mission is to make financial intelligence more practical, accessible, and useful for everyday life.**

---

## About the Creator

**Rowell Gutierrez** is an educator, former Academic Coordinator, and small business owner from the Philippines who began exploring AI engineering and software development just **two months before the hackathon**.

Despite having only two months of hands-on experience, he developed Bucketa to demonstrate how artificial intelligence can help solve real-world challenges in small business operations and personal financial management.

His journey reflects a passion for learning, innovation, and building practical technology that makes everyday tasks easier and more accessible.

**Project Information**

**Project:** Bucketa

**Tagline:** Smart Buckets — Everything in One Bucket.

**Track:** Build for Your World

**Creator:** Rowell Gutierrez

---

**Bucketa — Smart Buckets. Everything in One Bucket.**
