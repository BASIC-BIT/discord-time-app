Below is a **self‑contained specification** you can drop into your coding‑LLM prompt.
It includes every decision, version pin, schema, and guardrail we agreed on for the **Time‑Parse API** that powers your HammerTime overlay.

---

## 📄 1 – Executive summary *(hand to PMs/devs)*

* **Endpoint** `POST /parse`

  * Headers:

    * `X-API-Key: STATIC_KEY_123` (required)
    * `X-API-Version: 1` (required)
  * JSON body (max 512 chars):

    ```json
    { "text": "a week from tomorrow at 5 PM", "tz": "America/Indianapolis" }
    ```
* **Response 200**

  ```json
  { "epoch": 1752345600, "suggestedFormatIndex": 4, "confidence": 0.82 }
  ```
* **Rate‑limit** 60 requests /minute per API key (Fastify plugin).
* **Backend** Node 20.14 LTS • Fastify 5.2 • OpenAI SDK 5.8.2 • better‑sqlite3 9.0.
* **Latency SLO** p99 ≤ 1 s (API server + OpenAI round‑trip).
* **Logging** Single SQLite file (`usage.db`) for raw input/output rows.

---

## 🛠️ 2 – Implementation checklist (server)

> Use TypeScript everywhere; compile with `tsc --strict`.

| Step                     | Action                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Bootstrap**         | `pnpm init -y` → add deps:<br>`pnpm add fastify@5.2 @fastify/rate-limit better-sqlite3 openai@5.8.2 ajv ajv-formats`                                                                                                                                                                                                       |
| **1. Fastify instance**  | `logger:true`, trust proxy.                                                                                                                                                                                                                                                                                                |
| **2. Rate‑limit plugin** | `js app.register(rateLimit,{ max:60, timeWindow:'1 minute' })`                                                                                                                                                                                                                                                             |
| **3. Schema validation** | AJV via Fastify route‐schema:<br>`text:string(max=512)`, `tz:string`, headers include correct key & version.                                                                                                                                                                                                               |
| **4. SQLite**            | ``ts const db = Database('usage.db'); db.exec(`CREATE TABLE IF NOT EXISTS usage( id INTEGER PRIMARY KEY, text TEXT, tz TEXT, epoch INTEGER, format INT, conf REAL, ip TEXT, ts DATETIME DEFAULT CURRENT_TIMESTAMP);`);``                                                                                                   |
| **5. OpenAI call**       | `ts const client = new OpenAI(); const prompt = buildPrompt(body.text, body.tz); const res = await client.chat.completions.create({ model:'gpt-4o-mini', max_tokens:50, temperature:0, messages:[{role:'system',content:SYSTEM_PROMPT},{role:'user',content:prompt}]});` Parse JSON from `res.choices[0].message.content`. |
| **6. Response & log**    | Return `{epoch,suggestedFormatIndex,confidence}`.<br>Insert row in `usage` table.                                                                                                                                                                                                                                          |
| **7. Errors**            | `400` on validation fail; `401` on bad key; `429` via plugin; `500` on OpenAI/DB errors.                                                                                                                                                                                                                                   |
| **8. Start**             | `app.listen({host:'0.0.0.0',port:8080})`.                                                                                                                                                                                                                                                                                  |
| **9. Docker (optional)** | `FROM node:20-slim`, copy dist, `CMD ["node","dist/index.js"]`.                                                                                                                                                                                                                                                            |

---

## 📐 3 – OpenAPI 3.1 spec (YAML)

```yaml
openapi: 3.1.0
info:
  title: Time-Parse API
  version: "1"
servers:
  - url: https://{host}
paths:
  /parse:
    post:
      summary: Convert NL time text → Unix epoch & Discord format index
      operationId: parseTime
      tags: [time]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                text: { type: string, maxLength: 512 }
                tz:   { type: string, description: IANA zone e.g. "America/Los_Angeles" }
              required: [text, tz]
      parameters:
        - in: header
          name: X-API-Key
          required: true
          schema: { type: string, example: STATIC_KEY_123 }
        - in: header
          name: X-API-Version
          required: true
          schema: { type: string, enum: ["1"] }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  epoch: { type: integer, description: Unix seconds UTC }
                  suggestedFormatIndex: { type: integer, minimum: 0, maximum: 6 }
                  confidence: { type: number, minimum: 0, maximum: 1 }
                required: [epoch, suggestedFormatIndex, confidence]
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "429": { $ref: "#/components/responses/RateLimit" }
        "500": { $ref: "#/components/responses/Internal" }
components:
  responses:
    BadRequest:
      description: Validation failed
      content: { application/json: { schema: { type: object, properties: { error:{type:string,example:"bad_request"} } } } }
    Unauthorized:
      description: Missing or invalid API key
      content: { application/json: { schema: { type: object, properties: { error:{type:string,example:"unauthorized"} } } } }
    RateLimit:
      description: Too many requests
      headers:
        Retry-After: { schema: { type: integer }, description: seconds until reset }
      content: { application/json: { schema: { type: object, properties: { error:{type:string,example:"rate_limited"} } } } }
    Internal:
      description: OpenAI or DB failure
      content: { application/json: { schema: { type: object, properties: { error:{type:string,example:"server_error"} } } } }
```

---

## 🔑 4 – Environment variables (server)

| Var              | Purpose                                           |
| ---------------- | ------------------------------------------------- |
| `OPENAI_API_KEY` | Secret for upstream LLM                           |
| `STATIC_API_KEY` | Must equal client header value (`STATIC_KEY_123`) |
| `PORT` *(opt)*   | Override default 8080                             |

---

## 🧩 5 – TypeScript DTOs (duplicate in overlay + server)

```ts
export interface ParseRequest  { text: string; tz: string; }
export interface ParseResponse { epoch: number; suggestedFormatIndex: number; confidence: number; }
```

*(Copy‑paste, keep versions in sync manually for MVP.)*

---

## 📝 6 – System prompt snippet used on the server

```
You are a timestamp assistant. 
Return pure JSON: { "epoch": <int>, "suggestedFormatIndex": 0-6, "confidence": 0-1 } 
No prose. Current user timezone: {tz}. Input: """{text}"""
Discord formats index map: 0:d 1:D 2:t 3:T 4:f 5:F 6:R
```

---

### ➡️ Hand this file to your coding LLM

> “Implement this Fastify 5.2 server in Node 20 TS exactly as specced, using better‑sqlite3 for logging and openai 5.8.2 for inference. Generate human‑readable, well‑commented code.”

That’s all it needs to ship the API in a single pass.
