# Bucketa

**Smart Buckets — Everything in One Bucket.**

Bucketa is a local-first workspace for small business operations and personal financial management. It brings bookkeeping, savings, sales, inventory, and employee payments together, with Bucky to help users understand their records and prepare supported actions.

Built for the **Meta Global AI Developer Hackathon**, in the **Build for Your World** track.

## Real Meta AI integration

| Feature | Configured Meta model | Model ID | Purpose |
| --- | --- | --- | --- |
| Bucky Financial Intelligence | Meta Muse Spark 1.3 | `muse-spark-1.3` | Live conversation and eligible financial explanations |
| Bucky Record Scanner | Meta Muse Spark 1.3 | `muse-spark-1.3` | Structured extraction from receipts and other supported financial documents |
| Creative Studio | Meta Muse Image 1.0 | `muse-image-1.0` | Generate images from text and edit existing images |

The React frontend calls Bucketa’s local Node.js backend, which authenticates to the [Meta Responses API](https://dev.meta.ai/docs/protocols/responses) and validates the response before returning it to the browser. The key stays on the server. A result displays a model name when the successful response includes a verified model identifier from Meta. A configured-model label describes what Bucketa requests.

Bucketa computes exact financial totals locally and uses local rules for supported actions and confirmations. Eligible live explanations can use a scoped financial summary. Voice capture and playback depend on browser speech support. When live conversation is unavailable, Bucky can return a labeled deterministic response. Scanner and Creative Studio report live failures. Simulated provider responses are used for optional automated testing.

## Key features

- **Business and personal profiles:** Keep records separate by profile and currency.
- **Transactions, budgets, and savings:** Record income and expenses, organize money into buckets, and track savings goals.
- **Inventory and POS:** Manage products, prices, and stock. Record sales and review receipts.
- **Employees:** Configure compensation and review salary and payment history.
- **Financial summaries:** Explore recorded activity through dashboard charts, date filters, and currency-aware summaries.
- **Bucky Financial Intelligence:** Ask questions by text or voice in supported browsers. Review and confirm supported record changes before saving.
- **Record Scanner and Creative Studio:** Extract editable financial entries from images, or generate, edit, and download images.

## Run locally from GitHub

Use **Node.js 22.12 or newer** with npm and a modern browser. Live features require internet access and your own authorized Meta Model API credentials.

```bash
git clone https://github.com/rowellgutierrez/Bucketa.git
cd Bucketa
npm ci
```

### Configure live Meta AI

1. Create a key in your Meta Model API dashboard and check your account or team’s access to both models. Live requests may consume credits or incur charges and are subject to provider rate limits. See [Meta authentication](https://dev.meta.ai/docs/authentication) and [pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits).
2. Create a project-root `.env` using `.env.example` as a reference. Replace the placeholder only in your local file.

   ```dotenv
   MODEL_API_KEY=REPLACE_WITH_YOUR_OWN_META_API_KEY
   ENABLE_LIVE_META=1
   ```

3. Keep the key in the ignored local `.env` or the backend process environment. Keep it out of browser fields, `VITE_*` variables, source code, Git, screenshots, and logs. Live authorization uses the server flag, server-side key, and loopback request checks. No separate live-test token is required.

### Start the backend and frontend

Run these in separate terminals from the project root.

```bash
npm run server
```

```bash
npm run dev
```

Open the local URL printed by Vite, typically [http://localhost:5173](http://localhost:5173). Keep the default backend port `8787` because Vite proxies `/api` to `127.0.0.1:8787`. Use a loopback address for local testing.

From another terminal, run:

```bash
npm run health
```

Look for `"ok": true`, `"modelApiKeyConfigured": true`, and `"liveMeta": "enabled"`. This readiness check confirms local configuration. Account access and end-to-end inference are checked by a live request. Restart the backend after changing `.env`.

## Live demo walkthrough for judges

### Prepare a fictional workspace

In **Settings → Local demonstration workspace**, choose **Load fictional USD judge demo**. It adds missing demo records for **Harbor Mini Market**, **Corner Café**, and **Alex Morgan** without overwriting existing records. Alternatively, create a fictional business or personal profile, choose its currency, and add sample records manually. A separate browser profile keeps the walkthrough apart from your usual data.

### 1. Bucky Financial Intelligence

1. Open Bucky and ask, “Explain in two short sentences why a small café should separate personal and business bookkeeping.”
2. Look for **Meta Muse Spark 1.3** on the assistant message when the live response includes that model ID. A labeled deterministic response indicates that the live answer was unavailable.
3. Ask for Harbor Mini Market’s recorded income and expenses in USD to explore the local financial calculations. To see the confirmation safeguard, ask Bucky to record a $25 electricity expense under Corner Café. Review the preview, then cancel to leave the records unchanged.

### 2. Bucky Record Scanner

1. Select a profile and record type. Upload or photograph a readable fictional receipt in the profile’s currency.
2. Confirm sending the image for a live scan. Review the editable entries, flagged fields, and totals. A successful result with matching provider metadata shows **Meta Muse Spark 1.3**.
3. Stop at review for a demonstration without writes. Saving requires separate confirmation.

### 3. Creative Studio

1. Leave the upload empty and enter a prompt such as “A studio product photograph of a plain kraft coffee bag on a cream background.”
2. Click **Generate** once, inspect the preview, and try **Download Image**. A successful result with matching provider metadata shows **Meta Muse Image 1.0**.
3. To demonstrate editing, upload a fictional product photo or give a follow-up instruction for the generated image. An edit is a separate live request.

### Explore the rest of Bucketa

Open **Home** for financial summaries and date filters, **Transactions** for activity history, and **Personal Finance** for savings progress. In a business profile, review stock in **Products & Inventory**, compensation and payments in **Employees**, and receipts in **POS / Sales**. Completing a sample sale changes the local demo records and stock.

## Demo Data and Privacy Disclaimer

Sample names, employee salaries, dates, transaction histories, financial amounts, savings goals, and business records shown in the hackathon demo are fictional and illustrative. They do not represent actual employee records, salaries, or verified financial transactions. This disclaimer applies to the demonstration data. Information users independently enter may be real.

Bucketa stores profiles and financial records in IndexedDB for the current browser profile and site origin. Records do not automatically sync across devices, and clearing site data can remove them. Live requests send the inputs needed for the selected feature to Meta through the local backend. These may include prompts, conversation context, scoped financial summaries, or images. Use fictional inputs during judging.

## Security and limitations

The backend binds to loopback and checks the local request context. Health reports configuration status without revealing credentials. Live requests make one upstream attempt with no automatic retry. If a feature fails, check the backend connection, then your Meta model access, billing or credits, and rate limits.

Review AI results before using them. Bucketa is a hackathon prototype and does not replace professional accounting or financial advice.

For automated checks and a production build, run `npm test` and `npm run build`.

## About the Creator

**Rowell Gutierrez** is the creator of Bucketa, a developer from the Philippines who began exploring AI engineering and software development just **two months before the Meta Global AI Developer Hackathon**.

Despite having only two months of hands-on experience, he built Bucketa to explore how artificial intelligence can help solve everyday challenges in business operations and personal financial management.

### Why I Built Bucketa

I created Bucketa because I wanted to make financial management simpler and more accessible. Many small businesses and individuals still struggle with manually recording transactions, tracking expenses, managing sales, and understanding their financial activity.

My goal was to bring these essential tools together in one application and explore how AI could make everyday financial tasks easier, faster, and more manageable.

### Project Information

| | |
| --- | --- |
| **Project** | Bucketa |
| **Tagline** | Smart Buckets — Everything in One Bucket. |
| **Track** | Build for Your World |
| **Creator** | Rowell Gutierrez |
