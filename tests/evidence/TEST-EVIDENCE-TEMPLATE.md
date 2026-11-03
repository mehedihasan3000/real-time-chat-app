# Test evidence template

Copy this file for each executed suite or acceptance session. Replace every
`<placeholder>`. Do not record a result that was not observed, and do not paste
secrets, tokens, cookies, SDP/ICE, message plaintext, private keys, or personal
data.

## 1. Identification

| Field           | Value                                                 |
| --------------- | ----------------------------------------------------- |
| Task            | `<task ID and title>`                                 |
| Requirement IDs | `<SRS IDs, for example QA-001, QA-002>`               |
| Test IDs        | `<TC IDs, for example TC-QA-001>`                     |
| Suite layers    | `<unit / contract / integration / e2e / manual>`      |
| Date            | `<YYYY-MM-DD>`                                        |
| Reviewer        | `<name or role; state whether review is independent>` |
| Status          | `<passed / failed / blocked>`                         |

## 2. Tested revision

| Field                         | Value                                      |
| ----------------------------- | ------------------------------------------ |
| Branch                        | `<branch>`                                 |
| Commit                        | `<full commit SHA>`                        |
| Tree                          | `<full tree SHA>`                          |
| Base revision                 | `<full commit SHA>`                        |
| Working tree clean            | `<yes / no; explain any local-only files>` |
| Pull request or review record | `<URL or equivalent record>`               |

## 3. Environment

| Field                | Value                                                |
| -------------------- | ---------------------------------------------------- |
| Operating system     | `<name and version>`                                 |
| Node.js              | `<version>`                                          |
| npm                  | `<version>`                                          |
| Package lock         | `<committed / modified>`                             |
| Browser and version  | `<browser, version, headless or headed>`             |
| Device or emulator   | `<model, OS, or not applicable>`                     |
| Runtime host         | `<local / CI runner / staging>`                      |
| Database or services | `<synthetic local services, or explicitly not used>` |

## 4. Build and configuration

| Field                   | Value                                   |
| ----------------------- | --------------------------------------- |
| Install command         | `<for example npm ci>`                  |
| Build command           | `<for example npm run build>`           |
| Test command            | `<for example npm test>`                |
| E2E command             | `<for example npm run test:e2e>`        |
| Environment variables   | `<names only; never values or secrets>` |
| Feature flags           | `<flag names and states, or none>`      |
| Contract/schema version | `<version>`                             |
| Dependency audit        | `<command and result>`                  |
| Secret scan             | `<command and result>`                  |

## 5. Synthetic dataset and fixtures

| Field             | Value                                                      |
| ----------------- | ---------------------------------------------------------- |
| Fixture catalog   | `<path, for example tests/fixtures/>`                      |
| Participants      | `<two synthetic participants plus one unrelated user>`     |
| Content languages | `<English / Bengali / mixed Unicode>`                      |
| Key states        | `<session, device/key, call, AI consent, delivery, empty>` |
| Network profiles  | `<direct / forced relay / lossy relay>`                    |
| Provider doubles  | `<mock names; confirm network-free>`                       |
| Real data used    | `<no, or an approved exception reference>`                 |

## 6. Execution results

| Test ID   | Layer     | Expected     | Actual       | Result                    | Evidence                                |
| --------- | --------- | ------------ | ------------ | ------------------------- | --------------------------------------- |
| `<TC ID>` | `<layer>` | `<expected>` | `<observed>` | `<pass / fail / blocked>` | `<redacted log, report, or screenshot>` |

Attach or link:

- JUnit report: `<path or URL>`
- Coverage summary: `<path or URL>`
- E2E HTML report: `<path or URL>`
- Screenshots or traces: `<path or URL; confirm redaction>`
- Console/network notes: `<summary; no secrets>`

## 7. Coverage and thresholds

| Metric                          | Target                           | Observed  | Result                         |
| ------------------------------- | -------------------------------- | --------- | ------------------------------ |
| Critical-module branch coverage | `>= 90%`                         | `<value>` | `<pass / fail / not measured>` |
| Overall line coverage           | `>= 70%`                         | `<value>` | `<pass / fail / not measured>` |
| Exclusions                      | `<files and rationale, or none>` |           |                                |

An unmeasured or unfilled threshold is **blocked**, never passed.

## 8. Defects and limitations

| Item                     | Severity                                        | Status                      | Owner     | Reference |
| ------------------------ | ----------------------------------------------- | --------------------------- | --------- | --------- |
| `<defect or limitation>` | `<critical / high / medium / low / limitation>` | `<open / fixed / accepted>` | `<owner>` | `<link>`  |

State explicitly what the suite does **not** prove, including any real-provider,
real-device, real-network, staging, accessibility, or independent-review gap.

## 9. Reviewer sign-off

| Field                 | Value                                               |
| --------------------- | --------------------------------------------------- |
| Reviewer name or role | `<name>`                                            |
| Independent of author | `<yes / no>`                                        |
| Decision              | `<accepted / rejected / accepted with limitations>` |
| Date                  | `<YYYY-MM-DD>`                                      |
| Notes                 | `<summary>`                                         |
