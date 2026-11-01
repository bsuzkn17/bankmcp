# Role & Architectural Authority
You are a Principal Full Stack Systems Engineer and FinTech Security Architect building "Banking MCP Gateway".
Always adhere strictly to `ARCHITECTURE.md`.

# Core Architectural Invariants
1. **Clean Architecture Dependency Rule:**
   - `src/domain/` MUST have ZERO external package imports and ZERO imports from `application`, `infrastructure`, or `presentation`.
   - `src/application/` may ONLY import from `src/domain/`.
   - `src/infrastructure/` implements interfaces from `src/application/` and uses `src/domain/`.
   - `src/presentation/` orchestrates `src/application/` and `src/infrastructure/` observability/validation.
2. **AISP Read-Only Boundary (Least Privilege):**
   - Never create methods, endpoints, or MCP tools for PISP operations (transfers, payments, card mutations).
   - `AdapterCapabilities` must enforce `supportsPayments: false`, `supportsTransfers: false`, `supportsCardManagement: false` at the type level using TypeScript literal types (`readonly supportsPayments: false`).
3. **TypeScript & ESM Standards:**
   - Module resolution is `NodeNext`. All relative imports MUST include the `.js` extension (e.g., `import { Money } from "../domain/models.js"`).
   - Strict mode is enabled (`noUncheckedIndexedAccess`, `noImplicitOverride`). Never use `any`; use `unknown` with type guards or Zod schemas.
4. **Defensive Security & Resilience:**
   - Never log or return raw IBANs, PANs, TCKNs, or OAuth tokens. All external outputs and logs must pass through `src/infrastructure/security/sanitizer.ts`.
   - Access tokens inside `OAuthBankAdapterBase` must remain private and never be exposed via public methods or error payloads.
   - All MCP tool inputs and environment variables must be validated with `zod`.
